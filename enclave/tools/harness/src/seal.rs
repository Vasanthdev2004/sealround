//! `fairground-seal`: seals one bid to a sale's public key, as the app does in
//! the browser, for the command-line smoke test of a clear
//! (`enclave/deploy/7-smoke-clear.ps1`).
//!
//! ```text
//! fairground-seal --pubkey HEX --sale-id ID --bidder ACCOUNT --max-price N --max-spend N
//! ```
//!
//! Prints the base64 sealed box on stdout, one line. The salt is 16 random
//! bytes from the operating system, so sealing the same bid twice gives
//! unrelated ciphertexts.
//!
//! The plaintext is the canonical one the app seals
//! ([`fairground_sealer::seal_bid`]): both amounts zero-padded to 39 digits,
//! so the box is always `224 + len(sale_id) + len(bidder)` bytes
//! (`fairground_clearing::sealed_bid_len`) and its length, public on chain
//! while bidding is open, says nothing about the amounts. The tool refuses ids
//! for which that does not hold (ids that need escaping in JSON, which no valid
//! sale id or NEAR account has).

use std::process::ExitCode;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use crypto_box::aead::OsRng;
use crypto_box::aead::rand_core::RngCore;
use fairground_clearing::hash::parse_hex;
use fairground_clearing::sealed_bid_len;
use fairground_sealer::{BidPlaintext, seal_bid};

const USAGE: &str = "usage: fairground-seal --pubkey HEX --sale-id ID --bidder ACCOUNT \
                     --max-price N --max-spend N";

fn main() -> ExitCode {
    match seal(std::env::args().skip(1)) {
        Ok(ciphertext) => {
            println!("{ciphertext}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("fairground-seal: {error}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// The base64 sealed box for these arguments, or what is wrong with them.
fn seal(args: impl Iterator<Item = String>) -> Result<String, String> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let (public_key, bid) = parse(args, salt)?;
    let ciphertext = seal_bid(&public_key, &bid);
    let len = BASE64
        .decode(&ciphertext)
        .map_err(|_| "the sealer wrote no base64".to_owned())?
        .len();
    let expected = sealed_bid_len(bid.sale_id.len(), bid.bidder.len());
    if len != expected {
        return Err(format!(
            "the box is {len} bytes, not {expected}: --sale-id and --bidder must not need escaping in JSON"
        ));
    }
    Ok(ciphertext)
}

/// The sale key and the bid the arguments describe, with this salt.
fn parse(
    mut args: impl Iterator<Item = String>,
    salt: [u8; 16],
) -> Result<([u8; 32], BidPlaintext), String> {
    let (mut pubkey, mut sale_id, mut bidder, mut max_price, mut max_spend) =
        (None, None, None, None, None);
    while let Some(flag) = args.next() {
        let slot = match flag.as_str() {
            "--pubkey" => &mut pubkey,
            "--sale-id" => &mut sale_id,
            "--bidder" => &mut bidder,
            "--max-price" => &mut max_price,
            "--max-spend" => &mut max_spend,
            _ => return Err(format!("unknown argument {flag}")),
        };
        *slot = Some(args.next().ok_or_else(|| format!("{flag} needs a value"))?);
    }
    let required = |value: Option<String>, flag: &str| value.ok_or(format!("{flag} is required"));
    let amount = |value: Option<String>, flag: &str| -> Result<u128, String> {
        let digits = required(value, flag)?;
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("{flag} must be a decimal integer, got {digits:?}"));
        }
        digits
            .parse()
            .map_err(|_| format!("{flag} does not fit u128"))
    };
    let pubkey = required(pubkey, "--pubkey")?;
    let public_key = parse_hex::<32>(&pubkey)
        .ok_or_else(|| format!("--pubkey must be 64 hex digits, got {pubkey:?}"))?;
    let bid = BidPlaintext {
        sale_id: required(sale_id, "--sale-id")?,
        bidder: required(bidder, "--bidder")?,
        max_price: amount(max_price, "--max-price")?,
        max_spend: amount(max_spend, "--max-spend")?,
        salt,
    };
    // The plaintext must be one the job accepts; it counts anything else invalid.
    if bid.sale_id.is_empty() || bid.bidder.is_empty() {
        return Err("--sale-id and --bidder must not be empty".into());
    }
    Ok((public_key, bid))
}

#[cfg(test)]
mod tests {
    use fairground_harness::{CONTRACT, TEST_MASTER};
    use fairground_sealer::{SaleKeypair, open_bid};

    use super::*;

    fn args(sale_id: &str, extra: &[&str]) -> Vec<String> {
        let key = SaleKeypair::derive(&TEST_MASTER, CONTRACT, sale_id).public_key_hex();
        [
            "--pubkey",
            &key,
            "--sale-id",
            sale_id,
            "--bidder",
            "alice.testnet",
            "--max-price",
            "2000",
            "--max-spend",
            "1000000",
        ]
        .iter()
        .chain(extra)
        .map(|arg| (*arg).to_owned())
        .collect()
    }

    #[test]
    fn seals_the_canonical_padded_bid() {
        let sale_id = "smoke-11091200";
        let ciphertext = seal(args(sale_id, &[]).into_iter()).unwrap();
        // 224 + 14 + 13, whatever the amounts.
        assert_eq!(BASE64.decode(&ciphertext).unwrap().len(), 251);
        let keypair = SaleKeypair::derive(&TEST_MASTER, CONTRACT, sale_id);
        let bid = open_bid(&ciphertext, &keypair).unwrap();
        assert_eq!(
            (
                bid.sale_id.as_str(),
                bid.bidder.as_str(),
                bid.max_price,
                bid.max_spend
            ),
            (sale_id, "alice.testnet", 2000, 1_000_000)
        );
        // Two seals of one bid share nothing but the length.
        let again = seal(args(sale_id, &[]).into_iter()).unwrap();
        assert_ne!(again, ciphertext);
        assert_eq!(again.len(), ciphertext.len());
    }

    #[test]
    fn the_box_length_does_not_depend_on_the_amounts() {
        let lengths: std::collections::BTreeSet<usize> = [
            ["1", "1"],
            ["2000", "1000000"],
            ["340282366920938463463374607431768211455", "1"],
        ]
        .iter()
        .map(|[price, spend]| {
            let mut list = args("fairt", &[]);
            list[7] = (*price).to_owned();
            list[9] = (*spend).to_owned();
            BASE64
                .decode(seal(list.into_iter()).unwrap())
                .unwrap()
                .len()
        })
        .collect();
        assert_eq!(lengths.into_iter().collect::<Vec<_>>(), [242]);
    }

    #[test]
    fn bad_arguments_are_refused() {
        let salt = [0; 16];
        // The unpadded form is gone: only the canonical bid is sealed.
        assert!(parse(args("fairt", &["--unpadded"]).into_iter(), salt).is_err());
        for (at, value) in [
            (1, "abc"),
            (7, "-1"),
            (7, "1e3"),
            (9, ""),
            (9, "340282366920938463463374607431768211456"),
        ] {
            let mut list = args("fairt", &[]);
            list[at] = value.to_owned();
            assert!(parse(list.into_iter(), salt).is_err(), "{at} {value}");
        }
        let mut no_bidder = args("fairt", &[]);
        no_bidder.drain(4..6);
        assert_eq!(
            parse(no_bidder.into_iter(), salt).unwrap_err(),
            "--bidder is required"
        );
        let mut empty = args("fairt", &[]);
        empty[5] = String::new();
        assert!(parse(empty.into_iter(), salt).is_err());
        // An id that needs escaping would break the length formula.
        let mut quoted = args("fairt", &[]);
        quoted[5] = "al\"ice".to_owned();
        assert!(seal(quoted.into_iter()).unwrap_err().contains("escaping"));
    }
}
