//! The test as OutLayer's worker: answer pending requests on OutLayer's real
//! contract the way the worker does.
//!
//! The worker sizes the whole response: under 1024 bytes it calls
//! `resolve_execution`; larger successful outputs go through
//! `submit_execution_output_and_resolve`, which stores the output in OutLayer
//! and resumes the yield with metadata only (the yield payload limit is 1024
//! bytes). A failed run is reported with `success: false`, which reaches the
//! caller as `null`. Not answering for 200 blocks times the request out.

use std::task::Poll;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use near_workspaces::operations::TransactionStatus;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use serde_json::{Value, json};

use crate::Env;
use crate::env::str_field;

/// The yield payload limit (`max_yield_payload_size`).
const MAX_YIELD_PAYLOAD: usize = 1024;
/// What the worker attaches to its own transactions.
const WORKER_GAS: Gas = Gas::from_tgas(300);

/// One answered request.
#[derive(Debug)]
pub struct Served {
    pub request_id: u64,
    /// `input_data` as OutLayer stored it.
    pub input: String,
    /// The sealer's stdout, exactly as delivered (Text format).
    pub output: String,
    /// The worker's own transaction.
    pub worker_tx: ExecutionFinalResult,
}

fn resources_used() -> Value {
    json!({"instructions": 1_000_000, "time_ms": 100, "compile_time_ms": null})
}

impl Env {
    /// Waits for a pending OutLayer request this test has not answered yet.
    pub async fn next_request(&self) -> Result<u64> {
        for _ in 0..150 {
            let ids: Vec<u64> = self
                .outlayer
                .view("get_pending_request_ids")
                .args_json(json!({}))
                .await?
                .json()?;
            let handled = self.handled.lock().expect("lock").clone();
            if let Some(id) = ids.into_iter().find(|id| !handled.contains(id)) {
                return Ok(id);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        bail!("no new OutLayer request within 15 s")
    }

    /// `input_data` of a pending request.
    pub async fn request_input(&self, request_id: u64) -> Result<String> {
        let request: Value = self
            .outlayer
            .view("get_request")
            .args_json(json!({"request_id": request_id}))
            .await?
            .json()?;
        Ok(str_field(&request, "input_data")?.to_owned())
    }

    /// What the enclave job prints for `input`, run by Fairground.
    pub fn sealer_output(&self, input: &str) -> String {
        let ctx = fairground_sealer::Ctx {
            predecessor: self.fg().to_string(),
            master: self.master,
        };
        fairground_sealer::run(input, &ctx)
    }

    /// Answers the next request with the sealer's real output.
    pub async fn serve(&self) -> Result<Served> {
        self.serve_with(|_, output| output.to_owned()).await
    }

    /// Answers the next request with `tamper(input, sealer output)`.
    pub async fn serve_with(&self, tamper: impl FnOnce(&str, &str) -> String) -> Result<Served> {
        let request_id = self.next_request().await?;
        let input = self.request_input(request_id).await?;
        let output = tamper(&input, &self.sealer_output(&input));
        let worker_tx = self.resolve(request_id, &output).await?;
        Ok(Served {
            request_id,
            input,
            output,
            worker_tx,
        })
    }

    /// Delivers `output` as a successful Text-format run.
    pub async fn resolve(&self, request_id: u64, output: &str) -> Result<ExecutionFinalResult> {
        let response = json!({
            "success": true,
            "output": {"Text": output},
            "error": null,
            "resources_used": resources_used(),
            "compilation_note": null,
            "refund_usd": null,
        });
        let small = response.to_string().len() < MAX_YIELD_PAYLOAD;
        let call = if small {
            self.operator
                .call(self.outlayer.id(), "resolve_execution")
                .args_json(json!({"request_id": request_id, "response": response}))
        } else {
            self.operator
                .call(self.outlayer.id(), "submit_execution_output_and_resolve")
                .args_json(json!({
                    "request_id": request_id,
                    "output": {"Text": output},
                    "success": true,
                    "error": null,
                    "resources_used": resources_used(),
                    "compilation_note": null,
                }))
        };
        let result = call.gas(WORKER_GAS).transact().await?;
        self.handled.lock().expect("lock").push(request_id);
        ensure_success(&result).context("the worker's resolve transaction failed")?;
        Ok(result)
    }

    /// Reports the next request as a failed run (`success: false`).
    pub async fn fail_next_request(&self) -> Result<u64> {
        let request_id = self.next_request().await?;
        let result = self
            .operator
            .call(self.outlayer.id(), "resolve_execution")
            .args_json(json!({
                "request_id": request_id,
                "response": {
                    "success": false,
                    "output": null,
                    "error": "sealer exited with code 1",
                    "resources_used": resources_used(),
                    "compilation_note": null,
                    "refund_usd": null,
                },
            }))
            .gas(WORKER_GAS)
            .transact()
            .await?;
        self.handled.lock().expect("lock").push(request_id);
        ensure_success(&result).context("the worker's failure report failed")?;
        Ok(request_id)
    }

    /// Marks the next request as seen without answering it (it will time out).
    pub async fn ignore_next_request(&self) -> Result<u64> {
        let request_id = self.next_request().await?;
        self.handled.lock().expect("lock").push(request_id);
        Ok(request_id)
    }

    /// Requests OutLayer still holds.
    pub async fn pending_requests(&self) -> Result<Vec<u64>> {
        Ok(self
            .outlayer
            .view("get_pending_request_ids")
            .args_json(json!({}))
            .await?
            .json()?)
    }
}

/// The transaction's result as it stands now. Awaiting a transaction returns
/// once its own call is final, before the promises it detached have run (the
/// sealer key request of `create_sale` and `retry_setup`); asking again after
/// they ran gives a result that includes their receipts, logs and gas.
pub async fn result_now(pending: &TransactionStatus) -> Result<ExecutionFinalResult> {
    loop {
        if let Poll::Ready(result) = pending.status().await? {
            return Ok(result);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// The transaction's result once every receipt it led to has run, the
/// promises it detached included. [`result_now`] can return while a transfer
/// the last callback detached (a refund, say) is still waiting for its block:
/// that receipt's gas is then missing from the result, and a check of the
/// signer's balance to the yoctoNEAR is off by it.
pub async fn result_complete(pending: &TransactionStatus) -> Result<ExecutionFinalResult> {
    for _ in 0..100 {
        let result = result_now(pending).await?;
        if every_receipt_ran(&result) {
            return Ok(result);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("the transaction still has receipts waiting after 10 s")
}

/// Whether the result holds an outcome that ran for the transaction and for
/// every receipt any outcome names. A receipt that has not run yet is either
/// missing from the result or listed without having burnt any gas.
fn every_receipt_ran(result: &ExecutionFinalResult) -> bool {
    let outcomes = result.outcomes();
    let ran = |id| {
        outcomes
            .iter()
            .any(|outcome| outcome.transaction_hash == id && outcome.gas_burnt.as_gas() > 0)
    };
    outcomes.iter().all(|outcome| {
        ran(outcome.transaction_hash) && outcome.receipt_ids.iter().all(|id| ran(*id))
    })
}

/// Fails with every failed receipt's error when the transaction failed.
pub fn ensure_success(result: &ExecutionFinalResult) -> Result<()> {
    if result.is_success() {
        return Ok(());
    }
    let failures: Vec<String> = result
        .receipt_failures()
        .iter()
        .map(|outcome| {
            format!(
                "{} ({:?})",
                outcome.executor_id,
                (*outcome).clone().into_result().err()
            )
        })
        .collect();
    bail!("transaction failed: {failures:?}")
}
