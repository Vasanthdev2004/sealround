# Enclave job: performance

What the Sealround OutLayer job (`fairground-sealer`, crate
`fairground-sealer-job`) costs to run, measured on 10 Nov 2026, and how that
compares with what the sale contract asks OutLayer for.

## How it was measured

- **Module**: `enclave/res/fairground_sealer.wasm`, the Docker build from
  `scripts/build-enclave.ps1` and the only module to deploy and pin: 276,156
  bytes, sha256
  `f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb`
  (`scripts/build-enclave.ps1 -Verify` rebuilds it byte for byte;
  `enclave/res/fairground_sealer.wasm.sha256` is the source of truth). The
  hash depends on the sources of `crates/sealer` and `crates/clearing` too, so
  it changes whenever they do.
- **What changed since the build of 9 Nov 2026** (`a4526703...`, 266,237
  bytes, never deployed): bids are sealed with both amounts padded to 39
  digits, a clear's answer names `pubkey` and `invalid`, `run` refuses
  repeated keys itself, and the clearing price is found with the fixed-shape
  search (below). The books of this file are therefore not the books of the
  earlier measurements: the inputs are about a third larger.
- **The native build** (`cargo build --release --target wasm32-wasip1 -p
  fairground-sealer-job` from `enclave/`, 276,497 bytes, sha256 `4efb8e81...`
  on this machine) has another hash, because it embeds this machine's source
  paths, but the same code: on the same seven input files
  (`scripts/run-enclave.ps1 -Fixtures`) it used exactly the same instructions
  and gave the same bytes as the Docker build (pubkey 2,113,911; 500 bids
  3,139,344,160; 1000 bids 6,258,095,213; the worst case 3,193,296,629). The
  tests run on both (`scripts/run-enclave.ps1 -Test`).
- **Runner**: `tools/runner` (`fairground-runner`) is a copy of the worker's
  WASI P1 path (`worker/src/executor/wasi_p1.rs` in fastnear/near-outlayer at
  3079d756a0): wasmtime 28.0.1, async, fuel metering, epoch deadline, stdin
  input, 10 MiB stdout, memory floor 1024 MB, the worker's on-chain
  environment. "Instructions" are wasmtime fuel, which is what OutLayer limits
  (`max_instructions`) and charges for.
- **Cross-check** (the first revision of the job, same runner): OutLayer's own
  `wasi-examples/wasi-test-runner` (built natively from the same commit)
  reported exactly the same fuel for the same module, input and environment,
  less about 1,300 instructions because it passes fewer environment
  variables, which the module copies at start-up. The tables below include
  them. Not repeated for this build.
- **Inputs**: `tools/harness` (`BidBook::generate(n)`): `n` bids sealed with
  `fairground_sealer::seal_bid` to the sale key derived from a TEST master.
  That is the canonical plaintext the app seals, both amounts zero-padded to
  39 digits, so every box is `224 + len(sale_id) + len(bidder)` bytes (248
  here) whatever it bids. About 1 in 10 bids is void: random bytes of a
  bid's length, a copied ciphertext, the wrong sale's key, a plaintext naming
  another sale, a price below the floor, a spend above the deposit, or a zero
  spend. One bid in the middle bids 10^30 USDC per token. Decimals 18,
  oversubscribed about three times. Every answer was checked to be
  byte-identical to the native `fairground_sealer::run`.
- **Key order**: the harness writes a request's keys alphabetically
  (`serde_json`), the contract writes `v`, `op`, `contract`, `sale_id`, ...
  (contracts/fairground/src/outlayer.rs). Same keys, values and length. The
  same four requests rewritten in the contract's order gave the same
  outputs and cost 249 instructions more for `pubkey` and about 3,100 fewer
  for a clear (1, 500 and worst-case 500 bids): 0.0001 % of the figures
  below.
- **Machine**: Intel Core i7-13645HX (20 threads), 32 GB, Windows 11. This is
  not a TDX worker. Other builds were running beside these measurements, so
  the times are upper bounds; instruction counts do not depend on load.

## Results

The Docker build (`FAIRGROUND_JOB_WASM=enclave/res/fairground_sealer.wasm
cargo test -p fairground-harness --test perf -- --nocapture`):

| bids | valid | input bytes | output bytes | instructions | x 1e9 default | peak memory | run |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pubkey | | 71 | 125 | 2,113,911 | 0.002 | 1.1 MiB | 0.6 ms |
| 1 | 1 | 658 | 320 | 8,550,112 | 0.009 | 1.1 MiB | 0.6 ms |
| 50 | 43 | 18,834 | 1,625 | 309,381,599 | 0.31 | 1.2 MiB | 16 ms |
| 160 | 145 | 59,634 | 4,838 | 1,007,378,236 | 1.01 | 1.3 MiB | 58 ms |
| 500 | 460 | 185,743 | 14,950 | 3,139,344,108 | **3.14** | 1.9 MiB | 160 ms |
| 1000 | 892 | 371,193 | 29,468 | 6,258,095,148 | 6.26 | 2.7 MiB | 330 ms |
| 2000 | 1796 | 742,077 | 59,501 | 12,514,527,845 | 12.51 | 4.4 MiB | 707 ms |
| **500, worst case** | 500 | 271,315 | 17,881 | **3,193,296,681** | 3.19 | 2.3 MiB | 204 ms |
| 500, worst case, 512-byte boxes | 500 | 399,315 | 17,881 | 3,215,261,315 | 3.22 | 2.6 MiB | 165 ms |

The worst case is the largest clear request the contract can send
(`BidBook::worst_case`): 500 bids, all valid, a 32-character sale id,
64-character bidder ids, 39-digit deposits and one bid at max price 1e38.
Its boxes are 320 bytes each, `sealed_bid_len(32, 64)`, the longest the
contract accepts. The last row holds the same bids with every plaintext
padded with spaces to a 512-byte box. That was the contract's limit before
it checked the exact length; it now refuses such a bid
(`ciphertext_too_long`, and `wrong_ciphertext_length` for any other length
but the exact one), so the row is only an upper bound on what the job could
be given. Both outputs were byte-identical to the native `run`.

Compiling the module (Cranelift, once per run on the worker) took 77-94 ms.

- **Per bid**: about 6.26 M instructions (6.19 M at 50 bids, 6.30 M at 160,
  6.28 M at 500, 6.26 M at 1000 and 2000; it follows the share of valid
  bids). Most of it is opening the sealed box: a 1-bid clear costs 6.44 M
  more than a `pubkey` request, which is the fixed cost (2.1 M). The linear
  fit the test prints ("fixed: -3.7M") means nothing more than that the
  books' valid shares differ.
- **The fixed-shape price search costs about 1 %** (next section).
- **The job's own pass over the request** (repeated keys, `op`; see
  `job/src/main.rs`, `scan`) runs before the master is read. A run refused
  after it costs what was read and scanned: 1,962,241 instructions for a
  500-bid clear with no secret row (`missing_master`; 0.06 % of the clear),
  2,558,542 for the worst case, 16,911 for a `pubkey` request. A run refused
  before the input is read (`not_near_execution`) costs 2,900. A 500-bid
  clear that `run` refuses with `predecessor_mismatch` costs 5,982,486:
  `run` parses the request and looks for repeated keys again before it
  checks who is asking.
- **OutLayer's default limit of 1e9 instructions fits just under 160 bids**:
  the 160-bid book needs 1.007e9. With default limits a 500-bid clear runs
  out of fuel and the contract gets `null` (tested:
  `a_clear_over_its_instruction_limit_fails_the_run`). The contract does not
  use the default (see "What the contract asks for").
- **Stable counts**: a book sealed afresh (new ciphertexts, same plaintexts)
  costs the same to within about a hundred instructions (-104 at 500 bids in
  this run, between -65 and +91 in six others). The crypto is constant-time;
  base64 and JSON scanning vary slightly.
- **The master's digits cost nothing extra**: a `pubkey` request costs
  2,113,911 instructions under each of ten masters (all digits, all letters,
  either case, mixed; `reading_the_master_costs_the_same_for_every_master`).
- **Throughput** here is about 20e9 instructions per second, so time is not
  close to a limit. 500 bids take about 0.25 s including compilation, against
  60 s (`max_execution_seconds`) and the ~117 s yield window (200 blocks;
  OutLayer adds about 5 s of its own around a run). A TDX guest is slower than
  this laptop, but not by the factor of 200 it would take to matter.
- **Memory** peaks at 2.3 MiB for the worst case and 4.4 MiB at 2000 bids.
  OutLayer's default is 128 MB, and the worker gives every run at least
  1024 MB.

## The fixed-shape price search

OutLayer publishes every run's instruction count. The clearing crate's fast
search (`PriceSearch::Fast`, which the contract's `clear_onchain` keeps)
takes about one step per bit of the highest valid max price and stops each
demand sum early, so a clear's count told the magnitude of the top bid, which
the uniform price is meant to hide. The job now clears with
`PriceSearch::FixedShape` (`crates/sealer/src/job.rs`, `PRICE_SEARCH`):
always 128 halvings over `[floor, u128::MAX]`, each computing the demand of
every valid bid and masking out the ones below the probe. The results are the
same as the fast search's (the clearing crate proves that on its vectors and
on random books).

**It hides the top price on wasm too.** Two 500-bid books that differ only in
the max price of their 25 top bids, 1e4 against 1e30 (above the clearing
price either way, so the answers are equal), cost 3,131,081,921 and
3,131,082,051 instructions on the Docker build: 130 apart (0 and 104 in two
other runs), which is the noise of sealing a book afresh. The test
`the_top_max_price_does_not_change_the_instruction_count` allows 20,000. It
fails on two builds made to check it (native builds of copies of the
sources, not kept in the repository): with the fast search the same two
books are 2,091,829 instructions apart, and with a fixed-shape loop that
skips the masked-out bids instead of computing them, 1,252,723. So
`core::hint::black_box` in `full_demand` does keep the compiler from
skipping that work on wasm32.

**What it costs.** The same sources built natively twice, once as they are
and once with `PRICE_SEARCH = PriceSearch::Fast`, on the books of the table
above:

| bids | fixed-shape | fast | extra |
| ---: | ---: | ---: | ---: |
| 1 | 8,550,190 | 8,465,890 | +84,300 (1.00 %) |
| 50 | 309,381,625 | 306,559,350 | +2,822,275 (0.92 %) |
| 160 | 1,007,378,171 | 997,808,620 | +9,569,551 (0.96 %) |
| 500 | 3,139,344,160 | 3,108,950,371 | +30,393,789 (0.98 %) |
| 1000 | 6,258,095,122 | 6,199,170,530 | +58,924,592 (0.95 %) |
| 2000 | 12,514,527,897 | 12,396,018,482 | +118,509,415 (0.96 %) |
| 500, worst case | 3,193,296,603 | 3,162,934,990 | +30,361,613 (0.96 %) |
| 500, worst case, 512-byte boxes | 3,215,261,146 | 3,184,899,559 | +30,361,587 (0.95 %) |

That is about 66,000 instructions per valid bid from 50 bids up, or 1 % of a
clear, and one or two bids fewer within OutLayer's default limit (the fast
build fits the 160-bid book in 0.998e9). At OutLayer's price of 1e-10 NEAR per million instructions
the extra 30 M at 500 bids cost 0.000000003 NEAR. Natively the whole clear
of 500 bids, without the decryption, takes about 0.4 ms instead of 0.09 ms
(the core crates' measurement); decryption dominates either way.

**What still varies with the bids**, as documented on
`PriceSearch::FixedShape`: the instruction count of each u128 division
depends on the sizes of the numbers; a bid's checks stop at the first rule it
breaks; and the allocation at the clearing price depends on which bids are at
the margin. The count also tells the number of bids, the share of them that
are valid and the input's size, all of which are public anyway (bid count
and ids on chain, `n_valid` in the answer). None of it tells the top max
price.

## What the contract asks for

The contract sends `resource_limits` of `max_instructions` 50,000,000,000
and `max_execution_seconds` 60 for every request (`SEALER_MAX_INSTRUCTIONS`,
`SEALER_MAX_EXECUTION_SECONDS`, contracts/fairground/src/costs.rs). That
covers the largest clear it can send (3.19e9) **15.7 times** (15.6 times
with 512-byte boxes) and a 1000-bid book 8 times; keep it. Lowering it to
10e9 would save 0.000004 NEAR per request and cut the margin about five
times.

`get_close_deposit` is twice OutLayer's estimate at those limits,
`2 x (0.001 + 50,000e6/1e6 x 1e-10 + 60 x 0.0001)` = **0.01401 NEAR**
(`OUTLAYER_COMPUTE_DEPOSIT`), plus `(input_len - 32768) x 1e19` yoctoNEAR for
the input's storage, which OutLayer holds while the request is pending and
returns afterwards: about 1.53 NEAR for the 186 KB 500-bid input, 2.39 NEAR
for the 271 KB worst case. (Padding made a sealed bid about 90 base64
characters longer, so the 500-bid input grew from 141 KB and the deposit
held from 1.08 NEAR.) OutLayer also reserves 25 MGas per input byte above
32 KB for its callback (about 3.8 TGas at 186 KB, 6.0 TGas for the worst
case). Instructions are almost free: OutLayer charges 1e-10 NEAR per
million, so a 500-bid clear costs 0.0000003 NEAR in instructions. The
`pubkey` request (2.1 M) would fit the defaults too.

Outputs (15.0 KB at 500 bids, 17.9 KB in the worst case) are over
1024 bytes, so the worker delivers them in its two-step resolve. The callback
gets them as normal.

## Choosing the profile

Measured on the first revision of the job (9 Nov 2026: before the request
pass, the constant-cost master decoder, padded bids and the fixed-shape
search, none of which change the ranking): the 500-bid clear under the final
settings (overflow checks on for Sealround's three crates only; see below),
with `lto = true`, `codegen-units = 1`, `panic = "abort"` and `strip = true`:

| opt-level | size | instructions (500 bids) | vs 3 |
| --- | ---: | ---: | ---: |
| `"z"` | 208,792 | 3,808,380,743 | +23.9 % |
| `"s"` | 194,749 | 3,723,702,653 | +21.2 % |
| `2` | 248,340 | 3,079,317,643 | +0.18 % |
| **`3`** | 252,286 | **3,073,633,020** | |

opt-level 3 uses the fewest instructions. The extra 43-58 KB does not matter,
because the worker takes modules up to 10 MiB. (This revision at opt-level 3:
276,156 bytes, 3,139,344,108 instructions on its own 500-bid book.)

Overflow checks: turned on for the whole build, they cost +68 %
(5,172,092,388 at opt-level 3), almost all of it in the curve25519 limb
arithmetic, which is designed not to overflow. Turned on only for
`fairground-clearing`, `fairground-sealer` and `fairground-sealer-job`, where
an overflow would be a bug in the money logic, they cost 17 k instructions
(+0.0005 %), and such a bug aborts the run instead of producing a wrong
result. That is the setting in `Cargo.toml`.

## Build determinism

- **The canonical artifact is `enclave/res/fairground_sealer.wasm`**, built by
  `scripts/build-enclave.ps1` in Docker (`enclave/build`: the official
  `rust:1.97.1-trixie` image pinned by digest, `cargo build --locked` under
  `env -i`, fixed paths remapped with `--remap-path-prefix`, a fresh target
  directory). `build-info.json` next to it records the image, toolchain,
  command, environment and the sha256 of every input file.
- `scripts/build-enclave.ps1 -Verify` rebuilds from nothing and compares:
  on 10 Nov 2026 it printed `verify: MATCH` (exit 0, 22 s) for
  `f8408a87...`, twice, with a restart of the machine and of Docker in
  between, and the rebuilt wasm and `build-info.json` were byte-identical to
  `enclave/res`. `-Expected <sha256>` checks a hash a contract pins instead.
- A native build is not reproducible elsewhere: panic-location strings in
  dependencies hold absolute source paths (this machine's `CARGO_HOME`
  registry and `D:\Projects\...\crates\{sealer,clearing}`), and Cargo's
  `trim-paths` is still unstable in 1.97.1. Three native builds here in
  different target directories gave one hash, but another machine gets
  another. Use it for tests and measurements only.
- No build script and no `env!` paths in the job.
- rustup reads `rust-toolchain.toml` from the current directory, so run cargo
  from `enclave/`. With `--manifest-path` from the repository root the pin is
  not used.
- Do not set `--cfg curve25519_dalek_bits="64"` for this target. Forced on
  wasm32 it built, ran 2.4x the instructions, derived a different public key
  and opened no bid. The parity tests catch this.

## Reproduce

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1           # the Docker build -> enclave\res
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Test        # every test; the perf table prints; the wasm tests also on enclave\res
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Fixtures    # enclave\target\fixtures\{pubkey,clear-N,worst-500,worst-500-512}.json (+ .expected.json)
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Input enclave\target\fixtures\clear-500.json `
  -Master 6661697267726f756e642054455354206d61737465722c206e6f74207265616c -Predecessor fairground.testnet `
  -MaxInstructions 50000000000 -Expected enclave\target\fixtures\clear-500.expected.json     # runs enclave\res; -Native runs a native build
```

Or with cargo, from `enclave/`:

```text
cargo build --release --target wasm32-wasip1 -p fairground-sealer-job
cargo build --profile tools -p fairground-runner -p fairground-harness
cargo test --workspace -- --nocapture
FAIRGROUND_JOB_WASM=res/fairground_sealer.wasm cargo test -p fairground-harness --test perf -- --nocapture
```

The fast-search column above came from a copy of the sources with
`PRICE_SEARCH` in `crates/sealer/src/job.rs` set to `PriceSearch::Fast`,
built natively and passed to the perf test through `FAIRGROUND_JOB_WASM`.

On Windows the runner must be built with `panic = "abort"` (the `tools`
profile does that). wasmtime 28 leaves a fuel or time trap with a longjmp,
which on MSVC unwinds through Rust `extern "C"` frames, and a process built
with `panic = "unwind"` aborts there. For that reason the out-of-fuel test runs
the command-line runner rather than the in-process one. Linux, where
OutLayer's workers run, is not affected.
