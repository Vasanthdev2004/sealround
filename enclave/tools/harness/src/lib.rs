//! Inputs for the enclave job, built the way the app and the contract build
//! them.
//!
//! - [`TEST_MASTER`] is the master secret every fixture uses. It is a test
//!   value, never a real secret.
//! - [`BidBook::generate`] makes `n` bids sealed with
//!   [`fairground_sealer::seal_bid`] to the sale's public key, with every kind
//!   of invalid bid mixed in ([`Kind`]). `seal_bid` seals the canonical
//!   plaintext the app seals, both amounts zero-padded to 39 digits, so every
//!   box of a bidder is `sealed_bid_len(sale_id, bidder)` bytes long.
//! - [`BidBook::generate_with`] is the same book with a chosen number of bids
//!   at a chosen top max price, to compare instruction counts.
//! - [`BidBook::worst_case`] is the largest clear request `n` bids can make.
//! - [`pubkey_request`] and [`BidBook::clear_request`] give the `input_data`
//!   the contract sends: the same keys and values. Only the order of the keys
//!   differs (`serde_json` writes them alphabetically; the contract writes
//!   `v`, `op`, `contract`, `sale_id`, ...), which the job does not look at
//!   and which moves a clear's instruction count by about 3,000 (PERF.md).
//! - [`seal_bytes`] seals any bytes, for plaintexts the app does not write:
//!   bids sealed before padding, and plaintexts padded with spaces.
//!
//! A book is deterministic: bidders, deposits, prices, spends, salts and which
//! bids are invalid come from a generator seeded with `n`, so the clearing
//! result of a book of size `n` never changes. Only the ciphertext bytes (and
//! with them the bid-set hash) differ between generations, because `seal_bid`
//! takes its ephemeral key from the OS, as the browser does.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_clearing::SaleParams;
use fairground_clearing::hash::{BidSetEntry, bid_set_hash, to_hex};
use fairground_sealer::{BidPlaintext, Ctx, SaleKeypair, seal_bid};
use serde_json::json;

/// The master secret of every fixture: 32 ASCII bytes, so a leak of the raw
/// bytes is as easy to spot as a leak of the hex. Never a real secret.
pub const TEST_MASTER: [u8; 32] = *b"fairground TEST master, not real";
/// The sale contract, which is also the run's predecessor.
pub const CONTRACT: &str = "fairground.testnet";
/// The sale every generated book is for.
pub const SALE_ID: &str = "fairt";
/// Another sale, for bids that belong elsewhere. As long as [`SALE_ID`], so
/// its boxes have the length the contract expects for this sale.
pub const OTHER_SALE_ID: &str = "other";
/// The sale of [`BidBook::worst_case`]: 32 bytes, the longest sale id the
/// contract allows.
pub const WORST_SALE_ID: &str = "a234567890123456789012345678901z";
/// The env var the job reads the master from.
pub const MASTER_VAR: &str = "PROTECTED_FAIRGROUND_MASTER";
/// USDC base units per whole token (0.001 USDC).
pub const FLOOR_PRICE: u128 = 1_000;
/// Token decimals, as most NEAR tokens have.
pub const DECIMALS: u8 = 18;
/// The max price of the one top bid in a [`BidBook::generate`] book: a bid
/// that will pay any price. With the job's fixed-shape price search it costs
/// what any other valid bid costs (the wasm test
/// `the_top_max_price_does_not_change_the_instruction_count`).
pub const WHALE_PRICE: u128 = 1_000_000_000_000_000_000_000_000_000_000;
/// The longest ciphertext the sale contract accepted before it checked the
/// exact length, in bytes. Today it refuses a TEE bid of any length but
/// `sealed_bid_len(sale_id, bidder)` (`wrong_ciphertext_length`), which is at
/// most `sealed_bid_len(32, 64)` = 320 bytes (`MAX_CIPHERTEXT_BYTES`,
/// contracts/fairground/src/costs.rs), so a box this long cannot reach the
/// job through the contract any more. The job itself sets no length: it
/// reads a plaintext padded some other way all the same, and the tests keep
/// this case as an upper bound on what a clear can cost.
pub const LEGACY_MAX_CIPHERTEXT_BYTES: usize = 512;

/// [`TEST_MASTER`] as the 64 hex digits the job reads.
pub fn master_hex() -> String {
    to_hex(&TEST_MASTER)
}

/// Seals any bytes to a sale's public key, as libsodium's `crypto_box_seal`
/// does, and returns base64 (standard, padded). For the canonical plaintext
/// use [`fairground_sealer::seal_bid`].
///
/// # Panics
///
/// If the operating system's random source fails.
pub fn seal_bytes(public_key: &[u8; 32], plaintext: &[u8]) -> String {
    let sealed = crypto_box::PublicKey::from_bytes(*public_key)
        .seal(&mut crypto_box::aead::OsRng, plaintext)
        .expect("sealing into a growable buffer cannot fail");
    BASE64.encode(sealed)
}

/// A bid's plaintext as the app sealed it before amounts were padded: the
/// canonical key order with both amounts as plain decimal strings. Only for
/// tests that show the job still opens such bids; nothing seals it any more.
pub fn unpadded_plaintext(bid: &BidPlaintext) -> String {
    format!(
        r#"{{"sale_id":{},"bidder":{},"max_price":"{}","max_spend":"{}","salt":"{}"}}"#,
        json!(bid.sale_id),
        json!(bid.bidder),
        bid.max_price,
        bid.max_spend,
        to_hex(&bid.salt),
    )
}

/// What the native `fairground_sealer::run` needs to answer like the job.
pub fn ctx(predecessor: &str) -> Ctx {
    Ctx {
        predecessor: predecessor.to_owned(),
        master: TEST_MASTER,
    }
}

/// The public key of a sale of [`CONTRACT`] under [`TEST_MASTER`], as hex: what
/// a `pubkey` answer and a `clear` answer for that sale carry.
pub fn sale_pubkey_hex(sale_id: &str) -> String {
    SaleKeypair::derive(&TEST_MASTER, CONTRACT, sale_id).public_key_hex()
}

/// The `pubkey` request for the fixture sale.
pub fn pubkey_request() -> String {
    json!({"v": 1, "op": "pubkey", "contract": CONTRACT, "sale_id": SALE_ID}).to_string()
}

/// The sale terms of a book of `n` bids: oversubscribed about three times at
/// the floor, so clearing searches for the price and prorates at the margin.
pub fn params(n: usize) -> SaleParams {
    let n = u128::try_from(n.max(1)).unwrap_or(u128::MAX);
    SaleParams {
        sale_supply: n * 100_000 * 10u128.pow(u32::from(DECIMALS)),
        floor_price: FLOOR_PRICE,
        min_raise: 1_000_000,
        decimals: DECIMALS,
        max_price: None,
    }
}

/// What a bid in a book is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Valid,
    /// Random bytes of the length a sealed bid has, not a sealed box.
    Garbage,
    /// An earlier bidder's ciphertext, copied. It opens, but names that bidder.
    Copied,
    /// Sealed to another sale's key, so it does not open here.
    OtherKey,
    /// Sealed to this sale's key, but the plaintext names another sale.
    OtherSale,
    /// Opens, but the max price is below the floor.
    BelowFloor,
    /// Opens, but the max spend is above the deposit.
    SpendAboveDeposit,
    /// Opens, but the max spend is zero.
    ZeroSpend,
}

/// One bid as the contract records it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub bidder: String,
    pub deposit: u128,
    pub ciphertext: String,
    pub kind: Kind,
}

/// The bids of one sale, in contract order.
#[derive(Debug, Clone)]
pub struct BidBook {
    pub sale_id: String,
    pub params: SaleParams,
    pub bids: Vec<Entry>,
}

impl BidBook {
    /// `n` bids: mostly valid, about one in ten invalid (every [`Kind`]), and
    /// for `n >= 3` one bid at [`WHALE_PRICE`] in the middle of the book. The
    /// first bid is always valid.
    pub fn generate(n: usize) -> Self {
        Self::generate_with(n, WHALE_PRICE, 1)
    }

    /// [`BidBook::generate`] with `top_bids` top bids at `top_price` instead
    /// of one at [`WHALE_PRICE`]. For `n >= 3` the top bids sit at evenly
    /// spaced places (`top_bids` = 1: the middle) and are valid. Every other
    /// bid, and every other value of a top bid, depends on `n` and
    /// `top_bids` only, so books that differ only in `top_price` differ only
    /// in those prices (and in the ciphertexts' random bytes).
    pub fn generate_with(n: usize, top_price: u128, top_bids: usize) -> Self {
        let key = SaleKeypair::derive(&TEST_MASTER, CONTRACT, SALE_ID).public_key();
        let other_key = SaleKeypair::derive(&TEST_MASTER, CONTRACT, OTHER_SALE_ID).public_key();
        let mut rng = SplitMix64(0x6661_6972_6772_6f75 ^ n as u64);
        let mut bids: Vec<Entry> = Vec::with_capacity(n);
        // Bids whose ciphertext opens with this sale's key and names its bidder.
        let mut copyable: Vec<usize> = Vec::new();
        let top_bids = top_bids.min(n);
        let is_top =
            |i: usize| n >= 3 && (0..top_bids).any(|k| i == (2 * k + 1) * n / (2 * top_bids));

        for i in 0..n {
            let bidder = format!("bidder-{i:04}.testnet");
            // 1 to 1000 USDC.
            let deposit = 1_000_000 + u128::from(rng.below(999_000_001));
            let top = is_top(i);
            let kind = match rng.below(100) {
                _ if i == 0 || top => Kind::Valid,
                0 | 1 => Kind::Garbage,
                2 | 3 if !copyable.is_empty() => Kind::Copied,
                4 => Kind::OtherKey,
                5 => Kind::OtherSale,
                6 | 7 => Kind::BelowFloor,
                8 => Kind::SpendAboveDeposit,
                9 => Kind::ZeroSpend,
                _ => Kind::Valid,
            };
            let max_price = match kind {
                Kind::BelowFloor => 1 + u128::from(rng.below(999)),
                _ if top => top_price,
                _ => FLOOR_PRICE + u128::from(rng.below(4_000)),
            };
            let max_spend = match kind {
                Kind::ZeroSpend => 0,
                Kind::SpendAboveDeposit => deposit + 1 + u128::from(rng.below(1_000_000)),
                // Half the deposit to all of it.
                _ => {
                    deposit / 2 + u128::from(rng.below(u64::try_from(deposit / 2).unwrap_or(0) + 1))
                }
            };
            let plaintext = BidPlaintext {
                sale_id: if kind == Kind::OtherSale {
                    OTHER_SALE_ID
                } else {
                    SALE_ID
                }
                .to_owned(),
                bidder: bidder.clone(),
                max_price,
                max_spend,
                salt: rng.bytes(),
            };
            let ciphertext = match kind {
                Kind::Garbage => {
                    let len = fairground_clearing::sealed_bid_len(SALE_ID.len(), bidder.len());
                    BASE64.encode((0..len).map(|_| rng.next() as u8).collect::<Vec<u8>>())
                }
                Kind::Copied => {
                    let from =
                        copyable[usize::try_from(rng.below(copyable.len() as u64)).unwrap_or(0)];
                    bids[from].ciphertext.clone()
                }
                Kind::OtherKey => seal_bid(&other_key, &plaintext),
                _ => seal_bid(&key, &plaintext),
            };
            if matches!(
                kind,
                Kind::Valid | Kind::BelowFloor | Kind::SpendAboveDeposit | Kind::ZeroSpend
            ) {
                copyable.push(i);
            }
            bids.push(Entry {
                bidder,
                deposit,
                ciphertext,
                kind,
            });
        }
        Self {
            sale_id: SALE_ID.to_owned(),
            params: params(n),
            bids,
        }
    }

    /// The largest clear request `n` bids can make, every bid valid: the
    /// longest sale id ([`WORST_SALE_ID`], 32 bytes), 64-byte bidder ids,
    /// 39-digit deposits and one bid at a max price of 1e38. Real sales cannot
    /// take deposits that large (the contract caps
    /// `max_deposit_per_account * 10^decimals` at u128), which only makes the
    /// input larger than any real one.
    ///
    /// `box_len`: `None` seals the canonical plaintext, so every box is
    /// `sealed_bid_len(32, 64)` = 320 bytes, the most the app writes.
    /// `Some(len)` pads each plaintext with spaces after the JSON so its box
    /// is `len` bytes. [`LEGACY_MAX_CIPHERTEXT_BYTES`] is the longest box an
    /// earlier contract let through; the current one refuses it.
    ///
    /// # Panics
    ///
    /// If `len` is shorter than the canonical box.
    pub fn worst_case(n: usize, box_len: Option<usize>) -> Self {
        let key = SaleKeypair::derive(&TEST_MASTER, CONTRACT, WORST_SALE_ID).public_key();
        let mut rng = SplitMix64(0x776f_7273_7463_6173 ^ n as u64);
        let bids = (0..n)
            .map(|i| {
                let bidder = format!("{:0>59}.near", format!("b{i}"));
                let deposit = 10u128.pow(38) + u128::try_from(i).unwrap_or(0);
                let max_price = if i == n / 2 {
                    10u128.pow(38)
                } else {
                    FLOOR_PRICE + u128::from(rng.below(50_000))
                };
                let plaintext = BidPlaintext {
                    sale_id: WORST_SALE_ID.to_owned(),
                    bidder: bidder.clone(),
                    max_price,
                    max_spend: 1_000_000 + u128::from(rng.below(9_000_000)),
                    salt: rng.bytes(),
                };
                let ciphertext = match box_len {
                    None => seal_bid(&key, &plaintext),
                    Some(len) => {
                        let mut padded = plaintext.to_canonical_json();
                        let plaintext_len = len - fairground_clearing::SEALED_BOX_OVERHEAD;
                        assert!(padded.len() <= plaintext_len, "{len} is too short");
                        padded.extend(std::iter::repeat_n(' ', plaintext_len - padded.len()));
                        seal_bytes(&key, padded.as_bytes())
                    }
                };
                Entry {
                    bidder,
                    deposit,
                    ciphertext,
                    kind: Kind::Valid,
                }
            })
            .collect();
        Self {
            sale_id: WORST_SALE_ID.to_owned(),
            params: SaleParams {
                sale_supply: 600_000 * 10u128.pow(u32::from(DECIMALS)),
                floor_price: FLOOR_PRICE,
                min_raise: 50_000_000,
                decimals: DECIMALS,
                max_price: None,
            },
            bids,
        }
    }

    /// How many bids of this kind the book has.
    pub fn count(&self, kind: Kind) -> usize {
        self.bids.iter().filter(|bid| bid.kind == kind).count()
    }

    /// The indices of the bids that are not [`Kind::Valid`], ascending: what
    /// the `clear` answer's `invalid` must list.
    pub fn invalid_indices(&self) -> Vec<usize> {
        (0..self.bids.len())
            .filter(|&i| self.bids[i].kind != Kind::Valid)
            .collect()
    }

    /// The bid-set hash the contract would have recorded for these bids.
    pub fn bid_set_hash(&self) -> String {
        let payloads: Vec<Vec<u8>> = self
            .bids
            .iter()
            .map(|bid| BASE64.decode(&bid.ciphertext).expect("fixtures are base64"))
            .collect();
        bid_set_hash(
            &self.sale_id,
            self.bids
                .iter()
                .zip(&payloads)
                .map(|(bid, payload)| BidSetEntry {
                    bidder: &bid.bidder,
                    deposit: bid.deposit,
                    payload,
                }),
        )
        .expect("fixture bidders are short and few")
    }

    /// The `clear` request the contract sends for this book.
    pub fn clear_request(&self) -> String {
        self.clear_request_with_hash(&self.bid_set_hash())
    }

    /// The `clear` request with any `bid_set_hash`, to test a mismatch.
    pub fn clear_request_with_hash(&self, bid_set_hash: &str) -> String {
        let params = &self.params;
        json!({
            "v": 1,
            "op": "clear",
            "contract": CONTRACT,
            "sale_id": self.sale_id,
            "params": {
                "sale_supply": params.sale_supply.to_string(),
                "floor_price": params.floor_price.to_string(),
                "max_price": params.max_price.map(|price| price.to_string()),
                "min_raise": params.min_raise.to_string(),
                "decimals": params.decimals,
            },
            "bid_set_hash": bid_set_hash,
            "bids": self.bids
                .iter()
                .map(|bid| json!([bid.bidder, bid.deposit.to_string(), bid.ciphertext]))
                .collect::<Vec<_>>(),
        })
        .to_string()
    }
}

/// SplitMix64: small, seedable and good enough to spread test values.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A value in `0..bound` (the modulo bias does not matter here).
    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }

    fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        for byte in &mut out {
            *byte = self.next() as u8;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use fairground_clearing::hash::parse_hex;
    use fairground_clearing::{PADDED_AMOUNT_DIGITS, SEALED_BOX_OVERHEAD, sealed_bid_len};
    use fairground_sealer::{open_bid, run};
    use serde_json::Value;

    use super::*;

    /// The bid plaintext format written out by hand, independently of the
    /// sealer: canonical key order, no whitespace, both amounts left-padded
    /// with zeros to 39 digits, the salt as lowercase hex. It was the
    /// harness's own `padded_plaintext` before the sealer padded; it stays as
    /// the reference the sealer's output is checked against.
    fn reference_plaintext(bid: &BidPlaintext) -> String {
        format!(
            r#"{{"sale_id":{},"bidder":{},"max_price":"{:0width$}","max_spend":"{:0width$}","salt":"{}"}}"#,
            json!(bid.sale_id),
            json!(bid.bidder),
            bid.max_price,
            bid.max_spend,
            to_hex(&bid.salt),
            width = PADDED_AMOUNT_DIGITS,
        )
    }

    /// `crates/sealer/tests/fixtures/canonical_bids.json`: the rows the app and
    /// the relayer check their own code against.
    fn fixture_rows() -> Vec<Value> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../crates/sealer/tests/fixtures/canonical_bids.json"
        );
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let fixture: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(fixture["padded_amount_digits"], PADDED_AMOUNT_DIGITS);
        fixture["rows"].as_array().unwrap().clone()
    }

    #[test]
    fn the_master_is_the_test_value() {
        assert_eq!(
            master_hex(),
            "6661697267726f756e642054455354206d61737465722c206e6f74207265616c"
        );
    }

    /// One implementation of the format (the sealer's), checked against an
    /// independent one and against the shared fixture.
    #[test]
    fn the_sealer_writes_the_reference_plaintext_and_box_length() {
        let rows = fixture_rows();
        assert!(rows.len() >= 50, "{}", rows.len());
        let mut bids: Vec<(BidPlaintext, Option<String>)> = rows
            .iter()
            .map(|row| {
                let text = |key: &str| row[key].as_str().unwrap().to_owned();
                let bid = BidPlaintext {
                    sale_id: text("sale_id"),
                    bidder: text("bidder"),
                    max_price: text("max_price").parse().unwrap(),
                    max_spend: text("max_spend").parse().unwrap(),
                    salt: parse_hex::<16>(&text("salt")).unwrap(),
                };
                assert_eq!(
                    row["sealed_len"],
                    sealed_bid_len(bid.sale_id.len(), bid.bidder.len())
                );
                (bid, Some(text("plaintext")))
            })
            .collect();
        for (max_price, max_spend) in [(1, 1), (1_600, 5_000_000), (WHALE_PRICE, u128::MAX)] {
            let bid = BidPlaintext {
                sale_id: WORST_SALE_ID.into(),
                bidder: format!("{:0>59}.near", "b7"),
                max_price,
                max_spend,
                salt: [0xab; 16],
            };
            bids.push((bid, None));
        }

        for (bid, fixture) in bids {
            let canonical = bid.to_canonical_json();
            assert_eq!(canonical, reference_plaintext(&bid));
            if let Some(fixture) = fixture {
                assert_eq!(canonical, fixture);
            }
            assert_eq!(
                canonical.len() + SEALED_BOX_OVERHEAD,
                sealed_bid_len(bid.sale_id.len(), bid.bidder.len()),
                "{canonical}"
            );
            let keypair = SaleKeypair::derive(&TEST_MASTER, CONTRACT, &bid.sale_id);
            let ciphertext = seal_bid(&keypair.public_key(), &bid);
            assert_eq!(
                BASE64.decode(&ciphertext).unwrap().len(),
                sealed_bid_len(bid.sale_id.len(), bid.bidder.len())
            );
            assert_eq!(open_bid(&ciphertext, &keypair), Some(bid.clone()));
            // A bid sealed before padding still opens to the same bid.
            let unpadded = unpadded_plaintext(&bid);
            assert!(unpadded.len() <= canonical.len());
            // The two forms differ only in zeros.
            assert_eq!(
                unpadded.replace('0', ""),
                canonical.replace('0', ""),
                "{unpadded}"
            );
            let legacy = seal_bytes(&keypair.public_key(), unpadded.as_bytes());
            assert_eq!(open_bid(&legacy, &keypair), Some(bid));
        }
    }

    #[test]
    fn books_are_deterministic_but_for_the_ciphertexts() {
        let a = BidBook::generate(200);
        let b = BidBook::generate(200);
        for (x, y) in a.bids.iter().zip(&b.bids) {
            assert_eq!(
                (&x.bidder, x.deposit, x.kind),
                (&y.bidder, y.deposit, y.kind)
            );
        }
        assert_eq!(answer_without_hash(&a), answer_without_hash(&b));
    }

    fn answer_without_hash(book: &BidBook) -> Value {
        let mut value: Value =
            serde_json::from_str(&run(&book.clear_request(), &ctx(CONTRACT))).unwrap();
        value.as_object_mut().unwrap().remove("bid_set_hash");
        value
    }

    #[test]
    fn a_book_has_every_kind_of_bid_and_clears() {
        let book = BidBook::generate(500);
        for kind in [
            Kind::Valid,
            Kind::Garbage,
            Kind::Copied,
            Kind::OtherKey,
            Kind::OtherSale,
            Kind::BelowFloor,
            Kind::SpendAboveDeposit,
            Kind::ZeroSpend,
        ] {
            assert!(book.count(kind) > 0, "{kind:?}");
        }
        // Every box, garbage included, has the one length a padded bid of
        // its bidder has, so all of them pass a contract that checks it.
        for bid in &book.bids {
            assert_eq!(
                BASE64.decode(&bid.ciphertext).unwrap().len(),
                sealed_bid_len(SALE_ID.len(), bid.bidder.len()),
                "{bid:?}"
            );
        }
        let answer: Value =
            serde_json::from_str(&run(&book.clear_request(), &ctx(CONTRACT))).unwrap();
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["pubkey"], sale_pubkey_hex(SALE_ID));
        assert_eq!(answer["n_valid"], book.count(Kind::Valid));
        assert_eq!(answer["n_invalid"], 500 - book.count(Kind::Valid));
        assert_eq!(answer["invalid"], json!(book.invalid_indices()));
        assert_eq!(answer["fills"].as_array().unwrap().len(), 500);
        // Exactly these fields, in the order contracts/DESIGN.md gives.
        assert_eq!(answer.as_object().unwrap().len(), 11, "{answer:.300}");
        let order = [
            "v",
            "ok",
            "op",
            "sale_id",
            "bid_set_hash",
            "pubkey",
            "clearing_price",
            "n_valid",
            "n_invalid",
            "invalid",
            "fills",
        ];
        let raw = run(&book.clear_request(), &ctx(CONTRACT));
        let positions: Vec<usize> = order
            .iter()
            .map(|key| raw.find(&format!("\"{key}\":")).unwrap())
            .collect();
        assert!(positions.is_sorted(), "{raw:.300}");
        // Oversubscribed: the price rose above the floor, and invalid bids got nothing.
        let price: u128 = answer["clearing_price"].as_str().unwrap().parse().unwrap();
        assert!(price > FLOOR_PRICE, "{price}");
        for (bid, fill) in book.bids.iter().zip(answer["fills"].as_array().unwrap()) {
            if bid.kind != Kind::Valid {
                assert_eq!(fill, &json!(["0", "0"]), "{bid:?}");
            }
        }
    }

    #[test]
    fn top_bids_change_only_their_price() {
        let low = BidBook::generate_with(200, 10u128.pow(4), 10);
        let high = BidBook::generate_with(200, 10u128.pow(30), 10);
        for (x, y) in low.bids.iter().zip(&high.bids) {
            assert_eq!(
                (&x.bidder, x.deposit, x.kind),
                (&y.bidder, y.deposit, y.kind)
            );
        }
        // Every top bid is above the clearing price either way, so the
        // answers are the same.
        assert_eq!(answer_without_hash(&low), answer_without_hash(&high));
        // `generate` is the one-top-bid case.
        let one = BidBook::generate(200);
        let same = BidBook::generate_with(200, WHALE_PRICE, 1);
        assert_eq!(answer_without_hash(&one), answer_without_hash(&same));
    }

    #[test]
    fn worst_case_books_are_the_longest_and_all_valid() {
        let keypair = SaleKeypair::derive(&TEST_MASTER, CONTRACT, WORST_SALE_ID);
        assert_eq!(WORST_SALE_ID.len(), 32);
        for (box_len, expected) in [
            (None, sealed_bid_len(32, 64)),
            (
                Some(LEGACY_MAX_CIPHERTEXT_BYTES),
                LEGACY_MAX_CIPHERTEXT_BYTES,
            ),
        ] {
            let book = BidBook::worst_case(20, box_len);
            for bid in &book.bids {
                assert_eq!(bid.bidder.len(), 64);
                assert_eq!(bid.deposit.to_string().len(), 39);
                assert_eq!(BASE64.decode(&bid.ciphertext).unwrap().len(), expected);
                assert!(open_bid(&bid.ciphertext, &keypair).is_some());
            }
            let answer: Value =
                serde_json::from_str(&run(&book.clear_request(), &ctx(CONTRACT))).unwrap();
            assert_eq!(answer["ok"], true, "{answer}");
            assert_eq!(answer["n_valid"], 20, "{answer}");
            assert_eq!(answer["invalid"], json!([]));
        }
        assert_eq!(sealed_bid_len(32, 64), 320);
    }
}
