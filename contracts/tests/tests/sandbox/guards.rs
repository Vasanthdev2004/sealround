//! What only the runtime enforces: `#[init]` once, `#[private]` callbacks,
//! and `create_sale`'s argument and payment checks.

use anyhow::{Result, ensure};
use fairground_integration::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::test]
async fn init_and_private_methods_are_guarded() -> Result<()> {
    let env = Env::new("grd").await?;
    let stranger = env.account("stranger", 20).await?;

    // Fairground: initialised once, and only by its own account.
    let config = fairground_config(env.outlayer.id(), &[env.usdc.id()], None);
    let again = env
        .fairground
        .call("new")
        .args_json(config.clone())
        .transact()
        .await?;
    expect_failure(&again, "already been initialized")?;
    let other = env.account("fg2", 10).await?;
    let fresh = other
        .deploy(&std::fs::read(res("fairground.wasm"))?)
        .await?
        .into_result()?;
    let by_stranger = stranger
        .call(fresh.id(), "new")
        .args_json(config.clone())
        .transact()
        .await?;
    expect_failure(&by_stranger, "Method new is private")?;
    ensure!(
        env.view(env.fg(), "get_config", json!({})).await?["allowed_quote_tokens"]
            == json!([env.usdc.id()])
    );

    // Callbacks are private.
    for (method, args) in [
        (
            "on_clearing_result",
            json!({"sale_id": "x", "closer": stranger.id(), "deposit": "0"}),
        ),
        (
            "on_sealer_key",
            json!({"sale_id": "x", "payer": stranger.id(), "deposit": "0"}),
        ),
        ("on_token_deployed", json!({"sale_id": "x"})),
        ("on_quote_registered", json!({"quote_token": env.usdc.id()})),
        (
            "on_claim",
            json!({"sale_id": "x", "index": 0, "tokens": "1", "refund": "1"}),
        ),
        (
            "on_proceeds",
            json!({"sale_id": "x", "raise": "1", "allocation": "1", "burn": "1", "reserve": "1"}),
        ),
    ] {
        let tx = stranger
            .call(env.fg(), method)
            .args_json(args)
            .transact()
            .await?;
        expect_failure(&tx, &format!("Method {method} is private"))?;
    }

    // create_sale refuses unknown fields, too little NEAR and a quote token
    // that is not allowed, before anything is written.
    let creator = env.account("creator", 30).await?;
    let spec = SaleSpec::new("grd", Mode::Tee);
    let bid_start = env.now().await? + 600 * SECOND;
    let mut params = spec.params(bid_start, env.usdc.id());
    let cost = u128_value(
        &env.view(env.fg(), "get_create_cost", json!({"params": params}))
            .await?,
    )?;
    let create = |params: serde_json::Value, deposit: u128| {
        creator
            .call(env.fg(), "create_sale")
            .args_json(json!({"params": params}))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(Gas::from_tgas(300))
            .transact()
    };
    let mut misspelt = params.clone();
    misspelt["max_prise"] = json!("5000");
    expect_failure(&create(misspelt, cost).await?, "unknown field")?;
    expect_failure(
        &create(params.clone(), cost - 1).await?,
        "is below the required",
    )?;
    params["quote_token"] = json!(stranger.id());
    expect_failure(&create(params, cost).await?, "not an allowed quote token")?;
    ensure!(
        env.view(env.fg(), "get_sale", json!({"sale_id": "grd"}))
            .await?
            .is_null()
    );

    // The sale token: initialised once, ft_resolve_transfer private, no mint.
    let mut spec = SaleSpec::new("grdtok", Mode::CommitReveal);
    spec.icon = Some("data:image/svg+xml,<svg/>".to_owned());
    let sale = env.create_sale(&creator, spec).await?;
    let metadata = env.view(&sale.token, "ft_metadata", json!({})).await?;
    ensure!(
        metadata["icon"] == "data:image/svg+xml,<svg/>" && metadata["spec"] == "ft-1.0.0",
        "{metadata}"
    );
    let reinit = stranger
        .call(&sale.token, "new")
        .args_json(json!({
            "owner_id": stranger.id(),
            "total_supply": "1",
            "metadata": {"spec": "ft-1.0.0", "name": "X", "symbol": "X", "decimals": 0},
        }))
        .transact()
        .await?;
    expect_failure(&reinit, "already been initialized")?;
    let resolve = stranger
        .call(&sale.token, "ft_resolve_transfer")
        .args_json(json!({"sender_id": env.fg(), "receiver_id": stranger.id(), "amount": "1000"}))
        .transact()
        .await?;
    expect_failure(&resolve, "Method ft_resolve_transfer is private")?;
    let mint = stranger
        .call(&sale.token, "mint")
        .args_json(json!({"account_id": stranger.id(), "amount": "1"}))
        .transact()
        .await?;
    expect_failure(&mint, "MethodNotFound")?;
    ensure!(env.ft_balance(&sale.token, env.fg()).await? == sale.spec.total_supply);
    // The token account can pay for its own storage.
    let token_account = env.worker.view_account(&sale.token).await?;
    ensure!(
        token_account.balance.as_yoctonear()
            >= u128::from(token_account.storage_usage) * 10u128.pow(19)
    );
    Ok(())
}
