//! `ft_on_transfer`: accepted bids, every rejection, the window edges and the
//! bid-set hash.

use fairground_clearing::hash::{BidSetEntry, bid_set_hash, commitment};

use super::*;
use crate::costs::MAX_CIPHERTEXT_BYTES;

/// Delivers a deposit that must be rejected for `reason`, and checks that it
/// is returned in full and changes nothing.
fn assert_rejected(
    contract: &mut Fairground,
    token: &AccountId,
    now: u64,
    sender: &AccountId,
    amount: u128,
    msg: &str,
    reason: &str,
) {
    set_call(token, now, 0);
    let before = snapshot(contract, "fairt");
    assert_eq!(
        deliver(contract, token, now, sender, amount, msg),
        amount,
        "{reason}"
    );
    let rejected = event("bid_rejected");
    assert_eq!(rejected["reason"], json!(reason));
    assert_eq!(rejected["amount"], json!(amount.to_string()));
    assert_eq!(rejected["sender_id"], json!(sender));
    assert_eq!(
        snapshot(contract, "fairt"),
        before,
        "{reason} changed state"
    );
}

#[test]
fn accepts_a_bid() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    let payload = bid_ciphertext(1, "fairt", &bidder(1));
    let msg = tee_msg("fairt", &payload);
    assert_eq!(
        deliver(
            &mut contract,
            &usdc(),
            BID_START,
            &bidder(1),
            25 * USDC,
            &msg
        ),
        0
    );

    let summary = contract.get_bids_summary("fairt".into()).unwrap();
    assert_eq!(summary.count, 1);
    assert_eq!(summary.total_deposits, U128(25 * USDC));
    assert_eq!(
        event("bid_placed"),
        json!({"sale_id": "fairt", "bidder": "bidder1.testnet", "index": 0,
               "deposit": (25 * USDC).to_string(), "bid_set_hash": summary.bid_set_hash})
    );
    let bid = contract.get_bid("fairt".into(), bidder(1)).unwrap();
    assert_eq!(bid.index, 0);
    assert_eq!(bid.deposit, U128(25 * USDC));
    assert_eq!(bid.placed_at, U64(BID_START));
    assert!(!bid.claimed && !bid.revealed);
    use near_sdk::base64::Engine as _;
    assert_eq!(
        bid.payload,
        near_sdk::base64::engine::general_purpose::STANDARD.encode(&payload)
    );
    assert_eq!(contract.get_bids("fairt".into(), None, None), vec![bid]);
    assert!(contract.get_bid("fairt".into(), bidder(2)).is_none());
}

#[test]
fn rejects_every_invalid_deposit() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    let mut p = params("other", RevealMode::Tee);
    p.quote_token = account("usdc2.testnet");
    create(&mut contract, p);
    finish_setup(&mut contract, "other", RevealMode::Tee);

    let amount = 5 * USDC;
    let who = bidder(1);
    let good = tee_msg("fairt", &bid_ciphertext(1, "fairt", &who));
    let exact = sealed_len("fairt", &who);
    let cases: Vec<(AccountId, u64, u128, String, &str)> = vec![
        (usdc(), BID_START, amount, "not json".into(), "bad_msg"),
        (
            usdc(),
            BID_START,
            amount,
            r#"{"sale_id":"fairt","ciphertext":"AA==","extra":1}"#.into(),
            "bad_msg",
        ),
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("nope", &ciphertext(1, 200)),
            "unknown_sale",
        ),
        // An allowed quote token, but not this sale's.
        (
            account("usdc2.testnet"),
            BID_START,
            amount,
            good.clone(),
            "wrong_token",
        ),
        (
            account("evil.testnet"),
            BID_START,
            amount,
            good.clone(),
            "wrong_token",
        ),
        (usdc(), BID_START - 1, amount, good.clone(), "not_open"),
        (usdc(), BID_END, amount, good.clone(), "not_open"),
        (
            usdc(),
            BID_START,
            amount,
            commit_msg("fairt", &[7; 32]),
            "wrong_payload",
        ),
        (
            usdc(),
            BID_START,
            amount,
            r#"{"sale_id":"fairt"}"#.into(),
            "wrong_payload",
        ),
        (
            usdc(),
            BID_START,
            amount,
            json!({"sale_id":"fairt","ciphertext":"AAAA","commitment":"00".repeat(32)}).to_string(),
            "wrong_payload",
        ),
        (
            usdc(),
            BID_START,
            amount,
            r#"{"sale_id":"fairt","ciphertext":"***"}"#.into(),
            "bad_base64",
        ),
        (
            usdc(),
            BID_START,
            amount,
            r#"{"sale_id":"fairt","ciphertext":"AAA"}"#.into(),
            "bad_base64",
        ),
        (
            usdc(),
            BID_START,
            amount,
            r#"{"sale_id":"fairt","ciphertext":""}"#.into(),
            "bad_base64",
        ),
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("fairt", &ciphertext(1, MAX_CIPHERTEXT_BYTES + 1)),
            "ciphertext_too_long",
        ),
        // Only a sealed bid's exact length for this sale id and bidder: one
        // byte off either way, an old unpadded bid's length, the largest
        // length (right only for the longest ids) and a box sized for a
        // bidder with a longer id.
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("fairt", &ciphertext(1, exact - 1)),
            "wrong_ciphertext_length",
        ),
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("fairt", &ciphertext(1, exact + 1)),
            "wrong_ciphertext_length",
        ),
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("fairt", &ciphertext(1, 200)),
            "wrong_ciphertext_length",
        ),
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("fairt", &ciphertext(1, MAX_CIPHERTEXT_BYTES)),
            "wrong_ciphertext_length",
        ),
        (
            usdc(),
            BID_START,
            amount,
            tee_msg("fairt", &bid_ciphertext(1, "fairt", &bidder(10))),
            "wrong_ciphertext_length",
        ),
        (
            usdc(),
            BID_START,
            USDC - 1,
            good.clone(),
            "below_min_deposit",
        ),
        (usdc(), BID_START, 0, good.clone(), "below_min_deposit"),
        (
            usdc(),
            BID_START,
            10_000 * USDC + 1,
            good.clone(),
            "above_max_deposit",
        ),
    ];
    for (token, now, amount, msg, reason) in cases {
        assert_rejected(&mut contract, &token, now, &who, amount, &msg, reason);
    }
    // No sale id when the msg itself is unreadable.
    deliver(&mut contract, &usdc(), BID_START, &who, amount, "{}");
    assert_eq!(event("bid_rejected")["sale_id"], Value::Null);

    // A sale id longer than a storage key may be is never looked up (the read
    // would panic with KeyLengthExceeded): unknown_sale, logged as null.
    for long in ["x".repeat(3_000), "a".repeat(33), "Fairt".to_owned()] {
        assert_rejected(
            &mut contract,
            &usdc(),
            BID_START,
            &who,
            amount,
            &tee_msg(&long, &ciphertext(1, 200)),
            "unknown_sale",
        );
        assert_eq!(event("bid_rejected")["sale_id"], Value::Null);
        set_call(&who, BID_START, 0);
        assert!(contract.get_sale(long.clone()).is_none());
        assert!(contract.get_result(long.clone()).is_none());
        assert_eq!(
            err(contract.claim(long.clone(), None)),
            crate::Error::UnknownSale
        );
    }
    // A well-formed id that names no sale is echoed.
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &who,
        amount,
        &tee_msg("nosuchsale", &ciphertext(1, 200)),
        "unknown_sale",
    );
    assert_eq!(event("bid_rejected")["sale_id"], json!("nosuchsale"));

    // The exact length and the deposit cap itself are accepted.
    assert_eq!(
        deliver(
            &mut contract,
            &usdc(),
            BID_START,
            &who,
            10_000 * USDC,
            &good
        ),
        0
    );
    // One bid per account per sale; the same account may bid in another sale.
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &who,
        amount,
        &good,
        "already_bid",
    );
    let other = tee_msg("other", &bid_ciphertext(1, "other", &who));
    assert_eq!(
        deliver(
            &mut contract,
            &account("usdc2.testnet"),
            BID_START,
            &who,
            amount,
            &other
        ),
        0
    );
}

#[test]
fn rejects_bids_outside_bidding() {
    // Still in setup: the sale's token is not deployed yet.
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    let msg = tee_msg("fairt", &bid_ciphertext(1, "fairt", &bidder(1)));
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(1),
        5 * USDC,
        &msg,
        "not_open",
    );

    // Closed.
    let mut contract = ready_sale("fairt", RevealMode::CommitReveal);
    let msg = commit_msg("fairt", &[1; 32]);
    assert_eq!(
        deliver(
            &mut contract,
            &usdc(),
            BID_START,
            &bidder(1),
            5 * USDC,
            &msg
        ),
        0
    );
    set_call(&bidder(9), BID_END, 0);
    contract.close_sale("fairt".into()).unwrap().detach();
    let msg = commit_msg("fairt", &[2; 32]);
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_END,
        &bidder(2),
        5 * USDC,
        &msg,
        "not_open",
    );
}

#[test]
fn window_edges() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    let msg = |n| tee_msg("fairt", &bid_ciphertext(n, "fairt", &bidder(n)));
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START - 1,
        &bidder(0),
        USDC,
        &msg(0),
        "not_open",
    );
    assert_eq!(
        deliver(&mut contract, &usdc(), BID_START, &bidder(1), USDC, &msg(1)),
        0
    );
    assert_eq!(
        deliver(
            &mut contract,
            &usdc(),
            BID_END - 1,
            &bidder(2),
            USDC,
            &msg(2)
        ),
        0
    );
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_END,
        &bidder(3),
        USDC,
        &msg(3),
        "not_open",
    );
}

#[test]
fn rejects_bids_once_the_sale_is_full() {
    let mut contract = new_contract();
    let mut p = params("fairt", RevealMode::Tee);
    p.max_bids = 2;
    create(&mut contract, p);
    finish_setup(&mut contract, "fairt", RevealMode::Tee);
    place_tee_bid(&mut contract, "fairt", 1, USDC);
    place_tee_bid(&mut contract, "fairt", 2, USDC);
    let msg = tee_msg("fairt", &bid_ciphertext(3, "fairt", &bidder(3)));
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(3),
        USDC,
        &msg,
        "sale_full",
    );
}

#[test]
fn rejects_a_deposit_that_would_overflow_the_total() {
    // decimals 0 allows a cap of u128::MAX, so two capped deposits overflow.
    let mut contract = new_contract();
    let mut p = params("fairt", RevealMode::Tee);
    p.decimals = 0;
    p.total_supply = U128(1_000_000);
    p.sale_supply = U128(600_000);
    p.max_deposit_per_account = U128(u128::MAX);
    create(&mut contract, p);
    finish_setup(&mut contract, "fairt", RevealMode::Tee);
    place_tee_bid(&mut contract, "fairt", 1, u128::MAX - USDC);
    // bidder(2) and bidder(3) have ids of the same length.
    let msg = tee_msg("fairt", &bid_ciphertext(2, "fairt", &bidder(2)));
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(2),
        USDC + 1,
        &msg,
        "overflow",
    );
    // Exactly reaching u128::MAX still fits.
    assert_eq!(
        deliver(&mut contract, &usdc(), BID_START, &bidder(3), USDC, &msg),
        0
    );
    assert_eq!(
        contract
            .get_bids_summary("fairt".into())
            .unwrap()
            .total_deposits,
        U128(u128::MAX)
    );
}

#[test]
fn commit_reveal_bids_take_a_commitment() {
    let mut contract = ready_sale("fairt", RevealMode::CommitReveal);
    let tee = tee_msg("fairt", &ciphertext(1, 100));
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(1),
        USDC,
        &tee,
        "wrong_payload",
    );
    let short = r#"{"sale_id":"fairt","commitment":"abcd"}"#;
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(1),
        USDC,
        short,
        "bad_hex",
    );
    let not_hex = json!({"sale_id":"fairt","commitment":"zz".repeat(32)}).to_string();
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(1),
        USDC,
        &not_hex,
        "bad_hex",
    );
    // Either case of hex is accepted.
    let upper = json!({"sale_id":"fairt","commitment":"AB".repeat(32)}).to_string();
    assert_eq!(
        deliver(&mut contract, &usdc(), BID_START, &bidder(1), USDC, &upper),
        0
    );
    assert_eq!(
        contract.get_bid("fairt".into(), bidder(1)).unwrap().payload,
        "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s="
    );
}

#[test]
fn bid_set_hash_matches_the_reference() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    let bids: Vec<(AccountId, u128, Vec<u8>)> = (1..=6)
        .map(|n| {
            (
                bidder(n),
                u128::from(n) * 3 * USDC + 17,
                bid_ciphertext(n, "fairt", &bidder(n)),
            )
        })
        .collect();
    let empty = bid_set_hash("fairt", std::iter::empty()).unwrap();
    assert_eq!(
        contract
            .get_bids_summary("fairt".into())
            .unwrap()
            .bid_set_hash,
        empty
    );
    for (who, deposit, payload) in &bids {
        let msg = tee_msg("fairt", payload);
        assert_eq!(
            deliver(&mut contract, &usdc(), BID_START, who, *deposit, &msg),
            0
        );
    }
    let expected = bid_set_hash(
        "fairt",
        bids.iter().map(|(who, deposit, payload)| BidSetEntry {
            bidder: who.as_str(),
            deposit: *deposit,
            payload,
        }),
    )
    .unwrap();
    assert_eq!(
        contract
            .get_bids_summary("fairt".into())
            .unwrap()
            .bid_set_hash,
        expected
    );

    // Commit-reveal hashes the 32-byte commitment as the payload.
    let mut contract = ready_sale("cr", RevealMode::CommitReveal);
    let salt = [9u8; 16];
    let commit = commitment("cr", bidder(1).as_str(), 1_500, 10 * USDC, &salt);
    assert_eq!(
        deliver(
            &mut contract,
            &usdc(),
            BID_START,
            &bidder(1),
            10 * USDC,
            &commit_msg("cr", &commit)
        ),
        0
    );
    let expected = bid_set_hash(
        "cr",
        [BidSetEntry {
            bidder: bidder(1).as_str(),
            deposit: 10 * USDC,
            payload: &commit,
        }],
    )
    .unwrap();
    assert_eq!(
        contract.get_bids_summary("cr".into()).unwrap().bid_set_hash,
        expected
    );
}

#[test]
fn bids_are_listed_in_order() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    for n in 0..5 {
        place_tee_bid(&mut contract, "fairt", n, USDC + u128::from(n));
    }
    let page: Vec<(u32, AccountId)> = contract
        .get_bids("fairt".into(), Some(2), Some(2))
        .into_iter()
        .map(|bid| (bid.index, bid.bidder))
        .collect();
    assert_eq!(page, vec![(2, bidder(2)), (3, bidder(3))]);
    assert!(contract.get_bids("missing".into(), None, None).is_empty());
}

/// The contract's length rule against the sealer's own fixture: for every sale
/// id and bidder there, a ciphertext of the fixture's `sealed_len` is accepted
/// and one byte more or less is refused. The fixture's lengths come from
/// boxes `fairground_sealer::seal_bid` really made.
#[test]
fn ciphertext_lengths_match_the_sealer_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../crates/sealer/tests/fixtures/canonical_bids.json"
    ))
    .unwrap();
    let mut cases: Vec<(String, AccountId, usize)> = Vec::new();
    for row in fixture["rows"].as_array().unwrap() {
        let case = (
            row["sale_id"].as_str().unwrap().to_owned(),
            account(row["bidder"].as_str().unwrap()),
            usize::try_from(row["sealed_len"].as_u64().unwrap()).unwrap(),
        );
        assert_eq!(case.2, sealed_len(&case.0, &case.1), "{row}");
        if !cases.contains(&case) {
            cases.push(case);
        }
    }
    assert_eq!(cases.len(), 6);
    assert!(cases.iter().any(|case| case.2 == MAX_CIPHERTEXT_BYTES));

    let mut contract = new_contract();
    let mut created: Vec<String> = Vec::new();
    for (sale_id, who, len) in &cases {
        if !created.contains(sale_id) {
            create(&mut contract, params(sale_id, RevealMode::Tee));
            finish_setup(&mut contract, sale_id, RevealMode::Tee);
            created.push(sale_id.clone());
        }
        for wrong in [len - 1, len + 1] {
            deliver(
                &mut contract,
                &usdc(),
                BID_START,
                who,
                USDC,
                &tee_msg(sale_id, &ciphertext(1, wrong)),
            );
            let reason = if wrong > MAX_CIPHERTEXT_BYTES {
                "ciphertext_too_long"
            } else {
                "wrong_ciphertext_length"
            };
            assert_eq!(
                event("bid_rejected")["reason"],
                json!(reason),
                "{sale_id} {who} {wrong}"
            );
        }
        assert_eq!(
            deliver(
                &mut contract,
                &usdc(),
                BID_START,
                who,
                USDC,
                &tee_msg(sale_id, &ciphertext(2, *len)),
            ),
            0,
            "{sale_id} {who} {len}"
        );
    }
    assert_eq!(MAX_CIPHERTEXT_BYTES, 320);
}

/// A bid copied from another bidder whose id has the same length still gets
/// in (only the enclave can tell, and it then pays the invalid-bid penalty);
/// from a bidder with a longer or shorter id it is refused at the door.
#[test]
fn copied_ciphertexts_get_in_only_at_the_same_id_length() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    let original = bid_ciphertext(1, "fairt", &bidder(1));
    place_tee_bid(&mut contract, "fairt", 1, USDC);
    assert_eq!(
        deliver(
            &mut contract,
            &usdc(),
            BID_START,
            &bidder(2),
            USDC,
            &tee_msg("fairt", &original)
        ),
        0
    );
    assert_rejected(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(10),
        USDC,
        &tee_msg("fairt", &original),
        "wrong_ciphertext_length",
    );
}

/// `bid_placed` is logged only once the bid is in storage: when
/// `ft_on_transfer` returns, nothing is left for the end of the call to write.
/// The event itself is unchanged.
#[test]
fn a_bid_is_written_before_bid_placed_is_logged() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    // The first bid also creates the sale's deposits list; test both.
    for n in [1, 2] {
        contract.flush();
        let before = storage_bytes();
        let msg = tee_msg("fairt", &bid_ciphertext(n, "fairt", &bidder(n)));
        assert_eq!(
            deliver(
                &mut contract,
                &usdc(),
                BID_START,
                &bidder(n),
                7 * USDC,
                &msg
            ),
            0
        );
        let logged = events();
        // Storage as the call leaves it, before anything flushes the caches.
        let written = storage_bytes();
        contract.flush();
        let flushed = storage_bytes();
        assert!(written > before, "bid {n} wrote nothing");
        assert_eq!(
            written, flushed,
            "bid {n} left writes for the end of the call"
        );

        let summary = contract.get_bids_summary("fairt".into()).unwrap();
        assert_eq!(
            logged,
            vec![(
                "bid_placed".to_owned(),
                json!({"sale_id": "fairt", "bidder": bidder(n), "index": n - 1,
                       "deposit": (7 * USDC).to_string(), "bid_set_hash": summary.bid_set_hash})
            )]
        );
    }
}
