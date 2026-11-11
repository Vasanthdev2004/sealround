//! Commit-reveal: reveal window, `reveal_bid`, `clear_onchain` and the
//! unrevealed-bid penalty.

use fairground_clearing::hash::commitment;
use fairground_clearing::{Bid, ClearingStatus, clear};

use super::*;
use crate::{Error, FailReason, Status};

const REVEAL_WINDOW: u64 = 10 * MINUTE;
const REVEAL_END: u64 = BID_END + REVEAL_WINDOW;

struct Sealed {
    n: u32,
    deposit: u128,
    price: u128,
    spend: u128,
    salt: [u8; 16],
}

fn bids() -> Vec<Sealed> {
    vec![
        Sealed {
            n: 1,
            deposit: 500 * USDC,
            price: 2_000,
            spend: 400 * USDC,
            salt: [1; 16],
        },
        Sealed {
            n: 2,
            deposit: 300 * USDC,
            price: 1_500,
            spend: 300 * USDC,
            salt: [2; 16],
        },
        Sealed {
            n: 3,
            deposit: 200 * USDC,
            price: 1_000,
            spend: 150 * USDC,
            salt: [3; 16],
        },
        // Never revealed: pays ceil(1 %) of 123.456789 USDC.
        Sealed {
            n: 4,
            deposit: 123_456_789,
            price: 5_000,
            spend: 100 * USDC,
            salt: [4; 16],
        },
    ]
}

/// A commit-reveal sale with all bids placed and closed: status `revealing`.
fn revealing_sale() -> Fairground {
    let mut contract = ready_sale("fairt", RevealMode::CommitReveal);
    for bid in bids() {
        let commit = commitment(
            "fairt",
            bidder(bid.n).as_str(),
            bid.price,
            bid.spend,
            &bid.salt,
        );
        let msg = commit_msg("fairt", &commit);
        assert_eq!(
            deliver(
                &mut contract,
                &usdc(),
                BID_START,
                &bidder(bid.n),
                bid.deposit,
                &msg
            ),
            0
        );
    }
    set_call(&bidder(9), BID_END, 5);
    match contract.close_sale("fairt".into()).unwrap() {
        PromiseOrValue::Value(status) => assert_eq!(status, "revealing"),
        PromiseOrValue::Promise(_) => panic!("commit-reveal needs no OutLayer call"),
    }
    // The attached NEAR goes straight back.
    assert_eq!(transfers(), vec![(bidder(9), 5)]);
    assert_eq!(
        event("sale_closed")["reveal_end"],
        json!(REVEAL_END.to_string())
    );
    contract
}

fn reveal(contract: &mut Fairground, bid: &Sealed, now: u64) -> Result<(), Error> {
    set_call(&bidder(bid.n), now, 0);
    contract.reveal_bid(
        "fairt".into(),
        U128(bid.price),
        U128(bid.spend),
        fairground_clearing::hash::to_hex(&bid.salt),
    )
}

#[test]
fn reveals_are_checked_against_the_commitment() {
    let mut contract = revealing_sale();
    let sale = contract.get_sale("fairt".into()).unwrap();
    assert_eq!(sale.status, Status::Revealing);
    assert_eq!(sale.reveal_end, Some(U64(REVEAL_END)));
    assert_eq!(sale.refund_mode_at, Some(U64(REVEAL_END + SETTLE_TIMEOUT)));
    let bids = bids();

    let mut wrong = Sealed {
        price: bids[0].price + 1,
        ..bids[0]
    };
    assert_eq!(
        reveal(&mut contract, &wrong, BID_END),
        Err(Error::CommitmentMismatch)
    );
    wrong = Sealed {
        salt: [0; 16],
        ..bids[0]
    };
    assert_eq!(
        reveal(&mut contract, &wrong, BID_END),
        Err(Error::CommitmentMismatch)
    );
    set_call(&bidder(1), BID_END, 0);
    assert_eq!(
        contract.reveal_bid("fairt".into(), U128(1), U128(1), "xyz".into()),
        Err(Error::BadSalt)
    );
    assert_eq!(
        reveal(&mut contract, &Sealed { n: 8, ..bids[0] }, BID_END),
        Err(Error::NoBid)
    );

    reveal(&mut contract, &bids[0], BID_END).unwrap();
    assert_eq!(
        event("bid_revealed"),
        json!({"sale_id": "fairt", "bidder": "bidder1.testnet", "index": 0})
    );
    assert!(
        contract
            .get_bid("fairt".into(), bidder(1))
            .unwrap()
            .revealed
    );
    assert_eq!(
        reveal(&mut contract, &bids[0], BID_END),
        Err(Error::AlreadyRevealed)
    );
    reveal(&mut contract, &bids[1], REVEAL_END - 1).unwrap();
    assert_eq!(
        reveal(&mut contract, &bids[2], REVEAL_END),
        Err(Error::TooLate {
            action: "reveal a bid",
            at: REVEAL_END
        })
    );
}

#[test]
fn reveals_need_the_reveal_window() {
    let mut contract = ready_sale("fairt", RevealMode::CommitReveal);
    let bid = &bids()[0];
    let commit = commitment("fairt", bidder(1).as_str(), bid.price, bid.spend, &bid.salt);
    deliver(
        &mut contract,
        &usdc(),
        BID_START,
        &bidder(1),
        bid.deposit,
        &commit_msg("fairt", &commit),
    );
    assert_eq!(
        reveal(&mut contract, bid, BID_START),
        Err(Error::WrongPhase {
            action: "reveal a bid",
            status: "open"
        })
    );
    set_call(&bidder(1), BID_END, 0);
    assert_eq!(
        contract.clear_onchain("fairt".into()),
        Err(Error::WrongPhase {
            action: "clear on chain",
            status: "awaiting_close"
        })
    );
}

#[test]
fn clear_onchain_settles_and_penalises_unrevealed_bids() {
    let mut contract = revealing_sale();
    let bids = bids();
    for bid in &bids[..3] {
        reveal(&mut contract, bid, BID_END).unwrap();
    }
    set_call(&bidder(9), REVEAL_END - 1, 0);
    assert_eq!(
        contract.clear_onchain("fairt".into()),
        Err(Error::TooEarly {
            action: "clear on chain",
            at: REVEAL_END
        })
    );
    set_call(&bidder(9), REVEAL_END, 0);
    assert_eq!(contract.clear_onchain("fairt".into()).unwrap(), "settled");

    // Same result as the reference clearing with bid 4 unrevealed.
    let p = params("fairt", RevealMode::CommitReveal);
    let reference = clear(
        &fairground_clearing::SaleParams {
            sale_supply: p.sale_supply.0,
            floor_price: p.floor_price.0,
            min_raise: p.min_raise.0,
            decimals: p.decimals,
            max_price: None,
        },
        &bids
            .iter()
            .map(|bid| Bid {
                bidder: bidder(bid.n).to_string(),
                deposit: bid.deposit,
                max_price: (bid.n != 4).then_some(bid.price),
                max_spend: (bid.n != 4).then_some(bid.spend),
                mismatch: false,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert_eq!(reference.status, ClearingStatus::Settled);
    let result = contract.get_result("fairt".into()).unwrap();
    assert_eq!(result.status, Status::Settled);
    assert_eq!(result.clearing_price, U128(reference.clearing_price));
    assert_eq!(result.total_sold, U128(reference.total_sold));
    assert_eq!(result.total_raised, U128(reference.total_raised));
    assert_eq!((result.n_valid, result.n_invalid), (3, 1));
    // ceil(123_456_789 / 100)
    assert_eq!(result.total_penalties, U128(1_234_568));
    assert_eq!(
        event("sale_settled")["clearing_price"],
        json!(reference.clearing_price.to_string())
    );

    let fills = contract.get_fills("fairt".into(), None, None);
    for (view, expected) in fills.iter().zip(&reference.fills) {
        assert_eq!(
            (view.tokens.0, view.spent.0),
            (expected.tokens, expected.spent)
        );
    }
    assert_eq!(fills[3].refund, U128(123_456_789 - 1_234_568));

    // The unrevealed bidder can claim only the deposit minus the penalty.
    set_call(&bidder(4), REVEAL_END, 0);
    contract.claim("fairt".into(), None).unwrap().detach();
    let transfer = calls_to("ft_transfer").pop().unwrap();
    assert_eq!(
        transfer.args["amount"],
        json!((123_456_789u128 - 1_234_568).to_string())
    );
}

#[test]
fn clear_onchain_can_fail_the_sale() {
    // Nobody reveals: no valid bids; everyone loses the 1 % penalty.
    let mut contract = revealing_sale();
    set_call(&bidder(9), REVEAL_END, 0);
    assert_eq!(contract.clear_onchain("fairt".into()).unwrap(), "failed");
    let result = contract.get_result("fairt".into()).unwrap();
    assert_eq!(result.fail_reason, Some(FailReason::NoValidBids));
    let refunds: Vec<u128> = contract
        .get_fills("fairt".into(), None, None)
        .iter()
        .map(|fill| fill.refund.0)
        .collect();
    assert_eq!(
        refunds,
        [495 * USDC, 297 * USDC, 198 * USDC, 123_456_789 - 1_234_568]
    );

    // Below the minimum raise.
    let mut contract = revealing_sale();
    reveal(&mut contract, &Sealed { ..bids()[2] }, BID_END).unwrap();
    contract.sales.get_mut("fairt").unwrap().terms.min_raise = 1_000 * USDC;
    set_call(&bidder(9), REVEAL_END, 0);
    assert_eq!(contract.clear_onchain("fairt".into()).unwrap(), "failed");
    let result = contract.get_result("fairt".into()).unwrap();
    assert_eq!(result.fail_reason, Some(FailReason::BelowMinRaise));
    assert_eq!(result.failed_checks, ["raise_at_least_min"]);
    // The revealed bid gets everything back.
    assert_eq!(
        contract.get_fills("fairt".into(), Some(2), Some(1))[0].refund,
        U128(200 * USDC)
    );
}

#[test]
fn refund_mode_after_the_reveal_window_refunds_in_full() {
    let mut contract = revealing_sale();
    set_call(&bidder(9), REVEAL_END + SETTLE_TIMEOUT - 1, 0);
    assert_eq!(
        contract.trigger_refund_mode("fairt".into()),
        Err(Error::TooEarly {
            action: "trigger refund mode",
            at: REVEAL_END + SETTLE_TIMEOUT
        })
    );
    set_call(&bidder(9), REVEAL_END + SETTLE_TIMEOUT, 0);
    contract.trigger_refund_mode("fairt".into()).unwrap();
    assert_eq!(event("refund_mode")["from"], json!("revealing"));
    // No on-chain clearing happened, so no penalty.
    let refunds: Vec<u128> = contract
        .get_fills("fairt".into(), None, None)
        .iter()
        .map(|fill| fill.refund.0)
        .collect();
    assert_eq!(
        refunds,
        bids().iter().map(|bid| bid.deposit).collect::<Vec<_>>()
    );
    assert_eq!(
        contract.get_result("fairt".into()).unwrap().total_penalties,
        U128(0)
    );
}

/// Revealing a bid that breaks a bid rule (here: below the floor, and a spend
/// above the deposit) is no free exit: it pays the same 1 % as not revealing.
#[test]
fn revealed_invalid_bids_pay_the_penalty_too() {
    let mut contract = ready_sale("fairt", RevealMode::CommitReveal);
    let sealed = [
        Sealed {
            n: 1,
            deposit: 500 * USDC,
            price: 2_000,
            spend: 400 * USDC,
            salt: [1; 16],
        },
        Sealed {
            n: 2,
            deposit: 300 * USDC,
            price: 999,
            spend: 300 * USDC,
            salt: [2; 16],
        },
        Sealed {
            n: 3,
            deposit: 200 * USDC,
            price: 2_000,
            spend: 200 * USDC + 1,
            salt: [3; 16],
        },
    ];
    for bid in &sealed {
        let commit = commitment(
            "fairt",
            bidder(bid.n).as_str(),
            bid.price,
            bid.spend,
            &bid.salt,
        );
        let msg = commit_msg("fairt", &commit);
        assert_eq!(
            deliver(
                &mut contract,
                &usdc(),
                BID_START,
                &bidder(bid.n),
                bid.deposit,
                &msg
            ),
            0
        );
    }
    set_call(&bidder(9), BID_END, 0);
    contract.close_sale("fairt".into()).unwrap().detach();
    for bid in &sealed {
        reveal(&mut contract, bid, BID_END).unwrap();
    }
    set_call(&bidder(9), REVEAL_END, 0);
    assert_eq!(contract.clear_onchain("fairt".into()).unwrap(), "settled");
    let result = contract.get_result("fairt".into()).unwrap();
    assert_eq!((result.n_valid, result.n_invalid), (1, 2));
    assert_eq!(result.total_penalties, U128(5 * USDC));
    let fills = contract.get_fills("fairt".into(), None, None);
    assert_eq!(fills[0].penalty, U128(0));
    assert_eq!(
        (fills[1].refund, fills[1].penalty),
        (U128(297 * USDC), U128(3 * USDC))
    );
    assert_eq!(
        (fills[2].refund, fills[2].penalty),
        (U128(198 * USDC), U128(2 * USDC))
    );
}
