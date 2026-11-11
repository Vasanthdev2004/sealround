//! The per-test world: accounts, contracts, the chain clock and views.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use futures::StreamExt;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};

use crate::report::gas_cost;
use crate::{NEAR, SECOND, res};

/// The pinned sealer hash the Fairground config carries. The test is the
/// worker, so no wasm is ever fetched.
pub const SEALER_CODE_HASH: &str =
    "5f1d2f6bd4c5fe0e5d3d6b8f6a5c3c0e9a3f4b2d1c0e9f8a7b6c5d4e3f2a1b0c";

/// Block time `fast_forward` adds per block (measured: about 0.29 s).
const NS_PER_FORWARDED_BLOCK: u64 = 290_000_000;
/// Largest single `fast_forward` (about 30 s of wall time).
const MAX_FORWARD_BLOCKS: u64 = 3_000;
/// Forwards at least this long are checked for a frozen clock (a short one
/// may land within the same few blocks).
const MIN_CHECKED_FORWARD: u64 = 50;
/// Parallel transactions when creating many accounts or bids. Each stream
/// signs with its own account, so nonces never collide.
pub(crate) const PARALLEL: usize = 16;

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// How much NEAR the test's parent account starts with.
#[derive(Clone, Copy, Debug)]
pub struct EnvOptions {
    pub parent_near: u128,
}

impl Default for EnvOptions {
    fn default() -> Self {
        Self { parent_near: 400 }
    }
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    /// `<tag><unique>.test.near`: every other account is under it.
    pub parent: Account,
    /// OutLayer's operator: the test acting as the worker.
    pub operator: Account,
    pub outlayer: Contract,
    pub usdc: Contract,
    pub fairground: Contract,
    /// The sealer's master secret (`PROTECTED_FAIRGROUND_MASTER` in the enclave).
    pub master: [u8; 32],
    /// OutLayer requests this test already answered.
    pub(crate) handled: Mutex<Vec<u64>>,
}

impl Env {
    pub async fn new(tag: &str) -> Result<Self> {
        Self::with_options(tag, EnvOptions::default()).await
    }

    /// Connects to the sandbox and deploys OutLayer, USDC and Fairground under
    /// a new parent account.
    pub async fn with_options(tag: &str, options: EnvOptions) -> Result<Self> {
        let rpc =
            std::env::var("NEAR_SANDBOX_RPC").unwrap_or_else(|_| "http://127.0.0.1:3030".into());
        let home = std::env::var("NEAR_SANDBOX_HOME").unwrap_or_else(|_| {
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../.sandbox-home").to_owned()
        });
        let worker = near_workspaces::sandbox()
            .rpc_addr(&rpc)
            .validator_key(ValidatorKey::HomeDir(home.clone().into()))
            .await
            .with_context(|| {
                format!("connecting to the sandbox at {rpc} (home {home}); run scripts/sandbox.ps1")
            })?;
        let root = worker.root_account()?;
        let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() % 10_000_000_000;
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let parent = root
            .create_subaccount(&format!("{tag}{millis}{n}"))
            .initial_balance(NearToken::from_near(options.parent_near))
            .transact()
            .await?
            .into_result()?;

        let operator = subaccount(&parent, "operator", 50 * NEAR).await?;
        let outlayer = deploy(&parent, "outlayer", 20, "outlayer_contract.wasm").await?;
        outlayer
            .call("new")
            .args_json(json!({"owner_id": operator.id(), "operator_id": operator.id()}))
            .transact()
            .await?
            .into_result()
            .context("OutLayer new")?;
        let usdc = deploy(&parent, "usdc", 10, "mock_ft.wasm").await?;
        usdc.call("new")
            .args_json(json!({"name": "USD Coin", "symbol": "USDC"}))
            .transact()
            .await?
            .into_result()
            .context("mock-ft new")?;
        let fairground = deploy(&parent, "fg", 30, "fairground.wasm").await?;
        fairground
            .call("new")
            .args_json(fairground_config(outlayer.id(), &[usdc.id()]))
            .transact()
            .await?
            .into_result()
            .context("Fairground new")?;

        let mut master = [0u8; 32];
        for (i, byte) in master.iter_mut().enumerate() {
            *byte = (i as u8).wrapping_mul(37).wrapping_add(n as u8);
        }
        Ok(Self {
            worker,
            parent,
            operator,
            outlayer,
            usdc,
            fairground,
            master,
            handled: Mutex::new(Vec::new()),
        })
    }

    pub fn fg(&self) -> &AccountId {
        self.fairground.id()
    }

    /// `<name>.<parent>` with `near` NEAR.
    pub async fn account(&self, name: &str, near: u128) -> Result<Account> {
        subaccount(&self.parent, name, near * NEAR).await
    }

    /// `n` new accounts with `millinear` each and `usdc` minted to each, made
    /// in parallel streams. With `id_len`, every id is exactly that long
    /// (64 for the worst case).
    pub async fn bidders(
        &self,
        prefix: &str,
        n: usize,
        millinear: u128,
        usdc: u128,
        id_len: Option<usize>,
    ) -> Result<Vec<Account>> {
        let streams = n.clamp(1, PARALLEL);
        let per_stream = n.div_ceil(streams);
        let mut spawners = Vec::with_capacity(streams);
        for k in 0..streams {
            let budget = (per_stream as u128 * millinear * NEAR / 1_000) + 5 * NEAR;
            spawners.push(subaccount(&self.parent, &format!("{prefix}s{k}"), budget).await?);
        }
        let usdc_id = self.usdc.id().clone();
        let jobs = spawners.into_iter().enumerate().map(|(k, spawner)| {
            let usdc_id = usdc_id.clone();
            let prefix = prefix.to_owned();
            async move {
                let mut made = Vec::new();
                for i in (k * per_stream)..((k + 1) * per_stream).min(n) {
                    let mut name = format!("{prefix}{i}");
                    if let Some(len) = id_len {
                        let pad = len
                            .checked_sub(name.len() + 1 + spawner.id().as_str().len())
                            .context("id_len too short for this parent")?;
                        name.push_str(&"x".repeat(pad));
                    }
                    let account = retry(|| async {
                        spawner
                            .create_subaccount(&name)
                            .initial_balance(NearToken::from_yoctonear(millinear * NEAR / 1_000))
                            .transact()
                            .await?
                            .into_result()
                            .map_err(anyhow::Error::from)
                    })
                    .await?;
                    made.push(account);
                }
                // One transaction mints for up to 25 accounts.
                if usdc > 0 {
                    for chunk in made.chunks(25) {
                        let mut tx = spawner.batch(&usdc_id);
                        for account in chunk {
                            tx = tx.call(
                                Function::new("mint")
                                    .args_json(json!({"account_id": account.id(), "amount": usdc.to_string()}))
                                    .gas(Gas::from_tgas(12)),
                            );
                        }
                        tx.transact().await?.into_result()?;
                    }
                }
                Ok::<_, anyhow::Error>(made)
            }
        });
        let mut all: Vec<Account> = Vec::with_capacity(n);
        for made in futures::future::join_all(jobs).await {
            all.extend(made?);
        }
        Ok(all)
    }

    /// Mints mock USDC to `who`.
    pub async fn mint(&self, who: &AccountId, amount: u128) -> Result<()> {
        self.usdc
            .call("mint")
            .args_json(json!({"account_id": who, "amount": amount.to_string()}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Current block timestamp (ns).
    pub async fn now(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Moves the chain clock to at least `at` (ns) with `fast_forward`.
    ///
    /// Fails at once if the clock does not move: a sandbox restarted on an
    /// old chain (`docker start`) keeps a block time hours ahead of the wall
    /// clock and adds only nanoseconds per block until the new process has
    /// forwarded past it, which would stall the tests for many minutes.
    /// `scripts/sandbox.ps1` never restarts a chain; `-Reset` makes a new one.
    pub async fn advance_to(&self, at: u64) -> Result<()> {
        loop {
            let now = self.now().await?;
            if now >= at {
                return Ok(());
            }
            let blocks = ((at - now) / NS_PER_FORWARDED_BLOCK + 2).min(MAX_FORWARD_BLOCKS);
            self.worker.fast_forward(blocks).await?;
            let moved = self.now().await?.saturating_sub(now);
            if blocks >= MIN_CHECKED_FORWARD && moved < blocks * NS_PER_FORWARDED_BLOCK / 10 {
                bail!(
                    "the sandbox clock is frozen: {blocks} forwarded blocks moved it {moved} ns. \
                     The container was restarted on an old chain; run scripts/sandbox.ps1 -Reset"
                );
            }
        }
    }

    /// Moves the clock `seconds` ahead.
    pub async fn advance(&self, seconds: u64) -> Result<()> {
        let now = self.now().await?;
        self.advance_to(now + seconds * SECOND).await
    }

    // Views.

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        Ok(self
            .worker
            .view(contract, method)
            .args_json(args)
            .await?
            .json()?)
    }

    pub async fn sale_view(&self, sale_id: &str) -> Result<Value> {
        let sale = self
            .view(self.fg(), "get_sale", json!({"sale_id": sale_id}))
            .await?;
        ensure!(!sale.is_null(), "no sale {sale_id}");
        Ok(sale)
    }

    /// The sale view once `ready` holds for it (polled for up to 5 s).
    /// A transaction's result can come back before the callbacks of the
    /// promises it detached have run.
    pub async fn sale_when(&self, sale_id: &str, ready: impl Fn(&Value) -> bool) -> Result<Value> {
        for _ in 0..50 {
            let sale = self.sale_view(sale_id).await?;
            if ready(&sale) {
                return Ok(sale);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        bail!(
            "sale {sale_id} never reached the expected state: {}",
            self.sale_view(sale_id).await?
        )
    }

    pub async fn result_view(&self, sale_id: &str) -> Result<Value> {
        self.view(self.fg(), "get_result", json!({"sale_id": sale_id}))
            .await
    }

    pub async fn status(&self, sale_id: &str) -> Result<String> {
        Ok(str_field(&self.sale_view(sale_id).await?, "status")?.to_owned())
    }

    pub async fn fills_view(&self, sale_id: &str) -> Result<Vec<Value>> {
        let fills = self
            .view(
                self.fg(),
                "get_fills",
                json!({"sale_id": sale_id, "limit": 200}),
            )
            .await?;
        Ok(fills.as_array().cloned().unwrap_or_default())
    }

    /// NEP-141 balance (0 when not registered).
    pub async fn ft_balance(&self, token: &AccountId, who: &AccountId) -> Result<u128> {
        u128_value(
            &self
                .view(token, "ft_balance_of", json!({"account_id": who}))
                .await?,
        )
    }

    pub async fn usdc_balance(&self, who: &AccountId) -> Result<u128> {
        self.ft_balance(self.usdc.id(), who).await
    }

    pub async fn ft_supply(&self, token: &AccountId) -> Result<u128> {
        u128_value(&self.view(token, "ft_total_supply", json!({})).await?)
    }

    pub async fn near_balance(&self, who: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(who).await?.balance.as_yoctonear())
    }

    /// `near_balance` once the refunds of `who`'s earlier transactions (unused
    /// gas, returned deposits: separate receipts) have landed. Use it for a
    /// "before" balance of an account that has just signed something.
    pub async fn near_balance_settled(&self, who: &AccountId) -> Result<u128> {
        tokio::time::sleep(Duration::from_secs(2)).await;
        self.near_balance(who).await
    }

    pub async fn storage_usage(&self, who: &AccountId) -> Result<u64> {
        Ok(self.worker.view_account(who).await?.storage_usage)
    }

    /// Checks that `who`, the signer of `tx`, has lost exactly the gas of
    /// `tx` plus `kept` since its balance was `before`: every other
    /// yoctoNEAR it attached came back. Waits for the refund receipts first.
    /// Exact to the yoctoNEAR (the sandbox refunds unused gas in full), so
    /// `tx` must include every receipt that burnt the signer's gas (see
    /// [`crate::result_now`] for detached promises). Returns what it lost
    /// beyond gas.
    pub async fn ensure_near_kept(
        &self,
        who: &AccountId,
        before: u128,
        tx: &ExecutionFinalResult,
        kept: u128,
    ) -> Result<u128> {
        // Refunds of unused gas and deposits are separate receipts.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let after = self.near_balance(who).await?;
        let lost = before.saturating_sub(after);
        let beyond_gas = lost.saturating_sub(gas_cost(tx));
        println!("{who}: lost {beyond_gas} yoctoNEAR beyond gas, want {kept}");
        ensure!(
            beyond_gas == kept,
            "{who} lost {lost} yoctoNEAR: {beyond_gas} beyond gas, want {kept}"
        );
        Ok(beyond_gas)
    }
}

/// The `new` arguments for Fairground.
pub fn fairground_config(outlayer: &AccountId, quote_tokens: &[&AccountId]) -> Value {
    json!({
        "outlayer": outlayer,
        "sealer_source": {"WasmUrl": {
            "url": "https://example.com/fairground-sealer.wasm",
            "hash": SEALER_CODE_HASH,
            "build_target": "wasm32-wasip1",
        }},
        "sealer_code_hash": SEALER_CODE_HASH,
        "sealer_secrets": null,
        "allowed_quote_tokens": quote_tokens,
    })
}

async fn subaccount(parent: &Account, name: &str, yocto: u128) -> Result<Account> {
    parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_yoctonear(yocto))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("creating {name}.{}", parent.id()))
}

async fn deploy(parent: &Account, name: &str, near: u128, wasm: &str) -> Result<Contract> {
    let code = std::fs::read(res(wasm)).with_context(|| format!("reading contracts/res/{wasm}"))?;
    let account = subaccount(parent, name, near * NEAR).await?;
    Ok(account.deploy(&code).await?.into_result()?)
}

/// Retries a transaction the RPC rejected (not one that failed on chain):
/// a busy sandbox sometimes times out a request.
pub(crate) async fn retry<T, F, Fut>(mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(value) => return Ok(value),
            Err(error) if attempt < 4 && is_transient(&error) => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(300 * attempt)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_transient(error: &anyhow::Error) -> bool {
    let text = format!("{error:?}");
    [
        "InvalidNonce",
        "timeout",
        "Timeout",
        "TIMEOUT",
        "connection",
        "Transaction has expired",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Runs `jobs` with at most `PARALLEL` in flight, keeping their order.
pub async fn parallel<T, Fut>(jobs: impl IntoIterator<Item = Fut>) -> Result<Vec<T>>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    futures::stream::iter(jobs)
        .buffered(PARALLEL)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect()
}

pub(crate) fn str_field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("field {key} is not a string in {value}"))
}

/// A `U128` JSON value (decimal string).
pub fn u128_value(value: &Value) -> Result<u128> {
    match value.as_str() {
        Some(text) => Ok(text.parse()?),
        None => bail!("not a U128 string: {value}"),
    }
}

/// `value[key]` as a `U128`.
pub fn u128_field(value: &Value, key: &str) -> Result<u128> {
    u128_value(&value[key]).with_context(|| format!("field {key}"))
}
