//! Paying out a final sale: bidders' `claim` and the creator's `claim_proceeds`.
//!
//! Each payout is marked done before its promise and marked open again in the
//! callback if the promise failed, so it can be claimed again and never twice.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, NearToken, Promise, PromiseOrValue, env, near};

use crate::costs::{
    BURN_GAS, FT_TRANSFER_GAS, ON_CLAIM_GAS, ON_PROCEEDS_GAS, STORAGE_DEPOSIT_GAS,
    TOKEN_STORAGE_DEPOSIT, per_bid_reserve,
};
use crate::events::emit;
use crate::settle::invalid_bid_penalty;
use crate::{Error, Fairground, FairgroundExt, Phase, Sale, StepState, ext_ft, promise_succeeded};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// `(tokens, refund)` a bid is owed in a final sale. Settled: its fill and the
/// unspent deposit. Failed: the whole deposit. Either way, a bid the clearing
/// found invalid (`penalized`) loses the 1 % penalty.
pub fn bid_payout(
    sale: &Sale,
    deposit: u128,
    penalized: bool,
    fill: Option<(u128, u128)>,
) -> (u128, u128) {
    let penalty = if penalized {
        invalid_bid_penalty(deposit)
    } else {
        0
    };
    let (tokens, spent) = match sale.phase {
        Phase::Settled => fill.unwrap_or((0, 0)),
        _ => (0, 0),
    };
    (
        tokens,
        deposit.saturating_sub(spent).saturating_sub(penalty),
    )
}

/// NEAR given back to the creator: unused bid slots, token registrations no
/// winner needs, the creator's own registrations it does not need (on the
/// sale token without an allocation, on the quote token without a raise), and
/// the token deploy balance if the token never deployed.
pub fn reserve_refund(sale: &Sale) -> u128 {
    let unused_slots = sale.terms.max_bids.saturating_sub(sale.bid_count);
    let winners = match sale.phase {
        Phase::Settled => sale.result.n_winners,
        _ => 0,
    };
    let unneeded_registrations = sale.bid_count.saturating_sub(winners);
    let token_ready = sale.token_state == StepState::Done;
    let token_registration = if token_ready && sale.terms.creator_allocation() > 0 {
        0
    } else {
        TOKEN_STORAGE_DEPOSIT
    };
    let quote_registration = if sale.phase == Phase::Settled && sale.result.total_raised > 0 {
        0
    } else {
        TOKEN_STORAGE_DEPOSIT
    };
    let deploy_balance = if sale.token_state == StepState::Failed {
        sale.token_deploy_balance
    } else {
        0
    };
    u128::from(unused_slots) * per_bid_reserve(sale.reveal_mode)
        + u128::from(unneeded_registrations) * TOKEN_STORAGE_DEPOSIT
        + token_registration
        + quote_registration
        + deploy_balance
}

#[near]
impl Fairground {
    /// Pays a bidder what a final sale owes it: tokens (registering it on the
    /// token first, paid from the creator's reserve) and the unspent USDC.
    /// Anyone may push a claim; funds only ever go to the bidder (default: the
    /// caller). A second claim is a logged no-op returning `false`.
    #[handle_result]
    pub fn claim(
        &mut self,
        sale_id: String,
        bidder: Option<AccountId>,
    ) -> Result<PromiseOrValue<bool>, Error> {
        let bidder = bidder.unwrap_or_else(env::predecessor_account_id);
        let sale = self.sale(&sale_id)?;
        if !sale.is_final() {
            return Err(Error::WrongPhase {
                action: "claim",
                status: sale.status(env::block_timestamp()).as_str(),
            });
        }
        let num = sale.num;
        let index = *self
            .bid_index
            .get(&(num, bidder.clone()))
            .ok_or(Error::NoBid)?;
        let deposit = self
            .sale_deposits(num)
            .get(index as usize)
            .copied()
            .unwrap_or(0);
        let fill = self
            .fills
            .get(&num)
            .and_then(|fills| fills.get(index as usize).copied());
        let record = self.bid_record(num, index).ok_or(Error::NoBid)?;
        let (tokens, refund) = bid_payout(sale, deposit, self.is_penalized(num, index), fill);
        let tokens = if record.tokens_claimed { 0 } else { tokens };
        let refund = if record.refund_claimed { 0 } else { refund };
        if tokens == 0 && refund == 0 {
            env::log_str(&format!("nothing left to claim for {bidder}"));
            return Ok(PromiseOrValue::Value(false));
        }
        let memo = Some(format!("fairground {sale_id}"));
        let mut parts = Vec::with_capacity(2);
        if tokens > 0 {
            parts.push(register_and_transfer(
                &sale.token,
                &bidder,
                tokens,
                memo.clone(),
            ));
        }
        if refund > 0 {
            parts.push(ft_transfer(&sale.quote_token, &bidder, refund, memo));
        }
        let Some(payout) = join(parts) else {
            return Ok(PromiseOrValue::Value(false));
        };
        if let Some(record) = self.bids.get_mut(&(num, index)) {
            record.tokens_claimed |= tokens > 0;
            record.refund_claimed |= refund > 0;
        }
        let promise = payout.then(
            Self::ext(env::current_account_id())
                .with_static_gas(ON_CLAIM_GAS)
                .on_claim(sale_id, index, U128(tokens), U128(refund)),
        );
        Ok(PromiseOrValue::Promise(promise))
    }

    /// Restores whichever part of a claim failed so it can be claimed again.
    /// Promise results come in order: tokens (if sent), then refund (if sent).
    #[private]
    pub fn on_claim(&mut self, sale_id: String, index: u32, tokens: U128, refund: U128) -> bool {
        let mut results = 0..;
        let tokens_ok = tokens.0 == 0 || results.next().is_some_and(promise_succeeded);
        let refund_ok = refund.0 == 0 || results.next().is_some_and(promise_succeeded);
        let Some(num) = self.find_sale(&sale_id).map(|sale| sale.num) else {
            return false;
        };
        let Some(record) = self.bids.get_mut(&(num, index)) else {
            return false;
        };
        if !tokens_ok {
            record.tokens_claimed = false;
        }
        if !refund_ok {
            record.refund_claimed = false;
        }
        let mut failed = Vec::new();
        if !tokens_ok {
            failed.push("tokens");
        }
        if !refund_ok {
            failed.push("refund");
        }
        emit(
            "claimed",
            json!({
                "sale_id": sale_id,
                "bidder": record.bidder,
                "index": index,
                "tokens": U128(if tokens_ok { tokens.0 } else { 0 }),
                "refund": U128(if refund_ok { refund.0 } else { 0 }),
                "failed": failed,
            }),
        );
        tokens_ok && refund_ok
    }

    /// Pays the creator of a final sale (anyone may push it): the raise in USDC
    /// (settled), the creator allocation in tokens, the unused NEAR reserve;
    /// and burns the unsold sale tokens. The creator is registered on both
    /// tokens first, paid from the reserve. Each part happens once; a failed
    /// part can be claimed again. Returns `false` when nothing is left.
    #[handle_result]
    pub fn claim_proceeds(&mut self, sale_id: String) -> Result<PromiseOrValue<bool>, Error> {
        let sale = self.sale(&sale_id)?;
        if !sale.is_final() {
            return Err(Error::WrongPhase {
                action: "claim proceeds",
                status: sale.status(env::block_timestamp()).as_str(),
            });
        }
        let done = sale.proceeds;
        let token_ready = sale.token_state == StepState::Done;
        // A deploy still in flight decides whether its NEAR is refundable.
        let token_settled = sale.token_state != StepState::Pending;
        let raise = if sale.phase == Phase::Settled && !done.raise_paid {
            sale.result.total_raised
        } else {
            0
        };
        let allocation = if token_ready && !done.allocation_paid {
            sale.terms.creator_allocation()
        } else {
            0
        };
        let burn = if token_ready && !done.unsold_burned {
            sale.unsold()
        } else {
            0
        };
        let reserve = if token_settled && !done.reserve_returned {
            reserve_refund(sale)
        } else {
            0
        };
        if raise == 0 && allocation == 0 && burn == 0 && reserve == 0 {
            env::log_str("nothing left to claim for the creator");
            return Ok(PromiseOrValue::Value(false));
        }
        let memo = Some(format!("fairground {sale_id}"));
        let mut parts = Vec::with_capacity(4);
        if raise > 0 {
            parts.push(register_and_transfer(
                &sale.quote_token,
                &sale.creator,
                raise,
                memo.clone(),
            ));
        }
        if allocation > 0 {
            parts.push(register_and_transfer(
                &sale.token,
                &sale.creator,
                allocation,
                memo,
            ));
        }
        if burn > 0 {
            parts.push(
                ext_ft::ext(sale.token.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(BURN_GAS)
                    .burn(U128(burn)),
            );
        }
        if reserve > 0 {
            parts.push(
                Promise::new(sale.creator.clone()).transfer(NearToken::from_yoctonear(reserve)),
            );
        }
        let Some(payout) = join(parts) else {
            return Ok(PromiseOrValue::Value(false));
        };
        let proceeds = &mut self.sale_mut(&sale_id)?.proceeds;
        proceeds.raise_paid |= raise > 0;
        proceeds.allocation_paid |= allocation > 0;
        proceeds.unsold_burned |= burn > 0;
        proceeds.reserve_returned |= reserve > 0;
        let promise = payout.then(
            Self::ext(env::current_account_id())
                .with_static_gas(ON_PROCEEDS_GAS)
                .on_proceeds(
                    sale_id,
                    U128(raise),
                    U128(allocation),
                    U128(burn),
                    U128(reserve),
                ),
        );
        Ok(PromiseOrValue::Promise(promise))
    }

    /// Restores whichever creator payout failed. Results come in the order
    /// raise, allocation, burn, reserve, counting only the parts that were sent.
    #[private]
    pub fn on_proceeds(
        &mut self,
        sale_id: String,
        raise: U128,
        allocation: U128,
        burn: U128,
        reserve: U128,
    ) -> bool {
        let mut results = 0..;
        let mut part_ok =
            |amount: U128| amount.0 == 0 || results.next().is_some_and(promise_succeeded);
        let raise_ok = part_ok(raise);
        let allocation_ok = part_ok(allocation);
        let burn_ok = part_ok(burn);
        let reserve_ok = part_ok(reserve);
        let Some(sale) = self.sales.get_mut(&sale_id) else {
            return false;
        };
        let proceeds = &mut sale.proceeds;
        proceeds.raise_paid &= raise_ok;
        proceeds.allocation_paid &= allocation_ok;
        proceeds.unsold_burned &= burn_ok;
        proceeds.reserve_returned &= reserve_ok;
        let failed: Vec<&str> = [
            ("raise", raise_ok),
            ("allocation", allocation_ok),
            ("burn", burn_ok),
            ("reserve", reserve_ok),
        ]
        .into_iter()
        .filter_map(|(name, ok)| (!ok).then_some(name))
        .collect();
        let paid = |amount: U128, ok: bool| U128(if ok { amount.0 } else { 0 });
        emit(
            "proceeds_claimed",
            json!({
                "sale_id": sale_id,
                "creator": sale.creator,
                "raise": paid(raise, raise_ok),
                "allocation": paid(allocation, allocation_ok),
                "burned": paid(burn, burn_ok),
                "near_refund": paid(reserve, reserve_ok),
                "failed": failed,
            }),
        );
        failed.is_empty()
    }
}

/// `ft_transfer` with the required 1 yoctoNEAR.
fn ft_transfer(
    token: &AccountId,
    receiver: &AccountId,
    amount: u128,
    memo: Option<String>,
) -> Promise {
    ext_ft::ext(token.clone())
        .with_attached_deposit(ONE_YOCTO)
        .with_static_gas(FT_TRANSFER_GAS)
        .ft_transfer(receiver.clone(), U128(amount), memo)
}

/// Registers `receiver` on `token` (NEP-145), then transfers. The chain's
/// result is the transfer's. If `receiver` is already registered, the token
/// refunds the deposit to this contract, where it stays (DESIGN "Storage and
/// cost": checking first would cost about as much gas as the deposit).
fn register_and_transfer(
    token: &AccountId,
    receiver: &AccountId,
    amount: u128,
    memo: Option<String>,
) -> Promise {
    ext_ft::ext(token.clone())
        .with_attached_deposit(NearToken::from_yoctonear(TOKEN_STORAGE_DEPOSIT))
        .with_static_gas(STORAGE_DEPOSIT_GAS)
        .storage_deposit(Some(receiver.clone()), Some(true))
        .then(ft_transfer(token, receiver, amount, memo))
}

/// Joins promises so one callback sees all their results, in order.
fn join(parts: Vec<Promise>) -> Option<Promise> {
    parts.into_iter().reduce(Promise::and)
}
