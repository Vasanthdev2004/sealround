//! The job as a native process: stdin, environment, stdout, stderr and the
//! exit status, the parts a unit test of `respond` cannot see. The same checks
//! run against the wasm module under the OutLayer-like runner in
//! `tools/harness/tests`.

use std::io::Write;
use std::process::{Command, Output, Stdio};

/// A test master (hex of `fairground TEST master, not real`). Never a real secret.
const MASTER_HEX: &str = "6661697267726f756e642054455354206d61737465722c206e6f74207265616c";
const PUBKEY: &str = r#"{"v":1,"op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}"#;

fn job(input: &[u8], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fairground-sealer"));
    for name in [
        "OUTLAYER_EXECUTION_TYPE",
        "NEAR_PREDECESSOR_ID",
        "NEAR_SENDER_ID",
        "PROTECTED_FAIRGROUND_MASTER",
    ] {
        command.env_remove(name);
    }
    let mut child = command
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    // Written from another thread: a large input would otherwise fill the
    // pipe while the job is blocked writing its answer.
    let writer = std::thread::spawn(move || {
        // The job stops reading at its cap, so a broken pipe here is expected.
        let _ = stdin.write_all(&input);
    });
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    output
}

fn on_chain() -> Vec<(&'static str, &'static str)> {
    vec![
        ("OUTLAYER_EXECUTION_TYPE", "NEAR"),
        ("NEAR_PREDECESSOR_ID", "fairground.testnet"),
        ("NEAR_SENDER_ID", "alice.testnet"),
        ("PROTECTED_FAIRGROUND_MASTER", MASTER_HEX),
    ]
}

fn without(name: &str) -> Vec<(&'static str, &'static str)> {
    on_chain()
        .into_iter()
        .filter(|(key, _)| *key != name)
        .collect()
}

fn assert_no_secret(what: &str, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes).to_lowercase();
    assert!(!text.contains(MASTER_HEX), "{what}: {text}");
}

#[test]
fn answers_on_stdout_with_exit_zero() {
    let output = job(PUBKEY.as_bytes(), &on_chain());
    assert!(output.status.success(), "{:?}", output.status);
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_no_secret("stdout", stdout.as_bytes());
    assert!(
        stdout.starts_with(r#"{"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":""#),
        "{stdout}"
    );
    assert!(
        !stdout.ends_with('\n'),
        "the answer is exact bytes, no newline"
    );
}

/// Input, environment, and the refusal code expected.
type Case<'a> = (&'a [u8], Vec<(&'a str, &'a str)>, &'a str);

#[test]
fn refusals_fail_the_run_with_the_code_on_stderr() {
    let mut contract_signed = on_chain();
    contract_signed[2] = ("NEAR_SENDER_ID", "fairground.testnet");
    let mut bad_master = on_chain();
    bad_master[3] = ("PROTECTED_FAIRGROUND_MASTER", "not hex");
    let clear = br#"{"v":1,"op":"clear","contract":"fairground.testnet","sale_id":"fairt"}"#;

    let cases: [Case; 9] = [
        (PUBKEY.as_bytes(), vec![], "not_near_execution"),
        (
            PUBKEY.as_bytes(),
            without("NEAR_PREDECESSOR_ID"),
            "missing_predecessor",
        ),
        (
            PUBKEY.as_bytes(),
            without("NEAR_SENDER_ID"),
            "missing_sender",
        ),
        (b"\xff\xfe", on_chain(), "invalid_json"),
        (&[b' '; 4 * 1024 * 1024 + 1], on_chain(), "input_too_large"),
        (br#"{"v":1,"v":1}"#, on_chain(), "duplicate_key"),
        (clear, contract_signed, "signer_is_contract"),
        (
            PUBKEY.as_bytes(),
            without("PROTECTED_FAIRGROUND_MASTER"),
            "missing_master",
        ),
        (PUBKEY.as_bytes(), bad_master, "invalid_master"),
    ];
    for (input, env, code) in cases {
        let output = job(input, &env);
        assert_eq!(output.status.code(), Some(1), "{code}");
        assert!(output.stdout.is_empty(), "{code}: stdout must stay empty");
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            format!("fairground-sealer: refused: {code}\n")
        );
    }
}
