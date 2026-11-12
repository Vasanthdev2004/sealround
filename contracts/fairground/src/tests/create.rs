//! `new`, `create_sale` (validation, cost, promises), the setup callbacks and
//! `retry_setup`.

use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs};

use super::*;
use crate::costs::{
    MAX_BIDS_PER_SALE, ON_SEALER_KEY_GAS, QUOTE_REGISTRATION_COST, SEALER_MAX_EXECUTION_SECONDS,
    SEALER_MAX_INSTRUCTIONS, SEALER_MAX_MEMORY_MB, TOKEN_INIT_GAS, TOKEN_STORAGE_DEPOSIT,
    TOKEN_WASM, per_bid_reserve, sale_storage_cost, token_deploy_balance,
};
use crate::outlayer::pubkey_input;
use crate::sale::MIN_DEPOSIT_FLOOR;
use crate::{Error, StepState};

fn new_with(
    source: SealerSource,
    hash: &str,
    secrets: Option<SecretsRef>,
    tokens: Vec<AccountId>,
) -> Result<Fairground, Error> {
    set_call(&contract_id(), T0, 0);
    Fairground::new(outlayer(), source, hash.to_owned(), secrets, tokens)
}

fn project(version_key: &str) -> SealerSource {
    SealerSource::Project {
        project_id: "owner.testnet/fairground-sealer".to_owned(),
        version_key: version_key.to_owned(),
    }
}

fn wasm_url(url: &str, hash: &str) -> SealerSource {
    SealerSource::WasmUrl {
        url: url.to_owned(),
        hash: hash.to_owned(),
        build_target: Some("wasm32-wasip1".to_owned()),
    }
}

fn config_error(result: Result<Fairground, Error>) -> &'static str {
    match result {
        Err(Error::InvalidConfig(rule)) => rule,
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("config was accepted"),
    }
}

#[test]
fn new_validates_the_config() {
    let tokens = vec![usdc()];
    let profile = |p: &str| {
        Some(SecretsRef {
            profile: p.to_owned(),
            account_id: account("owner.testnet"),
        })
    };
    let upper = CODE_HASH.to_uppercase();
    let cases: Vec<(Result<Fairground, Error>, &str)> = vec![
        (
            new_with(project(&upper), &upper, None, tokens.clone()),
            "sealer_code_hash",
        ),
        (
            new_with(project("ab"), "ab", None, tokens.clone()),
            "sealer_code_hash",
        ),
        (
            new_with(project(&"0".repeat(64)), CODE_HASH, None, tokens.clone()),
            "version_key",
        ),
        (
            new_with(
                SealerSource::Project {
                    project_id: "no-slash".to_owned(),
                    version_key: CODE_HASH.to_owned(),
                },
                CODE_HASH,
                None,
                tokens.clone(),
            ),
            "project_id",
        ),
        (
            new_with(
                wasm_url("http://x.io/s.wasm", CODE_HASH),
                CODE_HASH,
                None,
                tokens.clone(),
            ),
            "url",
        ),
        (
            new_with(
                wasm_url("https://x.io/s.wasm", &"0".repeat(64)),
                CODE_HASH,
                None,
                tokens.clone(),
            ),
            "hash",
        ),
        (
            new_with(project(CODE_HASH), CODE_HASH, profile(""), tokens.clone()),
            "profile",
        ),
        (
            new_with(
                project(CODE_HASH),
                CODE_HASH,
                profile("a b"),
                tokens.clone(),
            ),
            "profile",
        ),
        (
            new_with(project(CODE_HASH), CODE_HASH, None, vec![]),
            "allowed_quote_tokens",
        ),
        (
            new_with(project(CODE_HASH), CODE_HASH, None, vec![usdc(), usdc()]),
            "duplicate",
        ),
    ];
    for (result, expected) in cases {
        let rule = config_error(result);
        assert!(
            rule.contains(expected),
            "{rule:?} should mention {expected}"
        );
    }

    let contract = new_with(
        wasm_url("https://test.fastfs.io/o/s.wasm", CODE_HASH),
        CODE_HASH,
        profile("default-1_x"),
        tokens,
    )
    .unwrap();
    let config = contract.get_config();
    assert_eq!(config.outlayer, outlayer());
    assert_eq!(config.sealer_code_hash, CODE_HASH);
    assert_eq!(
        serde_json::to_value(&config.sealer_source).unwrap(),
        json!({"WasmUrl": {"url": "https://test.fastfs.io/o/s.wasm", "hash": CODE_HASH, "build_target": "wasm32-wasip1"}})
    );
}

fn create_error(contract: &mut Fairground, params: CreateSaleParams) -> Error {
    set_call(&creator(), T0, 1_000_000 * TOKEN_STORAGE_DEPOSIT);
    contract.create_sale(params).unwrap_err()
}

/// Invalid params fail `create_sale` and `get_create_cost` alike.
fn invalid_params_error(contract: &mut Fairground, params: CreateSaleParams) -> Error {
    set_call(&creator(), T0, 0);
    let err = contract.get_create_cost(params.clone()).unwrap_err();
    assert_eq!(create_error(contract, params), err);
    err
}

#[test]
fn create_sale_validates_every_parameter() {
    let mut contract = new_contract();
    let base = || params("fairt", RevealMode::Tee);
    type Edit = Box<dyn Fn(&mut CreateSaleParams)>;
    let cases: Vec<(&str, Edit)> = vec![
        ("sale_id", Box::new(|p| p.sale_id = "Fairt".into())),
        ("sale_id", Box::new(|p| p.sale_id = "-fairt".into())),
        ("sale_id", Box::new(|p| p.sale_id = "fair.t".into())),
        ("sale_id", Box::new(|p| p.sale_id = "a".repeat(33))),
        // Valid by the pattern, but not as an account id.
        ("sale_id", Box::new(|p| p.sale_id = "fair--t".into())),
        ("token_name", Box::new(|p| p.token_name = "  ".into())),
        ("token_name", Box::new(|p| p.token_name = "n".repeat(65))),
        ("token_symbol", Box::new(|p| p.token_symbol = String::new())),
        (
            "token_symbol",
            Box::new(|p| p.token_symbol = "S".repeat(17)),
        ),
        ("decimals", Box::new(|p| p.decimals = 25)),
        (
            "icon",
            Box::new(|p| p.icon = Some("https://x.io/i.png".into())),
        ),
        (
            "icon",
            Box::new(|p| p.icon = Some(format!("data:{}", "a".repeat(2044)))),
        ),
        (
            "description",
            Box::new(|p| p.description = Some("d".repeat(281))),
        ),
        ("website", Box::new(|p| p.website = Some("w".repeat(201)))),
        ("sale_supply", Box::new(|p| p.sale_supply = U128(0))),
        (
            "sale_supply",
            Box::new(|p| p.sale_supply = U128(p.total_supply.0 + 1)),
        ),
        ("floor_price", Box::new(|p| p.floor_price = U128(0))),
        ("max_price", Box::new(|p| p.max_price = Some(U128(999)))),
        ("bid_start", Box::new(|p| p.bid_start = U64(T0 - 1))),
        ("bid_end", Box::new(|p| p.bid_end = p.bid_start)),
        (
            "bid_end",
            Box::new(|p| p.bid_end = U64(p.bid_start.0 + 30 * 24 * HOUR + 1)),
        ),
        ("min_deposit", Box::new(|p| p.min_deposit = U128(0))),
        // Below 1 USDC an invalid bid's 1 % penalty would cost next to nothing.
        (
            "min_deposit",
            Box::new(|p| p.min_deposit = U128(MIN_DEPOSIT_FLOOR - 1)),
        ),
        (
            "min_deposit",
            Box::new(|p| p.min_deposit = U128(p.max_deposit_per_account.0 + 1)),
        ),
        (
            "max_deposit_per_account",
            Box::new(|p| {
                p.decimals = 24;
                p.max_deposit_per_account = U128(u128::MAX / 10u128.pow(24) + 1);
            }),
        ),
        ("max_bids", Box::new(|p| p.max_bids = 0)),
        ("max_bids", Box::new(|p| p.max_bids = MAX_BIDS_PER_SALE + 1)),
        (
            "reveal_window",
            Box::new(|p| p.reveal_window = Some(U64(10 * MINUTE))),
        ),
        (
            "reveal_window",
            Box::new(|p| {
                p.reveal_mode = RevealMode::CommitReveal;
                p.reveal_window = Some(U64(59 * SEC));
            }),
        ),
        (
            "reveal_window",
            Box::new(|p| {
                p.reveal_mode = RevealMode::CommitReveal;
                p.reveal_window = Some(U64(7 * 24 * HOUR + 1));
            }),
        ),
        (
            "settle_timeout",
            Box::new(|p| p.settle_timeout = U64(10 * MINUTE - 1)),
        ),
        (
            "settle_timeout",
            Box::new(|p| p.settle_timeout = U64(7 * 24 * HOUR + 1)),
        ),
    ];
    for (field, edit) in cases {
        let mut p = base();
        edit(&mut p);
        match invalid_params_error(&mut contract, p) {
            Error::InvalidParam { field: got, .. } => assert_eq!(got, field),
            other => panic!("{field}: unexpected {other}"),
        }
    }

    let mut p = base();
    p.quote_token = account("dai.testnet");
    assert_eq!(
        invalid_params_error(&mut contract, p),
        Error::QuoteTokenNotAllowed
    );

    // Every limit itself is accepted.
    let mut p = base();
    p.sale_id = "a".repeat(32);
    p.token_name = "n".repeat(64);
    p.token_symbol = "S".repeat(16);
    p.decimals = 24;
    p.max_deposit_per_account = U128(u128::MAX / 10u128.pow(24));
    p.icon = Some(format!("data:{}", "a".repeat(2043)));
    p.description = Some("d".repeat(280));
    p.website = Some("w".repeat(200));
    p.max_price = Some(p.floor_price);
    p.bid_start = U64(T0);
    p.bid_end = U64(T0 + 30 * 24 * HOUR);
    p.max_bids = MAX_BIDS_PER_SALE;
    p.settle_timeout = U64(10 * MINUTE);
    p.sale_supply = p.total_supply;
    create(&mut contract, p.clone());
    assert_eq!(create_error(&mut contract, p), Error::SaleExists);

    let mut p = params("cr", RevealMode::CommitReveal);
    p.reveal_window = Some(U64(MINUTE));
    create(&mut contract, p);
    assert_eq!(
        contract.get_sale("cr".into()).unwrap().reveal_window,
        Some(U64(MINUTE))
    );
}

#[test]
fn create_params_refuse_unknown_fields() {
    let mut value = serde_json::to_value(params("fairt", RevealMode::Tee)).unwrap();
    value["max_prize"] = json!("5");
    assert!(serde_json::from_value::<CreateSaleParams>(value).is_err());
}

#[test]
fn create_cost_adds_up_and_excess_is_refunded() {
    let mut contract = new_contract();
    let p = params("fairt", RevealMode::Tee);
    set_call(&creator(), T0, 0);
    let cost = contract.get_create_cost(p.clone()).unwrap().0;
    let token_len = "fairt.fairground.testnet".len();
    let accounts_len = 64 + usdc().len() + token_len;
    let meta_len = "Fair Test".len() + "FAIRT".len();
    let expected = sale_storage_cost(5, accounts_len, meta_len)
        + token_deploy_balance(meta_len)
        + 10 * per_bid_reserve(RevealMode::Tee)
        + 2 * TOKEN_STORAGE_DEPOSIT
        + QUOTE_REGISTRATION_COST
        + OUTLAYER_COMPUTE_DEPOSIT;
    assert_eq!(cost, expected);

    set_call(&creator(), T0, cost - 1);
    assert_eq!(
        contract.create_sale(p.clone()).unwrap_err(),
        Error::DepositTooLow {
            required: cost,
            attached: cost - 1
        }
    );

    // TEE: the excess goes to OutLayer with the key deposit (headroom if its
    // prices rose); OutLayer refunds what it does not charge to the creator.
    let excess = 5 * 10u128.pow(24);
    set_call(&creator(), T0, cost + excess);
    contract.create_sale(p).unwrap();
    assert!(transfers().is_empty());
    let request = calls_to("request_execution").pop().unwrap();
    assert_eq!(request.deposit, OUTLAYER_COMPUTE_DEPOSIT + excess);
    assert_eq!(request.args["payer_account_id"], json!("creator.testnet"));
    assert_eq!(
        calls_to("on_sealer_key").pop().unwrap().args["deposit"],
        json!((OUTLAYER_COMPUTE_DEPOSIT + excess).to_string())
    );
    let created = event("sale_created");
    assert_eq!(created["cost"], json!(cost.to_string()));
    assert_eq!(created["token"], json!("fairt.fairground.testnet"));

    // The quote token is registered once; a commit-reveal sale pays no key
    // call and gets its excess back at once.
    let mut p = params("second", RevealMode::CommitReveal);
    p.max_bids = 3;
    set_call(&creator(), T0, 0);
    let cost = contract.get_create_cost(p.clone()).unwrap().0;
    let accounts_len = 64 + usdc().len() + "second.fairground.testnet".len();
    assert_eq!(
        cost,
        sale_storage_cost(6, accounts_len, meta_len)
            + token_deploy_balance(meta_len)
            + 3 * per_bid_reserve(RevealMode::CommitReveal)
            + 2 * TOKEN_STORAGE_DEPOSIT
    );
    set_call(&creator(), T0, cost + 9);
    contract.create_sale(p).unwrap();
    assert!(calls_to("storage_deposit").is_empty());
    assert!(calls_to("request_execution").is_empty());
    assert_eq!(transfers(), vec![(creator(), 9)]);
}

#[test]
fn create_sale_deploys_the_token_and_asks_for_the_key() {
    let mut contract = new_contract();
    let mut p = params("fairt", RevealMode::Tee);
    p.icon = Some("data:image/svg+xml,<svg/>".to_owned());
    set_call(&creator(), T0, 0);
    let cost = contract.get_create_cost(p.clone()).unwrap().0;
    set_call(&creator(), T0, cost);
    contract.create_sale(p).unwrap();
    let token = account("fairt.fairground.testnet");
    let meta_len = "Fair Test".len() + "FAIRT".len() + "data:image/svg+xml,<svg/>".len();

    // One batch: create, fund, deploy, init.
    let receipts = get_created_receipts();
    let batch = receipts.iter().find(|r| r.receiver_id == token).unwrap();
    assert!(matches!(batch.actions[0], MockAction::CreateAccount { .. }));
    assert!(matches!(
        batch.actions[1],
        MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == token_deploy_balance(meta_len)
    ));
    assert!(
        matches!(&batch.actions[2], MockAction::DeployContract { code, .. } if code.as_slice() == TOKEN_WASM)
    );
    let init = calls_to("new").pop().unwrap();
    assert_eq!(init.receiver, token);
    assert_eq!(init.gas, TOKEN_INIT_GAS);
    assert_eq!(
        init.args,
        json!({
            "owner_id": "fairground.testnet",
            "total_supply": (1_000_000 * TOKEN).to_string(),
            "metadata": {"spec": "ft-1.0.0", "name": "Fair Test", "symbol": "FAIRT",
                "icon": "data:image/svg+xml,<svg/>", "reference": null, "reference_hash": null, "decimals": 18},
        })
    );
    let callback = calls_to("on_token_deployed").pop().unwrap();
    assert_eq!(callback.receiver, contract_id());
    assert_eq!(callback.args, json!({"sale_id": "fairt"}));

    // The sealer key request, exactly as OutLayer takes it.
    let request = calls_to("request_execution").pop().unwrap();
    assert_eq!(request.receiver, outlayer());
    assert_eq!(request.deposit, OUTLAYER_COMPUTE_DEPOSIT);
    assert_eq!(
        request.args,
        json!({
            "source": {"Project": {"project_id": "fairground.testnet/fairground-sealer", "version_key": CODE_HASH}},
            "resource_limits": {"max_instructions": SEALER_MAX_INSTRUCTIONS, "max_memory_mb": SEALER_MAX_MEMORY_MB, "max_execution_seconds": SEALER_MAX_EXECUTION_SECONDS},
            "input_data": pubkey_input(&contract_id(), "fairt"),
            "secrets_ref": {"profile": "default", "account_id": "sealer-owner.testnet"},
            "response_format": "Text",
            "payer_account_id": "creator.testnet",
            "params": null,
        })
    );
    assert_eq!(
        pubkey_input(&contract_id(), "fairt"),
        r#"{"v":1,"op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}"#
    );
    let callback = calls_to("on_sealer_key").pop().unwrap();
    assert_eq!(callback.gas, ON_SEALER_KEY_GAS);
    assert_eq!(
        callback.args,
        json!({"sale_id": "fairt", "payer": "creator.testnet", "deposit": OUTLAYER_COMPUTE_DEPOSIT.to_string()})
    );

    // First sale on this quote token: register this contract on it.
    let register = calls_to("storage_deposit").pop().unwrap();
    assert_eq!(register.receiver, usdc());
    assert_eq!(register.deposit, TOKEN_STORAGE_DEPOSIT);
    assert_eq!(
        register.args,
        json!({"account_id": "fairground.testnet", "registration_only": true})
    );
    assert_eq!(
        calls_to("on_quote_registered").pop().unwrap().args,
        json!({"quote_token": "usdc.testnet"})
    );

    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(sale.status, crate::Status::Setup);
    assert_eq!(sale.token_setup, StepState::Pending);
    assert_eq!(sale.sealer_key_setup, StepState::Pending);
    assert_eq!(sale.sealer_code_hash, CODE_HASH);
    assert_eq!(sale.creator_allocation, U128(400_000 * TOKEN));
}

#[test]
fn create_sale_needs_enough_gas() {
    let mut contract = new_contract();
    let p = params("fairt", RevealMode::Tee);
    set_call(&creator(), T0, 0);
    let cost = contract.get_create_cost(p.clone()).unwrap().0;
    let mut ctx = context(&creator(), T0, cost);
    ctx.prepaid_gas(Gas::from_tgas(100));
    testing_env!(ctx.build());
    assert!(matches!(
        contract.create_sale(p),
        Err(Error::NotEnoughGas { .. })
    ));
}

#[test]
fn setup_callbacks_open_the_sale() {
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    set_callback(T0, vec![PromiseResult::Successful(vec![])]);
    assert!(contract.on_token_deployed("fairt".into()));
    assert!(events().is_empty());
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().status,
        crate::Status::Setup
    );

    set_callback(T0, vec![PromiseResult::Successful(pubkey_output("fairt"))]);
    assert!(contract.on_sealer_key("fairt".into(), creator(), U128(OUTLAYER_COMPUTE_DEPOSIT)));
    assert_eq!(
        event("sale_ready"),
        json!({"sale_id": "fairt", "token": "fairt.fairground.testnet", "sealer_pubkey": "11".repeat(32)})
    );
    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(sale.status, crate::Status::Upcoming);
    assert_eq!(sale.sealer_pubkey, Some("11".repeat(32)));

    set_callback(T0, vec![PromiseResult::Successful(vec![])]);
    assert!(contract.on_quote_registered(usdc()));

    set_call(&creator(), BID_START, 0);
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().status,
        crate::Status::Open
    );
    set_call(&creator(), BID_END, 0);
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().status,
        crate::Status::AwaitingClose
    );
}

#[test]
fn bad_sealer_key_replies_fail_the_key_step() {
    let replies: Vec<PromiseResult> = vec![
        PromiseResult::Successful(b"null".to_vec()),
        PromiseResult::Successful(text_output(
            r#"{"v":1,"ok":true,"op":"pubkey","sale_id":"other","pubkey":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
        )),
        PromiseResult::Successful(text_output(
            r#"{"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"zz"}"#,
        )),
        PromiseResult::Successful(text_output(
            r#"{"v":1,"ok":false,"op":"pubkey","sale_id":"fairt","error":"no secret"}"#,
        )),
        PromiseResult::Successful(text_output(
            r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"missing_master"}"#,
        )),
        PromiseResult::Successful(text_output(
            r#"{"v":1,"ok":true,"op":null,"sale_id":null,"pubkey":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
        )),
        PromiseResult::Successful(text_output(
            r#"{"v":1,"ok":true,"op":"clear","sale_id":"fairt","pubkey":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
        )),
        PromiseResult::Successful(text_output(
            r#"{"v":2,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
        )),
        PromiseResult::Successful(text_output("not json")),
        // Json format instead of Text: not a JSON string.
        PromiseResult::Successful(br#"{"v":1,"ok":true}"#.to_vec()),
    ];
    for reply in replies {
        let mut contract = new_contract();
        create(&mut contract, params("fairt", RevealMode::Tee));
        set_callback(T0, vec![reply]);
        assert!(!contract.on_sealer_key("fairt".into(), creator(), U128(OUTLAYER_COMPUTE_DEPOSIT)));
        // Not refused at the door: OutLayer refunds the payer itself.
        assert!(transfers().is_empty());
        let sale = contract.get_sale("fairt".into()).unwrap();
        assert_eq!(sale.sealer_key_setup, StepState::Failed);
        assert_eq!(sale.sealer_pubkey, None);
    }
}

/// The log names why the key request failed: for an `ok: false` answer, the
/// sealer's error code, even when it echoes no op or sale id. Then
/// `retry_setup` can ask again.
#[test]
fn a_failed_key_request_logs_the_sealer_error_code() {
    let cases = [
        (
            text_output(r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"missing_master"}"#),
            "sealer_error: missing_master",
        ),
        (
            text_output(
                r#"{"v":1,"ok":false,"op":"pubkey","sale_id":"fairt","error":"predecessor_mismatch"}"#,
            ),
            "sealer_error: predecessor_mismatch",
        ),
        (b"null".to_vec(), "the job failed or timed out"),
        (text_output("not json"), "output is not the sealer's JSON"),
        (
            text_output(r#"{"v":1,"ok":true,"op":"pubkey","sale_id":"other","pubkey":"00"}"#),
            "unexpected sealer output",
        ),
    ];
    for (reply, why) in cases {
        let mut contract = new_contract();
        create(&mut contract, params("fairt", RevealMode::Tee));
        set_callback(T0, vec![PromiseResult::Successful(reply)]);
        assert!(!contract.on_sealer_key("fairt".into(), creator(), U128(OUTLAYER_COMPUTE_DEPOSIT)));
        assert_eq!(
            get_logs(),
            vec![format!(
                "sealer key request failed ({why}); retry_setup can retry it"
            )]
        );
        assert_eq!(
            contract.get_sale("fairt".into()).unwrap().sealer_key_setup,
            StepState::Failed
        );

        let retrier = account("helper.testnet");
        set_call(&retrier, T0, OUTLAYER_COMPUTE_DEPOSIT);
        contract.retry_setup("fairt".into()).unwrap();
        assert_eq!(calls_to("request_execution").len(), 1);
        set_callback(T0, vec![PromiseResult::Successful(pubkey_output("fairt"))]);
        assert!(contract.on_sealer_key("fairt".into(), retrier, U128(OUTLAYER_COMPUTE_DEPOSIT)));
        assert_eq!(
            contract.get_sale("fairt".into()).unwrap().sealer_key_setup,
            StepState::Done
        );
    }
}

#[test]
fn refused_key_request_refunds_the_payer() {
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    set_callback(T0, vec![PromiseResult::Failed]);
    assert!(!contract.on_sealer_key("fairt".into(), creator(), U128(OUTLAYER_COMPUTE_DEPOSIT)));
    assert_eq!(transfers(), vec![(creator(), OUTLAYER_COMPUTE_DEPOSIT)]);
    // A late duplicate does nothing.
    set_callback(T0, vec![PromiseResult::Successful(pubkey_output("fairt"))]);
    assert!(!contract.on_sealer_key("fairt".into(), creator(), U128(0)));
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().sealer_key_setup,
        StepState::Failed
    );
}

#[test]
fn retry_setup_retries_only_failed_steps() {
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    let retrier = account("helper.testnet");
    set_call(&retrier, T0, 0);
    assert_eq!(
        contract.retry_setup("fairt".into()),
        Err(Error::NothingToRetry)
    );

    // Token deploy and key both fail.
    set_callback(T0, vec![PromiseResult::Failed]);
    assert!(!contract.on_token_deployed("fairt".into()));
    set_callback(T0, vec![PromiseResult::Successful(b"null".to_vec())]);
    assert!(!contract.on_sealer_key("fairt".into(), creator(), U128(OUTLAYER_COMPUTE_DEPOSIT)));
    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(
        (sale.token_setup, sale.sealer_key_setup),
        (StepState::Failed, StepState::Failed)
    );

    // The key call needs its deposit from the retrier.
    set_call(&retrier, T0, OUTLAYER_COMPUTE_DEPOSIT - 1);
    assert!(matches!(
        contract.retry_setup("fairt".into()),
        Err(Error::DepositTooLow { .. })
    ));

    // Everything attached goes to OutLayer: more than the constant gets a key
    // through after a price rise, and OutLayer refunds the retrier the rest.
    let attached = OUTLAYER_COMPUTE_DEPOSIT + 7 * 10u128.pow(24);
    set_call(&retrier, T0, attached);
    contract.retry_setup("fairt".into()).unwrap();
    let meta_len = "Fair Test".len() + "FAIRT".len();
    let receipts = get_created_receipts();
    let batch = receipts
        .iter()
        .find(|r| r.receiver_id == account("fairt.fairground.testnet"))
        .unwrap();
    assert!(matches!(
        batch.actions[1],
        MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == token_deploy_balance(meta_len)
    ));
    let request = calls_to("request_execution").pop().unwrap();
    assert_eq!(request.deposit, attached);
    assert_eq!(request.args["payer_account_id"], json!("helper.testnet"));
    assert_eq!(
        calls_to("on_sealer_key").pop().unwrap().args,
        json!({"sale_id": "fairt", "payer": "helper.testnet", "deposit": attached.to_string()})
    );
    assert!(transfers().is_empty());
    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(
        (sale.token_setup, sale.sealer_key_setup),
        (StepState::Pending, StepState::Pending)
    );

    // While steps are in flight there is nothing to retry.
    set_call(&retrier, T0, 0);
    assert_eq!(
        contract.retry_setup("fairt".into()),
        Err(Error::NothingToRetry)
    );

    finish_setup(&mut contract, "fairt", RevealMode::Tee);
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().status,
        crate::Status::Upcoming
    );
}

#[test]
fn quote_registration_can_be_retried_after_setup() {
    let mut contract = ready_sale("fairt", RevealMode::Tee);
    set_callback(T0, vec![PromiseResult::Failed]);
    assert!(!contract.on_quote_registered(usdc()));
    // No key to pay for: NEAR attached comes straight back.
    set_call(&bidder(1), BID_START, 5);
    contract.retry_setup("fairt".into()).unwrap();
    let register = calls_to("storage_deposit").pop().unwrap();
    assert_eq!(register.receiver, usdc());
    assert_eq!(register.deposit, TOKEN_STORAGE_DEPOSIT);
    assert_eq!(transfers(), vec![(bidder(1), 5)]);
    set_call(&bidder(1), BID_START, 0);
    assert_eq!(
        contract.retry_setup("fairt".into()),
        Err(Error::NothingToRetry)
    );
}

#[test]
fn commit_reveal_sale_needs_only_the_token() {
    let mut contract = new_contract();
    create(&mut contract, params("cr", RevealMode::CommitReveal));
    assert!(calls_to("request_execution").is_empty());
    set_callback(T0, vec![PromiseResult::Successful(vec![])]);
    assert!(contract.on_token_deployed("cr".into()));
    let ready = event("sale_ready");
    assert_eq!(ready["sealer_pubkey"], Value::Null);
    assert_eq!(
        contract.get_sale("cr".into()).unwrap().status,
        crate::Status::Upcoming
    );
}

#[test]
fn sales_are_listed_in_creation_order() {
    let mut contract = new_contract();
    for id in ["s0", "s1", "s2"] {
        create(&mut contract, params(id, RevealMode::CommitReveal));
    }
    let ids = |from, limit| -> Vec<String> {
        contract
            .get_sales(from, limit)
            .into_iter()
            .map(|sale| sale.sale_id)
            .collect()
    };
    assert_eq!(ids(None, None), ["s0", "s1", "s2"]);
    assert_eq!(ids(Some(1), Some(1)), ["s1"]);
    assert_eq!(ids(Some(5), None), Vec::<String>::new());
    assert!(contract.get_sale("missing".into()).is_none());
}
