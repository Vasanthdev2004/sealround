//! Hand-checked cases (ported from `clear.test.ts`), edge cases at the u128
//! limits, and invariants over 1,000 seeded random bid sets. Every case runs
//! through both price searches, which must agree; another 5,000 random books
//! compare them directly.

use std::time::{Duration, Instant};

use fairground_clearing::{
    Bid, ClearingError, ClearingResult, ClearingStatus, FailReason, InvalidReason, PriceSearch,
    SaleParams, ValidBid, clear, clear_with, contract_checks, cost_of, demand_at, one_token,
    prorate, tokens_for,
};

const MAX: u128 = u128::MAX;
const ONE: u128 = 1_000_000_000_000_000_000;

/// "12.5" with `decimals` places -> base units.
fn units(value: &str, decimals: u32) -> u128 {
    let (whole, frac) = value.split_once('.').unwrap_or((value, ""));
    assert!(
        frac.len() <= decimals as usize,
        "too many decimals: {value}"
    );
    let scale = 10u128.pow(decimals);
    let frac = format!("{frac:0<width$}", width = decimals as usize);
    whole.parse::<u128>().unwrap() * scale
        + if frac.is_empty() {
            0
        } else {
            frac.parse::<u128>().unwrap()
        }
}

fn usdc(value: &str) -> u128 {
    units(value, 6)
}

fn tokens(value: &str) -> u128 {
    units(value, 18)
}

fn bid(bidder: &str, deposit: &str, max_price: &str, max_spend: &str) -> Bid {
    Bid {
        bidder: bidder.to_owned(),
        deposit: usdc(deposit),
        max_price: Some(usdc(max_price)),
        max_spend: Some(usdc(max_spend)),
        mismatch: false,
    }
}

fn raw(bidder: &str, deposit: u128, max_price: u128, max_spend: u128) -> Bid {
    Bid {
        bidder: bidder.to_owned(),
        deposit,
        max_price: Some(max_price),
        max_spend: Some(max_spend),
        mismatch: false,
    }
}

fn params() -> SaleParams {
    SaleParams {
        sale_supply: tokens("600000"),
        floor_price: usdc("0.001"),
        min_raise: usdc("50"),
        decimals: 18,
        max_price: None,
    }
}

/// Clears with both price searches, checks that they agree, and returns the result.
fn both(params: &SaleParams, bids: &[Bid]) -> Result<ClearingResult, ClearingError> {
    let fast = clear(params, bids);
    let fixed = clear_with(params, bids, PriceSearch::FixedShape);
    assert_eq!(fixed, fast, "{params:?} {bids:?}");
    assert_eq!(clear_with(params, bids, PriceSearch::Fast), fast);
    fast
}

fn ok(params: &SaleParams, bids: &[Bid]) -> ClearingResult {
    both(params, bids).expect("clears")
}

// ---------------------------------------------------------------- hand-checked

#[test]
fn undersubscribed_clears_at_floor_with_unsold_remainder() {
    let r = ok(
        &params(),
        &[
            bid("a", "100", "0.002", "100"),
            bid("b", "100", "0.001", "50"),
        ],
    );
    assert_eq!(r.status, ClearingStatus::Settled);
    assert_eq!(r.clearing_price, 1_000);
    assert!(!r.oversubscribed);
    assert_eq!(r.fills[0].tokens, tokens("100000"));
    assert_eq!(r.fills[1].tokens, tokens("50000"));
    assert_eq!(r.total_raised, usdc("150"));
    assert_eq!(r.unsold, tokens("450000"));
    assert_eq!(r.fills[1].refund, usdc("50"));
}

#[test]
fn oversubscribed_everyone_pays_one_price_and_supply_sells_out() {
    // At 0.002: a(600) wants 300k, b(600) wants 300k -> exactly 600k.
    let p = params();
    let r = ok(
        &p,
        &[
            bid("a", "600", "0.005", "600"),
            bid("b", "600", "0.002", "600"),
            bid("c", "600", "0.0015", "600"),
        ],
    );
    assert_eq!(r.clearing_price, 2_000);
    assert_eq!(r.total_sold, p.sale_supply);
    assert_eq!(r.fills[2].tokens, 0);
    assert_eq!(r.fills[2].refund, usdc("600"));
    assert_eq!(r.unsold, 0);
}

#[test]
fn ties_at_the_clearing_price_share_pro_rata() {
    let p = SaleParams {
        sale_supply: tokens("1000"),
        min_raise: 0,
        ..params()
    };
    let r = ok(
        &p,
        &[
            bid("a", "10", "0.01", "1.5"),  // 500 tokens at 0.003
            bid("b", "10", "0.003", "3"),   // wants 1000
            bid("c", "10", "0.003", "1.5"), // wants 500
        ],
    );
    assert_eq!(r.clearing_price, 3_000);
    assert_eq!(r.fills[0].tokens, tokens("500"));
    // The remaining 500 split 2:1.
    let (b, c) = (r.fills[1].tokens, r.fills[2].tokens);
    assert_eq!(b + c, tokens("500"));
    assert!(b > c);
    assert!(b.abs_diff(2 * c) <= 2);
}

#[test]
fn min_raise_missed_fails_and_refunds_in_full() {
    let r = ok(&params(), &[bid("a", "10", "0.01", "10")]);
    assert_eq!(r.status, ClearingStatus::Failed);
    assert_eq!(r.fail_reason, Some(FailReason::BelowMinRaise));
    assert_eq!(r.fills[0].tokens, 0);
    assert_eq!(r.fills[0].refund, usdc("10"));
    assert_eq!(
        (r.total_sold, r.total_raised, r.unsold),
        (0, 0, params().sale_supply)
    );
}

#[test]
fn invalid_bids_count_as_zero_and_get_full_refunds() {
    let r = ok(
        &params(),
        &[
            bid("a", "100", "0.01", "100"),
            Bid {
                bidder: "x".into(),
                deposit: usdc("100"),
                max_price: None,
                max_spend: None,
                mismatch: false,
            },
            bid("y", "10", "0.01", "20"),     // spend above deposit
            bid("z", "100", "0.0009", "100"), // below floor
            Bid {
                mismatch: true,
                ..bid("m", "100", "0.01", "100")
            },
            bid("o", "100", "0.01", "0"),
        ],
    );
    assert_eq!(r.n_valid, 1);
    assert_eq!(r.n_invalid, 5);
    let reasons: Vec<_> = r.fills[1..].iter().map(|f| f.invalid_reason).collect();
    assert_eq!(
        reasons,
        [
            Some(InvalidReason::DecryptFailed),
            Some(InvalidReason::SpendAboveDeposit),
            Some(InvalidReason::PriceBelowFloor),
            Some(InvalidReason::BidderMismatch),
            Some(InvalidReason::ZeroSpend),
        ]
    );
    for f in &r.fills[1..] {
        assert!(!f.valid);
        assert_eq!(f.tokens, 0);
        assert_eq!(f.refund, f.deposit);
    }
}

#[test]
fn no_valid_bids_fails() {
    let r = ok(&params(), &[]);
    assert_eq!(r.status, ClearingStatus::Failed);
    assert_eq!(r.fail_reason, Some(FailReason::NoValidBids));
    let r = ok(
        &params(),
        &[Bid {
            max_price: None,
            ..bid("x", "1", "1", "1")
        }],
    );
    assert_eq!(r.fail_reason, Some(FailReason::NoValidBids));
    assert_eq!(r.fills[0].refund, usdc("1"));
}

#[test]
fn bot_and_human_pay_the_same_clearing_price() {
    // Per-bid floor rounding leaves demand at 1400 a few base units short of
    // supply, so the integer answer is 1399.
    let p = SaleParams {
        sale_supply: tokens("10000"),
        min_raise: 0,
        ..params()
    };
    let r = ok(
        &p,
        &[
            bid("sniper.testnet", "10", "1", "10"),
            bid("human.testnet", "10", "0.004", "4"),
        ],
    );
    assert_eq!(r.clearing_price, 1_399);
    for f in &r.fills {
        assert!(f.tokens > 0);
        assert_eq!(Some(f.spent), cost_of(f.tokens, r.clearing_price, ONE));
    }
}

#[test]
fn tier_one_alone_over_supply_is_prorated() {
    // No bid sits exactly at P* = 7, and the two bids above it want 8 > 7.
    let p = SaleParams {
        sale_supply: 7,
        floor_price: 1,
        min_raise: 0,
        decimals: 0,
        max_price: None,
    };
    let r = ok(&p, &[raw("a", 30, 100, 30), raw("b", 30, 100, 30)]);
    assert_eq!(r.clearing_price, 7);
    assert_eq!(r.fills.iter().map(|f| f.tokens).collect::<Vec<_>>(), [4, 3]);
    assert_eq!(
        r.fills.iter().map(|f| f.spent).collect::<Vec<_>>(),
        [28, 21]
    );
}

// ---------------------------------------------------------------- ceiling

#[test]
fn ceiling_is_optional() {
    let p = SaleParams {
        sale_supply: tokens("1000"),
        min_raise: 0,
        ..params()
    };
    let bids = [
        bid("a", "100", "0.05", "100"),
        bid("b", "100", "0.003", "2"),
        bid("c", "100", "0.0015", "1"),
    ];
    let r = ok(&p, &bids);
    assert_eq!(r.clearing_price, usdc("0.05"));
    let ceiling = SaleParams {
        max_price: Some(usdc("1")),
        ..p
    };
    assert_eq!(ok(&ceiling, &bids), r);
}

#[test]
fn ceiling_clamps_prices_before_clearing() {
    let p = SaleParams {
        sale_supply: tokens("1000"),
        min_raise: 0,
        max_price: Some(usdc("0.002")),
        ..params()
    };
    let bids = [
        bid("a", "100", "0.05", "100"),
        bid("b", "100", "0.003", "2"),
        bid("c", "100", "0.0015", "1"),
    ];
    let r = ok(&p, &bids);
    assert_eq!(r.clearing_price, usdc("0.002"));
    assert_eq!(r.fills[2].tokens, 0);
    assert_eq!(r.total_sold, p.sale_supply);
    assert_eq!(contract_checks(&p, &bids, &r), Ok(vec![]));

    let unclamped = ok(
        &SaleParams {
            max_price: None,
            ..p
        },
        &bids,
    );
    assert_eq!(
        contract_checks(&p, &bids, &unclamped),
        Ok(vec!["price_at_most_ceiling".to_owned()])
    );
}

#[test]
fn ceiling_at_the_floor_puts_everyone_at_the_floor() {
    let p = SaleParams {
        sale_supply: tokens("100"),
        min_raise: 0,
        max_price: Some(usdc("0.001")),
        ..params()
    };
    let r = ok(
        &p,
        &[bid("a", "1", "0.5", "1"), bid("b", "1", "0.002", "0.05")],
    );
    assert_eq!(r.clearing_price, usdc("0.001"));
    assert!(r.oversubscribed);
    assert_eq!(r.total_sold, p.sale_supply);
}

// ---------------------------------------------------------------- errors

#[test]
fn unusable_params_are_errors() {
    let bids = [bid("a", "1", "0.01", "1")];
    let cases = [
        (
            SaleParams {
                sale_supply: 0,
                ..params()
            },
            ClearingError::SaleSupplyNotPositive,
        ),
        (
            SaleParams {
                floor_price: 0,
                ..params()
            },
            ClearingError::FloorPriceNotPositive,
        ),
        (
            SaleParams {
                decimals: 25,
                ..params()
            },
            ClearingError::DecimalsOutOfRange,
        ),
        (
            SaleParams {
                decimals: 255,
                ..params()
            },
            ClearingError::DecimalsOutOfRange,
        ),
        (
            SaleParams {
                max_price: Some(999),
                ..params()
            },
            ClearingError::CeilingBelowFloor,
        ),
    ];
    for (p, err) in cases {
        assert_eq!(both(&p, &bids), Err(err));
        assert_eq!(contract_checks(&p, &bids, &ok(&params(), &bids)), Err(err));
    }
    assert_eq!(ClearingError::Overflow.code(), "overflow");
    assert_eq!(
        ClearingError::CeilingBelowFloor.to_string(),
        "max price ceiling must be at least the floor price"
    );
}

// ---------------------------------------------------------------- u128 limits

#[test]
fn demand_beyond_u128_at_the_floor_is_an_error_not_a_panic() {
    // 1e15 * 1e24 = 1e39 > u128::MAX.
    let p = SaleParams {
        sale_supply: 1,
        floor_price: 1,
        min_raise: 0,
        decimals: 24,
        max_price: None,
    };
    assert_eq!(
        both(&p, &[raw("a", 10u128.pow(15), 2, 10u128.pow(15))]),
        Err(ClearingError::Overflow)
    );
    // The same numbers on an invalid bid are ignored.
    let r = ok(&p, &[raw("a", 1, MAX, MAX), raw("b", 10, 1, 10)]);
    assert_eq!(
        r.fills[0].invalid_reason,
        Some(InvalidReason::SpendAboveDeposit)
    );
}

#[test]
fn total_raise_beyond_u128_is_an_error_not_a_panic() {
    let p = SaleParams {
        sale_supply: 1 << 127,
        floor_price: 1,
        min_raise: 0,
        decimals: 0,
        max_price: None,
    };
    assert_eq!(
        both(&p, &[raw("a", MAX, 2, MAX), raw("b", MAX, 2, MAX)]),
        Err(ClearingError::Overflow)
    );
}

#[test]
fn decimals_24_at_the_u128_edge() {
    // 340_282_366_920_938 * 1e24 is just below u128::MAX, so it is the largest
    // spend that still fits at a floor of 1.
    let spend = 340_282_366_920_938;
    let p = SaleParams {
        sale_supply: 10u128.pow(38),
        floor_price: 1,
        min_raise: 0,
        decimals: 24,
        max_price: None,
    };
    let r = ok(
        &p,
        &[
            raw("a", spend, 7, spend),
            raw("b", 10u128.pow(14), 1, 10u128.pow(14)),
        ],
    );
    // D(3) = floor(spend * 1e24 / 3) >= 1e38 > D(4), and a sits above P*.
    assert_eq!(r.clearing_price, 3);
    assert_eq!(r.fills[0].tokens, p.sale_supply);
    assert_eq!(r.fills[0].spent, 300_000_000_000_000);
    assert_eq!(
        contract_checks(
            &p,
            &[raw("a", spend, 0, 0), raw("b", 10u128.pow(14), 0, 0)],
            &r
        ),
        Ok(vec![])
    );
}

#[test]
fn supply_and_deposits_at_u128_max() {
    let p = SaleParams {
        sale_supply: MAX,
        floor_price: 1,
        min_raise: 0,
        decimals: 0,
        max_price: None,
    };
    let r = ok(&p, &[raw("whale", MAX, MAX, MAX)]);
    assert_eq!(
        (r.clearing_price, r.total_sold, r.total_raised, r.unsold),
        (1, MAX, MAX, 0)
    );

    let r = ok(&p, &[raw("a", MAX, 1, MAX), raw("b", MAX, 1, MAX)]);
    assert_eq!(r.fills[0].tokens, 1 << 127);
    assert_eq!(r.fills[1].tokens, (1 << 127) - 1);
    assert_eq!(r.total_sold, MAX);
}

#[test]
fn price_search_over_the_whole_u128_range() {
    let p = SaleParams {
        sale_supply: 1,
        floor_price: 1,
        min_raise: 0,
        decimals: 0,
        max_price: None,
    };
    let r = ok(&p, &[raw("a", MAX, MAX, MAX), raw("b", 10, MAX - 1, 10)]);
    assert_eq!(r.clearing_price, MAX);
    assert_eq!((r.fills[0].tokens, r.fills[0].spent), (1, MAX));

    let floor_max = SaleParams {
        floor_price: MAX,
        max_price: Some(MAX),
        ..p
    };
    let r = ok(&floor_max, &[raw("a", MAX, MAX, MAX)]);
    assert_eq!((r.clearing_price, r.fills[0].tokens), (MAX, 1));
}

#[test]
fn contract_checks_survive_absurd_results() {
    let p = params();
    let bids = [bid("a", "1", "1", "1"), bid("b", "1", "1", "1")];
    let mut r = ok(&p, &bids);
    for f in &mut r.fills {
        f.tokens = MAX;
        f.spent = MAX;
    }
    r.clearing_price = MAX;
    let failed = contract_checks(&p, &bids, &r).expect("valid params");
    assert!(failed.contains(&"sold_at_most_supply".to_owned()));
    assert!(failed.contains(&"raise_sums_fills".to_owned()));
    assert!(failed.contains(&"spent_equals_tokens_times_price_0".to_owned()));
    // A raise beyond u128 is above any minimum.
    assert!(!failed.contains(&"raise_at_least_min".to_owned()));
}

/// Every combination of extreme values either clears or returns an error.
#[test]
fn extreme_inputs_never_panic() {
    let values = [
        0,
        1,
        2,
        999,
        10u128.pow(6),
        10u128.pow(12),
        10u128.pow(24),
        1 << 64,
        1 << 127,
        MAX - 1,
        MAX,
    ];
    let decimals = [0, 6, 18, 24, 25, 38, 39, 255];
    let mut rng = SplitMix(99);
    for _ in 0..30_000 {
        let pick = |rng: &mut SplitMix| values[rng.below(values.len() as u64) as usize];
        let p = SaleParams {
            sale_supply: pick(&mut rng),
            floor_price: pick(&mut rng),
            min_raise: pick(&mut rng),
            decimals: decimals[rng.below(decimals.len() as u64) as usize],
            max_price: rng.chance(0.3).then(|| pick(&mut rng)),
        };
        let n = rng.below(5) as usize;
        let bids: Vec<Bid> = (0..n)
            .map(|i| Bid {
                bidder: format!("b{i}"),
                deposit: pick(&mut rng),
                max_price: rng.chance(0.9).then(|| pick(&mut rng)),
                max_spend: rng.chance(0.9).then(|| pick(&mut rng)),
                mismatch: rng.chance(0.1),
            })
            .collect();
        if let Ok(r) = both(&p, &bids) {
            assert_conserved(&p, &bids, &r);
        }
    }
}

// ---------------------------------------------------------------- prorate

#[test]
fn prorate_never_exceeds_weights_and_sums_to_amount() {
    assert_eq!(prorate(10, &[3, 3, 3]), [3, 3, 3]);
    assert_eq!(prorate(7, &[3, 3, 3]), [3, 2, 2]);
    assert_eq!(prorate(0, &[3]), [0]);
    assert_eq!(prorate(5, &[0, 10]), [0, 5]);
    assert_eq!(prorate(5, &[]), Vec::<u128>::new());
    assert_eq!(prorate(5, &[0, 0]), [0, 0]);
    // Floors are [0, 2, 0]; the two leftover units go one at a time in order.
    assert_eq!(prorate(4, &[1, 5, 1]), [1, 3, 0]);
    // Leftovers skip entries already at their weight.
    assert_eq!(prorate(1, &[0, 1, 1]), [0, 1, 0]);
    // Weights whose sum exceeds u128.
    assert_eq!(prorate(MAX, &[MAX, MAX]), [1 << 127, (1 << 127) - 1]);
    assert_eq!(prorate(1, &[MAX, MAX, MAX]), [1, 0, 0]);
    assert_eq!(prorate(MAX - 1, &[MAX, 2]), [MAX - 2, 1]);

    let mut rng = SplitMix(5);
    for _ in 0..5_000 {
        let weights: Vec<u128> = (0..=rng.below(8)).map(|_| rng.wide()).collect();
        let total = weights.iter().try_fold(0u128, |a, &w| a.checked_add(w));
        let amount = match total {
            Some(t) if rng.chance(0.5) => rng.wide() % (t.saturating_add(1)).max(1),
            _ => rng.wide(),
        };
        let shares = prorate(amount, &weights);
        assert!(shares.iter().zip(&weights).all(|(s, w)| s <= w));
        let given = shares.iter().try_fold(0u128, |a, &s| a.checked_add(s));
        match total {
            Some(t) => assert_eq!(given, Some(amount.min(t))),
            None => assert_eq!(given, Some(amount)),
        }
    }
}

// ---------------------------------------------------------------- invariants

/// SplitMix64: a small deterministic generator, no `rand` needed.
struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: u128, hi: u128) -> u128 {
        lo + u128::from(self.next()) % (hi - lo + 1)
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
    /// A value of random bit length, up to u128::MAX.
    fn wide(&mut self) -> u128 {
        let raw = (u128::from(self.next()) << 64) | u128::from(self.next());
        raw >> self.below(128)
    }
}

/// Money is conserved and the price is in range for any successful result.
fn assert_conserved(p: &SaleParams, bids: &[Bid], r: &ClearingResult) {
    assert_eq!(r.fills.len(), bids.len());
    for (f, b) in r.fills.iter().zip(bids) {
        assert_eq!(f.spent.checked_add(f.refund), Some(b.deposit));
        assert_eq!(f.deposit, b.deposit);
    }
    assert!(r.total_sold <= p.sale_supply);
    assert!(r.clearing_price >= p.floor_price);
    if let Some(ceiling) = p.max_price {
        assert!(r.clearing_price <= ceiling);
    }
}

#[test]
fn invariants_on_1000_random_bid_sets() {
    // (failed, undersubscribed, oversubscribed, ceiling below the top bid)
    let mut seen = (0, 0, 0, 0);
    for seed in 1..=1000u64 {
        let mut rng = SplitMix(seed);
        let decimals = [18, 18, 6, 0, 24][(seed % 5) as usize];
        let one = one_token(decimals).unwrap();
        let floor = [1_000, 1, 7, 250_000][(seed % 4) as usize];
        let p = SaleParams {
            sale_supply: (1 + u128::from(seed % 7) * 50_000) * one,
            floor_price: floor,
            min_raise: usdc(if seed % 3 == 0 { "400" } else { "5" }),
            decimals,
            max_price: rng.chance(0.25).then(|| rng.range(floor, floor * 4)),
        };
        let levels = [floor, floor * 3 / 2, floor * 2, floor * 3];
        let bids: Vec<Bid> = (0..1 + seed % 120)
            .map(|i| {
                let deposit = rng.range(1, usdc("200"));
                let mut b = Bid {
                    bidder: format!("bidder{i}.testnet"),
                    deposit,
                    max_price: Some(if rng.chance(0.35) {
                        levels[rng.below(4) as usize]
                    } else {
                        rng.range(floor, floor * 10)
                    }),
                    max_spend: Some(rng.range(1, deposit)),
                    mismatch: false,
                };
                if rng.chance(0.1) {
                    match rng.below(5) {
                        0 => (b.max_price, b.max_spend) = (None, None),
                        1 => b.max_spend = Some(deposit + 1),
                        2 => b.max_price = Some(floor - 1),
                        3 => b.mismatch = true,
                        _ => b.max_spend = Some(0),
                    }
                }
                b
            })
            .collect();

        let r = ok(&p, &bids);
        let price = r.clearing_price;

        // Deterministic, and the contract's checks pass on every honest result.
        assert_eq!(ok(&p, &bids), r);
        let failed = contract_checks(&p, &bids, &r).unwrap();
        assert!(
            failed.iter().all(|c| c == "raise_at_least_min"),
            "seed {seed}: {failed:?}"
        );
        assert_conserved(&p, &bids, &r);
        let top = bids.iter().filter_map(|b| b.max_price).max().unwrap_or(0);
        seen.3 += usize::from(p.max_price.is_some_and(|c| c < top));

        if r.status == ClearingStatus::Failed {
            assert!(
                r.fills
                    .iter()
                    .all(|f| f.tokens == 0 && f.refund == f.deposit)
            );
            seen.0 += 1;
            continue;
        }
        assert!(r.total_raised >= p.min_raise);
        if r.oversubscribed {
            seen.2 += 1;
        } else {
            seen.1 += 1;
        }

        // Valid bids with the ceiling applied.
        let valid: Vec<ValidBid> = bids
            .iter()
            .enumerate()
            .filter(|&(i, _)| r.fills[i].valid)
            .map(|(index, b)| ValidBid {
                index,
                max_price: p
                    .max_price
                    .map_or(b.max_price.unwrap(), |c| b.max_price.unwrap().min(c)),
                max_spend: b.max_spend.unwrap(),
            })
            .collect();
        let want = |v: &ValidBid| tokens_for(v.max_spend, price, one).unwrap();

        for v in &valid {
            let f = &r.fills[v.index];
            // Nobody pays more than their max spend or gets more than they asked for.
            assert!(f.spent <= v.max_spend);
            assert!(f.tokens <= want(v));
            // Bids below P* get nothing.
            if v.max_price < price {
                assert_eq!(f.tokens, 0);
            }
        }

        if r.oversubscribed {
            // P* is the highest price where demand covers supply.
            assert!(
                demand_at(&valid, price, one) >= p.sale_supply,
                "seed {seed}"
            );
            assert!(
                demand_at(&valid, price + 1, one) < p.sale_supply,
                "seed {seed}"
            );
            assert_eq!(r.total_sold, p.sale_supply);
            // Bids strictly above P* fill in full unless they alone exceed supply.
            let above: Vec<&ValidBid> = valid.iter().filter(|v| v.max_price > price).collect();
            if above.iter().map(|v| want(v)).sum::<u128>() <= p.sale_supply {
                for v in above {
                    assert_eq!(r.fills[v.index].tokens, want(v));
                }
            }
        } else {
            assert_eq!(price, p.floor_price);
            for v in &valid {
                assert_eq!(r.fills[v.index].tokens, want(v));
            }
        }
    }
    let (failed, under, over, clamped) = seen;
    assert!(
        failed >= 50 && under >= 50 && over >= 50 && clamped >= 50,
        "{seen:?}"
    );
}

// ---------------------------------------------------------------- price searches

/// A random book for comparing the searches: prices from the floor to
/// u128::MAX, spends from tiny to huge, some invalid bids, and a supply that
/// is usually below the demand at the floor (so the search runs).
fn random_book(rng: &mut SplitMix) -> (SaleParams, Vec<Bid>) {
    let decimals = [0u8, 6, 18, 24][rng.below(4) as usize];
    let one = one_token(decimals).unwrap();
    let floor = match rng.below(3) {
        0 => rng.range(1, 10_000),
        1 => rng.wide().max(1),
        _ => 1,
    };
    // One book in ten may hold spends whose demand or sum overflows u128.
    let wild = rng.chance(0.1);
    let bids: Vec<Bid> = (0..1 + rng.below(40))
        .map(|i| {
            let max_price = match rng.below(5) {
                // Ties just above the floor.
                0 => floor.saturating_add(u128::from(rng.below(4))),
                1 => rng.wide().max(floor),
                2 => MAX - u128::from(rng.below(4)),
                3 => floor.saturating_add(rng.wide()),
                _ => floor.saturating_sub(1).max(1),
            };
            // Spends whose demand at the floor, and whose sum, fit u128 (at
            // most 40 bids), unless the book is wild.
            let max_spend = match rng.below(10) {
                0..=3 => rng.range(1, 1_000_000_000),
                4 if wild => rng.wide(),
                _ => (MAX / one / 64) >> rng.below(100),
            };
            let deposit = if rng.chance(0.9) {
                max_spend
            } else {
                max_spend.saturating_sub(1)
            };
            Bid {
                bidder: format!("b{i}"),
                deposit,
                max_price: rng.chance(0.95).then_some(max_price),
                max_spend: Some(max_spend),
                mismatch: rng.chance(0.03),
            }
        })
        .collect();
    let floor_demand = bids
        .iter()
        .filter_map(|b| b.max_spend)
        .map(|spend| tokens_for(spend, floor, one).unwrap_or(MAX))
        .fold(0, u128::saturating_add);
    let sale_supply = if rng.chance(0.8) && floor_demand > 0 {
        1 + rng.wide() % floor_demand
    } else {
        rng.wide().max(1)
    };
    let max_price = rng
        .chance(0.2)
        .then(|| floor.saturating_add(rng.wide() >> rng.below(128)));
    let params = SaleParams {
        sale_supply,
        floor_price: floor,
        min_raise: 0,
        decimals,
        max_price,
    };
    (params, bids)
}

#[test]
fn both_searches_agree_on_5000_random_books() {
    let mut rng = SplitMix(0x5ea1_ed00);
    let (mut oversubscribed, mut errors, mut top_price_bits) = (0, 0, [0u32; 129]);
    for _ in 0..5_000 {
        let (params, bids) = random_book(&mut rng);
        // `both` asserts that the fixed-shape search gives the same result.
        match both(&params, &bids) {
            Ok(result) => {
                oversubscribed += usize::from(result.oversubscribed);
                if result.oversubscribed {
                    top_price_bits[(128 - result.clearing_price.leading_zeros()) as usize] += 1;
                }
            }
            Err(_) => errors += 1,
        }
    }
    // Most books run the search, and P* lands all over the u128 range
    // (counted by its bit length).
    assert!(oversubscribed >= 2_500, "{oversubscribed} oversubscribed");
    assert!(errors <= 1_000, "{errors} errors");
    let landed = |bits: core::ops::RangeInclusive<usize>| top_price_bits[bits].iter().sum::<u32>();
    assert!(landed(1..=16) >= 200, "{top_price_bits:?}");
    assert!(landed(17..=99) >= 200, "{top_price_bits:?}");
    assert!(landed(100..=128) >= 100, "{top_price_bits:?}");
}

/// Native time of both searches on 500-bid books. Not a check; run with
/// `cargo test --release -p fairground-clearing --test clear -- --ignored --nocapture`.
#[test]
#[ignore = "timing, not a check"]
fn time_both_searches_at_500_bids() {
    fn median(mut runs: Vec<Duration>) -> Duration {
        runs.sort();
        runs[runs.len() / 2]
    }
    let mut rng = SplitMix(500);
    // A realistic book: 18-decimal token, floor 0.001 USDC, prices up to 10x
    // the floor, spends up to 200 USDC; and the same book with one bid at
    // u128::MAX, the fast search's worst case (128 steps).
    let floor = 1_000;
    let realistic: Vec<Bid> = (0..500)
        .map(|i| {
            let spend = rng.range(1, usdc("200"));
            raw(
                &format!("bidder{i}.testnet"),
                spend,
                rng.range(floor, floor * 10),
                spend,
            )
        })
        .collect();
    let mut whale = realistic.clone();
    whale[250].max_price = Some(MAX);
    let params = SaleParams {
        sale_supply: tokens("10000000"),
        floor_price: floor,
        min_raise: 0,
        decimals: 18,
        max_price: None,
    };
    for (name, bids) in [("realistic", &realistic), ("one bid at u128::MAX", &whale)] {
        let result = both(&params, bids).unwrap();
        assert!(result.oversubscribed);
        for search in [PriceSearch::Fast, PriceSearch::FixedShape] {
            let runs: Vec<Duration> = (0..101)
                .map(|_| {
                    let start = Instant::now();
                    std::hint::black_box(clear_with(&params, std::hint::black_box(bids), search))
                        .unwrap();
                    start.elapsed()
                })
                .collect();
            println!(
                "{name}: 500 bids, P* = {}, {search:?}: median {:?} over {} runs",
                result.clearing_price,
                median(runs),
                101
            );
        }
    }
}
