//! The sealed bid: canonical JSON plaintext inside a libsodium sealed box.
//!
//! The app (`apps/web/src/lib/crypto.ts`, `canonicalBid` + `sealBid`) seals
//! `{"sale_id","bidder","max_price","max_spend","salt"}` in that key order with
//! no whitespace, the price and spend as decimal strings left-padded with
//! zeros to 39 digits (`PADDED_AMOUNT_DIGITS`) and the salt as 32 lowercase
//! hex characters, and sends it base64 encoded (standard alphabet, padded):
//!
//! ```text
//! {"sale_id":"fairt","bidder":"alice.testnet","max_price":"000000000000000000000000000000000001600","max_spend":"000000000000000000000000000000005000000","salt":"abababababababababababababababab"}
//! ```
//!
//! Padding makes the box length depend only on the sale id and the bidder
//! (`fairground_clearing::sealed_bid_len`: 224 + both lengths), never on how
//! many digits the amounts have. `tests/fixtures/canonical_bids.json` pins the
//! format for the app and the relayer.
//!
//! Reading is more lenient than writing: [`BidPlaintext::from_json`] accepts
//! amounts with or without leading zeros, keys in any order and whitespace, so
//! bids sealed before padding still open. The contract refuses a TEE bid whose
//! length is not the padded one.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_clearing::PADDED_AMOUNT_DIGITS;
use fairground_clearing::hash::{SALT_LEN, parse_hex, to_hex};
use serde::{Deserialize, Serialize};

use crate::keys::SaleKeypair;

/// What a bidder seals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BidPlaintext {
    /// The sale the bid is for. A bid copied into another sale is void.
    pub sale_id: String,
    /// The bidder's NEAR account. A ciphertext copied by another account is void.
    pub bidder: String,
    /// USDC base units per whole token.
    pub max_price: u128,
    /// USDC base units.
    pub max_spend: u128,
    /// Random bytes, so equal bids still give unrelated ciphertexts.
    pub salt: [u8; SALT_LEN],
}

/// The JSON shape, in canonical key order.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBid {
    sale_id: String,
    bidder: String,
    max_price: String,
    max_spend: String,
    salt: String,
}

impl BidPlaintext {
    /// The canonical JSON the app seals: keys in fixed order, no whitespace,
    /// both amounts zero-padded to [`PADDED_AMOUNT_DIGITS`] digits, salt in
    /// lowercase hex. Byte-equal to the app's `canonicalBid`
    /// (`JSON.stringify` with `padStart(39, "0")` on the amounts).
    ///
    /// For a valid sale id and bidder (nothing to escape) it is exactly
    /// `fairground_clearing::bid_plaintext_len(sale_id.len(), bidder.len())`
    /// bytes, whatever the amounts.
    pub fn to_canonical_json(&self) -> String {
        let wire = WireBid {
            sale_id: self.sale_id.clone(),
            bidder: self.bidder.clone(),
            max_price: padded(self.max_price),
            max_spend: padded(self.max_spend),
            salt: to_hex(&self.salt),
        };
        serde_json::to_string(&wire).expect("a struct of strings always serializes")
    }

    /// Parses a decrypted plaintext. Every field is required, no other field is
    /// allowed, amounts are decimal strings that fit u128 (any number of
    /// leading zeros, so padded and unpadded both parse) and the salt is
    /// exactly 32 hex digits. Anything else is `None`.
    pub fn from_json(bytes: &[u8]) -> Option<Self> {
        let wire: WireBid = serde_json::from_slice(bytes).ok()?;
        Some(Self {
            max_price: parse_u128(&wire.max_price)?,
            max_spend: parse_u128(&wire.max_spend)?,
            salt: parse_hex::<SALT_LEN>(&wire.salt)?,
            sale_id: wire.sale_id,
            bidder: wire.bidder,
        })
    }
}

/// An amount as the canonical JSON writes it: decimal, left-padded with zeros
/// to [`PADDED_AMOUNT_DIGITS`] digits (`u128::MAX` has exactly that many).
fn padded(amount: u128) -> String {
    format!("{amount:0width$}", width = PADDED_AMOUNT_DIGITS)
}

/// A non-empty string of ASCII digits that fits u128. Leading zeros are allowed;
/// signs, spaces and exponents are not.
pub(crate) fn parse_u128(digits: &str) -> Option<u128> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Opens a base64 sealed bid. `None` if it is not base64, does not open with
/// this key, or does not hold a well-formed plaintext.
pub fn open_bid(ciphertext_b64: &str, keypair: &SaleKeypair) -> Option<BidPlaintext> {
    open_bid_bytes(&BASE64.decode(ciphertext_b64).ok()?, keypair)
}

/// [`open_bid`] on the already decoded ciphertext bytes.
pub fn open_bid_bytes(ciphertext: &[u8], keypair: &SaleKeypair) -> Option<BidPlaintext> {
    BidPlaintext::from_json(&keypair.open(ciphertext)?)
}

/// Seals a bid to a sale's public key, as the app does in the browser.
/// Returns base64 (standard, padded).
///
/// # Panics
///
/// If the operating system's random source fails.
#[cfg(feature = "seal")]
pub fn seal_bid(public_key: &[u8; 32], plaintext: &BidPlaintext) -> String {
    use crypto_box::{PublicKey, aead::OsRng};

    let sealed = PublicKey::from_bytes(*public_key)
        .seal(&mut OsRng, plaintext.to_canonical_json().as_bytes())
        .expect("sealing into a growable buffer cannot fail");
    BASE64.encode(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BidPlaintext {
        BidPlaintext {
            sale_id: "fairt".into(),
            bidder: "alice.testnet".into(),
            max_price: 1600,
            max_spend: 5_000_000,
            salt: [0xab; SALT_LEN],
        }
    }

    /// Byte-equal to the app's padded `canonicalBid` (the module docs show it).
    #[test]
    fn canonical_json_has_fixed_order_padded_amounts_and_round_trips() {
        let json = sample().to_canonical_json();
        assert_eq!(
            json,
            r#"{"sale_id":"fairt","bidder":"alice.testnet","max_price":"000000000000000000000000000000000001600","max_spend":"000000000000000000000000000000005000000","salt":"abababababababababababababababab"}"#
        );
        assert_eq!(json.len(), 176 + "fairt".len() + "alice.testnet".len());
        assert_eq!(BidPlaintext::from_json(json.as_bytes()), Some(sample()));
    }

    #[test]
    fn the_plaintext_length_does_not_depend_on_the_amounts() {
        let amounts = [0, 1, 9, 10, 1600, 5_000_000, 10u128.pow(38), u128::MAX];
        for max_price in amounts {
            for max_spend in amounts {
                let bid = BidPlaintext {
                    max_price,
                    max_spend,
                    ..sample()
                };
                let json = bid.to_canonical_json();
                assert_eq!(
                    json.len(),
                    fairground_clearing::bid_plaintext_len(5, 13),
                    "{json}"
                );
                assert_eq!(BidPlaintext::from_json(json.as_bytes()), Some(bid));
            }
        }
        assert!(
            BidPlaintext {
                max_price: u128::MAX,
                ..sample()
            }
            .to_canonical_json()
            .contains(r#""max_price":"340282366920938463463374607431768211455""#)
        );
    }

    /// Bids sealed before padding (plain decimal amounts) still parse, to the
    /// same bid.
    #[test]
    fn unpadded_and_overpadded_amounts_still_parse() {
        for json in [
            r#"{"sale_id":"fairt","bidder":"alice.testnet","max_price":"1600","max_spend":"5000000","salt":"abababababababababababababababab"}"#,
            r#"{"sale_id":"fairt","bidder":"alice.testnet","max_price":"0001600","max_spend":"0000000000000000000000000000000000000000005000000","salt":"abababababababababababababababab"}"#,
        ] {
            assert_eq!(
                BidPlaintext::from_json(json.as_bytes()),
                Some(sample()),
                "{json}"
            );
        }
    }

    #[test]
    fn parse_u128_accepts_only_plain_digits() {
        assert_eq!(parse_u128("0"), Some(0));
        assert_eq!(parse_u128("007"), Some(7));
        assert_eq!(parse_u128(&u128::MAX.to_string()), Some(u128::MAX));
        for bad in [
            "",
            "+1",
            "-1",
            " 1",
            "1 ",
            "1e3",
            "1.0",
            "0x10",
            "340282366920938463463374607431768211456",
            "١",
        ] {
            assert_eq!(parse_u128(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn malformed_plaintexts_are_rejected() {
        let good = r#"{"sale_id":"s","bidder":"b","max_price":"1","max_spend":"2","salt":"00000000000000000000000000000000"}"#;
        assert!(BidPlaintext::from_json(good.as_bytes()).is_some());
        // Key order and whitespace do not matter to the parser.
        let reordered = r#"{ "salt":"00000000000000000000000000000000","max_spend":"2","max_price":"1","bidder":"b","sale_id":"s" }"#;
        assert!(BidPlaintext::from_json(reordered.as_bytes()).is_some());
        for bad in [
            "",
            "null",
            "[]",
            "not json",
            r#"{"sale_id":"s","bidder":"b","max_price":1,"max_spend":"2","salt":"00000000000000000000000000000000"}"#,
            r#"{"sale_id":"s","bidder":"b","max_price":"1","max_spend":"2"}"#,
            r#"{"sale_id":"s","bidder":"b","max_price":"1","max_spend":"2","salt":"00000000000000000000000000000000","x":1}"#,
            r#"{"sale_id":"s","sale_id":"t","bidder":"b","max_price":"1","max_spend":"2","salt":"00000000000000000000000000000000"}"#,
            r#"{"sale_id":"s","bidder":"b","max_price":"1","max_spend":"2","salt":"0000000000000000000000000000000"}"#,
            r#"{"sale_id":"s","bidder":"b","max_price":"1","max_spend":"2","salt":"000000000000000000000000000000zz"}"#,
            r#"{"sale_id":"s","bidder":null,"max_price":"1","max_spend":"2","salt":"00000000000000000000000000000000"}"#,
            r#"{"sale_id":"s","bidder":"b","max_price":"-1","max_spend":"2","salt":"00000000000000000000000000000000"}"#,
        ] {
            assert_eq!(BidPlaintext::from_json(bad.as_bytes()), None, "{bad}");
        }
        assert_eq!(BidPlaintext::from_json(&[0xff, 0xfe]), None);
    }

    #[test]
    fn open_bid_rejects_garbage_without_panicking() {
        let keypair = SaleKeypair::derive(&[3; 32], "fairground.testnet", "fairt");
        assert_eq!(open_bid("", &keypair), None);
        assert_eq!(open_bid("not base64!", &keypair), None);
        assert_eq!(open_bid("AAAA", &keypair), None);
        assert_eq!(open_bid_bytes(&[0; 32], &keypair), None);
        assert_eq!(open_bid_bytes(&[9; 48], &keypair), None);
        assert_eq!(open_bid_bytes(&[9; 200], &keypair), None);
    }

    #[cfg(feature = "seal")]
    #[test]
    fn seal_then_open_round_trips_only_with_the_right_key() {
        let keypair = SaleKeypair::derive(&[3; 32], "fairground.testnet", "fairt");
        let other = SaleKeypair::derive(&[3; 32], "fairground.testnet", "other");
        let sealed = seal_bid(&keypair.public_key(), &sample());
        assert_eq!(open_bid(&sealed, &keypair), Some(sample()));
        assert_eq!(open_bid(&sealed, &other), None);
        // Fresh randomness every time.
        assert_ne!(sealed, seal_bid(&keypair.public_key(), &sample()));
    }
}
