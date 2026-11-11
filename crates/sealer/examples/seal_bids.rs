//! Seals bids with this crate so `tests/fixtures/gen.mjs` can open them with
//! libsodium (the reverse of the libsodium fixture test).
//!
//! ```text
//! cargo run -p fairground-sealer --features seal --example seal_bids -- <public key hex>
//! ```
//!
//! Reads one bid JSON per stdin line and prints one base64 sealed box per line,
//! sealed to the given public key over the bid's canonical JSON.

use std::error::Error;
use std::io::{self, BufRead, Write};

use fairground_clearing::hash::parse_hex;
use fairground_sealer::{BidPlaintext, seal_bid};

fn main() -> Result<(), Box<dyn Error>> {
    let public_key = std::env::args()
        .nth(1)
        .and_then(|hex| parse_hex::<32>(&hex))
        .ok_or("usage: seal_bids <public key, 64 hex digits>")?;
    let mut out = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let line = line?;
        let bid = BidPlaintext::from_json(line.as_bytes())
            .ok_or_else(|| format!("not a well-formed bid: {line}"))?;
        writeln!(out, "{}", seal_bid(&public_key, &bid))?;
    }
    out.flush()?;
    Ok(())
}
