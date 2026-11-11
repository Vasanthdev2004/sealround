//! What the wasm tests share: the built job module, compiled once per test
//! binary, and checks on what a run printed.
//!
//! The tests run the release wasm, so build it first (or use
//! `scripts/run-enclave.ps1 -Test`, which does both steps):
//!
//! ```text
//! cargo build --release --target wasm32-wasip1 -p fairground-sealer-job
//! cargo test -p fairground-harness -- --nocapture
//! ```
//!
//! `FAIRGROUND_JOB_WASM` points them at another build, above all the one
//! OutLayer runs: `enclave/res/fairground_sealer.wasm` from the Docker build
//! (`scripts/run-enclave.ps1 -Test` runs the wasm tests on both).

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::OnceLock;

use fairground_clearing::hash::{sha256, to_hex};
use fairground_harness::{CONTRACT, MASTER_VAR, TEST_MASTER, master_hex};
use fairground_runner::{
    End, HARD_MAX_EXECUTION_SECONDS, HARD_MAX_INSTRUCTIONS, Limits, Outcome, Runner, near_env,
};

pub fn wasm_path() -> PathBuf {
    std::env::var_os("FAIRGROUND_JOB_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/wasm32-wasip1/release/fairground-sealer.wasm")
        })
}

/// The job module, compiled once for the whole test binary.
pub fn runner() -> &'static Runner {
    static RUNNER: OnceLock<Runner> = OnceLock::new();
    RUNNER.get_or_init(|| {
        let path = wasm_path();
        let wasm = std::fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "cannot read {} ({error}). Build it first: \
                 cargo build --release --target wasm32-wasip1 -p fairground-sealer-job",
                path.display()
            )
        });
        println!(
            "job: {} ({} bytes, sha256 {})",
            path.display(),
            wasm.len(),
            to_hex(&sha256(&wasm))
        );
        Runner::new(&wasm).expect("the job module compiles")
    })
}

/// The request's hard caps: enough for any fixture here.
pub fn generous() -> Limits {
    Limits {
        max_instructions: HARD_MAX_INSTRUCTIONS,
        max_memory_mb: 128,
        max_execution_seconds: HARD_MAX_EXECUTION_SECONDS,
    }
}

/// An on-chain run from the sale contract with the test secret row.
pub fn on_chain() -> Vec<(String, String)> {
    near_env(CONTRACT, &[(MASTER_VAR, &master_hex())])
}

/// Sets (or with `None` removes) one variable.
pub fn set(env: &mut Vec<(String, String)>, name: &str, value: Option<&str>) {
    env.retain(|(key, _)| key != name);
    if let Some(value) = value {
        env.push((name.to_owned(), value.to_owned()));
    }
}

/// Neither the master's hex (either case) nor its raw bytes.
pub fn assert_no_secret(what: &str, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes).to_lowercase();
    assert!(
        !text.contains(&master_hex()),
        "{what} holds the master's hex"
    );
    assert!(
        !bytes
            .windows(TEST_MASTER.len())
            .any(|window| window == TEST_MASTER),
        "{what} holds the master's bytes"
    );
}

/// Runs the job and checks what every answer must satisfy: the run succeeded
/// (exit 0), stderr is empty, nothing secret is printed, and stdout is one
/// JSON object with no trailing newline. Returns stdout.
pub fn answer(input: &[u8], env: &[(String, String)], limits: Limits) -> (String, Outcome) {
    let outcome = runner().run(input, env, limits).expect("the job starts");
    assert!(outcome.succeeded(), "run ended {:?}", outcome.end);
    assert!(
        outcome.stderr.is_empty(),
        "stderr: {}",
        String::from_utf8_lossy(&outcome.stderr)
    );
    assert_no_secret("stdout", &outcome.stdout);
    let stdout = String::from_utf8(outcome.stdout.clone()).expect("the answer is UTF-8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("the answer is JSON");
    assert!(value.is_object(), "{stdout}");
    assert!(!stdout.ends_with('\n'));
    (stdout, outcome)
}

/// Runs the job and checks that it refused the run the way the job's own
/// refusals end: exit status 1 (the worker counts a failed run and the
/// contract gets `null`), nothing on stdout, and exactly
/// `fairground-sealer: refused: <code>` on stderr, which the worker publishes.
pub fn refused(input: &[u8], env: &[(String, String)], code: &str) -> Outcome {
    let outcome = runner()
        .run(input, env, generous())
        .expect("the job starts");
    assert_eq!(outcome.end, End::Exited(1), "{code}");
    assert!(
        outcome.stdout.is_empty(),
        "{code}: {}",
        String::from_utf8_lossy(&outcome.stdout)
    );
    assert_eq!(
        String::from_utf8_lossy(&outcome.stderr),
        format!("fairground-sealer: refused: {code}\n")
    );
    outcome
}
