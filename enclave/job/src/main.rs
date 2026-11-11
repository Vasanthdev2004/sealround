//! `fairground-sealer`: Fairground's OutLayer job.
//!
//! The logic is the library function [`fairground_sealer::run`]. This program
//! connects it to what OutLayer gives a WASI P1 module (see
//! `contracts/DESIGN.md`, "Sealer" and "OutLayer call"):
//!
//! - stdin holds the request's `input_data`;
//! - the environment holds the worker's facts about the run and the values of
//!   the secret row the request named;
//! - stdout is the result. It reaches the contract as `Text`, byte for byte;
//! - a non-zero exit, a trap or a panic fails the run. The worker then
//!   publishes stderr as the run's `error_message` (in OutLayer's
//!   `execution_completed` event) and the contract's callback gets `null`.
//!
//! A run ends in one of two ways:
//!
//! - **An answer**: whatever `run` returns, its own `"ok":false` answers
//!   included, on stdout with exit status 0.
//! - **A refusal made here**, before `run` sees the request: nothing on
//!   stdout, exit status 1, and one fixed line on stderr:
//!
//!   ```text
//!   fairground-sealer: refused: <code>
//!   ```
//!
//! Why these fail the run instead of answering `"ok":false`: they are about
//! the run (no secret row, an HTTPS call, a request the contract never sends),
//! and most come before the request is understood, so an answer could not
//! name its `op` or `sale_id`. Earlier versions of the sale contract read an
//! answer without them as malformed and failed the sale for good; the current
//! one retries any `"ok":false` answer. A failed run is what every version
//! treats as "not now": a key request can be retried with `retry_setup`, and
//! a sale stays `closed` until `close_sale` is called again. The code still
//! reaches the chain, in OutLayer's event.
//!
//! The codes, in the order they are checked:
//!
//! | code | why |
//! | --- | --- |
//! | `not_near_execution` | `OUTLAYER_EXECUTION_TYPE` is not `NEAR`: not an on-chain request |
//! | `missing_predecessor` | `NEAR_PREDECESSOR_ID` is unset, empty or not Unicode |
//! | `missing_sender` | `NEAR_SENDER_ID` is unset, empty or not Unicode |
//! | `input_unreadable` | stdin could not be read |
//! | `input_too_large` | stdin holds more than 4 MiB |
//! | `invalid_json` | stdin is not one JSON object in UTF-8 |
//! | `duplicate_key` | an object somewhere in the request has the same key twice |
//! | `signer_is_contract` | the calling contract signed the transaction itself, and the request is not `pubkey` |
//! | `missing_master` | `PROTECTED_FAIRGROUND_MASTER` is unset: no secret row, or the row lacks it |
//! | `invalid_master` | `PROTECTED_FAIRGROUND_MASTER` is not 64 hex digits |

#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use fairground_sealer::{Ctx, run};
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use zeroize::{Zeroize, Zeroizing};

/// Set by the worker: `NEAR` for a request made on chain, `HTTPS` for one made
/// through OutLayer's HTTPS API. It is a system variable, so no secret can
/// take this name.
const EXECUTION_TYPE_VAR: &str = "OUTLAYER_EXECUTION_TYPE";
/// Set by the worker in a `NEAR` run: the account that called
/// `request_execution`. For Fairground that is the sale contract. The worker
/// sets it to an empty string in an HTTPS run.
const PREDECESSOR_VAR: &str = "NEAR_PREDECESSOR_ID";
/// Set by the worker in a `NEAR` run: the account the run acts for. That is
/// the transaction's signer, or, for a meta-transaction OutLayer recognises
/// (a delegate action sent to OutLayer itself), the account that signed the
/// delegate action. For Fairground it is a sale's creator (`create_sale`), a
/// retrier (`retry_setup`) or a closer (`close_sale`). A system variable too.
const SENDER_VAR: &str = "NEAR_SENDER_ID";
/// The master secret as 64 hex digits, generated inside OutLayer's keystore
/// TEE (`outlayer secrets set --generate PROTECTED_FAIRGROUND_MASTER:hex32`).
const MASTER_VAR: &str = "PROTECTED_FAIRGROUND_MASTER";

/// The largest input accepted, in bytes. `input_data` is an argument of the
/// contract's `request_execution` call and NEAR caps a call's arguments at
/// 4 MiB, so nothing larger can come from the chain. A 1000-bid clear is about
/// 0.3 MiB.
const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;

/// The one request the contract's own account may sign: it reveals nothing.
const PUBKEY_OP: &str = "pubkey";

fn main() -> ExitCode {
    // A panic ends the run, and the worker publishes stderr. The default hook
    // prints the panic message and a source location. This hook prints one
    // fixed sentence, so a bug cannot leak anything through stderr.
    std::panic::set_hook(Box::new(|_| report("internal error")));

    let answer = match respond(io::stdin().lock(), |name| std::env::var_os(name)) {
        Ok(answer) => answer,
        Err(refusal) => {
            report(&format!("refused: {}", refusal.code()));
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = io::stdout().lock();
    if stdout
        .write_all(answer.as_bytes())
        .and_then(|()| stdout.flush())
        .is_err()
    {
        // The answer cannot reach the contract. Failing the run at least makes
        // the worker report it, and the contract retries.
        report("cannot write the answer");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// One line on stderr, which the worker publishes as the error of a failed
/// run. Only fixed words reach it, never the input or the environment.
fn report(what: &str) {
    let _ = writeln!(io::stderr().lock(), "fairground-sealer: {what}");
}

/// The whole job: `run`'s answer for this input and environment, or why the
/// run is refused before `run` sees it.
fn respond(stdin: impl Read, env: impl Fn(&str) -> Option<OsString>) -> Result<String, Refusal> {
    // Only a request made on chain has a predecessor the sale contract stands
    // behind. An HTTPS run would also fail the predecessor check in `run`,
    // because the worker leaves the predecessor empty there; this check says
    // so directly, and the master is never read in such a run.
    if env(EXECUTION_TYPE_VAR).as_deref() != Some(OsStr::new("NEAR")) {
        return Err(Refusal::NotNearExecution);
    }
    let predecessor = account(&env, PREDECESSOR_VAR).ok_or(Refusal::MissingPredecessor)?;
    let sender = account(&env, SENDER_VAR).ok_or(Refusal::MissingSender)?;
    let input = read_input(stdin)?;
    let op = scan(&input)?;

    // The job believes the request it is given. The `bid_set_hash` it checks
    // arrives in the same request, so it binds the bids to what the requester
    // claims, not to the contract's state. Whoever can make the contract's
    // account call OutLayer could therefore "clear" made-up sales around one
    // real ciphertext and read its prices back from the fills. The contract's
    // code never does that, and its transactions are signed by the people
    // using it (creators, closers), never by the contract account. A request
    // that account signed itself comes from whoever holds its key, so it is
    // refused unless it is a `pubkey` request (the deploy smoke test makes
    // one, and a public key reveals nothing). Deleting that key remains the
    // real fix (README, section 5): this stops the direct call, not new code
    // deployed to the account, nor a meta-transaction OutLayer fails to
    // recognise.
    if sender == predecessor && op.as_deref() != Some(PUBKEY_OP) {
        return Err(Refusal::SignerIsContract);
    }

    // The master is read last, so it is in memory only for the run itself.
    let master = read_master(&env)?;
    let mut ctx = Ctx {
        predecessor,
        master: *master,
    };
    let answer = run(&input, &ctx);
    ctx.master.zeroize();
    Ok(answer)
}

/// An account id from the environment: set, Unicode and not empty. `run`
/// checks the predecessor's syntax against the request.
fn account(env: &impl Fn(&str) -> Option<OsString>, name: &str) -> Option<String> {
    env(name)
        .and_then(|id| id.into_string().ok())
        .filter(|id| !id.is_empty())
}

/// stdin up to EOF. Refuses more than [`MAX_INPUT_BYTES`], and anything that
/// is not UTF-8: JSON text is UTF-8 (RFC 8259), so such input is not a request.
fn read_input(stdin: impl Read) -> Result<String, Refusal> {
    let mut bytes = Vec::new();
    stdin
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Refusal::InputUnreadable)?;
    if u64::try_from(bytes.len()).map_or(true, |len| len > MAX_INPUT_BYTES) {
        return Err(Refusal::InputTooLarge);
    }
    String::from_utf8(bytes).map_err(|_| Refusal::InvalidJson)
}

/// One pass over the request before `run` parses it. It must be one JSON
/// object in which no object repeats a key. Returns the request's `op` when it
/// is a string.
///
/// Repeated keys: serde_json lets the last of two equal keys win, while other
/// parsers keep the first or refuse. A request read differently by the job
/// and by someone checking the public `input_data` (an auditor, the app's
/// Verified panel) is refused instead. Keys are compared after unescaping, as
/// every parser does: `op` spelt with a `\u` escape is still `op`. `run`
/// refuses such a request too, by answering `duplicate_key` with `op` and
/// `sale_id` null. It never gets to: refused here first, with the same code,
/// the run fails like every other refusal in the table above.
///
/// The same parser with the same limits as `run`'s (nesting depth 128), so
/// anything that passes here is a well-formed object for `run` too.
fn scan(input: &str) -> Result<Option<String>, Refusal> {
    let mut json = serde_json::Deserializer::from_str(input);
    let seen = (&mut json)
        .deserialize_map(Node {
            top: true,
            op: false,
        })
        .and_then(|seen| json.end().map(|()| seen))
        .map_err(|_| Refusal::InvalidJson)?;
    if seen.repeated_key {
        return Err(Refusal::DuplicateKey);
    }
    Ok(seen.op)
}

/// One JSON value in [`scan`]'s pass.
#[derive(Clone, Copy)]
struct Node {
    /// The value is the request itself: remember its `op`.
    top: bool,
    /// The value is the request's `op`: remember it if it is a string.
    op: bool,
}

/// What [`scan`] found in one value.
#[derive(Default)]
struct Seen {
    /// Some object in the value has a key twice.
    repeated_key: bool,
    /// For the request, its `op`; for the `op` value, the string itself.
    op: Option<String>,
}

impl Node {
    const INNER: Self = Self {
        top: false,
        op: false,
    };
}

impl<'de> DeserializeSeed<'de> for Node {
    type Value = Seen;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Seen, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Node {
    type Value = Seen;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.top {
            "a JSON object"
        } else {
            "a JSON value"
        })
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Seen, E> {
        Ok(Seen::default())
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Seen, E> {
        Ok(Seen::default())
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Seen, E> {
        Ok(Seen::default())
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Seen, E> {
        Ok(Seen::default())
    }

    fn visit_unit<E: de::Error>(self) -> Result<Seen, E> {
        Ok(Seen::default())
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Seen, E> {
        Ok(Seen {
            repeated_key: false,
            op: self.op.then(|| text.to_owned()),
        })
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Seen, A::Error> {
        let mut seen = Seen::default();
        while let Some(item) = items.next_element_seed(Self::INNER)? {
            seen.repeated_key |= item.repeated_key;
        }
        Ok(seen)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<Seen, A::Error> {
        let mut seen = Seen::default();
        let mut keys = BTreeSet::new();
        while let Some(key) = entries.next_key::<String>()? {
            let is_op = self.top && key == "op";
            let value = entries.next_value_seed(Node {
                top: false,
                op: is_op,
            })?;
            seen.repeated_key |= value.repeated_key | !keys.insert(key);
            if is_op {
                seen.op = value.op;
            }
        }
        Ok(seen)
    }
}

/// The master secret: exactly 64 hex digits, either case.
///
/// The copies this program holds (the hex text, the bytes, `Ctx::master`) are
/// wiped after use. Wiping is best effort: temporaries on the stack inside the
/// key derivation are not, and WASI copies the whole environment into the
/// module's memory at start-up. Those copies go away when the worker discards
/// the instance at the end of the run.
fn read_master(env: &impl Fn(&str) -> Option<OsString>) -> Result<Zeroizing<[u8; 32]>, Refusal> {
    let hex = Zeroizing::new(
        env(MASTER_VAR)
            .ok_or(Refusal::MissingMaster)?
            .into_encoded_bytes(),
    );
    decode_master(&hex).ok_or(Refusal::InvalidMaster)
}

/// 64 hex digits to 32 bytes, with the same instructions for every valid
/// master.
///
/// OutLayer publishes the instruction count of every run. A general-purpose
/// hex parser branches on each digit (a letter costs more than a number), so
/// the count would tell anyone how many of the master's 64 digits are
/// letters. Here only the length and the overall validity decide a branch,
/// and both are the same for every valid master.
fn decode_master(hex: &[u8]) -> Option<Zeroizing<[u8; 32]>> {
    let (pairs, []) = hex.as_chunks::<2>() else {
        return None;
    };
    let mut master = Zeroizing::new([0u8; 32]);
    if pairs.len() != master.len() {
        return None;
    }
    // Bits above the low four are set only by a byte that is not a hex digit.
    let mut invalid = 0u16;
    for (byte, &[high, low]) in master.iter_mut().zip(pairs) {
        let (high, low) = (nibble(high), nibble(low));
        invalid |= high | low;
        // Truncation intended: both are below 16 when the digits are valid.
        *byte = ((high << 4) | low) as u8;
    }
    (invalid >> 4 == 0).then_some(master)
}

/// The value of one hex digit (`0`-`9`, `a`-`f`, `A`-`F`), or `0xffff` for any
/// other byte, with no branch on the byte.
///
/// `(lo - 1 - c) & (c - hi - 1)` is negative exactly when `lo <= c <= hi`, and
/// `>> 8` turns its sign into an all-ones or all-zeros mask. So each of the
/// three ranges adds the digit's value plus one when `c` is in it and nothing
/// otherwise; starting from -1, a digit ends at its value and any other byte
/// stays at -1. The same arithmetic as the `base16ct` crate's decoder. No step
/// can overflow: every intermediate value lies between -256 and 255.
fn nibble(c: u8) -> u16 {
    let c = i16::from(c);
    let in_range = |lo: i16, hi: i16| ((lo - 1 - c) & (c - hi - 1)) >> 8;
    let value: i16 = -1
        + (in_range(0x30, 0x39) & (c - 0x2f)) // '0'..='9' -> 1..=10
        + (in_range(0x41, 0x46) & (c - 0x36)) // 'A'..='F' -> 11..=16
        + (in_range(0x61, 0x66) & (c - 0x56)); // 'a'..='f' -> 11..=16
    value as u16
}

/// Why the job refused a run before handing it to `run`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    NotNearExecution,
    MissingPredecessor,
    MissingSender,
    InputUnreadable,
    InputTooLarge,
    InvalidJson,
    DuplicateKey,
    SignerIsContract,
    MissingMaster,
    InvalidMaster,
}

impl Refusal {
    /// The code on stderr (see the table at the top of this file).
    const fn code(self) -> &'static str {
        match self {
            Self::NotNearExecution => "not_near_execution",
            Self::MissingPredecessor => "missing_predecessor",
            Self::MissingSender => "missing_sender",
            Self::InputUnreadable => "input_unreadable",
            Self::InputTooLarge => "input_too_large",
            Self::InvalidJson => "invalid_json",
            Self::DuplicateKey => "duplicate_key",
            Self::SignerIsContract => "signer_is_contract",
            Self::MissingMaster => "missing_master",
            Self::InvalidMaster => "invalid_master",
        }
    }
}

#[cfg(test)]
mod tests {
    use fairground_clearing::hash::to_hex;
    use fairground_sealer::SaleKeypair;

    use super::*;

    /// A test master. Never a real secret.
    const MASTER: [u8; 32] = *b"fairground TEST master, not real";
    const CONTRACT: &str = "fairground.testnet";
    const PUBKEY: &str =
        r#"{"v":1,"op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}"#;
    /// A `clear` request with no bids. `run` refuses it (the hash is not the
    /// empty set's), which is enough to tell whether it reached `run`.
    /// The key `op` with its `o` written as a JSON `\u` escape.
    const ESCAPED_OP: &str = "\"\\u006fp\"";
    const CLEAR: &str = r#"{"v":1,"op":"clear","contract":"fairground.testnet","sale_id":"fairt","params":{"sale_supply":"1","floor_price":"1","max_price":null,"min_raise":"0","decimals":0},"bid_set_hash":"0000000000000000000000000000000000000000000000000000000000000000","bids":[]}"#;

    /// The environment of an on-chain run from the sale contract, signed by a
    /// user.
    fn near_env() -> Vec<(&'static str, String)> {
        vec![
            (EXECUTION_TYPE_VAR, "NEAR".into()),
            (PREDECESSOR_VAR, CONTRACT.into()),
            (SENDER_VAR, "alice.testnet".into()),
            (MASTER_VAR, to_hex(&MASTER)),
        ]
    }

    fn with(
        mut env: Vec<(&'static str, String)>,
        name: &'static str,
        value: Option<&str>,
    ) -> Vec<(&'static str, String)> {
        env.retain(|(key, _)| *key != name);
        if let Some(value) = value {
            env.push((name, value.into()));
        }
        env
    }

    fn respond_with(input: &[u8], env: &[(&'static str, String)]) -> Result<String, Refusal> {
        respond(input, |name| {
            env.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        })
    }

    fn native(input: &str, predecessor: &str) -> String {
        run(
            input,
            &Ctx {
                predecessor: predecessor.into(),
                master: MASTER,
            },
        )
    }

    /// Answered exactly as `run` answers it.
    fn assert_answered(input: &str, env: &[(&'static str, String)]) {
        assert_eq!(
            respond_with(input.as_bytes(), env),
            Ok(native(input, CONTRACT)),
            "{input:.80}"
        );
    }

    #[test]
    fn answers_exactly_what_run_answers() {
        let answer = respond_with(PUBKEY.as_bytes(), &near_env()).unwrap();
        assert_eq!(answer, native(PUBKEY, CONTRACT));
        let key = SaleKeypair::derive(&MASTER, CONTRACT, "fairt");
        assert_eq!(
            answer,
            format!(
                r#"{{"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"{}"}}"#,
                key.public_key_hex()
            )
        );
        assert_answered(CLEAR, &near_env());
    }

    #[test]
    fn the_master_may_be_upper_case_hex() {
        let env = with(
            near_env(),
            MASTER_VAR,
            Some(&to_hex(&MASTER).to_uppercase()),
        );
        assert_answered(PUBKEY, &env);
    }

    #[test]
    fn requests_from_another_contract_are_refused_by_run() {
        let env = with(near_env(), PREDECESSOR_VAR, Some("evil.testnet"));
        let answer = respond_with(PUBKEY.as_bytes(), &env).unwrap();
        assert_eq!(answer, native(PUBKEY, "evil.testnet"));
        assert!(
            answer.contains(r#""error":"predecessor_mismatch""#),
            "{answer}"
        );
    }

    #[test]
    fn only_on_chain_runs_are_served() {
        for value in [None, Some("HTTPS"), Some("near"), Some(""), Some("NEAR ")] {
            let env = with(near_env(), EXECUTION_TYPE_VAR, value);
            assert_eq!(
                respond_with(PUBKEY.as_bytes(), &env),
                Err(Refusal::NotNearExecution)
            );
        }
        // An HTTPS run as the worker builds it: execution type HTTPS, empty predecessor.
        let env = with(
            with(near_env(), EXECUTION_TYPE_VAR, Some("HTTPS")),
            PREDECESSOR_VAR,
            Some(""),
        );
        assert_eq!(
            respond_with(PUBKEY.as_bytes(), &env),
            Err(Refusal::NotNearExecution)
        );
    }

    #[test]
    fn a_predecessor_and_a_sender_are_required() {
        for value in [None, Some("")] {
            let env = with(near_env(), PREDECESSOR_VAR, value);
            assert_eq!(
                respond_with(PUBKEY.as_bytes(), &env),
                Err(Refusal::MissingPredecessor)
            );
            let env = with(near_env(), SENDER_VAR, value);
            assert_eq!(
                respond_with(PUBKEY.as_bytes(), &env),
                Err(Refusal::MissingSender)
            );
        }
    }

    #[test]
    fn the_contract_account_may_only_ask_for_a_public_key() {
        assert_eq!(serde_json::from_str::<String>(ESCAPED_OP).unwrap(), "op");
        assert_ne!(ESCAPED_OP, "\"op\"");
        let env = with(near_env(), SENDER_VAR, Some(CONTRACT));
        // A public key reveals nothing: the deploy smoke test asks for one so.
        assert_answered(PUBKEY, &env);
        // `pubkey` with its `p` escaped is still `pubkey`, for `run` too.
        let pubkey_escaped = PUBKEY.replace(r#""pubkey""#, "\"\\u0070ubkey\"");
        assert!(pubkey_escaped.contains("\\u0070"), "{pubkey_escaped}");
        assert_answered(&pubkey_escaped, &env);
        // Anything else, read the way `run` reads it, is refused.
        for request in [
            CLEAR,
            r#"{"v":1}"#,
            r#"{"v":1,"op":["pubkey"],"contract":"fairground.testnet","sale_id":"fairt"}"#,
            r#"{"v":1,"op":"pubkey ","contract":"fairground.testnet","sale_id":"fairt"}"#,
            r#"{"v":1,"params":{"op":"pubkey"},"op":"clear"}"#,
            &CLEAR.replace(r#""op""#, ESCAPED_OP),
        ] {
            assert_eq!(
                respond_with(request.as_bytes(), &env),
                Err(Refusal::SignerIsContract),
                "{request}"
            );
        }
        // Another signer is fine; the check is not about the request.
        assert_answered(CLEAR, &near_env());
    }

    #[test]
    fn repeated_keys_are_refused_at_any_depth() {
        let env = near_env();
        for request in [
            // The reviewer's example: run would read the second one.
            r#"{"v":1,"op":"pubkey","contract":"evil.testnet","contract":"fairground.testnet","sale_id":"fairt"}"#,
            r#"{"v":1,"op":"clear","op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}"#,
            // Equal after unescaping.
            &PUBKEY.replacen('{', &format!("{{{ESCAPED_OP}:\"pubkey\","), 1),
            &CLEAR.replace(r#""decimals":0"#, r#""decimals":0,"min_raise":"5""#),
            r#"{"v":1,"bids":[["a","1","x"],{"k":1,"k":1}]}"#,
            r#"{"a":[[[{"b":{"c":1,"c":2}}]]]}"#,
        ] {
            assert_eq!(
                respond_with(request.as_bytes(), &env),
                Err(Refusal::DuplicateKey),
                "{request}"
            );
        }
        // The same key in different objects is not a repeat.
        assert_answered(r#"{"a":{"x":1},"b":{"x":1},"c":[{"x":1},{"x":1}]}"#, &env);
    }

    #[test]
    fn repeated_keys_never_reach_run() {
        // `run` refuses them too, with an answer. The job refuses first, with
        // the same code, by failing the run, and so never reads the master
        // for them.
        let env = with(near_env(), MASTER_VAR, None);
        for request in [
            r#"{"v":1,"v":1}"#,
            r#"{"v":1,"op":"clear","op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}"#,
            &PUBKEY.replacen('{', &format!("{{{ESCAPED_OP}:\"pubkey\","), 1),
            r#"{"a":[[[{"b":{"c":1,"c":2}}]]]}"#,
        ] {
            assert_eq!(
                native(request, CONTRACT),
                r#"{"v":1,"ok":false,"op":null,"sale_id":null,"error":"duplicate_key"}"#,
                "{request}"
            );
            assert_eq!(
                respond_with(request.as_bytes(), &env),
                Err(Refusal::DuplicateKey),
                "{request}"
            );
        }
        // Malformed JSON is `invalid_json` for both, whatever it repeats.
        let broken = r#"{"op":"clear","op":"clear""#;
        assert!(native(broken, CONTRACT).contains(r#""error":"invalid_json""#));
        assert_eq!(
            respond_with(broken.as_bytes(), &env),
            Err(Refusal::InvalidJson)
        );
    }

    #[test]
    fn requests_must_be_one_json_object() {
        for input in [
            "",
            " ",
            "null",
            "1",
            "\"x\"",
            "[]",
            "[1,2]",
            "{",
            "not json",
            "{}x",
            "{} {}",
            "{\"a\":1,}",
            "\u{feff}{}",
        ] {
            assert_eq!(
                respond_with(input.as_bytes(), &near_env()),
                Err(Refusal::InvalidJson),
                "{input:?}"
            );
        }
        // Objects reach `run`, which answers in its own words.
        for input in ["{}", " {\"v\":1} \n", "{\"v\":2}"] {
            assert_answered(input, &near_env());
        }
    }

    #[test]
    fn nesting_is_limited_as_in_run() {
        let nested = |depth: usize| format!("{{\"a\":{}{}}}", "[".repeat(depth), "]".repeat(depth));
        // 1 object + 126 arrays: within serde_json's limit of 128, for `run` too.
        assert_answered(&nested(126), &near_env());
        assert_eq!(
            respond_with(nested(200).as_bytes(), &near_env()),
            Err(Refusal::InvalidJson)
        );
    }

    #[test]
    fn the_master_must_be_present_and_well_formed() {
        let env = with(near_env(), MASTER_VAR, None);
        assert_eq!(
            respond_with(PUBKEY.as_bytes(), &env),
            Err(Refusal::MissingMaster)
        );

        let hex = to_hex(&MASTER);
        for bad in [
            String::new(),
            hex[..63].to_owned(),
            format!("{hex}0"),
            format!("{hex}00"),
            format!("0x{hex}"),
            format!(" {hex}"),
            format!("{}zz", &hex[..62]),
            format!("{}g0", &hex[..62]),
            format!("{}é", &hex[..62]),
            "secret".to_owned(),
        ] {
            let env = with(near_env(), MASTER_VAR, Some(&bad));
            assert_eq!(
                respond_with(PUBKEY.as_bytes(), &env),
                Err(Refusal::InvalidMaster),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn nibble_matches_a_reference_for_every_byte() {
        for byte in 0..=u8::MAX {
            let expected = char::from(byte)
                .to_digit(16)
                .filter(|_| byte.is_ascii())
                .map_or(0xffff, |digit| u16::try_from(digit).unwrap());
            assert_eq!(nibble(byte), expected, "{byte:#04x}");
        }
    }

    #[test]
    fn the_master_decodes_in_either_case() {
        let mixed = "0123456789abcdefABCDEF0123456789aBcDeF0123456789abcdef0123456789";
        let expected: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&mixed[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        assert_eq!(
            decode_master(mixed.as_bytes()).as_deref().map(|m| &m[..]),
            Some(&expected[..])
        );
        assert_eq!(
            decode_master(to_hex(&MASTER).as_bytes()).as_deref(),
            Some(&MASTER)
        );
        assert!(decode_master(&[b'0'; 63]).is_none());
        assert!(decode_master(&[b'0'; 66]).is_none());
        let mut one_bad = [b'f'; 64];
        for bad in [b'g', b'G', b'/', b':', b'@', b'`', 0, 0x80, 0xff] {
            for at in [0, 31, 63] {
                one_bad[at] = bad;
                assert!(decode_master(&one_bad).is_none(), "{bad:#04x} at {at}");
                one_bad[at] = b'f';
            }
        }
    }

    #[test]
    fn input_is_capped() {
        let mut padded = PUBKEY.as_bytes().to_vec();
        padded.resize(usize::try_from(MAX_INPUT_BYTES).unwrap(), b' ');
        // Exactly at the cap: read and answered. JSON allows trailing whitespace.
        assert_eq!(
            respond_with(&padded, &near_env()),
            Ok(native(PUBKEY, CONTRACT))
        );
        padded.push(b' ');
        assert_eq!(
            respond_with(&padded, &near_env()),
            Err(Refusal::InputTooLarge)
        );
    }

    #[test]
    fn input_that_is_not_utf8_is_not_json() {
        assert_eq!(
            respond_with(b"\xff\xfe{}", &near_env()),
            Err(Refusal::InvalidJson)
        );
        let mut almost = PUBKEY.as_bytes().to_vec();
        almost.insert(almost.len() - 2, 0xc3);
        assert_eq!(
            respond_with(&almost, &near_env()),
            Err(Refusal::InvalidJson)
        );
    }

    #[test]
    fn an_unreadable_stdin_is_refused() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("broken pipe"))
            }
        }
        let env = near_env();
        let answer = respond(Broken, |name| {
            env.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        });
        assert_eq!(answer, Err(Refusal::InputUnreadable));
    }

    #[test]
    fn the_checks_run_in_the_documented_order() {
        // Nothing is valid; the first rule that applies decides.
        let mut env = vec![(EXECUTION_TYPE_VAR, "HTTPS".to_owned())];
        assert_eq!(respond_with(b"\xff", &env), Err(Refusal::NotNearExecution));
        env = with(env, EXECUTION_TYPE_VAR, Some("NEAR"));
        assert_eq!(
            respond_with(b"\xff", &env),
            Err(Refusal::MissingPredecessor)
        );
        env = with(env, PREDECESSOR_VAR, Some(CONTRACT));
        assert_eq!(respond_with(b"\xff", &env), Err(Refusal::MissingSender));
        env = with(env, SENDER_VAR, Some(CONTRACT));
        assert_eq!(respond_with(b"\xff", &env), Err(Refusal::InvalidJson));
        let repeated = br#"{"op":"clear","op":"clear"}"#;
        assert_eq!(respond_with(repeated, &env), Err(Refusal::DuplicateKey));
        assert_eq!(
            respond_with(CLEAR.as_bytes(), &env),
            Err(Refusal::SignerIsContract)
        );
        assert_eq!(
            respond_with(PUBKEY.as_bytes(), &env),
            Err(Refusal::MissingMaster)
        );
        env = with(env, MASTER_VAR, Some("zz"));
        assert_eq!(
            respond_with(PUBKEY.as_bytes(), &env),
            Err(Refusal::InvalidMaster)
        );
    }

    #[test]
    fn codes_are_distinct_snake_case_words() {
        let all = [
            Refusal::NotNearExecution,
            Refusal::MissingPredecessor,
            Refusal::MissingSender,
            Refusal::InputUnreadable,
            Refusal::InputTooLarge,
            Refusal::InvalidJson,
            Refusal::DuplicateKey,
            Refusal::SignerIsContract,
            Refusal::MissingMaster,
            Refusal::InvalidMaster,
        ];
        let codes: BTreeSet<&str> = all.iter().map(|refusal| refusal.code()).collect();
        assert_eq!(codes.len(), all.len());
        assert!(
            codes
                .iter()
                .all(|code| code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        );
    }
}
