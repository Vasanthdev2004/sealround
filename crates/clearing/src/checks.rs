//! The checks the contract runs on an enclave result (port of `contractChecks`).

use crate::clear::{Bid, ClearingError, ClearingResult, SaleParams, checked_one, cost_of};
use crate::math::checked_sum;

/// Names of the checks an enclave result fails, in a fixed order. The contract
/// cannot see prices, so it verifies only what public data allows: the price
/// range, total sold, one fill per bid with the right bidder, each charge
/// against its deposit and `ceil(tokens * price / ONE)`, the raise total and
/// the minimum raise.
///
/// Reads only `bidder` and `deposit` of each bid and `clearing_price`,
/// `fills[].{bidder, tokens, spent}` and `total_raised` of the result. Returns
/// `Err` only for unusable params.
pub fn contract_checks(
    params: &SaleParams,
    bids: &[Bid],
    result: &ClearingResult,
) -> Result<Vec<String>, ClearingError> {
    let one = checked_one(params)?;
    let price = result.clearing_price;
    let mut failed = Vec::new();

    if price < params.floor_price {
        failed.push("price_at_least_floor".to_owned());
    }
    if params.max_price.is_some_and(|ceiling| price > ceiling) {
        failed.push("price_at_most_ceiling".to_owned());
    }
    // A sum beyond u128 is beyond any supply.
    let sold = checked_sum(result.fills.iter().map(|fill| fill.tokens));
    if sold.is_none_or(|sold| sold > params.sale_supply) {
        failed.push("sold_at_most_supply".to_owned());
    }
    if result.fills.len() != bids.len() {
        failed.push("one_fill_per_bid".to_owned());
    }
    for (i, fill) in result.fills.iter().enumerate() {
        let bid = bids.get(i);
        if bid.is_none_or(|bid| bid.bidder != fill.bidder) {
            failed.push(format!("bidder_matches_{i}"));
        }
        if bid.is_some_and(|bid| fill.spent > bid.deposit) {
            failed.push(format!("spent_within_deposit_{i}"));
        }
        if cost_of(fill.tokens, price, one) != Some(fill.spent) {
            failed.push(format!("spent_equals_tokens_times_price_{i}"));
        }
    }
    let raised = checked_sum(result.fills.iter().map(|fill| fill.spent));
    if raised != Some(result.total_raised) {
        failed.push("raise_sums_fills".to_owned());
    }
    if raised.is_some_and(|raised| raised < params.min_raise) {
        failed.push("raise_at_least_min".to_owned());
    }
    Ok(failed)
}
