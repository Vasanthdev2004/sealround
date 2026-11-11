//! The OutLayer side: job inputs, the `request_execution` call, and reading
//! what comes back.
//!
//! Requests use `response_format: "Text"`, so the sealer's stdout reaches our
//! callback byte for byte, wrapped in one JSON string (OutLayer's
//! `output_return_bytes`). A failed run or a timeout arrives as the bytes
//! `null`. A run that exits 0 without printing anything arrives as the empty
//! JSON string `""` (only an empty *Json* output becomes `null`); this
//! contract treats it, and an output of only whitespace, like a failed run.
//! The WASI job's own refusals (`fairground-sealer: refused: <code>` on
//! stderr, exit status 1) are failed runs, so they arrive as `null` too. An
//! answer that parses with `"ok": false` is also treated as "not now",
//! whatever its `op`, `sale_id` or `v`.
//! `Err` means `request_execution` itself was refused (its deposit then comes
//! back to this contract) or OutLayer's callback failed. OutLayer's
//! attestation `output_hash` is sha256 of exactly the bytes we receive, so
//! that is what `result_sha256` stores.

use core::fmt::Write as _;

use near_sdk::base64::Engine as _;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{AccountId, GasWeight, NearToken, Promise, env, serde_json};

use crate::config::Config;
use crate::costs::{
    MAX_CIPHERTEXT_BYTES, SEALER_MAX_EXECUTION_SECONDS, SEALER_MAX_INSTRUCTIONS,
    outlayer_request_gas,
};
use crate::sale::SaleTerms;

/// Largest promise result the protocol can return (`max_length_returned_data`).
const MAX_RESULT_BYTES: usize = 4 << 20;
/// Input format version.
const INPUT_VERSION: u32 = 1;
/// Most bytes one bid adds to the clearing input: the base64 of the largest
/// ciphertext, a 64-byte bidder, a 39-digit deposit and the punctuation.
const MAX_INPUT_BYTES_PER_BID: usize = MAX_CIPHERTEXT_BYTES.div_ceil(3) * 4 + 64 + 39 + 10;

/// `{"v":1,"op":"pubkey","contract":..,"sale_id":..}`.
pub fn pubkey_input(contract: &AccountId, sale_id: &str) -> String {
    // Account ids and sale ids contain only [a-z0-9._-]: nothing to escape.
    format!(
        r#"{{"v":{INPUT_VERSION},"op":"pubkey","contract":"{contract}","sale_id":"{sale_id}"}}"#
    )
}

/// The clearing input (DESIGN "Sealer", input `op: clear`). `bids` yields
/// `(bidder, deposit, ciphertext)` in bid order.
pub fn clear_input<'a>(
    contract: &AccountId,
    sale_id: &str,
    terms: &SaleTerms,
    bid_set_hash: &str,
    bid_count: u32,
    bids: impl Iterator<Item = (&'a AccountId, u128, &'a [u8])>,
) -> String {
    // Room for the largest bids, so the buffer is never copied to grow
    // (copying is what costs gas at this size).
    let mut out = String::with_capacity(256 + bid_count as usize * MAX_INPUT_BYTES_PER_BID);
    let max_price = terms
        .max_price
        .map_or_else(|| "null".to_owned(), |price| format!("\"{price}\""));
    // Writing to a String cannot fail.
    let _ = write!(
        out,
        r#"{{"v":{INPUT_VERSION},"op":"clear","contract":"{contract}","sale_id":"{sale_id}","params":{{"sale_supply":"{}","floor_price":"{}","max_price":{max_price},"min_raise":"{}","decimals":{}}},"bid_set_hash":"{bid_set_hash}","bids":["#,
        terms.sale_supply, terms.floor_price, terms.min_raise, terms.decimals,
    );
    for (i, (bidder, deposit, ciphertext)) in bids.enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, r#"["{bidder}","{deposit}",""#);
        BASE64.encode_string(ciphertext, &mut out);
        out.push_str("\"]");
    }
    out.push_str("]}");
    out
}

/// OutLayer `request_execution` arguments: `{"source", "resource_limits",
/// "input_data", "secrets_ref", "response_format": "Text", "payer_account_id",
/// "params": null}`.
///
/// Written by hand rather than with serde_json, whose string escaper costs
/// about 50 MGas per byte on chain: 20 TGas of `close_sale` when the largest
/// input was 390 KB (measured). [`push_json_string`] copies the input in runs.
pub fn request_args(config: &Config, input: &str, payer: &AccountId) -> Vec<u8> {
    // Small values; serialising them cannot fail.
    let source = serde_json::to_string(&config.sealer_source).unwrap_or_default();
    let secrets = serde_json::to_string(&config.sealer_secrets).unwrap_or_default();
    // The input's quotes each take one more byte; a bid has six.
    let mut out = String::with_capacity(input.len() + input.len() / 32 + source.len() + 512);
    let _ = write!(
        out,
        r#"{{"source":{source},"resource_limits":{{"max_instructions":{SEALER_MAX_INSTRUCTIONS},"max_execution_seconds":{SEALER_MAX_EXECUTION_SECONDS}}},"input_data":"#
    );
    push_json_string(&mut out, input);
    // Account ids contain only [a-z0-9._-]: nothing to escape.
    let _ = write!(
        out,
        r#","secrets_ref":{secrets},"response_format":"Text","payer_account_id":"{payer}","params":null}}"#
    );
    out.into_bytes()
}

/// Appends `text` as a JSON string literal. Escapes `"`, `\` and control
/// characters (as `\u00XX`); everything else, including non-ASCII UTF-8, is
/// copied unchanged in runs.
pub fn push_json_string(out: &mut String, text: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    let mut run_start = 0;
    for (i, byte) in text.bytes().enumerate() {
        if byte != b'"' && byte != b'\\' && byte >= 0x20 {
            continue;
        }
        out.push_str(&text[run_start..i]);
        match byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            _ => {
                out.push_str("\\u00");
                out.push(char::from(HEX[usize::from(byte >> 4)]));
                out.push(char::from(HEX[usize::from(byte & 0xf)]));
            }
        }
        run_start = i + 1;
    }
    out.push_str(&text[run_start..]);
    out.push('"');
}

/// `request_execution` with `deposit`; OutLayer refunds what it does not
/// charge to `payer`. Gets the call's unused gas too (weight 1).
pub fn request_execution(
    config: &Config,
    input: &str,
    payer: &AccountId,
    deposit: NearToken,
) -> Promise {
    send_request(
        config,
        request_args(config, input, payer),
        input.len(),
        deposit,
    )
}

/// The `request_execution` call for `args` built by [`request_args`] from an
/// input of `input_len` bytes.
pub fn send_request(
    config: &Config,
    args: Vec<u8>,
    input_len: usize,
    deposit: NearToken,
) -> Promise {
    Promise::new(config.outlayer.clone()).function_call_weight(
        "request_execution",
        args,
        deposit,
        outlayer_request_gas(input_len),
        GasWeight(1),
    )
}

/// Longest sealer error code kept in a log or event.
const MAX_ERROR_LOG_LEN: usize = 160;

/// What the sealer printed (both ops). Fields an op does not use are absent.
///
/// `op` and `sale_id` may be `null` or absent: `fairground_sealer::run`
/// answers `{"v":1,"ok":false,"op":null,"sale_id":null,"error":".."}` when
/// the request had no usable `op` or `sale_id` (or repeated a key). Every
/// `ok: false` answer is a refusal to clear or to give a key, so the callbacks
/// treat it as "not now" (the sale stays closed, the key request fails for
/// `retry_setup`) before checking anything else.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SealerReply {
    pub v: u32,
    pub ok: bool,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub sale_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub pubkey: Option<String>,
    #[serde(default)]
    pub bid_set_hash: Option<String>,
    #[serde(default)]
    pub clearing_price: Option<U128>,
    #[serde(default)]
    pub n_valid: Option<u32>,
    #[serde(default)]
    pub n_invalid: Option<u32>,
    /// Indices of the invalid bids, ascending (`op: clear`).
    #[serde(default)]
    pub invalid: Option<Vec<u32>>,
    #[serde(default)]
    pub fills: Option<Vec<(U128, U128)>>,
}

impl SealerReply {
    /// `sealer_error: <code>` (the code cut to 160 bytes), or `sealer_error`
    /// when the answer gave none. For `ok: false` answers.
    pub fn error_label(&self) -> String {
        match self.error.as_deref() {
            Some(code) => format!("sealer_error: {}", truncate(code, MAX_ERROR_LOG_LEN)),
            None => "sealer_error".to_owned(),
        }
    }
}

/// The promise result of a `request_execution`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::large_enum_variant,
    reason = "built once per callback and never stored"
)]
pub enum Outcome {
    /// The callback was not called by our own promise (no result to read).
    NoPromise,
    /// `Err`: refused at the door (deposit returned to us) or OutLayer failed.
    Refused,
    /// `null` (the run failed or timed out) or `""` (it printed nothing).
    NoOutput,
    /// Output bytes, their sha256, and the parsed reply or why it is malformed.
    Output {
        sha256: [u8; 32],
        reply: Result<SealerReply, &'static str>,
    },
}

/// Reads promise result 0 without ever panicking.
pub fn read_outcome() -> Outcome {
    if env::promise_results_count() != 1 {
        return Outcome::NoPromise;
    }
    let bytes = match env::promise_result_checked(0, MAX_RESULT_BYTES) {
        Err(_) => return Outcome::Refused,
        Ok(bytes) if bytes.as_slice() == b"null" => return Outcome::NoOutput,
        Ok(bytes) => bytes,
    };
    // Unwrap the Text-format JSON string.
    let text = serde_json::from_slice::<String>(&bytes);
    // `""` (or only whitespace): the job printed nothing, which is not an
    // answer either. Like `null`, the sale stays retryable.
    if text.as_ref().is_ok_and(|text| text.trim().is_empty()) {
        return Outcome::NoOutput;
    }
    Outcome::Output {
        sha256: env::sha256_array(&bytes),
        reply: text
            .map_err(|_| "output is not a JSON string (Text format)")
            .and_then(|text| parse_sealer_json(&text)),
    }
}

/// Parses the sealer's JSON (the text inside the Text-format string). An
/// `ok: false` answer is returned whatever its version: it is a refusal
/// either way, and the callers retry it. An `ok: true` answer must be `v: 1`.
fn parse_sealer_json(text: &str) -> Result<SealerReply, &'static str> {
    let reply: SealerReply =
        serde_json::from_str(text).map_err(|_| "output is not the sealer's JSON")?;
    if reply.ok && reply.v != 1 {
        return Err("unsupported output version");
    }
    Ok(reply)
}

/// At most `max` bytes, cut at a character boundary.
fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use near_sdk::serde_json::{self, Value, json};

    use super::{parse_sealer_json, push_json_string, request_args};
    use crate::config::{Config, SealerSource, SecretsRef};

    #[test]
    fn refusals_parse_whatever_their_op_sale_id_or_version() {
        for text in [
            r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"missing_master"}"#,
            r#"{"v":1,"ok":false,"error":"missing_master"}"#,
            r#"{"v":1,"ok":false,"op":"clear","sale_id":"fairt","error":"missing_master"}"#,
            r#"{"v":7,"ok":false,"op":null,"sale_id":null,"error":"missing_master"}"#,
        ] {
            let reply = parse_sealer_json(text).unwrap();
            assert!(!reply.ok, "{text}");
            assert_eq!(reply.error_label(), "sealer_error: missing_master");
        }
        let reply = parse_sealer_json(r#"{"v":1,"ok":false,"op":null,"sale_id":null}"#).unwrap();
        assert_eq!((reply.op, reply.sale_id), (None, None));
        assert_eq!(
            parse_sealer_json(r#"{"v":1,"ok":false,"error":null}"#)
                .unwrap()
                .error_label(),
            "sealer_error"
        );
        // Cut to 160 bytes, at a character boundary.
        let long = format!(r#"{{"v":1,"ok":false,"error":"{}"}}"#, "é".repeat(100));
        let label = parse_sealer_json(&long).unwrap().error_label();
        assert_eq!(label, format!("sealer_error: {}", "é".repeat(80)));
    }

    #[test]
    fn answers_must_be_version_1_and_say_ok() {
        assert_eq!(
            parse_sealer_json(r#"{"v":2,"ok":true,"op":"clear","sale_id":"fairt"}"#),
            Err("unsupported output version")
        );
        for text in [
            r#"{"ok":false,"error":"x"}"#,
            r#"{"v":1,"error":"x"}"#,
            r#"{"v":1,"ok":false,"op":7}"#,
            "null",
        ] {
            assert_eq!(
                parse_sealer_json(text),
                Err("output is not the sealer's JSON"),
                "{text}"
            );
        }
    }

    #[test]
    fn json_strings_round_trip() {
        for text in [
            "",
            "plain",
            r#"{"v":1,"bids":[["a.near","1","QUJD+/=="]]}"#,
            "back\\slash \"quoted\" \u{0}\u{1}\n\t\u{1f} end",
            "ünïcødé ✓ \u{7f}",
        ] {
            let mut out = String::new();
            push_json_string(&mut out, text);
            assert_eq!(serde_json::from_str::<String>(&out).unwrap(), text, "{out}");
        }
    }

    #[test]
    fn request_args_match_serde() {
        let config = Config {
            outlayer: "outlayer.testnet".parse().unwrap(),
            sealer_source: SealerSource::WasmUrl {
                url: "https://example.com/s.wasm".into(),
                hash: "ab".repeat(32),
                build_target: Some("wasm32-wasip1".into()),
            },
            sealer_code_hash: "ab".repeat(32),
            sealer_secrets: Some(SecretsRef {
                profile: "default".into(),
                account_id: "owner.testnet".parse().unwrap(),
            }),
            allowed_quote_tokens: vec!["usdc.testnet".parse().unwrap()],
        };
        let input = r#"{"v":1,"op":"clear","bids":[["a.testnet","5","AAAA"]]}"#;
        let payer = "closer.testnet".parse().unwrap();
        let args: Value = serde_json::from_slice(&request_args(&config, input, &payer)).unwrap();
        assert_eq!(
            args,
            json!({
                "source": {"WasmUrl": {"url": "https://example.com/s.wasm", "hash": "ab".repeat(32), "build_target": "wasm32-wasip1"}},
                "resource_limits": {"max_instructions": 50_000_000_000u64, "max_execution_seconds": 60},
                "input_data": input,
                "secrets_ref": {"profile": "default", "account_id": "owner.testnet"},
                "response_format": "Text",
                "payer_account_id": "closer.testnet",
                "params": null,
            })
        );
        let no_secrets = Config {
            sealer_secrets: None,
            ..config
        };
        let args: Value =
            serde_json::from_slice(&request_args(&no_secrets, input, &payer)).unwrap();
        assert_eq!(args["secrets_ref"], Value::Null);
    }
}
