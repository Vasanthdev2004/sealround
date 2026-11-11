//! Gas and storage calibration (contracts/GAS.md). Ignored by default; run
//! with `cargo test --test sandbox -- --ignored --test-threads=1 --nocapture gas`
//! (scripts/test-contracts.ps1 -Gas).
//!
//! Every TEE bid is a worst case: a 64-character bidder id in a sale with a
//! 32-character id, so its sealed box (a real one, made by `seal_bid`) is the
//! longest the contract accepts, 320 bytes, and a 21-digit deposit. The
//! sale's supply is near u128::MAX, so fills carry 36-digit token counts.

use anyhow::{Context, Result, ensure};
use fairground_integration::*;
use near_workspaces::Account;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

/// The longest sale id.
const MAX_SALE_ID_LEN: usize = 32;
/// The longest sealed bid: a 32-character sale id and a 64-character bidder.
const MAX_SEALED_BID_BYTES: usize = 320;
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// A bid's settled fill: one `(u128, u128)` in the sale's fills value.
const FILL_BYTES: u64 = 32;
/// An invalid bid's index (a u32) in the sale's invalid-bid list.
const INVALID_ENTRY_BYTES: u64 = 4;
/// What wallets let a transaction attach.
const MAX_PREPAID_TGAS: u64 = 300;
/// The least the relayer client attaches to a relayed `clear_onchain`
/// (`GAS.clear_onchain` in packages/relayer-client/src/actions.ts must not go
/// below this). The relayer refuses more than 150 TGas (`MAX_GAS_TGAS`), so
/// the call has to fit under that even with the longest price search.
const RELAYED_CLEAR_ONCHAIN_TGAS: u64 = 120;

#[tokio::test]
#[ignore = "gas calibration, about 1 minute; run with --ignored"]
async fn gas_100_bids() -> Result<()> {
    calibrate(100).await
}

#[tokio::test]
#[ignore = "gas calibration, about 2 minutes; run with --ignored"]
async fn gas_300_bids() -> Result<()> {
    calibrate(300).await
}

#[tokio::test]
#[ignore = "gas calibration, about 4 minutes; run with --ignored"]
async fn gas_500_bids() -> Result<()> {
    calibrate(500).await
}

/// Commit-reveal at the bid limit: `clear_onchain` reads and clears every bid
/// in one call, with the gas a relayed call attaches.
#[tokio::test]
#[ignore = "gas calibration, about 3 minutes; run with --ignored"]
async fn gas_commit_reveal_500_bids() -> Result<()> {
    calibrate_commit_reveal("gcr", "cr500", 500, |i| 100 + (i as u128 * 7_919) % 900).await
}

/// The same with the price search at its longest: every bid reveals a max
/// price of u128::MAX, so the search halves the whole u128 range (128 steps)
/// and no step above the clearing price can stop early or skip a bid.
#[tokio::test]
#[ignore = "gas calibration, about 3 minutes; run with --ignored"]
async fn gas_commit_reveal_500_bids_widest_search() -> Result<()> {
    calibrate_commit_reveal("gcw", "cw500", 500, |_| u128::MAX).await
}

async fn calibrate_commit_reveal(
    tag: &str,
    sale_id: &str,
    n: usize,
    max_price: impl Fn(usize) -> u128,
) -> Result<()> {
    let env = Env::with_options(tag, EnvOptions { parent_near: 600 }).await?;
    let creator = env.account("creator", 40).await?;
    let mut spec = worst_case_spec(sale_id, Mode::CommitReveal, n);
    spec.reveal_window = Some(120 + n as u64 / 2);
    println!("== {n} commit-reveal bids ({sale_id}) ==");
    let sale = env.create_sale(&creator, spec.clone()).await?;
    print_receipts("create_sale (commit-reveal)", &sale.create_tx);
    println!("  create cost {:.6} NEAR", sale.cost as f64 / 1e24);
    let base_deposit: u128 = 100_000_000_000_000_000_000;
    let bidders = env.bidders("c", n, 300, 2 * base_deposit, Some(64)).await?;
    let plain: Vec<PlainBid> = bidders
        .iter()
        .enumerate()
        .map(|(i, b)| {
            PlainBid::new(
                b.id(),
                base_deposit + i as u128 * 1_000,
                max_price(i),
                base_deposit + i as u128 * 1_000,
            )
        })
        .collect();
    env.wait_open(&sale).await?;
    let before = env.storage_usage(env.fg()).await?;
    let first = env
        .commit(
            &sale,
            &bidders[0],
            plain[0].deposit,
            plain[0].max_price.unwrap(),
            plain[0].max_spend.unwrap(),
        )
        .await?;
    ensure!(first.accepted());
    let mid = env.storage_usage(env.fg()).await?;
    let second = env
        .commit(
            &sale,
            &bidders[1],
            plain[1].deposit,
            plain[1].max_price.unwrap(),
            plain[1].max_spend.unwrap(),
        )
        .await?;
    ensure!(second.accepted());
    let commit_bytes = env.storage_usage(env.fg()).await? - mid;
    print_receipts("commit bid (ft_transfer_call)", &second.tx);
    println!(
        "  storage per commitment: first {}, second {commit_bytes} bytes",
        mid - before
    );
    let rest = parallel((2..n).map(|i| {
        let bid = &plain[i];
        env.commit(
            &sale,
            &bidders[i],
            bid.deposit,
            bid.max_price.unwrap(),
            bid.max_spend.unwrap(),
        )
    }))
    .await?;
    ensure!(rest.iter().all(Bidding::accepted));

    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 20).await?;
    let close = closer
        .call(env.fg(), "close_sale")
        .args_json(json!({"sale_id": sale.id}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure_success(&close)?;
    print_receipts("close_sale (commit-reveal)", &close);
    let before = env.storage_usage(env.fg()).await?;
    let reveals = parallel(bidders.iter().zip(&plain).map(|(bidder, bid)| {
        env.reveal(
            &sale,
            bidder,
            bid.max_price.unwrap(),
            bid.max_spend.unwrap(),
        )
    }))
    .await?;
    for reveal in &reveals {
        ensure_success(reveal)?;
    }
    let (lo, hi) = reveals
        .iter()
        .map(|r| tgas(r.total_gas_burnt.as_gas()))
        .fold((f64::MAX, 0f64), |(lo, hi), g| (lo.min(g), hi.max(g)));
    let reveal_bytes = env.storage_usage(env.fg()).await? - before;
    println!(
        "  reveal_bid: {lo:.2}-{hi:.2} TGas; storage per reveal {} bytes",
        reveal_bytes as f64 / n as f64
    );
    // What create_sale charges per slot covers a commitment, its reveal, its
    // fill and its entry in the invalid-bid list.
    let per_bid = commit_bytes + reveal_bytes.div_ceil(n as u64) + FILL_BYTES + INVALID_ENTRY_BYTES;
    let charged = fairground_const("BID_BYTES_COMMIT_REVEAL") as u64;
    ensure!(
        per_bid <= charged,
        "a commit-reveal bid stores {per_bid} bytes, BID_BYTES_COMMIT_REVEAL is {charged}"
    );

    let reveal_end: u64 = env.sale_view(&sale.id).await?["reveal_end"]
        .as_str()
        .context("reveal_end")?
        .parse()?;
    env.advance_to(reveal_end).await?;
    // With what a relayed call attaches: that must be enough to settle.
    let clear = closer
        .call(env.fg(), "clear_onchain")
        .args_json(json!({"sale_id": sale.id}))
        .gas(Gas::from_tgas(RELAYED_CLEAR_ONCHAIN_TGAS))
        .transact()
        .await?;
    ensure_success(&clear)?;
    ensure!(clear.clone().json::<String>()? == "settled");
    print_receipts("clear_onchain", &clear);
    let receipt = burnt_on(&clear, env.fg().as_str())
        .first()
        .copied()
        .unwrap_or(0.0);
    println!(
        "  clear_onchain: receipt {receipt:.2} TGas of the {RELAYED_CLEAR_ONCHAIN_TGAS} attached"
    );
    let expected = expected_clearing(&spec, &plain);
    let result = env.result_view(&sale.id).await?;
    ensure!(
        u128_field(&result, "clearing_price")? == expected.clearing_price,
        "{result}"
    );
    Ok(())
}

/// The longest amounts: supply near u128::MAX, 21-digit deposits.
fn worst_case_spec(sale_id: &str, mode: Mode, n: usize) -> SaleSpec {
    let mut spec = SaleSpec::new(sale_id, mode);
    spec.total_supply = 300_000_000_000_000_000_000_000_000_000_000_000_000;
    spec.sale_supply = spec.total_supply;
    spec.floor_price = 1;
    spec.min_deposit = USDC;
    spec.max_deposit = 300_000_000_000_000_000_000;
    spec.max_bids = n as u32;
    spec.start_delay = 5;
    // Room to create, fund and place every bid before the window ends.
    spec.window = 120 + n as u64;
    spec
}

/// `prefix` padded with `x` to the longest sale id (32 characters).
fn longest_sale_id(prefix: &str) -> String {
    format!("{prefix:x<MAX_SALE_ID_LEN$}")
}

fn print_receipts(label: &str, tx: &ExecutionFinalResult) {
    let lines = receipt_gas(tx);
    let parts: Vec<String> = lines
        .iter()
        .map(|line| {
            format!(
                "{} {:.2}",
                line.executor.split('.').next().unwrap_or(""),
                line.tgas
            )
        })
        .collect();
    println!(
        "  {label}: total {:.2} TGas = {}",
        tgas(tx.total_gas_burnt.as_gas()),
        parts.join(" + ")
    );
}

/// Gas of the receipts that `executor` ran, in order.
fn burnt_on(tx: &ExecutionFinalResult, executor: &str) -> Vec<f64> {
    receipt_gas(tx)
        .into_iter()
        .filter(|line| line.executor == executor)
        .map(|line| line.tgas)
        .collect()
}

/// `close_sale` with too little gas fails before any promise with "attach at
/// least N TGas", where N is what its checks require. Returns N, or `None`
/// if this much gas did not even reach the check.
async fn required_close_gas(
    env: &Env,
    closer: &Account,
    sale_id: &str,
    deposit: u128,
    probe_tgas: u64,
) -> Result<Option<u64>> {
    let tx = closer
        .call(env.fg(), "close_sale")
        .args_json(json!({"sale_id": sale_id}))
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(probe_tgas))
        .transact()
        .await?;
    ensure!(tx.is_failure(), "the {probe_tgas} TGas probe went through");
    let text = format!("{:?}", tx.into_result().err());
    Ok(text
        .split("attach at least ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .and_then(|n| n.parse().ok()))
}

async fn calibrate(n: usize) -> Result<()> {
    let env = Env::with_options(&format!("g{n}"), EnvOptions { parent_near: 600 }).await?;
    let creator = env.account("creator", 40).await?;
    let spec = worst_case_spec(&longest_sale_id(&format!("gas{n}")), Mode::Tee, n);
    ensure!(spec.sale_id.len() == MAX_SALE_ID_LEN);
    println!("== {n} worst-case bids ==");

    let fg_before = env.storage_usage(env.fg()).await?;
    let sale = env.create_sale(&creator, spec.clone()).await?;
    let fg_after_create = env.storage_usage(env.fg()).await?;
    print_receipts("create_sale", &sale.create_tx);
    println!("  create cost {:.6} NEAR", sale.cost as f64 / 1e24);
    let token = env.worker.view_account(&sale.token).await?;
    println!(
        "  storage: sale {} bytes (first sale: + quote token entry); token account {} bytes, balance covers {} bytes",
        fg_after_create - fg_before,
        token.storage_usage,
        token.balance.as_yoctonear() / YOCTO_PER_BYTE
    );
    // The deploy balance pays for the token account's own storage.
    ensure!(
        token.balance.as_yoctonear() >= u128::from(token.storage_usage) * YOCTO_PER_BYTE,
        "the token account cannot pay for its {} bytes",
        token.storage_usage
    );

    let base_deposit: u128 = 100_000_000_000_000_000_000;
    let bidders = env.bidders("b", n, 300, 2 * base_deposit, Some(64)).await?;
    ensure!(bidders.iter().all(|b| b.id().as_str().len() == 64));
    let mut plain = Vec::with_capacity(n);
    let mut msgs = Vec::with_capacity(n);
    for (i, bidder) in bidders.iter().enumerate() {
        let deposit = base_deposit + i as u128 * 1_000;
        let price = 100 + (i as u128 * 7_919) % 900;
        plain.push(PlainBid::new(bidder.id(), deposit, price, deposit));
        // A real sealed bid; at these id lengths it is the longest there is.
        ensure!(sealed_len(&sale.id, bidder.id()) == MAX_SEALED_BID_BYTES);
        msgs.push(tee_msg(
            &sale.id,
            &env.seal(&sale, bidder.id(), price, deposit),
        ));
    }

    env.wait_open(&sale).await?;
    // Bids 0 and 1 alone, to measure storage; the first also creates the
    // sale's deposits list.
    let mut bid_gas = Vec::with_capacity(n);
    let mut one_by_one = Vec::new();
    for i in 0..2 {
        let before = env.storage_usage(env.fg()).await?;
        let placed = env.deposit(&bidders[i], plain[i].deposit, &msgs[i]).await?;
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
        one_by_one.push(env.storage_usage(env.fg()).await? - before);
        bid_gas.push(tgas(placed.tx.total_gas_burnt.as_gas()));
        if i == 0 {
            print_receipts("bid (ft_transfer_call)", &placed.tx);
        }
    }
    let before_rest = env.storage_usage(env.fg()).await?;
    let started = std::time::Instant::now();
    let rest =
        parallel((2..n).map(|i| env.deposit(&bidders[i], plain[i].deposit, &msgs[i]))).await?;
    for placed in rest {
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
        bid_gas.push(tgas(placed.tx.total_gas_burnt.as_gas()));
    }
    let rest_bytes = env.storage_usage(env.fg()).await? - before_rest;
    let (lo, hi) = bid_gas
        .iter()
        .fold((f64::MAX, 0f64), |(lo, hi), g| (lo.min(*g), hi.max(*g)));
    println!(
        "  bids: {n} placed ({:?} for the parallel part); ft_transfer_call total {lo:.2}-{hi:.2} TGas",
        started.elapsed()
    );
    println!(
        "  storage per bid: first {} bytes, second {} bytes, the other {} average {} bytes",
        one_by_one[0],
        one_by_one[1],
        n - 2,
        rest_bytes as f64 / (n - 2) as f64
    );
    // What create_sale charges per slot covers the worst-case bid, its fill
    // and its entry in the invalid-bid list.
    let per_bid = one_by_one[1] + FILL_BYTES + INVALID_ENTRY_BYTES;
    let charged = fairground_const("BID_BYTES_TEE") as u64;
    ensure!(
        per_bid <= charged,
        "a TEE bid stores {per_bid} bytes, BID_BYTES_TEE is {charged}"
    );

    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 20).await?;
    let deposit = u128_value(
        &env.view(env.fg(), "get_close_deposit", json!({"sale_id": sale.id}))
            .await?,
    )?;
    let probe = 30 + (n as u64 * 3) / 10;
    let required = required_close_gas(&env, &closer, &sale.id, deposit, probe)
        .await?
        .context("the probe did not even reach close_sale's gas check")?;
    println!(
        "  close_sale: deposit {} NEAR; requires {required} TGas prepaid (probe {probe})",
        deposit as f64 / 1e24
    );
    ensure!(
        required <= MAX_PREPAID_TGAS,
        "close_sale asks {required} TGas, more than a transaction can attach"
    );

    // Refund receipts are not part of a transaction's result: let them land.
    let settle = || tokio::time::sleep(std::time::Duration::from_secs(2));
    settle().await;
    let near_before = env.near_balance(closer.id()).await?;
    let fg_before_close = env.storage_usage(env.fg()).await?;
    // Exactly what the check asked for: that must be enough to settle.
    let pending = closer
        .call(env.fg(), "close_sale")
        .args_json(json!({"sale_id": sale.id}))
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(required))
        .transact_async()
        .await?;
    let sealer_started = std::time::Instant::now();
    let served = env.serve().await?;
    let sealer_time = sealer_started.elapsed();
    let close = pending.await?;
    ensure_success(&close)?;
    let status: String = close.clone().json()?;
    ensure!(status == "settled", "close_sale returned {status}");
    settle().await;
    let closer_paid = near_before - env.near_balance(closer.id()).await?;
    for outcome in close
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == *env.outlayer.id())
    {
        for log in &outcome.logs {
            if log.starts_with("Execution completed") {
                println!("  OutLayer: {log}");
            }
        }
    }
    print_receipts("close_sale", &close);
    let fg = burnt_on(&close, env.fg().as_str());
    let ol = burnt_on(&close, env.outlayer.id().as_str());
    println!(
        "  close_sale: input {} bytes, output {} bytes; close receipt {:.2}, request_execution {:.2}, OutLayer callback {:.2}, on_clearing_result {:.2} TGas; worker tx {:.2} TGas; worker step {:?}; closer paid {:.6} NEAR",
        served.input.len(),
        served.output.len(),
        fg.first().copied().unwrap_or(0.0),
        ol.first().copied().unwrap_or(0.0),
        ol.get(1).copied().unwrap_or(0.0),
        fg.get(1).copied().unwrap_or(0.0),
        tgas(served.worker_tx.total_gas_burnt.as_gas()),
        sealer_time,
        closer_paid as f64 / 1e24,
    );
    println!(
        "  storage at settlement: {} bytes",
        env.storage_usage(env.fg()).await? - fg_before_close
    );

    let expected = expected_clearing(&spec, &plain);
    let result = env.result_view(&sale.id).await?;
    ensure!(
        u128_field(&result, "clearing_price")? == expected.clearing_price,
        "{result}"
    );
    ensure!(
        result["n_valid"] == n
            && result["n_winners"] == expected.fills.iter().filter(|f| f.tokens > 0).count()
    );

    // A winner (tokens and refund) and, if any, a bid that won nothing.
    let winner = expected
        .fills
        .iter()
        .position(|f| f.tokens > 0 && f.refund > 0)
        .or_else(|| expected.fills.iter().position(|f| f.tokens > 0))
        .context("no winner")?;
    let claim = env.claim(&bidders[winner], &sale.id, None).await?;
    ensure_success(&claim)?;
    print_receipts("claim (tokens + refund)", &claim);
    if let Some(loser) = expected.fills.iter().position(|f| f.tokens == 0) {
        let claim = env.claim(&bidders[loser], &sale.id, None).await?;
        ensure_success(&claim)?;
        print_receipts("claim (refund only)", &claim);
    }
    let proceeds = env.claim_proceeds(&closer, &sale.id).await?;
    ensure_success(&proceeds)?;
    ensure!(event(&proceeds, "proceeds_claimed").is_some_and(|e| e["failed"] == json!([])));
    print_receipts("claim_proceeds", &proceeds);
    Ok(())
}
