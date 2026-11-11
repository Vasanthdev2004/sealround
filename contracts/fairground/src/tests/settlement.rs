//! `close_sale`, `on_clearing_result` (every outcome and check), retries and
//! refund mode.

use fairground_clearing::{Bid, SaleParams, clear};

use super::*;
use crate::costs::{
    OUTLAYER_FREE_INPUT_BYTES, OUTLAYER_REQUEST_BASE_GAS, YOCTO_PER_BYTE, close_deposit,
};
use crate::{Error, FailReason, Status};

/// A bid as the sealer decrypts it.
#[derive(Clone, Copy)]
pub struct TestBid {
    pub n: u32,
    pub deposit: u128,
    pub price: u128,
    pub spend: u128,
}

/// Oversubscribed at the floor (850k tokens of demand for 600k).
pub fn three_bids() -> Vec<TestBid> {
    vec![
        TestBid {
            n: 1,
            deposit: 500 * USDC,
            price: 2_000,
            spend: 400 * USDC,
        },
        TestBid {
            n: 2,
            deposit: 300 * USDC,
            price: 1_500,
            spend: 300 * USDC,
        },
        TestBid {
            n: 3,
            deposit: 200 * USDC,
            price: 1_000,
            spend: 150 * USDC,
        },
    ]
}

pub fn closer() -> AccountId {
    account("closer.testnet")
}

/// Time of the clearing callback.
pub const CLEARED_AT: u64 = BID_END + MINUTE;

/// A TEE sale with `bids` placed and closed: status `clearing`. Returns the
/// close deposit.
pub fn clearing_sale(p: CreateSaleParams, bids: &[TestBid]) -> (Fairground, u128) {
    let sale_id = p.sale_id.clone();
    let mut contract = new_contract();
    create(&mut contract, p);
    finish_setup(&mut contract, &sale_id, RevealMode::Tee);
    for bid in bids {
        place_tee_bid(&mut contract, &sale_id, bid.n, bid.deposit);
    }
    set_call(&closer(), BID_END, 0);
    let deposit = contract.get_close_deposit(sale_id.clone()).unwrap().0;
    set_call(&closer(), BID_END, deposit);
    contract.close_sale(sale_id).unwrap().detach();
    (contract, deposit)
}

/// What a correct sealer prints for these bids (as a JSON value to tamper with).
pub fn sealer_output(contract: &Fairground, p: &CreateSaleParams, bids: &[TestBid]) -> Value {
    let params = SaleParams {
        sale_supply: p.sale_supply.0,
        floor_price: p.floor_price.0,
        min_raise: p.min_raise.0,
        decimals: p.decimals,
        max_price: p.max_price.map(|price| price.0),
    };
    let decrypted: Vec<Bid> = bids
        .iter()
        .map(|bid| Bid {
            bidder: bidder(bid.n).to_string(),
            deposit: bid.deposit,
            max_price: Some(bid.price),
            max_spend: Some(bid.spend),
            mismatch: false,
        })
        .collect();
    let result = clear(&params, &decrypted).unwrap();
    json!({
        "v": 1, "ok": true, "op": "clear", "sale_id": p.sale_id,
        "bid_set_hash": contract.get_bids_summary(p.sale_id.clone()).unwrap().bid_set_hash,
        // The key `finish_setup` published.
        "pubkey": "11".repeat(32),
        "clearing_price": result.clearing_price.to_string(),
        "n_valid": result.n_valid, "n_invalid": result.n_invalid,
        "invalid": result.fills.iter().filter(|f| !f.valid).map(|f| f.index).collect::<Vec<_>>(),
        "fills": result.fills.iter().map(|f| json!([f.tokens.to_string(), f.spent.to_string()])).collect::<Vec<_>>(),
    })
}

/// Delivers the clearing callback; returns the status it reports.
pub fn resolve(
    contract: &mut Fairground,
    sale_id: &str,
    deposit: u128,
    result: PromiseResult,
) -> String {
    set_callback(CLEARED_AT, vec![result]);
    contract.on_clearing_result(sale_id.to_owned(), closer(), U128(deposit))
}

pub fn ok_text(value: &Value) -> PromiseResult {
    PromiseResult::Successful(text_output(&value.to_string()))
}

/// A settled three-bid sale.
pub fn settled_sale() -> (Fairground, Value) {
    let p = params("fairt", RevealMode::Tee);
    let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
    let output = sealer_output(&contract, &p, &three_bids());
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&output)),
        "settled"
    );
    (contract, output)
}

fn result(contract: &Fairground) -> crate::ResultView {
    contract.get_result("fairt".into()).unwrap()
}

#[test]
fn close_sale_only_after_the_window() {
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    set_call(&closer(), BID_END, 0);
    assert_eq!(
        err(contract.close_sale("fairt".into())),
        Error::WrongPhase {
            action: "close the sale",
            status: "setup"
        }
    );
    finish_setup(&mut contract, "fairt", RevealMode::Tee);
    set_call(&closer(), BID_END - 1, 0);
    assert_eq!(
        err(contract.close_sale("fairt".into())),
        Error::TooEarly {
            action: "close the sale",
            at: BID_END
        }
    );
    set_call(&closer(), BID_END, 0);
    assert_eq!(err(contract.close_sale("nope".into())), Error::UnknownSale);
}

#[test]
fn closing_without_bids_fails_the_sale_and_refunds() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    set_call(&closer(), BID_END, 3 * YOCTO_PER_BYTE);
    assert_eq!(contract.get_close_deposit("fairt".into()).unwrap(), U128(0));
    match contract.close_sale("fairt".into()).unwrap() {
        PromiseOrValue::Value(status) => assert_eq!(status, "failed"),
        PromiseOrValue::Promise(_) => panic!("no OutLayer call without bids"),
    }
    assert_eq!(transfers(), vec![(closer(), 3 * YOCTO_PER_BYTE)]);
    assert!(calls_to("request_execution").is_empty());
    assert_eq!(event("sale_closed")["bid_count"], json!(0));
    assert_eq!(event("sale_failed")["reason"], json!("no_bids"));
    let result = result(&contract);
    assert_eq!(result.status, Status::Failed);
    assert_eq!(result.fail_reason, Some(FailReason::NoBids));
    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(sale.closed_at, Some(U64(BID_END)));
    assert_eq!(sale.refund_mode_at, None);
}

#[test]
fn close_sale_sends_every_bid_to_the_sealer() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    for bid in three_bids() {
        place_tee_bid(&mut contract, "fairt", bid.n, bid.deposit);
    }
    let bid_set_hash = contract
        .get_bids_summary("fairt".into())
        .unwrap()
        .bid_set_hash;
    let b64 = |n| {
        use near_sdk::base64::Engine as _;
        near_sdk::base64::engine::general_purpose::STANDARD.encode(bid_ciphertext(
            n,
            "fairt",
            &bidder(n),
        ))
    };
    let expected_input = format!(
        concat!(
            r#"{{"v":1,"op":"clear","contract":"fairground.testnet","sale_id":"fairt","#,
            r#""params":{{"sale_supply":"600000000000000000000000","floor_price":"1000","max_price":null,"min_raise":"50000000","decimals":18}},"#,
            r#""bid_set_hash":"{}","bids":[["bidder1.testnet","500000000","{}"],["bidder2.testnet","300000000","{}"],["bidder3.testnet","200000000","{}"]]}}"#
        ),
        bid_set_hash,
        b64(1),
        b64(2),
        b64(3)
    );

    set_call(&closer(), BID_END, 0);
    let deposit = contract.get_close_deposit("fairt".into()).unwrap().0;
    assert_eq!(deposit, close_deposit(expected_input.len()));
    assert_eq!(deposit, OUTLAYER_COMPUTE_DEPOSIT);
    set_call(&closer(), BID_END, deposit - 1);
    assert_eq!(
        err(contract.close_sale("fairt".into())),
        Error::DepositTooLow {
            required: deposit,
            attached: deposit - 1
        }
    );
    let mut ctx = context(&closer(), BID_END, deposit);
    ctx.prepaid_gas(Gas::from_tgas(100));
    testing_env!(ctx.build());
    assert!(matches!(
        contract.close_sale("fairt".into()),
        Err(Error::NotEnoughGas { .. })
    ));

    set_call(&closer(), BID_END, deposit);
    assert!(matches!(
        contract.close_sale("fairt".into()).unwrap(),
        PromiseOrValue::Promise(_)
    ));
    let request = calls_to("request_execution").pop().unwrap();
    assert_eq!(request.receiver, outlayer());
    assert_eq!(request.deposit, deposit);
    assert!(request.gas >= OUTLAYER_REQUEST_BASE_GAS);
    assert_eq!(request.args["input_data"], json!(expected_input));
    assert_eq!(request.args["payer_account_id"], json!("closer.testnet"));
    assert_eq!(request.args["response_format"], json!("Text"));
    let parsed: Value = serde_json::from_str(&expected_input).unwrap();
    assert_eq!(parsed["bids"].as_array().unwrap().len(), 3);
    let callback = calls_to("on_clearing_result").pop().unwrap();
    assert_eq!(
        callback.args,
        json!({"sale_id": "fairt", "closer": "closer.testnet", "deposit": deposit.to_string()})
    );
    let input_sha256 = fairground_clearing::hash::to_hex(&fairground_clearing::hash::sha256(
        expected_input.as_bytes(),
    ));
    assert_eq!(
        event("clearing_requested")["input_sha256"],
        json!(input_sha256)
    );
    assert_eq!(event("sale_closed")["bid_set_hash"], json!(bid_set_hash));

    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(sale.status, Status::Clearing);
    assert_eq!(sale.closed_at, Some(U64(BID_END)));
    assert_eq!(sale.refund_mode_at, Some(U64(BID_END + SETTLE_TIMEOUT)));
    assert_eq!(result(&contract).input_sha256, Some(input_sha256));
    assert_eq!(result(&contract).clear_requests, 1);
    // Bids are frozen and a second close waits for the result.
    let late = tee_msg("fairt", &bid_ciphertext(9, "fairt", &bidder(9)));
    assert_eq!(
        deliver(&mut contract, &usdc(), BID_END, &bidder(9), USDC, &late),
        USDC
    );
    set_call(&closer(), BID_END, deposit);
    assert_eq!(
        err(contract.close_sale("fairt".into())),
        Error::WrongPhase {
            action: "close the sale",
            status: "clearing"
        }
    );
    assert_eq!(contract.get_close_deposit("fairt".into()).unwrap(), U128(0));
}

#[test]
fn close_deposit_covers_input_above_32_kb() {
    let mut p = params("fairt", RevealMode::Tee);
    p.max_bids = 100;
    let mut contract = new_contract();
    create(&mut contract, p);
    finish_setup(&mut contract, "fairt", RevealMode::Tee);
    for n in 0..100 {
        let msg = tee_msg("fairt", &bid_ciphertext(n, "fairt", &bidder(n)));
        assert_eq!(
            deliver(&mut contract, &usdc(), BID_START, &bidder(n), USDC, &msg),
            0
        );
    }
    set_call(&closer(), BID_END, 0);
    let deposit = contract.get_close_deposit("fairt".into()).unwrap().0;
    set_call(&closer(), BID_END, deposit);
    contract.close_sale("fairt".into()).unwrap().detach();
    let request = calls_to("request_execution").pop().unwrap();
    let input_len = request.args["input_data"].as_str().unwrap().len();
    assert!(input_len > OUTLAYER_FREE_INPUT_BYTES);
    assert_eq!(
        deposit,
        OUTLAYER_COMPUTE_DEPOSIT + (input_len - OUTLAYER_FREE_INPUT_BYTES) as u128 * YOCTO_PER_BYTE
    );
    // 25 MGas per byte above 32 KB on top of the base, for OutLayer's callback.
    assert!(
        request.gas.as_gas()
            > OUTLAYER_REQUEST_BASE_GAS.as_gas()
                + (input_len - OUTLAYER_FREE_INPUT_BYTES) as u64 * 25_000_000
    );
}

#[test]
fn a_settled_result_is_checked_and_stored() {
    let p = params("fairt", RevealMode::Tee);
    let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
    let output = sealer_output(&contract, &p, &three_bids());
    let raw = text_output(&output.to_string());
    assert_eq!(
        resolve(
            &mut contract,
            "fairt",
            deposit,
            PromiseResult::Successful(raw.clone())
        ),
        "settled"
    );
    assert!(transfers().is_empty());

    let fills: Vec<(u128, u128)> = output["fills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f[0].as_str().unwrap().parse().unwrap(),
                f[1].as_str().unwrap().parse().unwrap(),
            )
        })
        .collect();
    let sold: u128 = fills.iter().map(|f| f.0).sum();
    let raised: u128 = fills.iter().map(|f| f.1).sum();
    assert_eq!(sold, 600_000 * TOKEN);
    let result = result(&contract);
    assert_eq!(result.status, Status::Settled);
    assert_eq!(result.fail_reason, None);
    assert_eq!(
        result.clearing_price,
        U128(output["clearing_price"].as_str().unwrap().parse().unwrap())
    );
    assert!(result.clearing_price.0 > 1_000);
    assert_eq!(
        (result.total_sold, result.total_raised),
        (U128(sold), U128(raised))
    );
    assert_eq!(result.unsold, U128(0));
    assert_eq!(
        (result.n_valid, result.n_invalid, result.n_winners),
        (3, 0, 2)
    );
    assert!(result.failed_checks.is_empty());
    let sha = fairground_clearing::hash::to_hex(&fairground_clearing::hash::sha256(&raw));
    assert_eq!(result.result_sha256, Some(sha.clone()));
    let settled = event("sale_settled");
    assert_eq!(settled["result_sha256"], json!(sha));
    assert_eq!(settled["total_raised"], json!(raised.to_string()));

    let views = contract.get_fills("fairt".into(), None, None);
    let deposits = [500 * USDC, 300 * USDC, 200 * USDC];
    for (i, view) in views.iter().enumerate() {
        assert_eq!(view.bidder, bidder(i as u32 + 1));
        assert_eq!((view.tokens.0, view.spent.0), fills[i]);
        assert_eq!(view.refund.0, deposits[i] - fills[i].1);
    }
    assert_eq!(views[2].tokens, U128(0));
}

#[test]
fn failed_runs_leave_the_sale_closed_for_a_retry() {
    let p = params("fairt", RevealMode::Tee);
    let cases: Vec<(PromiseResult, &str, bool)> = vec![
        (PromiseResult::Failed, "request refused by OutLayer", true),
        (
            PromiseResult::Successful(b"null".to_vec()),
            "the job failed or timed out",
            false,
        ),
        (
            ok_text(
                &json!({"v":1,"ok":false,"op":"clear","sale_id":"fairt","error":"cannot open key"}),
            ),
            "sealer_error: cannot open key",
            false,
        ),
        // `run`'s answer to a request without a usable op or sale id: a
        // refusal, not malformed output, whatever the op and sale id say.
        (
            PromiseResult::Successful(text_output(
                r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"missing_master"}"#,
            )),
            "sealer_error: missing_master",
            false,
        ),
        (
            PromiseResult::Successful(text_output(r#"{"v":1,"ok":false,"error":"internal"}"#)),
            "sealer_error: internal",
            false,
        ),
        (
            ok_text(&json!({"v":1,"ok":false,"op":"pubkey","sale_id":"other","error":"x"})),
            "sealer_error: x",
            false,
        ),
        (
            PromiseResult::Successful(text_output(r#"{"v":2,"ok":false,"error":null}"#)),
            "sealer_error",
            false,
        ),
    ];
    // A job that exits 0 without printing anything comes back as the Text
    // string "" (not `null`); whitespace alone is no answer either.
    let blank = [text_output(""), text_output(" \n")].map(|raw| {
        (
            PromiseResult::Successful(raw),
            "the job failed or timed out",
            false,
        )
    });
    let cases = cases.into_iter().chain(blank);
    for (outcome, reason, refunded) in cases {
        let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
        assert_eq!(resolve(&mut contract, "fairt", deposit, outcome), "closed");
        let expected_refund = if refunded {
            vec![(closer(), deposit)]
        } else {
            vec![]
        };
        assert_eq!(transfers(), expected_refund, "{reason}");
        let failed = event("clearing_failed");
        assert_eq!(failed["reason"], json!(reason));
        assert_eq!(failed["attempt"], json!(1));
        let result = result(&contract);
        assert_eq!(result.status, Status::Closed);
        assert_eq!(result.clear_attempts, 1);

        // Anyone retries with close_sale; the close time and bid set stay.
        let retrier = account("retrier.testnet");
        set_call(&retrier, CLEARED_AT, deposit);
        contract.close_sale("fairt".into()).unwrap().detach();
        assert!(events().iter().all(|(name, _)| name != "sale_closed"));
        assert_eq!(event("clearing_requested")["request"], json!(2));
        assert_eq!(
            calls_to("request_execution").pop().unwrap().args["payer_account_id"],
            json!("retrier.testnet")
        );
        let sale = contract.get_sale("fairt".into()).unwrap();
        assert_eq!(sale.status, Status::Clearing);
        assert_eq!(sale.closed_at, Some(U64(BID_END)));

        let output = sealer_output(&contract, &p, &three_bids());
        assert_eq!(
            resolve(&mut contract, "fairt", deposit, ok_text(&output)),
            "settled"
        );
        assert_eq!(result.clear_requests, 1);
        assert_eq!(
            contract.get_result("fairt".into()).unwrap().clear_requests,
            2
        );
    }
}

#[test]
fn malformed_output_fails_the_sale() {
    let p = params("fairt", RevealMode::Tee);
    let outputs: Vec<Vec<u8>> = vec![
        // Json format instead of Text.
        br#"{"v":1,"ok":true}"#.to_vec(),
        text_output("garbage"),
        text_output(r#"{"v":2,"ok":true,"op":"clear","sale_id":"fairt"}"#),
        text_output(r#"{"v":1,"ok":true,"op":"clear","sale_id":"fairt","clearing_price":"1000"}"#),
        text_output(r#"{"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"00"}"#),
        // `ok: true` needs an op and a sale id.
        text_output(r#"{"v":1,"ok":true,"op":null,"sale_id":null}"#),
        // A missing `ok` is not an answer either.
        text_output(r#"{"v":1,"op":"clear","sale_id":"fairt","error":"x"}"#),
        // Amounts must be decimal strings.
        text_output(
            r#"{"v":1,"ok":true,"op":"clear","sale_id":"fairt","bid_set_hash":"","clearing_price":1000,"n_valid":0,"n_invalid":0,"fills":[]}"#,
        ),
    ];
    for raw in outputs {
        let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
        assert_eq!(
            resolve(
                &mut contract,
                "fairt",
                deposit,
                PromiseResult::Successful(raw.clone())
            ),
            "failed"
        );
        let result = result(&contract);
        assert_eq!(result.fail_reason, Some(FailReason::ChecksFailed));
        assert_eq!(result.failed_checks, ["output_well_formed"]);
        let sha = fairground_clearing::hash::to_hex(&fairground_clearing::hash::sha256(&raw));
        assert_eq!(result.result_sha256, Some(sha));
    }
}

/// An `ok: true` clear answer without its op or sale id is malformed, even
/// when everything else is right.
#[test]
fn a_clear_answer_needs_its_op_and_sale_id() {
    let p = params("fairt", RevealMode::Tee);
    let tampers: [fn(&mut Value); 3] = [
        |o| o["sale_id"] = Value::Null,
        |o| {
            o.as_object_mut().unwrap().remove("sale_id");
        },
        |o| {
            o.as_object_mut().unwrap().remove("op");
        },
    ];
    for tamper in tampers {
        let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
        let mut output = sealer_output(&contract, &p, &three_bids());
        tamper(&mut output);
        assert_eq!(
            resolve(&mut contract, "fairt", deposit, ok_text(&output)),
            "failed",
            "{output}"
        );
        assert_eq!(result(&contract).failed_checks, ["output_well_formed"]);
    }
}

/// The exact bytes `run` prints when it has no op or sale id to echo: the
/// sale stays closed, the code is in the event, and a retry settles.
#[test]
fn a_refusal_without_op_or_sale_id_keeps_the_sale_closed() {
    let p = params("fairt", RevealMode::Tee);
    let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
    let refusal =
        text_output(r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"missing_master"}"#);
    assert_eq!(
        resolve(
            &mut contract,
            "fairt",
            deposit,
            PromiseResult::Successful(refusal)
        ),
        "closed"
    );
    assert_eq!(
        event("clearing_failed"),
        json!({"sale_id": "fairt", "attempt": 1, "reason": "sealer_error: missing_master"})
    );
    assert!(events().iter().all(|(name, _)| name != "sale_failed"));
    let result = result(&contract);
    assert_eq!((result.status, result.fail_reason), (Status::Closed, None));
    assert!(result.failed_checks.is_empty());

    // A long code is cut to 160 bytes.
    set_call(&closer(), CLEARED_AT, deposit);
    contract.close_sale("fairt".into()).unwrap().detach();
    let long = json!({"v":1,"ok":false,"op":"clear","sale_id":"fairt","error":"e".repeat(300)});
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&long)),
        "closed"
    );
    assert_eq!(
        event("clearing_failed")["reason"],
        json!(format!("sealer_error: {}", "e".repeat(160)))
    );

    set_call(&closer(), CLEARED_AT, deposit);
    contract.close_sale("fairt".into()).unwrap().detach();
    let output = sealer_output(&contract, &p, &three_bids());
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&output)),
        "settled"
    );
    assert_eq!(
        contract.get_result("fairt".into()).unwrap().clear_attempts,
        2
    );
}

/// Resolves a three-bid sale with the correct output after `tamper`; returns the result.
fn tampered(p: CreateSaleParams, tamper: impl Fn(&mut Value)) -> crate::ResultView {
    let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
    let mut output = sealer_output(&contract, &p, &three_bids());
    tamper(&mut output);
    resolve(&mut contract, "fairt", deposit, ok_text(&output));
    result(&contract)
}

fn set_fill(output: &mut Value, i: usize, tokens: u128, spent: u128) {
    output["fills"][i] = json!([tokens.to_string(), spent.to_string()]);
}

fn fill(output: &Value, i: usize) -> (u128, u128) {
    let f = &output["fills"][i];
    (
        f[0].as_str().unwrap().parse().unwrap(),
        f[1].as_str().unwrap().parse().unwrap(),
    )
}

#[test]
fn every_check_can_fail_the_sale() {
    let p = params("fairt", RevealMode::Tee);
    let mut ceiling = p.clone();
    ceiling.max_price = Some(U128(1_100));
    type Tamper = Box<dyn Fn(&mut Value)>;
    let cases: Vec<(CreateSaleParams, Tamper, &str)> = vec![
        (
            p.clone(),
            Box::new(|o| o["sale_id"] = json!("other")),
            "sale_id_matches",
        ),
        (
            p.clone(),
            Box::new(|o| o["bid_set_hash"] = json!("00".repeat(32))),
            "bid_set_hash_matches",
        ),
        // Opened with another key (the master secret changed): its verdicts,
        // invalid bids included, cannot be trusted.
        (
            p.clone(),
            Box::new(|o| o["pubkey"] = json!("22".repeat(32))),
            "pubkey_matches",
        ),
        // The invalid list: unsorted, out of range, or not adding up.
        (
            p.clone(),
            Box::new(|o| {
                o["n_valid"] = json!(1);
                o["n_invalid"] = json!(2);
                o["invalid"] = json!([2, 1]);
            }),
            "invalid_list_matches",
        ),
        (
            p.clone(),
            Box::new(|o| {
                o["n_valid"] = json!(2);
                o["n_invalid"] = json!(1);
                o["invalid"] = json!([3]);
            }),
            "invalid_list_matches",
        ),
        (
            p.clone(),
            Box::new(|o| o["invalid"] = json!([2])),
            "invalid_list_matches",
        ),
        (
            p.clone(),
            Box::new(|o| o["n_invalid"] = json!(1)),
            "invalid_list_matches",
        ),
        // A bid named invalid must get nothing.
        (
            p.clone(),
            Box::new(|o| {
                o["n_valid"] = json!(2);
                o["n_invalid"] = json!(1);
                o["invalid"] = json!([0]);
            }),
            "invalid_bid_unfilled_0",
        ),
        (
            p.clone(),
            Box::new(|o| {
                o["fills"].as_array_mut().unwrap().pop();
            }),
            "one_fill_per_bid",
        ),
        (
            p.clone(),
            Box::new(|o| {
                o["fills"].as_array_mut().unwrap().push(json!(["0", "0"]));
            }),
            "one_fill_per_bid",
        ),
        (
            p.clone(),
            Box::new(|o| o["clearing_price"] = json!("999")),
            "price_at_least_floor",
        ),
        (
            ceiling.clone(),
            Box::new(|o| o["clearing_price"] = json!("1101")),
            "price_at_most_ceiling",
        ),
        (
            p.clone(),
            Box::new(|o| {
                let (tokens, spent) = fill(o, 2);
                set_fill(o, 2, tokens + 1_000 * TOKEN, spent + 1_000_000);
            }),
            "sold_at_most_supply",
        ),
        (
            p.clone(),
            Box::new(|o| {
                let (tokens, _) = fill(o, 1);
                set_fill(o, 1, tokens, 300 * USDC + 1);
            }),
            "spent_within_deposit_1",
        ),
        (
            p.clone(),
            Box::new(|o| {
                let (tokens, spent) = fill(o, 0);
                set_fill(o, 0, tokens, spent + 1);
            }),
            "spent_equals_tokens_times_price_0",
        ),
    ];
    for (p, tamper, check) in cases {
        let result = tampered(p, tamper);
        assert_eq!(result.status, Status::Failed, "{check}");
        assert_eq!(
            result.fail_reason,
            Some(FailReason::ChecksFailed),
            "{check}"
        );
        assert!(
            result.failed_checks.iter().any(|name| name == check),
            "{check} not in {:?}",
            result.failed_checks
        );
        assert_eq!(
            (result.total_sold, result.total_raised, result.n_winners),
            (U128(0), U128(0), 0)
        );
    }

    // Only the tampered fill's price check fails when the change stays within the deposit.
    let result = tampered(p.clone(), |o| {
        let (tokens, spent) = fill(o, 0);
        set_fill(o, 0, tokens, spent + 1);
    });
    assert_eq!(result.failed_checks, ["spent_equals_tokens_times_price_0"]);
    assert_eq!(result.failed_checks_total, 1);
}

#[test]
fn failed_check_names_are_capped() {
    let mut p = params("fairt", RevealMode::Tee);
    p.max_bids = 12;
    let bids: Vec<TestBid> = (0..12)
        .map(|n| TestBid {
            n,
            deposit: 100 * USDC,
            price: 2_000,
            spend: 100 * USDC,
        })
        .collect();
    let (mut contract, deposit) = clearing_sale(p.clone(), &bids);
    let mut output = sealer_output(&contract, &p, &bids);
    for fill in output["fills"].as_array_mut().unwrap() {
        fill[1] = json!("1");
    }
    resolve(&mut contract, "fairt", deposit, ok_text(&output));
    let result = result(&contract);
    assert_eq!(result.failed_checks.len(), crate::settle::MAX_STORED_CHECKS);
    assert_eq!(result.failed_checks[0], "spent_equals_tokens_times_price_0");
    assert!(result.failed_checks_total >= 12);
    assert_eq!(
        event("sale_failed")["failed_checks_total"],
        json!(result.failed_checks_total)
    );
}

#[test]
fn unsuccessful_clearing_fails_with_its_reason() {
    // Below the minimum raise: the sealer zeroes every fill.
    let mut p = params("fairt", RevealMode::Tee);
    p.min_raise = U128(10_000 * USDC);
    let result = tampered(p, |_| {});
    assert_eq!(result.fail_reason, Some(FailReason::BelowMinRaise));
    assert_eq!(
        result.failed_checks,
        ["raise_at_least_min", "something_sold"]
    );
    assert_eq!(result.n_valid, 3);

    // No valid bid at all.
    let p = params("fairt", RevealMode::Tee);
    let result = tampered(p, |o| {
        o["n_valid"] = json!(0);
        o["n_invalid"] = json!(3);
        o["invalid"] = json!([0, 1, 2]);
        for i in 0..3 {
            set_fill(o, i, 0, 0);
        }
    });
    assert_eq!(result.fail_reason, Some(FailReason::NoValidBids));
    assert_eq!(
        result.failed_checks,
        ["raise_at_least_min", "something_sold"]
    );

    // Valid bids, no minimum raise, but nothing sold.
    let mut p = params("fairt", RevealMode::Tee);
    p.min_raise = U128(0);
    let result = tampered(p, |o| {
        for i in 0..3 {
            set_fill(o, i, 0, 0);
        }
    });
    assert_eq!(result.fail_reason, Some(FailReason::NothingSold));
    assert_eq!(result.failed_checks, ["something_sold"]);
}

#[test]
fn a_late_result_after_refund_mode_is_ignored() {
    let p = params("fairt", RevealMode::Tee);
    let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
    set_call(&closer(), BID_END + SETTLE_TIMEOUT - 1, 0);
    assert_eq!(
        contract.trigger_refund_mode("fairt".into()).unwrap_err(),
        Error::TooEarly {
            action: "trigger refund mode",
            at: BID_END + SETTLE_TIMEOUT
        }
    );
    set_call(&closer(), BID_END + SETTLE_TIMEOUT, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();
    assert_eq!(
        event("refund_mode"),
        json!({"sale_id": "fairt", "from": "clearing"})
    );

    let output = sealer_output(&contract, &p, &three_bids());
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&output)),
        "failed"
    );
    assert_eq!(result(&contract).fail_reason, Some(FailReason::RefundMode));
    // A refused request still hands the deposit back.
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, PromiseResult::Failed),
        "failed"
    );
    assert_eq!(transfers(), vec![(closer(), deposit)]);
}

#[test]
fn refund_mode_waits_for_the_settle_timeout() {
    // Never set up: counted from bid_end.
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    let deadline = BID_END + SETTLE_TIMEOUT;
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().refund_mode_at,
        Some(U64(deadline))
    );
    set_call(&bidder(1), deadline - 1, 0);
    assert!(matches!(
        contract.trigger_refund_mode("fairt".into()),
        Err(Error::TooEarly { .. })
    ));
    set_call(&bidder(1), deadline, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();
    assert_eq!(event("refund_mode")["from"], json!("setup"));
    assert_eq!(event("sale_failed")["reason"], json!("refund_mode"));
    assert_eq!(
        contract.trigger_refund_mode("fairt".into()).unwrap_err(),
        Error::WrongPhase {
            action: "trigger refund mode",
            status: "failed"
        }
    );

    // Bids but nobody closed: also from bid_end.
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    place_tee_bid(&mut contract, "fairt", 1, USDC);
    set_call(&bidder(1), deadline - 1, 0);
    assert!(matches!(
        contract.trigger_refund_mode("fairt".into()),
        Err(Error::TooEarly { .. })
    ));
    set_call(&bidder(1), deadline, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();
    assert_eq!(event("refund_mode")["from"], json!("awaiting_close"));

    // Closed after a failed run: from the close.
    let p = params("fairt", RevealMode::Tee);
    let mut contract = new_contract();
    create(&mut contract, p);
    finish_setup(&mut contract, "fairt", RevealMode::Tee);
    place_tee_bid(&mut contract, "fairt", 1, USDC);
    let closed_at = BID_END + 30 * MINUTE;
    set_call(&closer(), closed_at, OUTLAYER_COMPUTE_DEPOSIT);
    contract.close_sale("fairt".into()).unwrap().detach();
    resolve(
        &mut contract,
        "fairt",
        OUTLAYER_COMPUTE_DEPOSIT,
        PromiseResult::Successful(b"null".to_vec()),
    );
    set_call(&bidder(1), closed_at + SETTLE_TIMEOUT - 1, 0);
    assert_eq!(
        contract.trigger_refund_mode("fairt".into()).unwrap_err(),
        Error::TooEarly {
            action: "trigger refund mode",
            at: closed_at + SETTLE_TIMEOUT
        }
    );
    set_call(&bidder(1), closed_at + SETTLE_TIMEOUT, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();
    assert_eq!(event("refund_mode")["from"], json!("closed"));

    // Settled sales are final.
    let (mut contract, _) = settled_sale();
    set_call(&bidder(1), BID_END + 100 * SETTLE_TIMEOUT, 0);
    assert!(matches!(
        contract.trigger_refund_mode("fairt".into()),
        Err(Error::WrongPhase { .. })
    ));
    set_call(
        &closer(),
        BID_END + 100 * SETTLE_TIMEOUT,
        OUTLAYER_COMPUTE_DEPOSIT,
    );
    assert!(matches!(
        contract.close_sale("fairt".into()),
        Err(Error::WrongPhase { .. })
    ));
}

/// Refunds `get_fills` reports, in bid order.
fn refunds(contract: &Fairground) -> Vec<(u128, u128)> {
    contract
        .get_fills("fairt".into(), None, None)
        .iter()
        .map(|fill| (fill.refund.0, fill.penalty.0))
        .collect()
}

/// Every bid slot filled with ciphertexts the enclave cannot open: the sale
/// fails with no valid bids, and each junk bid pays 1 % of its deposit, so
/// blocking a sale this way is no longer free.
#[test]
fn junk_bids_pay_the_invalid_bid_penalty() {
    let p = params("fairt", RevealMode::Tee);
    let junk: Vec<TestBid> = (1..=3)
        .map(|n| TestBid {
            n,
            deposit: 150 * USDC + u128::from(n),
            price: 2_000,
            spend: USDC,
        })
        .collect();
    let (mut contract, deposit) = clearing_sale(p.clone(), &junk);
    let mut output = sealer_output(&contract, &p, &junk);
    output["n_valid"] = json!(0);
    output["n_invalid"] = json!(3);
    output["invalid"] = json!([0, 1, 2]);
    for i in 0..3 {
        set_fill(&mut output, i, 0, 0);
    }
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&output)),
        "failed"
    );
    let result = result(&contract);
    assert_eq!(result.fail_reason, Some(FailReason::NoValidBids));
    let penalties: Vec<u128> = junk.iter().map(|bid| bid.deposit.div_ceil(100)).collect();
    assert_eq!(result.total_penalties, U128(penalties.iter().sum::<u128>()));
    assert_eq!(
        refunds(&contract),
        junk.iter()
            .zip(&penalties)
            .map(|(bid, &penalty)| (bid.deposit - penalty, penalty))
            .collect::<Vec<_>>()
    );
    // The claim pays the deposit minus the penalty, once.
    set_call(&bidder(2), CLEARED_AT, 0);
    contract.claim("fairt".into(), None).unwrap().detach();
    let transfer = calls_to("ft_transfer").pop().unwrap();
    assert_eq!(
        transfer.args["amount"],
        json!((junk[1].deposit - penalties[1]).to_string())
    );
}

/// A settled sale: only the bids the enclave named invalid pay the penalty.
#[test]
fn only_invalid_bids_of_a_settled_sale_pay_the_penalty() {
    let p = params("fairt", RevealMode::Tee);
    let mut bids = three_bids();
    // Below the floor: invalid.
    bids.push(TestBid {
        n: 4,
        deposit: 70 * USDC,
        price: 999,
        spend: 70 * USDC,
    });
    let (mut contract, deposit) = clearing_sale(p.clone(), &bids);
    let output = sealer_output(&contract, &p, &bids);
    assert_eq!(output["invalid"], json!([3]));
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&output)),
        "settled"
    );
    let result = result(&contract);
    assert_eq!((result.n_valid, result.n_invalid), (3, 1));
    assert_eq!(result.total_penalties, U128(700_000));
    let refunds = refunds(&contract);
    assert_eq!(refunds[3], (70 * USDC - 700_000, 700_000));
    assert!(refunds[..3].iter().all(|&(_, penalty)| penalty == 0));
}

/// A result that fails an integrity check cannot name anyone invalid: the
/// sale fails and every deposit comes back whole.
#[test]
fn an_untrusted_result_refunds_everyone_in_full() {
    let p = params("fairt", RevealMode::Tee);
    let (mut contract, deposit) = clearing_sale(p.clone(), &three_bids());
    let mut output = sealer_output(&contract, &p, &three_bids());
    // Another key "failed to open" every bid.
    output["pubkey"] = json!("22".repeat(32));
    output["n_valid"] = json!(0);
    output["n_invalid"] = json!(3);
    output["invalid"] = json!([0, 1, 2]);
    for i in 0..3 {
        set_fill(&mut output, i, 0, 0);
    }
    assert_eq!(
        resolve(&mut contract, "fairt", deposit, ok_text(&output)),
        "failed"
    );
    let result = result(&contract);
    assert_eq!(result.fail_reason, Some(FailReason::ChecksFailed));
    assert_eq!(result.failed_checks[0], "pubkey_matches");
    assert_eq!(result.total_penalties, U128(0));
    assert_eq!(
        refunds(&contract),
        three_bids()
            .iter()
            .map(|bid| (bid.deposit, 0))
            .collect::<Vec<_>>()
    );
}
