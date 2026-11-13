//! Launch liquidity: parameters, the pool's amounts, every step and its
//! failure, the token lock, abandonment and the creator's payouts. Also the
//! OutLayer request block heights.

use near_sdk::Gas;

use super::settlement::{
    CLEARED_AT, TestBid, clearing_sale, closer, ok_text, resolve, sealer_output, three_bids,
};
use super::*;
use crate::claims::reserve_refund;
use crate::costs::{
    ADD_LIQUIDITY_GAS, ADD_SIMPLE_POOL_GAS, DEX_ACCOUNT_DEPOSIT, DEX_POOL_SCAN_GAS,
    DEX_REGISTER_TOKENS_GAS, DEX_STORAGE_DEPOSIT_GAS, DEX_VIEW_GAS, DEX_WITHDRAW_GAS,
    FT_TRANSFER_CALL_GAS, LIQUIDITY_NEAR_RESERVE, LIQUIDITY_RECORD_BYTES, LIQUIDITY_YOCTO,
    LP_STORAGE_DEPOSIT, ON_LIQUIDITY_GAS, ON_POOL_COUNT_GAS, POOL_STORAGE_DEPOSIT,
    STORAGE_DEPOSIT_GAS, TOKEN_STORAGE_DEPOSIT, storage_cost,
};
use crate::liquidity::{Liquidity, POOL_SCAN_LIMIT, STEP_TIMEOUT_BLOCKS, pool_plan, step_gas};
use crate::{Error, LiquidityParams, LiquidityStage, LiquidityStep, Status};

const SALE: &str = "fairt";
const POOL_ID: u64 = 7;
/// A time after settlement, inside the seeding window.
const LATER: u64 = CLEARED_AT + MINUTE;
/// The seeding deadline of a sale cleared at `CLEARED_AT`.
const DEADLINE: u64 = CLEARED_AT + SETTLE_TIMEOUT;

fn token() -> AccountId {
    account("fairt.fairground.testnet")
}

/// 20 % of the raise and 100k of the 1M tokens (sale supply 600k, so the
/// creator keeps 300k), at a 0.3 % fee.
fn terms() -> LiquidityParams {
    LiquidityParams {
        raise_share_bps: 2_000,
        pool_tokens: U128(100_000 * TOKEN),
        fee_bps: 30,
    }
}

fn liquidity_params(terms: LiquidityParams) -> CreateSaleParams {
    let mut p = params(SALE, RevealMode::Tee);
    p.liquidity = Some(terms);
    p
}

/// A TEE sale with launch liquidity, cleared and settled with `bids`.
fn settled_with(terms: LiquidityParams, bids: &[TestBid]) -> Fairground {
    let p = liquidity_params(terms);
    let (mut contract, deposit) = clearing_sale(p.clone(), bids);
    let output = sealer_output(&contract, &p, bids);
    assert_eq!(
        resolve(&mut contract, SALE, deposit, ok_text(&output)),
        "settled"
    );
    contract
}

fn seeding_sale() -> Fairground {
    settled_with(terms(), &three_bids())
}

fn record(contract: &Fairground) -> Liquidity {
    contract.sales.get(SALE).unwrap().liquidity.clone().unwrap()
}

/// The number of the step in flight, which its callback carries.
fn att(contract: &Fairground) -> u32 {
    record(contract).attempt
}

fn view(contract: &Fairground) -> crate::LiquidityView {
    contract.get_result(SALE.into()).unwrap().liquidity.unwrap()
}

fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

fn json_result(value: &Value) -> PromiseResult {
    PromiseResult::Successful(value.to_string().into_bytes())
}

fn amount(value: u128) -> PromiseResult {
    json_result(&json!(value.to_string()))
}

/// The method and status of a callback's return: the next step's callback if
/// it started one (after checking that step's calls were made), else the status.
fn returned(result: PromiseOrValue<String>) -> Option<String> {
    match result {
        PromiseOrValue::Promise(_) => None,
        PromiseOrValue::Value(status) => Some(status),
    }
}

fn seed(contract: &mut Fairground, now: u64) -> Result<PromiseOrValue<String>, Error> {
    set_call(&account("anyone.testnet"), now, 0);
    contract.seed_liquidity(SALE.into())
}

fn abandon(contract: &mut Fairground, now: u64) -> Result<PromiseOrValue<String>, Error> {
    set_call(&account("anyone.testnet"), now, 0);
    contract.abandon_liquidity(SALE.into())
}

fn on_registered(contract: &mut Fairground, sent: [bool; 3], results: Vec<PromiseResult>) {
    set_callback(LATER, results);
    let _ = contract.on_dex_registered(SALE.into(), att(contract), sent[0], sent[1], sent[2]);
}

/// Runs every step with success; returns the plan `(usdc, tokens)`.
fn seed_all(contract: &mut Fairground) -> (u128, u128) {
    let plan = record(contract);
    assert!(matches!(
        seed(contract, LATER),
        Ok(PromiseOrValue::Promise(_))
    ));
    set_callback(LATER, vec![ok(), ok(), ok()]);
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), att(contract), true, true, true)),
        None
    );
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    assert_eq!(
        returned(contract.on_pool_created(SALE.into(), att(contract))),
        None
    );
    set_callback(LATER, vec![amount(plan.tokens), amount(plan.usdc)]);
    assert_eq!(
        returned(contract.on_dex_deposit(
            SALE.into(),
            att(contract),
            U128(plan.tokens),
            U128(plan.usdc)
        )),
        None
    );
    set_callback(LATER, vec![amount(10u128.pow(24))]);
    assert_eq!(
        returned(contract.on_liquidity_added(SALE.into(), att(contract))),
        Some("seeded".into())
    );
    (plan.usdc, plan.tokens)
}

fn claim_proceeds(contract: &mut Fairground) -> Result<bool, Error> {
    set_call(&account("anyone.testnet"), LATER, 0);
    contract
        .claim_proceeds(SALE.into())
        .map(|result| matches!(result, PromiseOrValue::Promise(_)))
}

/// `(raise, allocation, burn, reserve)` the last `claim_proceeds` sent.
fn proceeds_sent() -> (u128, u128, u128, u128) {
    let callback = calls_to("on_proceeds").pop().unwrap();
    let field = |name: &str| {
        callback.args[name]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
    };
    (
        field("raise"),
        field("allocation"),
        field("burn"),
        field("reserve"),
    )
}

#[test]
fn new_refuses_a_dex_that_is_outlayer_or_a_quote_token() {
    let (outlayer, source, hash, secrets, tokens, _) = config_args();
    for dex in [outlayer.clone(), usdc()] {
        with_mocked_blockchain(|chain| chain.take_storage());
        set_call(&contract_id(), T0, 0);
        let result = Fairground::new(
            outlayer.clone(),
            source.clone(),
            hash.clone(),
            secrets.clone(),
            tokens.clone(),
            Some(dex),
        );
        assert!(matches!(result, Err(Error::InvalidConfig(_))));
    }
    // No dex at all is fine: launch liquidity is then off.
    with_mocked_blockchain(|chain| chain.take_storage());
    set_call(&contract_id(), T0, 0);
    let mut contract = Fairground::new(outlayer, source, hash, secrets, tokens, None).unwrap();
    assert_eq!(contract.get_config().dex, None);
    set_call(&creator(), T0, 0);
    assert_eq!(
        contract.get_create_cost(liquidity_params(terms())),
        Err(Error::InvalidParam {
            field: "liquidity",
            rule: "launch liquidity is off: this contract has no dex",
        })
    );
    // A sale without liquidity is unaffected.
    create(&mut contract, params(SALE, RevealMode::Tee));
}

#[test]
fn liquidity_params_are_validated() {
    let mut contract = new_contract();
    let cases: Vec<(LiquidityParams, &str)> = vec![
        (
            LiquidityParams {
                raise_share_bps: 0,
                ..terms()
            },
            "liquidity.raise_share_bps",
        ),
        (
            LiquidityParams {
                raise_share_bps: 5_001,
                ..terms()
            },
            "liquidity.raise_share_bps",
        ),
        (
            LiquidityParams {
                pool_tokens: U128(0),
                ..terms()
            },
            "liquidity.pool_tokens",
        ),
        (
            LiquidityParams {
                // 600k sale + 400k + 1 base unit > 1M.
                pool_tokens: U128(400_000 * TOKEN + 1),
                ..terms()
            },
            "liquidity.pool_tokens",
        ),
        (
            LiquidityParams {
                pool_tokens: U128(u128::MAX),
                ..terms()
            },
            "liquidity.pool_tokens",
        ),
        (
            LiquidityParams {
                fee_bps: 0,
                ..terms()
            },
            "liquidity.fee_bps",
        ),
        (
            LiquidityParams {
                fee_bps: 1_001,
                ..terms()
            },
            "liquidity.fee_bps",
        ),
    ];
    for (terms, field) in cases {
        set_call(&creator(), T0, 0);
        match contract.get_create_cost(liquidity_params(terms)) {
            Err(Error::InvalidParam { field: got, .. }) => assert_eq!(got, field),
            other => panic!("{terms:?}: expected {field} to fail, got {other:?}"),
        }
    }
    // The bounds themselves are allowed: all the rest of the supply, 50 %, 10 %.
    let edge = LiquidityParams {
        raise_share_bps: 5_000,
        pool_tokens: U128(400_000 * TOKEN),
        fee_bps: 1_000,
    };
    create(&mut contract, liquidity_params(edge));
    let sale = contract.get_sale(SALE.into()).unwrap();
    assert_eq!(sale.creator_allocation, U128(0));
    // Unknown fields are refused.
    let mut value = serde_json::to_value(liquidity_params(terms())).unwrap();
    value["liquidity"]["min_price"] = json!("1");
    assert!(serde_json::from_value::<CreateSaleParams>(value).is_err());
}

#[test]
fn create_charges_the_reserve_and_get_sale_shows_the_terms() {
    let mut contract = new_contract();
    set_call(&creator(), T0, 0);
    let without = contract
        .get_create_cost(params(SALE, RevealMode::Tee))
        .unwrap()
        .0;
    let with = contract
        .get_create_cost(liquidity_params(terms()))
        .unwrap()
        .0;
    assert_eq!(
        with - without,
        storage_cost(LIQUIDITY_RECORD_BYTES) + LIQUIDITY_NEAR_RESERVE
    );
    assert_eq!(
        LIQUIDITY_NEAR_RESERVE,
        DEX_ACCOUNT_DEPOSIT
            + 2 * TOKEN_STORAGE_DEPOSIT
            + POOL_STORAGE_DEPOSIT
            + LP_STORAGE_DEPOSIT
            + LIQUIDITY_YOCTO
    );
    create(&mut contract, liquidity_params(terms()));
    // Creating asks nothing of the exchange.
    assert!(calls().iter().all(|call| call.receiver != dex()));
    let sale = contract.get_sale(SALE.into()).unwrap();
    assert_eq!(sale.creator_allocation, U128(300_000 * TOKEN));
    assert_eq!(
        serde_json::to_value(&sale.liquidity).unwrap(),
        json!({
            "dex": "ref-finance-101.testnet",
            "raise_share_bps": 2000,
            "pool_tokens": (100_000 * TOKEN).to_string(),
            "fee_bps": 30,
        })
    );
    let result = contract.get_result(SALE.into()).unwrap();
    assert_eq!(
        serde_json::to_value(result.liquidity).unwrap(),
        json!({
            "status": "waiting", "next_step": null, "in_flight": null,
            "dex": "ref-finance-101.testnet", "pool_id": null,
            "usdc": "0", "tokens": "0", "shares": "0",
            "usdc_on_dex": "0", "tokens_on_dex": "0", "failures": 0, "deadline": null,
        })
    );
    // A sale without liquidity shows none.
    create(&mut contract, params("plain", RevealMode::Tee));
    assert_eq!(contract.get_sale("plain".into()).unwrap().liquidity, None);
    assert_eq!(contract.get_result("plain".into()).unwrap().liquidity, None);
}

#[test]
fn the_pool_price_is_the_clearing_price() {
    // 18 decimals: 100 USDC raised at 0.002 USDC per token, 20 %: 20 USDC
    // buys 10,000 tokens.
    assert_eq!(
        pool_plan(100 * USDC, 2_000, 18, 2_000, u128::MAX),
        (20 * USDC, 10_000 * TOKEN)
    );
    // The reserve caps the tokens and the USDC shrinks to match.
    assert_eq!(
        pool_plan(100 * USDC, 2_000, 18, 2_000, 2_500 * TOKEN),
        (5 * USDC, 2_500 * TOKEN)
    );
    // 0 decimals: whole tokens only; 7 USDC at 3 USDC each buys 2 tokens for 6.
    assert_eq!(
        pool_plan(35 * USDC, 3 * USDC, 0, 2_000, 1_000),
        (6 * USDC, 2)
    );
    // Too little to buy one base unit, or nothing raised: no pool.
    assert_eq!(pool_plan(35 * USDC, 3 * USDC, 0, 1, 1_000), (0, 0));
    assert_eq!(pool_plan(0, 2_000, 18, 5_000, u128::MAX), (0, 0));
    assert_eq!(pool_plan(100 * USDC, 0, 18, 5_000, u128::MAX), (0, 0));

    // Every combination: the pool's price is the clearing price, within one
    // USDC base unit in total and never below it; the USDC stays within its
    // share of the raise and the tokens within the reserve.
    let raises = [
        1,
        999,
        1_000_001,
        123_456_789_012,
        10_000 * 500 * USDC,
        u128::MAX / 3,
    ];
    let prices = [1, 7, 1_000, 999_999, 3 * USDC, 10u128.pow(20)];
    let reserves = [1, 1_000, 10u128.pow(18) + 1, 10u128.pow(30), u128::MAX];
    for decimals in [0u8, 6, 18, 24] {
        let one = 10u128.pow(u32::from(decimals));
        for raise in raises {
            for price in prices {
                for share in [1u16, 2_000, 5_000] {
                    for reserve in reserves {
                        let (usdc, tokens) = pool_plan(raise, price, decimals, share, reserve);
                        if tokens == 0 {
                            assert_eq!(usdc, 0);
                            continue;
                        }
                        let budget = fairground_clearing::math::mul_div_floor(
                            raise,
                            u128::from(share),
                            10_000,
                        )
                        .unwrap();
                        assert!(usdc > 0 && usdc <= budget && tokens <= reserve);
                        // usdc = ceil(tokens * price / one), with 256-bit maths.
                        let floor =
                            fairground_clearing::math::mul_div_floor(tokens, price, one).unwrap();
                        assert!(
                            usdc == floor || usdc == floor + 1,
                            "{raise} {price} {decimals}"
                        );
                        assert_eq!(
                            Some(usdc),
                            fairground_clearing::math::mul_div_ceil(tokens, price, one)
                        );
                        // Below the reserve, one more base unit would not fit the budget.
                        if tokens < reserve {
                            assert!(
                                fairground_clearing::math::mul_div_ceil(tokens + 1, price, one)
                                    .is_none_or(|cost| cost > budget)
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn settlement_fixes_the_plan_and_locks_the_tokens() {
    let mut contract = seeding_sale();
    let result = contract.get_result(SALE.into()).unwrap();
    let liquidity = record(&contract);
    let expected = pool_plan(
        result.total_raised.0,
        result.clearing_price.0,
        18,
        2_000,
        100_000 * TOKEN,
    );
    assert_eq!((liquidity.usdc, liquidity.tokens), expected);
    // 20 % of the raise would buy more than the reserve: the reserve caps
    // the pool and the USDC shrinks to match.
    assert_eq!(liquidity.tokens, 100_000 * TOKEN);
    assert!(liquidity.usdc < result.total_raised.0 / 5);
    assert_eq!(liquidity.stage, LiquidityStage::Seeding);
    assert_eq!(liquidity.deadline, DEADLINE);
    let v = view(&contract);
    assert_eq!(v.status, LiquidityStage::Seeding);
    assert_eq!(v.next_step, Some(LiquidityStep::Register));
    assert_eq!(v.deadline, Some(U64(DEADLINE)));
    // Unsold sale supply plus the reserve the pool does not take.
    assert_eq!(
        result.unsold.0,
        600_000 * TOKEN - result.total_sold.0 + 100_000 * TOKEN - liquidity.tokens
    );

    // A winner gets the unspent USDC now, the tokens later.
    let fill = contract
        .get_fills(SALE.into(), Some(0), Some(1))
        .pop()
        .unwrap();
    assert!(fill.tokens.0 > 0 && fill.refund.0 > 0);
    set_call(&bidder(1), LATER, 0);
    assert!(matches!(
        contract.claim(SALE.into(), None),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert!(calls_to("ft_transfer").iter().all(|c| c.receiver == usdc()));
    set_callback(LATER, vec![ok()]);
    assert!(contract.on_claim(SALE.into(), 0, U128(0), U128(fill.refund.0)));
    set_call(&bidder(1), LATER, 0);
    assert_eq!(
        contract.claim(SALE.into(), None).err(),
        Some(Error::LiquidityPending)
    );

    // The creator gets the raise less the pool's USDC, the unused reserve is
    // burned, the allocation waits.
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, reserve) = proceeds_sent();
    assert_eq!(raise, result.total_raised.0 - liquidity.usdc);
    assert_eq!(allocation, 0);
    assert_eq!(burn, result.unsold.0);
    let sale = contract.sales.get(SALE).unwrap();
    // No part of the liquidity reserve comes back while seeding.
    let mut without_pool = sale.clone();
    without_pool.liquidity = None;
    assert_eq!(reserve, reserve_refund(&without_pool));
    set_callback(LATER, vec![ok(), ok(), ok()]);
    assert!(contract.on_proceeds(SALE.into(), U128(raise), U128(0), U128(burn), U128(reserve)));
    let proceeds = contract.get_result(SALE.into()).unwrap().proceeds;
    assert!(proceeds.raise_paid && !proceeds.allocation_paid && proceeds.reserve_returned);
    // Oversubscribed and the pool takes the whole reserve: nothing to burn.
    assert_eq!(burn, 0);
    assert!(!proceeds.unsold_burned);
    // Only the allocation is left, and it is locked.
    assert_eq!(claim_proceeds(&mut contract), Err(Error::LiquidityPending));
}

#[test]
fn seeding_runs_every_step_and_unlocks_the_tokens() {
    let mut contract = seeding_sale();
    let plan = record(&contract);
    let result = contract.get_result(SALE.into()).unwrap();

    // Step 1: the exchange account (one batch) and its registrations.
    assert!(matches!(
        seed(&mut contract, LATER),
        Ok(PromiseOrValue::Promise(_))
    ));
    let receipts = near_sdk::test_utils::get_created_receipts();
    let batch = receipts.iter().find(|r| r.receiver_id == dex()).unwrap();
    assert_eq!(batch.actions.len(), 2, "one receipt for both calls");
    let storage = calls_to("storage_deposit");
    assert_eq!(storage.len(), 3);
    assert_eq!(storage[0].receiver, dex());
    assert_eq!(storage[0].deposit, DEX_ACCOUNT_DEPOSIT);
    assert_eq!(storage[0].gas, DEX_STORAGE_DEPOSIT_GAS);
    assert_eq!(
        storage[0].args,
        json!({"account_id": "fairground.testnet", "registration_only": false})
    );
    let register = calls_to("register_tokens").pop().unwrap();
    assert_eq!(register.receiver, dex());
    assert_eq!(
        (register.deposit, register.gas),
        (1, DEX_REGISTER_TOKENS_GAS)
    );
    assert_eq!(
        register.args,
        json!({"token_ids": ["fairt.fairground.testnet", "usdc.testnet"]})
    );
    for (call, receiver) in storage[1..].iter().zip([token(), usdc()]) {
        assert_eq!(call.receiver, receiver);
        assert_eq!(call.deposit, TOKEN_STORAGE_DEPOSIT);
        assert_eq!(call.gas, STORAGE_DEPOSIT_GAS);
        assert_eq!(
            call.args,
            json!({"account_id": "ref-finance-101.testnet", "registration_only": true})
        );
    }
    let callback = calls_to("on_dex_registered").pop().unwrap();
    assert_eq!(callback.gas, ON_LIQUIDITY_GAS);
    assert_eq!(
        callback.args,
        json!({"sale_id": SALE, "attempt": 1, "account": true, "on_token": true, "on_quote": true})
    );
    assert_eq!(view(&contract).in_flight, Some(LiquidityStep::Register));

    // Step 2: its callback starts the pool: the exchange's pool count first,
    // then add_simple_pool.
    set_callback(LATER, vec![ok(), ok(), ok()]);
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), att(&contract), true, true, true)),
        None
    );
    let count = calls_to("get_number_of_pools").pop().unwrap();
    assert_eq!(
        (count.receiver, count.deposit, count.gas),
        (dex(), 0, DEX_VIEW_GAS)
    );
    assert_eq!(count.args, json!({}));
    let callback = calls_to("on_pool_count").pop().unwrap();
    assert_eq!(callback.gas, ON_POOL_COUNT_GAS);
    assert_eq!(callback.args, json!({"sale_id": SALE, "attempt": 2}));
    assert!(calls_to("add_simple_pool").is_empty());
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    assert_eq!(
        returned(contract.on_pool_count(SALE.into(), att(&contract))),
        None
    );
    assert_eq!(record(&contract).pool_search, Some(POOL_ID));
    assert_eq!(
        calls_to("on_pool_created").pop().unwrap().args,
        json!({"sale_id": SALE, "attempt": 2})
    );
    let pool = calls_to("add_simple_pool").pop().unwrap();
    assert_eq!(pool.receiver, dex());
    assert_eq!(
        (pool.deposit, pool.gas),
        (POOL_STORAGE_DEPOSIT, ADD_SIMPLE_POOL_GAS)
    );
    assert_eq!(
        pool.args,
        json!({"tokens": ["fairt.fairground.testnet", "usdc.testnet"], "fee": 30})
    );
    assert_eq!(view(&contract).in_flight, Some(LiquidityStep::CreatePool));

    // Step 3: the deposits.
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    assert_eq!(
        returned(contract.on_pool_created(SALE.into(), att(&contract))),
        None
    );
    let deposits = calls_to("ft_transfer_call");
    assert_eq!(deposits.len(), 2);
    for (call, (receiver, amount)) in deposits
        .iter()
        .zip([(token(), plan.tokens), (usdc(), plan.usdc)])
    {
        assert_eq!(call.receiver, receiver);
        assert_eq!((call.deposit, call.gas), (1, FT_TRANSFER_CALL_GAS));
        assert_eq!(
            call.args,
            json!({"receiver_id": "ref-finance-101.testnet", "amount": amount.to_string(), "memo": null, "msg": ""})
        );
    }
    assert_eq!(view(&contract).pool_id, Some(POOL_ID));

    // Step 4: the liquidity, with min_amounts equal to the amounts.
    set_callback(LATER, vec![amount(plan.tokens), amount(plan.usdc)]);
    assert_eq!(
        returned(contract.on_dex_deposit(
            SALE.into(),
            att(&contract),
            U128(plan.tokens),
            U128(plan.usdc)
        )),
        None
    );
    let add = calls_to("add_liquidity").pop().unwrap();
    assert_eq!(add.receiver, dex());
    assert_eq!(
        (add.deposit, add.gas),
        (LP_STORAGE_DEPOSIT, ADD_LIQUIDITY_GAS)
    );
    let amounts = json!([plan.tokens.to_string(), plan.usdc.to_string()]);
    assert_eq!(
        add.args,
        json!({"pool_id": POOL_ID, "amounts": amounts, "min_amounts": amounts})
    );
    let v = view(&contract);
    assert_eq!(
        (v.tokens_on_dex.0, v.usdc_on_dex.0),
        (plan.tokens, plan.usdc)
    );

    let shares = 10u128.pow(24);
    set_callback(LATER, vec![amount(shares)]);
    assert_eq!(
        returned(contract.on_liquidity_added(SALE.into(), att(&contract))),
        Some("seeded".into())
    );
    assert_eq!(
        event("liquidity_seeded"),
        json!({
            "sale_id": SALE, "dex": "ref-finance-101.testnet", "pool_id": POOL_ID,
            "usdc": plan.usdc.to_string(), "tokens": plan.tokens.to_string(),
            "price": result.clearing_price.0.to_string(), "shares": shares.to_string(),
        })
    );
    let v = view(&contract);
    assert_eq!(v.status, LiquidityStage::Seeded);
    assert_eq!(
        (v.shares.0, v.tokens_on_dex.0, v.usdc_on_dex.0),
        (shares, 0, 0)
    );
    assert_eq!((v.next_step, v.in_flight), (None, None));
    assert!(calls().is_empty());

    // Nothing more to do.
    assert_eq!(
        seed(&mut contract, LATER).err(),
        Some(Error::WrongLiquidityStage {
            action: "seed liquidity",
            stage: "seeded"
        })
    );
    assert_eq!(
        abandon(&mut contract, DEADLINE).err(),
        Some(Error::WrongLiquidityStage {
            action: "abandon the launch pool",
            stage: "seeded"
        })
    );

    // Tokens unlock: the winner's tokens and the creator's allocation.
    set_call(&bidder(1), LATER, 0);
    assert!(matches!(
        contract.claim(SALE.into(), None),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert!(
        calls_to("ft_transfer")
            .iter()
            .any(|c| c.receiver == token())
    );
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, reserve) = proceeds_sent();
    assert_eq!(raise, result.total_raised.0 - plan.usdc);
    assert_eq!(allocation, 300_000 * TOKEN);
    assert_eq!(burn, result.unsold.0);
    // Every part of the reserve was spent except the 1 yoctoNEAR deposits
    // that the run did not need, which are counted as spent anyway.
    let sale = contract.sales.get(SALE).unwrap();
    let mut without_pool = sale.clone();
    without_pool.liquidity = None;
    assert_eq!(reserve, reserve_refund(&without_pool));
}

#[test]
fn the_whole_run_fits_one_call_with_300_tgas() {
    // The callbacks receive the call's unused gas, so each starts the next
    // step; the static gas of all four steps fits in 300 TGas.
    let total: u64 = [
        LiquidityStep::Register,
        LiquidityStep::CreatePool,
        LiquidityStep::Deposit,
        LiquidityStep::AddLiquidity,
    ]
    .into_iter()
    .map(|step| step_gas(step).as_gas())
    .sum();
    assert!(Gas::from_gas(total) < Gas::from_tgas(270), "{total}");
    assert_eq!(
        step_gas(LiquidityStep::Withdraw),
        Gas::from_gas(2 * DEX_WITHDRAW_GAS.as_gas() + ON_LIQUIDITY_GAS.as_gas())
    );

    // A callback without the gas for the next step stops; the next call goes on.
    let mut contract = seeding_sale();
    seed(&mut contract, LATER).unwrap().detach();
    let mut ctx = context(&contract_id(), LATER, 0);
    ctx.prepaid_gas(Gas::from_tgas(40));
    testing_env!(
        ctx.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![ok(), ok(), ok()],
    );
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), att(&contract), true, true, true)),
        Some("seeding".into())
    );
    assert!(calls().is_empty());
    let v = view(&contract);
    assert_eq!(
        (v.next_step, v.in_flight),
        (Some(LiquidityStep::CreatePool), None)
    );

    // A call without the gas for its step is refused.
    let mut ctx = context(&account("anyone.testnet"), LATER, 0);
    ctx.prepaid_gas(Gas::from_tgas(30));
    testing_env!(ctx.build());
    assert!(matches!(
        contract.seed_liquidity(SALE.into()),
        Err(Error::NotEnoughGas { .. })
    ));
    seed(&mut contract, LATER).unwrap().detach();
    assert_eq!(calls_to("get_number_of_pools").len(), 1);
}

#[test]
fn a_failed_step_changes_nothing_and_runs_again() {
    let mut contract = seeding_sale();
    let plan = record(&contract);

    // Register: the batch fails, the token registration works, the quote
    // registration fails. The run stops; the next call sends only what failed.
    seed(&mut contract, LATER).unwrap().detach();
    set_callback(
        LATER,
        vec![PromiseResult::Failed, ok(), PromiseResult::Failed],
    );
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), att(&contract), true, true, true)),
        Some("seeding".into())
    );
    assert!(calls().is_empty());
    assert_eq!(
        event("liquidity_step_failed"),
        json!({"sale_id": SALE, "step": "register", "failures": 1})
    );
    let liquidity = record(&contract);
    assert!(!liquidity.dex_account && liquidity.dex_on_token && !liquidity.dex_on_quote);
    assert_eq!(liquidity.in_flight, None);
    seed(&mut contract, LATER).unwrap().detach();
    let storage = calls_to("storage_deposit");
    assert_eq!(
        storage
            .iter()
            .map(|c| c.receiver.clone())
            .collect::<Vec<_>>(),
        vec![dex(), usdc()]
    );
    assert_eq!(
        calls_to("on_dex_registered").pop().unwrap().args,
        json!({"sale_id": SALE, "attempt": 2, "account": true, "on_token": false, "on_quote": true})
    );
    // Results count only the parts sent.
    set_callback(LATER, vec![ok(), ok()]);
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), att(&contract), true, false, true)),
        None
    );
    assert!(record(&contract).registered());

    // The pool: the count fails, then add_simple_pool fails; both run again.
    set_callback(LATER, vec![PromiseResult::Failed]);
    assert_eq!(
        returned(contract.on_pool_count(SALE.into(), att(&contract))),
        Some("seeding".into())
    );
    assert!(calls().is_empty());
    seed(&mut contract, LATER).unwrap().detach();
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    let _ = contract.on_pool_count(SALE.into(), att(&contract));
    set_callback(LATER, vec![PromiseResult::Failed]);
    assert_eq!(
        returned(contract.on_pool_created(SALE.into(), att(&contract))),
        Some("seeding".into())
    );
    seed(&mut contract, LATER).unwrap().detach();
    assert_eq!(record(&contract).pool_search, None);
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    let _ = contract.on_pool_count(SALE.into(), att(&contract));
    // Then add_simple_pool goes through but its answer is not a pool id: the
    // pool is looked for on the exchange at once, never created twice.
    set_callback(
        LATER,
        vec![PromiseResult::Successful(b"\"seven\"".to_vec())],
    );
    assert_eq!(
        returned(contract.on_pool_created(SALE.into(), att(&contract))),
        None
    );
    assert!(calls_to("add_simple_pool").is_empty());
    let scan = calls_to("get_pools").pop().unwrap();
    assert_eq!(
        (scan.receiver, scan.deposit, scan.gas),
        (dex(), 0, DEX_POOL_SCAN_GAS)
    );
    assert_eq!(
        scan.args,
        json!({"from_index": POOL_ID, "limit": POOL_SCAN_LIMIT})
    );
    assert_eq!(
        calls_to("on_dex_reconciled").pop().unwrap().args,
        json!({"sale_id": SALE, "attempt": 6, "pool_id": null, "search": POOL_ID})
    );
    // The page: another pair, the same pair at another fee, the pair the
    // other way round, the pair with liquidity in it, a stable pool of the
    // pair, then the sale's pool.
    let ours = ["fairt.fairground.testnet", "usdc.testnet"];
    let pool = |kind: &str, ids: [&str; 2], fee: u32, shares: &str| {
        json!({
            "pool_kind": kind, "token_account_ids": ids, "amounts": ["0", "0"],
            "total_fee": fee, "shares_total_supply": shares, "amp": 0,
        })
    };
    let page = json!([
        pool("SIMPLE_POOL", ["wrap.testnet", "usdc.testnet"], 30, "0"),
        pool("SIMPLE_POOL", ours, 25, "0"),
        pool(
            "SIMPLE_POOL",
            ["usdc.testnet", "fairt.fairground.testnet"],
            30,
            "0"
        ),
        pool("SIMPLE_POOL", ours, 30, "5"),
        pool("STABLE_SWAP", ours, 30, "0"),
        pool("SIMPLE_POOL", ours, 30, "0"),
    ]);
    set_callback(LATER, vec![on_dex(0, 0), json_result(&page)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 6, None, Some(POOL_ID))),
        None
    );
    assert_eq!(
        event("liquidity_reconciled"),
        json!({
            "sale_id": SALE, "pool_id": POOL_ID + 5, "tokens_on_dex": "0",
            "usdc_on_dex": "0", "shares": "0",
        })
    );
    let liquidity = record(&contract);
    assert_eq!(
        (liquidity.pool_id, liquidity.pool_search, liquidity.unsure),
        (Some(POOL_ID + 5), None, false)
    );
    assert_eq!(calls_to("ft_transfer_call").len(), 2);

    // Deposits: the tokens go in, the USDC call fails; the exchange keeps
    // only part of a later USDC deposit (the token refunded the rest).
    set_callback(LATER, vec![amount(plan.tokens), PromiseResult::Failed]);
    assert_eq!(
        returned(contract.on_dex_deposit(
            SALE.into(),
            att(&contract),
            U128(plan.tokens),
            U128(plan.usdc)
        )),
        Some("seeding".into())
    );
    let v = view(&contract);
    assert_eq!((v.tokens_on_dex.0, v.usdc_on_dex.0), (plan.tokens, 0));
    assert_eq!(v.failures, 4);
    seed(&mut contract, LATER).unwrap().detach();
    let deposits = calls_to("ft_transfer_call");
    assert_eq!(deposits.len(), 1);
    assert_eq!(deposits[0].receiver, usdc());
    assert_eq!(
        calls_to("on_dex_deposit").pop().unwrap().args,
        json!({"sale_id": SALE, "attempt": 8, "tokens": "0", "usdc": plan.usdc.to_string()})
    );
    set_callback(LATER, vec![amount(plan.usdc - 5)]);
    assert_eq!(
        returned(contract.on_dex_deposit(SALE.into(), att(&contract), U128(0), U128(plan.usdc))),
        Some("seeding".into())
    );
    seed(&mut contract, LATER).unwrap().detach();
    assert_eq!(
        calls_to("ft_transfer_call").pop().unwrap().args["amount"],
        json!("5")
    );
    set_callback(LATER, vec![amount(5)]);
    assert_eq!(
        returned(contract.on_dex_deposit(SALE.into(), att(&contract), U128(0), U128(5))),
        None
    );

    // add_liquidity fails: everything stays on the exchange, the next call
    // tries again.
    set_callback(LATER, vec![PromiseResult::Failed]);
    assert_eq!(
        returned(contract.on_liquidity_added(SALE.into(), att(&contract))),
        Some("seeding".into())
    );
    let v = view(&contract);
    assert_eq!(
        (v.status, v.next_step),
        (LiquidityStage::Seeding, Some(LiquidityStep::AddLiquidity))
    );
    assert_eq!(
        (v.tokens_on_dex.0, v.usdc_on_dex.0),
        (plan.tokens, plan.usdc)
    );
    seed(&mut contract, LATER).unwrap().detach();
    // add_liquidity goes through but its share count cannot be read: the
    // pool is not called seeded until the exchange shows the shares.
    set_callback(LATER, vec![PromiseResult::Successful(b"oops".to_vec())]);
    assert_eq!(
        returned(contract.on_liquidity_added(SALE.into(), att(&contract))),
        None
    );
    assert!(events().iter().all(|(name, _)| name != "liquidity_seeded"));
    let v = view(&contract);
    assert_eq!(
        (v.status, v.in_flight),
        (LiquidityStage::Seeding, Some(LiquidityStep::Reconcile))
    );
    assert_eq!(
        calls_to("get_pool_shares").pop().unwrap().args,
        json!({"pool_id": POOL_ID + 5, "account_id": "fairground.testnet"})
    );
    let shares = 10u128.pow(24);
    set_callback(LATER, vec![on_dex(0, 0), amount(shares)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), att(&contract), Some(POOL_ID + 5), None)),
        Some("seeded".into())
    );
    assert_eq!(
        event("liquidity_seeded")["shares"],
        json!(shares.to_string())
    );
    let v = view(&contract);
    assert_eq!(
        (v.shares.0, v.failures, v.pool_id),
        (shares, 6, Some(POOL_ID + 5))
    );
}

#[test]
fn one_step_at_a_time_and_only_before_the_deadline() {
    let mut contract = seeding_sale();
    seed(&mut contract, LATER).unwrap().detach();
    assert_eq!(seed(&mut contract, LATER).err(), Some(Error::LiquidityBusy));
    // Even after the deadline, abandoning waits for the step in flight.
    assert_eq!(
        abandon(&mut contract, DEADLINE).err(),
        Some(Error::LiquidityBusy)
    );
    on_registered(&mut contract, [true, true, true], vec![ok(), ok(), ok()]);
    // The callback started the pool step; let it fail.
    set_callback(LATER, vec![PromiseResult::Failed]);
    let _ = contract.on_pool_created(SALE.into(), att(&contract));

    assert_eq!(
        abandon(&mut contract, DEADLINE - 1).err(),
        Some(Error::TooEarly {
            action: "abandon the launch pool",
            at: DEADLINE
        })
    );
    assert_eq!(
        seed(&mut contract, DEADLINE).err(),
        Some(Error::TooLate {
            action: "seed liquidity",
            at: DEADLINE
        })
    );
    // A callback after the deadline does not start another step.
    let mut c2 = seeding_sale();
    seed(&mut c2, LATER).unwrap().detach();
    set_callback(DEADLINE, vec![ok(), ok(), ok()]);
    assert_eq!(
        returned(c2.on_dex_registered(SALE.into(), att(&c2), true, true, true)),
        Some("seeding".into())
    );
    assert!(calls().is_empty());

    // Sales without liquidity, and stray callbacks.
    let mut plain = new_contract();
    create(&mut plain, params("plain", RevealMode::Tee));
    set_call(&account("anyone.testnet"), LATER, 0);
    assert_eq!(
        plain.seed_liquidity("plain".into()).err(),
        Some(Error::NoLiquidity)
    );
    assert_eq!(
        plain.abandon_liquidity("plain".into()).err(),
        Some(Error::NoLiquidity)
    );
    set_callback(LATER, vec![ok()]);
    assert_eq!(
        returned(plain.on_pool_created("plain".into(), 0)),
        Some("unknown_sale".into())
    );
    // Before settlement there is nothing to seed.
    let mut open = new_contract();
    create(&mut open, liquidity_params(terms()));
    set_call(&account("anyone.testnet"), LATER, 0);
    assert_eq!(
        open.seed_liquidity(SALE.into()).err(),
        Some(Error::WrongLiquidityStage {
            action: "seed liquidity",
            stage: "waiting"
        })
    );
}

#[test]
fn abandoning_unlocks_withdraws_and_pays_the_creator() {
    let mut contract = seeding_sale();
    let plan = record(&contract);
    let result = contract.get_result(SALE.into()).unwrap();
    // Registered, pool created, deposits made; add_liquidity keeps failing.
    seed(&mut contract, LATER).unwrap().detach();
    on_registered(&mut contract, [true, true, true], vec![ok(), ok(), ok()]);
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    let _ = contract.on_pool_created(SALE.into(), att(&contract));
    set_callback(LATER, vec![amount(plan.tokens), amount(plan.usdc)]);
    let _ = contract.on_dex_deposit(
        SALE.into(),
        att(&contract),
        U128(plan.tokens),
        U128(plan.usdc),
    );
    set_callback(LATER, vec![PromiseResult::Failed]);
    let _ = contract.on_liquidity_added(SALE.into(), att(&contract));
    // The creator took the raise less the pool's USDC while seeding.
    assert!(claim_proceeds(&mut contract).unwrap());
    let first = proceeds_sent();
    set_callback(LATER, vec![ok(), ok(), ok()]);
    assert!(contract.on_proceeds(
        SALE.into(),
        U128(first.0),
        U128(first.1),
        U128(first.2),
        U128(first.3)
    ));

    // After the deadline anyone abandons: the tokens unlock at once and both
    // deposits are withdrawn.
    assert!(matches!(
        abandon(&mut contract, DEADLINE),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert_eq!(
        event("liquidity_abandoned"),
        json!({
            "sale_id": SALE, "pool_id": POOL_ID,
            "usdc": plan.usdc.to_string(), "tokens": plan.tokens.to_string(),
            "usdc_on_dex": plan.usdc.to_string(), "tokens_on_dex": plan.tokens.to_string(),
            "failures": 1,
        })
    );
    let withdrawals = calls_to("withdraw");
    assert_eq!(withdrawals.len(), 2);
    for (call, (token_id, amount)) in withdrawals
        .iter()
        .zip([(token(), plan.tokens), (usdc(), plan.usdc)])
    {
        assert_eq!(call.receiver, dex());
        assert_eq!((call.deposit, call.gas), (1, DEX_WITHDRAW_GAS));
        assert_eq!(
            call.args,
            json!({"token_id": token_id, "amount": amount.to_string()})
        );
    }
    assert_eq!(view(&contract).status, LiquidityStage::Abandoned);
    assert_eq!(
        abandon(&mut contract, DEADLINE).err(),
        Some(Error::LiquidityBusy)
    );
    set_call(&bidder(1), DEADLINE, 0);
    assert!(matches!(
        contract.claim(SALE.into(), None),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert!(
        calls_to("ft_transfer")
            .iter()
            .any(|c| c.receiver == token())
    );

    // While the funds are still on the exchange the creator gets the
    // allocation and the NEAR the run did not spend, not the pool's USDC.
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, reserve) = proceeds_sent();
    assert_eq!((raise, burn), (0, 0));
    assert_eq!(allocation, 300_000 * TOKEN);
    assert_eq!(reserve, LP_STORAGE_DEPOSIT);
    set_callback(DEADLINE, vec![ok(), ok()]);
    assert!(contract.on_proceeds(
        SALE.into(),
        U128(0),
        U128(allocation),
        U128(0),
        U128(reserve)
    ));

    // The token withdrawal works; the USDC one fails (the exchange answers 0
    // and credits it again).
    set_callback(DEADLINE, vec![amount(plan.tokens), amount(0)]);
    assert_eq!(
        returned(contract.on_dex_withdraw(
            SALE.into(),
            att(&contract),
            U128(plan.tokens),
            U128(plan.usdc)
        )),
        Some("abandoned".into())
    );
    assert_eq!(
        event("liquidity_withdrawn"),
        json!({"sale_id": SALE, "tokens": plan.tokens.to_string(), "usdc": "0", "failed": ["usdc"]})
    );
    let v = view(&contract);
    assert_eq!((v.tokens_on_dex.0, v.usdc_on_dex.0), (0, plan.usdc));
    assert_eq!(v.next_step, Some(LiquidityStep::Withdraw));
    // The returned tokens are burned now.
    assert!(claim_proceeds(&mut contract).unwrap());
    assert_eq!(proceeds_sent(), (0, 0, plan.tokens, 0));
    set_callback(DEADLINE, vec![ok()]);
    assert!(contract.on_proceeds(SALE.into(), U128(0), U128(0), U128(plan.tokens), U128(0)));

    // A second abandon_liquidity retries the USDC.
    assert!(matches!(
        abandon(&mut contract, DEADLINE + MINUTE),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert_eq!(calls_to("withdraw").len(), 1);
    set_callback(DEADLINE, vec![amount(plan.usdc)]);
    let _ = contract.on_dex_withdraw(SALE.into(), att(&contract), U128(0), U128(plan.usdc));
    assert_eq!(view(&contract).next_step, None);
    assert!(matches!(
        abandon(&mut contract, DEADLINE + MINUTE),
        Ok(PromiseOrValue::Value(_))
    ));

    // Now the pool's USDC goes to the creator, without a second registration.
    assert!(claim_proceeds(&mut contract).unwrap());
    assert_eq!(proceeds_sent(), (plan.usdc, 0, 0, 0));
    assert!(calls_to("storage_deposit").is_empty());
    let transfer = calls_to("ft_transfer").pop().unwrap();
    assert_eq!(transfer.receiver, usdc());
    assert_eq!(transfer.args["receiver_id"], json!("creator.testnet"));
    // A failed payment is owed again.
    set_callback(DEADLINE, vec![PromiseResult::Failed]);
    assert!(!contract.on_proceeds(SALE.into(), U128(plan.usdc), U128(0), U128(0), U128(0)));
    assert!(
        !contract
            .get_result(SALE.into())
            .unwrap()
            .proceeds
            .raise_paid
    );
    assert!(claim_proceeds(&mut contract).unwrap());
    assert_eq!(proceeds_sent(), (plan.usdc, 0, 0, 0));
    set_callback(DEADLINE, vec![ok()]);
    assert!(contract.on_proceeds(SALE.into(), U128(plan.usdc), U128(0), U128(0), U128(0)));

    // In all: the whole raise to the creator, every reserved token that did
    // not reach a pool burned.
    let paid = contract.sales.get(SALE).unwrap().proceeds;
    assert_eq!(paid.raise_paid, result.total_raised.0);
    assert_eq!(
        paid.burned,
        600_000 * TOKEN - result.total_sold.0 + 100_000 * TOKEN
    );
    let proceeds = contract.get_result(SALE.into()).unwrap().proceeds;
    assert!(
        proceeds.raise_paid
            && proceeds.allocation_paid
            && proceeds.unsold_burned
            && proceeds.reserve_returned
    );
    assert_eq!(claim_proceeds(&mut contract), Ok(false));
}

#[test]
fn abandoning_before_any_deposit_returns_the_unspent_reserve() {
    let mut contract = seeding_sale();
    let plan = record(&contract);
    let result = contract.get_result(SALE.into()).unwrap();
    // Nothing ever ran: everything stays in this contract.
    assert!(matches!(
        abandon(&mut contract, DEADLINE),
        Ok(PromiseOrValue::Value(status)) if status == "abandoned"
    ));
    assert!(calls().is_empty());
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, reserve) = proceeds_sent();
    assert_eq!(raise, result.total_raised.0);
    assert_eq!(allocation, 300_000 * TOKEN);
    assert_eq!(burn, result.unsold.0 + plan.tokens);
    let sale = contract.sales.get(SALE).unwrap();
    let mut without_pool = sale.clone();
    without_pool.liquidity = None;
    assert_eq!(
        reserve,
        reserve_refund(&without_pool) + LIQUIDITY_NEAR_RESERVE - LIQUIDITY_YOCTO
    );
    assert_eq!(
        abandon(&mut contract, DEADLINE).map(|r| matches!(r, PromiseOrValue::Value(_))),
        Ok(true)
    );
}

#[test]
fn a_failed_sale_burns_the_reserve() {
    // Below the minimum raise: one small bid.
    let bids = [TestBid {
        n: 1,
        deposit: 10 * USDC,
        price: 2_000,
        spend: 10 * USDC,
    }];
    let p = liquidity_params(terms());
    let (mut contract, deposit) = clearing_sale(p.clone(), &bids);
    let output = sealer_output(&contract, &p, &bids);
    assert_eq!(
        resolve(&mut contract, SALE, deposit, ok_text(&output)),
        "failed"
    );
    assert_eq!(view(&contract).status, LiquidityStage::Cancelled);
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, reserve) = proceeds_sent();
    assert_eq!(raise, 0);
    assert_eq!(allocation, 300_000 * TOKEN);
    assert_eq!(burn, 700_000 * TOKEN);
    let sale = contract.sales.get(SALE).unwrap();
    let mut without_pool = sale.clone();
    without_pool.liquidity = None;
    assert_eq!(
        reserve,
        reserve_refund(&without_pool) + LIQUIDITY_NEAR_RESERVE
    );
    set_call(&account("anyone.testnet"), LATER, 0);
    assert_eq!(
        contract.seed_liquidity(SALE.into()).err(),
        Some(Error::WrongLiquidityStage {
            action: "seed liquidity",
            stage: "cancelled"
        })
    );
    // The bidder's refund is not held back.
    set_call(&bidder(1), LATER, 0);
    assert!(matches!(
        contract.claim(SALE.into(), None),
        Ok(PromiseOrValue::Promise(_))
    ));
}

#[test]
fn a_plan_of_zero_skips_the_pool() {
    // 0 decimals at 3 USDC a token: 1 bps of a 35 USDC raise buys nothing.
    let mut liquidity = Liquidity {
        raise_share_bps: 1,
        pool_tokens: 1_000,
        fee_bps: 30,
        stage: LiquidityStage::Waiting,
        usdc: 0,
        tokens: 0,
        deadline: 0,
        dex_account: false,
        dex_on_token: false,
        dex_on_quote: false,
        pool_id: None,
        tokens_on_dex: 0,
        usdc_on_dex: 0,
        shares: 0,
        in_flight: None,
        failures: 0,
        attempt: 0,
        started_at: 0,
        unsure: false,
        near_lost: 0,
        pool_search: None,
    };
    liquidity.plan(35 * USDC, 3 * USDC, 0, DEADLINE);
    assert_eq!(liquidity.stage, LiquidityStage::Skipped);
    assert_eq!(
        (liquidity.usdc, liquidity.tokens, liquidity.deadline),
        (0, 0, 0)
    );
    assert!(!liquidity.locks_tokens());
    assert_eq!((liquidity.usdc_kept(), liquidity.tokens_kept()), (0, 0));
    assert_eq!(liquidity.near_refund(), LIQUIDITY_NEAR_RESERVE);
    assert_eq!(liquidity.next_step(T0, 0), None);
}

#[test]
fn request_blocks_are_recorded() {
    let at = |height: u64, who: &AccountId, now: u64, deposit: u128| {
        let mut ctx = context(who, now, deposit);
        ctx.block_height(height);
        testing_env!(ctx.build());
    };
    let mut contract = new_contract();
    let p = params(SALE, RevealMode::Tee);
    set_call(&creator(), T0, 0);
    let cost = contract.get_create_cost(p.clone()).unwrap().0;
    at(1_000, &creator(), T0, cost);
    contract.create_sale(p.clone()).unwrap();
    assert_eq!(
        contract.get_sale(SALE.into()).unwrap().key_request_block,
        Some(1_000)
    );
    // A failed key is asked for again: the latest request counts.
    set_callback(T0, vec![PromiseResult::Failed]);
    assert!(!contract.on_sealer_key(SALE.into(), creator(), U128(OUTLAYER_COMPUTE_DEPOSIT)));
    at(1_005, &creator(), T0, OUTLAYER_COMPUTE_DEPOSIT);
    contract.retry_setup(SALE.into()).unwrap();
    assert_eq!(
        contract.get_sale(SALE.into()).unwrap().key_request_block,
        Some(1_005)
    );
    finish_setup(&mut contract, SALE, RevealMode::Tee);
    assert_eq!(
        contract
            .get_result(SALE.into())
            .unwrap()
            .clear_request_block,
        None
    );
    place_tee_bid(&mut contract, SALE, 1, 100 * USDC);
    set_call(&closer(), BID_END, 0);
    let deposit = contract.get_close_deposit(SALE.into()).unwrap().0;
    at(2_000, &closer(), BID_END, deposit);
    contract.close_sale(SALE.into()).unwrap().detach();
    assert_eq!(
        contract
            .get_result(SALE.into())
            .unwrap()
            .clear_request_block,
        Some(2_000)
    );
    // A failed run is retried: the block of the latest request.
    set_callback(CLEARED_AT, vec![PromiseResult::Failed]);
    contract.on_clearing_result(SALE.into(), closer(), U128(deposit));
    at(2_050, &closer(), CLEARED_AT, deposit);
    contract.close_sale(SALE.into()).unwrap().detach();
    let result = contract.get_result(SALE.into()).unwrap();
    assert_eq!(result.clear_request_block, Some(2_050));
    assert_eq!(
        serde_json::to_value(&result).unwrap()["clear_request_block"],
        json!(2_050)
    );

    // Commit-reveal never asks OutLayer.
    let mut contract = new_contract();
    create(&mut contract, params("cr", RevealMode::CommitReveal));
    let sale = contract.get_sale("cr".into()).unwrap();
    assert_eq!(sale.key_request_block, None);
    assert_eq!(
        serde_json::to_value(&sale).unwrap()["key_request_block"],
        Value::Null
    );
}

#[test]
fn views_report_the_status() {
    let mut contract = seeding_sale();
    assert_eq!(
        contract.get_sale(SALE.into()).unwrap().status,
        Status::Settled
    );
    let (usdc, tokens) = seed_all(&mut contract);
    let v = view(&contract);
    assert_eq!(
        serde_json::to_value(&v).unwrap(),
        json!({
            "status": "seeded", "next_step": null, "in_flight": null,
            "dex": "ref-finance-101.testnet", "pool_id": POOL_ID,
            "usdc": usdc.to_string(), "tokens": tokens.to_string(),
            "shares": 10u128.pow(24).to_string(),
            "usdc_on_dex": "0", "tokens_on_dex": "0", "failures": 0,
            "deadline": DEADLINE.to_string(),
        })
    );
}

#[test]
fn the_reserve_the_pool_does_not_take_is_burned() {
    let big = LiquidityParams {
        pool_tokens: U128(400_000 * TOKEN),
        ..terms()
    };
    let mut contract = settled_with(big, &three_bids());
    let result = contract.get_result(SALE.into()).unwrap();
    let liquidity = record(&contract);
    // Not capped: the pool gets its full 20 % of the raise (to the base unit).
    assert!(liquidity.tokens < 400_000 * TOKEN);
    let budget = result.total_raised.0 / 5;
    assert!(budget - liquidity.usdc <= 1);
    let unused = 400_000 * TOKEN - liquidity.tokens;
    assert_eq!(
        result.unsold.0,
        600_000 * TOKEN - result.total_sold.0 + unused
    );
    assert_eq!(
        event("liquidity_planned"),
        json!({
            "sale_id": SALE, "dex": "ref-finance-101.testnet", "stage": "seeding",
            "usdc": liquidity.usdc.to_string(), "tokens": liquidity.tokens.to_string(),
            "price": result.clearing_price.0.to_string(), "unused_tokens": unused.to_string(),
            "deadline": DEADLINE.to_string(),
        })
    );
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, _) = proceeds_sent();
    assert_eq!(raise, result.total_raised.0 - liquidity.usdc);
    assert_eq!((allocation, burn), (0, result.unsold.0));
}

// Lost results. A step's callback receipt can fail (on a bug here, or out of
// gas), and then its result never comes. After `STEP_TIMEOUT_BLOCKS` the next
// call reads the exchange instead (`reconcile`) and carries on from what is
// really there.

/// Block height at which a step started at height 0 counts as lost.
const STALE: u64 = STEP_TIMEOUT_BLOCKS;

fn at_height(predecessor: &AccountId, now: u64, height: u64) -> VMContextBuilder {
    let mut ctx = context(predecessor, now, 0);
    ctx.block_height(height);
    ctx
}

fn seed_at(
    contract: &mut Fairground,
    now: u64,
    height: u64,
) -> Result<PromiseOrValue<String>, Error> {
    testing_env!(at_height(&account("anyone.testnet"), now, height).build());
    contract.seed_liquidity(SALE.into())
}

fn abandon_at(
    contract: &mut Fairground,
    now: u64,
    height: u64,
) -> Result<PromiseOrValue<String>, Error> {
    testing_env!(at_height(&account("anyone.testnet"), now, height).build());
    contract.abandon_liquidity(SALE.into())
}

fn callback_at(now: u64, height: u64, results: Vec<PromiseResult>) {
    testing_env!(
        at_height(&contract_id(), now, height).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

/// `get_deposits` of this contract: the sale token and USDC.
fn on_dex(tokens: u128, usdc: u128) -> PromiseResult {
    json_result(&json!({
        "fairt.fairground.testnet": tokens.to_string(),
        "usdc.testnet": usdc.to_string(),
    }))
}

fn logged(text: &str) -> bool {
    near_sdk::test_utils::get_logs()
        .iter()
        .any(|line| line.contains(text))
}

#[test]
fn a_lost_deposit_result_is_read_from_the_exchange() {
    let mut contract = seeding_sale();
    let plan = record(&contract);
    // Register and pool at height 0; the deposit step starts at height 100
    // and its result never comes.
    seed(&mut contract, LATER).unwrap().detach();
    on_registered(&mut contract, [true, true, true], vec![ok(), ok(), ok()]);
    callback_at(LATER, 100, vec![json_result(&json!(POOL_ID))]);
    let _ = contract.on_pool_created(SALE.into(), att(&contract));
    let lost = att(&contract);
    let liquidity = record(&contract);
    assert_eq!(
        (liquidity.in_flight, liquidity.started_at, lost),
        (Some(LiquidityStep::Deposit), 100, 3)
    );

    // Until the timeout the step counts as running.
    let stale = 100 + STEP_TIMEOUT_BLOCKS;
    assert_eq!(
        seed_at(&mut contract, LATER, stale - 1).err(),
        Some(Error::LiquidityBusy)
    );
    assert_eq!(view(&contract).next_step, None);

    // Then seed_liquidity reads the exchange instead: this contract's
    // deposits and its LP shares, with no deposit and 10 TGas each.
    testing_env!(at_height(&account("anyone.testnet"), LATER, stale).build());
    assert_eq!(view(&contract).next_step, Some(LiquidityStep::Reconcile));
    assert!(matches!(
        seed_at(&mut contract, LATER, stale),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert_eq!(
        event("liquidity_step_lost"),
        json!({"sale_id": SALE, "step": "deposit", "failures": 1})
    );
    let deposits = calls_to("get_deposits").pop().unwrap();
    assert_eq!(
        (deposits.receiver, deposits.deposit, deposits.gas),
        (dex(), 0, DEX_VIEW_GAS)
    );
    assert_eq!(deposits.args, json!({"account_id": "fairground.testnet"}));
    let shares = calls_to("get_pool_shares").pop().unwrap();
    assert_eq!(
        (shares.receiver, shares.deposit, shares.gas),
        (dex(), 0, DEX_VIEW_GAS)
    );
    assert_eq!(
        shares.args,
        json!({"pool_id": POOL_ID, "account_id": "fairground.testnet"})
    );
    let callback = calls_to("on_dex_reconciled").pop().unwrap();
    assert_eq!(callback.gas, ON_LIQUIDITY_GAS);
    assert_eq!(
        callback.args,
        json!({"sale_id": SALE, "attempt": 4, "pool_id": POOL_ID, "search": null})
    );
    assert!(record(&contract).unsure);
    assert_eq!(
        seed_at(&mut contract, LATER, stale).err(),
        Some(Error::LiquidityBusy)
    );

    // The lost result turns up after all: ignored, nothing changes.
    callback_at(LATER, stale, vec![amount(plan.tokens), amount(plan.usdc)]);
    assert_eq!(
        returned(contract.on_dex_deposit(SALE.into(), lost, U128(plan.tokens), U128(plan.usdc))),
        Some("seeding".into())
    );
    assert!(logged("ignored"));
    assert!(calls().is_empty());
    let liquidity = record(&contract);
    assert_eq!(
        (liquidity.tokens_on_dex, liquidity.in_flight),
        (0, Some(LiquidityStep::Reconcile))
    );

    // The exchange holds the tokens and all but 9 units of the USDC: the
    // next deposit sends just those 9.
    callback_at(
        LATER,
        stale,
        vec![on_dex(plan.tokens, plan.usdc - 9), amount(0)],
    );
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 4, Some(POOL_ID), None)),
        None
    );
    assert_eq!(
        event("liquidity_reconciled"),
        json!({
            "sale_id": SALE, "pool_id": POOL_ID, "tokens_on_dex": plan.tokens.to_string(),
            "usdc_on_dex": (plan.usdc - 9).to_string(), "shares": "0",
        })
    );
    assert!(!record(&contract).unsure);
    let deposit = calls_to("ft_transfer_call");
    assert_eq!(deposit.len(), 1);
    assert_eq!(deposit[0].receiver, usdc());
    assert_eq!(deposit[0].args["amount"], json!("9"));
    callback_at(LATER, stale, vec![amount(9)]);
    assert_eq!(
        returned(contract.on_dex_deposit(SALE.into(), att(&contract), U128(0), U128(9))),
        None
    );
    // A result delivered twice is ignored the second time.
    callback_at(LATER, stale, vec![amount(9)]);
    assert_eq!(
        returned(contract.on_dex_deposit(SALE.into(), 5, U128(0), U128(9))),
        Some("seeding".into())
    );
    assert_eq!(record(&contract).usdc_on_dex, plan.usdc);
    callback_at(LATER, stale, vec![amount(10u128.pow(24))]);
    assert_eq!(
        returned(contract.on_liquidity_added(SALE.into(), att(&contract))),
        Some("seeded".into())
    );
    // A lost deposit step sends no NEAR, so none counts as lost.
    let liquidity = record(&contract);
    assert_eq!((liquidity.near_lost, liquidity.failures), (0, 1));
    assert_eq!(liquidity.near_refund(), 0);
}

#[test]
fn a_lost_add_liquidity_that_went_through_counts_as_seeded() {
    let mut contract = seeding_sale();
    let plan = record(&contract);
    let result = contract.get_result(SALE.into()).unwrap();
    // Every step up to add_liquidity, whose result never comes.
    seed(&mut contract, LATER).unwrap().detach();
    on_registered(&mut contract, [true, true, true], vec![ok(), ok(), ok()]);
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    let _ = contract.on_pool_created(SALE.into(), att(&contract));
    set_callback(LATER, vec![amount(plan.tokens), amount(plan.usdc)]);
    let _ = contract.on_dex_deposit(
        SALE.into(),
        att(&contract),
        U128(plan.tokens),
        U128(plan.usdc),
    );
    assert_eq!(
        record(&contract).in_flight,
        Some(LiquidityStep::AddLiquidity)
    );
    let lost = att(&contract);

    // Past the deadline but inside the timeout, nobody can touch it.
    assert_eq!(
        abandon_at(&mut contract, DEADLINE, STALE - 1).err(),
        Some(Error::LiquidityBusy)
    );
    // Then abandoning unlocks the tokens at once and reads the exchange.
    assert!(matches!(
        abandon_at(&mut contract, DEADLINE, STALE),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert_eq!(event("liquidity_step_lost")["step"], json!("add_liquidity"));
    assert_eq!(
        event("liquidity_abandoned")["usdc_on_dex"],
        json!(plan.usdc.to_string())
    );
    let liquidity = record(&contract);
    assert_eq!(liquidity.stage, LiquidityStage::Abandoned);
    assert!(liquidity.unsure && !liquidity.locks_tokens());
    set_call(&bidder(1), DEADLINE, 0);
    assert!(matches!(
        contract.claim(SALE.into(), None),
        Ok(PromiseOrValue::Promise(_))
    ));

    // Until the exchange answers, the creator gets the raise less the pool's
    // share and the allocation, and no pool token is burned; the NEAR refund
    // leaves out the LP deposit.
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, allocation, burn, reserve) = proceeds_sent();
    assert_eq!(raise, result.total_raised.0 - plan.usdc);
    assert_eq!(allocation, 300_000 * TOKEN);
    assert_eq!(burn, result.unsold.0);
    let mut without_pool = contract.sales.get(SALE).unwrap().clone();
    without_pool.liquidity = None;
    assert_eq!(reserve, reserve_refund(&without_pool));

    // The exchange shows the LP shares: add_liquidity went through.
    let shares = 10u128.pow(24);
    callback_at(DEADLINE, STALE, vec![on_dex(0, 0), amount(shares)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), lost + 1, Some(POOL_ID), None)),
        Some("seeded".into())
    );
    assert_eq!(
        event("liquidity_seeded")["shares"],
        json!(shares.to_string())
    );
    let v = view(&contract);
    assert_eq!(
        (v.status, v.shares.0, v.next_step, v.in_flight),
        (LiquidityStage::Seeded, shares, None, None)
    );
    // The payouts already match a seeded pool: nothing is left to pay.
    assert_eq!(claim_proceeds(&mut contract), Ok(false));
    assert_eq!(
        abandon_at(&mut contract, DEADLINE, STALE).err(),
        Some(Error::WrongLiquidityStage {
            action: "abandon the launch pool",
            stage: "seeded"
        })
    );
}

#[test]
fn abandoning_after_a_lost_step_withdraws_what_the_exchange_holds() {
    let mut contract = seeding_sale();
    let plan = record(&contract);
    let result = contract.get_result(SALE.into()).unwrap();
    // The deposit step's result never comes.
    seed(&mut contract, LATER).unwrap().detach();
    on_registered(&mut contract, [true, true, true], vec![ok(), ok(), ok()]);
    set_callback(LATER, vec![json_result(&json!(POOL_ID))]);
    let _ = contract.on_pool_created(SALE.into(), att(&contract));
    assert_eq!(record(&contract).in_flight, Some(LiquidityStep::Deposit));

    assert!(matches!(
        abandon_at(&mut contract, DEADLINE, STALE),
        Ok(PromiseOrValue::Promise(_))
    ));
    let read = att(&contract);
    // While the exchange is read, the pool's whole share stays held.
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, _, burn, _) = proceeds_sent();
    assert_eq!(
        (raise, burn),
        (result.total_raised.0 - plan.usdc, result.unsold.0)
    );

    // The tokens reached the exchange, the USDC did not: only the tokens
    // are withdrawn.
    callback_at(DEADLINE, STALE, vec![on_dex(plan.tokens, 0), amount(0)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), read, Some(POOL_ID), None)),
        None
    );
    let withdrawals = calls_to("withdraw");
    assert_eq!(withdrawals.len(), 1);
    assert_eq!(
        withdrawals[0].args,
        json!({"token_id": "fairt.fairground.testnet", "amount": plan.tokens.to_string()})
    );
    // The pool's USDC never left: the creator gets it now.
    assert!(claim_proceeds(&mut contract).unwrap());
    let (raise, _, burn, reserve) = proceeds_sent();
    assert_eq!((raise, burn, reserve), (plan.usdc, 0, LP_STORAGE_DEPOSIT));

    // The withdrawal's result is lost too; a later abandon_liquidity reads
    // the exchange again, which shows the tokens came back.
    let withdraw = att(&contract);
    let later = STALE + STEP_TIMEOUT_BLOCKS;
    assert_eq!(
        abandon_at(&mut contract, DEADLINE, later - 1).err(),
        Some(Error::LiquidityBusy)
    );
    assert!(matches!(
        abandon_at(&mut contract, DEADLINE, later),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert_eq!(event("liquidity_step_lost")["step"], json!("withdraw"));
    assert!(
        events()
            .iter()
            .all(|(name, _)| name != "liquidity_abandoned")
    );
    // Meanwhile nothing more is paid or burned.
    assert_eq!(claim_proceeds(&mut contract), Ok(false));
    callback_at(DEADLINE, later, vec![on_dex(0, 0), amount(0)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), withdraw + 1, Some(POOL_ID), None)),
        Some("abandoned".into())
    );
    // The late withdraw result is ignored.
    callback_at(DEADLINE, later, vec![amount(plan.tokens)]);
    assert_eq!(
        returned(contract.on_dex_withdraw(SALE.into(), withdraw, U128(plan.tokens), U128(0))),
        Some("abandoned".into())
    );
    assert!(events().is_empty());
    // Now the returned tokens are burned, and the books close.
    assert!(claim_proceeds(&mut contract).unwrap());
    assert_eq!(proceeds_sent(), (0, 0, plan.tokens, 0));
    let paid = contract.sales.get(SALE).unwrap().proceeds;
    assert_eq!(paid.raise_paid, result.total_raised.0);
    assert_eq!(
        paid.burned,
        600_000 * TOKEN - result.total_sold.0 + 100_000 * TOKEN
    );
    assert_eq!(
        abandon_at(&mut contract, DEADLINE, later)
            .ok()
            .and_then(returned),
        Some("abandoned".into())
    );
}

#[test]
fn a_failed_read_runs_again_and_a_lost_register_step_reruns() {
    let mut contract = seeding_sale();
    // The register step's result never comes.
    seed(&mut contract, LATER).unwrap().detach();
    seed_at(&mut contract, LATER, STALE).unwrap().detach();
    // No pool yet: only the deposits are read.
    assert!(calls_to("get_pool_shares").is_empty());
    assert_eq!(
        calls_to("on_dex_reconciled").pop().unwrap().args,
        json!({"sale_id": SALE, "attempt": 2, "pool_id": null, "search": null})
    );
    // Its NEAR may be gone: it no longer counts as refundable.
    let lost_near = DEX_ACCOUNT_DEPOSIT + 2 * TOKEN_STORAGE_DEPOSIT;
    assert_eq!(record(&contract).near_lost, lost_near);

    // The read fails, then answers something that is not a balance map:
    // each time the run stops and the next call reads again.
    callback_at(LATER, STALE, vec![PromiseResult::Failed]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 2, None, None)),
        Some("seeding".into())
    );
    assert_eq!(
        event("liquidity_step_failed"),
        json!({"sale_id": SALE, "step": "reconcile", "failures": 2})
    );
    let v = view(&contract);
    assert_eq!(
        (v.next_step, v.in_flight),
        (Some(LiquidityStep::Reconcile), None)
    );
    seed_at(&mut contract, LATER, STALE).unwrap().detach();
    assert!(
        events()
            .iter()
            .all(|(name, _)| name != "liquidity_step_lost")
    );
    callback_at(
        LATER,
        STALE,
        vec![PromiseResult::Successful(b"[1, 2]".to_vec())],
    );
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 3, None, None)),
        Some("seeding".into())
    );
    assert!(record(&contract).unsure);
    seed_at(&mut contract, LATER, STALE).unwrap().detach();

    // The exchange has no account for this contract (an empty map): the
    // register step runs again, all of it.
    callback_at(LATER, STALE, vec![json_result(&json!({}))]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 4, None, None)),
        None
    );
    assert_eq!(calls_to("storage_deposit").len(), 3);
    assert_eq!(record(&contract).in_flight, Some(LiquidityStep::Register));
    // The first register step's result, very late: ignored.
    callback_at(LATER, STALE, vec![ok(), ok(), ok()]);
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), 1, true, true, true)),
        Some("seeding".into())
    );
    assert!(!record(&contract).dex_account);
    // The rerun works; the pool step fails, and the deadline passes.
    callback_at(LATER, STALE, vec![ok(), ok(), ok()]);
    assert_eq!(
        returned(contract.on_dex_registered(SALE.into(), 5, true, true, true)),
        None
    );
    callback_at(LATER, STALE, vec![PromiseResult::Failed]);
    let _ = contract.on_pool_created(SALE.into(), 6);
    assert!(matches!(
        abandon_at(&mut contract, DEADLINE, STALE),
        Ok(PromiseOrValue::Value(status)) if status == "abandoned"
    ));
    // The creator gets back the pool and LP deposits less the lost NEAR.
    let liquidity = record(&contract);
    assert_eq!((liquidity.failures, liquidity.attempt), (4, 6));
    assert_eq!(
        liquidity.near_refund(),
        POOL_STORAGE_DEPOSIT + LP_STORAGE_DEPOSIT - lost_near
    );
}

/// A `get_pools` entry.
fn pool_info(ids: [&str; 2], fee: u32, shares: &str) -> Value {
    json!({
        "pool_kind": "SIMPLE_POOL", "token_account_ids": ids, "amounts": ["0", "0"],
        "total_fee": fee, "shares_total_supply": shares, "amp": 0,
    })
}

/// Registered, then the pool step counted 40 pools and sent
/// `add_simple_pool`, whose result never comes (the step started at `STALE`).
fn pool_result_lost(contract: &mut Fairground) {
    seed(contract, LATER).unwrap().detach();
    on_registered(contract, [true, true, true], vec![ok(), ok(), ok()]);
    // First the count's own result is lost: add_simple_pool was never sent,
    // so after the read the pool step simply runs again.
    seed_at(contract, LATER, STALE).unwrap().detach();
    assert_eq!(event("liquidity_step_lost")["step"], json!("create_pool"));
    assert!(calls_to("get_pools").is_empty());
    callback_at(LATER, STALE, vec![on_dex(0, 0)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 3, None, None)),
        None
    );
    assert_eq!(calls_to("get_number_of_pools").len(), 1);
    callback_at(LATER, STALE, vec![json_result(&json!(40))]);
    let _ = contract.on_pool_count(SALE.into(), 4);
    assert_eq!(calls_to("add_simple_pool").len(), 1);
    let liquidity = record(contract);
    assert_eq!(
        (
            liquidity.pool_search,
            liquidity.started_at,
            liquidity.near_lost
        ),
        (Some(40), STALE, 0)
    );
}

#[test]
fn a_lost_pool_result_is_found_on_the_exchange() {
    let mut contract = seeding_sale();
    pool_result_lost(&mut contract);
    // The exchange is read from pool 40 on, 20 pools at a time.
    seed_at(&mut contract, LATER, 2 * STALE).unwrap().detach();
    assert_eq!(
        calls_to("get_pools").pop().unwrap().args,
        json!({"from_index": 40, "limit": 20})
    );
    // A full page without the pool: the next read goes on from 60, in the
    // same run while the gas lasts.
    let other = pool_info(["wrap.testnet", "usdc.testnet"], 30, "7");
    let full = json!(vec![other.clone(); 20]);
    callback_at(LATER, 2 * STALE, vec![on_dex(0, 0), json_result(&full)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 5, None, Some(40))),
        None
    );
    let liquidity = record(&contract);
    assert_eq!(
        (liquidity.pool_search, liquidity.unsure, liquidity.in_flight),
        (Some(60), true, Some(LiquidityStep::Reconcile))
    );
    assert_eq!(
        calls_to("get_pools").pop().unwrap().args,
        json!({"from_index": 60, "limit": 20})
    );
    assert!(
        events()
            .iter()
            .all(|(name, _)| name != "liquidity_step_lost")
    );
    // The next page has it, third: it becomes the sale's pool, and the run
    // goes on to the deposits without asking for a second pool.
    let ours = pool_info(["fairt.fairground.testnet", "usdc.testnet"], 30, "0");
    let page = json!([other.clone(), other, ours]);
    callback_at(LATER, 2 * STALE, vec![on_dex(0, 0), json_result(&page)]);
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 6, None, Some(60))),
        None
    );
    let liquidity = record(&contract);
    assert_eq!(
        (liquidity.pool_id, liquidity.pool_search, liquidity.unsure),
        (Some(62), None, false)
    );
    assert!(calls_to("add_simple_pool").is_empty());
    assert_eq!(calls_to("ft_transfer_call").len(), 2);
    // The late add_simple_pool result is ignored.
    callback_at(LATER, 2 * STALE, vec![json_result(&json!(62))]);
    assert_eq!(
        returned(contract.on_pool_created(SALE.into(), 4)),
        Some("seeding".into())
    );
    assert_eq!(record(&contract).in_flight, Some(LiquidityStep::Deposit));
}

#[test]
fn a_lost_pool_result_without_a_pool_creates_it_again() {
    let mut contract = seeding_sale();
    pool_result_lost(&mut contract);
    seed_at(&mut contract, LATER, 2 * STALE).unwrap().detach();
    // An unreadable page is a failed read: run again.
    callback_at(
        LATER,
        2 * STALE,
        vec![on_dex(0, 0), PromiseResult::Successful(b"{}".to_vec())],
    );
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 5, None, Some(40))),
        Some("seeding".into())
    );
    assert_eq!(event("liquidity_step_failed")["step"], json!("reconcile"));
    assert_eq!(record(&contract).pool_search, Some(40));
    seed_at(&mut contract, LATER, 2 * STALE).unwrap().detach();
    // A short page without the pool (the same pair with liquidity in it is
    // not the sale's): add_simple_pool failed, so the pool step runs again.
    let ours_full = pool_info(["fairt.fairground.testnet", "usdc.testnet"], 30, "1");
    callback_at(
        LATER,
        2 * STALE,
        vec![on_dex(0, 0), json_result(&json!([ours_full]))],
    );
    assert_eq!(
        returned(contract.on_dex_reconciled(SALE.into(), 6, None, Some(40))),
        None
    );
    let liquidity = record(&contract);
    assert_eq!(
        (
            liquidity.pool_id,
            liquidity.pool_search,
            liquidity.in_flight
        ),
        (None, None, Some(LiquidityStep::CreatePool))
    );
    assert_eq!(calls_to("get_number_of_pools").len(), 1);
}
