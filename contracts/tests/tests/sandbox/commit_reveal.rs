//! Commit-reveal sales: hash commitments, a reveal window, clearing on chain,
//! and the 1 % penalty on a bid that is never revealed or is revealed invalid.

use anyhow::{Result, ensure};
use fairground_integration::*;
use near_workspaces::types::Gas;
use serde_json::json;

#[tokio::test]
async fn commit_reveal_with_unrevealed_and_invalid_bids() -> Result<()> {
    let env = Env::new("cr").await?;
    let creator = env.account("creator", 30).await?;
    let spec = SaleSpec::new("cr", Mode::CommitReveal);
    let sale = env.create_sale(&creator, spec.clone()).await?;
    ensure!(
        sale.pubkey.is_none() && env.pending_requests().await?.is_empty(),
        "no sealer key in commit-reveal"
    );
    let bidders = env.bidders("b", 4, 2_000, 1_000 * USDC, None).await?;
    let plain = vec![
        PlainBid::new(bidders[0].id(), 300 * USDC, 3_000, 300 * USDC),
        PlainBid::new(bidders[1].id(), 100 * USDC, 2_000, 80 * USDC),
        PlainBid::new(bidders[2].id(), 101 * USDC, 2_500, 101 * USDC),
        // Below the 1000 floor: revealing it does not avoid the penalty.
        PlainBid::new(bidders[3].id(), 50 * USDC, 500, 50 * USDC),
    ];
    env.wait_open(&sale).await?;
    for (bidder, bid) in bidders.iter().zip(&plain) {
        let placed = env
            .commit(
                &sale,
                bidder,
                bid.deposit,
                bid.max_price.unwrap(),
                bid.max_spend.unwrap(),
            )
            .await?;
        ensure!(placed.accepted(), "{:?}", rejection_reason(&placed.tx));
    }
    // A ciphertext is the wrong payload for a commit-reveal sale.
    let stray = env.bidders("x", 1, 2_000, 10 * USDC, None).await?;
    let attempt = env
        .deposit(&stray[0], 10 * USDC, &tee_msg(&sale.id, "AAAA"))
        .await?;
    ensure!(attempt.used == 0 && rejection_reason(&attempt.tx).as_deref() == Some("wrong_payload"));

    // Revealing before the close is refused.
    expect_failure(
        &env.reveal(&sale, &bidders[0], 3_000, 300 * USDC).await?,
        "sale is open",
    )?;
    env.wait_ended(&sale).await?;
    let closer = env.account("closer", 10).await?;
    let close = closer
        .call(env.fg(), "close_sale")
        .args_json(json!({"sale_id": sale.id}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure_success(&close)?;
    ensure!(close.clone().json::<String>()? == "revealing");
    let closed = event(&close, "sale_closed").expect("sale_closed");
    let reveal_end: u64 = closed["reveal_end"].as_str().expect("reveal_end").parse()?;

    // A wrong reveal does not match the commitment; bidders 0, 1 and 3
    // reveal; 2 never does.
    expect_failure(
        &env.reveal(&sale, &bidders[0], 3_001, 300 * USDC).await?,
        "does not match the commitment",
    )?;
    for i in [0, 1, 3] {
        let bid = &plain[i];
        let tx = env
            .reveal(
                &sale,
                &bidders[i],
                bid.max_price.unwrap(),
                bid.max_spend.unwrap(),
            )
            .await?;
        ensure_success(&tx)?;
        ensure!(event(&tx, "bid_revealed").is_some());
    }
    expect_failure(
        &env.reveal(&sale, &bidders[0], 3_000, 300 * USDC).await?,
        "already revealed",
    )?;
    let early = closer
        .call(env.fg(), "clear_onchain")
        .args_json(json!({"sale_id": sale.id}))
        .transact()
        .await?;
    expect_failure(&early, "cannot clear on chain before")?;

    env.advance_to(reveal_end).await?;
    expect_failure(
        &env.reveal(&sale, &bidders[2], 2_500, 101 * USDC).await?,
        "cannot reveal a bid after",
    )?;
    let clear = closer
        .call(env.fg(), "clear_onchain")
        .args_json(json!({"sale_id": sale.id}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure_success(&clear)?;
    ensure!(clear.clone().json::<String>()? == "settled");

    let unrevealed = PlainBid {
        max_price: None,
        max_spend: None,
        ..plain[2].clone()
    };
    let cleared = [
        plain[0].clone(),
        plain[1].clone(),
        unrevealed,
        plain[3].clone(),
    ];
    let expected = expected_clearing(&spec, &cleared);
    // 1 % of 101 USDC rounded up, and 1 % of 50 USDC.
    let penalties = invalid_penalties(&expected);
    ensure!(penalties == [0, 0, (101 * USDC).div_ceil(100), USDC / 2]);
    let total_penalties: u128 = penalties.iter().sum();
    let result = env.result_view(&sale.id).await?;
    ensure!(
        result["status"] == "settled" && result["n_invalid"] == 2,
        "{result}"
    );
    ensure!(u128_field(&result, "clearing_price")? == expected.clearing_price);
    ensure!(u128_field(&result, "total_penalties")? == total_penalties);
    env.check_fills(&sale, &cleared, &expected, &penalties)
        .await?;

    let owed: Vec<(u128, u128)> = expected
        .fills
        .iter()
        .zip(&penalties)
        .map(|(f, penalty)| (f.tokens, f.refund - penalty))
        .collect();
    let refs: Vec<_> = bidders.iter().collect();
    env.claim_all(&sale, &refs, &owed, Some(&closer)).await?;
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
    // The penalties are all that stays: locked in Fairground for good.
    ensure!(env.usdc_balance(env.fg()).await? == total_penalties);
    Ok(())
}
