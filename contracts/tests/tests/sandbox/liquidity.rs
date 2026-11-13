//! Launch liquidity against the real Rhea exchange (`contracts/tests/res`):
//! a settled sale seeds a pool at the clearing price, the LP shares stay with
//! Fairground, and a pool that cannot be seeded is abandoned with every
//! token and USDC accounted for. The exchange's owner (the test) pauses it or
//! freezes tokens to make steps fail, as Rhea's owner and guardians can.

use anyhow::{Context, Result, ensure};
use fairground_clearing::ClearingResult;
use fairground_integration::*;
use near_workspaces::Account;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};

/// 12.34 % of the raise buys pool tokens at the clearing price, out of a
/// reserve of 100,000 tokens; a 0.3 % swap fee.
const TERMS: LiquidityTerms = LiquidityTerms {
    raise_share_bps: 1_234,
    pool_tokens: 100_000 * TOKEN,
    fee_bps: 30,
};
/// What wallets let a transaction attach.
const MAX_TGAS: u64 = 300;
/// What the relayer attaches at most.
const RELAYED_TGAS: u64 = 150;
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;

/// A TEE sale with launch liquidity, settled and not yet seeded.
pub(crate) struct Launched {
    pub(crate) env: Env,
    sale: Sale,
    bidders: Vec<Account>,
    /// Pushes calls for others: never paid by the sale.
    stranger: Account,
    expected: ClearingResult,
    close: ExecutionFinalResult,
    /// The pool's planned amounts.
    usdc: u128,
    tokens: u128,
}

/// Four bids, oversubscribed at 0.001337 USDC per token: the fourth bid is
/// out, the third is filled in part.
pub(crate) async fn launched(tag: &str) -> Result<Launched> {
    let env = Env::with_options(
        tag,
        EnvOptions {
            dex: true,
            ..EnvOptions::default()
        },
    )
    .await?;
    let creator = env.account("creator", 40).await?;
    let stranger = env.account("stranger", 20).await?;
    let mut spec = SaleSpec::new(tag, Mode::Tee);
    spec.liquidity = Some(TERMS.json());
    let sale = env.create_sale(&creator, spec.clone()).await?;
    let bidders = env.bidders("b", 4, 2_000, 1_000 * USDC, None).await?;
    let plain: Vec<PlainBid> = [1_500, 1_400, 1_337, 1_200]
        .iter()
        .zip(&bidders)
        .map(|(&price, bidder)| PlainBid::new(bidder.id(), 300 * USDC, price, 300 * USDC))
        .collect();
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
            placed.accepted(),
            "bid rejected: {:?}",
            rejection_reason(&placed.tx)
        );
    }
    env.wait_ended(&sale).await?;
    let (close, _) = env.close_and_clear(&stranger, &sale.id).await?;
    ensure!(close.clone().json::<String>()? == "settled");
    let expected = expected_clearing(&spec, &plain);
    ensure!(expected.oversubscribed && expected.clearing_price == 1_337);
    let (usdc, tokens) = pool_plan(
        expected.total_raised,
        expected.clearing_price,
        spec.decimals,
        TERMS.raise_share_bps,
        TERMS.pool_tokens,
    );
    ensure!(usdc > 0 && tokens > 0 && tokens < TERMS.pool_tokens);
    println!(
        "raise {} at {}: pool {usdc} USDC and {tokens} tokens",
        expected.total_raised, expected.clearing_price
    );
    Ok(Launched {
        env,
        sale,
        bidders,
        stranger,
        expected,
        close,
        usdc,
        tokens,
    })
}

impl Launched {
    pub(crate) async fn liquidity(&self) -> Result<Value> {
        self.env.liquidity(&self.sale.id).await
    }

    pub(crate) async fn seed(&self, tgas: u64) -> Result<ExecutionFinalResult> {
        let tx = self
            .env
            .seed_liquidity(&self.stranger, &self.sale.id, tgas)
            .await?;
        ensure_success(&tx).context("seed_liquidity")?;
        print_gas("seed_liquidity", &tx);
        Ok(tx)
    }

    pub(crate) async fn abandon(&self) -> Result<ExecutionFinalResult> {
        let tx = self
            .env
            .abandon_liquidity(&self.stranger, &self.sale.id, MAX_TGAS)
            .await?;
        ensure_success(&tx).context("abandon_liquidity")?;
        print_gas("abandon_liquidity", &tx);
        Ok(tx)
    }

    /// The deadline from `get_result`.
    pub(crate) async fn deadline(&self) -> Result<u64> {
        Ok(self.liquidity().await?["deadline"]
            .as_str()
            .context("no deadline")?
            .parse()?)
    }

    /// The creator's USDC, sale tokens and NEAR, and the token supply.
    async fn creator_balances(&self) -> Result<[u128; 4]> {
        let env = &self.env;
        let creator = &self.sale.creator;
        Ok([
            env.usdc_balance(creator).await?,
            env.ft_balance(&self.sale.token, creator).await?,
            env.near_balance(creator).await?,
            env.ft_supply(&self.sale.token).await?,
        ])
    }

    /// `claim_proceeds` pushed by the stranger. Checks what the creator got
    /// (USDC, tokens, NEAR as `get_reserve_refund` said) and what was burned.
    async fn proceeds(&self, raise: u128, allocation: u128, burned: u128) -> Result<()> {
        let env = &self.env;
        let reserve = u128_value(
            &env.view(
                env.fg(),
                "get_reserve_refund",
                json!({"sale_id": self.sale.id}),
            )
            .await?,
        )?;
        let before = self.creator_balances().await?;
        let tx = env.claim_proceeds(&self.stranger, &self.sale.id).await?;
        ensure_success(&tx).context("claim_proceeds")?;
        ensure!(tx.clone().json::<bool>()?, "claim_proceeds paid nothing");
        let claimed = event(&tx, "proceeds_claimed").context("no proceeds_claimed")?;
        ensure!(claimed["failed"] == json!([]), "{claimed}");
        let after = self.creator_balances().await?;
        let got = [
            after[0] - before[0],
            after[1] - before[1],
            after[2] - before[2],
            before[3] - after[3],
        ];
        ensure!(
            got == [raise, allocation, reserve, burned],
            "creator got {got:?} (USDC, tokens, NEAR, burned), want {:?}",
            [raise, allocation, reserve, burned]
        );
        Ok(())
    }

    /// Bidder `i` claims; checks the USDC and tokens it received.
    async fn claim(&self, i: usize, tokens: u128, refund: u128) -> Result<()> {
        let env = &self.env;
        let bidder = &self.bidders[i];
        let usdc_before = env.usdc_balance(bidder.id()).await?;
        let tokens_before = env.ft_balance(&self.sale.token, bidder.id()).await?;
        let tx = env.claim(bidder, &self.sale.id, None).await?;
        ensure_success(&tx).with_context(|| format!("claim {i}"))?;
        ensure!(tx.clone().json::<bool>()?, "claim {i} paid nothing");
        let got_usdc = env.usdc_balance(bidder.id()).await? - usdc_before;
        let got_tokens = env.ft_balance(&self.sale.token, bidder.id()).await? - tokens_before;
        ensure!(
            (got_tokens, got_usdc) == (tokens, refund),
            "bidder {i} got {got_tokens} tokens and {got_usdc} USDC, want {tokens} and {refund}"
        );
        Ok(())
    }

    /// Bidder `i`'s fill: `(tokens, refund)`.
    fn fill(&self, i: usize) -> (u128, u128) {
        let fill = &self.expected.fills[i];
        (fill.tokens, fill.deposit - fill.spent)
    }

    /// Nothing of this sale is left in Fairground or on the exchange.
    async fn nothing_left(&self) -> Result<()> {
        let env = &self.env;
        let fg = env.fg();
        ensure!(env.usdc_balance(fg).await? == 0, "USDC left in Fairground");
        ensure!(
            env.ft_balance(&self.sale.token, fg).await? == 0,
            "sale tokens left in Fairground"
        );
        ensure!(env.dex_deposit(fg, env.usdc.id()).await? == 0);
        ensure!(env.dex_deposit(fg, &self.sale.token).await? == 0);
        let refund = env
            .view(fg, "get_reserve_refund", json!({"sale_id": self.sale.id}))
            .await?;
        ensure!(refund == json!("0"), "reserve refund left: {refund}");
        let proceeds = &env.result_view(&self.sale.id).await?["proceeds"];
        ensure!(
            *proceeds
                == json!({
                    "raise_paid": true,
                    "allocation_paid": true,
                    "unsold_burned": true,
                    "reserve_returned": true,
                }),
            "{proceeds}"
        );
        Ok(())
    }
}

fn print_gas(label: &str, tx: &ExecutionFinalResult) {
    let total: f64 = receipt_gas(tx).iter().map(|line| line.tgas).sum();
    println!("{label}: {total:.1} TGas burnt");
    for line in receipt_gas(tx) {
        println!("  {:>6.2} TGas  {}", line.tgas, line.executor);
    }
}

fn step_failed(tx: &ExecutionFinalResult) -> Option<String> {
    event(tx, "liquidity_step_failed").and_then(|data| data["step"].as_str().map(str::to_owned))
}

/// The whole path: terms in `get_sale`, the plan at settlement, refunds but
/// no tokens before seeding, a paused exchange (the step fails and changes
/// nothing), then one 300 TGas call that seeds the pool at the clearing
/// price. The LP shares are Fairground's alone and nothing can take them out.
#[tokio::test]
async fn pool_is_seeded_at_the_clearing_price() -> Result<()> {
    let l = launched("lqs").await?;
    let env = &l.env;
    let fg = env.fg();
    let usdc = env.usdc.id();
    let token = &l.sale.token;

    // Terms and request blocks.
    let sale = env.sale_view(&l.sale.id).await?;
    ensure!(
        sale["liquidity"]
            == json!({
                "dex": env.dex().id(),
                "raise_share_bps": TERMS.raise_share_bps,
                "pool_tokens": TERMS.pool_tokens.to_string(),
                "fee_bps": TERMS.fee_bps,
            }),
        "{}",
        sale["liquidity"]
    );
    let spec = &l.sale.spec;
    let allocation = spec.total_supply - spec.sale_supply - TERMS.pool_tokens;
    ensure!(u128_field(&sale, "creator_allocation")? == allocation);
    ensure!(sale["key_request_block"].is_u64(), "{sale}");

    // Settlement fixed the plan.
    let planned = event(&l.close, "liquidity_planned").context("no liquidity_planned")?;
    ensure!(
        planned["stage"] == "seeding"
            && u128_field(&planned, "usdc")? == l.usdc
            && u128_field(&planned, "tokens")? == l.tokens
            && u128_field(&planned, "unused_tokens")? == TERMS.pool_tokens - l.tokens,
        "{planned}"
    );
    let result = env.result_view(&l.sale.id).await?;
    ensure!(result["clear_request_block"].is_u64(), "{result}");
    ensure!(
        u128_field(&result, "unsold")? == l.expected.unsold + TERMS.pool_tokens - l.tokens,
        "{result}"
    );
    let liquidity = &result["liquidity"];
    ensure!(
        liquidity["status"] == "seeding"
            && liquidity["next_step"] == "register"
            && liquidity["in_flight"].is_null()
            && liquidity["pool_id"].is_null()
            && liquidity["failures"] == 0,
        "{liquidity}"
    );

    // Before seeding, refunds are paid and tokens wait.
    let (_, refund) = l.fill(3);
    l.claim(3, 0, refund).await?;
    let (_, refund) = l.fill(2);
    ensure!(refund > 0);
    l.claim(2, 0, refund).await?;
    let again = env.claim(&l.bidders[2], &l.sale.id, None).await?;
    expect_failure(&again, "sale tokens stay locked")?;
    // The creator gets the raise less the pool's USDC; the unsold part of
    // the reserve is burned; the allocation waits.
    let raise = l.expected.total_raised - l.usdc;
    let burned = l.expected.unsold + TERMS.pool_tokens - l.tokens;
    l.proceeds(raise, 0, burned).await?;
    let again = env.claim_proceeds(&l.stranger, &l.sale.id).await?;
    expect_failure(&again, "sale tokens stay locked")?;
    expect_failure(
        &env.abandon_liquidity(&l.stranger, &l.sale.id, MAX_TGAS)
            .await?,
        "cannot abandon the launch pool before",
    )?;

    // A paused exchange: the step fails, nothing is registered, the run stops.
    env.pause_dex(true).await?;
    let tx = l.seed(MAX_TGAS).await?;
    ensure!(tx.clone().json::<String>()? == "seeding");
    ensure!(step_failed(&tx).as_deref() == Some("register"));
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["next_step"] == "register" && liquidity["failures"] == 1,
        "{liquidity}"
    );
    ensure!(
        env.dex_storage(fg).await?.is_null(),
        "registered on a paused exchange"
    );

    // Resumed: one call runs every step.
    env.pause_dex(false).await?;
    let tx = l.seed(MAX_TGAS).await?;
    ensure!(tx.clone().json::<String>()? == "seeded");
    ensure!(step_failed(&tx).is_none());
    let seeded = event(&tx, "liquidity_seeded").context("no liquidity_seeded")?;
    let pool_id = seeded["pool_id"].as_u64().context("pool_id")?;
    let shares = u128_field(&seeded, "shares")?;
    ensure!(shares > 0 && u128_field(&seeded, "price")? == l.expected.clearing_price);
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["status"] == "seeded"
            && liquidity["next_step"].is_null()
            && liquidity["in_flight"].is_null()
            && liquidity["pool_id"] == pool_id
            && u128_field(&liquidity, "shares")? == shares
            && u128_field(&liquidity, "usdc_on_dex")? == 0
            && u128_field(&liquidity, "tokens_on_dex")? == 0
            && liquidity["failures"] == 1,
        "{liquidity}"
    );

    // The pool: the sale token and USDC in the planned amounts, so its price
    // is the clearing price (at most one USDC base unit above it in total).
    let pool = env.dex_pool(pool_id).await?;
    println!("pool {pool_id}: {pool}");
    ensure!(
        pool["pool_kind"] == "SIMPLE_POOL"
            && pool["token_account_ids"] == json!([token, usdc])
            && pool["amounts"] == json!([l.tokens.to_string(), l.usdc.to_string()])
            && pool["total_fee"] == TERMS.fee_bps
            && u128_field(&pool, "shares_total_supply")? == shares,
        "{pool}"
    );
    let price = l.expected.clearing_price;
    let excess = l.usdc * TOKEN - l.tokens * price;
    ensure!(excess < TOKEN, "pool price off by {excess} / 1e18 USDC");
    // Every LP share is Fairground's; nothing is left on its exchange account.
    ensure!(env.dex_shares(pool_id, fg).await? == shares);
    ensure!(env.dex_deposit(fg, usdc).await? == 0 && env.dex_deposit(fg, token).await? == 0);
    let storage = env.dex_storage(fg).await?;
    println!("Fairground's storage on the exchange: {storage}");
    let account_deposit = fairground_const("DEX_ACCOUNT_BYTES") * YOCTO_PER_BYTE;
    ensure!(
        u128_field(&storage, "total")? == account_deposit,
        "{storage}"
    );

    // Nobody can take the liquidity out: others hold no shares, and
    // Fairground's code never names a method that moves or redeems them.
    let remove = l
        .stranger
        .call(env.dex().id(), "remove_liquidity")
        .args_json(
            json!({"pool_id": pool_id, "shares": shares.to_string(), "min_amounts": ["0", "0"]}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    ensure!(remove.is_failure(), "a stranger removed liquidity");
    let transfer = l
        .stranger
        .call(env.dex().id(), "mft_transfer")
        .args_json(json!({"token_id": format!(":{pool_id}"), "receiver_id": l.stranger.id(), "amount": shares.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    ensure!(transfer.is_failure(), "a stranger moved LP shares");
    let wasm = std::fs::read(res("fairground.wasm"))?;
    let names = |needle: &str| wasm.windows(needle.len()).any(|w| w == needle.as_bytes());
    ensure!(names("add_liquidity") && names("add_simple_pool"));
    for method in [
        "remove_liquidity",
        "mft_transfer",
        "mft_register",
        "withdraw_owner_token",
    ] {
        ensure!(!names(method), "fairground.wasm names {method}");
    }
    expect_failure(
        &env.seed_liquidity(&l.stranger, &l.sale.id, MAX_TGAS)
            .await?,
        "cannot seed liquidity: launch liquidity is seeded",
    )?;
    expect_failure(
        &env.abandon_liquidity(&l.stranger, &l.sale.id, MAX_TGAS)
            .await?,
        "cannot abandon the launch pool: launch liquidity is seeded",
    )?;
    ensure!(env.dex_shares(pool_id, fg).await? == shares);
    ensure!(env.dex_pool(pool_id).await?["amounts"] == pool["amounts"]);

    // Tokens unlock: every winner's tokens, then the creator's allocation and
    // the NEAR the steps did not spend.
    for i in 0..3 {
        let (tokens, refund) = l.fill(i);
        // Bidder 2 took its refund before the pool was seeded.
        let refund = if i == 2 { 0 } else { refund };
        l.claim(i, tokens, refund).await?;
    }
    l.proceeds(0, allocation, 0).await?;
    l.nothing_left().await?;
    Ok(())
}

/// The exchange takes the USDC but not the frozen sale token, and then not
/// the USDC back either: seeding fails until the deadline, the pool is
/// abandoned, tokens unlock at once, and the USDC follows when the exchange
/// lets it go. Every token and USDC ends with a bidder or the creator, or
/// burned.
#[tokio::test]
async fn unseeded_pool_is_abandoned_and_nothing_is_stranded() -> Result<()> {
    let l = launched("lqa").await?;
    let env = &l.env;
    let fg = env.fg();
    let usdc = env.usdc.id();
    let token = &l.sale.token;
    let allocation = l.sale.spec.total_supply - l.sale.spec.sale_supply - TERMS.pool_tokens;

    env.freeze_on_dex(&[token], true).await?;
    let tx = l.seed(MAX_TGAS).await?;
    ensure!(step_failed(&tx).as_deref() == Some("deposit"));
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["next_step"] == "deposit"
            && liquidity["pool_id"].is_u64()
            && u128_field(&liquidity, "usdc_on_dex")? == l.usdc
            && u128_field(&liquidity, "tokens_on_dex")? == 0
            && liquidity["failures"] == 1,
        "{liquidity}"
    );
    // A retry sends only what is missing.
    let tx = l.seed(MAX_TGAS).await?;
    ensure!(step_failed(&tx).as_deref() == Some("deposit"));
    ensure!(env.dex_deposit(fg, usdc).await? == l.usdc);
    ensure!(env.dex_deposit(fg, token).await? == 0);
    ensure!(l.liquidity().await?["failures"] == 2);

    // Past the deadline, with the USDC frozen too: seeding is over, the pool
    // is abandoned, the withdrawal fails and can be retried.
    env.freeze_on_dex(&[usdc], true).await?;
    env.advance_to(l.deadline().await?).await?;
    expect_failure(
        &env.seed_liquidity(&l.stranger, &l.sale.id, MAX_TGAS)
            .await?,
        "cannot seed liquidity after",
    )?;
    let tx = l.abandon().await?;
    let abandoned = event(&tx, "liquidity_abandoned").context("no liquidity_abandoned")?;
    ensure!(
        u128_field(&abandoned, "usdc_on_dex")? == l.usdc
            && u128_field(&abandoned, "tokens_on_dex")? == 0,
        "{abandoned}"
    );
    let withdrawn = event(&tx, "liquidity_withdrawn").context("no liquidity_withdrawn")?;
    ensure!(withdrawn["failed"] == json!(["usdc"]), "{withdrawn}");
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["status"] == "abandoned"
            && liquidity["next_step"] == "withdraw"
            && u128_field(&liquidity, "usdc_on_dex")? == l.usdc
            && liquidity["failures"] == 3,
        "{liquidity}"
    );

    // Tokens are unlocked: bidders take theirs, the creator gets the
    // allocation and the raise less what is still on the exchange, and the
    // whole reserve is burned.
    for i in 0..4 {
        let (tokens, refund) = l.fill(i);
        l.claim(i, tokens, refund).await?;
    }
    l.proceeds(
        l.expected.total_raised - l.usdc,
        allocation,
        l.expected.unsold + TERMS.pool_tokens,
    )
    .await?;

    // The exchange lets the USDC go: it comes back and goes to the creator.
    env.freeze_on_dex(&[token, usdc], false).await?;
    let tx = l.abandon().await?;
    let withdrawn = event(&tx, "liquidity_withdrawn").context("no liquidity_withdrawn")?;
    ensure!(
        withdrawn["failed"] == json!([]) && u128_field(&withdrawn, "usdc")? == l.usdc,
        "{withdrawn}"
    );
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["next_step"].is_null() && u128_field(&liquidity, "usdc_on_dex")? == 0,
        "{liquidity}"
    );
    l.proceeds(l.usdc, 0, 0).await?;
    let again = env.claim_proceeds(&l.stranger, &l.sale.id).await?;
    ensure_success(&again)?;
    ensure!(!again.json::<bool>()?, "claim_proceeds paid twice");
    let tx = l.abandon().await?;
    ensure!(tx.clone().json::<String>()? == "abandoned");
    ensure!(
        tx.logs()
            .iter()
            .any(|line| line.contains("nothing left on the dex")),
        "{:?}",
        tx.logs()
    );
    l.nothing_left().await?;
    Ok(())
}

/// The relayer attaches at most 150 TGas: each call runs the steps it has
/// gas for, and a few calls seed the pool.
#[tokio::test]
async fn relayed_calls_seed_the_pool_step_by_step() -> Result<()> {
    let l = launched("lqr").await?;
    let mut calls = 0;
    loop {
        let tx = l.seed(RELAYED_TGAS).await?;
        ensure!(step_failed(&tx).is_none());
        calls += 1;
        let status: String = tx.json()?;
        println!(
            "call {calls}: {status}, next {}",
            l.liquidity().await?["next_step"]
        );
        if status == "seeded" {
            break;
        }
        ensure!(calls < 4, "not seeded after {calls} calls");
    }
    let liquidity = l.liquidity().await?;
    let pool_id = liquidity["pool_id"].as_u64().context("pool_id")?;
    let pool = l.env.dex_pool(pool_id).await?;
    ensure!(
        pool["amounts"] == json!([l.tokens.to_string(), l.usdc.to_string()]),
        "{pool}"
    );
    // Seeded: the tokens are free.
    let (tokens, refund) = l.fill(0);
    l.claim(0, tokens, refund).await?;
    Ok(())
}

/// The NEAR the contract attaches for the exchange's storage covers the
/// worst case: 64-character ids for both tokens and for the account that
/// holds the LP shares. Measured with plain calls from such an account.
#[tokio::test]
async fn exchange_storage_matches_the_constants() -> Result<()> {
    let env = Env::with_options(
        "lqm",
        EnvOptions {
            dex: true,
            ..EnvOptions::default()
        },
    )
    .await?;
    let dex = env.dex().id().clone();
    let one_yocto = NearToken::from_yoctonear(1);
    let code = std::fs::read(res("mock_ft.wasm"))?;
    let token_accounts = env.bidders("t", 2, 3_000, 0, Some(64)).await?;
    let lp = env.bidders("p", 1, 3_000, 0, Some(64)).await?.remove(0);
    let mut tokens = Vec::new();
    for (i, account) in token_accounts.iter().enumerate() {
        let token = account.deploy(&code).await?.into_result()?;
        token
            .call("new")
            .args_json(json!({"name": format!("Long {i}"), "symbol": "LONG"}))
            .transact()
            .await?
            .into_result()?;
        for who in [lp.id(), &dex] {
            account
                .call(token.id(), "mint")
                .args_json(json!({"account_id": who, "amount": "1000000"}))
                .transact()
                .await?
                .into_result()?;
        }
        tokens.push(token.id().clone());
    }
    ensure!(tokens.iter().chain([lp.id()]).all(|id| id.len() == 64));

    // The LP's exchange account with both tokens registered.
    lp.call(&dex, "storage_deposit")
        .args_json(json!({"account_id": lp.id(), "registration_only": false}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    lp.call(&dex, "register_tokens")
        .args_json(json!({"token_ids": tokens}))
        .deposit(one_yocto)
        .transact()
        .await?
        .into_result()?;
    let storage = env.dex_storage(lp.id()).await?;
    let account_bytes =
        (u128_field(&storage, "total")? - u128_field(&storage, "available")?) / YOCTO_PER_BYTE;
    for token in &tokens {
        let deposit = lp
            .call(token, "ft_transfer_call")
            .args_json(json!({"receiver_id": dex, "amount": "1000", "msg": ""}))
            .deposit(one_yocto)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        ensure_success(&deposit)?;
        ensure!(deposit.json::<String>()? == "1000", "deposit refused");
    }

    // The pool record, then the LP share record.
    let before = env.storage_usage(&dex).await?;
    let pool = lp
        .call(&dex, "add_simple_pool")
        .args_json(json!({"tokens": tokens, "fee": TERMS.fee_bps}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    ensure_success(&pool)?;
    let pool_id: u64 = pool.json()?;
    let after_pool = env.storage_usage(&dex).await?;
    let added = lp
        .call(&dex, "add_liquidity")
        .args_json(json!({"pool_id": pool_id, "amounts": ["1000", "1000"], "min_amounts": ["1000", "1000"]}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    ensure_success(&added)?;
    let after_lp = env.storage_usage(&dex).await?;
    let pool_bytes = u128::from(after_pool - before);
    let lp_bytes = u128::from(after_lp - after_pool);
    println!(
        "exchange storage: account {account_bytes} bytes, pool {pool_bytes} bytes, LP record {lp_bytes} bytes"
    );
    ensure!(account_bytes == fairground_const("DEX_ACCOUNT_BYTES"));
    let pool_deposit = fairground_const("POOL_STORAGE_DEPOSIT");
    let lp_deposit = fairground_const("LP_STORAGE_DEPOSIT");
    ensure!(
        pool_bytes * YOCTO_PER_BYTE <= pool_deposit,
        "pool needs {pool_bytes} bytes, POOL_STORAGE_DEPOSIT pays {}",
        pool_deposit / YOCTO_PER_BYTE
    );
    ensure!(
        lp_bytes * YOCTO_PER_BYTE <= lp_deposit,
        "LP record needs {lp_bytes} bytes, LP_STORAGE_DEPOSIT pays {}",
        lp_deposit / YOCTO_PER_BYTE
    );
    Ok(())
}

/// Both deposits made, the pool never filled (the run stopped before
/// `add_liquidity` and nobody called again): after the deadline both come
/// back, the creator gets the USDC and the tokens are burned.
#[tokio::test]
async fn deposited_pool_is_abandoned_and_both_tokens_come_back() -> Result<()> {
    let l = deposited("lqd").await?;
    let env = &l.env;
    let allocation = l.sale.spec.total_supply - l.sale.spec.sale_supply - TERMS.pool_tokens;
    // Tokens stay locked until the deadline passes and someone abandons;
    // bidder 2 (filled in part) takes its refund meanwhile.
    let (tokens, refund) = l.fill(2);
    ensure!(refund > 0);
    l.claim(2, 0, refund).await?;
    expect_failure(
        &env.claim(&l.bidders[0], &l.sale.id, None).await?,
        "sale tokens stay locked",
    )?;
    env.advance_to(l.deadline().await?).await?;
    let tx = l.abandon().await?;
    let withdrawn = event(&tx, "liquidity_withdrawn").context("no liquidity_withdrawn")?;
    ensure!(
        withdrawn["failed"] == json!([])
            && u128_field(&withdrawn, "usdc")? == l.usdc
            && u128_field(&withdrawn, "tokens")? == l.tokens,
        "{withdrawn}"
    );
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["status"] == "abandoned" && liquidity["next_step"].is_null(),
        "{liquidity}"
    );
    l.claim(2, tokens, 0).await?;
    for i in [0, 1, 3] {
        let (tokens, refund) = l.fill(i);
        l.claim(i, tokens, refund).await?;
    }
    l.proceeds(
        l.expected.total_raised,
        allocation,
        l.expected.unsold + TERMS.pool_tokens,
    )
    .await?;
    l.nothing_left().await
}

/// A launched sale whose two relayed calls registered, created the pool and
/// deposited both amounts, stopping before `add_liquidity`.
pub(crate) async fn deposited(tag: &str) -> Result<Launched> {
    let l = launched(tag).await?;
    for _ in 0..2 {
        let tx = l.seed(RELAYED_TGAS).await?;
        ensure!(step_failed(&tx).is_none());
    }
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["next_step"] == "add_liquidity"
            && u128_field(&liquidity, "usdc_on_dex")? == l.usdc
            && u128_field(&liquidity, "tokens_on_dex")? == l.tokens,
        "{liquidity}"
    );
    Ok(l)
}

/// A step whose result never came (its callback receipt failed) blocks the
/// next call until `STEP_TIMEOUT_BLOCKS` have passed; then one call reads
/// Fairground's balances and LP shares from the real exchange and carries on.
/// The test fakes the lost result by rewriting Fairground's record after both
/// deposits went through: the record says the deposit step is still in
/// flight and nothing reached the exchange.
#[tokio::test]
async fn a_lost_result_is_read_from_the_exchange() -> Result<()> {
    let l = deposited("lqr").await?;
    let env = &l.env;
    let fg = env.fg();
    let allocation = l.sale.spec.total_supply - l.sale.spec.sale_supply - TERMS.pool_tokens;
    let started = env.height().await?;
    let before = env
        .patch_liquidity(&l.sale.id, &TERMS, |record| {
            record.in_flight = Some(step::DEPOSIT);
            record.started_at = started;
            record.tokens_on_dex = 0;
            record.usdc_on_dex = 0;
        })
        .await?;
    ensure!(
        before.in_flight.is_none()
            && (before.tokens_on_dex, before.usdc_on_dex) == (l.tokens, l.usdc),
        "{before:?}"
    );
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["in_flight"] == "deposit"
            && liquidity["next_step"].is_null()
            && u128_field(&liquidity, "usdc_on_dex")? == 0
            && u128_field(&liquidity, "tokens_on_dex")? == 0,
        "{liquidity}"
    );
    // Until the timeout the step counts as running (checked 50 blocks
    // before it: a call lands a few blocks after it is sent).
    expect_failure(
        &env.seed_liquidity(&l.stranger, &l.sale.id, MAX_TGAS)
            .await?,
        "waiting for its result",
    )?;
    let timeout = step_timeout_blocks();
    let height = env.worker.view_block().await?.height();
    env.worker
        .fast_forward(started + timeout - height - 50)
        .await?;
    let tx = env
        .seed_liquidity(&l.stranger, &l.sale.id, MAX_TGAS)
        .await?;
    let landed = env.worker.view_block().await?.height();
    println!("busy check at block {landed}, the step started at {started}");
    expect_failure(&tx, "waiting for its result")?;
    env.worker.fast_forward(50).await?;
    ensure!(env.now().await? < l.deadline().await?, "past the deadline");
    ensure!(l.liquidity().await?["next_step"] == "reconcile");

    // One call reads the exchange (both deposits are there, no LP shares),
    // then adds the liquidity.
    let tx = l.seed(MAX_TGAS).await?;
    ensure!(tx.clone().json::<String>()? == "seeded");
    let lost = event(&tx, "liquidity_step_lost").context("no liquidity_step_lost")?;
    ensure!(lost["step"] == "deposit", "{lost}");
    let read = event(&tx, "liquidity_reconciled").context("no liquidity_reconciled")?;
    ensure!(
        u128_field(&read, "tokens_on_dex")? == l.tokens
            && u128_field(&read, "usdc_on_dex")? == l.usdc
            && u128_field(&read, "shares")? == 0,
        "{read}"
    );
    let seeded = event(&tx, "liquidity_seeded").context("no liquidity_seeded")?;
    let pool_id = seeded["pool_id"].as_u64().context("pool_id")?;
    let shares = u128_field(&seeded, "shares")?;
    let pool = env.dex_pool(pool_id).await?;
    ensure!(
        pool["amounts"] == json!([l.tokens.to_string(), l.usdc.to_string()])
            && u128_field(&pool, "shares_total_supply")? == shares,
        "{pool}"
    );
    ensure!(env.dex_shares(pool_id, fg).await? == shares);
    ensure!(
        env.dex_deposit(fg, env.usdc.id()).await? == 0
            && env.dex_deposit(fg, &l.sale.token).await? == 0
    );
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["status"] == "seeded"
            && liquidity["in_flight"].is_null()
            && liquidity["failures"] == 1,
        "{liquidity}"
    );

    // The books close as for any seeded pool.
    for i in 0..4 {
        let (tokens, refund) = l.fill(i);
        if tokens > 0 || refund > 0 {
            l.claim(i, tokens, refund).await?;
        }
    }
    l.proceeds(
        l.expected.total_raised - l.usdc,
        allocation,
        l.expected.unsold + TERMS.pool_tokens - l.tokens,
    )
    .await?;
    l.nothing_left().await
}

/// The pool was created but `add_simple_pool`'s result never came back: the
/// read finds the pool on the exchange (skipping a stranger's pools of the
/// same tokens the other way round or at another fee) and seeds it, without
/// creating a second one. Faked as above: after one relayed call registered
/// and created the pool, the record is rewritten to say the pool step is
/// still in flight, with the search starting at pool 0.
#[tokio::test]
async fn a_lost_pool_result_is_found_on_the_exchange() -> Result<()> {
    let l = launched("lqp").await?;
    let env = &l.env;
    let fg = env.fg();
    let usdc = env.usdc.id();
    let token = &l.sale.token;
    let allocation = l.sale.spec.total_supply - l.sale.spec.sale_supply - TERMS.pool_tokens;
    // Anyone may create pools: pools 0 and 1 hold the same tokens, the other
    // way round and at another fee.
    for (tokens, fee) in [
        (json!([usdc, token]), TERMS.fee_bps),
        (json!([token, usdc]), 25),
    ] {
        let tx = l
            .stranger
            .call(env.dex().id(), "add_simple_pool")
            .args_json(json!({"tokens": tokens, "fee": fee}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?;
        ensure_success(&tx).context("stranger's add_simple_pool")?;
    }
    let tx = l.seed(RELAYED_TGAS).await?;
    ensure!(step_failed(&tx).is_none());
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["pool_id"] == 2 && liquidity["next_step"] == "deposit",
        "{liquidity}"
    );
    let started = env.height().await?;
    let before = env
        .patch_liquidity(&l.sale.id, &TERMS, |record| {
            record.pool_id = None;
            record.in_flight = Some(step::CREATE_POOL);
            record.started_at = started;
            record.pool_search = Some(0);
        })
        .await?;
    ensure!(
        before.pool_search.is_none() && before.pool_id == Some(2),
        "{before:?}"
    );
    ensure!(l.liquidity().await?["in_flight"] == "create_pool");
    env.worker.fast_forward(step_timeout_blocks()).await?;
    ensure!(env.now().await? < l.deadline().await?, "past the deadline");

    let tx = l.seed(MAX_TGAS).await?;
    ensure!(tx.clone().json::<String>()? == "seeded");
    let lost = event(&tx, "liquidity_step_lost").context("no liquidity_step_lost")?;
    ensure!(lost["step"] == "create_pool", "{lost}");
    let read = event(&tx, "liquidity_reconciled").context("no liquidity_reconciled")?;
    ensure!(read["pool_id"] == 2, "{read}");
    let seeded = event(&tx, "liquidity_seeded").context("no liquidity_seeded")?;
    ensure!(seeded["pool_id"] == 2, "{seeded}");
    ensure!(
        env.view(env.dex().id(), "get_number_of_pools", json!({}))
            .await?
            == json!(3),
        "a second pool was created"
    );
    ensure!(env.dex_pool(2).await?["amounts"] == json!([l.tokens.to_string(), l.usdc.to_string()]));
    ensure!(env.dex_shares(2, fg).await? == u128_field(&seeded, "shares")?);
    for pool_id in [0, 1] {
        ensure!(env.dex_pool(pool_id).await?["shares_total_supply"] == "0");
    }
    for i in 0..4 {
        let (tokens, refund) = l.fill(i);
        if tokens > 0 || refund > 0 {
            l.claim(i, tokens, refund).await?;
        }
    }
    l.proceeds(
        l.expected.total_raised - l.usdc,
        allocation,
        l.expected.unsold + TERMS.pool_tokens - l.tokens,
    )
    .await?;
    l.nothing_left().await
}

/// Two callers push `seed_liquidity` at once: the second finds the run busy
/// (or already done), and each step runs once. No deposit is doubled.
#[tokio::test]
async fn concurrent_seed_calls_run_each_step_once() -> Result<()> {
    let l = launched("lqc").await?;
    let env = &l.env;
    let fg = env.fg();
    let send = |caller: &Account| {
        caller
            .call(fg, "seed_liquidity")
            .args_json(json!({"sale_id": l.sale.id}))
            .gas(Gas::from_tgas(MAX_TGAS))
            .transact_async()
    };
    let first = send(&l.stranger).await?;
    let second = send(&l.bidders[3]).await?;
    let (first, second) = (first.await?, second.await?);
    let outcomes = [&first, &second].map(|tx| {
        let failure = tx
            .clone()
            .into_result()
            .err()
            .map(|error| format!("{error:?}"));
        (tx.is_success(), failure)
    });
    println!("concurrent seed_liquidity: {outcomes:?}");
    ensure!(
        outcomes.iter().filter(|(ok, _)| *ok).count() == 1,
        "one call seeds: {outcomes:?}"
    );
    let refused = outcomes
        .iter()
        .find_map(|(_, failure)| failure.clone())
        .unwrap_or_default();
    ensure!(
        refused.contains("waiting for its result")
            || refused.contains("launch liquidity is seeded"),
        "{refused}"
    );
    let seeded = [&first, &second]
        .into_iter()
        .find_map(|tx| event(tx, "liquidity_seeded"))
        .context("no liquidity_seeded")?;
    let pool_id = seeded["pool_id"].as_u64().context("pool_id")?;
    // One pool, the planned amounts, nothing left over on the exchange.
    ensure!(
        env.view(env.dex().id(), "get_number_of_pools", json!({}))
            .await?
            == json!(1)
    );
    ensure!(
        env.dex_pool(pool_id).await?["amounts"]
            == json!([l.tokens.to_string(), l.usdc.to_string()])
    );
    ensure!(
        env.dex_deposit(fg, env.usdc.id()).await? == 0
            && env.dex_deposit(fg, &l.sale.token).await? == 0
    );
    let liquidity = l.liquidity().await?;
    ensure!(
        liquidity["status"] == "seeded" && liquidity["failures"] == 0,
        "{liquidity}"
    );
    Ok(())
}

/// Two callers push `abandon_liquidity` at once after the deadline: the
/// deposits come back once, and the second call finds the withdrawal busy or
/// nothing left to withdraw.
#[tokio::test]
async fn concurrent_abandon_calls_withdraw_once() -> Result<()> {
    let l = deposited("lqa").await?;
    let env = &l.env;
    let fg = env.fg();
    let allocation = l.sale.spec.total_supply - l.sale.spec.sale_supply - TERMS.pool_tokens;
    env.advance_to(l.deadline().await?).await?;
    let send = |caller: &Account| {
        caller
            .call(fg, "abandon_liquidity")
            .args_json(json!({"sale_id": l.sale.id}))
            .gas(Gas::from_tgas(MAX_TGAS))
            .transact_async()
    };
    let first = send(&l.stranger).await?;
    let second = send(&l.bidders[3]).await?;
    let (first, second) = (first.await?, second.await?);
    let withdrawn: Vec<Value> = [&first, &second]
        .into_iter()
        .flat_map(|tx| events(tx).into_iter())
        .filter(|(name, _)| name == "liquidity_withdrawn")
        .map(|(_, data)| data)
        .collect();
    println!(
        "concurrent abandon_liquidity: {:?}, withdrawn {withdrawn:?}",
        [first.is_success(), second.is_success()]
    );
    ensure!(withdrawn.len() == 1, "{withdrawn:?}");
    ensure!(
        u128_field(&withdrawn[0], "tokens")? == l.tokens
            && u128_field(&withdrawn[0], "usdc")? == l.usdc
            && withdrawn[0]["failed"] == json!([]),
        "{withdrawn:?}"
    );
    let abandoned = [&first, &second]
        .into_iter()
        .filter(|tx| event(tx, "liquidity_abandoned").is_some())
        .count();
    ensure!(abandoned == 1, "abandoned {abandoned} times");
    for tx in [&first, &second] {
        if let Err(error) = tx.clone().into_result() {
            ensure!(
                format!("{error:?}").contains("waiting for its result"),
                "{error:?}"
            );
        }
    }
    // A third call has nothing to do.
    let tx = l.abandon().await?;
    ensure!(tx.clone().json::<String>()? == "abandoned");
    ensure!(tx.logs().iter().any(|line| line.contains("nothing left")));
    ensure!(
        env.dex_deposit(fg, env.usdc.id()).await? == 0
            && env.dex_deposit(fg, &l.sale.token).await? == 0
    );
    for i in 0..4 {
        let (tokens, refund) = l.fill(i);
        if tokens > 0 || refund > 0 {
            l.claim(i, tokens, refund).await?;
        }
    }
    l.proceeds(
        l.expected.total_raised,
        allocation,
        l.expected.unsold + TERMS.pool_tokens,
    )
    .await?;
    l.nothing_left().await
}
