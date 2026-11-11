//! Unit tests. They drive the contract directly under `testing_env!`, inject
//! promise results for the callbacks, and read the receipts and events it
//! produces.

mod bidding;
mod claims;
mod costs;
mod create;
mod reveal;
mod settlement;

use near_sdk::json_types::{U64, U128};
use near_sdk::mock::{MockAction, MockedBlockchain, with_mocked_blockchain};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{
    AccountId, Gas, NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig, env,
    test_vm_config, testing_env,
};

use crate::costs::OUTLAYER_COMPUTE_DEPOSIT;
use crate::{CreateSaleParams, Fairground, RevealMode, SealerSource, SecretsRef};

pub const SEC: u64 = 1_000_000_000;
pub const MINUTE: u64 = 60 * SEC;
pub const HOUR: u64 = 60 * MINUTE;
/// Test clock start (any fixed time works).
pub const T0: u64 = 1_800_000_000 * SEC;
pub const BID_START: u64 = T0 + MINUTE;
pub const BID_END: u64 = T0 + HOUR;
pub const SETTLE_TIMEOUT: u64 = 2 * HOUR;
pub const CODE_HASH: &str = "5f1d2f6bd4c5fe0e5d3d6b8f6a5c3c0e9a3f4b2d1c0e9f8a7b6c5d4e3f2a1b0c";
/// 1 USDC.
pub const USDC: u128 = 1_000_000;
/// 10^18 base units: one whole token at 18 decimals.
pub const TOKEN: u128 = 1_000_000_000_000_000_000;

pub fn account(id: &str) -> AccountId {
    id.parse().unwrap()
}
pub fn contract_id() -> AccountId {
    account("fairground.testnet")
}
pub fn usdc() -> AccountId {
    account("usdc.testnet")
}
pub fn outlayer() -> AccountId {
    account("outlayer.testnet")
}
pub fn creator() -> AccountId {
    account("creator.testnet")
}
pub fn bidder(n: u32) -> AccountId {
    account(&format!("bidder{n}.testnet"))
}

/// The error of a call that must fail (for results whose Ok type has no Debug).
pub fn err<T>(result: Result<T, crate::Error>) -> crate::Error {
    match result {
        Err(error) => error,
        Ok(_) => panic!("the call succeeded"),
    }
}

/// A context for a call from `predecessor` at `now` with `deposit` attached.
pub fn context(predecessor: &AccountId, now: u64, deposit: u128) -> VMContextBuilder {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(contract_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300));
    ctx
}

pub fn set_call(predecessor: &AccountId, now: u64, deposit: u128) {
    testing_env!(context(predecessor, now, deposit).build());
}

/// A callback from this contract to itself, with `results` as its promise results.
pub fn set_callback(now: u64, results: Vec<PromiseResult>) {
    testing_env!(
        context(&contract_id(), now, 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

pub fn config_args() -> (
    AccountId,
    SealerSource,
    String,
    Option<SecretsRef>,
    Vec<AccountId>,
) {
    (
        outlayer(),
        SealerSource::Project {
            project_id: "fairground.testnet/fairground-sealer".to_owned(),
            version_key: CODE_HASH.to_owned(),
        },
        CODE_HASH.to_owned(),
        Some(SecretsRef {
            profile: "default".to_owned(),
            account_id: account("sealer-owner.testnet"),
        }),
        vec![usdc(), account("usdc2.testnet")],
    )
}

/// A freshly initialised contract on empty storage.
pub fn new_contract() -> Fairground {
    with_mocked_blockchain(|chain| chain.take_storage());
    set_call(&contract_id(), T0, 0);
    let (outlayer, source, hash, secrets, tokens) = config_args();
    Fairground::new(outlayer, source, hash, secrets, tokens).unwrap()
}

pub fn params(sale_id: &str, mode: RevealMode) -> CreateSaleParams {
    CreateSaleParams {
        sale_id: sale_id.to_owned(),
        token_name: "Fair Test".to_owned(),
        token_symbol: "FAIRT".to_owned(),
        decimals: 18,
        icon: None,
        total_supply: U128(1_000_000 * TOKEN),
        sale_supply: U128(600_000 * TOKEN),
        floor_price: U128(1_000),
        max_price: None,
        min_raise: U128(50 * USDC),
        bid_start: U64(BID_START),
        bid_end: U64(BID_END),
        min_deposit: U128(USDC),
        max_deposit_per_account: U128(10_000 * USDC),
        max_bids: 10,
        reveal_mode: mode,
        reveal_window: None,
        settle_timeout: U64(SETTLE_TIMEOUT),
        quote_token: usdc(),
        unsold_rule: None,
        description: None,
        website: None,
    }
}

/// `create_sale` with exactly the cost attached.
pub fn create(contract: &mut Fairground, params: CreateSaleParams) {
    set_call(&creator(), T0, 0);
    let cost = contract.get_create_cost(params.clone()).unwrap().0;
    set_call(&creator(), T0, cost);
    contract.create_sale(params).unwrap();
}

/// Storage in use as NEAR counts it: each record's key and value plus 40
/// bytes. `env::storage_usage()` agrees within one context, but every
/// `testing_env!` resets it. Resets the context (and its logs and receipts).
pub fn storage_bytes() -> u64 {
    let storage = with_mocked_blockchain(|chain| chain.take_storage());
    let bytes = storage
        .iter()
        .map(|(key, value)| (key.len() + value.len() + 40) as u64)
        .sum();
    env::set_blockchain_interface(MockedBlockchain::new(
        context(&contract_id(), T0, 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        storage,
        Default::default(),
        None,
    ));
    bytes
}

/// The sealer's stdout as OutLayer's Text format delivers it: one JSON string.
pub fn text_output(stdout: &str) -> Vec<u8> {
    serde_json::to_vec(stdout).unwrap()
}

pub fn pubkey_output(sale_id: &str) -> Vec<u8> {
    text_output(
        &json!({"v":1,"ok":true,"op":"pubkey","sale_id":sale_id,"pubkey":"11".repeat(32)})
            .to_string(),
    )
}

/// Resolves the token deploy and (TEE) the sealer key successfully.
pub fn finish_setup(contract: &mut Fairground, sale_id: &str, mode: RevealMode) {
    set_callback(T0, vec![PromiseResult::Successful(vec![])]);
    assert!(contract.on_token_deployed(sale_id.to_owned()));
    if mode == RevealMode::Tee {
        set_callback(T0, vec![PromiseResult::Successful(pubkey_output(sale_id))]);
        assert!(contract.on_sealer_key(
            sale_id.to_owned(),
            creator(),
            U128(OUTLAYER_COMPUTE_DEPOSIT)
        ));
    }
}

/// A contract with one sale, set up and ready for bids.
pub fn ready_sale(sale_id: &str, mode: RevealMode) -> Fairground {
    let mut contract = new_contract();
    create(&mut contract, params(sale_id, mode));
    finish_setup(&mut contract, sale_id, mode);
    contract
}

/// A deterministic fake ciphertext of `len` bytes.
pub fn ciphertext(seed: u32, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (seed as usize * 31 + i * 7) as u8)
        .collect()
}

/// The only ciphertext length a TEE sale accepts from `bidder`.
pub fn sealed_len(sale_id: &str, bidder: &AccountId) -> usize {
    fairground_clearing::sealed_bid_len(sale_id.len(), bidder.as_str().len())
}

/// A fake ciphertext of exactly the length a sealed bid of `bidder` in
/// `sale_id` has.
pub fn bid_ciphertext(seed: u32, sale_id: &str, bidder: &AccountId) -> Vec<u8> {
    ciphertext(seed, sealed_len(sale_id, bidder))
}

pub fn tee_msg(sale_id: &str, ciphertext: &[u8]) -> String {
    use near_sdk::base64::Engine as _;
    let encoded = near_sdk::base64::engine::general_purpose::STANDARD.encode(ciphertext);
    json!({"sale_id": sale_id, "ciphertext": encoded}).to_string()
}

pub fn commit_msg(sale_id: &str, commitment: &[u8; 32]) -> String {
    json!({"sale_id": sale_id, "commitment": fairground_clearing::hash::to_hex(commitment)})
        .to_string()
}

/// `ft_on_transfer` from `token` at `now`; returns the amount handed back.
pub fn deliver(
    contract: &mut Fairground,
    token: &AccountId,
    now: u64,
    sender: &AccountId,
    amount: u128,
    msg: &str,
) -> u128 {
    set_call(token, now, 0);
    match contract.ft_on_transfer(sender.clone(), U128(amount), msg.to_owned()) {
        PromiseOrValue::Value(unused) => unused.0,
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer returned a promise"),
    }
}

/// A TEE bid by `bidder(n)` with a ciphertext of the right length during the
/// window; asserts it was accepted.
pub fn place_tee_bid(contract: &mut Fairground, sale_id: &str, n: u32, amount: u128) {
    let msg = tee_msg(sale_id, &bid_ciphertext(n, sale_id, &bidder(n)));
    assert_eq!(
        deliver(contract, &usdc(), BID_START, &bidder(n), amount, &msg),
        0
    );
}

/// Events logged since the last `testing_env!`, as `(event, data)`.
pub fn events() -> Vec<(String, Value)> {
    get_logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .map(|json| {
            let value: Value = serde_json::from_str(json).unwrap();
            assert_eq!(value["standard"], "fairground");
            assert_eq!(value["version"], "1.0.0");
            (
                value["event"].as_str().unwrap().to_owned(),
                value["data"].clone(),
            )
        })
        .collect()
}

/// Data of the only event named `name` since the last `testing_env!`.
pub fn event(name: &str) -> Value {
    let found: Vec<Value> = events()
        .into_iter()
        .filter(|(event, _)| event == name)
        .map(|(_, data)| data)
        .collect();
    assert_eq!(found.len(), 1, "expected one {name} event, got {found:?}");
    found.into_iter().next().unwrap()
}

/// A function call made by the contract.
#[derive(Debug, Clone)]
pub struct Call {
    pub receiver: AccountId,
    pub method: String,
    pub args: Value,
    pub deposit: u128,
    pub gas: Gas,
}

/// Every function call in the receipts created since the last `testing_env!`.
pub fn calls() -> Vec<Call> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in &receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } = action
            {
                out.push(Call {
                    receiver: receipt.receiver_id.clone(),
                    method: String::from_utf8(method_name.clone()).unwrap(),
                    args: serde_json::from_slice(args).unwrap_or(Value::Null),
                    deposit: attached_deposit.as_yoctonear(),
                    gas: *prepaid_gas,
                });
            }
        }
    }
    out
}

pub fn calls_to(method: &str) -> Vec<Call> {
    calls()
        .into_iter()
        .filter(|call| call.method == method)
        .collect()
}

/// Plain NEAR transfers `(receiver, amount)` since the last `testing_env!`
/// (not counting transfers inside a batch that also calls a function).
pub fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .filter(|receipt| {
            receipt
                .actions
                .iter()
                .all(|action| matches!(action, MockAction::Transfer { .. }))
        })
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.clone();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    MockAction::Transfer { deposit, .. } => {
                        Some((receiver.clone(), deposit.as_yoctonear()))
                    }
                    _ => None,
                })
        })
        .collect()
}

/// Every sale view field that can be compared for "nothing changed".
pub fn snapshot(contract: &Fairground, sale_id: &str) -> Value {
    json!({
        "sale": contract.get_sale(sale_id.to_owned()),
        "result": contract.get_result(sale_id.to_owned()),
        "summary": contract.get_bids_summary(sale_id.to_owned()),
    })
}
