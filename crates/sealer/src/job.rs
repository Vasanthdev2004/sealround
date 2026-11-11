//! The OutLayer job: one JSON request in, one JSON response out.
//!
//! Requests (`input_data`):
//!
//! ```text
//! {"v":1,"op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}
//! {"v":1,"op":"clear","contract":"fairground.testnet","sale_id":"fairt",
//!  "params":{"sale_supply":"..","floor_price":"..","max_price":null,"min_raise":"..","decimals":18},
//!  "bid_set_hash":"<hex64>","bids":[["alice.testnet","5000000","<base64 ciphertext>"], ..]}
//! ```
//!
//! Responses (returned as `Text`, so the bytes and the u128 strings arrive exactly):
//!
//! ```text
//! {"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"<hex64>"}
//! {"v":1,"ok":true,"op":"clear","sale_id":"fairt","bid_set_hash":"<hex64>","pubkey":"<hex64>",
//!  "clearing_price":"1600","n_valid":48,"n_invalid":1,"invalid":[7],
//!  "fills":[["<tokens>","<spent>"], ..]}
//! {"v":1,"ok":false,"op":"clear","sale_id":"fairt","error":"<code>"}
//! ```
//!
//! A `clear` answer names the key it decrypted with (`pubkey`, which the
//! contract compares with the key bids were sealed to) and the indices of the
//! invalid bids (`invalid`, ascending), which pay the invalid-bid penalty. It
//! never shows a bid's price or spend.
//!
//! On failure `op` and `sale_id` echo the request's values when they are
//! strings, else `null` (always `null` for `invalid_json` and
//! `duplicate_key`). Error codes: `invalid_json`, `duplicate_key`,
//! `unsupported_version`, `unknown_op`, `unexpected_field`, `invalid_contract`,
//! `predecessor_mismatch`, `invalid_sale_id`, `invalid_params`,
//! `invalid_bid_set_hash`, `invalid_bids`, `invalid_ciphertext`,
//! `bid_set_hash_mismatch`, and the clearing crate's `ClearingError::code()`
//! values.
//!
//! The price is found with `PriceSearch::FixedShape`: the same result as the
//! contract's `clear`, but the number of search steps and the bids each step
//! visits do not depend on the bids' prices, so the run's published
//! instruction count does not reveal the highest max price.

use core::fmt;
use std::collections::BTreeSet;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fairground_clearing::hash::{BidSetHasher, parse_hex};
use fairground_clearing::{
    Bid, ClearingError, PriceSearch, SaleParams, clear_with, validate_params,
};
use serde::Serialize;
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

use crate::bid::{open_bid_bytes, parse_u128};
use crate::keys::SaleKeypair;

/// Request and response format version.
pub const VERSION: u64 = 1;

/// Keys a `pubkey` request may have (all required).
const PUBKEY_FIELDS: [&str; 4] = ["v", "op", "contract", "sale_id"];
/// Keys a `clear` request may have (all required).
const CLEAR_FIELDS: [&str; 7] = [
    "v",
    "op",
    "contract",
    "sale_id",
    "params",
    "bid_set_hash",
    "bids",
];
/// Keys of `params` (all required; `max_price` may be `null`).
const PARAM_FIELDS: [&str; 5] = [
    "sale_supply",
    "floor_price",
    "max_price",
    "min_raise",
    "decimals",
];

/// How the `clear` op finds the clearing price. Fixed-shape: the same result
/// as the contract's fast search, with work that does not depend on the bids'
/// prices, because OutLayer publishes every run's instruction count.
const PRICE_SEARCH: PriceSearch = PriceSearch::FixedShape;

/// Sent if a response ever failed to serialize, which plain strings and
/// integers cannot do. It keeps `run` total: every call returns valid JSON.
const INTERNAL_FAILURE: &str = r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"internal"}"#;

/// What the job knows besides its input.
#[derive(Clone)]
pub struct Ctx {
    /// The contract that asked OutLayer for this run (`NEAR_PREDECESSOR_ID`).
    /// Requests naming any other contract are refused.
    pub predecessor: String,
    /// The master secret (`PROTECTED_FAIRGROUND_MASTER`, 32 bytes).
    pub master: [u8; 32],
}

impl fmt::Debug for Ctx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Ctx")
            .field("predecessor", &self.predecessor)
            .finish_non_exhaustive()
    }
}

/// Runs one job request and returns the response JSON. Never panics: any
/// problem with the input becomes an `"ok":false` response.
pub fn run(input: &str, ctx: &Ctx) -> String {
    let request = match serde_json::from_str::<Value>(input) {
        Ok(Value::Object(request)) => request,
        _ => return failure(None, None, JobError::InvalidJson),
    };
    // Which of two equal keys counts is up to the parser, so such a request
    // has no single `op` or `sale_id` to echo.
    if repeats_a_key(input) {
        return failure(None, None, JobError::DuplicateKey);
    }
    let echo = |key: &str| request.get(key).and_then(Value::as_str);
    match respond(&request, ctx) {
        Ok(response) => response,
        Err(error) => failure(echo("op"), echo("sale_id"), error),
    }
}

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobError {
    InvalidJson,
    DuplicateKey,
    UnsupportedVersion,
    UnknownOp,
    UnexpectedField,
    InvalidContract,
    PredecessorMismatch,
    InvalidSaleId,
    InvalidParams,
    InvalidBidSetHash,
    InvalidBids,
    InvalidCiphertext,
    BidSetHashMismatch,
    Clearing(ClearingError),
}

impl JobError {
    const fn code(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::DuplicateKey => "duplicate_key",
            Self::UnsupportedVersion => "unsupported_version",
            Self::UnknownOp => "unknown_op",
            Self::UnexpectedField => "unexpected_field",
            Self::InvalidContract => "invalid_contract",
            Self::PredecessorMismatch => "predecessor_mismatch",
            Self::InvalidSaleId => "invalid_sale_id",
            Self::InvalidParams => "invalid_params",
            Self::InvalidBidSetHash => "invalid_bid_set_hash",
            Self::InvalidBids => "invalid_bids",
            Self::InvalidCiphertext => "invalid_ciphertext",
            Self::BidSetHashMismatch => "bid_set_hash_mismatch",
            Self::Clearing(error) => error.code(),
        }
    }
}

#[derive(Serialize)]
struct PubkeyResponse<'a> {
    v: u64,
    ok: bool,
    op: &'static str,
    sale_id: &'a str,
    pubkey: String,
}

#[derive(Serialize)]
struct ClearResponse<'a> {
    v: u64,
    ok: bool,
    op: &'static str,
    sale_id: &'a str,
    bid_set_hash: String,
    /// The sale key the bids were opened with.
    pubkey: String,
    clearing_price: String,
    n_valid: usize,
    n_invalid: usize,
    /// Indices of the invalid bids, ascending.
    invalid: Vec<usize>,
    fills: Vec<[String; 2]>,
}

#[derive(Serialize)]
struct FailureResponse<'a> {
    v: u64,
    ok: bool,
    op: Option<&'a str>,
    sale_id: Option<&'a str>,
    error: &'static str,
}

fn failure(op: Option<&str>, sale_id: Option<&str>, error: JobError) -> String {
    to_json(&FailureResponse {
        v: VERSION,
        ok: false,
        op,
        sale_id,
        error: error.code(),
    })
}

fn to_json(response: &impl Serialize) -> String {
    serde_json::to_string(response).unwrap_or_else(|_| INTERNAL_FAILURE.to_owned())
}

fn respond(request: &Map<String, Value>, ctx: &Ctx) -> Result<String, JobError> {
    if request.get("v").and_then(Value::as_u64) != Some(VERSION) {
        return Err(JobError::UnsupportedVersion);
    }
    let op = request.get("op").and_then(Value::as_str);
    let allowed: &[&str] = match op {
        Some("pubkey") => &PUBKEY_FIELDS,
        Some("clear") => &CLEAR_FIELDS,
        _ => return Err(JobError::UnknownOp),
    };
    if request.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(JobError::UnexpectedField);
    }

    // The account-id check also guarantees the contract id has no 0x00 byte,
    // which the key derivation uses as a separator.
    let contract = request
        .get("contract")
        .and_then(Value::as_str)
        .filter(|contract| is_account_id(contract))
        .ok_or(JobError::InvalidContract)?;
    if contract != ctx.predecessor {
        return Err(JobError::PredecessorMismatch);
    }
    let sale_id = request
        .get("sale_id")
        .and_then(Value::as_str)
        .filter(|sale_id| is_sale_id(sale_id))
        .ok_or(JobError::InvalidSaleId)?;
    let keypair = SaleKeypair::derive(&ctx.master, contract, sale_id);

    if op == Some("pubkey") {
        return Ok(to_json(&PubkeyResponse {
            v: VERSION,
            ok: true,
            op: "pubkey",
            sale_id,
            pubkey: keypair.public_key_hex(),
        }));
    }
    clear_sale(request, sale_id, &keypair)
}

/// One bid as the contract recorded it.
struct BidRecord<'a> {
    bidder: &'a str,
    deposit: u128,
    payload: Vec<u8>,
}

fn clear_sale(
    request: &Map<String, Value>,
    sale_id: &str,
    keypair: &SaleKeypair,
) -> Result<String, JobError> {
    let params = parse_params(request.get("params"))?;
    let expected_hash = request
        .get("bid_set_hash")
        .and_then(Value::as_str)
        .and_then(parse_hex::<32>)
        .ok_or(JobError::InvalidBidSetHash)?;
    let records = request
        .get("bids")
        .and_then(Value::as_array)
        .ok_or(JobError::InvalidBids)?
        .iter()
        .map(parse_bid_record)
        .collect::<Result<Vec<_>, _>>()?;

    // Decrypt nothing unless the bids hash to `bid_set_hash`. That hash comes
    // in this same request, so the check binds the bids to the requester's
    // own hash, not to the contract's state: the job cannot read the chain.
    // The set is the one the contract froze only because the request must
    // come from the sale contract (`ctx.predecessor`), whose code is trusted
    // to send its frozen bids with the hash it recorded. That holds only
    // while nobody else can act as the contract account: its full-access key
    // must be deleted (enclave/README.md, section 5).
    let mut hasher = BidSetHasher::new(sale_id);
    for record in &records {
        hasher
            .push(record.bidder, record.deposit, &record.payload)
            .map_err(|_| JobError::InvalidBids)?;
    }
    if hasher.state() != expected_hash {
        return Err(JobError::BidSetHashMismatch);
    }

    let bids: Vec<Bid> = records
        .iter()
        .map(|record| decrypt(record, sale_id, keypair))
        .collect();
    let result = clear_with(&params, &bids, PRICE_SEARCH).map_err(JobError::Clearing)?;

    // A failed sale already has all-zero fills; the contract decides from the totals.
    Ok(to_json(&ClearResponse {
        v: VERSION,
        ok: true,
        op: "clear",
        sale_id,
        bid_set_hash: hasher.hex(),
        pubkey: keypair.public_key_hex(),
        clearing_price: result.clearing_price.to_string(),
        n_valid: result.n_valid,
        n_invalid: result.n_invalid,
        invalid: result
            .fills
            .iter()
            .filter(|fill| !fill.valid)
            .map(|fill| fill.index)
            .collect(),
        fills: result
            .fills
            .iter()
            .map(|fill| [fill.tokens.to_string(), fill.spent.to_string()])
            .collect(),
    }))
}

/// `{"sale_supply","floor_price","max_price","min_raise","decimals"}`, amounts as
/// decimal strings, `max_price` a string or `null`, `decimals` an integer.
fn parse_params(value: Option<&Value>) -> Result<SaleParams, JobError> {
    let fields = value
        .and_then(Value::as_object)
        .filter(|fields| {
            fields.len() == PARAM_FIELDS.len()
                && PARAM_FIELDS.iter().all(|key| fields.contains_key(*key))
        })
        .ok_or(JobError::InvalidParams)?;
    let amount = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .and_then(parse_u128)
            .ok_or(JobError::InvalidParams)
    };
    let max_price = match fields.get("max_price") {
        Some(Value::Null) => None,
        _ => Some(amount("max_price")?),
    };
    let decimals = fields
        .get("decimals")
        .and_then(Value::as_u64)
        .and_then(|decimals| u8::try_from(decimals).ok())
        .ok_or(JobError::InvalidParams)?;
    let params = SaleParams {
        sale_supply: amount("sale_supply")?,
        floor_price: amount("floor_price")?,
        min_raise: amount("min_raise")?,
        decimals,
        max_price,
    };
    validate_params(&params).map_err(JobError::Clearing)?;
    Ok(params)
}

/// `[bidder, deposit, ciphertext_base64]`, all strings.
fn parse_bid_record(value: &Value) -> Result<BidRecord<'_>, JobError> {
    let Some(
        [
            Value::String(bidder),
            Value::String(deposit),
            Value::String(ciphertext),
        ],
    ) = value.as_array().map(Vec::as_slice)
    else {
        return Err(JobError::InvalidBids);
    };
    Ok(BidRecord {
        bidder,
        deposit: parse_u128(deposit).ok_or(JobError::InvalidBids)?,
        payload: BASE64
            .decode(ciphertext)
            .map_err(|_| JobError::InvalidCiphertext)?,
    })
}

/// The clearing input for one bid. A bid that does not open is a decrypt
/// failure; one whose plaintext names another bidder or sale (a copied
/// ciphertext) is a mismatch. Both end up invalid with a zero fill.
fn decrypt(record: &BidRecord<'_>, sale_id: &str, keypair: &SaleKeypair) -> Bid {
    let plaintext = open_bid_bytes(&record.payload, keypair);
    Bid {
        bidder: record.bidder.to_owned(),
        deposit: record.deposit,
        max_price: plaintext.as_ref().map(|bid| bid.max_price),
        max_spend: plaintext.as_ref().map(|bid| bid.max_spend),
        mismatch: plaintext
            .as_ref()
            .is_some_and(|bid| bid.bidder != record.bidder || bid.sale_id != sale_id),
    }
}

/// Whether any object in `input`, at any depth, has the same key twice.
/// Keys are compared after unescaping, as every JSON parser does: `"op"` and
/// `"\u006fp"` are the same key. The same check as the enclave job's own
/// (`enclave/job/src/main.rs`, `scan`), which refuses such a run before
/// `run` sees it.
///
/// `run` calls it on input that already parsed as one JSON object, with the
/// same parser and limits, so it cannot fail; if it did, that would count as
/// a repeat.
fn repeats_a_key(input: &str) -> bool {
    let mut json = serde_json::Deserializer::from_str(input);
    (&mut json)
        .deserialize_any(KeyCheck)
        .and_then(|repeated| json.end().map(|()| repeated))
        .unwrap_or(true)
}

/// One JSON value in [`repeats_a_key`]'s pass: `true` if some object in it
/// repeats a key.
#[derive(Clone, Copy)]
struct KeyCheck;

impl<'de> DeserializeSeed<'de> for KeyCheck {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<bool, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for KeyCheck {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_unit<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<bool, A::Error> {
        let mut repeated = false;
        while let Some(item) = items.next_element_seed(self)? {
            repeated |= item;
        }
        Ok(repeated)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<bool, A::Error> {
        let mut repeated = false;
        let mut keys = BTreeSet::new();
        while let Some(key) = entries.next_key::<String>()? {
            repeated |= entries.next_value_seed(self)? | !keys.insert(key);
        }
        Ok(repeated)
    }
}

/// `^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$`, the contract's sale id rule.
fn is_sale_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes.first().is_some_and(is_alphanumeric)
        && bytes.last().is_some_and(is_alphanumeric)
        && bytes
            .iter()
            .all(|b| is_alphanumeric(b) || *b == b'_' || *b == b'-')
}

/// A valid NEAR account id: 2 to 64 bytes, dot-separated parts of lowercase
/// letters and digits, joined inside a part by single `-` or `_`.
fn is_account_id(id: &str) -> bool {
    (2..=64).contains(&id.len())
        && id.split('.').all(|part| {
            let bytes = part.as_bytes();
            bytes.first().is_some_and(is_alphanumeric)
                && bytes.last().is_some_and(is_alphanumeric)
                && bytes
                    .iter()
                    .all(|b| is_alphanumeric(b) || *b == b'_' || *b == b'-')
                && !bytes
                    .windows(2)
                    .any(|pair| !is_alphanumeric(&pair[0]) && !is_alphanumeric(&pair[1]))
        })
}

fn is_alphanumeric(b: &u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sale_id_rule() {
        for good in ["a", "0", "fairt", "a-b_c", "a1", &"a".repeat(32)] {
            assert!(is_sale_id(good), "{good}");
        }
        for bad in [
            "",
            "-a",
            "a-",
            "_a",
            "a_",
            "A",
            "a.b",
            "a b",
            "a\0b",
            "é",
            &"a".repeat(33),
        ] {
            assert!(!is_sale_id(bad), "{bad}");
        }
    }

    #[test]
    fn account_id_rule() {
        for good in [
            "ab",
            "fairground.testnet",
            "a-b.c_d.near",
            "0x1234",
            &"a".repeat(64),
            "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
        ] {
            assert!(is_account_id(good), "{good}");
        }
        for bad in [
            "",
            "a",
            "A.near",
            ".near",
            "a..near",
            "a.near.",
            "a--b.near",
            "a-_b.near",
            "-a.near",
            "a-.near",
            "a\0b.near",
            "a b.near",
            &"a".repeat(65),
        ] {
            assert!(!is_account_id(bad), "{bad}");
        }
    }

    /// The result is the same with either search, so only this pins that the
    /// job uses the one whose work does not depend on prices.
    #[test]
    fn the_job_uses_the_fixed_shape_price_search() {
        assert_eq!(PRICE_SEARCH, PriceSearch::FixedShape);
    }

    #[test]
    fn repeated_keys_are_found_at_any_depth() {
        for repeated in [
            r#"{"a":1,"a":1}"#,
            r#"{"a":1,"b":2,"a":3}"#,
            r#"{"x":{"a":1,"a":2}}"#,
            r#"{"x":[1,{"a":1,"a":2}]}"#,
            r#"{"x":[[[{"y":{"b":null,"b":null}}]]]}"#,
            r#"{"op":"clear","\u006fp":"pubkey"}"#,
            r#"{"a\"b":1,"a\u0022b":2}"#,
            r#"{"x":{},"y":{"x":{"k":1,"k":1}}}"#,
        ] {
            // Valid JSON, so the answer is not the parse-failure fallback.
            assert!(
                serde_json::from_str::<Value>(repeated).is_ok(),
                "{repeated}"
            );
            assert!(repeats_a_key(repeated), "{repeated}");
        }
        for unique in [
            r#"{}"#,
            r#"{"a":1,"A":1}"#,
            r#"{"a":{"a":{"a":1}}}"#,
            r#"{"x":[{"a":1},{"a":2}],"y":{"a":3}}"#,
            r#"{"a":"a","b":"a"}"#,
            r#"{"op":"clear","o p":"clear","op ":1}"#,
            r#"{"n":[1,-1,1.5,1e3,true,false,null,"s"]}"#,
        ] {
            assert!(!repeats_a_key(unique), "{unique}");
        }
    }

    #[test]
    fn ctx_debug_hides_the_master() {
        let ctx = Ctx {
            predecessor: "fairground.testnet".into(),
            master: [0x5a; 32],
        };
        let text = format!("{ctx:?}");
        assert!(text.contains("fairground.testnet"));
        assert!(!text.contains("90"), "{text}");
    }
}
