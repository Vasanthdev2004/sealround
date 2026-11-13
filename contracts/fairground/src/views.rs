//! Read-only views. Bid views never show prices: TEE bids are sealed, and a
//! commit-reveal bid only shows whether it was revealed.

use near_sdk::base64::Engine as _;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env, near};

use crate::claims::{bid_payout, reserve_refund};
use crate::costs::close_deposit;
use crate::events::hex;
use crate::liquidity::{Liquidity, deadline_view};
use crate::settle::invalid_bid_penalty;
use crate::{
    BidRecord, Config, CreateSaleParams, Error, FailReason, Fairground, FairgroundExt,
    LiquidityStage, LiquidityStep, Phase, RevealMode, Sale, Status, StepState, UnsoldRule,
};

/// Default and maximum page size of the list views.
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleView {
    pub sale_id: String,
    pub status: Status,
    pub creator: AccountId,
    pub token: AccountId,
    pub quote_token: AccountId,
    pub token_name: String,
    pub token_symbol: String,
    pub decimals: u8,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub website: Option<String>,
    pub total_supply: U128,
    pub sale_supply: U128,
    pub creator_allocation: U128,
    pub floor_price: U128,
    pub max_price: Option<U128>,
    pub min_raise: U128,
    pub bid_start: U64,
    pub bid_end: U64,
    pub min_deposit: U128,
    pub max_deposit_per_account: U128,
    pub max_bids: u32,
    pub reveal_mode: RevealMode,
    /// Commit-reveal only.
    pub reveal_window: Option<U64>,
    /// Commit-reveal, once closed.
    pub reveal_end: Option<U64>,
    pub settle_timeout: U64,
    /// When `trigger_refund_mode` becomes possible (none once final).
    pub refund_mode_at: Option<U64>,
    pub unsold_rule: UnsoldRule,
    pub sealer_code_hash: String,
    /// X25519 public key bids are sealed to (hex), TEE mode once set up.
    pub sealer_pubkey: Option<String>,
    pub token_setup: StepState,
    pub sealer_key_setup: StepState,
    /// Block height of the call that sent the (latest) sealer key request to
    /// OutLayer. TEE mode only.
    pub key_request_block: Option<u64>,
    pub created_at: U64,
    pub closed_at: Option<U64>,
    pub bid_count: u32,
    pub total_deposits: U128,
    pub bid_set_hash: String,
    /// Launch liquidity terms, fixed at creation.
    pub liquidity: Option<LiquidityTermsView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidityTermsView {
    /// The exchange the pool is seeded on.
    pub dex: AccountId,
    pub raise_share_bps: u16,
    /// Sale tokens set aside for the pool.
    pub pool_tokens: U128,
    pub fee_bps: u16,
}

/// Launch liquidity progress (in `get_result`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidityView {
    pub status: LiquidityStage,
    /// What `seed_liquidity` (seeding) or `abandon_liquidity` (abandoned)
    /// would run now.
    pub next_step: Option<LiquidityStep>,
    /// The step waiting for its result.
    pub in_flight: Option<LiquidityStep>,
    pub dex: AccountId,
    pub pool_id: Option<u64>,
    /// USDC and sale tokens the pool gets (zero until settled).
    pub usdc: U128,
    pub tokens: U128,
    /// LP shares this contract holds (they never leave it).
    pub shares: U128,
    /// Deposited on the exchange, not yet in the pool or withdrawn.
    pub usdc_on_dex: U128,
    pub tokens_on_dex: U128,
    pub failures: u32,
    /// Seeding is possible until, and `abandon_liquidity` from, this time.
    pub deadline: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidView {
    pub index: u32,
    pub bidder: AccountId,
    pub deposit: U128,
    /// Ciphertext (TEE) or commitment (commit-reveal), standard base64.
    pub payload: String,
    pub placed_at: U64,
    pub revealed: bool,
    /// Everything this bid is owed has been paid out.
    pub claimed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidsSummary {
    pub count: u32,
    pub max_bids: u32,
    pub total_deposits: U128,
    pub bid_set_hash: String,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProceedsView {
    pub raise_paid: bool,
    pub allocation_paid: bool,
    pub unsold_burned: bool,
    pub reserve_returned: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultView {
    pub sale_id: String,
    pub status: Status,
    pub fail_reason: Option<FailReason>,
    pub clearing_price: U128,
    pub total_sold: U128,
    pub total_raised: U128,
    /// Sale tokens burned (or to be burned) at `claim_proceeds`: the unsold
    /// sale supply plus the launch pool reserve the pool does not take. Zero
    /// while the token is not deployed (nothing exists to burn).
    pub unsold: U128,
    pub n_valid: u32,
    pub n_invalid: u32,
    pub n_winners: u32,
    /// First failed checks by name, and how many failed in all.
    pub failed_checks: Vec<String>,
    pub failed_checks_total: u32,
    /// sha256 (hex) of the sealer output as received: OutLayer's attestation `output_hash`.
    pub result_sha256: Option<String>,
    /// sha256 (hex) of the last clearing input: the attestation's `input_hash`.
    pub input_sha256: Option<String>,
    pub clear_requests: u32,
    /// Block height of the call that sent the latest clearing request to
    /// OutLayer (TEE mode), to find that transaction and its attestation.
    pub clear_request_block: Option<u64>,
    pub clear_attempts: u32,
    /// Invalid-bid penalties locked in this contract.
    pub total_penalties: U128,
    pub proceeds: ProceedsView,
    pub liquidity: Option<LiquidityView>,
}

/// What one bid gets, in bid order.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FillView {
    pub index: u32,
    pub bidder: AccountId,
    pub tokens: U128,
    pub spent: U128,
    pub refund: U128,
    /// The invalid-bid penalty kept from the deposit (already taken out of
    /// `refund`); zero for a valid bid.
    pub penalty: U128,
}

#[near]
impl Fairground {
    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_sale(&self, sale_id: String) -> Option<SaleView> {
        let sale = self.find_sale(&sale_id)?;
        Some(self.sale_view(&sale_id, sale))
    }

    /// Sales in creation order.
    pub fn get_sales(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SaleView> {
        page(self.sale_ids.len(), from_index, limit)
            .filter_map(|index| {
                let sale_id = self.sale_ids.get(index)?;
                Some(self.sale_view(sale_id, self.sales.get(sale_id)?))
            })
            .collect()
    }

    pub fn get_bid(&self, sale_id: String, bidder: AccountId) -> Option<BidView> {
        let sale = self.find_sale(&sale_id)?;
        let index = *self.bid_index.get(&(sale.num, bidder))?;
        self.bid_view(sale, index)
    }

    /// Bids in bid order.
    pub fn get_bids(
        &self,
        sale_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<BidView> {
        let Some(sale) = self.find_sale(&sale_id) else {
            return Vec::new();
        };
        page(sale.bid_count, from_index, limit)
            .filter_map(|index| self.bid_view(sale, index))
            .collect()
    }

    pub fn get_bids_summary(&self, sale_id: String) -> Option<BidsSummary> {
        let sale = self.find_sale(&sale_id)?;
        Some(BidsSummary {
            count: sale.bid_count,
            max_bids: sale.terms.max_bids,
            total_deposits: U128(sale.total_deposits),
            bid_set_hash: hex(&sale.bid_set_state),
        })
    }

    pub fn get_result(&self, sale_id: String) -> Option<ResultView> {
        let sale = self.find_sale(&sale_id)?;
        let result = &sale.result;
        let paid = sale.proceeds;
        let now = env::block_timestamp();
        // A part counts as paid once everything it owes so far is paid.
        let settled = |paid: u128, owed: u128| paid > 0 && paid >= owed;
        let allocation = if sale.token_state == StepState::Done {
            sale.creator_allocation()
        } else {
            0
        };
        Some(ResultView {
            sale_id,
            status: sale.status(env::block_timestamp()),
            fail_reason: result.fail_reason,
            clearing_price: U128(result.clearing_price),
            total_sold: U128(result.total_sold),
            total_raised: U128(result.total_raised),
            unsold: U128(if sale.is_final() { sale.unsold() } else { 0 }),
            n_valid: result.n_valid,
            n_invalid: result.n_invalid,
            n_winners: result.n_winners,
            failed_checks: result.failed_checks.clone(),
            failed_checks_total: result.failed_checks_total,
            result_sha256: result.result_sha256.as_ref().map(|h| hex(h)),
            input_sha256: result.input_sha256.as_ref().map(|h| hex(h)),
            clear_requests: result.clear_requests,
            clear_request_block: result.clear_request_block,
            clear_attempts: result.clear_attempts,
            total_penalties: U128(result.total_penalties),
            proceeds: ProceedsView {
                raise_paid: settled(paid.raise_paid, sale.creator_raise()),
                allocation_paid: settled(paid.allocation_paid, allocation),
                unsold_burned: settled(paid.burned, sale.unsold()),
                reserve_returned: settled(paid.reserve_returned, reserve_refund(sale)),
            },
            liquidity: sale
                .liquidity
                .as_ref()
                .and_then(|liquidity| self.liquidity_view(liquidity, now)),
        })
    }

    /// What each bid gets once the sale is final (empty before): tokens and
    /// spent from the fills when settled, the refund either way.
    pub fn get_fills(
        &self,
        sale_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<FillView> {
        let Some(sale) = self.find_sale(&sale_id) else {
            return Vec::new();
        };
        if !sale.is_final() {
            return Vec::new();
        }
        let fills = self.fills.get(&sale.num);
        let deposits = self.sale_deposits(sale.num);
        page(sale.bid_count, from_index, limit)
            .filter_map(|index| {
                let record = self.bid_record(sale.num, index)?;
                let deposit = deposits.get(index as usize).copied().unwrap_or(0);
                let fill = fills.and_then(|fills| fills.get(index as usize).copied());
                let penalized = self.is_penalized(sale.num, index);
                let (tokens, refund) = bid_payout(sale, deposit, penalized, fill);
                let spent = match sale.phase {
                    Phase::Settled => fill.map_or(0, |(_, spent)| spent),
                    _ => 0,
                };
                Some(FillView {
                    index,
                    bidder: record.bidder.clone(),
                    tokens: U128(tokens),
                    spent: U128(spent),
                    refund: U128(refund),
                    penalty: U128(if penalized {
                        invalid_bid_penalty(deposit)
                    } else {
                        0
                    }),
                })
            })
            .collect()
    }

    /// NEAR `create_sale` charges for these params (it validates them too).
    #[handle_result]
    pub fn get_create_cost(&self, params: CreateSaleParams) -> Result<U128, Error> {
        let sale = params.validate(
            env::block_timestamp(),
            &env::current_account_id(),
            &self.config,
        )?;
        Ok(U128(self.create_cost(&sale).total()))
    }

    /// NEAR `close_sale` requires now: OutLayer's compute estimate (doubled)
    /// plus 1e19 yoctoNEAR per input byte above 32 KB, which OutLayer holds and
    /// returns. Zero when closing needs no OutLayer call.
    #[handle_result]
    pub fn get_close_deposit(&self, sale_id: String) -> Result<U128, Error> {
        let sale = self.sale(&sale_id)?;
        let needs_outlayer = sale.reveal_mode == RevealMode::Tee
            && sale.bid_count > 0
            && matches!(sale.phase, Phase::Bidding | Phase::Closed);
        if !needs_outlayer {
            return Ok(U128(0));
        }
        Ok(U128(close_deposit(
            self.clear_input_for(&sale_id, sale).len(),
        )))
    }

    /// NEAR `claim_proceeds` would return to the creator now (zero before the
    /// sale is final or once returned).
    pub fn get_reserve_refund(&self, sale_id: String) -> U128 {
        let refund = self
            .find_sale(&sale_id)
            .filter(|sale| sale.is_final() && sale.token_state != StepState::Pending);
        U128(refund.map_or(0, |sale| {
            reserve_refund(sale).saturating_sub(sale.proceeds.reserve_returned)
        }))
    }
}

impl Fairground {
    fn sale_view(&self, sale_id: &str, sale: &Sale) -> SaleView {
        let meta = self.meta.get(&sale.num);
        let terms = &sale.terms;
        SaleView {
            sale_id: sale_id.to_owned(),
            status: sale.status(env::block_timestamp()),
            creator: sale.creator.clone(),
            token: sale.token.clone(),
            quote_token: sale.quote_token.clone(),
            token_name: meta.map(|m| m.token_name.clone()).unwrap_or_default(),
            token_symbol: meta.map(|m| m.token_symbol.clone()).unwrap_or_default(),
            decimals: terms.decimals,
            icon: meta.and_then(|m| m.icon.clone()),
            description: meta.and_then(|m| m.description.clone()),
            website: meta.and_then(|m| m.website.clone()),
            total_supply: U128(terms.total_supply),
            sale_supply: U128(terms.sale_supply),
            creator_allocation: U128(sale.creator_allocation()),
            floor_price: U128(terms.floor_price),
            max_price: terms.max_price.map(U128),
            min_raise: U128(terms.min_raise),
            bid_start: U64(terms.bid_start),
            bid_end: U64(terms.bid_end),
            min_deposit: U128(terms.min_deposit),
            max_deposit_per_account: U128(terms.max_deposit),
            max_bids: terms.max_bids,
            reveal_mode: sale.reveal_mode,
            reveal_window: (sale.reveal_mode == RevealMode::CommitReveal)
                .then_some(U64(sale.reveal_window)),
            reveal_end: sale.reveal_end().map(U64),
            settle_timeout: U64(sale.settle_timeout),
            refund_mode_at: sale.refund_mode_at().map(U64),
            unsold_rule: UnsoldRule::Burn,
            sealer_code_hash: sale.sealer_code_hash.clone(),
            sealer_pubkey: sale.sealer_pubkey.as_ref().map(|key| hex(key)),
            token_setup: sale.token_state,
            sealer_key_setup: sale.key_state,
            key_request_block: sale.key_request_block,
            created_at: U64(sale.created_at),
            closed_at: sale.closed_at.map(U64),
            bid_count: sale.bid_count,
            total_deposits: U128(sale.total_deposits),
            bid_set_hash: hex(&sale.bid_set_state),
            liquidity: sale.liquidity.as_ref().and_then(|liquidity| {
                Some(LiquidityTermsView {
                    dex: self.config.dex.clone()?,
                    raise_share_bps: liquidity.raise_share_bps,
                    pool_tokens: U128(liquidity.pool_tokens),
                    fee_bps: liquidity.fee_bps,
                })
            }),
        }
    }

    fn liquidity_view(&self, liquidity: &Liquidity, now: u64) -> Option<LiquidityView> {
        Some(LiquidityView {
            status: liquidity.stage,
            next_step: liquidity.next_step(now, env::block_height()),
            in_flight: liquidity.in_flight,
            dex: self.config.dex.clone()?,
            pool_id: liquidity.pool_id,
            usdc: U128(liquidity.usdc),
            tokens: U128(liquidity.tokens),
            shares: U128(liquidity.shares),
            usdc_on_dex: U128(liquidity.usdc_on_dex),
            tokens_on_dex: U128(liquidity.tokens_on_dex),
            failures: liquidity.failures,
            deadline: deadline_view(liquidity),
        })
    }

    fn bid_view(&self, sale: &Sale, index: u32) -> Option<BidView> {
        let record: &BidRecord = self.bid_record(sale.num, index)?;
        let deposit = self.sale_deposits(sale.num).get(index as usize).copied()?;
        let claimed = sale.is_final() && {
            let fill = self
                .fills
                .get(&sale.num)
                .and_then(|fills| fills.get(index as usize).copied());
            let penalized = self.is_penalized(sale.num, index);
            let (tokens, refund) = bid_payout(sale, deposit, penalized, fill);
            (tokens == 0 || record.tokens_claimed) && (refund == 0 || record.refund_claimed)
        };
        Some(BidView {
            index,
            bidder: record.bidder.clone(),
            deposit: U128(deposit),
            payload: BASE64.encode(&record.payload),
            placed_at: U64(record.placed_at),
            revealed: record.reveal.is_some(),
            claimed,
        })
    }
}

/// Indices `from_index..` of a list of `len`, at most `limit` (default 50, max 200).
fn page(len: u32, from_index: Option<u32>, limit: Option<u32>) -> impl Iterator<Item = u32> {
    let from = from_index.unwrap_or(0).min(len);
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    from..from.saturating_add(limit).min(len)
}
