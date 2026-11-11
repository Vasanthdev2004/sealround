//! The job end to end: JSON requests in, JSON responses out, checked against
//! `fairground_clearing::clear` run directly on the bids we sealed (the job
//! uses the fixed-shape price search, whose results are the same).

use std::collections::HashSet;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_clearing::hash::{BidSetEntry, bid_set_hash};
use fairground_clearing::{Bid, ClearingResult, InvalidReason, SaleParams, clear};
use fairground_sealer::{BidPlaintext, Ctx, SaleKeypair, run, seal_bid};
use serde_json::{Value, json};

const MASTER: [u8; 32] = [0x42; 32];
const CONTRACT: &str = "fairground.testnet";
const SALE: &str = "fairt";
/// 10^6: the token has 6 decimals in these tests.
const ONE: u128 = 1_000_000;

fn ctx() -> Ctx {
    Ctx {
        predecessor: CONTRACT.into(),
        master: MASTER,
    }
}

fn respond(request: &str) -> Value {
    serde_json::from_str(&run(request, &ctx())).expect("the job always answers with JSON")
}

/// A bid as the contract records it.
#[derive(Clone)]
struct Record {
    bidder: String,
    deposit: u128,
    ciphertext: String,
}

fn seal(
    key: &SaleKeypair,
    sale_id: &str,
    bidder: &str,
    max_price: u128,
    max_spend: u128,
) -> String {
    seal_bid(
        &key.public_key(),
        &BidPlaintext {
            sale_id: sale_id.into(),
            bidder: bidder.into(),
            max_price,
            max_spend,
            salt: [7; 16],
        },
    )
}

/// The record and the bid `clear` should see after decryption.
fn entry(
    bidder: &str,
    deposit: u128,
    ciphertext: String,
    terms: Option<(u128, u128)>,
    mismatch: bool,
) -> (Record, Bid) {
    (
        Record {
            bidder: bidder.into(),
            deposit,
            ciphertext,
        },
        Bid {
            bidder: bidder.into(),
            deposit,
            max_price: terms.map(|(price, _)| price),
            max_spend: terms.map(|(_, spend)| spend),
            mismatch,
        },
    )
}

fn base_params() -> SaleParams {
    SaleParams {
        sale_supply: 4_000 * ONE,
        floor_price: 1_000,
        min_raise: 1_000_000,
        decimals: 6,
        max_price: None,
    }
}

/// Three valid bids (two tied at the clearing price 1500) and one of every way
/// a bid can be void.
fn bid_book() -> (Vec<Record>, Vec<Bid>) {
    let key = SaleKeypair::derive(&MASTER, CONTRACT, SALE);
    let other_sale_key = SaleKeypair::derive(&MASTER, CONTRACT, "fairt2");
    let alice = seal(&key, SALE, "alice.testnet", 2_000, 4_000_000);
    let entries = vec![
        entry(
            "alice.testnet",
            5_000_000,
            alice.clone(),
            Some((2_000, 4_000_000)),
            false,
        ),
        entry(
            "bob.testnet",
            3_000_000,
            seal(&key, SALE, "bob.testnet", 1_500, 3_000_000),
            Some((1_500, 3_000_000)),
            false,
        ),
        entry(
            "carol.testnet",
            2_000_000,
            seal(&key, SALE, "carol.testnet", 1_500, 1_500_000),
            Some((1_500, 1_500_000)),
            false,
        ),
        // Not a sealed box at all.
        entry(
            "dave.testnet",
            1_000_000,
            BASE64.encode([0xa5; 120]),
            None,
            false,
        ),
        // alice's ciphertext copied by erin: it opens, but names alice.
        entry(
            "erin.testnet",
            5_000_000,
            alice,
            Some((2_000, 4_000_000)),
            true,
        ),
        // A bid sealed to this sale's key whose plaintext names another sale.
        entry(
            "frank.testnet",
            2_000_000,
            seal(&key, "other", "frank.testnet", 3_000, 2_000_000),
            Some((3_000, 2_000_000)),
            true,
        ),
        // Sealed to another sale's key: does not open here.
        entry(
            "grace.testnet",
            2_000_000,
            seal(&other_sale_key, SALE, "grace.testnet", 3_000, 2_000_000),
            None,
            false,
        ),
        entry(
            "heidi.testnet",
            2_000_000,
            seal(&key, SALE, "heidi.testnet", 500, 2_000_000),
            Some((500, 2_000_000)),
            false,
        ),
        entry(
            "ivan.testnet",
            1_000_000,
            seal(&key, SALE, "ivan.testnet", 3_000, 2_000_000),
            Some((3_000, 2_000_000)),
            false,
        ),
        entry(
            "judy.testnet",
            1_000_000,
            seal(&key, SALE, "judy.testnet", 3_000, 0),
            Some((3_000, 0)),
            false,
        ),
    ];
    entries.into_iter().unzip()
}

fn hash_of(sale_id: &str, records: &[Record]) -> String {
    let payloads: Vec<Vec<u8>> = records
        .iter()
        .map(|record| BASE64.decode(&record.ciphertext).unwrap())
        .collect();
    bid_set_hash(
        sale_id,
        records
            .iter()
            .zip(&payloads)
            .map(|(record, payload)| BidSetEntry {
                bidder: &record.bidder,
                deposit: record.deposit,
                payload,
            }),
    )
    .unwrap()
}

fn params_json(params: &SaleParams) -> Value {
    json!({
        "sale_supply": params.sale_supply.to_string(),
        "floor_price": params.floor_price.to_string(),
        "max_price": params.max_price.map(|price| price.to_string()),
        "min_raise": params.min_raise.to_string(),
        "decimals": params.decimals,
    })
}

fn clear_request(params: &SaleParams, records: &[Record]) -> Value {
    json!({
        "v": 1,
        "op": "clear",
        "contract": CONTRACT,
        "sale_id": SALE,
        "params": params_json(params),
        "bid_set_hash": hash_of(SALE, records),
        "bids": records
            .iter()
            .map(|record| json!([record.bidder, record.deposit.to_string(), record.ciphertext]))
            .collect::<Vec<_>>(),
    })
}

/// The exact bytes the job must print for a clearing result.
fn expected_output(records: &[Record], result: &ClearingResult) -> String {
    let fills: Vec<String> = result
        .fills
        .iter()
        .map(|fill| format!(r#"["{}","{}"]"#, fill.tokens, fill.spent))
        .collect();
    let invalid: Vec<String> = result
        .fills
        .iter()
        .filter(|fill| !fill.valid)
        .map(|fill| fill.index.to_string())
        .collect();
    format!(
        r#"{{"v":1,"ok":true,"op":"clear","sale_id":"{SALE}","bid_set_hash":"{}","pubkey":"{}","clearing_price":"{}","n_valid":{},"n_invalid":{},"invalid":[{}],"fills":[{}]}}"#,
        hash_of(SALE, records),
        SaleKeypair::derive(&MASTER, CONTRACT, SALE).public_key_hex(),
        result.clearing_price,
        result.n_valid,
        result.n_invalid,
        invalid.join(","),
        fills.join(",")
    )
}

/// Asserts an `ok:false` response with this error code and returns it.
fn assert_refused(request: &str, error: &str) -> Value {
    let response = respond(request);
    assert_eq!(response["v"], 1, "{request}");
    assert_eq!(response["ok"], false, "{request} -> {response}");
    assert_eq!(response["error"], error, "{request}");
    let keys: Vec<&str> = response
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys.len(), 5, "{response}");
    response
}

#[test]
fn pubkey_is_deterministic_and_unique_per_contract_sale_and_master() {
    let ask = |contract: &str, sale_id: &str, master: [u8; 32]| {
        let request = json!({"v": 1, "op": "pubkey", "contract": contract, "sale_id": sale_id});
        let ctx = Ctx {
            predecessor: contract.into(),
            master,
        };
        run(&request.to_string(), &ctx)
    };

    let output = ask(CONTRACT, SALE, MASTER);
    let pubkey = SaleKeypair::derive(&MASTER, CONTRACT, SALE).public_key_hex();
    assert_eq!(
        output,
        format!(r#"{{"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"{pubkey}"}}"#)
    );
    assert_eq!(output, ask(CONTRACT, SALE, MASTER));

    let mut seen = HashSet::new();
    for (contract, sale_id, master) in [
        (CONTRACT, SALE, MASTER),
        (CONTRACT, "fairt2", MASTER),
        (CONTRACT, "a", MASTER),
        ("fairground.near", SALE, MASTER),
        ("other.testnet", SALE, MASTER),
        (CONTRACT, SALE, [0x43; 32]),
    ] {
        let response: Value = serde_json::from_str(&ask(contract, sale_id, master)).unwrap();
        assert_eq!(response["ok"], true);
        let pubkey = response["pubkey"].as_str().unwrap().to_owned();
        assert_eq!(pubkey.len(), 64);
        assert!(seen.insert(pubkey), "{contract} {sale_id} repeats a key");
    }
}

#[test]
fn clear_matches_the_clearing_crate_on_a_mixed_bid_book() {
    let (records, bids) = bid_book();
    let params = base_params();
    let direct = clear(&params, &bids).unwrap();

    // The book really has what it claims.
    let reasons: Vec<Option<InvalidReason>> = direct
        .fills
        .iter()
        .map(|fill| fill.invalid_reason)
        .collect();
    assert_eq!(
        reasons,
        [
            None,
            None,
            None,
            Some(InvalidReason::DecryptFailed),
            Some(InvalidReason::BidderMismatch),
            Some(InvalidReason::BidderMismatch),
            Some(InvalidReason::DecryptFailed),
            Some(InvalidReason::PriceBelowFloor),
            Some(InvalidReason::SpendAboveDeposit),
            Some(InvalidReason::ZeroSpend),
        ]
    );
    assert!(direct.oversubscribed);
    assert_eq!(direct.clearing_price, 1_500);
    // bob and carol tie at the clearing price and share what alice leaves, 2:1.
    let (bob, carol) = (&direct.fills[1], &direct.fills[2]);
    assert!(bob.tokens > 0 && bob.tokens < 2_000 * ONE);
    assert!(carol.tokens > 0 && carol.tokens < 1_000 * ONE);
    assert!(bob.tokens.abs_diff(2 * carol.tokens) <= 2);
    assert_eq!(direct.total_sold, params.sale_supply);

    let request = clear_request(&params, &records).to_string();
    let output = run(&request, &ctx());
    assert_eq!(output, expected_output(&records, &direct));
    // Same input, same bytes.
    assert_eq!(output, run(&request, &ctx()));

    let response: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(response["n_valid"], 3);
    assert_eq!(response["n_invalid"], 7);
    for void in &response["fills"].as_array().unwrap()[3..] {
        assert_eq!(void, &json!(["0", "0"]));
    }
    // Every void bid is named (it pays the penalty), and the key it was
    // checked against is the one published for the sale.
    assert_eq!(response["invalid"], json!([3, 4, 5, 6, 7, 8, 9]));
    assert_eq!(
        response["pubkey"],
        SaleKeypair::derive(&MASTER, CONTRACT, SALE).public_key_hex()
    );
}

#[test]
fn a_ceiling_clamps_prices_before_clearing() {
    let (records, bids) = bid_book();
    let params = SaleParams {
        max_price: Some(1_200),
        ..base_params()
    };
    let direct = clear(&params, &bids).unwrap();
    assert_eq!(direct.clearing_price, 1_200);
    let output = run(&clear_request(&params, &records).to_string(), &ctx());
    assert_eq!(output, expected_output(&records, &direct));
}

#[test]
fn a_failed_sale_returns_all_zero_fills() {
    let (records, bids) = bid_book();
    let params = SaleParams {
        min_raise: 1_000_000_000_000,
        ..base_params()
    };
    let direct = clear(&params, &bids).unwrap();
    assert!(direct.fail_reason.is_some());
    let output = run(&clear_request(&params, &records).to_string(), &ctx());
    assert_eq!(output, expected_output(&records, &direct));
    let response: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(response["n_valid"], 3);
    assert!(
        response["fills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|fill| fill == &json!(["0", "0"]))
    );

    // A failed sale still names its invalid bids: they pay the penalty too.
    assert_eq!(response["invalid"], json!([3, 4, 5, 6, 7, 8, 9]));

    // No valid bids at all (every bid named), and no bids at all.
    let void: Vec<Record> = records[3..].to_vec();
    let response = respond(&clear_request(&base_params(), &void).to_string());
    assert_eq!(response["ok"], true);
    assert_eq!(response["n_valid"], 0);
    assert_eq!(response["clearing_price"], "1000");
    assert_eq!(response["fills"].as_array().unwrap().len(), void.len());
    assert_eq!(response["invalid"], json!([0, 1, 2, 3, 4, 5, 6]));
    let response = respond(&clear_request(&base_params(), &[]).to_string());
    assert_eq!(response["ok"], true);
    assert_eq!(response["fills"], json!([]));
    assert_eq!(response["invalid"], json!([]));
    assert_eq!(response["bid_set_hash"], hash_of(SALE, &[]));
}

#[test]
fn requests_from_another_contract_are_refused() {
    let (records, _) = bid_book();
    let request = clear_request(&base_params(), &records).to_string();
    let elsewhere = Ctx {
        predecessor: "attacker.testnet".into(),
        master: MASTER,
    };
    assert_eq!(
        run(&request, &elsewhere),
        r#"{"v":1,"ok":false,"op":"clear","sale_id":"fairt","error":"predecessor_mismatch"}"#
    );
    let pubkey = json!({"v": 1, "op": "pubkey", "contract": CONTRACT, "sale_id": SALE});
    let response: Value = serde_json::from_str(&run(&pubkey.to_string(), &elsewhere)).unwrap();
    assert_eq!(response["error"], "predecessor_mismatch");
    assert!(response.get("pubkey").is_none());
}

#[test]
fn malformed_envelopes_are_refused_with_a_reason() {
    let (records, _) = bid_book();
    let good = clear_request(&base_params(), &records);
    let with = |path: &[&str], value: Value| {
        let mut request = good.clone();
        let (last, parents) = path.split_last().unwrap();
        let mut target = &mut request;
        for key in parents {
            target = &mut target[*key];
        }
        target[*last] = value;
        request.to_string()
    };
    let without = |key: &str| {
        let mut request = good.clone();
        request.as_object_mut().unwrap().remove(key);
        request.to_string()
    };
    let too_big = "340282366920938463463374607431768211456";

    for input in ["", " ", "{", "[]", "null", "1", "\"x\"", "{\"v\":1,}"] {
        let response = assert_refused(input, "invalid_json");
        assert!(response["op"].is_null() && response["sale_id"].is_null());
    }
    assert_refused(&"[".repeat(100_000), "invalid_json");
    assert_refused(&format!("{good} trailing"), "invalid_json");

    assert_refused(&with(&["v"], json!(2)), "unsupported_version");
    assert_refused(&with(&["v"], json!("1")), "unsupported_version");
    assert_refused(&with(&["v"], json!(1.5)), "unsupported_version");
    // `"v":1` occurs once, wherever the key lands: keys print sorted unless a
    // workspace build turns on serde_json's `preserve_order` (near-sdk does).
    let huge_version = good
        .to_string()
        .replace(r#""v":1"#, r#""v":18446744073709551617"#);
    assert_ne!(huge_version, good.to_string());
    assert_refused(&huge_version, "unsupported_version");
    assert_refused(&without("v"), "unsupported_version");

    let response = assert_refused(&with(&["op"], json!("drain")), "unknown_op");
    assert_eq!(response["op"], "drain");
    assert_eq!(response["sale_id"], SALE);
    assert_refused(&with(&["op"], json!(null)), "unknown_op");
    assert_refused(&with(&["extra"], json!(1)), "unexpected_field");
    assert_refused(
        &json!({"v": 1, "op": "pubkey", "contract": CONTRACT, "sale_id": SALE, "bids": []})
            .to_string(),
        "unexpected_field",
    );

    assert_refused(
        &with(&["contract"], json!("Fairground.testnet")),
        "invalid_contract",
    );
    assert_refused(&with(&["contract"], json!(7)), "invalid_contract");
    assert_refused(&without("contract"), "invalid_contract");
    assert_refused(
        &with(&["contract"], json!("other.testnet")),
        "predecessor_mismatch",
    );

    for sale_id in [
        json!(""),
        json!("Fairt"),
        json!("fair t"),
        json!("fairt\u{0}"),
        json!(1),
    ] {
        assert_refused(&with(&["sale_id"], sale_id), "invalid_sale_id");
    }

    for (key, value) in [
        ("sale_supply", json!(too_big)),
        ("sale_supply", json!(4_000_000_000u64)),
        ("floor_price", json!("-1")),
        ("floor_price", json!("1e3")),
        ("min_raise", json!("")),
        ("max_price", json!(1200)),
        ("decimals", json!(256)),
        ("decimals", json!(-1)),
        ("decimals", json!("6")),
        ("extra", json!("1")),
    ] {
        assert_refused(&with(&["params", key], value), "invalid_params");
    }
    let mut missing = good.clone();
    missing["params"]
        .as_object_mut()
        .unwrap()
        .remove("max_price");
    assert_refused(&missing.to_string(), "invalid_params");
    assert_refused(&with(&["params"], json!(null)), "invalid_params");
    assert_refused(
        &with(&["params", "decimals"], json!(25)),
        "decimals_out_of_range",
    );
    assert_refused(
        &with(&["params", "floor_price"], json!("0")),
        "floor_price_not_positive",
    );
    assert_refused(
        &with(&["params", "sale_supply"], json!("0")),
        "sale_supply_not_positive",
    );
    assert_refused(
        &with(&["params", "max_price"], json!("999")),
        "ceiling_below_floor",
    );

    assert_refused(
        &with(&["bid_set_hash"], json!("abc")),
        "invalid_bid_set_hash",
    );
    assert_refused(
        &with(&["bid_set_hash"], json!("zz".repeat(32))),
        "invalid_bid_set_hash",
    );
    assert_refused(
        &with(&["bid_set_hash"], json!(null)),
        "invalid_bid_set_hash",
    );
    assert_refused(
        &with(&["bid_set_hash"], json!("00".repeat(32))),
        "bid_set_hash_mismatch",
    );

    assert_refused(&with(&["bids"], json!({})), "invalid_bids");
    assert_refused(
        &with(&["bids"], json!([["alice.testnet", "1"]])),
        "invalid_bids",
    );
    assert_refused(
        &with(&["bids"], json!([["alice.testnet", "1", "AAAA", "x"]])),
        "invalid_bids",
    );
    assert_refused(
        &with(&["bids"], json!([["alice.testnet", 1, "AAAA"]])),
        "invalid_bids",
    );
    assert_refused(
        &with(&["bids"], json!([["alice.testnet", too_big, "AAAA"]])),
        "invalid_bids",
    );
    assert_refused(
        &with(&["bids"], json!([["alice.testnet", "-1", "AAAA"]])),
        "invalid_bids",
    );
    assert_refused(
        &with(&["bids"], json!([["a".repeat(256), "1", "AAAA"]])),
        "invalid_bids",
    );
    for ciphertext in ["AAA", "AAAA=", "A===", "AA==AA==", "AB==", "@@@@", "AA AA"] {
        assert_refused(
            &with(&["bids"], json!([["alice.testnet", "1", ciphertext]])),
            "invalid_ciphertext",
        );
    }
}

/// Like the enclave job's wrapper: a request in which any object repeats a
/// key is refused as a whole, before anything else is checked, and echoes no
/// `op` or `sale_id` (it has no single one).
#[test]
fn repeated_keys_are_refused_at_any_depth() {
    let (records, _) = bid_book();
    let good = clear_request(&base_params(), &records).to_string();
    assert_eq!(respond(&good)["ok"], true);
    let repeat = |from: &str, to: &str| {
        assert_eq!(good.matches(from).count(), 1, "{from}");
        good.replacen(from, to, 1)
    };
    for request in [
        repeat(r#""v":1"#, r#""v":1,"v":1"#),
        repeat(r#""op":"clear""#, r#""op":"clear","op":"pubkey""#),
        repeat(
            r#""sale_id":"fairt""#,
            r#""sale_id":"fairt","sale_id":"fairt""#,
        ),
        // The same key spelt with a JSON escape.
        repeat(r#""op":"clear""#, r#""op":"clear","\u006fp":"clear""#),
        repeat(
            r#""floor_price":"1000""#,
            r#""floor_price":"1000","floor_price":"1000""#,
        ),
        // Deeper than the request ever has objects; the bid then is not
        // well-formed either, but the repeat is what the job reports.
        repeat(r#""bids":["#, r#""bids":[{"a":{"k":1,"k":2}},"#),
        format!(
            r#"{{"v":1,"op":"pubkey","contract":"{CONTRACT}","sale_id":"fairt","sale_id":"other"}}"#
        ),
    ] {
        let response = assert_refused(&request, "duplicate_key");
        assert!(response["op"].is_null() && response["sale_id"].is_null());
    }
    // Malformed JSON is reported as such even if it also repeats a key.
    assert_refused(r#"{"v":1,"v":1"#, "invalid_json");
    assert_refused(r#"[{"v":1,"v":1}]"#, "invalid_json");
    // Keys that differ in case, or the same key in sibling objects, are not repeats.
    assert_refused(&repeat(r#""v":1"#, r#""v":1,"V":1"#), "unexpected_field");
    let siblings = repeat(r#""bids":["#, r#""bids":[{"k":1},{"k":2},"#);
    assert_refused(&siblings, "invalid_bids");
}

#[test]
fn any_change_to_the_frozen_bid_set_is_refused() {
    let (records, _) = bid_book();
    let request = clear_request(&base_params(), &records);
    let mut changed_deposit = request.clone();
    changed_deposit["bids"][0][1] = json!("5000001");
    let mut swapped = request.clone();
    let bids = swapped["bids"].as_array_mut().unwrap();
    bids.swap(0, 1);
    let mut dropped = request.clone();
    dropped["bids"].as_array_mut().unwrap().pop();
    let mut other_sale = request.clone();
    other_sale["sale_id"] = json!("fairt2");
    for changed in [changed_deposit, swapped, dropped, other_sale] {
        assert_refused(&changed.to_string(), "bid_set_hash_mismatch");
    }
    // Upper-case hex for the expected hash is fine; the echo is lower-case.
    let mut upper = request.clone();
    upper["bid_set_hash"] = json!(request["bid_set_hash"].as_str().unwrap().to_uppercase());
    let response = respond(&upper.to_string());
    assert_eq!(response["ok"], true);
    assert_eq!(response["bid_set_hash"], request["bid_set_hash"]);
}

/// SplitMix64, a tiny seeded generator, so the mangling below is reproducible.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n).unwrap()).unwrap()
    }
}

#[test]
fn mangled_requests_never_panic_and_always_answer_json() {
    let (records, _) = bid_book();
    let valid = clear_request(&base_params(), &records[..4]).to_string();
    for end in (0..valid.len()).filter(|&end| valid.is_char_boundary(end)) {
        let response = respond(&valid[..end]);
        assert_eq!(response["ok"], false);
    }
    let alphabet = b"{}[]\":,0123456789abcdefvn-+eE. \\/=AZ";
    let mut rng = SplitMix64(0x5eed);
    let mut answered_ok = 0;
    for _ in 0..3_000 {
        let mut bytes = valid.clone().into_bytes();
        for _ in 0..=rng.below(3) {
            let at = rng.below(bytes.len());
            bytes[at] = alphabet[rng.below(alphabet.len())];
        }
        let input = String::from_utf8(bytes).expect("ASCII stays UTF-8");
        let response = respond(&input);
        assert_eq!(response["v"], 1);
        assert!(response["ok"].is_boolean(), "{input} -> {response}");
        if response["ok"] == true {
            answered_ok += 1;
        }
    }
    // Some mutations (inside amounts) still describe a valid sale.
    assert!(answered_ok > 0);
}
