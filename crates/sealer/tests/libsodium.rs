//! Compatibility with libsodium-wrappers, the library the app seals bids with.
//! `fixtures/libsodium.json` comes from `fixtures/gen.mjs`.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_clearing::hash::{BidSetEntry, bid_set_hash, parse_hex};
use fairground_sealer::{BidPlaintext, Ctx, SaleKeypair, open_bid, open_bid_bytes, run};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/libsodium.json")).expect("fixture is JSON")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

fn master(fixture: &Value) -> [u8; 32] {
    parse_hex(text(fixture, "master")).expect("master is 64 hex digits")
}

fn keypairs(fixture: &Value) -> Vec<SaleKeypair> {
    let master = master(fixture);
    fixture["keys"]
        .as_array()
        .expect("keys")
        .iter()
        .map(|key| SaleKeypair::derive(&master, text(key, "contract"), text(key, "sale_id")))
        .collect()
}

fn expected_bid(expect: &Value) -> Option<BidPlaintext> {
    if expect.is_null() {
        return None;
    }
    Some(BidPlaintext {
        sale_id: text(expect, "sale_id").into(),
        bidder: text(expect, "bidder").into(),
        max_price: text(expect, "max_price").parse().unwrap(),
        max_spend: text(expect, "max_spend").parse().unwrap(),
        salt: parse_hex(text(expect, "salt")).unwrap(),
    })
}

#[test]
fn derived_public_keys_match_node_hkdf_and_libsodium_x25519() {
    let fixture = fixture();
    let keys = fixture["keys"].as_array().unwrap();
    assert!(keys.len() >= 4);
    for (key, keypair) in keys.iter().zip(keypairs(&fixture)) {
        assert_eq!(
            keypair.public_key_hex(),
            text(key, "public_key"),
            "{} / {}",
            text(key, "contract"),
            text(key, "sale_id")
        );
    }
}

#[test]
fn every_libsodium_box_opens_to_the_expected_bid() {
    let fixture = fixture();
    let keypairs = keypairs(&fixture);
    let boxes = fixture["boxes"].as_array().unwrap();
    assert!(boxes.len() >= 15);
    let mut opened = 0;
    for case in boxes {
        let name = text(case, "name");
        let key = usize::try_from(case["key"].as_u64().unwrap()).unwrap();
        let ciphertext = text(case, "ciphertext");
        let expect = expected_bid(&case["expect"]);

        let got = open_bid(ciphertext, &keypairs[key]);
        assert_eq!(got, expect, "{name}");
        if let Some(bid) = &got {
            opened += 1;
            if case["canonical"].as_bool().unwrap() {
                assert_eq!(bid.to_canonical_json(), text(case, "plaintext"), "{name}");
            }
        }
        // No other sale's key opens it.
        for (other, keypair) in keypairs.iter().enumerate() {
            if other != key {
                assert_eq!(
                    open_bid(ciphertext, keypair),
                    None,
                    "{name} under key {other}"
                );
            }
        }
    }
    assert!(opened >= 8, "only {opened} boxes opened");
}

#[test]
fn tampered_libsodium_boxes_do_not_open() {
    let fixture = fixture();
    let keypair = &keypairs(&fixture)[0];
    let basic = fixture["boxes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "basic")
        .unwrap();
    let sealed = BASE64.decode(text(basic, "ciphertext")).unwrap();
    assert!(open_bid_bytes(&sealed, keypair).is_some());
    for position in 0..sealed.len() {
        let mut tampered = sealed.clone();
        tampered[position] ^= 0x01;
        assert_eq!(
            open_bid_bytes(&tampered, keypair),
            None,
            "bit flip at {position}"
        );
    }
    for length in 0..sealed.len() {
        assert_eq!(
            open_bid_bytes(&sealed[..length], keypair),
            None,
            "truncated to {length}"
        );
    }
    let mut extended = sealed.clone();
    extended.push(0);
    assert_eq!(open_bid_bytes(&extended, keypair), None);
}

#[test]
fn the_job_clears_libsodium_sealed_bids() {
    let fixture = fixture();
    let key = &fixture["keys"][0];
    let (contract, sale_id) = (text(key, "contract"), text(key, "sale_id"));
    let find = |name: &str| {
        let case = fixture["boxes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap();
        text(case, "ciphertext").to_owned()
    };
    // alice's own bid, the same box copied by bob, and a box that opens but is malformed.
    let bids = [
        ("alice.testnet", 6_000_000u128, find("basic")),
        ("bob.testnet", 6_000_000, find("basic")),
        ("carol.testnet", 6_000_000, find("number_price")),
    ];
    let payloads: Vec<Vec<u8>> = bids.iter().map(|b| BASE64.decode(&b.2).unwrap()).collect();
    let hash = bid_set_hash(
        sale_id,
        bids.iter()
            .zip(&payloads)
            .map(|(bid, payload)| BidSetEntry {
                bidder: bid.0,
                deposit: bid.1,
                payload,
            }),
    )
    .unwrap();
    let request = json!({
        "v": 1, "op": "clear", "contract": contract, "sale_id": sale_id,
        "params": {"sale_supply": "100000000000", "floor_price": "1000", "max_price": null,
                   "min_raise": "0", "decimals": 6},
        "bid_set_hash": hash,
        "bids": bids.iter().map(|b| json!([b.0, b.1.to_string(), b.2])).collect::<Vec<_>>(),
    });
    let ctx = Ctx {
        predecessor: contract.into(),
        master: master(&fixture),
    };
    let response: Value = serde_json::from_str(&run(&request.to_string(), &ctx)).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["bid_set_hash"], hash);
    assert_eq!(response["n_valid"], 1);
    assert_eq!(response["n_invalid"], 2);
    // Undersubscribed: alice spends her 5 USDC at the floor, 0.001 USDC per token.
    assert_eq!(response["clearing_price"], "1000");
    assert_eq!(
        response["fills"],
        json!([["5000000000", "5000000"], ["0", "0"], ["0", "0"]])
    );
}
