//! What Fairground's OutLayer job does, as a library (see `contracts/DESIGN.md`,
//! "Sealer").
//!
//! - [`SaleKeypair::derive`]: each sale's X25519 key, from the enclave's master
//!   secret with HKDF-SHA256.
//! - [`open_bid`]: opens a bid the app sealed (libsodium `crypto_box_seal`)
//!   and parses its canonical JSON.
//! - [`run`]: the whole job, one JSON request to one JSON response. Ops
//!   `pubkey` (publish a sale's key) and `clear` (check the bid set, decrypt,
//!   run `fairground_clearing::clear_with` with the fixed-shape price search,
//!   return positional fills).
//! - [`seal_bid`] (feature `seal`): what the app does in the browser, for tests.
//!   It seals [`BidPlaintext::to_canonical_json`], whose amounts are padded so
//!   every box for a given sale id and bidder has the same length
//!   (`fairground_clearing::sealed_bid_len`).
//!
//! The WASI binary around it (`enclave/job`) reads stdin and four environment
//! variables: `OUTLAYER_EXECUTION_TYPE`, `NEAR_PREDECESSOR_ID`,
//! `NEAR_SENDER_ID` and `PROTECTED_FAIRGROUND_MASTER`. It prints `run`'s answer,
//! or refuses the run before `run` sees it by failing it (exit status 1, a
//! fixed line on stderr): an HTTPS run, a missing account id, unreadable,
//! oversized or malformed input, a key repeated in the input, a non-`pubkey`
//! request signed by the contract account itself, or a missing or malformed
//! master. Pure Rust; builds natively and for `wasm32-wasip1` / `wasm32-wasip2`.

mod bid;
mod job;
mod keys;

#[cfg(feature = "seal")]
pub use bid::seal_bid;
pub use bid::{BidPlaintext, open_bid, open_bid_bytes};
pub use job::{Ctx, VERSION, run};
pub use keys::{KEY_INFO_PREFIX, KEY_SALT, SaleKeypair};
