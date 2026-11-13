//! Sales from the outside: create, bid, close, claim, and what the result
//! should be.

use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_clearing::hash::{commitment, parse_hex, to_hex};
use fairground_clearing::{Bid, ClearingResult, SaleParams, clear};
use fairground_sealer::{BidPlaintext, seal_bid};
use near_workspaces::operations::TransactionStatus;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use serde_json::{Value, json};

use crate::env::{str_field, u128_field, u128_value};
use crate::outlayer::{Served, ensure_success};
use crate::report::event;
use crate::{Env, SECOND, TOKEN, USDC};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Tee,
    CommitReveal,
}

/// `create_sale` parameters. Times are relative to the moment of creation.
#[derive(Clone, Debug)]
pub struct SaleSpec {
    pub sale_id: String,
    pub mode: Mode,
    pub token_name: String,
    pub token_symbol: String,
    pub decimals: u8,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub website: Option<String>,
    pub total_supply: u128,
    pub sale_supply: u128,
    pub floor_price: u128,
    pub max_price: Option<u128>,
    pub min_raise: u128,
    pub min_deposit: u128,
    pub max_deposit: u128,
    pub max_bids: u32,
    /// Seconds from creation to `bid_start`.
    pub start_delay: u64,
    /// Seconds from `bid_start` to `bid_end`.
    pub window: u64,
    /// Seconds (commit-reveal only).
    pub reveal_window: Option<u64>,
    /// Seconds.
    pub settle_timeout: u64,
    /// `create_sale`'s `liquidity` argument, as JSON.
    pub liquidity: Option<Value>,
}

impl SaleSpec {
    /// 1,000,000 tokens (18 decimals), 600,000 for sale at a floor of
    /// 0.001 USDC per token, deposits of 1 to 10,000 USDC, 20 bids, a 60 s
    /// window starting 4 s after creation, a 10 minute settle timeout.
    pub fn new(sale_id: &str, mode: Mode) -> Self {
        Self {
            sale_id: sale_id.to_owned(),
            mode,
            token_name: format!("Test {sale_id}"),
            token_symbol: "TEST".to_owned(),
            decimals: 18,
            icon: None,
            description: None,
            website: None,
            total_supply: 1_000_000 * TOKEN,
            sale_supply: 600_000 * TOKEN,
            floor_price: 1_000,
            max_price: None,
            min_raise: 0,
            min_deposit: USDC,
            max_deposit: 10_000 * USDC,
            max_bids: 20,
            start_delay: 4,
            window: 60,
            reveal_window: match mode {
                Mode::Tee => None,
                Mode::CommitReveal => Some(60),
            },
            settle_timeout: 600,
            liquidity: None,
        }
    }

    /// The `params` argument of `create_sale` / `get_create_cost`.
    pub fn params(&self, bid_start: u64, quote_token: &AccountId) -> Value {
        let mut params = json!({
            "sale_id": self.sale_id,
            "token_name": self.token_name,
            "token_symbol": self.token_symbol,
            "decimals": self.decimals,
            "total_supply": self.total_supply.to_string(),
            "sale_supply": self.sale_supply.to_string(),
            "floor_price": self.floor_price.to_string(),
            "min_raise": self.min_raise.to_string(),
            "bid_start": bid_start.to_string(),
            "bid_end": (bid_start + self.window * SECOND).to_string(),
            "min_deposit": self.min_deposit.to_string(),
            "max_deposit_per_account": self.max_deposit.to_string(),
            "max_bids": self.max_bids,
            "reveal_mode": match self.mode {
                Mode::Tee => "Tee",
                Mode::CommitReveal => "CommitReveal",
            },
            "settle_timeout": (self.settle_timeout * SECOND).to_string(),
            "quote_token": quote_token,
        });
        let optional = [
            ("icon", self.icon.clone().map(Value::from)),
            ("description", self.description.clone().map(Value::from)),
            ("website", self.website.clone().map(Value::from)),
            (
                "max_price",
                self.max_price.map(|p| Value::from(p.to_string())),
            ),
            (
                "reveal_window",
                self.reveal_window
                    .map(|w| Value::from((w * SECOND).to_string())),
            ),
            ("liquidity", self.liquidity.clone()),
        ];
        for (key, value) in optional {
            if let Some(value) = value {
                params[key] = value;
            }
        }
        params
    }

    pub fn clearing_params(&self) -> SaleParams {
        SaleParams {
            sale_supply: self.sale_supply,
            floor_price: self.floor_price,
            min_raise: self.min_raise,
            decimals: self.decimals,
            max_price: self.max_price,
        }
    }
}

/// A created sale, ready for bids.
#[derive(Clone, Debug)]
pub struct Sale {
    pub spec: SaleSpec,
    pub id: String,
    pub token: AccountId,
    pub creator: AccountId,
    /// The sealer's X25519 key for this sale (TEE mode).
    pub pubkey: Option<[u8; 32]>,
    pub bid_start: u64,
    pub bid_end: u64,
    /// NEAR `create_sale` charged.
    pub cost: u128,
    pub create_tx: ExecutionFinalResult,
}

/// What one bid really was, for computing the expected clearing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlainBid {
    pub bidder: AccountId,
    pub deposit: u128,
    /// `None`: does not decrypt (or was not revealed).
    pub max_price: Option<u128>,
    pub max_spend: Option<u128>,
    /// The plaintext names another bidder (a copied ciphertext).
    pub mismatch: bool,
}

impl PlainBid {
    pub fn new(bidder: &AccountId, deposit: u128, max_price: u128, max_spend: u128) -> Self {
        Self {
            bidder: bidder.clone(),
            deposit,
            max_price: Some(max_price),
            max_spend: Some(max_spend),
            mismatch: false,
        }
    }
}

/// Each bid's invalid-bid penalty under `expected`: 1 % of the deposit,
/// rounded up, for the invalid ones; zero for the valid ones.
pub fn invalid_penalties(expected: &ClearingResult) -> Vec<u128> {
    expected
        .fills
        .iter()
        .map(|fill| {
            if fill.valid {
                0
            } else {
                fill.deposit.div_ceil(100)
            }
        })
        .collect()
}

/// The clearing the sealer (or `clear_onchain`) must produce for `bids`.
pub fn expected_clearing(spec: &SaleSpec, bids: &[PlainBid]) -> ClearingResult {
    let bids: Vec<Bid> = bids
        .iter()
        .map(|bid| Bid {
            bidder: bid.bidder.to_string(),
            deposit: bid.deposit,
            max_price: bid.max_price,
            max_spend: bid.max_spend,
            mismatch: bid.mismatch,
        })
        .collect();
    clear(&spec.clearing_params(), &bids).expect("valid sale params")
}

/// A deposit's outcome.
#[derive(Debug)]
pub struct Bidding {
    /// The amount the receiver kept (`ft_transfer_call`'s return value).
    pub used: u128,
    pub tx: ExecutionFinalResult,
}

impl Bidding {
    pub fn accepted(&self) -> bool {
        self.used > 0
    }
}

impl Env {
    /// Creates a sale (attaching exactly `get_create_cost`), answers the
    /// sealer's `pubkey` request in TEE mode, and waits until setup is done.
    pub async fn create_sale(&self, creator: &Account, spec: SaleSpec) -> Result<Sale> {
        let bid_start = self.now().await? + spec.start_delay * SECOND;
        let params = spec.params(bid_start, self.usdc.id());
        let cost = u128_value(
            &self
                .view(self.fg(), "get_create_cost", json!({"params": params}))
                .await?,
        )?;
        let pending = creator
            .call(self.fg(), "create_sale")
            .args_json(json!({"params": params}))
            .deposit(NearToken::from_yoctonear(cost))
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?;
        if spec.mode == Mode::Tee {
            let served = self.serve().await?;
            ensure!(
                served.output.contains(r#""ok":true"#),
                "pubkey job failed: {}",
                served.output
            );
        }
        let create_tx = pending.await?;
        ensure_success(&create_tx).context("create_sale")?;
        let mut sale = self.sale_view(&spec.sale_id).await?;
        for _ in 0..50 {
            if sale["status"] != "setup" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            sale = self.sale_view(&spec.sale_id).await?;
        }
        ensure!(sale["status"] != "setup", "sale still in setup: {sale}");
        let pubkey = match sale["sealer_pubkey"].as_str() {
            Some(hex) => Some(parse_hex::<32>(hex).context("sealer_pubkey")?),
            None => None,
        };
        Ok(Sale {
            id: spec.sale_id.clone(),
            token: str_field(&sale, "token")?.parse()?,
            creator: creator.id().clone(),
            pubkey,
            bid_start,
            bid_end: bid_start + spec.window * SECOND,
            cost,
            create_tx,
            spec,
        })
    }

    /// A sealed bid for `bidder`, as the app makes it (base64 sealed box).
    pub fn seal(
        &self,
        sale: &Sale,
        bidder: &AccountId,
        max_price: u128,
        max_spend: u128,
    ) -> String {
        let pubkey = sale.pubkey.expect("a TEE sale has a sealer key");
        let mut salt = [0u8; 16];
        salt[..8].copy_from_slice(&max_price.to_le_bytes()[..8]);
        salt[8..].copy_from_slice(&(bidder.as_str().len() as u64).to_le_bytes());
        seal_bid(
            &pubkey,
            &BidPlaintext {
                sale_id: sale.id.clone(),
                bidder: bidder.to_string(),
                max_price,
                max_spend,
                salt,
            },
        )
    }

    /// Any NEP-141 deposit into Fairground with `msg`.
    pub async fn deposit_with(
        &self,
        token: &AccountId,
        from: &Account,
        amount: u128,
        msg: &str,
    ) -> Result<Bidding> {
        let tx = from
            .call(token, "ft_transfer_call")
            .args_json(json!({"receiver_id": self.fg(), "amount": amount.to_string(), "msg": msg}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        ensure_success(&tx).context("ft_transfer_call")?;
        let used: String = tx.clone().json()?;
        Ok(Bidding {
            used: used.parse()?,
            tx,
        })
    }

    /// A USDC deposit into Fairground with `msg`.
    pub async fn deposit(&self, from: &Account, amount: u128, msg: &str) -> Result<Bidding> {
        self.deposit_with(&self.usdc.id().clone(), from, amount, msg)
            .await
    }

    /// A sealed TEE bid.
    pub async fn bid(
        &self,
        sale: &Sale,
        bidder: &Account,
        deposit: u128,
        max_price: u128,
        max_spend: u128,
    ) -> Result<Bidding> {
        let ciphertext = self.seal(sale, bidder.id(), max_price, max_spend);
        self.deposit(bidder, deposit, &tee_msg(&sale.id, &ciphertext))
            .await
    }

    /// A commit-reveal bid; the salt is derived from the bidder id.
    pub async fn commit(
        &self,
        sale: &Sale,
        bidder: &Account,
        deposit: u128,
        max_price: u128,
        max_spend: u128,
    ) -> Result<Bidding> {
        let hash = commitment(
            &sale.id,
            bidder.id().as_str(),
            max_price,
            max_spend,
            &salt_for(bidder.id()),
        );
        let msg = json!({"sale_id": sale.id, "commitment": to_hex(&hash)}).to_string();
        self.deposit(bidder, deposit, &msg).await
    }

    /// Reveals a commit-reveal bid made with [`Env::commit`].
    pub async fn reveal(
        &self,
        sale: &Sale,
        bidder: &Account,
        max_price: u128,
        max_spend: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(bidder
            .call(self.fg(), "reveal_bid")
            .args_json(json!({
                "sale_id": sale.id,
                "max_price": max_price.to_string(),
                "max_spend": max_spend.to_string(),
                "salt": to_hex(&salt_for(bidder.id())),
            }))
            .transact()
            .await?)
    }

    pub async fn wait_open(&self, sale: &Sale) -> Result<()> {
        self.advance_to(sale.bid_start).await
    }

    pub async fn wait_ended(&self, sale: &Sale) -> Result<()> {
        self.advance_to(sale.bid_end).await
    }

    /// Calls `close_sale` with `get_close_deposit` attached and 300 TGas, and
    /// returns without waiting (a TEE close waits for the OutLayer worker).
    pub async fn start_close(
        &self,
        closer: &Account,
        sale_id: &str,
    ) -> Result<(TransactionStatus, u128)> {
        let deposit = u128_value(
            &self
                .view(self.fg(), "get_close_deposit", json!({"sale_id": sale_id}))
                .await?,
        )?;
        let pending = closer
            .call(self.fg(), "close_sale")
            .args_json(json!({"sale_id": sale_id}))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?;
        Ok((pending, deposit))
    }

    /// Closes a TEE sale and answers the clearing request with the sealer's
    /// real output. Returns the close transaction and what was served.
    pub async fn close_and_clear(
        &self,
        closer: &Account,
        sale_id: &str,
    ) -> Result<(ExecutionFinalResult, Served)> {
        let (pending, _) = self.start_close(closer, sale_id).await?;
        let served = self.serve().await?;
        let tx = pending.await?;
        ensure_success(&tx).context("close_sale")?;
        Ok((tx, served))
    }

    /// `claim(sale_id, bidder)` by `caller`.
    pub async fn claim(
        &self,
        caller: &Account,
        sale_id: &str,
        bidder: Option<&AccountId>,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.fg(), "claim")
            .args_json(json!({"sale_id": sale_id, "bidder": bidder}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// `claim_proceeds(sale_id)` by `caller`.
    pub async fn claim_proceeds(
        &self,
        caller: &Account,
        sale_id: &str,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.fg(), "claim_proceeds")
            .args_json(json!({"sale_id": sale_id}))
            .gas(Gas::from_tgas(150))
            .transact()
            .await?)
    }

    /// Checks `get_fills` against the expected clearing, bid by bid
    /// (`penalties[i]` is taken off bid i's refund and shown as its penalty).
    pub async fn check_fills(
        &self,
        sale: &Sale,
        bids: &[PlainBid],
        expected: &ClearingResult,
        penalties: &[u128],
    ) -> Result<()> {
        let fills = self.fills_view(&sale.id).await?;
        ensure!(
            fills.len() == bids.len(),
            "{} fills for {} bids",
            fills.len(),
            bids.len()
        );
        let settled = self.status(&sale.id).await? == "settled";
        for (i, (fill, bid)) in fills.iter().zip(bids).enumerate() {
            let want = &expected.fills[i];
            let (tokens, spent) = if settled {
                (want.tokens, want.spent)
            } else {
                (0, 0)
            };
            let penalty = penalties.get(i).copied().unwrap_or(0);
            let refund = bid.deposit - spent - penalty;
            ensure!(
                fill["bidder"] == bid.bidder.as_str(),
                "fill {i} bidder: {fill}"
            );
            ensure!(
                u128_field(fill, "penalty")? == penalty,
                "fill {i} penalty: {fill}, want {penalty}"
            );
            ensure!(
                u128_field(fill, "tokens")? == tokens,
                "fill {i} tokens: {fill}, want {tokens}"
            );
            ensure!(
                u128_field(fill, "spent")? == spent,
                "fill {i} spent: {fill}, want {spent}"
            );
            ensure!(
                u128_field(fill, "refund")? == refund,
                "fill {i} refund: {fill}, want {refund}"
            );
        }
        Ok(())
    }

    /// Every bidder claims its `(tokens, refund)`; with `pushed_by`, every
    /// second claim is pushed by that account instead. Checks that each bidder
    /// received exactly that, and that a second claim pays nothing.
    pub async fn claim_all(
        &self,
        sale: &Sale,
        bidders: &[&Account],
        expected: &[(u128, u128)],
        pushed_by: Option<&Account>,
    ) -> Result<()> {
        ensure!(bidders.len() == expected.len());
        for (i, (bidder, &(tokens, refund))) in bidders.iter().zip(expected).enumerate() {
            let usdc_before = self.usdc_balance(bidder.id()).await?;
            let tokens_before = self.ft_balance(&sale.token, bidder.id()).await?;
            let caller = match pushed_by {
                Some(other) if i % 2 == 1 => other,
                _ => bidder,
            };
            let tx = self.claim(caller, &sale.id, Some(bidder.id())).await?;
            ensure_success(&tx).with_context(|| format!("claim {i}"))?;
            let paid: bool = tx.clone().json()?;
            ensure!(
                paid == (tokens > 0 || refund > 0),
                "claim {i} returned {paid}"
            );
            if let Some(data) = event(&tx, "claimed") {
                ensure!(
                    data["failed"].as_array().is_some_and(Vec::is_empty),
                    "claim {i} failed parts: {data}"
                );
            }
            let got_usdc = self.usdc_balance(bidder.id()).await? - usdc_before;
            let got_tokens = self.ft_balance(&sale.token, bidder.id()).await? - tokens_before;
            ensure!(
                got_usdc == refund,
                "bidder {i} refund {got_usdc}, want {refund}"
            );
            ensure!(
                got_tokens == tokens,
                "bidder {i} tokens {got_tokens}, want {tokens}"
            );
            // A second claim pays nothing.
            let again = self.claim(caller, &sale.id, Some(bidder.id())).await?;
            ensure_success(&again)?;
            ensure!(!again.json::<bool>()?, "second claim {i} paid again");
            ensure!(self.usdc_balance(bidder.id()).await? - usdc_before == refund);
            ensure!(self.ft_balance(&sale.token, bidder.id()).await? - tokens_before == tokens);
        }
        Ok(())
    }

    /// `claim_proceeds` pushed by `caller` (not the creator, so the creator's
    /// NEAR changes by the reserve refund alone). Checks the raise, the
    /// allocation, the burn, and that the NEAR refund equals what
    /// `get_reserve_refund` promised; then that a second call pays nothing.
    /// Returns the NEAR refund.
    pub async fn claim_proceeds_checked(
        &self,
        caller: &Account,
        sale: &Sale,
        want: Proceeds,
    ) -> Result<u128> {
        let creator = &sale.creator;
        let usdc_before = self.usdc_balance(creator).await?;
        let tokens_before = self.ft_balance(&sale.token, creator).await?;
        let supply_before = self.ft_supply(&sale.token).await?;
        let near_before = self.near_balance(creator).await?;
        let reserve = u128_value(
            &self
                .view(self.fg(), "get_reserve_refund", json!({"sale_id": sale.id}))
                .await?,
        )?;
        let tx = self.claim_proceeds(caller, &sale.id).await?;
        ensure_success(&tx).context("claim_proceeds")?;
        ensure!(tx.clone().json::<bool>()?, "claim_proceeds paid nothing");
        let event = event(&tx, "proceeds_claimed").context("no proceeds_claimed event")?;
        ensure!(
            event["failed"].as_array().is_some_and(Vec::is_empty),
            "failed parts: {event}"
        );
        let raise = self.usdc_balance(creator).await? - usdc_before;
        let allocation = self.ft_balance(&sale.token, creator).await? - tokens_before;
        let burned = supply_before - self.ft_supply(&sale.token).await?;
        let near_refund = self.near_balance(creator).await? - near_before;
        ensure!(raise == want.raise, "raise {raise}, want {}", want.raise);
        ensure!(
            allocation == want.allocation,
            "allocation {allocation}, want {}",
            want.allocation
        );
        ensure!(
            burned == want.burned,
            "burned {burned}, want {}",
            want.burned
        );
        ensure!(
            near_refund == reserve,
            "NEAR refund {near_refund}, get_reserve_refund said {reserve}"
        );
        let again = self.claim_proceeds(caller, &sale.id).await?;
        ensure_success(&again)?;
        ensure!(!again.json::<bool>()?, "second claim_proceeds paid again");
        ensure!(self.near_balance(creator).await? - near_before == reserve);
        ensure!(self.usdc_balance(creator).await? - usdc_before == want.raise);
        Ok(near_refund)
    }

    /// What one bid slot costs the creator (storage plus the winner's token
    /// registration): the difference `max_bids` makes to `get_create_cost`.
    pub async fn per_bid_reserve(&self, spec: &SaleSpec) -> Result<u128> {
        let mut one = spec.clone();
        one.sale_id = format!("{}x", spec.sale_id);
        one.max_bids = 1;
        let mut two = one.clone();
        two.max_bids = 2;
        let bid_start = self.now().await? + 3_600 * SECOND;
        let mut cost = Vec::new();
        for spec in [one, two] {
            let params = spec.params(bid_start, self.usdc.id());
            cost.push(u128_value(
                &self
                    .view(self.fg(), "get_create_cost", json!({"params": params}))
                    .await?,
            )?);
        }
        Ok(cost[1] - cost[0])
    }
}

/// What the creator should receive from `claim_proceeds`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Proceeds {
    /// USDC.
    pub raise: u128,
    /// Sale tokens.
    pub allocation: u128,
    /// Sale tokens burned (total supply falls by this).
    pub burned: u128,
}

/// Fails unless `tx` failed with a message containing `needle`.
pub fn expect_failure(tx: &ExecutionFinalResult, needle: &str) -> Result<()> {
    if tx.is_success() {
        bail!("expected a failure containing {needle:?}, but the call succeeded");
    }
    let text = format!("{:?}", tx.clone().into_result().err());
    ensure!(text.contains(needle), "expected {needle:?} in {text}");
    Ok(())
}

/// `{"sale_id":..,"ciphertext":..}`.
pub fn tee_msg(sale_id: &str, ciphertext: &str) -> String {
    json!({"sale_id": sale_id, "ciphertext": ciphertext}).to_string()
}

/// The only ciphertext length (decoded) a TEE sale accepts from `bidder`:
/// `fairground_clearing::sealed_bid_len`, 224 + len(sale_id) + len(bidder).
pub fn sealed_len(sale_id: &str, bidder: &AccountId) -> usize {
    fairground_clearing::sealed_bid_len(sale_id.len(), bidder.as_str().len())
}

/// Random-looking bytes of exactly the length a sealed bid of `bidder` in
/// `sale_id` has: the contract takes them, the enclave cannot open them.
pub fn junk_ciphertext(sale_id: &str, bidder: &AccountId, seed: u8) -> String {
    garbage_ciphertext(sealed_len(sale_id, bidder), seed)
}

/// Random-looking bytes that are not a box for any key.
pub fn garbage_ciphertext(len: usize, seed: u8) -> String {
    let bytes: Vec<u8> = (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect();
    BASE64.encode(bytes)
}

/// A per-bidder commit-reveal salt.
fn salt_for(bidder: &AccountId) -> [u8; 16] {
    let digest = fairground_clearing::hash::sha256(bidder.as_bytes());
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&digest[..16]);
    salt
}
