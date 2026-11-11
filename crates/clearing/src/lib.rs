//! Fairground's clearing rule, shared by the sale contract and the sealer enclave.
//!
//! An exact port of the TypeScript reference in `packages/clearing/src/clear.ts`:
//! the same input gives the same result, field for field. `tests/vectors.json`
//! is generated from the TypeScript code and the parity test checks every field.
//! [`clear_with`] can find the price with a fixed-shape search instead
//! ([`PriceSearch`]); the result is the same.
//!
//! All math is on u128 with 256-bit intermediates; no input makes it panic.
//! It builds for the contract (`wasm32-unknown-unknown`, use
//! `default-features = false` and hash with near's host sha256), the enclave
//! (`wasm32-wasip1`) and natively.
//!
//! [`sealed_bid`] gives the exact length of a sealed bid, so the contract can
//! check one without opening it.

mod checks;
mod clear;
pub mod hash;
pub mod math;
pub mod sealed_bid;

pub use checks::contract_checks;
pub use clear::{
    Bid, ClearingError, ClearingResult, ClearingStatus, FIXED_SHAPE_STEPS, FailReason, Fill,
    InvalidReason, MAX_DECIMALS, PriceSearch, SaleParams, ValidBid, clear, clear_with, cost_of,
    demand_at, one_token, prorate, tokens_for, validate_bid, validate_params,
};
pub use sealed_bid::{
    BID_PLAINTEXT_FIXED_LEN, PADDED_AMOUNT_DIGITS, SEALED_BOX_OVERHEAD, bid_plaintext_len,
    sealed_bid_len,
};
