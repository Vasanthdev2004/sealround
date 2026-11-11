//! `fairground-runner`: runs a WASI P1 module the way OutLayer's worker does
//! and reports what the worker would see.
//!
//! ```text
//! fairground-runner --wasm FILE [--input FILE] [--out FILE] [--env KEY=VALUE]...
//!                   [--near PREDECESSOR] [--max-instructions N] [--max-memory-mb N]
//!                   [--max-execution-seconds N]
//! ```
//!
//! - `--input`: the request's `input_data`; without it, this program's stdin.
//! - `--out`: where the module's stdout goes, byte for byte; without it, this
//!   program's stdout.
//! - `--env`: one variable of the run's environment (repeatable).
//! - `--near`: add the worker's system variables of an on-chain run from this
//!   predecessor (see [`fairground_runner::near_env`]); `--env` values for
//!   system names are then replaced, as the worker does.
//! - limits: OutLayer's `resource_limits`, with its defaults.
//!
//! A report goes to stderr as `key: value` lines. Exit status: 0 if the run
//! succeeded, 1 if it failed as the worker would count it, 2 if the module
//! could not be run at all or the arguments are wrong.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use fairground_runner::{End, Limits, Runner, near_env};

struct Args {
    wasm: PathBuf,
    input: Option<PathBuf>,
    out: Option<PathBuf>,
    env: Vec<(String, String)>,
    near: Option<String>,
    limits: Limits,
}

fn parse_args() -> Result<Args> {
    let mut wasm = None;
    let mut input = None;
    let mut out = None;
    let mut env = Vec::new();
    let mut near = None;
    let mut limits = Limits::default();
    let mut args = std::env::args_os().skip(1);
    while let Some(flag) = args.next() {
        let flag = flag.to_string_lossy().into_owned();
        let mut value = || args.next().with_context(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--wasm" => wasm = Some(PathBuf::from(value()?)),
            "--input" => input = Some(PathBuf::from(value()?)),
            "--out" => out = Some(PathBuf::from(value()?)),
            "--near" => near = Some(text(value()?)?),
            "--env" => {
                let pair = text(value()?)?;
                let (key, val) = pair.split_once('=').context("--env takes KEY=VALUE")?;
                env.push((key.to_owned(), val.to_owned()));
            }
            "--max-instructions" => limits.max_instructions = number(value()?)?,
            "--max-memory-mb" => limits.max_memory_mb = number(value()?)?,
            "--max-execution-seconds" => limits.max_execution_seconds = number(value()?)?,
            _ => bail!("unknown argument {flag}"),
        }
    }
    Ok(Args {
        wasm: wasm.context("--wasm FILE is required")?,
        input,
        out,
        env,
        near,
        limits,
    })
}

fn text(value: std::ffi::OsString) -> Result<String> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("arguments must be Unicode"))
}

fn number<T: std::str::FromStr>(value: std::ffi::OsString) -> Result<T> {
    text(value)?
        .replace('_', "")
        .parse()
        .map_err(|_| anyhow::anyhow!("not a number"))
}

fn main() -> ExitCode {
    match try_main() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::from(2)
        }
    }
}

fn try_main() -> Result<bool> {
    let args = parse_args()?;
    let wasm = std::fs::read(&args.wasm)
        .with_context(|| format!("cannot read {}", args.wasm.display()))?;
    let input = match &args.input {
        Some(path) => {
            std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?
        }
        None => {
            let mut bytes = Vec::new();
            io::stdin().lock().read_to_end(&mut bytes)?;
            bytes
        }
    };
    let env = match &args.near {
        Some(predecessor) => {
            let secrets: Vec<(&str, &str)> = args
                .env
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect();
            near_env(predecessor, &secrets)
        }
        None => args.env.clone(),
    };

    let runner = Runner::new(&wasm)?;
    let outcome = runner.run(&input, &env, args.limits)?;

    match &args.out {
        Some(path) => std::fs::write(path, &outcome.stdout)
            .with_context(|| format!("cannot write {}", path.display()))?,
        None => {
            let mut stdout = io::stdout().lock();
            stdout.write_all(&outcome.stdout)?;
            stdout.flush()?;
        }
    }

    let result = match &outcome.end {
        End::Success => "succeeded".to_owned(),
        End::Exited(code) => format!("failed: exit status {code}"),
        End::OutOfFuel => "failed: out of fuel".to_owned(),
        End::TimedOut => "failed: timed out".to_owned(),
        End::Trapped(trap) => format!("failed: {}", trap.replace('\n', " | ")),
    };
    let mut report = io::stderr().lock();
    writeln!(report, "result: {result}")?;
    writeln!(report, "instructions: {}", outcome.instructions)?;
    writeln!(report, "max_instructions: {}", args.limits.max_instructions)?;
    writeln!(report, "compile_ms: {:.1}", ms(runner.compile_time()))?;
    writeln!(report, "run_ms: {:.1}", ms(outcome.run_time))?;
    writeln!(report, "memory_bytes: {}", outcome.memory_bytes)?;
    writeln!(report, "input_bytes: {}", input.len())?;
    writeln!(report, "output_bytes: {}", outcome.stdout.len())?;
    writeln!(report, "stderr_bytes: {}", outcome.stderr.len())?;
    if !outcome.stderr.is_empty() {
        let text = String::from_utf8_lossy(&outcome.stderr);
        writeln!(report, "stderr: {}", text.trim_end().replace('\n', " | "))?;
    }
    Ok(outcome.succeeded())
}

fn ms(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}
