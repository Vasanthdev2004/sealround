//! The clearing rule. An exact port of `packages/clearing/src/clear.ts`: same
//! rule, same rounding, same results for the same input.
//!
//! Units (all integers):
//!   - USDC amounts: base units (6 decimals). 1 USDC = 1_000_000.
//!   - Prices: USDC base units per WHOLE token. 0.001 USDC/token = 1_000.
//!   - Token amounts: token base units (`decimals`).
//!
//! Rule: P* = max { P >= floor : D(P) >= S }, where
//!   D(P) = sum over valid bids with max_price >= P of floor(max_spend * ONE / P).
//! If D(floor) < S, P* = floor, every valid bid is filled in full, and the
//! remainder is unsold.
//!
//! Allocation at P* (two priority tiers):
//!   tier 1: max_price >  P*  -> filled in full, unless their demand alone
//!                               exceeds S (possible because prices are
//!                               discrete), in which case tier 1 is prorated.
//!   tier 2: max_price == P*  -> share what is left, pro rata to demand.
//! Pro-rata rounding: floor each share, then hand out the leftover base units
//! one at a time in bid order.
//!
//! Charge: spent = ceil(tokens * P* / ONE). Since tokens <= floor(max_spend * ONE / P*),
//! spent <= max_spend <= deposit always holds.
//!
//! If the sale has a max price ceiling, decrypted max prices above it are
//! clamped to it before anything else, so P* never exceeds the ceiling.
//!
//! Two ways to find P*, with the same answer for every input ([`PriceSearch`]):
//! [`clear`] uses the fast one (the contract's on-chain clear, where gas
//! matters and prices are public after reveal); [`clear_with`] can use the
//! fixed-shape one (the sealer, where prices are secret and the work done is
//! published as an instruction count).

use core::fmt;
use core::hint::black_box;

use ethnum::U256;

use crate::math::{checked_sum, mul_div_ceil, mul_div_floor, mul_div_floor_wide, narrow, wide_sum};

/// Highest token `decimals` a sale may use. It keeps `ONE` (10^24) small
/// enough that every 256-bit intermediate stays in range.
pub const MAX_DECIMALS: u8 = 24;

/// Halvings in [`PriceSearch::FixedShape`]: enough to narrow the whole u128
/// price range to one price.
pub const FIXED_SHAPE_STEPS: u32 = 128;

/// How [`clear_with`] finds the clearing price P*. Both give the same price,
/// and so the same result, for every input.
///
/// Both search the largest P with D(P) >= S. That set of prices is an interval
/// starting at the floor: D only falls as P rises, and D(P) = 0 < S above
/// every max price (S > 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum PriceSearch {
    /// Binary search over `[floor, highest max price]`; each step sums demand
    /// only over the bids at or above the probe price and stops once the sum
    /// reaches S. About `log2(highest max price - floor)` steps, each as short
    /// as the bids allow. What [`clear`] uses.
    ///
    /// The work it does depends on the bids' prices: the number of steps
    /// reveals the magnitude of the highest max price, and the early exit
    /// depends on how the demand is spread. Use it only where prices are
    /// public, as in the contract's commit-reveal clear.
    #[default]
    Fast,
    /// Exactly [`FIXED_SHAPE_STEPS`] halvings over `[floor, u128::MAX]`; each
    /// step computes the demand of every valid bid at the probe price and
    /// masks out the bids below it, with no early exit. For the sealer, whose
    /// instruction count is public while prices are secret.
    ///
    /// The sequence of probe prices depends only on the floor and P*, both
    /// public. What still varies with the bids (none of it reveals the
    /// highest max price):
    ///
    /// - the number of valid bids each step visits (`n_valid`, published);
    /// - the cost of each u128 division (`max_spend * ONE / price`): on
    ///   targets without 128-bit division (wasm32) it is a library routine
    ///   whose instruction count depends on the operands' magnitudes, so the
    ///   total carries some information about the spends' magnitudes;
    /// - `mul_div_floor` takes its 256-bit path for a bid whose
    ///   `max_spend * ONE` exceeds u128. Never under the contract's limits
    ///   (`max_deposit * 10^decimals <= u128::MAX` and spend <= deposit);
    /// - the work before and after the search: which bid rule fails first,
    ///   the floor demand, and the allocation at P* (which bids are above or
    ///   at P*, the pro-rata leftover pass). The published fills reveal most
    ///   of that.
    FixedShape,
}

/// One sealed bid, as the enclave sees it after decryption.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bid {
    /// NEAR account that placed the bid (from the on-chain record).
    pub bidder: String,
    /// Public USDC deposit, base units.
    pub deposit: u128,
    /// Decrypted max price, USDC base units per whole token. `None` = failed to decrypt.
    pub max_price: Option<u128>,
    /// Decrypted max spend, USDC base units. `None` = failed to decrypt.
    pub max_spend: Option<u128>,
    /// The plaintext names a different bidder or sale than the on-chain record
    /// (a copied ciphertext). Such bids are void.
    pub mismatch: bool,
}

/// The sale terms that clearing depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaleParams {
    /// Tokens for sale, token base units.
    pub sale_supply: u128,
    /// Floor price, USDC base units per whole token.
    pub floor_price: u128,
    /// Minimum total raise, USDC base units. Below this the sale fails.
    pub min_raise: u128,
    /// Token decimals, `0..=MAX_DECIMALS`.
    pub decimals: u8,
    /// Optional max price ceiling. Decrypted max prices above it are clamped to it.
    pub max_price: Option<u128>,
}

/// Why a bid does not take part in clearing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InvalidReason {
    DecryptFailed,
    BidderMismatch,
    ZeroSpend,
    SpendAboveDeposit,
    PriceBelowFloor,
}

impl InvalidReason {
    /// The name used by the TypeScript reference and in JSON.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DecryptFailed => "decrypt_failed",
            Self::BidderMismatch => "bidder_mismatch",
            Self::ZeroSpend => "zero_spend",
            Self::SpendAboveDeposit => "spend_above_deposit",
            Self::PriceBelowFloor => "price_below_floor",
        }
    }
}

/// Outcome of a sale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClearingStatus {
    Settled,
    Failed,
}

impl ClearingStatus {
    /// The name used by the TypeScript reference and in JSON.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Failed => "failed",
        }
    }
}

/// Why a sale failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailReason {
    BelowMinRaise,
    NoValidBids,
}

impl FailReason {
    /// The name used by the TypeScript reference and in JSON.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BelowMinRaise => "below_min_raise",
            Self::NoValidBids => "no_valid_bids",
        }
    }
}

/// What one bid receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fill {
    /// Position in the contract's bid order.
    pub index: usize,
    pub bidder: String,
    pub deposit: u128,
    /// Tokens received, token base units.
    pub tokens: u128,
    /// USDC charged, base units.
    pub spent: u128,
    /// USDC returned, base units (deposit - spent).
    pub refund: u128,
    pub valid: bool,
    pub invalid_reason: Option<InvalidReason>,
}

/// The full outcome of clearing one sale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearingResult {
    pub status: ClearingStatus,
    pub fail_reason: Option<FailReason>,
    /// USDC base units per whole token. Equals the floor when undersubscribed.
    pub clearing_price: u128,
    /// One entry per input bid, in input order.
    pub fills: Vec<Fill>,
    pub total_sold: u128,
    pub total_raised: u128,
    /// sale_supply - total_sold. Burned under the default unsold rule.
    pub unsold: u128,
    pub oversubscribed: bool,
    pub n_valid: usize,
    pub n_invalid: usize,
}

/// A bid that passed validation, with its (clamped) decrypted terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidBid {
    /// Position in the input bid list.
    pub index: usize,
    pub max_price: u128,
    pub max_spend: u128,
}

/// Parameters or amounts that clearing cannot work with. Never caused by a bid's
/// sealed contents under the contract's own limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClearingError {
    SaleSupplyNotPositive,
    FloorPriceNotPositive,
    DecimalsOutOfRange,
    CeilingBelowFloor,
    /// A bid's demand at the floor price, or the total raise, does not fit u128.
    /// The contract rules this out with `max_deposit * 10^decimals <= u128::MAX`.
    Overflow,
}

impl ClearingError {
    /// The error code used by the TypeScript reference (`ClearingError.code`).
    pub const fn code(self) -> &'static str {
        match self {
            Self::SaleSupplyNotPositive => "sale_supply_not_positive",
            Self::FloorPriceNotPositive => "floor_price_not_positive",
            Self::DecimalsOutOfRange => "decimals_out_of_range",
            Self::CeilingBelowFloor => "ceiling_below_floor",
            Self::Overflow => "overflow",
        }
    }
}

impl fmt::Display for ClearingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SaleSupplyNotPositive => "sale supply must be positive",
            Self::FloorPriceNotPositive => "floor price must be positive",
            Self::DecimalsOutOfRange => "decimals must be at most 24",
            Self::CeilingBelowFloor => "max price ceiling must be at least the floor price",
            Self::Overflow => "amounts do not fit in u128",
        })
    }
}

impl std::error::Error for ClearingError {}

/// `10^decimals`, the number of base units in one whole token. `None` if it does not fit u128.
pub fn one_token(decimals: u8) -> Option<u128> {
    10u128.checked_pow(u32::from(decimals))
}

/// Checks the sale parameters that clearing relies on.
pub fn validate_params(params: &SaleParams) -> Result<(), ClearingError> {
    if params.sale_supply == 0 {
        return Err(ClearingError::SaleSupplyNotPositive);
    }
    if params.floor_price == 0 {
        return Err(ClearingError::FloorPriceNotPositive);
    }
    if params.decimals > MAX_DECIMALS {
        return Err(ClearingError::DecimalsOutOfRange);
    }
    if params
        .max_price
        .is_some_and(|ceiling| ceiling < params.floor_price)
    {
        return Err(ClearingError::CeilingBelowFloor);
    }
    Ok(())
}

/// Validated params' `ONE`.
pub(crate) fn checked_one(params: &SaleParams) -> Result<u128, ClearingError> {
    validate_params(params)?;
    one_token(params.decimals).ok_or(ClearingError::DecimalsOutOfRange)
}

/// Why a bid is invalid at this floor price, or `None` if it is valid.
pub fn validate_bid(bid: &Bid, floor_price: u128) -> Option<InvalidReason> {
    decrypted_terms(bid, bid.max_price, floor_price).err()
}

/// The bid's `(max_price, max_spend)` if it is valid, else why not. Takes the
/// max price separately so `clear` can apply the ceiling first.
fn decrypted_terms(
    bid: &Bid,
    max_price: Option<u128>,
    floor_price: u128,
) -> Result<(u128, u128), InvalidReason> {
    let (Some(max_price), Some(max_spend)) = (max_price, bid.max_spend) else {
        return Err(InvalidReason::DecryptFailed);
    };
    if bid.mismatch {
        return Err(InvalidReason::BidderMismatch);
    }
    if max_spend == 0 {
        return Err(InvalidReason::ZeroSpend);
    }
    if max_spend > bid.deposit {
        return Err(InvalidReason::SpendAboveDeposit);
    }
    if max_price < floor_price {
        return Err(InvalidReason::PriceBelowFloor);
    }
    Ok((max_price, max_spend))
}

/// Tokens a budget buys at price P (floor). `None` if `price == 0` or the
/// result does not fit u128.
pub fn tokens_for(spend: u128, price: u128, one: u128) -> Option<u128> {
    mul_div_floor(spend, one, price)
}

/// USDC charged for `tokens` at price P (ceil). `None` if `one == 0` or the
/// result does not fit u128.
pub fn cost_of(tokens: u128, price: u128, one: u128) -> Option<u128> {
    mul_div_ceil(tokens, price, one)
}

/// Aggregate demand at price P, token base units. Saturates at `u128::MAX`
/// (the TypeScript reference returns the exact bigint), so comparing it with
/// any supply still gives the exact answer.
pub fn demand_at(valid: &[ValidBid], price: u128, one: u128) -> u128 {
    valid
        .iter()
        .filter(|bid| bid.max_price >= price)
        .map(|bid| tokens_for(bid.max_spend, price, one).unwrap_or(u128::MAX))
        .fold(0, u128::saturating_add)
}

/// Whether D(price) >= supply. Stops as soon as the running sum reaches it.
/// For [`PriceSearch::Fast`].
fn demand_reaches(valid: &[ValidBid], price: u128, one: u128, supply: u128) -> bool {
    let mut total: u128 = 0;
    for bid in valid.iter().filter(|bid| bid.max_price >= price) {
        let Some(sum) = tokens_for(bid.max_spend, price, one).and_then(|t| total.checked_add(t))
        else {
            // More than u128::MAX tokens, so more than any supply.
            return true;
        };
        if sum >= supply {
            return true;
        }
        total = sum;
    }
    false
}

/// D(price), saturating at `u128::MAX` like [`demand_at`], doing the same work
/// for every bid: each bid's demand is computed whether or not its max price
/// reaches `price`, then masked to zero if it does not. For
/// [`PriceSearch::FixedShape`].
fn full_demand(valid: &[ValidBid], price: u128, one: u128) -> u128 {
    let mut total: u128 = 0;
    for bid in valid {
        #[cfg(test)]
        shape::visit();
        // `black_box` keeps the compiler from computing the demand only when
        // the mask keeps it (it may turn a select into a branch).
        let demand = black_box(tokens_for(bid.max_spend, price, one).unwrap_or(u128::MAX));
        let keep = 0u128.wrapping_sub(u128::from(bid.max_price >= price));
        total = total.saturating_add(demand & keep);
    }
    total
}

/// [`PriceSearch::Fast`]: the largest P in `[floor, highest max price]` with
/// D(P) >= supply. Requires D(floor) >= supply.
fn fast_search(valid: &[ValidBid], floor: u128, one: u128, supply: u128) -> u128 {
    let mut lo = floor;
    let mut hi = valid.iter().map(|bid| bid.max_price).fold(floor, u128::max);
    while lo < hi {
        // (lo + hi + 1) / 2 without overflow.
        let mid = lo + (hi - lo).div_ceil(2);
        if demand_reaches(valid, mid, one, supply) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

/// [`PriceSearch::FixedShape`]: the largest P in `[floor, u128::MAX]` with
/// D(P) >= supply, in exactly [`FIXED_SHAPE_STEPS`] steps. Requires
/// D(floor) >= supply and `floor >= 1`.
fn fixed_shape_search(valid: &[ValidBid], floor: u128, one: u128, supply: u128) -> u128 {
    // Invariants: D(lo) >= supply, and D(P) < supply for every P > hi.
    // Each step leaves hi - lo at most half of what it was (rounded down), so
    // 128 steps take any u128 range to lo == hi. A step after that probes
    // mid == lo, whose demand reaches the supply, and changes nothing.
    let mut lo = floor;
    let mut hi = u128::MAX;
    for _ in 0..FIXED_SHAPE_STEPS {
        #[cfg(test)]
        shape::step();
        let mid = lo + (hi - lo).div_ceil(2);
        let reaches = 0u128.wrapping_sub(u128::from(full_demand(valid, mid, one) >= supply));
        // lo = reaches ? mid : lo; hi = reaches ? hi : mid - 1, without a
        // branch. mid >= floor >= 1, so mid - 1 never wraps.
        lo = (mid & reaches) | (lo & !reaches);
        hi = (hi & reaches) | (mid.wrapping_sub(1) & !reaches);
    }
    lo
}

/// Counts the fixed-shape search's work, for the tests that pin its shape.
#[cfg(test)]
pub(crate) mod shape {
    use std::cell::Cell;

    std::thread_local! {
        static STEPS: Cell<u64> = const { Cell::new(0) };
        static VISITS: Cell<u64> = const { Cell::new(0) };
    }

    pub(crate) fn step() {
        STEPS.with(|steps| steps.set(steps.get() + 1));
    }

    pub(crate) fn visit() {
        VISITS.with(|visits| visits.set(visits.get() + 1));
    }

    /// `(steps, bids visited)` since the last call, and resets both.
    pub(crate) fn take() -> (u64, u64) {
        (STEPS.with(|s| s.replace(0)), VISITS.with(|v| v.replace(0)))
    }
}

/// Split `amount` across `weights` pro rata (floor), then give leftover units
/// one at a time in array order, skipping entries already at their weight.
/// When `amount >= sum(weights)` every entry gets its full weight.
pub fn prorate(amount: u128, weights: &[u128]) -> Vec<u128> {
    let total = wide_sum(weights);
    if total == U256::ZERO || amount == 0 {
        return vec![0; weights.len()];
    }
    if U256::new(amount) >= total {
        return weights.to_vec();
    }
    // total > 0 and each w <= total, so floor(w * amount / total) <= amount:
    // the division always has an answer that fits.
    let mut out: Vec<u128> = weights
        .iter()
        .map(|&w| mul_div_floor_wide(w, amount, total).unwrap_or(0))
        .collect();
    // The floored shares sum to at most amount.
    let given = out
        .iter()
        .fold(0u128, |sum, &share| sum.saturating_add(share));
    let mut left = amount.saturating_sub(given);
    // Each leftover unit comes from an entry with a fractional share, and such
    // an entry is below its weight, so this ends within one pass.
    let mut k = 0;
    while left > 0 {
        if out[k] < weights[k] {
            out[k] += 1;
            left -= 1;
        }
        k = (k + 1) % out.len();
    }
    out
}

/// Clears a sale: one uniform price for everyone, fills and refunds per bid.
/// Returns `Err` only for unusable params or amounts beyond u128, never panics.
/// Finds the price with [`PriceSearch::Fast`].
pub fn clear(params: &SaleParams, bids: &[Bid]) -> Result<ClearingResult, ClearingError> {
    clear_by(params, bids, fast_search)
}

/// [`clear`] with a choice of price search. The result is the same for every
/// search; only the work done to reach it differs (see [`PriceSearch`]).
pub fn clear_with(
    params: &SaleParams,
    bids: &[Bid],
    search: PriceSearch,
) -> Result<ClearingResult, ClearingError> {
    match search {
        PriceSearch::Fast => clear_by(params, bids, fast_search),
        PriceSearch::FixedShape => clear_by(params, bids, fixed_shape_search),
    }
}

/// The clear itself, with the search passed in, so a build that only calls
/// [`clear`] (the contract) does not link the fixed-shape search.
fn clear_by(
    params: &SaleParams,
    bids: &[Bid],
    search: fn(&[ValidBid], u128, u128, u128) -> u128,
) -> Result<ClearingResult, ClearingError> {
    let one = checked_one(params)?;
    let supply = params.sale_supply;
    let floor = params.floor_price;

    let mut reasons = Vec::with_capacity(bids.len());
    let mut valid = Vec::new();
    for (index, bid) in bids.iter().enumerate() {
        let max_price = bid.max_price.map(|price| clamp(price, params.max_price));
        match decrypted_terms(bid, max_price, floor) {
            Ok((max_price, max_spend)) => {
                reasons.push(None);
                valid.push(ValidBid {
                    index,
                    max_price,
                    max_spend,
                });
            }
            Err(reason) => reasons.push(Some(reason)),
        }
    }

    // Demand only falls as the price rises, so if each bid's demand at the
    // floor fits u128, every later per-bid amount fits too.
    let floor_demand = valid
        .iter()
        .map(|bid| tokens_for(bid.max_spend, floor, one).ok_or(ClearingError::Overflow))
        .collect::<Result<Vec<u128>, _>>()?;

    let mut tokens = vec![0u128; bids.len()];
    let mut price = floor;
    let mut oversubscribed = false;

    if !valid.is_empty() {
        let undersubscribed = narrow(wide_sum(&floor_demand)).is_some_and(|total| total < supply);
        if undersubscribed {
            // Undersubscribed: everyone valid fills in full at the floor.
            for (bid, &demand) in valid.iter().zip(&floor_demand) {
                tokens[bid.index] = demand;
            }
        } else {
            oversubscribed = true;
            // Largest P >= floor with D(P) >= S; here D(floor) >= S (a sum
            // beyond u128 is beyond any supply).
            price = search(&valid, floor, one, supply);
            allocate_at(&valid, price, one, supply, &mut tokens)?;
        }
    }

    let mut fills = Vec::with_capacity(bids.len());
    for (index, (bid, reason)) in bids.iter().zip(&reasons).enumerate() {
        let filled = tokens[index];
        let spent = cost_of(filled, price, one).ok_or(ClearingError::Overflow)?;
        fills.push(Fill {
            index,
            bidder: bid.bidder.clone(),
            deposit: bid.deposit,
            tokens: filled,
            spent,
            refund: bid
                .deposit
                .checked_sub(spent)
                .ok_or(ClearingError::Overflow)?,
            valid: reason.is_none(),
            invalid_reason: *reason,
        });
    }

    let total_sold =
        checked_sum(fills.iter().map(|fill| fill.tokens)).ok_or(ClearingError::Overflow)?;
    let total_raised =
        checked_sum(fills.iter().map(|fill| fill.spent)).ok_or(ClearingError::Overflow)?;
    let n_valid = valid.len();
    let n_invalid = bids.len() - n_valid;

    let fail_reason = if valid.is_empty() {
        Some(FailReason::NoValidBids)
    } else if total_raised < params.min_raise {
        Some(FailReason::BelowMinRaise)
    } else {
        None
    };

    if let Some(reason) = fail_reason {
        // Failed sale: nobody gets tokens, everyone gets their full deposit back.
        for fill in &mut fills {
            fill.tokens = 0;
            fill.spent = 0;
            fill.refund = fill.deposit;
        }
        return Ok(ClearingResult {
            status: ClearingStatus::Failed,
            fail_reason: Some(reason),
            clearing_price: price,
            fills,
            total_sold: 0,
            total_raised: 0,
            unsold: supply,
            oversubscribed,
            n_valid,
            n_invalid,
        });
    }

    Ok(ClearingResult {
        status: ClearingStatus::Settled,
        fail_reason: None,
        clearing_price: price,
        fills,
        total_sold,
        total_raised,
        unsold: supply
            .checked_sub(total_sold)
            .ok_or(ClearingError::Overflow)?,
        oversubscribed,
        n_valid,
        n_invalid,
    })
}

/// Oversubscribed allocation at the clearing price: bids above it first, then
/// bids exactly at it share what is left.
fn allocate_at(
    valid: &[ValidBid],
    price: u128,
    one: u128,
    supply: u128,
    tokens: &mut [u128],
) -> Result<(), ClearingError> {
    let demand =
        |bid: &&ValidBid| tokens_for(bid.max_spend, price, one).ok_or(ClearingError::Overflow);
    let above: Vec<&ValidBid> = valid.iter().filter(|bid| bid.max_price > price).collect();
    let at: Vec<&ValidBid> = valid.iter().filter(|bid| bid.max_price == price).collect();
    let above_demand = above.iter().map(demand).collect::<Result<Vec<u128>, _>>()?;

    match narrow(wide_sum(&above_demand)).filter(|&total| total < supply) {
        // Tier 1 alone covers the supply: prorate it among tier 1.
        None => assign(&above, &prorate(supply, &above_demand), tokens),
        Some(above_total) => {
            assign(&above, &above_demand, tokens);
            let at_demand = at.iter().map(demand).collect::<Result<Vec<u128>, _>>()?;
            assign(&at, &prorate(supply - above_total, &at_demand), tokens);
        }
    }
    Ok(())
}

fn assign(bids: &[&ValidBid], amounts: &[u128], tokens: &mut [u128]) {
    for (bid, &amount) in bids.iter().zip(amounts) {
        tokens[bid.index] = amount;
    }
}

fn clamp(price: u128, ceiling: Option<u128>) -> u128 {
    ceiling.map_or(price, |ceiling| price.min(ceiling))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bid(max_price: u128, max_spend: u128) -> Bid {
        Bid {
            bidder: "b.testnet".into(),
            deposit: max_spend,
            max_price: Some(max_price),
            max_spend: Some(max_spend),
            mismatch: false,
        }
    }

    fn params(sale_supply: u128, floor_price: u128) -> SaleParams {
        SaleParams {
            sale_supply,
            floor_price,
            min_raise: 0,
            decimals: 0,
            max_price: None,
        }
    }

    /// Five oversubscribed books with five valid bids each, whose top max
    /// prices range from the floor to u128::MAX, plus one invalid bid each.
    fn books() -> Vec<(SaleParams, Vec<Bid>)> {
        let invalid = Bid {
            max_spend: Some(0),
            ..bid(5, 0)
        };
        [
            [10, 10, 10, 10, 10],
            [10, 11, 12, 13, 14],
            [10, 20, 1_000, 1_000_000, 1 << 40],
            [10, 10, 10, 10, u128::MAX],
            [u128::MAX, u128::MAX - 1, 1 << 127, 1 << 100, 10],
        ]
        .into_iter()
        .map(|prices| {
            let mut bids: Vec<Bid> = prices.into_iter().map(|p| bid(p, 1_000)).collect();
            bids.insert(2, invalid.clone());
            (params(400, 10), bids)
        })
        .collect()
    }

    #[test]
    fn the_fixed_shape_search_does_the_same_work_whatever_the_prices() {
        shape::take();
        for (params, bids) in books() {
            let fixed = clear_with(&params, &bids, PriceSearch::FixedShape).unwrap();
            assert!(fixed.oversubscribed);
            assert_eq!(fixed.n_valid, 5);
            // 128 halvings, each visiting all 5 valid bids, for every book.
            assert_eq!(shape::take(), (128, 128 * 5), "{bids:?}");
            assert_eq!(clear(&params, &bids).unwrap(), fixed);
            // The fast search does not use the fixed-shape demand sum at all.
            assert_eq!(shape::take(), (0, 0));
        }
    }

    #[test]
    fn an_undersubscribed_sale_runs_no_search() {
        shape::take();
        let bids = [bid(10, 1), bid(u128::MAX, 1)];
        let result = clear_with(&params(1_000, 10), &bids, PriceSearch::FixedShape).unwrap();
        assert!(!result.oversubscribed);
        assert_eq!(shape::take(), (0, 0));
    }

    #[test]
    fn full_demand_equals_demand_at() {
        let valid: Vec<ValidBid> = [
            (10, 1_000),
            (25, 7),
            (u128::MAX, u128::MAX),
            (1 << 64, 1 << 100),
            (11, 0),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (max_price, max_spend))| ValidBid {
            index,
            max_price,
            max_spend,
        })
        .collect();
        for one in [1, 10, 1_000_000, 10u128.pow(24)] {
            for price in [1, 2, 9, 10, 11, 25, 26, 1 << 64, (1 << 64) + 1, u128::MAX] {
                assert_eq!(
                    full_demand(&valid, price, one),
                    demand_at(&valid, price, one),
                    "price {price}, one {one}"
                );
            }
        }
        shape::take();
    }

    #[test]
    fn both_searches_agree_at_the_edges_of_the_price_range() {
        // P* at the floor, just above it, and at u128::MAX.
        for (supply, floor, prices) in [
            (100, 1, vec![1, 1]),
            (100, 1, vec![2, 1]),
            (1, u128::MAX - 1, vec![u128::MAX, u128::MAX]),
            (1, 1, vec![u128::MAX]),
            (1, u128::MAX, vec![u128::MAX]),
        ] {
            let bids: Vec<Bid> = prices.into_iter().map(|p| bid(p, u128::MAX)).collect();
            let params = params(supply, floor);
            let fast = clear(&params, &bids);
            assert_eq!(fast, clear_with(&params, &bids, PriceSearch::FixedShape));
            assert!(fast.is_ok(), "{fast:?}");
        }
        shape::take();
    }
}
