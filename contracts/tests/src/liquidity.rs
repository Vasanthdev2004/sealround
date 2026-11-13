//! Launch liquidity: the calls that seed or abandon a sale's pool, the
//! exchange's views, and its owner's powers (pause, freeze a token), which the
//! tests use to make steps fail.

use anyhow::{Context, Result, bail, ensure};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{Value, json};

use crate::Env;
use crate::env::u128_value;

/// `create_sale`'s `liquidity` argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidityTerms {
    pub raise_share_bps: u16,
    pub pool_tokens: u128,
    pub fee_bps: u16,
}

impl LiquidityTerms {
    pub fn json(&self) -> Value {
        json!({
            "raise_share_bps": self.raise_share_bps,
            "pool_tokens": self.pool_tokens.to_string(),
            "fee_bps": self.fee_bps,
        })
    }
}

/// `(usdc, tokens)` the pool should get, worked out here independently of
/// the contract: `share_bps` of the raise (rounded down) buys tokens at the
/// clearing price (rounded down, at most the reserve), which cost `usdc`
/// (rounded up). `(0, 0)` when either is zero. Test values only: panics on
/// overflow.
pub fn pool_plan(
    raise: u128,
    price: u128,
    decimals: u8,
    share_bps: u16,
    reserve: u128,
) -> (u128, u128) {
    let one = 10u128.pow(decimals.into());
    let budget = raise.checked_mul(share_bps.into()).expect("small raise") / 10_000;
    let tokens = (budget.checked_mul(one).expect("small budget") / price).min(reserve);
    let usdc = tokens.checked_mul(price).expect("small pool").div_ceil(one);
    if tokens == 0 || usdc == 0 || usdc > budget {
        (0, 0)
    } else {
        (usdc, tokens)
    }
}

impl Env {
    /// The exchange. Panics unless the `Env` was made with `EnvOptions::dex`.
    pub fn dex(&self) -> &Contract {
        self.dex
            .as_ref()
            .expect("this Env has no exchange: build it with EnvOptions { dex: true, .. }")
    }

    pub async fn seed_liquidity(
        &self,
        caller: &Account,
        sale_id: &str,
        tgas: u64,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.fg(), "seed_liquidity")
            .args_json(json!({"sale_id": sale_id}))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?)
    }

    pub async fn abandon_liquidity(
        &self,
        caller: &Account,
        sale_id: &str,
        tgas: u64,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.fg(), "abandon_liquidity")
            .args_json(json!({"sale_id": sale_id}))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?)
    }

    /// `get_result(sale_id).liquidity`.
    pub async fn liquidity(&self, sale_id: &str) -> Result<Value> {
        let result = self.result_view(sale_id).await?;
        let liquidity = result["liquidity"].clone();
        ensure!(!liquidity.is_null(), "no liquidity in {result}");
        Ok(liquidity)
    }

    /// An owner call on the exchange with 1 yoctoNEAR, signed by the parent
    /// account (the exchange's owner here).
    pub async fn dex_owner(&self, method: &str, args: Value) -> Result<()> {
        self.parent
            .call(self.dex().id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()
            .with_context(|| format!("exchange {method}"))?;
        Ok(())
    }

    /// Pauses or resumes the whole exchange.
    pub async fn pause_dex(&self, paused: bool) -> Result<()> {
        let state = if paused { "Paused" } else { "Running" };
        self.dex_owner("change_state", json!({"state": state}))
            .await
    }

    /// Freezes or unfreezes tokens on the exchange: no deposit, withdrawal or
    /// liquidity change of a frozen token.
    pub async fn freeze_on_dex(&self, tokens: &[&AccountId], frozen: bool) -> Result<()> {
        let method = if frozen {
            "extend_frozenlist_tokens"
        } else {
            "remove_frozenlist_tokens"
        };
        self.dex_owner(method, json!({"tokens": tokens})).await
    }

    pub async fn dex_pool(&self, pool_id: u64) -> Result<Value> {
        self.view(self.dex().id(), "get_pool", json!({"pool_id": pool_id}))
            .await
    }

    pub async fn dex_shares(&self, pool_id: u64, who: &AccountId) -> Result<u128> {
        u128_value(
            &self
                .view(
                    self.dex().id(),
                    "get_pool_shares",
                    json!({"pool_id": pool_id, "account_id": who}),
                )
                .await?,
        )
    }

    /// `who`'s balance of `token` deposited on the exchange (0 if none).
    pub async fn dex_deposit(&self, who: &AccountId, token: &AccountId) -> Result<u128> {
        let deposits = self
            .view(self.dex().id(), "get_deposits", json!({"account_id": who}))
            .await?;
        match deposits.get(token.as_str()) {
            Some(amount) => u128_value(amount),
            None => Ok(0),
        }
    }

    /// NEP-145 `storage_balance_of` on the exchange (null if not registered).
    pub async fn dex_storage(&self, who: &AccountId) -> Result<Value> {
        self.view(
            self.dex().id(),
            "storage_balance_of",
            json!({"account_id": who}),
        )
        .await
    }
}

const LIQUIDITY_RS: &str = include_str!("../../fairground/src/liquidity.rs");

/// `STEP_TIMEOUT_BLOCKS` in the contract's `liquidity.rs`.
pub fn step_timeout_blocks() -> u64 {
    let prefix = "pub const STEP_TIMEOUT_BLOCKS: u64 = ";
    LIQUIDITY_RS
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .and_then(|value| value.trim_end_matches(';').replace('_', "").parse().ok())
        .expect("STEP_TIMEOUT_BLOCKS in liquidity.rs")
}

impl Env {
    /// Rewrites Fairground's liquidity record of `sale_id` with `change`, as
    /// the sandbox lets a test do. The tests use it to leave a step in flight
    /// that never gets its result: what a failed callback receipt leaves
    /// behind. Returns the record as it was.
    pub async fn patch_liquidity(
        &self,
        sale_id: &str,
        terms: &LiquidityTerms,
        change: impl FnOnce(&mut LiquidityRecord),
    ) -> Result<LiquidityRecord> {
        // `sales` is a LookupMap under the storage key `Sales` (variant 1),
        // keyed by the Borsh sale id. The liquidity record is the sale's last
        // field: `Some`, then the terms.
        let mut key = vec![1u8];
        key.extend_from_slice(&(sale_id.len() as u32).to_le_bytes());
        key.extend_from_slice(sale_id.as_bytes());
        let state = self.fairground.view_state().prefix(&key).await?;
        let value = state
            .get(&key)
            .with_context(|| format!("no sale record {sale_id} in Fairground's state"))?;
        let mut head = vec![1u8];
        head.extend_from_slice(&terms.raise_share_bps.to_le_bytes());
        head.extend_from_slice(&terms.pool_tokens.to_le_bytes());
        head.extend_from_slice(&terms.fee_bps.to_le_bytes());
        let start = value
            .windows(head.len())
            .rposition(|window| window == head.as_slice())
            .context("no liquidity record in the sale")?;
        let before = LiquidityRecord::parse(&value[start + 1..])?;
        let mut record = before.clone();
        change(&mut record);
        let mut patched = value[..=start].to_vec();
        patched.extend_from_slice(&record.bytes());
        self.worker
            .patch(self.fg())
            .state(&key, &patched)
            .transact()
            .await?;
        Ok(before)
    }

    /// The current block height.
    pub async fn height(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.height())
    }
}

/// `LiquidityStep` as Fairground stores it (the Borsh variant index).
pub mod step {
    pub const CREATE_POOL: u8 = 1;
    pub const DEPOSIT: u8 = 2;
}

/// Fairground's `Liquidity` record, field for field as Borsh stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidityRecord {
    pub raise_share_bps: u16,
    pub pool_tokens: u128,
    pub fee_bps: u16,
    pub stage: u8,
    pub usdc: u128,
    pub tokens: u128,
    pub deadline: u64,
    pub dex_account: bool,
    pub dex_on_token: bool,
    pub dex_on_quote: bool,
    pub pool_id: Option<u64>,
    pub tokens_on_dex: u128,
    pub usdc_on_dex: u128,
    pub shares: u128,
    pub in_flight: Option<u8>,
    pub failures: u32,
    pub attempt: u32,
    pub started_at: u64,
    pub unsure: bool,
    pub near_lost: u128,
    pub pool_search: Option<u64>,
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        ensure!(self.0.len() >= N, "the liquidity record ends early");
        let (head, rest) = self.0.split_at(N);
        self.0 = rest;
        Ok(head.try_into()?)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take::<1>()?[0])
    }
    fn bool(&mut self) -> Result<bool> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            other => bail!("not a bool: {other}"),
        }
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(self.take()?))
    }
    fn option<T>(&mut self, read: impl FnOnce(&mut Self) -> Result<T>) -> Result<Option<T>> {
        if self.bool()? {
            Ok(Some(read(self)?))
        } else {
            Ok(None)
        }
    }
}

impl LiquidityRecord {
    fn parse(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader(bytes);
        let record = Self {
            raise_share_bps: r.u16()?,
            pool_tokens: r.u128()?,
            fee_bps: r.u16()?,
            stage: r.u8()?,
            usdc: r.u128()?,
            tokens: r.u128()?,
            deadline: r.u64()?,
            dex_account: r.bool()?,
            dex_on_token: r.bool()?,
            dex_on_quote: r.bool()?,
            pool_id: r.option(Reader::u64)?,
            tokens_on_dex: r.u128()?,
            usdc_on_dex: r.u128()?,
            shares: r.u128()?,
            in_flight: r.option(Reader::u8)?,
            failures: r.u32()?,
            attempt: r.u32()?,
            started_at: r.u64()?,
            unsure: r.bool()?,
            near_lost: r.u128()?,
            pool_search: r.option(Reader::u64)?,
        };
        ensure!(
            r.0.is_empty(),
            "{} bytes after the liquidity record",
            r.0.len()
        );
        Ok(record)
    }

    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let option = |out: &mut Vec<u8>, value: Option<&[u8]>| match value {
            Some(bytes) => {
                out.push(1);
                out.extend_from_slice(bytes);
            }
            None => out.push(0),
        };
        out.extend_from_slice(&self.raise_share_bps.to_le_bytes());
        out.extend_from_slice(&self.pool_tokens.to_le_bytes());
        out.extend_from_slice(&self.fee_bps.to_le_bytes());
        out.push(self.stage);
        out.extend_from_slice(&self.usdc.to_le_bytes());
        out.extend_from_slice(&self.tokens.to_le_bytes());
        out.extend_from_slice(&self.deadline.to_le_bytes());
        out.extend([self.dex_account, self.dex_on_token, self.dex_on_quote].map(u8::from));
        option(
            &mut out,
            self.pool_id.map(u64::to_le_bytes).as_ref().map(|b| &b[..]),
        );
        out.extend_from_slice(&self.tokens_on_dex.to_le_bytes());
        out.extend_from_slice(&self.usdc_on_dex.to_le_bytes());
        out.extend_from_slice(&self.shares.to_le_bytes());
        option(
            &mut out,
            self.in_flight.map(|step| [step]).as_ref().map(|b| &b[..]),
        );
        out.extend_from_slice(&self.failures.to_le_bytes());
        out.extend_from_slice(&self.attempt.to_le_bytes());
        out.extend_from_slice(&self.started_at.to_le_bytes());
        out.push(u8::from(self.unsure));
        out.extend_from_slice(&self.near_lost.to_le_bytes());
        option(
            &mut out,
            self.pool_search
                .map(u64::to_le_bytes)
                .as_ref()
                .map(|b| &b[..]),
        );
        out
    }
}
