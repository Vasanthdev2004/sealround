# Evidence

Files a reader can re-check without trusting us.

- `sales.json`: the live testnet sales that the scheduled `Live testnet`
  workflow re-verifies (`.github/workflows/live-testnet.yml`).
- `outlayer/`: proof bundles for every OutLayer run of those sales, checked
  with OutLayer's own open-source verifier, `outlayer-verify`. This file
  explains them.

## OutLayer runs: the Intel signature chain

Each Sealround sale uses the enclave twice: once at `create_sale` to make the
sale's sealing key, and once at `close_sale` to open the bids and clear the
sale. Our own checks (`pnpm --filter web verify-sale`, and the Verified panel
on the result page) test eight things per run but say "Not checked here: the
signature chain up to Intel". The bundles below close that gap.

All six runs passed, in the tool's words: `PROVEN  every check passed: this
input produced this output, inside genuine Intel TDX hardware, running code
approved on chain.`

| Sale (contract) | Run | Transaction | OutLayer task | Ran at (UTC) | Verdict | Bundle |
| --- | --- | --- | ---: | --- | --- | --- |
| `nosnipe-11140458` (`sealround.itzbeast.testnet`) | sale key | `D94S8AmXhyY2rNJ4aoMtEzEqG3DDwAqsCs3UknNpwuj4` | 102567 | 2026-11-14 04:59:55 | PROVEN | `outlayer/nosnipe-11140458/key-D94S8AmX.json` |
| `nosnipe-11140458` (`sealround.itzbeast.testnet`) | clearing | `8vjEzwQFzKjZvAXB36G6Ps2MDcyEKkrSAAPbjUFXkqrK` | 102710 | 2026-11-14 05:16:30 | PROVEN | `outlayer/nosnipe-11140458/clear-8vjEzwQF.json` |
| `nosnipe-11140429` (`sealround.itzbeast.testnet`) | sale key | `7srGSogu9337s5WiUzwYEza4djr2W5cAVZr8CfPVG6Ty` | 102309 | 2026-11-14 04:30:33 | PROVEN | `outlayer/nosnipe-11140429/key-7srGSogu.json` |
| `nosnipe-11140429` (`sealround.itzbeast.testnet`) | clearing | `9ZdpEuQp9z6CTQGueQY4JtvhLG9qPUDUiKbmaXgMDeiQ` | 102445 | 2026-11-14 04:47:57 | PROVEN | `outlayer/nosnipe-11140429/clear-9ZdpEuQp.json` |
| `smoke-11120830` (`fairground.itzbeast.testnet`) | sale key | `9VTgvUt8FhEPq2U22wFJDWv8hVf7g6q2wD8rY8qhZdem` | 71518 | 2026-11-12 08:31:39 | PROVEN | `outlayer/smoke-11120830/key-9VTgvUt8.json` |
| `smoke-11120830` (`fairground.itzbeast.testnet`) | clearing | `E7CEppqPTqGuT5E7eXEMTWaJGzjFrTDw4wDFmVinDVDS` | 71893 | 2026-11-12 08:48:30 | PROVEN | `outlayer/smoke-11120830/clear-E7CEppqP.json` |

Next to each bundle, the `.txt` file with the same name is the tool's full
report from the online run. `outlayer/manifest.json` lists every run with its
command, the values it checked, its verdicts and the sha256 of its bundle.

### What a bundle proves

Each bundle holds OutLayer's published record of the run (with the TDX
quote), the Intel collateral used, the request and response read from the
transaction, and the chain's answer on the measurements. From that file the
tool proves:

1. **Authenticity.** The TDX quote is genuine: its signature chain ends at
   Intel's SGX root CA, which is compiled into the tool (sha256
   `44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3`, the
   same as Intel's published copy). The tool ticks eight checks: TCB Info and
   QE Identity signed by Intel, PCK certificate chains to the root, QE report
   signed by that certificate, QE report covers the attestation key, QE
   report meets the QE Identity policy, enclave report signed by the
   attestation key, platform TCB matches TCB Info. Intel TCB status:
   `UpToDate` for all six. The collateral (FMSPC `b0c06f000000`, sha256
   `2e80992e…9140`, valid 2026-11-08 00:15:55 to 2026-12-08 00:15:19 UTC,
   which covers both the 12 Nov and the 14 Nov runs) was read from
   `worker.outlayer.testnet`'s contract state at block 276,791,207 on an
   archival node, and was byte-identical to the copy OutLayer's API served.
   The tool checks the quote as of the run's own time (the timestamp inside
   the commitment), not today's date.
2. **Identity.** The five measurements read from the verified quote (MRTD,
   RTMR0 to RTMR3) are approved by `is_measurements_approved` on
   `worker.outlayer.testnet`.
3. **Binding.** `report_data[0..32]` inside the signed quote equals the
   sha256 of the run's fields: task type and id, build target
   (`wasm32-wasip1`), wasm sha256 (`f8408a87…d8cb`, the sealer the contract
   pins), input hash, output hash, block height, caller, project
   (`itzbeast.testnet/fairground-sealer`), secrets reference, timestamp and
   attached payment. `report_data[32..64]` is zero, as the format requires.
4. **Input and output.** The request (from the `execution_requested` event in
   the transaction) and the response (the value `outlayer.testnet` returned in
   the same transaction) hash to the values inside that commitment. The
   request names the contract and the sale, for example
   `{"v":1,"op":"pubkey","contract":"fairground.itzbeast.testnet","sale_id":"smoke-11120830"}`;
   the clearing response carries the clearing price and every fill.

### What it does not prove

- **That the sale contract sent the request.** The record's caller is the
  account that signed the transaction (`itzbeast.testnet`), not the contract
  that called `request_execution`. The contract and sale named in the request
  are data inside the request. `verify-sale` checks the request's
  predecessor is the sale contract and that the attested wasm is the one the
  contract pins; `outlayer-verify` does neither. Run both.
- **The transaction hash itself.** It is not inside the signed commitment.
  The tool ties the run to the transaction by reading the request and the
  response out of that transaction and matching their hashes; the block
  height is inside the commitment.
- **What OutLayer's tool lists as out of scope**: that the approved worker
  measurements were built from published source, who controls the approved
  list on `worker.outlayer.testnet`, and that the program's logic is correct.
  The sealer's own build is reproducible (`enclave/README.md`); its logic is
  covered by the Rust and e2e tests, not by this check.
- **Identity, offline.** Offline, the tool recomputes Authenticity, Binding,
  Input and Output from the file, but Identity uses the chain's answer saved
  in the file at check time (`measurements_approved`). To check it again, run
  the online command below.

### Re-check the bundles offline

Install the tool at the commit we used (Rust 1.85 or newer and a C compiler;
40 to 80 s on our machine):

```sh
cargo install --git https://github.com/out-layer/outlayer-verify \
  --rev 90c27d9d4fc843194ddc6f8ebaafa4eb320c3bb6 --locked outlayer-verify
```

Then, with no network:

```sh
cd evidence/outlayer
for f in */*.json; do outlayer-verify bundle "$f" --offline --short; done
```

You should see six lines, one per bundle, for example
`PROVEN task 102710 (execute) dbe5956a41a2b771…cf190e5d`, and exit code 0.
Drop `--short` to see the full report: the record, the values read from the
signed quote, the collateral, and both values of every comparison. Exit codes:
0 proven, 1 a check failed, 2 incomplete, 3 usage error.

We ran this loop on Windows and on Linux (Debian 13 in Docker with
`--network none`, so nothing could be fetched): six `PROVEN`, exit 0 each.

### Re-check a run online, from the chain

```sh
outlayer-verify tx 8vjEzwQFzKjZvAXB36G6Ps2MDcyEKkrSAAPbjUFXkqrK \
  --network testnet --api https://testnet-api.outlayer.ai
```

This fetches the record again, reads the request and response from the
transaction on an archival node, reads the Intel collateral from
`worker.outlayer.testnet` at the block the record names, and asks the chain
whether the measurements are approved. Two things to know:

- `--api https://testnet-api.outlayer.ai` is required. The tool's built-in
  testnet address answers `HTTP 410 {"error":"api_moved","message":"This API
  address is retired. The OutLayer API is at https://testnet-api.outlayer.ai
  (same paths, same keys): update your base URL. ...`. The tool's own
  "reproduce" line leaves `--api` out for the same reason.
- If Identity comes back `UNPROVEN` with `could not read the approved list —
  NEAR RPC: https://rpc.testnet.fastnear.com/: status code 429`, FastNear is
  rate-limiting your IP. Pass `--rpc https://near-testnet.drpc.org` or
  `--rpc https://archival-rpc.testnet.fastnear.com`; both gave `PROVEN` for
  us.

### Changing a bundle breaks it

We edited copies of `nosnipe-11140458/clear-8vjEzwQF.json` and re-checked
each offline. Every change was caught (exit 1, `NOT PROVEN`) except the one
the tool takes on trust offline:

| Change in the copy | What the tool said |
| --- | --- |
| Clearing price in the response, `2000` to `1000` | Output `FAIL`: the output hashes to `b2915376…` but the attested value is `b6e3e851…` |
| One bidder's account name in the request | Input `FAIL` |
| One bit of the TDX quote | Authenticity `FAIL`: `QE report hash mismatch` |
| One character of the TCB Info signature in the collateral | Authenticity `FAIL`: `Signature is invalid for tcb_info in quote_collateral` |
| `output_hash` in the record | Binding `FAIL` and Output `FAIL` |
| `timestamp` in the record, plus one second | Binding `FAIL` |
| `measurements_approved` set to `false` | Identity `FAIL` (the saved chain answer is used as is, see above) |

### Tool version and build

- Repository: <https://github.com/out-layer/outlayer-verify>, owned by the
  `out-layer` GitHub organisation (OutLayer, site outlayer.ai, which also
  hosts the main `outlayer` repository). Licence MIT OR Apache-2.0.
- Commit `90c27d9d4fc843194ddc6f8ebaafa4eb320c3bb6` (2026-07-31), version
  0.1.0. No release binaries are published, so we built from source with
  `--locked`. The repository has no build script of its own; every
  dependency comes from crates.io. The tool's own tests pass (8 of 8).
- Built with Rust 1.97.1 on Windows (`cargo build --release --locked`, 77 s
  cold) and on Linux (`cargo install ... --locked` as above, 40 s cold on a
  20-core machine, with a C compiler for `ring`). Binary sha256 on Windows
  `2c1e3186…9af9`, on Linux `2226b85b…9e9b`; these are platform-specific and
  only say which binary we ran.
- Endpoints used for the bundles: API `https://testnet-api.outlayer.ai`, RPC
  `https://rpc.testnet.fastnear.com`, archival RPC
  `https://archival-rpc.testnet.fastnear.com`. Checked on 2026-11-14 at about
  06:00 UTC.

### What went wrong along the way

- The tool's default testnet API is retired (the `HTTP 410` above). Fixed
  with `--api`.
- One later confirmation run on Linux hit FastNear's rate limit on the
  approved-list read and reported `INCOMPLETE` (exit 2). Fixed with another
  RPC. The six bundles come from runs where every check, Identity included,
  passed.
- Nothing else failed. The transaction lookup works for our runs although the
  request comes from the sale contract inside `create_sale` and `close_sale`:
  OutLayer indexes the transaction that carried it. The collateral covers the
  12 Nov smoke sale.
