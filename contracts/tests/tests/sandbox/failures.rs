//! Sales that do not settle the easy way: failed runs, timeouts, refund mode,
//! a missed minimum raise, no bids, and a result that fails the checks.

use anyhow::{Result, ensure};
use fairground_integration::*;
use near_workspaces::Account;
use near_workspaces::operations::TransactionStatus;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};

/// A TEE sale with three valid bids placed and the window over.
async fn sale_with_bids(
    env: &Env,
    creator: &Account,
    spec: SaleSpec,
) -> Result<(Sale, Vec<Account>, Vec<PlainBid>)> {
    let sale = env.create_sale(creator, spec).await?;
    let bidders = env
        .bidders(&format!("{}b", sale.id), 3, 2_000, 1_000 * USDC, None)
        .await?;
    let plain = vec![
        PlainBid::new(bidders[0].id(), 200 * USDC, 2_000, 150 * USDC),
        PlainBid::new(bidders[1].id(), 100 * USDC, 1_500, 100 * USDC),
        PlainBid::new(bidders[2].id(), 50 * USDC, 1_000, 50 * USDC),
    ];
    env.wait_open(&sale).await?;
    for (bidder, bid) in bidders.iter().zip(&plain) {
        let placed = env
            .bid(
                &sale,
                bidder,
                bid.deposit,
                bid.max_price.unwrap(),
                bid.max_spend.unwrap(),
            )
            .await?;
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
    }
    Ok((sale, bidders, plain))
}

/// Full refunds for every bidder of a failed sale.
fn refunds(plain: &[PlainBid]) -> Vec<(u128, u128)> {
    plain.iter().map(|bid| (0, bid.deposit)).collect()
}

fn refs(accounts: &[Account]) -> Vec<&Account> {
    accounts.iter().collect()
}

/// OutLayer's charge for a run the worker reports as 1M instructions and
/// 100 ms (see `resources_used` in the harness) at a per-ms fee of
/// `per_ms_fee`: base fee + 1 x the per-million fee + 100 x the per-ms fee.
fn run_charge(per_ms_fee: u128) -> u128 {
    fairground_const("OUTLAYER_BASE_FEE")
        + fairground_const("OUTLAYER_PER_MILLION_INSTRUCTIONS_FEE")
        + 100 * per_ms_fee
}

/// [`run_charge`] at the prices the contract assumes (OutLayer's defaults).
fn reported_run_charge() -> u128 {
    run_charge(fairground_const("OUTLAYER_PER_MS_FEE"))
}

/// The sealer run fails (`success: false`, which reaches Fairground as
/// `null`), then a run prints nothing (Text `""`): each time the sale goes to
/// `closed`, the closer gets back all but OutLayer's charge, and anyone can
/// retry the close.
#[tokio::test]
async fn failed_run_then_retry_settles() -> Result<()> {
    let env = Env::new("frun").await?;
    let creator = env.account("creator", 30).await?;
    let spec = SaleSpec::new("frun", Mode::Tee);
    let (sale, bidders, plain) = sale_with_bids(&env, &creator, spec.clone()).await?;
    env.wait_ended(&sale).await?;

    let closer = env.account("closer", 10).await?;
    let before = env.near_balance(closer.id()).await?;
    let (pending, deposit) = env.start_close(&closer, &sale.id).await?;
    ensure!(deposit > 0);
    env.fail_next_request().await?;
    let close = pending.await?;
    ensure_success(&close)?;
    ensure!(close.clone().json::<String>()? == "closed");
    let failed = event(&close, "clearing_failed").expect("clearing_failed event");
    ensure!(failed["attempt"] == 1, "{failed}");
    // OutLayer keeps the charge for the reported run; the rest of the
    // deposit is back with the closer.
    ensure!(outlayer_charged(&close) == reported_run_charge());
    env.ensure_near_kept(closer.id(), before, &close, reported_run_charge())
        .await?;
    let result = env.result_view(&sale.id).await?;
    ensure!(
        result["status"] == "closed"
            && result["clear_attempts"] == 1
            && result["clear_requests"] == 1,
        "{result}"
    );
    // Still closed: no bid is accepted any more.
    ensure!(
        env.deposit(&bidders[0], USDC, &tee_msg(&sale.id, "AAAA"))
            .await?
            .used
            == 0
    );

    // A run that exits 0 without printing reaches Fairground as the Text
    // string "": not an answer, so the sale stays retryable.
    let retrier = env.account("retrier", 10).await?;
    let (pending, _) = env.start_close(&retrier, &sale.id).await?;
    env.serve_with(|_, _| String::new()).await?;
    let blank = pending.await?;
    ensure_success(&blank)?;
    ensure!(blank.clone().json::<String>()? == "closed");
    let result = env.result_view(&sale.id).await?;
    ensure!(
        result["clear_attempts"] == 2 && result["result_sha256"].is_null(),
        "{result}"
    );

    let (retry, _) = env.close_and_clear(&retrier, &sale.id).await?;
    ensure!(retry.json::<String>()? == "settled");
    let result = env.result_view(&sale.id).await?;
    ensure!(
        result["clear_attempts"] == 2 && result["clear_requests"] == 3,
        "{result}"
    );
    let expected = expected_clearing(&spec, &plain);
    env.check_fills(&sale, &plain, &expected, &[]).await?;
    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .map(|f| (f.tokens, f.refund))
        .collect();
    env.claim_all(&sale, &refs(&bidders), &owed, None).await?;
    Ok(())
}

/// Nobody answers the request: after 200 blocks OutLayer's yield times out,
/// Fairground's callback gets `null` and the sale goes to `closed`; a late
/// answer is refused; a retry settles the sale.
#[tokio::test]
async fn outlayer_timeout_then_retry_settles() -> Result<()> {
    let env = Env::new("tout").await?;
    let creator = env.account("creator", 30).await?;
    let spec = SaleSpec::new("tout", Mode::Tee);
    let (sale, bidders, plain) = sale_with_bids(&env, &creator, spec.clone()).await?;
    env.wait_ended(&sale).await?;

    let closer = env.account("closer", 10).await?;
    let before = env.near_balance(closer.id()).await?;
    let (pending, _) = env.start_close(&closer, &sale.id).await?;
    let request = env.ignore_next_request().await?;
    let input = env.request_input(request).await?;
    env.worker.fast_forward(205).await?;
    let close = pending.await?;
    ensure_success(&close)?;
    ensure!(close.clone().json::<String>()? == "closed");
    let failed = event(&close, "clearing_failed").expect("clearing_failed event");
    ensure!(
        failed["reason"]
            .as_str()
            .is_some_and(|r| r.contains("timed out")),
        "{failed}"
    );
    // A timeout costs the closer OutLayer's base fee; the rest comes back.
    let base_fee = fairground_const("OUTLAYER_BASE_FEE");
    ensure!(outlayer_charged(&close) == base_fee);
    env.ensure_near_kept(closer.id(), before, &close, base_fee)
        .await?;
    ensure!(!env.pending_requests().await?.contains(&request));
    // The worker's answer after the timeout is refused by OutLayer.
    ensure!(
        env.resolve(request, &env.sealer_output(&input))
            .await
            .is_err()
    );
    ensure!(env.status(&sale.id).await? == "closed");

    let (retry, _) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(retry.json::<String>()? == "settled");
    let expected = expected_clearing(&spec, &plain);
    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .map(|f| (f.tokens, f.refund))
        .collect();
    env.claim_all(&sale, &refs(&bidders), &owed, None).await?;
    Ok(())
}

/// OutLayer refuses the request at the door (here: paused by its owner).
/// The deposit comes back to Fairground, which passes it on to the closer;
/// the sale goes to `closed`, and a retry settles it once OutLayer accepts.
#[tokio::test]
async fn refused_request_refunds_the_closer() -> Result<()> {
    let env = Env::new("refus").await?;
    let creator = env.account("creator", 30).await?;
    let spec = SaleSpec::new("refus", Mode::Tee);
    let (sale, bidders, plain) = sale_with_bids(&env, &creator, spec.clone()).await?;
    env.wait_ended(&sale).await?;
    let set_paused = |paused: bool| {
        env.operator
            .call(env.outlayer.id(), "set_paused")
            .args_json(json!({"paused": paused}))
            .transact()
    };
    set_paused(true).await?.into_result()?;

    let closer = env.account("closer", 10).await?;
    let before = env.near_balance(closer.id()).await?;
    let (pending, deposit) = env.start_close(&closer, &sale.id).await?;
    // The refund is a transfer `on_clearing_result` detaches. It runs a block
    // after the call's own result is known, so wait for it: its gas is part
    // of what the closer paid.
    let close = result_complete(&pending).await?;
    ensure_success(&close)?;
    ensure!(close.clone().json::<String>()? == "closed");
    let failed = event(&close, "clearing_failed").expect("clearing_failed event");
    ensure!(
        failed["reason"]
            .as_str()
            .is_some_and(|r| r.contains("refused")),
        "{failed}"
    );
    ensure!(env.pending_requests().await?.is_empty());
    // Refused at the door: nothing charged, the whole deposit is back.
    ensure!(deposit > 0 && outlayer_charged(&close) == 0);
    env.ensure_near_kept(closer.id(), before, &close, 0).await?;
    ensure!(env.result_view(&sale.id).await?["clear_attempts"] == 1);

    set_paused(false).await?.into_result()?;
    let (retry, _) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(retry.json::<String>()? == "settled");
    let expected = expected_clearing(&spec, &plain);
    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .map(|f| (f.tokens, f.refund))
        .collect();
    env.claim_all(&sale, &refs(&bidders), &owed, None).await?;
    Ok(())
}

/// `create_sale` for `spec` with `get_create_cost` plus `excess` NEAR
/// attached, without waiting. Returns the pending transaction and the cost.
async fn start_create(
    env: &Env,
    creator: &Account,
    spec: &SaleSpec,
    excess: u128,
) -> Result<(TransactionStatus, u128)> {
    let bid_start = env.now().await? + spec.start_delay * SECOND;
    let params = spec.params(bid_start, env.usdc.id());
    let cost = u128_value(
        &env.view(env.fg(), "get_create_cost", json!({"params": params}))
            .await?,
    )?;
    let pending = creator
        .call(env.fg(), "create_sale")
        .args_json(json!({"params": params}))
        .deposit(NearToken::from_yoctonear(cost + excess))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    Ok((pending, cost))
}

/// `retry_setup(sale_id)` by `caller` with `deposit` attached, not waited for.
async fn start_retry_setup(
    env: &Env,
    caller: &Account,
    sale_id: &str,
    deposit: u128,
) -> Result<TransactionStatus> {
    Ok(caller
        .call(env.fg(), "retry_setup")
        .args_json(json!({"sale_id": sale_id}))
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?)
}

/// The sealer's `pubkey` run fails: the sale stays in `setup` (no bids), the
/// creator gets back all of the key deposit but OutLayer's charge, and anyone
/// can `retry_setup`, paying the OutLayer deposit, to finish it.
#[tokio::test]
async fn failed_sealer_key_then_retry_setup() -> Result<()> {
    let env = Env::new("rkey").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("rkey", Mode::Tee);
    spec.start_delay = 30;
    let before = env.near_balance(creator.id()).await?;
    let (pending, cost) = start_create(&env, &creator, &spec, 0).await?;
    env.fail_next_request().await?;
    ensure_success(&result_now(&pending).await?)?;
    let sale = env
        .sale_when(&spec.sale_id, |s| {
            s["sealer_key_setup"] != "pending" && s["token_setup"] != "pending"
        })
        .await?;
    ensure!(
        sale["status"] == "setup"
            && sale["sealer_key_setup"] == "failed"
            && sale["token_setup"] == "done",
        "{sale}"
    );
    ensure!(sale["sealer_pubkey"].is_null());
    // The creator paid the cost, minus the key deposit OutLayer refunded
    // after keeping its charge for the failed run.
    let create = result_now(&pending).await?;
    ensure!(outlayer_charged(&create) == reported_run_charge());
    let kept = cost - outlayer_compute_deposit() + reported_run_charge();
    env.ensure_near_kept(creator.id(), before, &create, kept)
        .await?;

    let helper = env.account("helper", 10).await?;
    // The key job needs at least its OutLayer deposit (0.01401 NEAR).
    expect_failure(
        &start_retry_setup(&env, &helper, &spec.sale_id, 0)
            .await?
            .await?,
        "is below the required",
    )?;
    // All of it goes to OutLayer, which refunds the helper what it does not charge.
    let before = env.near_balance_settled(helper.id()).await?;
    let pending = start_retry_setup(&env, &helper, &spec.sale_id, 20 * NEAR / 1_000).await?;
    let served = env.serve().await?;
    ensure!(
        served.input.contains(r#""op":"pubkey""#),
        "{}",
        served.input
    );
    ensure_success(&result_now(&pending).await?)?;
    let sale = env
        .sale_when(&spec.sale_id, |s| s["sealer_key_setup"] != "pending")
        .await?;
    ensure!(
        sale["sealer_key_setup"] == "done" && sale["status"] != "setup",
        "{sale}"
    );
    let retried = result_now(&pending).await?;
    ensure!(outlayer_charged(&retried) == reported_run_charge());
    env.ensure_near_kept(helper.id(), before, &retried, reported_run_charge())
        .await?;
    let served: Value = serde_json::from_str(&served.output)?;
    ensure!(sale["sealer_pubkey"] == served["pubkey"]);
    // Nothing failed any more.
    expect_failure(
        &start_retry_setup(&env, &helper, &spec.sale_id, 0)
            .await?
            .await?,
        "nothing to retry",
    )?;
    Ok(())
}

/// OutLayer's owner raises its prices past the 2x margin of the fixed key
/// deposit. The key request is refused at the door (the deposit comes back),
/// a retry with only the fixed deposit is refused again, and a retry with
/// more attached gets through: retry_setup forwards everything. A sale
/// created with NEAR to spare gets its key at once: create_sale forwards
/// the excess too.
#[tokio::test]
async fn key_requests_get_through_an_outlayer_price_rise() -> Result<()> {
    let env = Env::new("price").await?;
    // 0.00025 NEAR per ms: 60 s now cost 0.015 NEAR, above the 0.01401 sent.
    let per_ms_fee: u128 = 250_000_000_000_000_000;
    env.operator
        .call(env.outlayer.id(), "set_pricing")
        .args_json(json!({"per_ms_fee": per_ms_fee.to_string()}))
        .transact()
        .await?
        .into_result()?;
    let estimate = u128_value(
        &env.view(
            env.outlayer.id(),
            "estimate_execution_cost",
            json!({"resource_limits": {"max_instructions": 50_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60}}),
        )
        .await?,
    )?;
    ensure!(estimate > outlayer_compute_deposit(), "estimate {estimate}");
    let charge = run_charge(per_ms_fee);

    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("price", Mode::Tee);
    spec.start_delay = 30;
    let before = env.near_balance(creator.id()).await?;
    let (pending, cost) = start_create(&env, &creator, &spec, 0).await?;
    ensure_success(&result_now(&pending).await?)?;
    let sale = env
        .sale_when(&spec.sale_id, |s| s["sealer_key_setup"] != "pending")
        .await?;
    ensure!(sale["sealer_key_setup"] == "failed", "{sale}");
    // Refused at the door: Fairground handed the whole key deposit back.
    let create = result_now(&pending).await?;
    ensure!(outlayer_charged(&create) == 0);
    env.ensure_near_kept(
        creator.id(),
        before,
        &create,
        cost - outlayer_compute_deposit(),
    )
    .await?;

    // Only the fixed deposit: refused again.
    let helper = env.account("helper", 10).await?;
    let pending =
        start_retry_setup(&env, &helper, &spec.sale_id, outlayer_compute_deposit()).await?;
    ensure_success(&result_now(&pending).await?)?;
    let sale = env
        .sale_when(&spec.sale_id, |s| s["sealer_key_setup"] != "pending")
        .await?;
    ensure!(sale["sealer_key_setup"] == "failed", "{sale}");

    // More attached: all of it is forwarded, and the request gets through.
    let before = env.near_balance_settled(helper.id()).await?;
    let pending = start_retry_setup(&env, &helper, &spec.sale_id, 50 * NEAR / 1_000).await?;
    env.serve().await?;
    ensure_success(&result_now(&pending).await?)?;
    let sale = env
        .sale_when(&spec.sale_id, |s| s["sealer_key_setup"] != "pending")
        .await?;
    ensure!(
        sale["sealer_key_setup"] == "done" && sale["status"] != "setup",
        "{sale}"
    );
    let retried = result_now(&pending).await?;
    ensure!(outlayer_charged(&retried) == charge);
    env.ensure_near_kept(helper.id(), before, &retried, charge)
        .await?;

    // Created with 0.05 NEAR to spare: the key goes through first time.
    let mut spec = SaleSpec::new("price2", Mode::Tee);
    spec.start_delay = 30;
    let before = env.near_balance_settled(creator.id()).await?;
    let (pending, cost) = start_create(&env, &creator, &spec, 50 * NEAR / 1_000).await?;
    env.serve().await?;
    ensure_success(&result_now(&pending).await?)?;
    let sale = env
        .sale_when(&spec.sale_id, |s| s["sealer_key_setup"] != "pending")
        .await?;
    ensure!(sale["sealer_key_setup"] == "done", "{sale}");
    // The key deposit and the excess went to OutLayer; all of it came back
    // but what OutLayer charged.
    let create = result_now(&pending).await?;
    ensure!(outlayer_charged(&create) == charge);
    env.ensure_near_kept(
        creator.id(),
        before,
        &create,
        cost - outlayer_compute_deposit() + charge,
    )
    .await?;
    Ok(())
}

/// After the settle timeout anyone can fail a sale that never settled, from
/// `closed` (its clearing timed out) and from `awaiting_close` (nobody
/// closed it). Everyone gets the whole deposit back and every sale token is
/// burned except the creator's allocation.
#[tokio::test]
async fn settle_timeout_refund_mode() -> Result<()> {
    let env = Env::new("rmode").await?;
    let creator = env.account("creator", 30).await?;
    let (closed, closed_bidders, closed_plain) =
        sale_with_bids(&env, &creator, SaleSpec::new("rclosed", Mode::Tee)).await?;
    let (open, open_bidders, open_plain) =
        sale_with_bids(&env, &creator, SaleSpec::new("ropen", Mode::Tee)).await?;
    env.advance_to(closed.bid_end.max(open.bid_end)).await?;

    let closer = env.account("closer", 10).await?;
    let (pending, _) = env.start_close(&closer, &closed.id).await?;
    env.ignore_next_request().await?;
    env.worker.fast_forward(205).await?;
    ensure!(pending.await?.json::<String>()? == "closed");
    ensure!(env.status(&open.id).await? == "awaiting_close");

    let anyone = env.account("anyone", 10).await?;
    let trigger = |sale_id: String| {
        let anyone = anyone.clone();
        let fg = env.fg().clone();
        async move {
            anyone
                .call(&fg, "trigger_refund_mode")
                .args_json(json!({"sale_id": sale_id}))
                .transact()
                .await
        }
    };
    expect_failure(
        &trigger(closed.id.clone()).await?,
        "cannot trigger refund mode before",
    )?;
    let mut latest = 0;
    for sale in [&closed, &open] {
        let at: u64 = env.sale_view(&sale.id).await?["refund_mode_at"]
            .as_str()
            .expect("refund_mode_at")
            .parse()?;
        latest = latest.max(at);
    }
    env.advance_to(latest).await?;
    for (sale, from) in [(&closed, "closed"), (&open, "awaiting_close")] {
        let tx = trigger(sale.id.clone()).await?;
        ensure_success(&tx)?;
        ensure!(event(&tx, "refund_mode").expect("refund_mode event")["from"] == from);
        let result = env.result_view(&sale.id).await?;
        ensure!(
            result["status"] == "failed" && result["fail_reason"] == "refund_mode",
            "{result}"
        );
    }
    // Final: no more closing, no second refund mode.
    let tx = closer
        .call(env.fg(), "close_sale")
        .args_json(json!({"sale_id": closed.id}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    expect_failure(&tx, "sale is failed")?;
    expect_failure(&trigger(open.id.clone()).await?, "sale is failed")?;

    env.claim_all(
        &closed,
        &refs(&closed_bidders),
        &refunds(&closed_plain),
        Some(&anyone),
    )
    .await?;
    env.claim_all(&open, &refs(&open_bidders), &refunds(&open_plain), None)
        .await?;
    let spec = &closed.spec;
    let per_bid = env.per_bid_reserve(spec).await?;
    for sale in [&closed, &open] {
        let near_refund = env
            .claim_proceeds_checked(
                &anyone,
                sale,
                Proceeds {
                    raise: 0,
                    allocation: spec.total_supply - spec.sale_supply,
                    burned: spec.sale_supply,
                },
            )
            .await?;
        // Unused slots, the three bids' unused token registrations and the
        // creator's unused USDC registration.
        ensure!(
            near_refund == 17 * per_bid + 4 * STORAGE_DEPOSIT,
            "{near_refund}"
        );
    }
    ensure!(env.usdc_balance(env.fg()).await? == 0);
    Ok(())
}

/// Valid bids that raise less than `min_raise`: the sale fails and every
/// deposit comes back.
#[tokio::test]
async fn below_min_raise_fails_and_refunds() -> Result<()> {
    let env = Env::new("minr").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("minr", Mode::Tee);
    spec.min_raise = 1_000 * USDC;
    let (sale, bidders, plain) = sale_with_bids(&env, &creator, spec.clone()).await?;
    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let (close, served) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(close.clone().json::<String>()? == "failed");
    let output: Value = serde_json::from_str(&served.output)?;
    ensure!(
        output["fills"]
            .as_array()
            .is_some_and(|f| f.iter().all(|f| *f == json!(["0", "0"]))),
        "{output}"
    );
    let result = env.result_view(&sale.id).await?;
    ensure!(
        result["fail_reason"] == "below_min_raise" && result["n_valid"] == 3,
        "{result}"
    );
    ensure!(event(&close, "sale_failed").expect("sale_failed")["reason"] == "below_min_raise");
    env.check_fills(&sale, &plain, &expected_clearing(&spec, &plain), &[])
        .await?;
    env.claim_all(&sale, &refs(&bidders), &refunds(&plain), None)
        .await?;
    env.claim_proceeds_checked(
        &closer,
        &sale,
        Proceeds {
            raise: 0,
            allocation: spec.total_supply - spec.sale_supply,
            burned: spec.sale_supply,
        },
    )
    .await?;
    ensure!(env.ft_supply(&sale.token).await? == spec.total_supply - spec.sale_supply);
    Ok(())
}

/// Closing a sale without bids fails it at once (no OutLayer call) and
/// returns the NEAR the closer attached.
#[tokio::test]
async fn no_bids_fails_without_outlayer() -> Result<()> {
    let env = Env::new("nobid").await?;
    let creator = env.account("creator", 30).await?;
    let spec = SaleSpec::new("nobid", Mode::Tee);
    let sale = env.create_sale(&creator, spec.clone()).await?;
    env.wait_ended(&sale).await?;
    ensure!(
        env.view(env.fg(), "get_close_deposit", json!({"sale_id": sale.id}))
            .await?
            == "0"
    );
    let closer = env.account("closer", 10).await?;
    let before = env.near_balance(closer.id()).await?;
    let close = closer
        .call(env.fg(), "close_sale")
        .args_json(json!({"sale_id": sale.id}))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure_success(&close)?;
    ensure!(close.clone().json::<String>()? == "failed");
    // Only gas was spent: the attached NEAR came back.
    env.ensure_near_kept(closer.id(), before, &close, 0).await?;
    ensure!(env.pending_requests().await?.is_empty());
    let result = env.result_view(&sale.id).await?;
    ensure!(result["fail_reason"] == "no_bids", "{result}");
    let per_bid = env.per_bid_reserve(&spec).await?;
    let near_refund = env
        .claim_proceeds_checked(
            &closer,
            &sale,
            Proceeds {
                raise: 0,
                allocation: spec.total_supply - spec.sale_supply,
                burned: spec.sale_supply,
            },
        )
        .await?;
    ensure!(
        near_refund == 20 * per_bid + STORAGE_DEPOSIT,
        "{near_refund}"
    );
    Ok(())
}

/// A result that does not add up (a fill spending more than its deposit,
/// a wrong bid-set hash) fails the contract's checks: the sale fails with the
/// failed checks by name and everyone is refunded. Malformed output fails the
/// same way, as `output_well_formed`.
#[tokio::test]
async fn results_that_fail_the_checks_fail_the_sale() -> Result<()> {
    let env = Env::new("chk").await?;
    let creator = env.account("creator", 40).await?;
    let (bad, bad_bidders, bad_plain) =
        sale_with_bids(&env, &creator, SaleSpec::new("chkbad", Mode::Tee)).await?;
    let (garbled, garbled_bidders, garbled_plain) =
        sale_with_bids(&env, &creator, SaleSpec::new("chkjunk", Mode::Tee)).await?;
    env.advance_to(bad.bid_end.max(garbled.bid_end)).await?;
    let closer = env.account("closer", 10).await?;

    let (pending, _) = env.start_close(&closer, &bad.id).await?;
    env.serve_with(|_, output| {
        let mut output: Value = serde_json::from_str(output).expect("sealer JSON");
        output["fills"][0][1] = json!((10_000 * USDC).to_string());
        output["bid_set_hash"] = json!("00".repeat(32));
        output.to_string()
    })
    .await?;
    let close = pending.await?;
    ensure_success(&close)?;
    ensure!(close.clone().json::<String>()? == "failed");
    let result = env.result_view(&bad.id).await?;
    ensure!(result["fail_reason"] == "checks_failed", "{result}");
    let checks: Vec<&str> = result["failed_checks"]
        .as_array()
        .expect("checks")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for name in [
        "bid_set_hash_matches",
        "spent_within_deposit_0",
        "spent_equals_tokens_times_price_0",
    ] {
        ensure!(checks.contains(&name), "{name} not in {checks:?}");
    }
    ensure!(result["result_sha256"].is_string());
    env.claim_all(&bad, &refs(&bad_bidders), &refunds(&bad_plain), None)
        .await?;

    let before = env.near_balance_settled(closer.id()).await?;
    let (pending, _) = env.start_close(&closer, &garbled.id).await?;
    env.serve_with(|_, _| "not json".to_owned()).await?;
    let close = pending.await?;
    ensure!(close.clone().json::<String>()? == "failed");
    let result = env.result_view(&garbled.id).await?;
    ensure!(
        result["fail_reason"] == "checks_failed"
            && result["failed_checks"] == json!(["output_well_formed"])
            && result["total_penalties"] == "0",
        "{result}"
    );
    // The run itself succeeded: the closer pays OutLayer's charge for it.
    ensure!(outlayer_charged(&close) == reported_run_charge());
    env.ensure_near_kept(closer.id(), before, &close, reported_run_charge())
        .await?;
    env.claim_all(
        &garbled,
        &refs(&garbled_bidders),
        &refunds(&garbled_plain),
        None,
    )
    .await?;
    ensure!(env.usdc_balance(env.fg()).await? == 0);
    Ok(())
}
