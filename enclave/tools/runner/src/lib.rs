//! Runs a WASI Preview 1 module the way OutLayer's worker runs a job, and
//! reports what the worker would see: the output, the instructions it
//! counted, and whether the run succeeded.
//!
//! It copies the run path of `worker/src/executor/wasi_p1.rs` and
//! `worker/src/executor/sandbox.rs` in fastnear/near-outlayer at commit
//! 3079d756a0 (8 Nov 2026), without the logging:
//!
//! - wasmtime 28.0.1 with async support, fuel metering and epoch interruption;
//! - stdin holds the input; stdout holds up to 10 MiB and stderr 1 MiB, and a
//!   write past either fails;
//! - no preopened files, no sockets, no arguments; the environment is exactly
//!   what the caller passes (the worker passes the secrets plus its system
//!   variables, see [`near_env`]);
//! - each linear memory is held to `max_memory_mb`, which the worker first
//!   raises to at least 1024 MB and caps at 4096 MB;
//! - the fuel budget is `max_instructions`, and the instructions a run used are
//!   the budget minus the fuel left, whichever way the run ended;
//! - an epoch deadline traps the run after `max(max_execution_seconds, 5)`
//!   seconds (within a second; see [`Ticker`]), and a wall-clock bound two
//!   seconds later ends a run that waits in a host call;
//! - returning from `_start`, or `proc_exit(0)`, is a success. Anything else
//!   fails the run, and then the worker publishes stderr instead of stdout.
//!
//! The worker's other host interfaces (storage, keys, HTTP) are only for P2
//! components, so a P1 module cannot import them and they are left out.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, Trap};
use wasmtime_wasi::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::preview1::{self, WasiP1Ctx};
use wasmtime_wasi::{I32Exit, WasiCtxBuilder};

/// OutLayer's default `max_instructions` (contract `lib.rs`), used when a
/// request's `resource_limits` leave it out.
pub const DEFAULT_MAX_INSTRUCTIONS: u64 = 1_000_000_000;
/// OutLayer's default `max_memory_mb`.
pub const DEFAULT_MAX_MEMORY_MB: u32 = 128;
/// OutLayer's default `max_execution_seconds`.
pub const DEFAULT_MAX_EXECUTION_SECONDS: u64 = 60;
/// The most instructions a request may ask for (`get_max_limits`).
pub const HARD_MAX_INSTRUCTIONS: u64 = 500_000_000_000;
/// The longest run a request may ask for, seconds.
pub const HARD_MAX_EXECUTION_SECONDS: u64 = 180;
/// The least memory the worker gives a run, whatever it asked for.
pub const MEMORY_FLOOR_MB: u32 = 1024;
/// The most memory the worker gives a run: wasm32's own bound.
pub const MEMORY_CEILING_MB: u32 = 4096;
/// The stdout capacity.
pub const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
/// The stderr capacity.
pub const MAX_STDERR_BYTES: usize = 1024 * 1024;

/// A request's `resource_limits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
}

impl Default for Limits {
    /// OutLayer's defaults: what `"resource_limits": {}` gets.
    fn default() -> Self {
        Self {
            max_instructions: DEFAULT_MAX_INSTRUCTIONS,
            max_memory_mb: DEFAULT_MAX_MEMORY_MB,
            max_execution_seconds: DEFAULT_MAX_EXECUTION_SECONDS,
        }
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum End {
    /// `_start` returned or called `proc_exit(0)`: the worker delivers stdout.
    Success,
    /// `proc_exit` with another status, which a Rust `main` returning an error
    /// or `ExitCode::FAILURE` does.
    Exited(i32),
    /// The fuel ran out: more than `max_instructions`.
    OutOfFuel,
    /// The time limit. The worker charges the whole instruction budget for it.
    TimedOut,
    /// Any other trap, a panic under `panic = "abort"` included.
    Trapped(String),
}

/// What one run produced.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub end: End,
    /// Everything the module wrote to stdout. The worker delivers it only if
    /// the run succeeded.
    pub stdout: Vec<u8>,
    /// Everything the module wrote to stderr. The worker publishes it as the
    /// error message of a failed run.
    pub stderr: Vec<u8>,
    /// Fuel used: wasm instructions as wasmtime meters them, which is what
    /// OutLayer limits and charges for.
    pub instructions: u64,
    /// Instantiation plus `_start`, without compiling the module.
    pub run_time: Duration,
    /// The size of the module's linear memory when the run ended. Wasm memory
    /// never shrinks, so this is the peak.
    pub memory_bytes: usize,
}

impl Outcome {
    /// Whether the worker would count this run a success.
    pub fn succeeded(&self) -> bool {
        self.end == End::Success
    }
}

/// The environment the worker gives an on-chain (`NEAR`) run
/// (`merge_env_vars` in `worker/src/main.rs`), plus the secret row's
/// variables. The values are placeholders of realistic length. Variables the
/// job does not read are included because the module's start-up copies the
/// whole environment, so their size is part of the cost being measured.
pub fn near_env(predecessor: &str, secrets: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = secrets
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    let system = [
        ("NEAR_NETWORK_ID", "testnet"),
        ("OUTLAYER_EXECUTION_TYPE", "NEAR"),
        ("NEAR_SENDER_ID", "alice.testnet"),
        ("NEAR_CONTRACT_ID", "outlayer.testnet"),
        ("NEAR_BLOCK_HEIGHT", "276923467"),
        ("NEAR_BLOCK_TIMESTAMP", "1762693651000000000"),
        (
            "NEAR_RECEIPT_ID",
            "11111111111111111111111111111111111111111111",
        ),
        ("NEAR_PREDECESSOR_ID", predecessor),
        (
            "NEAR_SIGNER_PUBLIC_KEY",
            "ed25519:11111111111111111111111111111111111111111111",
        ),
        ("NEAR_GAS_BURNT", "4800000000000"),
        ("NEAR_RELAYER_ID", ""),
        ("NEAR_USER_ACCOUNT_ID", "alice.testnet"),
        ("NEAR_PAYMENT_YOCTO", "7000100000000000000000"),
        ("ATTACHED_USD", "0"),
        (
            "NEAR_TRANSACTION_HASH",
            "11111111111111111111111111111111111111111111",
        ),
        ("NEAR_REQUEST_ID", "1"),
        ("USD_PAYMENT", "0"),
        ("OUTLAYER_CALL_ID", ""),
        ("NEAR_MAX_INSTRUCTIONS", "1000000000"),
        ("NEAR_MAX_MEMORY_MB", "128"),
        ("NEAR_MAX_EXECUTION_SECONDS", "60"),
        (
            "OUTLAYER_PROJECT_ID",
            "fairground.testnet/fairground-sealer",
        ),
        ("OUTLAYER_PROJECT_OWNER", "fairground.testnet"),
        ("OUTLAYER_PROJECT_NAME", "fairground-sealer"),
    ];
    // System names win: the worker strips them from the secrets first.
    env.retain(|(key, _)| !system.iter().any(|(name, _)| name == key));
    env.extend(
        system
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned())),
    );
    env
}

/// What a run's store carries: the WASI context and the run's bounds.
struct State {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
}

/// One compiled module, ready to run any number of times, also from several
/// threads at once.
pub struct Runner {
    engine: Engine,
    module: Module,
    linker: Linker<State>,
    compile_time: Duration,
    _ticker: Ticker,
}

impl Runner {
    /// Compiles `wasm` with the worker's engine settings.
    pub fn new(wasm: &[u8]) -> Result<Self> {
        let mut config = Config::new();
        config.async_support(true);
        config.consume_fuel(true);
        config.epoch_interruption(true);
        let engine = Engine::new(&config)?;

        let started = Instant::now();
        let module =
            Module::from_binary(&engine, wasm).context("not a valid WASI Preview 1 module")?;
        let compile_time = started.elapsed();

        let mut linker = Linker::new(&engine);
        preview1::add_to_linker_async(&mut linker, |state: &mut State| &mut state.wasi)?;
        let ticker = Ticker::start(engine.clone());
        Ok(Self {
            engine,
            module,
            linker,
            compile_time,
            _ticker: ticker,
        })
    }

    /// How long Cranelift took to compile the module. The worker compiles a P1
    /// module on every run, so its timing includes this.
    pub fn compile_time(&self) -> Duration {
        self.compile_time
    }

    /// Runs the module once. `Err` means it could not start at all (it does not
    /// instantiate or has no `_start`), which the worker reports as a failure
    /// that consumed nothing.
    pub fn run(&self, input: &[u8], env: &[(String, String)], limits: Limits) -> Result<Outcome> {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?
            .block_on(self.run_async(input, env, limits))
    }

    async fn run_async(
        &self,
        input: &[u8],
        env: &[(String, String)],
        limits: Limits,
    ) -> Result<Outcome> {
        let stdout = MemoryOutputPipe::new(MAX_OUTPUT_BYTES);
        let stderr = MemoryOutputPipe::new(MAX_STDERR_BYTES);
        let mut wasi = WasiCtxBuilder::new();
        wasi.stdin(MemoryInputPipe::new(input.to_vec()))
            .stdout(stdout.clone())
            .stderr(stderr.clone())
            .allow_tcp(false)
            .allow_udp(false)
            .allow_ip_name_lookup(false)
            .socket_addr_check(|_, _| Box::pin(async { false }));
        for (key, value) in env {
            wasi.env(key, value);
        }

        let memory_mb = limits
            .max_memory_mb
            .clamp(MEMORY_FLOOR_MB, MEMORY_CEILING_MB);
        let state = State {
            wasi: wasi.build_p1(),
            limits: StoreLimitsBuilder::new()
                .memory_size(memory_mb as usize * 1024 * 1024)
                .table_elements(1_000_000)
                .build(),
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|state| &mut state.limits);
        store.set_fuel(limits.max_instructions)?;
        let timeout_secs = limits.max_execution_seconds.max(5);
        store.set_epoch_deadline(timeout_secs);
        store.epoch_deadline_trap();

        let started = Instant::now();
        let instance = self
            .linker
            .instantiate_async(&mut store, &self.module)
            .await
            .context("failed to instantiate the module")?;
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .context("the module has no `_start` (it must be a binary with `fn main`)")?;
        let mut wall_clock_hit = false;
        let result = match tokio::time::timeout(
            Duration::from_secs(timeout_secs + 2),
            start.call_async(&mut store, ()),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                wall_clock_hit = true;
                Err(anyhow::anyhow!("wall-clock limit reached in a host call"))
            }
        };
        let run_time = started.elapsed();
        let instructions = limits.max_instructions - store.get_fuel().unwrap_or(0);
        let memory_bytes = instance
            .get_memory(&mut store, "memory")
            .map_or(0, |memory| memory.data_size(&store));

        let end = match result {
            Ok(()) => End::Success,
            Err(error) => classify(&error, wall_clock_hit),
        };
        Ok(Outcome {
            end,
            stdout: stdout.contents().to_vec(),
            stderr: stderr.contents().to_vec(),
            instructions,
            run_time,
            memory_bytes,
        })
    }
}

/// The worker's `sandbox::ended`, with fuel exhaustion told apart from other traps.
fn classify(error: &anyhow::Error, wall_clock_hit: bool) -> End {
    let trap = error.downcast_ref::<Trap>();
    if wall_clock_hit || trap == Some(&Trap::Interrupt) {
        return End::TimedOut;
    }
    if let Some(exit) = error.downcast_ref::<I32Exit>() {
        return if exit.0 == 0 {
            End::Success
        } else {
            End::Exited(exit.0)
        };
    }
    if trap == Some(&Trap::OutOfFuel) {
        return End::OutOfFuel;
    }
    End::Trapped(format!("{error:#}"))
}

/// Advances the engine's epoch once a second for as long as the [`Runner`]
/// lives, so every run's deadline counts real seconds.
///
/// The worker instead starts a ticker per run on an engine all runs share,
/// and its first tick fires at once, so its deadline falls about a second
/// before `max_execution_seconds`. Here the ticker's phase is arbitrary and a
/// run's deadline falls within the last second before it. One ticker per
/// engine also keeps concurrent runs from speeding up each other's clocks.
struct Ticker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Ticker {
    fn start(engine: Engine) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            let mut next = Instant::now() + Duration::from_secs(1);
            while !flag.load(Ordering::Relaxed) {
                let now = Instant::now();
                if now >= next {
                    engine.increment_epoch();
                    next += Duration::from_secs(1);
                } else {
                    std::thread::park_timeout(next - now);
                }
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}
