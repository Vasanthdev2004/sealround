//! Launch liquidity (DESIGN "Launch liquidity").
//!
//! A sale can set aside sale tokens and a share of its raise to seed a
//! constant-product pool on the Rhea (Ref) exchange at exactly the clearing
//! price. The LP shares stay with this contract, which has no method that
//! moves or redeems them, so the liquidity can never be pulled.
//!
//! The parameters are fixed at `create_sale`. Settlement fixes the pool's
//! amounts ([`pool_plan`]). Then anyone calls `seed_liquidity`, which runs
//! four steps, each a promise whose callback records the result:
//!
//! 1. `register`: this contract's storage account on the exchange with both
//!    tokens registered (one batch), and the exchange's storage on both tokens.
//! 2. `create_pool`: `add_simple_pool([sale token, quote token], fee)`.
//! 3. `deposit`: `ft_transfer_call` of the pool's tokens and USDC to the exchange.
//! 4. `add_liquidity`: both amounts into the pool, with `min_amounts` equal to them.
//!
//! While the pool is being seeded no sale token leaves this contract: bidders
//! get their refunds but not their tokens, the creator gets the raise but not
//! the allocation. Nobody else holds the token, so nobody else can put
//! liquidity into the empty pool at another price first. A failed step
//! changes nothing and can be run again. If the pool is not seeded by the
//! deadline (settlement plus `settle_timeout`), anyone can call
//! `abandon_liquidity`: sale tokens unlock, what sits on the exchange is
//! withdrawn, and `claim_proceeds` pays the pool's USDC to the creator and
//! burns its tokens.
//!
//! A step whose callback never comes (the callback receipt failed) would
//! block every later step. After [`STEP_TIMEOUT_BLOCKS`] the next call runs
//! `reconcile` instead: it reads this contract's balances on the exchange and
//! its LP shares, and carries on from what is really there. A late callback of
//! a step given up on is ignored.

use std::collections::BTreeMap;

use fairground_clearing::math::mul_div_floor;
use fairground_clearing::{cost_of, one_token, tokens_for};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseOrValue, env, near};

use crate::claims::join;
use crate::costs::{
    ADD_LIQUIDITY_GAS, ADD_SIMPLE_POOL_GAS, DEX_ACCOUNT_DEPOSIT, DEX_POOL_SCAN_GAS,
    DEX_REGISTER_TOKENS_GAS, DEX_STORAGE_DEPOSIT_GAS, DEX_VIEW_GAS, DEX_WITHDRAW_GAS,
    FT_TRANSFER_CALL_GAS, LIQUIDITY_NEAR_RESERVE, LIQUIDITY_YOCTO, LP_STORAGE_DEPOSIT,
    ON_LIQUIDITY_GAS, ON_POOL_COUNT_GAS, OWN_WORK_GAS, POOL_STORAGE_DEPOSIT, STORAGE_DEPOSIT_GAS,
    TOKEN_STORAGE_DEPOSIT,
};
use crate::events::emit;
use crate::{
    Config, Error, Fairground, FairgroundExt, ext_ft, promise_succeeded, promise_value, require_gas,
};

/// Most of the raise a pool may take: 50 %.
pub const MAX_RAISE_SHARE_BPS: u16 = 5_000;
/// Highest pool fee: 10 %. Rhea accepts up to 99.99 %.
pub const MAX_POOL_FEE_BPS: u16 = 1_000;
/// Blocks after which a step still waiting for its callback counts as lost
/// (about 6 to 10 minutes). A step's receipts and its callback take a few
/// blocks; only a callback receipt that failed waits this long.
pub const STEP_TIMEOUT_BLOCKS: u64 = 600;
/// Pools one `reconcile` reads while it looks for a pool whose creation
/// result was lost; a later one reads on from there.
pub const POOL_SCAN_LIMIT: u64 = 20;
const BPS: u128 = 10_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

/// `create_sale`'s optional `liquidity` argument.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidityParams {
    /// Share of the raise that goes into the pool, in basis points (1 to 5000).
    pub raise_share_bps: u16,
    /// Sale tokens set aside for the pool, in base units. Part of
    /// `total_supply` on top of `sale_supply`: the creator allocation is
    /// `total_supply - sale_supply - pool_tokens`.
    pub pool_tokens: U128,
    /// The pool's swap fee in basis points (1 to 1000).
    pub fee_bps: u16,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiquidityStage {
    /// The sale is not final yet.
    Waiting,
    /// Settled with a pool to seed. Sale tokens stay locked.
    Seeding,
    /// The pool holds the planned amounts; the LP shares belong to this contract.
    Seeded,
    /// Settled, but the plan came to zero tokens or zero USDC: no pool. The
    /// reserve is burned and the whole raise goes to the creator.
    Skipped,
    /// The sale failed: the reserve is burned with the sale supply.
    Cancelled,
    /// Not seeded by the deadline: the pool's USDC goes to the creator and
    /// its tokens are burned.
    Abandoned,
}

impl LiquidityStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Seeding => "seeding",
            Self::Seeded => "seeded",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
            Self::Abandoned => "abandoned",
        }
    }
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiquidityStep {
    Register,
    CreatePool,
    Deposit,
    AddLiquidity,
    /// After abandonment: what this contract deposited on the exchange comes back.
    Withdraw,
    /// A step's callback never came: read this contract's balances and LP
    /// shares from the exchange.
    Reconcile,
}

impl LiquidityStep {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::CreatePool => "create_pool",
            Self::Deposit => "deposit",
            Self::AddLiquidity => "add_liquidity",
            Self::Withdraw => "withdraw",
            Self::Reconcile => "reconcile",
        }
    }
}

/// A sale's launch liquidity: its terms, the plan fixed at settlement and
/// how far seeding got. Every flag is set only by a callback that saw its
/// promise succeed, so a failed step can simply run again.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Liquidity {
    pub raise_share_bps: u16,
    /// Sale tokens set aside for the pool.
    pub pool_tokens: u128,
    pub fee_bps: u16,
    pub stage: LiquidityStage,
    /// USDC and sale tokens the pool gets (zero until settled).
    pub usdc: u128,
    pub tokens: u128,
    /// `abandon_liquidity` is allowed from this time (nanoseconds) on, and
    /// `seed_liquidity` until it. Zero until settled.
    pub deadline: u64,
    /// This contract's storage account on the exchange, with both tokens registered.
    pub dex_account: bool,
    /// The exchange's storage on the sale token and on the quote token.
    pub dex_on_token: bool,
    pub dex_on_quote: bool,
    pub pool_id: Option<u64>,
    /// Deposited on the exchange and not yet in the pool (or withdrawn).
    pub tokens_on_dex: u128,
    pub usdc_on_dex: u128,
    /// LP shares minted to this contract.
    pub shares: u128,
    /// The step waiting for its callback.
    pub in_flight: Option<LiquidityStep>,
    pub failures: u32,
    /// Steps started so far; the one in flight is number `attempt`. A
    /// callback with an older number is ignored.
    pub attempt: u32,
    /// Block height at which the step in flight started.
    pub started_at: u64,
    /// A step was given up on: what is on the exchange must be read again
    /// before anything else runs, and until then all of the pool's USDC and
    /// tokens count as possibly on the exchange.
    pub unsure: bool,
    /// NEAR attached to `register` steps that were given up on. Whether the
    /// exchange and the tokens kept it is unknown, so it counts as spent and
    /// is not refunded to the creator.
    pub near_lost: u128,
    /// The exchange's pool count just before this contract's last
    /// `add_simple_pool`: the pool it asked for has this id or a higher one.
    /// If that call's result is lost, `reconcile` looks for the pool from
    /// here instead of creating a second one.
    pub pool_search: Option<u64>,
}

impl Liquidity {
    fn new(params: LiquidityParams) -> Self {
        Self {
            raise_share_bps: params.raise_share_bps,
            pool_tokens: params.pool_tokens.0,
            fee_bps: params.fee_bps,
            stage: LiquidityStage::Waiting,
            usdc: 0,
            tokens: 0,
            deadline: 0,
            dex_account: false,
            dex_on_token: false,
            dex_on_quote: false,
            pool_id: None,
            tokens_on_dex: 0,
            usdc_on_dex: 0,
            shares: 0,
            in_flight: None,
            failures: 0,
            attempt: 0,
            started_at: 0,
            unsure: false,
            near_lost: 0,
            pool_search: None,
        }
    }

    /// Fixes the pool's amounts when the sale settles.
    pub(crate) fn plan(&mut self, raised: u128, price: u128, decimals: u8, deadline: u64) {
        let (usdc, tokens) = pool_plan(
            raised,
            price,
            decimals,
            self.raise_share_bps,
            self.pool_tokens,
        );
        self.usdc = usdc;
        self.tokens = tokens;
        if tokens == 0 {
            self.stage = LiquidityStage::Skipped;
        } else {
            self.stage = LiquidityStage::Seeding;
            self.deadline = deadline;
        }
    }

    /// Whether sale tokens must stay in this contract for now.
    pub fn locks_tokens(&self) -> bool {
        matches!(
            self.stage,
            LiquidityStage::Waiting | LiquidityStage::Seeding
        )
    }

    /// USDC of the raise that is not the creator's: what the pool takes, or
    /// after abandonment what is still on the exchange (all of the pool's
    /// share while that is being read again).
    pub fn usdc_kept(&self) -> u128 {
        match self.stage {
            LiquidityStage::Seeding | LiquidityStage::Seeded => self.usdc,
            LiquidityStage::Abandoned if self.unsure => self.usdc,
            LiquidityStage::Abandoned => self.usdc_on_dex,
            _ => 0,
        }
    }

    /// Reserved sale tokens that are not burned at `claim_proceeds`: what the
    /// pool takes, or after abandonment what is still on the exchange (all
    /// of the pool's tokens while that is being read again).
    pub fn tokens_kept(&self) -> u128 {
        match self.stage {
            LiquidityStage::Seeding | LiquidityStage::Seeded => self.tokens,
            LiquidityStage::Abandoned if self.unsure => self.tokens,
            LiquidityStage::Abandoned => self.tokens_on_dex,
            _ => 0,
        }
    }

    pub fn registered(&self) -> bool {
        self.dex_account && self.dex_on_token && self.dex_on_quote
    }

    /// Whether the step in flight has waited `STEP_TIMEOUT_BLOCKS` or more.
    pub fn stale(&self, height: u64) -> bool {
        self.in_flight.is_some() && height >= self.started_at.saturating_add(STEP_TIMEOUT_BLOCKS)
    }

    /// The step `seed_liquidity` (or `abandon_liquidity`) would run now:
    /// `reconcile` while a lost step's effects are unknown, else the next
    /// step of seeding or of withdrawing. None while a step waits for its
    /// result.
    pub fn next_step(&self, now: u64, height: u64) -> Option<LiquidityStep> {
        if !matches!(
            self.stage,
            LiquidityStage::Seeding | LiquidityStage::Abandoned
        ) {
            return None;
        }
        if self.in_flight.is_some() {
            return self.stale(height).then_some(LiquidityStep::Reconcile);
        }
        if self.unsure {
            return Some(LiquidityStep::Reconcile);
        }
        match self.stage {
            LiquidityStage::Seeding if now < self.deadline => Some(if !self.registered() {
                LiquidityStep::Register
            } else if self.pool_id.is_none() {
                LiquidityStep::CreatePool
            } else if self.tokens_on_dex < self.tokens || self.usdc_on_dex < self.usdc {
                LiquidityStep::Deposit
            } else {
                LiquidityStep::AddLiquidity
            }),
            LiquidityStage::Abandoned if self.tokens_on_dex > 0 || self.usdc_on_dex > 0 => {
                Some(LiquidityStep::Withdraw)
            }
            _ => None,
        }
    }

    /// NEAR of the reserve paid at `create_sale` that goes back to the
    /// creator (with the rest of the reserve, at `claim_proceeds`). Zero while
    /// seeding; afterwards whatever no step spent.
    pub fn near_refund(&self) -> u128 {
        match self.stage {
            LiquidityStage::Waiting | LiquidityStage::Seeding => 0,
            LiquidityStage::Skipped | LiquidityStage::Cancelled => LIQUIDITY_NEAR_RESERVE,
            LiquidityStage::Seeded | LiquidityStage::Abandoned => {
                LIQUIDITY_NEAR_RESERVE.saturating_sub(self.near_spent())
            }
        }
    }

    /// The part of the reserve the done steps sent to the exchange and the
    /// tokens, and what steps given up on may have spent. The 1 yoctoNEAR
    /// deposits count as spent from the start, the LP deposit also while a
    /// lost `add_liquidity` may have gone through.
    fn near_spent(&self) -> u128 {
        let mut spent = LIQUIDITY_YOCTO.saturating_add(self.near_lost);
        if self.dex_account {
            spent += DEX_ACCOUNT_DEPOSIT;
        }
        if self.dex_on_token {
            spent += TOKEN_STORAGE_DEPOSIT;
        }
        if self.dex_on_quote {
            spent += TOKEN_STORAGE_DEPOSIT;
        }
        if self.pool_id.is_some() {
            spent += POOL_STORAGE_DEPOSIT;
        }
        if self.stage == LiquidityStage::Seeded || self.unsure {
            spent += LP_STORAGE_DEPOSIT;
        }
        spent
    }

    /// Whether a callback for `step` number `attempt` is the one this sale
    /// waits for.
    fn awaits(&self, step: LiquidityStep, attempt: u32) -> bool {
        self.in_flight == Some(step) && self.attempt == attempt
    }
}

fn invalid(field: &'static str, rule: &'static str) -> Error {
    Error::InvalidParam { field, rule }
}

impl LiquidityParams {
    pub(crate) fn validate(
        self,
        total_supply: u128,
        sale_supply: u128,
        config: &Config,
    ) -> Result<Liquidity, Error> {
        if config.dex.is_none() {
            return Err(invalid(
                "liquidity",
                "launch liquidity is off: this contract has no dex",
            ));
        }
        if !(1..=MAX_RAISE_SHARE_BPS).contains(&self.raise_share_bps) {
            return Err(invalid(
                "liquidity.raise_share_bps",
                "must be between 1 and 5000 (0.01 % to 50 % of the raise)",
            ));
        }
        let pool_tokens = self.pool_tokens.0;
        let fits = sale_supply
            .checked_add(pool_tokens)
            .is_some_and(|reserved| reserved <= total_supply);
        if pool_tokens == 0 || !fits {
            return Err(invalid(
                "liquidity.pool_tokens",
                "must satisfy 0 < pool_tokens <= total_supply - sale_supply",
            ));
        }
        if !(1..=MAX_POOL_FEE_BPS).contains(&self.fee_bps) {
            return Err(invalid(
                "liquidity.fee_bps",
                "must be between 1 and 1000 (0.01 % to 10 %)",
            ));
        }
        Ok(Liquidity::new(self))
    }
}

/// `(usdc, tokens)` for the pool: `share_bps` of the raise, rounded down,
/// buys `tokens` at the clearing price (rounded down, at most `reserve`), and
/// `usdc` is what those tokens cost at that price, rounded up as a bid's
/// spend is. So `usdc * ONE - tokens * price` is in `[0, ONE)`: the pool's
/// price is the clearing price, at most one USDC base unit above it in total,
/// never below. `(0, 0)` when either amount would be zero.
pub fn pool_plan(
    raise: u128,
    price: u128,
    decimals: u8,
    share_bps: u16,
    reserve: u128,
) -> (u128, u128) {
    let Some(one) = one_token(decimals) else {
        return (0, 0);
    };
    let budget = mul_div_floor(raise, u128::from(share_bps), BPS).unwrap_or(0);
    // `None` only when the quotient passes u128: far more than any reserve.
    let tokens = tokens_for(budget, price, one).map_or(reserve, |tokens| tokens.min(reserve));
    let usdc = cost_of(tokens, price, one).unwrap_or(0);
    if tokens == 0 || usdc == 0 || usdc > budget {
        (0, 0)
    } else {
        (usdc, tokens)
    }
}

/// Static gas a step attaches: its calls (at most) and the callback. The
/// pool step's first callback (`on_pool_count`) carries the gas of
/// `add_simple_pool` and of the callback after it.
pub(crate) const fn step_gas(step: LiquidityStep) -> Gas {
    let callback = ON_LIQUIDITY_GAS.as_gas();
    Gas::from_gas(match step {
        LiquidityStep::Register => {
            DEX_STORAGE_DEPOSIT_GAS.as_gas()
                + DEX_REGISTER_TOKENS_GAS.as_gas()
                + 2 * STORAGE_DEPOSIT_GAS.as_gas()
                + callback
        }
        LiquidityStep::CreatePool => DEX_VIEW_GAS.as_gas() + ON_POOL_COUNT_GAS.as_gas(),
        LiquidityStep::Deposit => 2 * FT_TRANSFER_CALL_GAS.as_gas() + callback,
        LiquidityStep::AddLiquidity => ADD_LIQUIDITY_GAS.as_gas() + callback,
        LiquidityStep::Withdraw => 2 * DEX_WITHDRAW_GAS.as_gas() + callback,
        LiquidityStep::Reconcile => DEX_VIEW_GAS.as_gas() + DEX_POOL_SCAN_GAS.as_gas() + callback,
    })
}

/// What a step needs from the calling method: its static gas plus room for
/// the rest of the method.
const fn step_call_gas(step: LiquidityStep) -> Gas {
    Gas::from_gas(step_gas(step).as_gas() + OWN_WORK_GAS.as_gas())
}

#[near]
impl Fairground {
    /// Seeds the sale's launch pool. Anyone may call it once the sale has
    /// settled, until the deadline; no deposit (the NEAR came with
    /// `create_sale`). Runs the next step; each step's callback starts the
    /// one after while the gas lasts (300 TGas runs them all), so a call
    /// with less gas leaves the rest for the next call. A failed step stops
    /// the run and the next call tries it again; a step whose callback never
    /// came is reconciled with the exchange after `STEP_TIMEOUT_BLOCKS`.
    /// Returns the liquidity status.
    #[handle_result]
    pub fn seed_liquidity(&mut self, sale_id: String) -> Result<PromiseOrValue<String>, Error> {
        let now = env::block_timestamp();
        let height = env::block_height();
        let liquidity = self
            .sale(&sale_id)?
            .liquidity
            .as_ref()
            .ok_or(Error::NoLiquidity)?;
        if liquidity.stage != LiquidityStage::Seeding {
            return Err(Error::WrongLiquidityStage {
                action: "seed liquidity",
                stage: liquidity.stage.as_str(),
            });
        }
        if liquidity.in_flight.is_some() && !liquidity.stale(height) {
            return Err(Error::LiquidityBusy);
        }
        if now >= liquidity.deadline {
            return Err(Error::TooLate {
                action: "seed liquidity",
                at: liquidity.deadline,
            });
        }
        let step = liquidity
            .next_step(now, height)
            .ok_or(Error::LiquidityBusy)?;
        require_gas(step_call_gas(step))?;
        let promise = self
            .start_liquidity_step(&sale_id, step)
            .ok_or(Error::NoLiquidity)?;
        Ok(PromiseOrValue::Promise(promise))
    }

    /// Gives up on a launch pool that was not seeded by the deadline
    /// (anyone, from `deadline` on). Sale tokens unlock at once; what this
    /// contract deposited on the exchange is withdrawn; `claim_proceeds` then
    /// pays the pool's USDC to the creator and burns its tokens. Call it
    /// again to retry a failed withdrawal. If a step's result never came,
    /// tokens still unlock, and it reads what is on the exchange first: until
    /// that read succeeds, all of the pool's USDC and tokens stay held, and
    /// if `add_liquidity` went through after all, the pool counts as seeded.
    /// Returns the liquidity status.
    #[handle_result]
    pub fn abandon_liquidity(&mut self, sale_id: String) -> Result<PromiseOrValue<String>, Error> {
        let now = env::block_timestamp();
        let height = env::block_height();
        let liquidity = self
            .sale(&sale_id)?
            .liquidity
            .as_ref()
            .ok_or(Error::NoLiquidity)?;
        let action = "abandon the launch pool";
        match liquidity.stage {
            LiquidityStage::Seeding if now < liquidity.deadline => {
                return Err(Error::TooEarly {
                    action,
                    at: liquidity.deadline,
                });
            }
            LiquidityStage::Seeding | LiquidityStage::Abandoned => {}
            other => {
                return Err(Error::WrongLiquidityStage {
                    action,
                    stage: other.as_str(),
                });
            }
        }
        if liquidity.in_flight.is_some() && !liquidity.stale(height) {
            return Err(Error::LiquidityBusy);
        }
        let first = liquidity.stage == LiquidityStage::Seeding;
        if first {
            // With a step given up on, the next step is `reconcile`, which
            // marks the record unsure in this same call: the payouts then
            // keep all of the pool's share until the exchange is read.
            self.mark_abandoned(&sale_id);
        }
        let liquidity = self.sale(&sale_id)?.liquidity.as_ref();
        let Some(step) = liquidity.and_then(|liquidity| liquidity.next_step(now, height)) else {
            if !first {
                env::log_str("nothing left on the dex to withdraw");
            }
            return Ok(PromiseOrValue::Value(
                LiquidityStage::Abandoned.as_str().to_owned(),
            ));
        };
        require_gas(step_call_gas(step))?;
        let promise = self
            .start_liquidity_step(&sale_id, step)
            .ok_or(Error::NoLiquidity)?;
        Ok(PromiseOrValue::Promise(promise))
    }

    /// Result of the `register` step. Promise results come in the order
    /// account, token, quote, counting only the parts that were sent.
    #[private]
    pub fn on_dex_registered(
        &mut self,
        sale_id: String,
        attempt: u32,
        account: bool,
        on_token: bool,
        on_quote: bool,
    ) -> PromiseOrValue<String> {
        let mut results = 0..;
        let mut part_ok = |sent: bool| sent && results.next().is_some_and(promise_succeeded);
        let account_ok = part_ok(account);
        let token_ok = part_ok(on_token);
        let quote_ok = part_ok(on_quote);
        let Some(liquidity) = self.step_done(&sale_id, LiquidityStep::Register, attempt) else {
            return self.ignored(&sale_id);
        };
        liquidity.dex_account |= account_ok;
        liquidity.dex_on_token |= token_ok;
        liquidity.dex_on_quote |= quote_ok;
        let failed = account != account_ok || on_token != token_ok || on_quote != quote_ok;
        self.after_liquidity_step(&sale_id, LiquidityStep::Register, failed)
    }

    /// First half of the `create_pool` step: the exchange's pool count, kept
    /// as `pool_search`, then `add_simple_pool`. The step stays in flight.
    #[private]
    pub fn on_pool_count(&mut self, sale_id: String, attempt: u32) -> PromiseOrValue<String> {
        let count =
            promise_value(0, 64).and_then(|bytes| serde_json::from_slice::<u64>(&bytes).ok());
        let dex = self.config.dex.clone();
        let Some(sale) = self.sales.get(&sale_id) else {
            return unknown_sale();
        };
        let tokens = json!([sale.token, sale.quote_token]);
        if !sale
            .liquidity
            .as_ref()
            .is_some_and(|liquidity| liquidity.awaits(LiquidityStep::CreatePool, attempt))
        {
            return self.ignored(&sale_id);
        }
        let (Some(count), Some(dex)) = (count, dex) else {
            self.step_done(&sale_id, LiquidityStep::CreatePool, attempt);
            return self.after_liquidity_step(&sale_id, LiquidityStep::CreatePool, true);
        };
        let Some(liquidity) = self.liquidity_mut(&sale_id) else {
            return unknown_sale();
        };
        liquidity.pool_search = Some(count);
        let args = json!({ "tokens": tokens, "fee": liquidity.fee_bps });
        let promise = Promise::new(dex)
            .function_call(
                "add_simple_pool",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(POOL_STORAGE_DEPOSIT),
                ADD_SIMPLE_POOL_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_LIQUIDITY_GAS)
                    .on_pool_created(sale_id, attempt),
            );
        PromiseOrValue::Promise(promise)
    }

    /// Result of `add_simple_pool`: the new pool's id. A pool created whose
    /// id cannot be read is looked for by `reconcile`, never created again.
    #[private]
    pub fn on_pool_created(&mut self, sale_id: String, attempt: u32) -> PromiseOrValue<String> {
        let created = promise_succeeded(0);
        let pool_id =
            promise_value(0, 64).and_then(|bytes| serde_json::from_slice::<u64>(&bytes).ok());
        let Some(liquidity) = self.step_done(&sale_id, LiquidityStep::CreatePool, attempt) else {
            return self.ignored(&sale_id);
        };
        match (created, pool_id) {
            (true, Some(id)) => {
                liquidity.pool_id = Some(id);
                liquidity.pool_search = None;
            }
            (true, None) => {
                liquidity.unsure = true;
                env::log_str(
                    "the exchange created the pool but its id is unreadable; reading the exchange",
                );
            }
            (false, _) => {}
        }
        self.after_liquidity_step(&sale_id, LiquidityStep::CreatePool, !created)
    }

    /// Result of the deposits: each `ft_transfer_call` returns the amount the
    /// exchange kept (the token refunded the rest). Results come in the order
    /// tokens, USDC, counting only the parts that were sent.
    #[private]
    pub fn on_dex_deposit(
        &mut self,
        sale_id: String,
        attempt: u32,
        tokens: U128,
        usdc: U128,
    ) -> PromiseOrValue<String> {
        let mut results = 0..;
        let mut kept = |sent: U128| {
            if sent.0 == 0 {
                return 0;
            }
            results
                .next()
                .and_then(|index| promise_value(index, 64))
                .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok())
                .map_or(0, |used| used.0.min(sent.0))
        };
        let tokens_kept = kept(tokens);
        let usdc_kept = kept(usdc);
        let Some(liquidity) = self.step_done(&sale_id, LiquidityStep::Deposit, attempt) else {
            return self.ignored(&sale_id);
        };
        liquidity.tokens_on_dex = liquidity.tokens_on_dex.saturating_add(tokens_kept);
        liquidity.usdc_on_dex = liquidity.usdc_on_dex.saturating_add(usdc_kept);
        let failed = tokens_kept < tokens.0 || usdc_kept < usdc.0;
        self.after_liquidity_step(&sale_id, LiquidityStep::Deposit, failed)
    }

    /// Result of `add_liquidity`: the LP shares minted to this contract. If
    /// the call went through but the share count is unreadable (or zero), the
    /// pool is not called seeded yet: `reconcile` reads the shares from the
    /// exchange first.
    #[private]
    pub fn on_liquidity_added(&mut self, sale_id: String, attempt: u32) -> PromiseOrValue<String> {
        let added = promise_succeeded(0);
        let shares = promise_value(0, 64)
            .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok())
            .map_or(0, |shares| shares.0);
        let Some(liquidity) = self.step_done(&sale_id, LiquidityStep::AddLiquidity, attempt) else {
            return self.ignored(&sale_id);
        };
        if added && shares == 0 {
            liquidity.unsure = true;
            env::log_str(
                "add_liquidity went through but its share count is unreadable; reading the exchange",
            );
        } else if added {
            self.mark_seeded(&sale_id, shares);
        }
        self.after_liquidity_step(&sale_id, LiquidityStep::AddLiquidity, !added)
    }

    /// Result of the withdrawals after abandonment: the exchange returns the
    /// amount sent back, or 0 if the transfer failed (it then credits the
    /// amount again). Results come in the order tokens, USDC.
    #[private]
    pub fn on_dex_withdraw(
        &mut self,
        sale_id: String,
        attempt: u32,
        tokens: U128,
        usdc: U128,
    ) -> PromiseOrValue<String> {
        let mut results = 0..;
        let mut part_ok = |sent: U128| {
            sent.0 == 0
                || results
                    .next()
                    .and_then(|index| promise_value(index, 64))
                    .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok())
                    == Some(sent)
        };
        let tokens_ok = part_ok(tokens);
        let usdc_ok = part_ok(usdc);
        let Some(liquidity) = self.step_done(&sale_id, LiquidityStep::Withdraw, attempt) else {
            return self.ignored(&sale_id);
        };
        if tokens_ok {
            liquidity.tokens_on_dex = liquidity.tokens_on_dex.saturating_sub(tokens.0);
        }
        if usdc_ok {
            liquidity.usdc_on_dex = liquidity.usdc_on_dex.saturating_sub(usdc.0);
        }
        let mut failed = Vec::new();
        if !tokens_ok {
            failed.push("tokens");
        }
        if !usdc_ok {
            failed.push("usdc");
        }
        emit(
            "liquidity_withdrawn",
            json!({
                "sale_id": sale_id,
                "tokens": U128(if tokens_ok { tokens.0 } else { 0 }),
                "usdc": U128(if usdc_ok { usdc.0 } else { 0 }),
                "failed": failed,
            }),
        );
        self.after_liquidity_step(&sale_id, LiquidityStep::Withdraw, !failed.is_empty())
    }

    /// Result of `reconcile`: this contract's deposits on the exchange
    /// (`get_deposits`) and, if it has a pool, its LP shares there
    /// (`get_pool_shares`), or else, if a pool may have been created without
    /// its id coming back, a page of pools from `search` (`get_pools`). The
    /// balances replace the recorded ones; shares mean `add_liquidity` went
    /// through, so the pool is seeded (even if it was abandoned meanwhile).
    /// The first empty simple pool of these two tokens, in this order, with
    /// this fee becomes the sale's pool; a full page without one means the
    /// next reconcile reads on. Past the deadline an unseeded pool is
    /// abandoned here.
    #[private]
    pub fn on_dex_reconciled(
        &mut self,
        sale_id: String,
        attempt: u32,
        pool_id: Option<u64>,
        search: Option<u64>,
    ) -> PromiseOrValue<String> {
        // The map holds the two tokens this contract registered; the limit
        // leaves far more room than that needs.
        let deposits = promise_value(0, 16_384)
            .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, U128>>(&bytes).ok());
        let shares = match pool_id {
            Some(_) => promise_value(1, 64)
                .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok())
                .map(|shares| shares.0),
            None => Some(0),
        };
        let pools = match (pool_id, search) {
            (None, Some(_)) => promise_value(1, 65_536)
                .and_then(|bytes| serde_json::from_slice::<Vec<PoolInfo>>(&bytes).ok())
                .map(Some),
            _ => Some(None),
        };
        let now = env::block_timestamp();
        let Some(sale) = self.sales.get(&sale_id) else {
            return unknown_sale();
        };
        let (token, quote) = (sale.token.clone(), sale.quote_token.clone());
        let Some(liquidity) = self.step_done(&sale_id, LiquidityStep::Reconcile, attempt) else {
            return self.ignored(&sale_id);
        };
        let (Some(deposits), Some(shares), Some(pools)) = (deposits, shares, pools) else {
            return self.after_liquidity_step(&sale_id, LiquidityStep::Reconcile, true);
        };
        let balance = |token: &AccountId| deposits.get(token.as_str()).map_or(0, |amount| amount.0);
        liquidity.tokens_on_dex = balance(&token);
        liquidity.usdc_on_dex = balance(&quote);
        liquidity.unsure = false;
        if let (Some(pools), Some(from)) = (pools, search) {
            let ours = |pool: &PoolInfo| {
                pool.pool_kind == "SIMPLE_POOL"
                    && pool.token_account_ids == [token.clone(), quote.clone()]
                    && pool.total_fee == u32::from(liquidity.fee_bps)
                    && pool.shares_total_supply.0 == 0
            };
            if let Some(index) = pools.iter().position(ours) {
                liquidity.pool_id = Some(from + index as u64);
                liquidity.pool_search = None;
            } else if (pools.len() as u64) < POOL_SCAN_LIMIT {
                // Read to the end: the lost add_simple_pool did not create one.
                liquidity.pool_search = None;
            } else {
                liquidity.pool_search = Some(from + POOL_SCAN_LIMIT);
                liquidity.unsure = true;
            }
        }
        let stage = liquidity.stage;
        emit(
            "liquidity_reconciled",
            json!({
                "sale_id": sale_id,
                "pool_id": liquidity.pool_id,
                "tokens_on_dex": U128(liquidity.tokens_on_dex),
                "usdc_on_dex": U128(liquidity.usdc_on_dex),
                "shares": U128(shares),
            }),
        );
        if shares > 0 {
            self.mark_seeded(&sale_id, shares);
        } else if stage == LiquidityStage::Seeding && now >= liquidity.deadline {
            self.mark_abandoned(&sale_id);
        }
        self.after_liquidity_step(&sale_id, LiquidityStep::Reconcile, false)
    }
}

impl Fairground {
    fn liquidity_mut(&mut self, sale_id: &str) -> Option<&mut Liquidity> {
        self.sales.get_mut(sale_id)?.liquidity.as_mut()
    }

    /// The sale's liquidity with `step` no longer in flight, if this callback
    /// (`step` number `attempt`) is the one it waits for.
    fn step_done(
        &mut self,
        sale_id: &str,
        step: LiquidityStep,
        attempt: u32,
    ) -> Option<&mut Liquidity> {
        let liquidity = self.liquidity_mut(sale_id)?;
        if !liquidity.awaits(step, attempt) {
            return None;
        }
        liquidity.in_flight = None;
        Some(liquidity)
    }

    /// The answer of a callback nobody waits for: a step given up on (its
    /// result was reconciled), or a sale without liquidity.
    fn ignored(&self, sale_id: &str) -> PromiseOrValue<String> {
        match self
            .sales
            .get(sale_id)
            .and_then(|sale| sale.liquidity.as_ref())
        {
            Some(liquidity) => {
                env::log_str(
                    "ignored a launch liquidity result that came after its step was given up on",
                );
                PromiseOrValue::Value(liquidity.stage.as_str().to_owned())
            }
            None => unknown_sale(),
        }
    }

    /// The pool holds the planned amounts and `shares` LP shares are ours.
    fn mark_seeded(&mut self, sale_id: &str, shares: u128) {
        let dex = self.config.dex.clone();
        let Some(sale) = self.sales.get_mut(sale_id) else {
            return;
        };
        let price = sale.result.clearing_price;
        let Some(liquidity) = sale.liquidity.as_mut() else {
            return;
        };
        liquidity.stage = LiquidityStage::Seeded;
        liquidity.shares = shares;
        liquidity.tokens_on_dex = 0;
        liquidity.usdc_on_dex = 0;
        emit(
            "liquidity_seeded",
            json!({
                "sale_id": sale_id,
                "dex": dex,
                "pool_id": liquidity.pool_id,
                "usdc": U128(liquidity.usdc),
                "tokens": U128(liquidity.tokens),
                "price": U128(price),
                "shares": U128(shares),
            }),
        );
    }

    /// Gives up on the pool: tokens unlock, what is on the exchange will be
    /// withdrawn.
    fn mark_abandoned(&mut self, sale_id: &str) {
        let Some(liquidity) = self.liquidity_mut(sale_id) else {
            return;
        };
        liquidity.stage = LiquidityStage::Abandoned;
        emit(
            "liquidity_abandoned",
            json!({
                "sale_id": sale_id,
                "pool_id": liquidity.pool_id,
                "usdc": U128(liquidity.usdc),
                "tokens": U128(liquidity.tokens),
                "usdc_on_dex": U128(liquidity.usdc_on_dex),
                "tokens_on_dex": U128(liquidity.tokens_on_dex),
                "failures": liquidity.failures,
            }),
        );
    }

    /// Ends a step's callback: counts a failure (the run stops there; the
    /// next call retries), or starts the next step if the gas left covers it.
    fn after_liquidity_step(
        &mut self,
        sale_id: &str,
        step: LiquidityStep,
        failed: bool,
    ) -> PromiseOrValue<String> {
        let now = env::block_timestamp();
        let height = env::block_height();
        let Some(liquidity) = self.liquidity_mut(sale_id) else {
            return unknown_sale();
        };
        let mut next = None;
        if failed {
            liquidity.failures = liquidity.failures.saturating_add(1);
            env::log_str(&format!(
                "launch liquidity step {} failed; call {} again to retry",
                step.as_str(),
                if liquidity.stage == LiquidityStage::Abandoned {
                    "abandon_liquidity"
                } else {
                    "seed_liquidity"
                }
            ));
            emit(
                "liquidity_step_failed",
                json!({
                    "sale_id": sale_id,
                    "step": step,
                    "failures": liquidity.failures,
                }),
            );
        } else {
            next = liquidity.next_step(now, height);
        }
        let stage = liquidity.stage;
        if let Some(next) = next {
            let left = env::prepaid_gas().saturating_sub(env::used_gas());
            if left >= step_call_gas(next)
                && let Some(promise) = self.start_liquidity_step(sale_id, next)
            {
                return PromiseOrValue::Promise(promise);
            }
        }
        PromiseOrValue::Value(stage.as_str().to_owned())
    }

    /// Sends `step`'s calls and its callback and marks it in flight (as step
    /// number `attempt + 1`). None if the sale has no liquidity (or the
    /// contract no dex) or the step has nothing to send.
    pub(crate) fn start_liquidity_step(
        &mut self,
        sale_id: &str,
        step: LiquidityStep,
    ) -> Option<Promise> {
        let dex = self.config.dex.clone()?;
        let contract = env::current_account_id();
        let sale = self.sales.get_mut(sale_id)?;
        let token = sale.token.clone();
        let quote = sale.quote_token.clone();
        let liquidity = sale.liquidity.as_mut()?;
        let attempt = liquidity.attempt.saturating_add(1);
        let callback = Self::ext(contract.clone()).with_static_gas(ON_LIQUIDITY_GAS);
        let id = sale_id.to_owned();
        let promise = match step {
            LiquidityStep::Register => {
                let account = !liquidity.dex_account;
                let on_token = !liquidity.dex_on_token;
                let on_quote = !liquidity.dex_on_quote;
                let mut parts = Vec::with_capacity(3);
                if account {
                    parts.push(open_dex_account(&dex, &contract, &token, &quote));
                }
                if on_token {
                    parts.push(register_dex_on(&token, &dex));
                }
                if on_quote {
                    parts.push(register_dex_on(&quote, &dex));
                }
                join(parts)?
                    .then(callback.on_dex_registered(id, attempt, account, on_token, on_quote))
            }
            LiquidityStep::CreatePool => {
                // The pool count first (`on_pool_count` then sends
                // `add_simple_pool`), so a lost result can be looked for.
                liquidity.pool_search = None;
                dex_view(&dex, "get_number_of_pools", json!({}), DEX_VIEW_GAS).then(
                    Self::ext(contract.clone())
                        .with_static_gas(ON_POOL_COUNT_GAS)
                        .on_pool_count(id, attempt),
                )
            }
            LiquidityStep::Deposit => {
                let tokens = liquidity.tokens.saturating_sub(liquidity.tokens_on_dex);
                let usdc = liquidity.usdc.saturating_sub(liquidity.usdc_on_dex);
                let mut parts = Vec::with_capacity(2);
                if tokens > 0 {
                    parts.push(deposit_on_dex(&token, &dex, tokens));
                }
                if usdc > 0 {
                    parts.push(deposit_on_dex(&quote, &dex, usdc));
                }
                join(parts)?.then(callback.on_dex_deposit(id, attempt, U128(tokens), U128(usdc)))
            }
            LiquidityStep::AddLiquidity => {
                let amounts = [U128(liquidity.tokens), U128(liquidity.usdc)];
                // `min_amounts` equal to the amounts: the pool is empty, and
                // if it somehow were not, a different ratio fails the call.
                let args = json!({
                    "pool_id": liquidity.pool_id?,
                    "amounts": amounts,
                    "min_amounts": amounts,
                });
                Promise::new(dex)
                    .function_call(
                        "add_liquidity",
                        args.to_string().into_bytes(),
                        NearToken::from_yoctonear(LP_STORAGE_DEPOSIT),
                        ADD_LIQUIDITY_GAS,
                    )
                    .then(callback.on_liquidity_added(id, attempt))
            }
            LiquidityStep::Withdraw => {
                let tokens = liquidity.tokens_on_dex;
                let usdc = liquidity.usdc_on_dex;
                let mut parts = Vec::with_capacity(2);
                if tokens > 0 {
                    parts.push(withdraw_from_dex(&dex, &token, tokens));
                }
                if usdc > 0 {
                    parts.push(withdraw_from_dex(&dex, &quote, usdc));
                }
                join(parts)?.then(callback.on_dex_withdraw(id, attempt, U128(tokens), U128(usdc)))
            }
            LiquidityStep::Reconcile => {
                let pool_id = liquidity.pool_id;
                let search = match pool_id {
                    Some(_) => None,
                    None => liquidity.pool_search,
                };
                let mut parts = vec![dex_view(
                    &dex,
                    "get_deposits",
                    json!({ "account_id": contract }),
                    DEX_VIEW_GAS,
                )];
                if let Some(pool_id) = pool_id {
                    parts.push(dex_view(
                        &dex,
                        "get_pool_shares",
                        json!({ "pool_id": pool_id, "account_id": contract }),
                        DEX_VIEW_GAS,
                    ));
                } else if let Some(from) = search {
                    parts.push(dex_view(
                        &dex,
                        "get_pools",
                        json!({ "from_index": from, "limit": POOL_SCAN_LIMIT }),
                        DEX_POOL_SCAN_GAS,
                    ));
                }
                if let Some(lost) = liquidity.in_flight {
                    give_up(liquidity, lost, sale_id);
                }
                // Until a reconcile succeeds, nothing else runs.
                liquidity.unsure = true;
                join(parts)?.then(callback.on_dex_reconciled(id, attempt, pool_id, search))
            }
        };
        liquidity.attempt = attempt;
        liquidity.started_at = env::block_height();
        liquidity.in_flight = Some(step);
        Some(promise)
    }
}

fn unknown_sale() -> PromiseOrValue<String> {
    PromiseOrValue::Value("unknown_sale".to_owned())
}

/// Gives up on `lost`, a step whose callback never came. A `register` step
/// may have spent its NEAR, which then no longer goes back to the creator.
/// (A lost `create_pool` either created a pool, which `reconcile` finds, or
/// got its deposit back; a lost `add_liquidity` either minted LP shares,
/// which `reconcile` finds, or got its deposit back.)
fn give_up(liquidity: &mut Liquidity, lost: LiquidityStep, sale_id: &str) {
    let near = match lost {
        LiquidityStep::Register => {
            let part = |done: bool, deposit: u128| if done { 0 } else { deposit };
            part(liquidity.dex_account, DEX_ACCOUNT_DEPOSIT)
                + part(liquidity.dex_on_token, TOKEN_STORAGE_DEPOSIT)
                + part(liquidity.dex_on_quote, TOKEN_STORAGE_DEPOSIT)
        }
        _ => 0,
    };
    liquidity.near_lost = liquidity.near_lost.saturating_add(near);
    liquidity.failures = liquidity.failures.saturating_add(1);
    env::log_str(&format!(
        "launch liquidity step {} got no result in {STEP_TIMEOUT_BLOCKS} blocks; reading the exchange",
        lost.as_str()
    ));
    emit(
        "liquidity_step_lost",
        json!({
            "sale_id": sale_id,
            "step": lost,
            "failures": liquidity.failures,
        }),
    );
}

/// One batch on the exchange: this contract's storage account (paid for an
/// account and two token entries), then both tokens registered in it. The
/// exchange takes deposits only of tokens an account registered (or it
/// whitelisted).
fn open_dex_account(
    dex: &AccountId,
    contract: &AccountId,
    token: &AccountId,
    quote: &AccountId,
) -> Promise {
    let deposit = json!({ "account_id": contract, "registration_only": false });
    let register = json!({ "token_ids": [token, quote] });
    Promise::new(dex.clone())
        .function_call(
            "storage_deposit",
            deposit.to_string().into_bytes(),
            NearToken::from_yoctonear(DEX_ACCOUNT_DEPOSIT),
            DEX_STORAGE_DEPOSIT_GAS,
        )
        .function_call(
            "register_tokens",
            register.to_string().into_bytes(),
            ONE_YOCTO,
            DEX_REGISTER_TOKENS_GAS,
        )
}

/// The exchange's NEP-145 registration on `token`, so it can receive it. If
/// it is registered already, the token refunds the deposit to this contract.
fn register_dex_on(token: &AccountId, dex: &AccountId) -> Promise {
    ext_ft::ext(token.clone())
        .with_attached_deposit(NearToken::from_yoctonear(TOKEN_STORAGE_DEPOSIT))
        .with_static_gas(STORAGE_DEPOSIT_GAS)
        .with_unused_gas_weight(0)
        .storage_deposit(Some(dex.clone()), Some(true))
}

/// `ft_transfer_call` with an empty message: a plain deposit into this
/// contract's account on the exchange.
fn deposit_on_dex(token: &AccountId, dex: &AccountId, amount: u128) -> Promise {
    ext_ft::ext(token.clone())
        .with_attached_deposit(ONE_YOCTO)
        .with_static_gas(FT_TRANSFER_CALL_GAS)
        .with_unused_gas_weight(0)
        .ft_transfer_call(dex.clone(), U128(amount), None, String::new())
}

/// The exchange sends `amount` of `token` back to this contract.
fn withdraw_from_dex(dex: &AccountId, token: &AccountId, amount: u128) -> Promise {
    let args = json!({ "token_id": token, "amount": U128(amount) });
    Promise::new(dex.clone()).function_call(
        "withdraw",
        args.to_string().into_bytes(),
        ONE_YOCTO,
        DEX_WITHDRAW_GAS,
    )
}

/// One of the exchange's view methods, called as a function call.
fn dex_view(dex: &AccountId, method: &str, args: serde_json::Value, gas: Gas) -> Promise {
    Promise::new(dex.clone()).function_call(method, args.to_string().into_bytes(), NO_DEPOSIT, gas)
}

/// The fields of the exchange's `get_pools` entries that identify the sale's
/// pool; the rest are ignored.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PoolInfo {
    pool_kind: String,
    token_account_ids: Vec<AccountId>,
    total_fee: u32,
    shares_total_supply: U128,
}

/// Terms and progress as views show them.
pub(crate) fn deadline_view(liquidity: &Liquidity) -> Option<U64> {
    (liquidity.deadline > 0).then_some(U64(liquidity.deadline))
}
