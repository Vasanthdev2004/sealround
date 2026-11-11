//! TEE sales that settle: bids sealed to the sealer's key, cleared by the
//! real sealer logic behind OutLayer's real contract.

use anyhow::{Result, ensure};
use fairground_clearing::hash::{sha256, to_hex};
use fairground_integration::*;
use serde_json::json;

/// Demand below supply at the floor: every valid bid is filled in full at the
/// floor price, the unsold tokens are burned when the creator claims, and
/// the creator gets the raise, the allocation and the unused NEAR reserve.
#[tokio::test]
async fn undersubscribed_settles_and_pays_everyone() -> Result<()> {
    let env = Env::new("under").await?;
    let creator = env.account("creator", 30).await?;
    let stranger = env.account("stranger", 10).await?;
    let spec = SaleSpec::new("under", Mode::Tee);
    let sale = env.create_sale(&creator, spec.clone()).await?;

    // The token minted its whole supply to Fairground.
    let token_supply = env.ft_supply(&sale.token).await?;
    ensure!(token_supply == spec.total_supply);
    ensure!(env.ft_balance(&sale.token, env.fg()).await? == spec.total_supply);
    let created = event(&sale.create_tx, "sale_created").expect("sale_created");
    ensure!(u128_field(&created, "cost")? == sale.cost);
    let metadata = env.view(&sale.token, "ft_metadata", json!({})).await?;
    ensure!(
        metadata["symbol"] == "TEST" && metadata["decimals"] == 18,
        "{metadata}"
    );

    let bidders = env.bidders("b", 3, 2_000, 1_000 * USDC, None).await?;
    // At the floor (0.001 USDC/token) these buy 150k + 100k + 50k = 300k of 600k tokens.
    let plain = vec![
        PlainBid::new(bidders[0].id(), 200 * USDC, 2_000, 150 * USDC),
        PlainBid::new(bidders[1].id(), 100 * USDC, 1_500, 100 * USDC),
        PlainBid::new(bidders[2].id(), 50 * USDC, 1_000, 50 * USDC),
    ];
    env.wait_open(&sale).await?;
    for (bidder, bid) in bidders.iter().zip(&plain) {
        let placed = env
            .bid(
                &sale,
                bidder,
                bid.deposit,
                bid.max_price.unwrap(),
                bid.max_spend.unwrap(),
            )
            .await?;
        ensure!(
            placed.used == bid.deposit,
            "bid rejected: {:?}",
            rejection_reason(&placed.tx)
        );
        ensure!(event(&placed.tx, "bid_placed").is_some());
    }
    ensure!(env.usdc_balance(env.fg()).await? == 350 * USDC);

    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let (close, served) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(close.clone().json::<String>()? == "settled");

    let expected = expected_clearing(&spec, &plain);
    ensure!(!expected.oversubscribed && expected.clearing_price == spec.floor_price);
    let result = env.result_view(&sale.id).await?;
    ensure!(result["status"] == "settled", "{result}");
    ensure!(u128_field(&result, "clearing_price")? == expected.clearing_price);
    ensure!(u128_field(&result, "total_sold")? == 300_000 * TOKEN);
    ensure!(u128_field(&result, "total_raised")? == 300 * USDC);
    ensure!(u128_field(&result, "unsold")? == 300_000 * TOKEN);
    ensure!(result["n_valid"] == 3 && result["n_invalid"] == 0 && result["n_winners"] == 3);
    // The attestation hashes: input as stored by OutLayer, output exactly as
    // delivered (a JSON string in Text format).
    let output_bytes = serde_json::to_vec(&served.output)?;
    ensure!(
        result["result_sha256"] == to_hex(&sha256(&output_bytes)),
        "{result}"
    );
    ensure!(result["input_sha256"] == to_hex(&sha256(served.input.as_bytes())));
    let input: serde_json::Value = serde_json::from_str(&served.input)?;
    ensure!(input["bids"].as_array().map(Vec::len) == Some(3));
    ensure!(input["params"]["max_price"].is_null());
    env.check_fills(&sale, &plain, &expected, &[]).await?;

    // Bidders 0 and 2 claim themselves; the stranger pushes bidder 1's claim.
    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .map(|f| (f.tokens, f.refund))
        .collect();
    let refs: Vec<_> = bidders.iter().collect();
    env.claim_all(&sale, &refs, &owed, Some(&stranger)).await?;

    // Unused bid slots come back in full; every bid won, so no registration does.
    let per_bid = env.per_bid_reserve(&spec).await?;
    let near_refund = env
        .claim_proceeds_checked(
            &stranger,
            &sale,
            Proceeds {
                raise: 300 * USDC,
                allocation: 400_000 * TOKEN,
                burned: 300_000 * TOKEN,
            },
        )
        .await?;
    ensure!(
        near_refund == 17 * per_bid,
        "reserve refund {near_refund}, want 17 x {per_bid}"
    );
    ensure!(env.ft_supply(&sale.token).await? == 700_000 * TOKEN);
    ensure!(env.usdc_balance(env.fg()).await? == 0);
    ensure!(env.ft_balance(&sale.token, env.fg()).await? == 0);
    let proceeds = env.result_view(&sale.id).await?["proceeds"].clone();
    ensure!(
        proceeds
            == json!({"raise_paid": true, "allocation_paid": true, "unsold_burned": true, "reserve_returned": true})
    );
    Ok(())
}

/// Demand above supply with two bids tied at the clearing price: the tie is
/// prorated, higher bids are filled in full, lower bids get nothing, and
/// nothing is left to burn.
#[tokio::test]
async fn oversubscribed_with_ties_at_the_clearing_price() -> Result<()> {
    let env = Env::new("over").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("over", Mode::Tee);
    spec.sale_supply = 100_000 * TOKEN;
    let sale = env.create_sale(&creator, spec.clone()).await?;
    let bidders = env.bidders("b", 5, 2_000, 1_000 * USDC, None).await?;
    // Demand at 0.002 USDC: 50k + 50k + 30k = 130k > 100k; at any higher price only bidder 0.
    let plain = vec![
        PlainBid::new(bidders[0].id(), 100 * USDC, 3_000, 100 * USDC),
        PlainBid::new(bidders[1].id(), 120 * USDC, 2_000, 100 * USDC),
        PlainBid::new(bidders[2].id(), 60 * USDC, 2_000, 60 * USDC),
        PlainBid::new(bidders[3].id(), 100 * USDC, 1_500, 100 * USDC),
        PlainBid::new(bidders[4].id(), 50 * USDC, 1_000, 50 * USDC),
    ];
    let expected = expected_clearing(&spec, &plain);
    ensure!(expected.oversubscribed && expected.clearing_price == 2_000);
    ensure!(
        expected.fills[0].tokens == 50_000 * TOKEN,
        "bidder 0 above the price is filled in full"
    );
    let (b1, b2) = (&expected.fills[1], &expected.fills[2]);
    ensure!(
        b1.tokens > 0 && b1.tokens < 50_000 * TOKEN && b2.tokens > 0 && b2.tokens < 30_000 * TOKEN,
        "tie prorated"
    );
    ensure!(expected.fills[3].tokens == 0 && expected.fills[4].tokens == 0);
    ensure!(expected.total_sold == spec.sale_supply);

    env.wait_open(&sale).await?;
    for (bidder, bid) in bidders.iter().zip(&plain) {
        let placed = env
            .bid(
                &sale,
                bidder,
                bid.deposit,
                bid.max_price.unwrap(),
                bid.max_spend.unwrap(),
            )
            .await?;
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
    }
    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let (close, _) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(close.json::<String>()? == "settled");
    let result = env.result_view(&sale.id).await?;
    ensure!(u128_field(&result, "clearing_price")? == 2_000, "{result}");
    ensure!(u128_field(&result, "total_sold")? == spec.sale_supply);
    ensure!(u128_field(&result, "unsold")? == 0);
    ensure!(result["n_winners"] == 3);
    env.check_fills(&sale, &plain, &expected, &[]).await?;

    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .map(|f| (f.tokens, f.refund))
        .collect();
    let refs: Vec<_> = bidders.iter().collect();
    env.claim_all(&sale, &refs, &owed, None).await?;
    // Nothing unsold, so nothing burns; two bids won nothing, so their token
    // registrations come back with the 15 unused slots.
    let per_bid = env.per_bid_reserve(&spec).await?;
    let near_refund = env
        .claim_proceeds_checked(
            &closer,
            &sale,
            Proceeds {
                raise: expected.total_raised,
                allocation: 900_000 * TOKEN,
                burned: 0,
            },
        )
        .await?;
    ensure!(
        near_refund == 15 * per_bid + 2 * STORAGE_DEPOSIT,
        "reserve refund {near_refund}"
    );
    ensure!(env.ft_supply(&sale.token).await? == spec.total_supply);
    ensure!(env.usdc_balance(env.fg()).await? == 0);
    Ok(())
}

/// A ciphertext that does not open and a ciphertext copied from another
/// bidder are invalid: refunded minus the 1 % invalid-bid penalty, which
/// stays in Fairground, while the valid bids clear.
#[tokio::test]
async fn invalid_and_copied_ciphertexts_pay_the_penalty() -> Result<()> {
    let env = Env::new("inval").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("inval", Mode::Tee);
    spec.sale_supply = 100_000 * TOKEN;
    let sale = env.create_sale(&creator, spec.clone()).await?;
    let bidders = env.bidders("b", 4, 2_000, 1_000 * USDC, None).await?;
    env.wait_open(&sale).await?;

    // 0: valid; 1: random bytes of the right length; 2: bidder 0's exact
    // ciphertext (the contract takes it: bidder 2's id has the same length);
    // 3: valid.
    ensure!(sealed_len(&sale.id, bidders[0].id()) == sealed_len(&sale.id, bidders[2].id()));
    let copied = env.seal(&sale, bidders[0].id(), 4_000, 200 * USDC);
    let msgs = [
        tee_msg(&sale.id, &copied),
        tee_msg(&sale.id, &junk_ciphertext(&sale.id, bidders[1].id(), 9)),
        tee_msg(&sale.id, &copied),
        tee_msg(
            &sale.id,
            &env.seal(&sale, bidders[3].id(), 2_500, 100 * USDC),
        ),
    ];
    let deposits = [200 * USDC, 80 * USDC, 300 * USDC, 100 * USDC];
    for ((bidder, msg), deposit) in bidders.iter().zip(&msgs).zip(deposits) {
        let placed = env.deposit(bidder, deposit, msg).await?;
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
    }
    let plain = vec![
        PlainBid::new(bidders[0].id(), deposits[0], 4_000, 200 * USDC),
        PlainBid {
            max_price: None,
            max_spend: None,
            ..PlainBid::new(bidders[1].id(), deposits[1], 0, 0)
        },
        PlainBid {
            mismatch: true,
            ..PlainBid::new(bidders[2].id(), deposits[2], 4_000, 200 * USDC)
        },
        PlainBid::new(bidders[3].id(), deposits[3], 2_500, 100 * USDC),
    ];
    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let (close, served) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(close.json::<String>()? == "settled");
    let output: serde_json::Value = serde_json::from_str(&served.output)?;
    ensure!(
        output["n_invalid"] == 2 && output["n_valid"] == 2 && output["invalid"] == json!([1, 2]),
        "{output}"
    );
    ensure!(output["fills"][1] == json!(["0", "0"]) && output["fills"][2] == json!(["0", "0"]));
    ensure!(output["pubkey"] == env.sale_view(&sale.id).await?["sealer_pubkey"]);

    let expected = expected_clearing(&spec, &plain);
    ensure!(expected.n_invalid == 2);
    let penalties = invalid_penalties(&expected);
    ensure!(penalties == [0, deposits[1] / 100, deposits[2] / 100, 0]);
    let result = env.result_view(&sale.id).await?;
    ensure!(
        result["n_invalid"] == 2 && result["n_valid"] == 2,
        "{result}"
    );
    ensure!(u128_field(&result, "clearing_price")? == expected.clearing_price);
    ensure!(u128_field(&result, "total_penalties")? == penalties.iter().sum::<u128>());
    env.check_fills(&sale, &plain, &expected, &penalties)
        .await?;
    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .zip(&penalties)
        .map(|(f, penalty)| (f.tokens, f.refund - penalty))
        .collect();
    let refs: Vec<_> = bidders.iter().collect();
    env.claim_all(&sale, &refs, &owed, None).await?;
    env.claim_proceeds_checked(
        &closer,
        &sale,
        Proceeds {
            raise: expected.total_raised,
            allocation: spec.total_supply - spec.sale_supply,
            burned: spec.sale_supply - expected.total_sold,
        },
    )
    .await?;
    // The penalties are all that stays, locked in Fairground for good.
    ensure!(env.usdc_balance(env.fg()).await? == penalties.iter().sum::<u128>());
    Ok(())
}

/// Filling every bid slot with junk ciphertexts no longer blocks a sale for
/// free: honest bids are turned away (`sale_full`), the sale fails with no
/// valid bids, and each junk bid gets back its deposit minus 1 %.
#[tokio::test]
async fn junk_bids_that_fill_a_sale_pay_the_penalty() -> Result<()> {
    let env = Env::new("junk").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("junk", Mode::Tee);
    spec.max_bids = 3;
    let sale = env.create_sale(&creator, spec.clone()).await?;
    let bidders = env.bidders("b", 4, 2_000, 100 * USDC, None).await?;
    env.wait_open(&sale).await?;
    let deposit = spec.min_deposit;
    for (i, junker) in bidders[..3].iter().enumerate() {
        let msg = tee_msg(&sale.id, &junk_ciphertext(&sale.id, junker.id(), i as u8));
        let placed = env.deposit(junker, deposit, &msg).await?;
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
    }
    let honest = env
        .bid(&sale, &bidders[3], 50 * USDC, 2_000, 50 * USDC)
        .await?;
    ensure!(rejection_reason(&honest.tx).as_deref() == Some("sale_full"));

    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let (close, served) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(close.json::<String>()? == "failed");
    let output: serde_json::Value = serde_json::from_str(&served.output)?;
    ensure!(output["invalid"] == json!([0, 1, 2]), "{output}");
    let result = env.result_view(&sale.id).await?;
    let penalty = deposit.div_ceil(100);
    ensure!(
        result["fail_reason"] == "no_valid_bids"
            && u128_field(&result, "total_penalties")? == 3 * penalty,
        "{result}"
    );
    let owed = vec![(0, deposit - penalty); 3];
    let refs: Vec<_> = bidders[..3].iter().collect();
    env.claim_all(&sale, &refs, &owed, None).await?;
    ensure!(env.usdc_balance(env.fg()).await? == 3 * penalty);
    Ok(())
}

/// A sale with a max price: a bid above it counts at the ceiling, so the
/// clearing price never passes the ceiling.
#[tokio::test]
async fn max_price_ceiling_caps_the_clearing_price() -> Result<()> {
    let env = Env::new("ceil").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("ceil", Mode::Tee);
    spec.sale_supply = 100_000 * TOKEN;
    spec.max_price = Some(2_000);
    let sale = env.create_sale(&creator, spec.clone()).await?;
    let bidders = env.bidders("b", 2, 2_000, 1_000 * USDC, None).await?;
    // Uncapped, bidder 0 alone would clear 100k tokens at 0.003 USDC.
    let plain = vec![
        PlainBid::new(bidders[0].id(), 300 * USDC, 10_000, 300 * USDC),
        PlainBid::new(bidders[1].id(), 100 * USDC, 1_800, 100 * USDC),
    ];
    let uncapped = expected_clearing(
        &SaleSpec {
            max_price: None,
            ..spec.clone()
        },
        &plain,
    );
    ensure!(uncapped.clearing_price > 2_000);
    let expected = expected_clearing(&spec, &plain);
    ensure!(expected.clearing_price == 2_000);

    env.wait_open(&sale).await?;
    for (bidder, bid) in bidders.iter().zip(&plain) {
        let placed = env
            .bid(
                &sale,
                bidder,
                bid.deposit,
                bid.max_price.unwrap(),
                bid.max_spend.unwrap(),
            )
            .await?;
        ensure!(placed.accepted());
    }
    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let (close, served) = env.close_and_clear(&closer, &sale.id).await?;
    ensure!(close.json::<String>()? == "settled");
    let input: serde_json::Value = serde_json::from_str(&served.input)?;
    ensure!(input["params"]["max_price"] == "2000", "{input}");
    let result = env.result_view(&sale.id).await?;
    ensure!(u128_field(&result, "clearing_price")? == 2_000, "{result}");
    env.check_fills(&sale, &plain, &expected, &[]).await?;
    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .map(|f| (f.tokens, f.refund))
        .collect();
    let refs: Vec<_> = bidders.iter().collect();
    env.claim_all(&sale, &refs, &owed, None).await?;
    Ok(())
}
