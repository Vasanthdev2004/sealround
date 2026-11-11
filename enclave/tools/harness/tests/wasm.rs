//! The release job module under the OutLayer-like runner: it answers exactly
//! like the native `fairground_sealer::run`, it refuses bad runs by failing
//! them with a fixed code on stderr, it never prints the secret, and its
//! instruction count, which OutLayer publishes, depends neither on the
//! master's digits nor on how high the top bids' max prices are. See
//! `common/mod.rs` for how to build the module first.

mod common;

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use common::{answer, assert_no_secret, generous, on_chain, refused, set};
use fairground_clearing::sealed_bid_len;
use fairground_harness::{
    BidBook, CONTRACT, Entry, Kind, LEGACY_MAX_CIPHERTEXT_BYTES, MASTER_VAR, SALE_ID, TEST_MASTER,
    ctx, master_hex, params, pubkey_request, sale_pubkey_hex, seal_bytes, unpadded_plaintext,
};
use fairground_runner::{DEFAULT_MAX_INSTRUCTIONS, near_env};
use fairground_sealer::{BidPlaintext, SaleKeypair, run, seal_bid};
use serde_json::{Value, json};

#[test]
fn answers_match_native_run_byte_for_byte() {
    let mut inputs: Vec<(String, String)> = vec![("pubkey".into(), pubkey_request())];
    for n in [1, 50, 500] {
        inputs.push((
            format!("clear, {n} bids"),
            BidBook::generate(n).clear_request(),
        ));
    }
    for box_len in [None, Some(LEGACY_MAX_CIPHERTEXT_BYTES)] {
        inputs.push((
            format!("worst case, 50 bids, boxes {box_len:?}"),
            BidBook::worst_case(50, box_len).clear_request(),
        ));
    }
    // Answers `run` gives for requests it refuses or for sales that fail.
    let book = BidBook::generate(20);
    inputs.push((
        "bid set hash mismatch".into(),
        book.clear_request_with_hash(&"00".repeat(32)),
    ));
    let mut below_min_raise = BidBook::generate(20);
    below_min_raise.params.min_raise = u128::MAX;
    inputs.push(("below min raise".into(), below_min_raise.clear_request()));
    let mut ceiling = BidBook::generate(50);
    ceiling.params.max_price = Some(1_500);
    inputs.push(("max price ceiling".into(), ceiling.clear_request()));
    inputs.push((
        "another contract's sale".into(),
        r#"{"v":1,"op":"pubkey","contract":"evil.testnet","sale_id":"fairt"}"#.into(),
    ));
    inputs.push((
        "unknown op".into(),
        r#"{"v":1,"op":"tally","contract":"fairground.testnet","sale_id":"fairt"}"#.into(),
    ));

    for (name, input) in &inputs {
        let (stdout, _) = answer(input.as_bytes(), &on_chain(), generous());
        assert_eq!(stdout, run(input, &ctx(CONTRACT)), "{name}");
    }

    // A clear names the key it decrypted with and lists the invalid bids,
    // between `n_invalid` and `fills`, as the contract requires.
    let book = BidBook::generate(500);
    let (stdout, _) = answer(book.clear_request().as_bytes(), &on_chain(), generous());
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["pubkey"], sale_pubkey_hex(SALE_ID), "{stdout:.300}");
    assert_eq!(value["invalid"], json!(book.invalid_indices()));
    assert_eq!(value["n_invalid"], book.invalid_indices().len());
    let prefix = format!(
        r#"{{"v":1,"ok":true,"op":"clear","sale_id":"{SALE_ID}","bid_set_hash":"{}","pubkey":"{}","clearing_price":""#,
        book.bid_set_hash(),
        sale_pubkey_hex(SALE_ID)
    );
    assert!(stdout.starts_with(&prefix), "{stdout:.300}");
    let invalid = format!(
        r#","n_invalid":{},"invalid":{},"fills":[["#,
        book.invalid_indices().len(),
        json!(book.invalid_indices())
    );
    assert!(stdout.contains(&invalid), "{stdout:.300}");

    // A failed sale is still an `"ok":true` answer, with all-zero fills.
    let (stdout, _) = answer(
        below_min_raise.clear_request().as_bytes(),
        &on_chain(),
        generous(),
    );
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert!(
        value["fills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|fill| fill == &serde_json::json!(["0", "0"]))
    );
}

#[test]
fn refusals_fail_the_run_with_the_code_on_stderr() {
    let pubkey = pubkey_request().into_bytes();
    let hex = master_hex();

    let mut https = on_chain();
    set(&mut https, "OUTLAYER_EXECUTION_TYPE", Some("HTTPS"));
    set(&mut https, "NEAR_PREDECESSOR_ID", Some(""));
    let mut no_type = on_chain();
    set(&mut no_type, "OUTLAYER_EXECUTION_TYPE", None);
    let mut no_predecessor = on_chain();
    set(&mut no_predecessor, "NEAR_PREDECESSOR_ID", None);
    let mut no_sender = on_chain();
    set(&mut no_sender, "NEAR_SENDER_ID", None);
    let mut contract_signed = on_chain();
    set(&mut contract_signed, "NEAR_SENDER_ID", Some(CONTRACT));
    let env_with_master = |value: &str| near_env(CONTRACT, &[(MASTER_VAR, value)]);
    let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));

    // (what, input, environment, the refusal code expected)
    type Case<'a> = (&'a str, Vec<u8>, Vec<(String, String)>, &'a str);
    let cases: Vec<Case> = vec![
        ("an HTTPS run", pubkey.clone(), https, "not_near_execution"),
        ("no execution type", pubkey.clone(), no_type, "not_near_execution"),
        ("an empty environment", pubkey.clone(), vec![], "not_near_execution"),
        ("no predecessor", pubkey.clone(), no_predecessor, "missing_predecessor"),
        ("no sender", pubkey.clone(), no_sender, "missing_sender"),
        (
            "input over 4 MiB",
            vec![b' '; 4 * 1024 * 1024 + 1],
            on_chain(),
            "input_too_large",
        ),
        (
            "input that is not UTF-8",
            (0..=255u8).cycle().take(3000).collect(),
            on_chain(),
            "invalid_json",
        ),
        ("empty input", vec![], on_chain(), "invalid_json"),
        ("not JSON", b"not json".to_vec(), on_chain(), "invalid_json"),
        ("null", b"null".to_vec(), on_chain(), "invalid_json"),
        ("an array", b"[1,2]".to_vec(), on_chain(), "invalid_json"),
        ("nesting past 128", deep.into_bytes(), on_chain(), "invalid_json"),
        (
            "a number too large for f64",
            format!(r#"{{"v":{}}}"#, "9".repeat(10_000)).into_bytes(),
            on_chain(),
            "invalid_json",
        ),
        (
            "a repeated contract (serde_json would read the second)",
            br#"{"v":1,"op":"pubkey","contract":"evil.testnet","contract":"fairground.testnet","sale_id":"fairt"}"#.to_vec(),
            on_chain(),
            "duplicate_key",
        ),
        (
            "a clear signed by the contract account itself",
            BidBook::generate(5).clear_request().into_bytes(),
            contract_signed.clone(),
            "signer_is_contract",
        ),
        ("no secret row", pubkey.clone(), near_env(CONTRACT, &[]), "missing_master"),
        (
            "a master that is not hex",
            pubkey.clone(),
            env_with_master(&"zz".repeat(32)),
            "invalid_master",
        ),
        (
            "a short master",
            pubkey.clone(),
            env_with_master(&hex[..62]),
            "invalid_master",
        ),
        (
            "a 0x master",
            pubkey.clone(),
            env_with_master(&format!("0x{hex}")),
            "invalid_master",
        ),
        (
            "a 64-byte master",
            pubkey.clone(),
            env_with_master(&format!("{hex}{hex}")),
            "invalid_master",
        ),
    ];
    for (name, input, env, code) in cases {
        println!("{name}");
        let outcome = refused(&input, &env, code);
        assert_no_secret(name, &outcome.stderr);
    }

    // `run` refuses repeated keys too, with an answer whose `op` and
    // `sale_id` are null. The job refuses them first, by failing the run
    // with the same code, like every other refusal of its own.
    for repeated in [
        r#"{"v":1,"op":"pubkey","contract":"evil.testnet","contract":"fairground.testnet","sale_id":"fairt"}"#,
        r#"{"v":1,"op":"clear","op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}"#,
    ] {
        assert_eq!(
            run(repeated, &ctx(CONTRACT)),
            r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"duplicate_key"}"#
        );
        refused(repeated.as_bytes(), &on_chain(), "duplicate_key");
    }

    // The contract account may still ask for a public key: it reveals nothing.
    let (stdout, _) = answer(&pubkey, &contract_signed, generous());
    assert_eq!(stdout, run(&pubkey_request(), &ctx(CONTRACT)));

    // Objects reach `run`, which refuses bad ones in its own words.
    for request in ["{}", "{\"v\":1}", "{\"v\":2,\"op\":\"pubkey\"}"] {
        let (stdout, _) = answer(request.as_bytes(), &on_chain(), generous());
        assert_eq!(stdout, run(request, &ctx(CONTRACT)), "{request}");
        let value: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(value["ok"], false, "{stdout}");
    }

    // A request from another contract: `run` refuses it, naming the request.
    let mut evil = on_chain();
    set(&mut evil, "NEAR_PREDECESSOR_ID", Some("evil.testnet"));
    let (stdout, _) = answer(&pubkey, &evil, generous());
    assert_eq!(
        stdout,
        r#"{"v":1,"ok":false,"op":"pubkey","sale_id":"fairt","error":"predecessor_mismatch"}"#
    );
}

/// OutLayer publishes every run's instruction count. Reading the master must
/// cost the same whatever its digits are, or the count tells how many of
/// them are letters.
#[test]
fn reading_the_master_costs_the_same_for_every_master() {
    let pubkey = pubkey_request().into_bytes();
    let mut counts: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    for master in [
        "00".repeat(32),
        "99".repeat(32),
        "ff".repeat(32),
        "FF".repeat(32),
        "0123456789abcdef".repeat(4),
        "fedcba9876543210".repeat(4),
        "a5".repeat(32),
        "5A".repeat(32),
        "aBcDeF".repeat(10) + "0a0A",
        master_hex(),
    ] {
        let env = near_env(CONTRACT, &[(MASTER_VAR, &master)]);
        let (_, outcome) = answer(&pubkey, &env, generous());
        counts.entry(outcome.instructions).or_default().push(master);
    }
    println!("pubkey instructions by master: {counts:?}");
    assert_eq!(counts.len(), 1, "{counts:#?}");
}

/// The most two clears of books that differ only in their top bids' max
/// prices may differ in instructions. What still varies is the sealing (fresh
/// random boxes: base64 and JSON scanning, a few dozen instructions at
/// 500 bids) and parsing the padded amounts' digits.
const TOP_PRICE_TOLERANCE: u64 = 20_000;

/// OutLayer publishes every run's instruction count. The fast price search
/// took about one step per bit of the highest valid max price, so the count
/// told the top bid's order of magnitude, which the uniform price hides. The
/// job uses `PriceSearch::FixedShape`: 128 halvings over [floor, u128::MAX],
/// each visiting every valid bid. Two 500-bid books that differ only in their
/// 25 top bids' max prices, 1e4 against 1e30 (above the clearing price either
/// way, so the answers are equal), must cost nearly the same.
///
/// This also checks on wasm that the compiler kept the masked-out work: if it
/// skipped the demand of the bids priced below a probe, the 1e4 book would
/// skip the 25 top bids' u128 divisions at the hundred-odd probes above 1e4
/// and cost hundreds of thousands of instructions less.
#[test]
fn the_top_max_price_does_not_change_the_instruction_count() {
    let clear = |top_price: u128| -> (Value, u64) {
        let book = BidBook::generate_with(500, top_price, 25);
        let input = book.clear_request();
        let (stdout, outcome) = answer(input.as_bytes(), &on_chain(), generous());
        assert_eq!(stdout, run(&input, &ctx(CONTRACT)));
        let mut value: Value = serde_json::from_str(&stdout).unwrap();
        value.as_object_mut().unwrap().remove("bid_set_hash");
        (value, outcome.instructions)
    };
    let (low, low_count) = clear(10u128.pow(4));
    let (high, high_count) = clear(10u128.pow(30));
    assert_eq!(low["ok"], true, "{low}");
    // Same n_valid, invalid list, clearing price and fills.
    assert_eq!(low, high);
    let price: u128 = low["clearing_price"].as_str().unwrap().parse().unwrap();
    assert!(price < 10u128.pow(4), "{price}");
    let diff = low_count.abs_diff(high_count);
    println!(
        "25 top bids at 1e4: {low_count} instructions; at 1e30: {high_count} ({:+})",
        i128::from(high_count) - i128::from(low_count)
    );
    assert!(diff <= TOP_PRICE_TOLERANCE, "{low_count} vs {high_count}");
}

/// The app used to seal amounts as plain decimal strings, so a ciphertext's
/// length gave away their digit count. `seal_bid` now pads them to 39 digits:
/// every bid of a bidder has one length, and the job clears it exactly as the
/// same bid sealed the old way, which it still reads.
#[test]
fn padded_bids_clear_like_unpadded_ones() {
    let key = SaleKeypair::derive(&TEST_MASTER, CONTRACT, SALE_ID).public_key();
    let amounts: [(u128, u128); 5] = [
        (1_600, 5_000_000),
        (9_999, 500),
        (160_000, 50_000_000),
        (1_000, 1_000_000_000),
        (10u128.pow(30), 7_654_321),
    ];
    let book = |seal: &dyn Fn(&BidPlaintext) -> String| -> BidBook {
        let bids = amounts
            .iter()
            .enumerate()
            .map(|(i, &(max_price, max_spend))| {
                let bidder = format!("bidder-{i}.testnet");
                let plaintext = BidPlaintext {
                    sale_id: SALE_ID.into(),
                    bidder: bidder.clone(),
                    max_price,
                    max_spend,
                    salt: [u8::try_from(i).unwrap(); 16],
                };
                Entry {
                    bidder,
                    deposit: 1_000_000_000,
                    ciphertext: seal(&plaintext),
                    kind: Kind::Valid,
                }
            })
            .collect();
        BidBook {
            sale_id: SALE_ID.into(),
            params: params(1),
            bids,
        }
    };
    let unpadded = book(&|bid| seal_bytes(&key, unpadded_plaintext(bid).as_bytes()));
    let padded = book(&|bid| seal_bid(&key, bid));

    let lengths = |book: &BidBook| -> Vec<usize> {
        book.bids
            .iter()
            .map(|bid| BASE64.decode(&bid.ciphertext).unwrap().len())
            .collect()
    };
    // Unpadded, the lengths differ with the amounts; padded, one length,
    // 48 (box) + 176 + sale id + bidder.
    assert!(lengths(&unpadded).windows(2).any(|pair| pair[0] != pair[1]));
    assert!(
        lengths(&padded)
            .iter()
            .all(|&len| len == sealed_bid_len(SALE_ID.len(), "bidder-0.testnet".len()))
    );
    assert_eq!(sealed_bid_len(SALE_ID.len(), "bidder-0.testnet".len()), 245);

    let answer_without_hash = |book: &BidBook| -> Value {
        let input = book.clear_request();
        let (stdout, _) = answer(input.as_bytes(), &on_chain(), generous());
        assert_eq!(stdout, run(&input, &ctx(CONTRACT)));
        let mut value: Value = serde_json::from_str(&stdout).unwrap();
        value.as_object_mut().unwrap().remove("bid_set_hash");
        value
    };
    let expected = answer_without_hash(&unpadded);
    assert_eq!(expected["ok"], true, "{expected}");
    assert_eq!(expected["n_valid"], amounts.len(), "{expected}");
    assert_eq!(answer_without_hash(&padded), expected);
}

/// The runner's command-line tool, built with `cargo build --profile tools -p
/// fairground-runner` (`FAIRGROUND_RUNNER` points at another build).
///
/// A run that ends in a fuel or time trap goes through it rather than through
/// [`common::runner`]: on Windows, wasmtime 28 raises such a trap with a
/// longjmp that aborts any process built with `panic = "unwind"`, which every
/// test binary is. The tool is built with `panic = "abort"` and reports the trap.
fn runner_cli() -> PathBuf {
    std::env::var_os("FAIRGROUND_RUNNER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../target/tools/fairground-runner{}",
                std::env::consts::EXE_SUFFIX
            ))
        })
}

#[test]
fn a_clear_over_its_instruction_limit_fails_the_run() {
    let cli = runner_cli();
    assert!(
        cli.exists(),
        "{} is missing. Build it first: cargo build --profile tools -p fairground-runner",
        cli.display()
    );
    // OutLayer's default limit: a 500-bid clear needs about three times more.
    let input = BidBook::generate(500).clear_request();
    let mut child = Command::new(&cli)
        .arg("--wasm")
        .arg(common::wasm_path())
        .args(["--near", CONTRACT, "--env"])
        .arg(format!("{MASTER_VAR}={}", master_hex()))
        .args(["--max-instructions", &DEFAULT_MAX_INSTRUCTIONS.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let report = String::from_utf8_lossy(&output.stderr);

    assert_eq!(output.status.code(), Some(1), "{report}");
    assert!(report.contains("result: failed: out of fuel\n"), "{report}");
    assert!(report.contains(&format!("instructions: {DEFAULT_MAX_INSTRUCTIONS}\n")));
    // The job printed nothing before the trap; the worker would publish its
    // (empty) stderr as the run's error.
    assert!(output.stdout.is_empty());
    assert!(report.contains("stderr_bytes: 0\n"), "{report}");
    assert_no_secret("report", &output.stderr);
}
