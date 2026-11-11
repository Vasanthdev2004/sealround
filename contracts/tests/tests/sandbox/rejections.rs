//! Deposits Fairground must refuse. Each is returned in full by the token
//! (`ft_transfer_call` reports 0 used) with a `bid_rejected` event naming
//! the reason, and the bid book does not change.

use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_integration::*;
use near_workspaces::Account;
use near_workspaces::types::NearToken;
use serde_json::json;

/// Deposits `amount` with `msg` (through `token`) and checks it was refused
/// for `reason` and returned in full.
async fn refused(
    env: &Env,
    token: &near_workspaces::AccountId,
    from: &Account,
    amount: u128,
    msg: &str,
    reason: &str,
) -> Result<()> {
    let before = env.ft_balance(token, from.id()).await?;
    let attempt = env.deposit_with(token, from, amount, msg).await?;
    ensure!(
        attempt.used == 0,
        "{reason}: deposit kept ({})",
        attempt.used
    );
    let got = rejection_reason(&attempt.tx);
    ensure!(got.as_deref() == Some(reason), "want {reason}, got {got:?}");
    ensure!(
        env.ft_balance(token, from.id()).await? == before,
        "{reason}: balance changed"
    );
    Ok(())
}

#[tokio::test]
async fn bad_deposits_are_returned() -> Result<()> {
    let env = Env::new("rej").await?;
    let creator = env.account("creator", 30).await?;
    let mut spec = SaleSpec::new("rej", Mode::Tee);
    spec.max_bids = 3;
    spec.min_deposit = 5 * USDC;
    spec.max_deposit = 100 * USDC;
    spec.start_delay = 30;
    let sale = env.create_sale(&creator, spec).await?;
    let bidders = env.bidders("b", 5, 2_000, 1_000 * USDC, None).await?;
    let usdc = env.usdc.id().clone();
    let valid =
        |bidder: &Account| tee_msg(&sale.id, &env.seal(&sale, bidder.id(), 2_000, 50 * USDC));

    // Before the window opens.
    ensure!(env.status(&sale.id).await? == "upcoming");
    refused(
        &env,
        &usdc,
        &bidders[0],
        50 * USDC,
        &valid(&bidders[0]),
        "not_open",
    )
    .await?;
    env.wait_open(&sale).await?;
    ensure!(env.status(&sale.id).await? == "open");

    let b = &bidders[0];
    refused(&env, &usdc, b, 50 * USDC, "not json", "bad_msg").await?;
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &json!({"sale_id": sale.id, "ciphertext": "AAAA", "extra": 1}).to_string(),
        "bad_msg",
    )
    .await?;
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &tee_msg("nosuchsale", "AAAA"),
        "unknown_sale",
    )
    .await?;
    // A sale id too long for a storage key is never looked up (the read
    // would fail the receipt): refused like any unknown sale, logged as null.
    let long_id = tee_msg(&"x".repeat(3_000), "AAAA");
    refused(&env, &usdc, b, 50 * USDC, &long_id, "unknown_sale").await?;
    let attempt = env.deposit(b, 50 * USDC, &long_id).await?;
    ensure!(event(&attempt.tx, "bid_rejected").is_some_and(|e| e["sale_id"].is_null()));
    let commitment = json!({"sale_id": sale.id, "commitment": "00".repeat(32)}).to_string();
    refused(&env, &usdc, b, 50 * USDC, &commitment, "wrong_payload").await?;
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &tee_msg(&sale.id, "not base64!"),
        "bad_base64",
    )
    .await?;
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &tee_msg(&sale.id, ""),
        "bad_base64",
    )
    .await?;
    // 320 bytes (a sealed bid for a 32-byte sale id and a 64-byte bidder) is
    // the longest any bid can be.
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &tee_msg(&sale.id, &garbage_ciphertext(321, 1)),
        "ciphertext_too_long",
    )
    .await?;
    // Every other length but this bidder's exact one: a box one byte short,
    // and a real box of the old unpadded plaintext, whose length would show
    // how many digits the amounts have.
    let exact = sealed_len(&sale.id, b.id());
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &tee_msg(&sale.id, &garbage_ciphertext(exact - 1, 1)),
        "wrong_ciphertext_length",
    )
    .await?;
    let pubkey = sale.pubkey.context("sealer key")?;
    let unpadded = format!(
        r#"{{"sale_id":"{}","bidder":"{}","max_price":"2000","max_spend":"{}","salt":"{}"}}"#,
        sale.id,
        b.id(),
        50 * USDC,
        "ab".repeat(16)
    );
    let old_box = crypto_box::PublicKey::from(pubkey)
        .seal(&mut crypto_box::aead::OsRng, unpadded.as_bytes())
        .map_err(|_| anyhow::anyhow!("seal failed"))?;
    ensure!(old_box.len() < exact);
    refused(
        &env,
        &usdc,
        b,
        50 * USDC,
        &tee_msg(&sale.id, &BASE64.encode(old_box)),
        "wrong_ciphertext_length",
    )
    .await?;
    refused(&env, &usdc, b, 5 * USDC - 1, &valid(b), "below_min_deposit").await?;
    refused(
        &env,
        &usdc,
        b,
        100 * USDC + 1,
        &valid(b),
        "above_max_deposit",
    )
    .await?;

    // The limits themselves are accepted; one bid per account.
    let placed = env
        .deposit(&bidders[0], 5 * USDC, &valid(&bidders[0]))
        .await?;
    ensure!(placed.used == 5 * USDC);
    refused(
        &env,
        &usdc,
        &bidders[0],
        50 * USDC,
        &valid(&bidders[0]),
        "already_bid",
    )
    .await?;
    let placed = env
        .deposit(&bidders[1], 100 * USDC, &valid(&bidders[1]))
        .await?;
    ensure!(placed.used == 100 * USDC);
    // Any payload of exactly the right length gets in (the enclave finds this
    // one invalid).
    let placed = env
        .deposit(
            &bidders[2],
            50 * USDC,
            &tee_msg(&sale.id, &junk_ciphertext(&sale.id, bidders[2].id(), 2)),
        )
        .await?;
    ensure!(placed.accepted());
    refused(
        &env,
        &usdc,
        &bidders[3],
        50 * USDC,
        &valid(&bidders[3]),
        "sale_full",
    )
    .await?;

    // Another NEP-141 token, even with a valid bid in the msg.
    let fake = env.account("fakeusdc", 10).await?;
    let fake = fake
        .deploy(&std::fs::read(res("mock_ft.wasm"))?)
        .await?
        .into_result()?;
    fake.call("new")
        .args_json(json!({"name": "Fake USD", "symbol": "FUSD"}))
        .transact()
        .await?
        .into_result()?;
    fake.call("storage_deposit")
        .args_json(json!({"account_id": env.fg(), "registration_only": true}))
        .deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT))
        .transact()
        .await?
        .into_result()?;
    fake.call("mint")
        .args_json(json!({"account_id": bidders[4].id(), "amount": (100 * USDC).to_string()}))
        .transact()
        .await?
        .into_result()?;
    refused(
        &env,
        fake.id(),
        &bidders[4],
        50 * USDC,
        &valid(&bidders[4]),
        "wrong_token",
    )
    .await?;

    // After the window.
    env.wait_ended(&sale).await?;
    refused(
        &env,
        &usdc,
        &bidders[4],
        50 * USDC,
        &valid(&bidders[4]),
        "not_open",
    )
    .await?;

    let summary = env
        .view(env.fg(), "get_bids_summary", json!({"sale_id": sale.id}))
        .await?;
    ensure!(
        summary["count"] == 3 && summary["total_deposits"] == (155 * USDC).to_string(),
        "{summary}"
    );
    ensure!(env.usdc_balance(env.fg()).await? == 155 * USDC);
    ensure!(env.ft_balance(fake.id(), env.fg()).await? == 0);
    let bids = env
        .view(env.fg(), "get_bids", json!({"sale_id": sale.id}))
        .await?;
    let bidders_seen: Vec<&str> = bids
        .as_array()
        .context("bids")?
        .iter()
        .filter_map(|b| b["bidder"].as_str())
        .collect();
    ensure!(
        bidders_seen
            == [
                bidders[0].id().as_str(),
                bidders[1].id().as_str(),
                bidders[2].id().as_str()
            ]
    );
    Ok(())
}
