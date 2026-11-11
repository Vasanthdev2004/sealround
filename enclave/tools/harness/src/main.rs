//! `fairground-fixtures`: writes inputs for the enclave job, with the answer
//! the native `fairground_sealer::run` gives for each.
//!
//! ```text
//! fairground-fixtures [--out DIR] [N ...]        (default: --out target/fixtures 1 50 500 1000)
//! ```
//!
//! Writes `pubkey.json` and `clear-<N>.json` (the `input_data` the contract
//! sends), the two 500-bid worst cases of `PERF.md` (`worst-500.json`:
//! the longest ids and canonical 320-byte boxes, the largest input the contract
//! can send; `worst-500-512.json`: the same with every box padded to 512
//! bytes, which the contract accepted before it checked the length), and next to
//! each the native answer as `<name>.expected.json`. Run them with
//! `scripts/run-enclave.ps1 -Input <file>`: the master is the TEST master
//! printed at the end and the predecessor is `fairground.testnet`.

use std::path::PathBuf;

use fairground_harness::{
    BidBook, CONTRACT, Kind, LEGACY_MAX_CIPHERTEXT_BYTES, ctx, master_hex, pubkey_request,
};
use fairground_sealer::run;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() -> Result<()> {
    let mut out = PathBuf::from("target/fixtures");
    let mut sizes = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--out" {
            out = PathBuf::from(args.next().ok_or("--out needs a directory")?);
        } else {
            sizes.push(
                arg.parse::<usize>()
                    .map_err(|_| format!("not a bid count: {arg}"))?,
            );
        }
    }
    if sizes.is_empty() {
        sizes = vec![1, 50, 500, 1000];
    }
    std::fs::create_dir_all(&out)?;

    let write = |name: &str, input: &str| -> Result<()> {
        let path = out.join(format!("{name}.json"));
        std::fs::write(&path, input)?;
        std::fs::write(
            out.join(format!("{name}.expected.json")),
            run(input, &ctx(CONTRACT)),
        )?;
        println!("{}  ({} bytes)", path.display(), input.len());
        Ok(())
    };
    write("pubkey", &pubkey_request())?;
    for n in sizes {
        let book = BidBook::generate(n);
        write(&format!("clear-{n}"), &book.clear_request())?;
        println!(
            "  {n} bids: {} valid, {} invalid",
            book.count(Kind::Valid),
            n - book.count(Kind::Valid)
        );
    }
    write("worst-500", &BidBook::worst_case(500, None).clear_request())?;
    write(
        "worst-500-512",
        &BidBook::worst_case(500, Some(LEGACY_MAX_CIPHERTEXT_BYTES)).clear_request(),
    )?;
    println!("predecessor: {CONTRACT}");
    println!("master (TEST value, never a real secret): {}", master_hex());
    Ok(())
}
