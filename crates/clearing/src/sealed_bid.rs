//! The exact size of a sealed bid, for the contract to check without opening it.
//!
//! A TEE-mode bid is a libsodium sealed box (`crypto_box_seal`) of the canonical
//! JSON
//!
//! ```text
//! {"sale_id":"<id>","bidder":"<account>","max_price":"<39 digits>","max_spend":"<39 digits>","salt":"<32 hex>"}
//! ```
//!
//! with both amounts left-padded with zeros to [`PADDED_AMOUNT_DIGITS`] digits
//! (`fairground_sealer::BidPlaintext::to_canonical_json`, the app's
//! `canonicalBid`). Padded, the length no longer says how many digits a bid's
//! amounts have: it depends only on the sale id and the bidder, which are
//! public anyway.
//!
//! ```text
//! plaintext = 176 + len(sale_id) + len(bidder)    bytes
//! box       = plaintext + 48                      (32-byte ephemeral key + 16-byte tag)
//!           = 224 + len(sale_id) + len(bidder)
//! ```
//!
//! Lengths are in bytes. The formula holds when neither id needs escaping in
//! JSON, which is true of every valid sale id (`[a-z0-9_-]`) and NEAR account
//! id (`[a-z0-9._-]`).

use crate::hash::SALT_LEN;

/// Digits every amount is padded to: `u128::MAX` has 39, so any amount fits.
pub const PADDED_AMOUNT_DIGITS: usize = 39;

/// Bytes a sealed box adds to its plaintext: the 32-byte ephemeral X25519
/// public key and the 16-byte Poly1305 tag.
pub const SEALED_BOX_OVERHEAD: usize = 48;

/// The canonical JSON with every value empty: the keys, quotes and punctuation.
const EMPTY_PLAINTEXT: &str =
    r#"{"sale_id":"","bidder":"","max_price":"","max_spend":"","salt":""}"#;

/// Plaintext bytes that do not depend on the ids: the JSON around the values
/// (66), two padded amounts (2 x 39) and the salt as hex (32). Equal to 176.
pub const BID_PLAINTEXT_FIXED_LEN: usize =
    EMPTY_PLAINTEXT.len() + 2 * PADDED_AMOUNT_DIGITS + 2 * SALT_LEN;

/// Length of a bid's canonical plaintext, in bytes, for ids of these byte
/// lengths: `176 + sale_id_len + bidder_len`. Saturates at `usize::MAX`, which
/// is never a real length.
pub const fn bid_plaintext_len(sale_id_len: usize, bidder_len: usize) -> usize {
    BID_PLAINTEXT_FIXED_LEN
        .saturating_add(sale_id_len)
        .saturating_add(bidder_len)
}

/// Length of a sealed bid (the decoded box, not its base64), in bytes:
/// `224 + sale_id_len + bidder_len`. A TEE-mode bid of any other length was
/// not sealed by the app's canonical format. Saturates like
/// [`bid_plaintext_len`].
pub const fn sealed_bid_len(sale_id_len: usize, bidder_len: usize) -> usize {
    bid_plaintext_len(sale_id_len, bidder_len).saturating_add(SEALED_BOX_OVERHEAD)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_formula_in_the_docs() {
        assert_eq!(EMPTY_PLAINTEXT.len(), 66);
        assert_eq!(BID_PLAINTEXT_FIXED_LEN, 176);
        assert_eq!(bid_plaintext_len(0, 0), 176);
        assert_eq!(sealed_bid_len(0, 0), 224);
        assert_eq!(bid_plaintext_len(5, 13), 194);
        assert_eq!(sealed_bid_len(5, 13), 242);
        // The longest: a 32-byte sale id and a 64-byte account.
        assert_eq!(sealed_bid_len(32, 64), 320);
        for sale_id_len in 1..=32 {
            for bidder_len in 2..=64 {
                assert_eq!(
                    sealed_bid_len(sale_id_len, bidder_len),
                    224 + sale_id_len + bidder_len
                );
            }
        }
    }

    #[test]
    fn padded_amounts_fit_any_u128() {
        assert_eq!(u128::MAX.to_string().len(), PADDED_AMOUNT_DIGITS);
        assert_eq!(
            format!("{:0w$}", 0u128, w = PADDED_AMOUNT_DIGITS).len(),
            PADDED_AMOUNT_DIGITS
        );
    }

    #[test]
    fn absurd_lengths_saturate_instead_of_overflowing() {
        assert_eq!(bid_plaintext_len(usize::MAX, 1), usize::MAX);
        assert_eq!(sealed_bid_len(usize::MAX - 200, 0), usize::MAX);
        assert_eq!(sealed_bid_len(1, usize::MAX), usize::MAX);
    }

    /// Usable in a `const` item, as the contract may want.
    #[test]
    fn usable_in_const_context() {
        const LONGEST: usize = sealed_bid_len(32, 64);
        assert_eq!(LONGEST, 320);
    }
}
