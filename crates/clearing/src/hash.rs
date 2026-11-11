//! Bid-set hash (v1) and commit-reveal commitments (see `contracts/DESIGN.md`).
//!
//! ```text
//! h0 = sha256( "fairground/bidset/v1" || 0x00 || sale_id )
//! hi = sha256( h(i-1) || u32_be(i) || u8(len(bidder)) || bidder
//!              || u128_be(deposit) || sha256(payload) )      for bid index i = 0..n-1
//! bid_set_hash = hex(h_n)
//!
//! commitment = sha256( "fairground/commit/v1" || 0x00 || sale_id || 0x00 || bidder || 0x00
//!                      || u128_be(max_price) || u128_be(max_spend) || salt[16] )
//! ```
//!
//! The preimage builders are plain byte encodings, so the contract can hash
//! them with near's host sha256 (much cheaper than hashing in wasm). The
//! default `sha2` feature adds functions that do the hashing too.

use core::fmt;

/// Domain prefix of the bid-set hash seed.
pub const BID_SET_DOMAIN: &str = "fairground/bidset/v1";
/// Domain prefix of a commitment.
pub const COMMIT_DOMAIN: &str = "fairground/commit/v1";
/// Salt length of a commitment, bytes (the app's 32 hex characters).
pub const SALT_LEN: usize = 16;

/// Inputs the bid-set encoding cannot represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HashError {
    /// The bidder id is longer than 255 bytes, so its length does not fit one byte.
    BidderTooLong,
    /// The bid index would not fit its 4 bytes.
    TooManyBids,
}

impl fmt::Display for HashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BidderTooLong => "bidder id is longer than 255 bytes",
            Self::TooManyBids => "bid index does not fit in u32",
        })
    }
}

impl std::error::Error for HashError {}

/// Preimage of `h0`: `"fairground/bidset/v1" || 0x00 || sale_id`.
pub fn bid_set_seed_preimage(sale_id: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(BID_SET_DOMAIN.len() + 1 + sale_id.len());
    out.extend_from_slice(BID_SET_DOMAIN.as_bytes());
    out.push(0);
    out.extend_from_slice(sale_id.as_bytes());
    out
}

/// Preimage of `h(index + 1)` given the previous state `prev = h(index)` and
/// `payload_hash = sha256(payload)`.
pub fn bid_set_step_preimage(
    prev: &[u8; 32],
    index: u32,
    bidder: &str,
    deposit: u128,
    payload_hash: &[u8; 32],
) -> Result<Vec<u8>, HashError> {
    let bidder_len = u8::try_from(bidder.len()).map_err(|_| HashError::BidderTooLong)?;
    let mut out = Vec::with_capacity(32 + 4 + 1 + bidder.len() + 16 + 32);
    out.extend_from_slice(prev);
    out.extend_from_slice(&index.to_be_bytes());
    out.push(bidder_len);
    out.extend_from_slice(bidder.as_bytes());
    out.extend_from_slice(&deposit.to_be_bytes());
    out.extend_from_slice(payload_hash);
    Ok(out)
}

/// Preimage of a commit-reveal commitment.
pub fn commitment_preimage(
    sale_id: &str,
    bidder: &str,
    max_price: u128,
    max_spend: u128,
    salt: &[u8; SALT_LEN],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        COMMIT_DOMAIN.len() + 3 + sale_id.len() + bidder.len() + 16 + 16 + SALT_LEN,
    );
    out.extend_from_slice(COMMIT_DOMAIN.as_bytes());
    out.push(0);
    out.extend_from_slice(sale_id.as_bytes());
    out.push(0);
    out.extend_from_slice(bidder.as_bytes());
    out.push(0);
    out.extend_from_slice(&max_price.to_be_bytes());
    out.extend_from_slice(&max_spend.to_be_bytes());
    out.extend_from_slice(salt);
    out
}

/// Lowercase hex.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Exactly `2 * N` hex digits (either case) as bytes, else `None`. Parses a
/// 64-char commitment (`N = 32`) or a 32-char salt (`N = 16`).
pub fn parse_hex<const N: usize>(hex: &str) -> Option<[u8; N]> {
    let digits = hex.as_bytes();
    if digits.len() != 2 * N {
        return None;
    }
    let mut out = [0u8; N];
    for (byte, pair) in out.iter_mut().zip(digits.chunks_exact(2)) {
        *byte = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Some(out)
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(feature = "sha2")]
pub use with_sha2::*;

#[cfg(feature = "sha2")]
mod with_sha2 {
    use sha2::{Digest, Sha256};

    use super::{
        HashError, SALT_LEN, bid_set_seed_preimage, bid_set_step_preimage, commitment_preimage,
        to_hex,
    };

    /// SHA-256 of `bytes`.
    pub fn sha256(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    /// One bid as it enters the bid-set hash.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct BidSetEntry<'a> {
        pub bidder: &'a str,
        pub deposit: u128,
        /// Raw ciphertext bytes (TEE mode) or the 32-byte commitment (commit-reveal).
        pub payload: &'a [u8],
    }

    /// The running bid-set hash, updated one accepted bid at a time.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct BidSetHasher {
        state: [u8; 32],
        count: u32,
    }

    impl BidSetHasher {
        /// Starts at `h0` for this sale.
        pub fn new(sale_id: &str) -> Self {
            Self {
                state: sha256(&bid_set_seed_preimage(sale_id)),
                count: 0,
            }
        }

        /// Continues from a stored state after `count` bids.
        pub fn resume(state: [u8; 32], count: u32) -> Self {
            Self { state, count }
        }

        /// Adds the next bid (index = `count()`).
        pub fn push(
            &mut self,
            bidder: &str,
            deposit: u128,
            payload: &[u8],
        ) -> Result<(), HashError> {
            let next = self.count.checked_add(1).ok_or(HashError::TooManyBids)?;
            let preimage =
                bid_set_step_preimage(&self.state, self.count, bidder, deposit, &sha256(payload))?;
            self.state = sha256(&preimage);
            self.count = next;
            Ok(())
        }

        /// `h_n` as bytes.
        pub fn state(&self) -> [u8; 32] {
            self.state
        }

        /// Number of bids hashed so far.
        pub fn count(&self) -> u32 {
            self.count
        }

        /// `h_n` as lowercase hex, the published `bid_set_hash`.
        pub fn hex(&self) -> String {
            to_hex(&self.state)
        }
    }

    /// `bid_set_hash` of a whole bid list, in contract order.
    pub fn bid_set_hash<'a>(
        sale_id: &str,
        bids: impl IntoIterator<Item = BidSetEntry<'a>>,
    ) -> Result<String, HashError> {
        let mut hasher = BidSetHasher::new(sale_id);
        for bid in bids {
            hasher.push(bid.bidder, bid.deposit, bid.payload)?;
        }
        Ok(hasher.hex())
    }

    /// The commit-reveal commitment.
    pub fn commitment(
        sale_id: &str,
        bidder: &str,
        max_price: u128,
        max_spend: u128,
        salt: &[u8; SALT_LEN],
    ) -> [u8; 32] {
        sha256(&commitment_preimage(
            sale_id, bidder, max_price, max_spend, salt,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_and_rejects_bad_input() {
        let bytes = [0x00, 0x7f, 0xab, 0xff];
        assert_eq!(to_hex(&bytes), "007fabff");
        assert_eq!(parse_hex::<4>("007FabfF"), Some(bytes));
        assert_eq!(parse_hex::<4>("007fabf"), None);
        assert_eq!(parse_hex::<4>("007fabfff0"), None);
        assert_eq!(parse_hex::<2>("0g12"), None);
        assert_eq!(parse_hex::<2>("+1ab"), None);
        assert_eq!(parse_hex::<1>("é"), None);
        assert_eq!(parse_hex::<0>(""), Some([]));
    }

    #[test]
    fn step_preimage_layout() {
        let prev = [7u8; 32];
        let payload_hash = [9u8; 32];
        let got = bid_set_step_preimage(&prev, 258, "ab", 0x0102, &payload_hash).unwrap();
        let mut want = prev.to_vec();
        want.extend_from_slice(&[0, 0, 1, 2, 2, b'a', b'b']);
        want.extend_from_slice(&[0; 14]);
        want.extend_from_slice(&[1, 2]);
        want.extend_from_slice(&payload_hash);
        assert_eq!(got, want);
    }

    #[test]
    fn bidder_longer_than_255_bytes_is_an_error() {
        let h = [0u8; 32];
        assert!(bid_set_step_preimage(&h, 0, &"x".repeat(255), 1, &h).is_ok());
        assert_eq!(
            bid_set_step_preimage(&h, 0, &"x".repeat(256), 1, &h),
            Err(HashError::BidderTooLong)
        );
    }

    #[test]
    fn commitment_preimage_layout() {
        let salt = [0xaa; SALT_LEN];
        let got = commitment_preimage("s", "b", 1, 2, &salt);
        let mut want = b"fairground/commit/v1\0s\0b\0".to_vec();
        want.extend_from_slice(&1u128.to_be_bytes());
        want.extend_from_slice(&2u128.to_be_bytes());
        want.extend_from_slice(&salt);
        assert_eq!(got, want);
    }

    #[cfg(feature = "sha2")]
    #[test]
    fn hasher_resumes_and_stops_at_u32_max() {
        let mut whole = BidSetHasher::new("fairt");
        whole.push("alice.testnet", 5, b"one").unwrap();
        let mut resumed = BidSetHasher::resume(whole.state(), whole.count());
        whole.push("bob.testnet", 6, b"two").unwrap();
        resumed.push("bob.testnet", 6, b"two").unwrap();
        assert_eq!(resumed, whole);
        assert_eq!(whole.count(), 2);
        let entries = [
            BidSetEntry {
                bidder: "alice.testnet",
                deposit: 5,
                payload: b"one",
            },
            BidSetEntry {
                bidder: "bob.testnet",
                deposit: 6,
                payload: b"two",
            },
        ];
        assert_eq!(bid_set_hash("fairt", entries), Ok(whole.hex()));
        assert_eq!(
            sha256(b"abc"),
            parse_hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").unwrap()
        );

        let mut full = BidSetHasher::resume([0; 32], u32::MAX);
        assert_eq!(full.push("a", 1, b""), Err(HashError::TooManyBids));
        assert_eq!(full.count(), u32::MAX);
        assert_eq!(
            BidSetHasher::new("s").push(&"x".repeat(256), 1, b""),
            Err(HashError::BidderTooLong)
        );
    }
}
