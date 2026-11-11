//! Reading transaction results: NEP-297 events and gas per receipt.

use near_workspaces::result::ExecutionFinalResult;
use serde_json::Value;

/// Gas in TGas, for printing.
pub fn tgas(gas: u64) -> f64 {
    gas as f64 / 1e12
}

/// Every `fairground` event in the transaction, as `(event, data)`, in order.
pub fn events(result: &ExecutionFinalResult) -> Vec<(String, Value)> {
    result
        .logs()
        .into_iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .filter(|event| event["standard"] == "fairground")
        .map(|event| {
            (
                event["event"].as_str().unwrap_or_default().to_owned(),
                event["data"].clone(),
            )
        })
        .collect()
}

/// The data of the first `name` event, if any.
pub fn event(result: &ExecutionFinalResult, name: &str) -> Option<Value> {
    events(result)
        .into_iter()
        .find(|(event, _)| event == name)
        .map(|(_, data)| data)
}

/// The `reason` of a `bid_rejected` event in a bid transaction.
pub fn rejection_reason(result: &ExecutionFinalResult) -> Option<String> {
    event(result, "bid_rejected").and_then(|data| data["reason"].as_str().map(str::to_owned))
}

/// NEAR the transaction's signer paid for gas: the tokens burnt by the
/// transaction and every receipt it led to (yoctoNEAR).
pub fn gas_cost(result: &ExecutionFinalResult) -> u128 {
    result
        .outcomes()
        .iter()
        .map(|outcome| outcome.tokens_burnt.as_yoctonear())
        .sum()
}

/// What OutLayer charged its payer in this transaction: the sum of its
/// `[[yNEAR charged: "<n>"]]` logs (yoctoNEAR). The worker's own transaction
/// logs an estimate the same way, so pass the payer's transaction.
pub fn outlayer_charged(result: &ExecutionFinalResult) -> u128 {
    result
        .logs()
        .into_iter()
        .filter_map(|line| {
            line.strip_prefix("[[yNEAR charged: \"")?
                .strip_suffix("\"]]")?
                .parse::<u128>()
                .ok()
        })
        .sum()
}

/// One receipt's gas.
#[derive(Clone, Debug, PartialEq)]
pub struct GasLine {
    pub executor: String,
    pub tgas: f64,
}

/// Gas burnt by each receipt that burnt any, in execution order (refunds and
/// other zero-gas receipts left out). The transaction's own conversion is
/// listed first as `tx`.
pub fn receipt_gas(result: &ExecutionFinalResult) -> Vec<GasLine> {
    let mut lines = vec![GasLine {
        executor: "tx".to_owned(),
        tgas: tgas(result.outcome().gas_burnt.as_gas()),
    }];
    lines.extend(
        result
            .receipt_outcomes()
            .iter()
            .filter(|outcome| outcome.gas_burnt.as_gas() > 0)
            .map(|outcome| GasLine {
                executor: outcome.executor_id.to_string(),
                tgas: tgas(outcome.gas_burnt.as_gas()),
            }),
    );
    lines
}
