//! `claim` and `claim_proceeds`: what is sent, restore on failure, no double pay.

use super::settlement::{CLEARED_AT, clearing_sale, resolve, settled_sale, three_bids};
use super::*;
use crate::claims::reserve_refund;
use crate::costs::{TOKEN_STORAGE_DEPOSIT, per_bid_reserve, token_deploy_balance};
use crate::{Error, Status};

const LATER: u64 = CLEARED_AT + MINUTE;

fn token() -> AccountId {
    account("fairt.fairground.testnet")
}

/// Claims for `who` (pushed by `caller`); returns whether a promise was made.
fn claim(contract: &mut Fairground, caller: &AccountId, who: Option<AccountId>) -> bool {
    set_call(caller, LATER, 0);
    match contract.claim("fairt".into(), who).unwrap() {
        PromiseOrValue::Promise(_) => true,
        PromiseOrValue::Value(sent) => {
            assert!(!sent);
            false
        }
    }
}

fn on_claim(
    contract: &mut Fairground,
    index: u32,
    tokens: u128,
    refund: u128,
    results: Vec<PromiseResult>,
) -> bool {
    set_callback(LATER, results);
    contract.on_claim("fairt".into(), index, U128(tokens), U128(refund))
}

fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

#[test]
fn a_winner_gets_tokens_and_unspent_usdc() {
    let (mut contract, _) = settled_sale();
    let fill = contract
        .get_fills("fairt".into(), Some(0), Some(1))
        .pop()
        .unwrap();
    assert!(fill.tokens.0 > 0 && fill.refund.0 > 0);
    assert!(claim(&mut contract, &bidder(1), None));

    let register = calls_to("storage_deposit").pop().unwrap();
    assert_eq!(register.receiver, token());
    assert_eq!(register.deposit, TOKEN_STORAGE_DEPOSIT);
    assert_eq!(
        register.args,
        json!({"account_id": "bidder1.testnet", "registration_only": true})
    );
    let transfers = calls_to("ft_transfer");
    assert_eq!(transfers.len(), 2);
    assert_eq!(transfers[0].receiver, token());
    assert_eq!(transfers[0].deposit, 1);
    assert_eq!(transfers[0].args["receiver_id"], json!("bidder1.testnet"));
    assert_eq!(
        transfers[0].args["amount"],
        json!(fill.tokens.0.to_string())
    );
    assert_eq!(transfers[1].receiver, usdc());
    assert_eq!(transfers[1].deposit, 1);
    assert_eq!(
        transfers[1].args["amount"],
        json!(fill.refund.0.to_string())
    );
    let callback = calls_to("on_claim").pop().unwrap();
    assert_eq!(
        callback.args,
        json!({"sale_id": "fairt", "index": 0, "tokens": fill.tokens.0.to_string(), "refund": fill.refund.0.to_string()})
    );

    // Marked before the callback: a second claim sends nothing.
    assert!(!claim(&mut contract, &bidder(1), None));
    assert!(calls().is_empty());

    assert!(on_claim(
        &mut contract,
        0,
        fill.tokens.0,
        fill.refund.0,
        vec![ok(), ok()]
    ));
    let claimed = event("claimed");
    assert_eq!(claimed["tokens"], json!(fill.tokens.0.to_string()));
    assert_eq!(claimed["failed"], json!([]));
    assert!(contract.get_bid("fairt".into(), bidder(1)).unwrap().claimed);
    assert!(!claim(&mut contract, &bidder(1), None));
}

#[test]
fn a_failed_part_can_be_claimed_again() {
    let (mut contract, _) = settled_sale();
    let fill = contract
        .get_fills("fairt".into(), Some(0), Some(1))
        .pop()
        .unwrap();
    assert!(claim(&mut contract, &bidder(1), None));
    // The token transfer failed (say the bidder could not be registered).
    assert!(!on_claim(
        &mut contract,
        0,
        fill.tokens.0,
        fill.refund.0,
        vec![PromiseResult::Failed, ok()]
    ));
    let claimed = event("claimed");
    assert_eq!(claimed["tokens"], json!("0"));
    assert_eq!(claimed["refund"], json!(fill.refund.0.to_string()));
    assert_eq!(claimed["failed"], json!(["tokens"]));
    assert!(!contract.get_bid("fairt".into(), bidder(1)).unwrap().claimed);

    // Only the tokens are sent again.
    assert!(claim(&mut contract, &bidder(1), None));
    assert_eq!(calls_to("ft_transfer").len(), 1);
    assert_eq!(calls_to("ft_transfer")[0].receiver, token());
    assert_eq!(
        calls_to("on_claim")[0].args,
        json!({"sale_id": "fairt", "index": 0, "tokens": fill.tokens.0.to_string(), "refund": "0"})
    );
    assert!(on_claim(&mut contract, 0, fill.tokens.0, 0, vec![ok()]));
    assert!(contract.get_bid("fairt".into(), bidder(1)).unwrap().claimed);

    // The refund fails on its own (a single result, at index 0).
    let refund = contract
        .get_fills("fairt".into(), Some(2), Some(1))
        .pop()
        .unwrap()
        .refund
        .0;
    assert!(claim(&mut contract, &bidder(3), None));
    assert!(!on_claim(
        &mut contract,
        2,
        0,
        refund,
        vec![PromiseResult::Failed]
    ));
    assert!(claim(&mut contract, &bidder(3), None));
    assert_eq!(
        calls_to("ft_transfer")[0].args["amount"],
        json!(refund.to_string())
    );
}

#[test]
fn a_loser_gets_its_deposit_and_anyone_can_push_it() {
    let (mut contract, _) = settled_sale();
    let fill = contract
        .get_fills("fairt".into(), Some(2), Some(1))
        .pop()
        .unwrap();
    assert_eq!(fill.tokens, U128(0));
    assert_eq!(fill.refund, U128(200 * USDC));
    assert!(claim(
        &mut contract,
        &account("anyone.testnet"),
        Some(bidder(3))
    ));
    assert!(calls_to("storage_deposit").is_empty());
    let transfer = calls_to("ft_transfer").pop().unwrap();
    assert_eq!(transfer.receiver, usdc());
    assert_eq!(transfer.args["receiver_id"], json!("bidder3.testnet"));
    assert_eq!(transfer.args["amount"], json!((200 * USDC).to_string()));
}

#[test]
fn claims_need_a_final_sale_and_a_bid() {
    let (mut contract, _) = clearing_sale(params("fairt", RevealMode::Tee), &three_bids());
    set_call(&bidder(1), LATER, 0);
    assert_eq!(
        err(contract.claim("fairt".into(), None)),
        Error::WrongPhase {
            action: "claim",
            status: "clearing"
        }
    );
    assert_eq!(
        err(contract.claim_proceeds("fairt".into())),
        Error::WrongPhase {
            action: "claim proceeds",
            status: "clearing"
        }
    );
    let (mut contract, _) = settled_sale();
    set_call(&bidder(7), LATER, 0);
    assert_eq!(err(contract.claim("fairt".into(), None)), Error::NoBid);
    assert_eq!(err(contract.claim("nope".into(), None)), Error::UnknownSale);
}

#[test]
fn a_failed_sale_refunds_every_deposit() {
    let (mut contract, deposit) = clearing_sale(params("fairt", RevealMode::Tee), &three_bids());
    resolve(
        &mut contract,
        "fairt",
        deposit,
        PromiseResult::Successful(text_output("garbage")),
    );
    assert_eq!(
        contract.get_result("fairt".into()).unwrap().status,
        Status::Failed
    );
    for (i, bid) in three_bids().iter().enumerate() {
        assert!(claim(&mut contract, &bidder(bid.n), None));
        assert!(calls_to("storage_deposit").is_empty());
        let transfer = calls_to("ft_transfer").pop().unwrap();
        assert_eq!(transfer.receiver, usdc());
        assert_eq!(transfer.args["amount"], json!(bid.deposit.to_string()));
        assert!(on_claim(
            &mut contract,
            i as u32,
            0,
            bid.deposit,
            vec![ok()]
        ));
        assert!(!claim(&mut contract, &bidder(bid.n), None));
    }
}

fn claim_proceeds(contract: &mut Fairground) -> bool {
    set_call(&account("anyone.testnet"), LATER, 0);
    match contract.claim_proceeds("fairt".into()).unwrap() {
        PromiseOrValue::Promise(_) => true,
        PromiseOrValue::Value(sent) => {
            assert!(!sent);
            false
        }
    }
}

fn on_proceeds(contract: &mut Fairground, parts: [u128; 4], results: Vec<PromiseResult>) -> bool {
    set_callback(LATER, results);
    let [raise, allocation, burn, reserve] = parts.map(U128);
    contract.on_proceeds("fairt".into(), raise, allocation, burn, reserve)
}

#[test]
fn the_creator_gets_the_raise_allocation_and_reserve() {
    let (mut contract, _) = settled_sale();
    let result = contract.get_result("fairt".into()).unwrap();
    let raise = result.total_raised.0;
    let allocation = 400_000 * TOKEN;
    // 7 unused slots, plus the loser's token registration.
    let reserve = 7 * per_bid_reserve(RevealMode::Tee) + TOKEN_STORAGE_DEPOSIT;
    assert_eq!(contract.get_reserve_refund("fairt".into()), U128(reserve));
    assert_eq!(result.unsold, U128(0));

    assert!(claim_proceeds(&mut contract));
    let transfers_out = calls_to("ft_transfer");
    assert_eq!(transfers_out[0].receiver, usdc());
    assert_eq!(
        transfers_out[0].args["receiver_id"],
        json!("creator.testnet")
    );
    assert_eq!(transfers_out[0].args["amount"], json!(raise.to_string()));
    assert_eq!(transfers_out[1].receiver, token());
    assert_eq!(
        transfers_out[1].args["amount"],
        json!(allocation.to_string())
    );
    // The creator is registered on the quote token and on the sale token first.
    let registrations: Vec<(AccountId, Value)> = calls_to("storage_deposit")
        .into_iter()
        .map(|call| (call.receiver, call.args))
        .collect();
    let creator_registration = json!({"account_id": "creator.testnet", "registration_only": true});
    assert_eq!(
        registrations,
        vec![
            (usdc(), creator_registration.clone()),
            (token(), creator_registration)
        ]
    );
    // Everything sold: nothing to burn.
    assert!(calls_to("burn").is_empty());
    assert_eq!(transfers(), vec![(creator(), reserve)]);
    assert_eq!(
        calls_to("on_proceeds").pop().unwrap().args,
        json!({"sale_id": "fairt", "raise": raise.to_string(), "allocation": allocation.to_string(),
               "burn": "0", "reserve": reserve.to_string()})
    );
    // A second call before the callback sends nothing.
    assert!(!claim_proceeds(&mut contract));

    // The allocation failed: only it is sent again.
    assert!(!on_proceeds(
        &mut contract,
        [raise, allocation, 0, reserve],
        vec![ok(), PromiseResult::Failed, ok()]
    ));
    assert_eq!(event("proceeds_claimed")["failed"], json!(["allocation"]));
    let proceeds = contract.get_result("fairt".into()).unwrap().proceeds;
    assert!(proceeds.raise_paid && !proceeds.allocation_paid && proceeds.reserve_returned);
    assert!(claim_proceeds(&mut contract));
    assert_eq!(calls_to("ft_transfer").len(), 1);
    assert!(transfers().is_empty());
    assert!(on_proceeds(
        &mut contract,
        [0, allocation, 0, 0],
        vec![ok()]
    ));
    assert!(!claim_proceeds(&mut contract));
    assert_eq!(contract.get_reserve_refund("fairt".into()), U128(0));
}

#[test]
fn unsold_tokens_are_burned() {
    // Undersubscribed: one small bid at the floor.
    let p = params("fairt", RevealMode::Tee);
    let bids = [super::settlement::TestBid {
        n: 1,
        deposit: 100 * USDC,
        price: 1_000,
        spend: 100 * USDC,
    }];
    let (mut contract, deposit) = clearing_sale(p.clone(), &bids);
    let output = super::settlement::sealer_output(&contract, &p, &bids);
    resolve(
        &mut contract,
        "fairt",
        deposit,
        super::settlement::ok_text(&output),
    );
    let result = contract.get_result("fairt".into()).unwrap();
    assert_eq!(result.status, Status::Settled);
    assert_eq!(result.total_sold, U128(100_000 * TOKEN));
    assert_eq!(result.unsold, U128(500_000 * TOKEN));

    assert!(claim_proceeds(&mut contract));
    let burn = calls_to("burn").pop().unwrap();
    assert_eq!(burn.receiver, token());
    assert_eq!(burn.deposit, 1);
    assert_eq!(burn.args, json!({"amount": (500_000 * TOKEN).to_string()}));
    let raise = result.total_raised.0;
    let reserve = 9 * per_bid_reserve(RevealMode::Tee);
    // Burn failed: only the burn is retried.
    assert!(!on_proceeds(
        &mut contract,
        [raise, 400_000 * TOKEN, 500_000 * TOKEN, reserve],
        vec![ok(), ok(), PromiseResult::Failed, ok()]
    ));
    assert!(claim_proceeds(&mut contract));
    assert_eq!(
        calls()
            .iter()
            .map(|c| c.method.as_str())
            .collect::<Vec<_>>(),
        ["burn", "on_proceeds"]
    );
}

#[test]
fn a_sale_that_never_set_up_returns_all_its_near() {
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    set_callback(T0, vec![PromiseResult::Failed]);
    contract.on_token_deployed("fairt".into());
    set_call(&bidder(1), BID_END + SETTLE_TIMEOUT, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();

    let meta_len = "Fair Test".len() + "FAIRT".len();
    // Neither creator registration is needed.
    let expected = 10 * per_bid_reserve(RevealMode::Tee)
        + 2 * TOKEN_STORAGE_DEPOSIT
        + token_deploy_balance(meta_len);
    assert_eq!(contract.get_reserve_refund("fairt".into()), U128(expected));
    // No token exists, so nothing is (or will be) burned.
    assert_eq!(contract.get_result("fairt".into()).unwrap().unsold, U128(0));
    assert!(claim_proceeds(&mut contract));
    // No token: nothing to transfer or burn.
    assert!(calls_to("ft_transfer").is_empty() && calls_to("burn").is_empty());
    assert_eq!(transfers(), vec![(creator(), expected)]);
}

#[test]
fn proceeds_wait_for_a_token_deploy_in_flight() {
    let mut contract = new_contract();
    create(&mut contract, params("fairt", RevealMode::Tee));
    set_call(&bidder(1), BID_END + SETTLE_TIMEOUT, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();
    assert_eq!(contract.get_reserve_refund("fairt".into()), U128(0));
    assert_eq!(contract.get_result("fairt".into()).unwrap().unsold, U128(0));
    assert!(!claim_proceeds(&mut contract));

    // The deploy lands after all: allocation and the whole sale supply burn.
    set_callback(LATER, vec![PromiseResult::Successful(vec![])]);
    assert!(contract.on_token_deployed("fairt".into()));
    assert_eq!(
        contract.get_result("fairt".into()).unwrap().unsold,
        U128(600_000 * TOKEN)
    );
    assert_eq!(
        contract.get_sale("fairt".into()).unwrap().status,
        Status::Failed
    );
    let sale = contract.sales.get("fairt").unwrap().clone();
    // No raise: the creator's quote-token registration comes back.
    assert_eq!(
        reserve_refund(&sale),
        10 * per_bid_reserve(RevealMode::Tee) + TOKEN_STORAGE_DEPOSIT
    );
    assert!(claim_proceeds(&mut contract));
    assert_eq!(
        calls_to("burn").pop().unwrap().args["amount"],
        json!((600_000 * TOKEN).to_string())
    );
    assert_eq!(
        calls_to("ft_transfer").pop().unwrap().args["amount"],
        json!((400_000 * TOKEN).to_string())
    );
}
