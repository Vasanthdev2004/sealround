//! Instructions, memory and time of a clear by bid count, against OutLayer's
//! limits: 1e9 instructions by default (500e9 at most), 60 s by default, and
//! the ~117 s yield window (200 blocks) in which the result must land; and
//! against what the sale contract asks for, `SEALER_MAX_INSTRUCTIONS` = 5e10
//! (contracts/fairground/src/costs.rs). Run with `--nocapture` to see the
//! table; PERF.md records it.
//!
//! A test binary of its own, so no other test runs beside it and skews the
//! times. See `common/mod.rs` for how to build the module first.

mod common;

use std::time::Duration;

use common::{answer, generous, on_chain, runner};
use fairground_harness::{
    BidBook, CONTRACT, Kind, LEGACY_MAX_CIPHERTEXT_BYTES, ctx, pubkey_request,
};
use fairground_runner::{DEFAULT_MAX_EXECUTION_SECONDS, DEFAULT_MAX_INSTRUCTIONS, Outcome};
use fairground_sealer::run;

/// The yield window in which OutLayer's answer must reach the contract:
/// 200 blocks at about 0.585 s.
const YIELD_WINDOW: Duration = Duration::from_secs(117);
/// What the contract asks OutLayer for (`SEALER_MAX_INSTRUCTIONS`).
const CONTRACT_MAX_INSTRUCTIONS: u64 = 50_000_000_000;
/// The most bids a sale can have (`MAX_BIDS_PER_SALE`, costs.rs).
const MAX_BIDS_PER_SALE: usize = 500;

/// Runs one input, checks it against the native `run` and the limits, and
/// prints a table row.
fn row(label: &str, valid: &str, input: &str) -> Outcome {
    let (stdout, outcome) = answer(input.as_bytes(), &on_chain(), generous());
    assert_eq!(stdout, run(input, &ctx(CONTRACT)), "{label}");
    println!(
        "| {label} | {valid} | {} | {} | {} | {:.3} | {:.1} | {:.1} |",
        input.len(),
        stdout.len(),
        outcome.instructions,
        outcome.instructions as f64 / DEFAULT_MAX_INSTRUCTIONS as f64,
        outcome.memory_bytes as f64 / (1024.0 * 1024.0),
        outcome.run_time.as_secs_f64() * 1e3,
    );
    assert!(
        runner().compile_time() + outcome.run_time
            < Duration::from_secs(DEFAULT_MAX_EXECUTION_SECONDS),
        "{label} took {:?}",
        outcome.run_time
    );
    assert!(outcome.run_time < YIELD_WINDOW);
    outcome
}

#[test]
fn instructions_and_time_by_bid_count() {
    let runner = runner();
    println!(
        "compile: {:.0} ms",
        runner.compile_time().as_secs_f64() * 1e3
    );
    println!(
        "| bids | valid | input bytes | output bytes | instructions | / 1e9 default | memory MiB | run ms |"
    );
    println!("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

    row("pubkey", "", &pubkey_request());
    let mut measured = Vec::new();
    for n in [1, 50, 160, 500, 1000, 2000] {
        let book = BidBook::generate(n);
        let outcome = row(
            &n.to_string(),
            &book.count(Kind::Valid).to_string(),
            &book.clear_request(),
        );
        measured.push((n, outcome.instructions));
    }
    // The largest input a sale can send (the canonical boxes the app seals,
    // which are the only ones the contract accepts), then the same bids in
    // 512-byte boxes, which only an earlier contract let through.
    let mut worst = 0;
    for (label, box_len) in [
        ("500, worst case", None),
        (
            "500, worst case, 512-byte boxes",
            Some(LEGACY_MAX_CIPHERTEXT_BYTES),
        ),
    ] {
        let book = BidBook::worst_case(MAX_BIDS_PER_SALE, box_len);
        let outcome = row(label, "500", &book.clear_request());
        worst = worst.max(outcome.instructions);
    }

    // The cost per bid, and how many bids fit in the default limit.
    let (n0, i0) = measured[1];
    let (n1, i1) = measured[4];
    let per_bid = (i1 - i0) as f64 / (n1 - n0) as f64;
    let base = i0 as f64 - per_bid * n0 as f64;
    println!(
        "per bid: {:.2}M instructions; fixed: {:.1}M; bids within the 1e9 default: {}",
        per_bid / 1e6,
        base / 1e6,
        ((DEFAULT_MAX_INSTRUCTIONS as f64 - base) / per_bid) as u64
    );
    // The contract's limit against the largest sale it allows.
    println!(
        "contract limit {CONTRACT_MAX_INSTRUCTIONS} / worst case {worst} = {:.1}x",
        CONTRACT_MAX_INSTRUCTIONS as f64 / worst as f64
    );
    assert!(worst * 10 < CONTRACT_MAX_INSTRUCTIONS, "{worst}");

    // Instructions depend on the plaintexts and hardly on the ciphertext bytes
    // (the crypto is constant-time; base64 and JSON scanning vary by a few
    // instructions): a second book of the same size, sealed afresh, costs the
    // same to within 0.001 %.
    let again = BidBook::generate(500).clear_request();
    let (_, outcome) = answer(again.as_bytes(), &on_chain(), generous());
    let first = measured[3].1;
    println!(
        "500 bids sealed again: {} instructions ({:+})",
        outcome.instructions,
        outcome.instructions as i64 - first as i64
    );
    assert!(
        outcome.instructions.abs_diff(first) * 100_000 < first,
        "500 bids, sealed again"
    );
}
