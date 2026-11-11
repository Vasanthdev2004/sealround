//! Harness for Fairground's sandbox integration tests.
//!
//! Every test builds its own [`Env`] on the shared sandbox node: a fresh
//! parent account, OutLayer's real contract with the test as its operator,
//! `mock_ft` as USDC, and the Fairground contract configured with both. The
//! test then plays the OutLayer worker ([`Env::serve`]): it reads the pending
//! request, runs `fairground_sealer::run` (the enclave job's logic) with a test
//! master secret, and resolves the request the way the real worker does.
//!
//! Connection: `NEAR_SANDBOX_RPC` (default `http://127.0.0.1:3030`) and
//! `NEAR_SANDBOX_HOME` (default `<repo>/.sandbox-home`, holding the node's
//! `validator_key.json`). Start the node with `scripts/sandbox.ps1`.
//!
//! The chain is shared and persistent, so every account is new and unique, and
//! tests must run one at a time (`--test-threads=1`): `fast_forward` moves the
//! whole chain's clock, which would break other tests' bid windows and
//! OutLayer's 200-block yield window.

mod costs;
mod env;
mod outlayer;
mod report;
mod sale;

pub use costs::{fairground_const, outlayer_compute_deposit};
pub use env::{
    Env, EnvOptions, SEALER_CODE_HASH, fairground_config, parallel, u128_field, u128_value,
};
pub use outlayer::{Served, ensure_success, result_complete, result_now};
pub use report::{
    GasLine, event, events, gas_cost, outlayer_charged, receipt_gas, rejection_reason, tgas,
};
pub use sale::{
    Bidding, Mode, PlainBid, Proceeds, Sale, SaleSpec, expect_failure, expected_clearing,
    garbage_ciphertext, invalid_penalties, junk_ciphertext, sealed_len, tee_msg,
};

/// One USDC in base units (6 decimals).
pub const USDC: u128 = 1_000_000;
/// One whole sale token at 18 decimals.
pub const TOKEN: u128 = 1_000_000_000_000_000_000;
/// One NEAR in yoctoNEAR.
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Nanoseconds per second.
pub const SECOND: u64 = 1_000_000_000;
/// NEP-145 registration on any of the tokens here (125 bytes).
pub const STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;

/// `contracts/res/<name>`.
pub fn res(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("res")
        .join(name)
}
