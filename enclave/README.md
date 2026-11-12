# Sealround enclave job: deployment runbook

This folder holds the OutLayer job ("the enclave job") that Sealround sales
call twice: once at `create_sale` for the sale's X25519 public key, and once at
`close_sale` to decrypt the sealed bids and clear the sale. The job is the WASI
program in `job/` around the library `crates/sealer` (`fairground-sealer`);
its input and output JSON are fixed in `contracts/DESIGN.md` ("Sealer",
"OutLayer call").

This runbook takes you from nothing to "a Sealround contract on testnet that
uses our enclave job", and the same on mainnet later. Every command below is
also printed, with your values filled in, by the scripts in `deploy/`.

- [How the pieces fit](#how-the-pieces-fit)
- [0. Prerequisites](#0-prerequisites)
- [1. Build](#1-build)
- [2. Publish the job](#2-publish-the-job)
- [3. Smoke-test the job on its own](#3-smoke-test-the-job-on-its-own)
- [4. Generate the master secret](#4-generate-the-master-secret)
- [5. Deploy the Sealround contract](#5-deploy-the-sealround-contract)
- [6. Smoke-test through the contract](#6-smoke-test-through-the-contract)
- [6b. Smoke-test a clear](#6b-smoke-test-a-clear)
- [7. Check an attestation](#7-check-an-attestation)
- [8. Upgrading the job later](#8-upgrading-the-job-later)
- [9. Mainnet](#9-mainnet)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Trust assumptions](#11-trust-assumptions)
- [12. What was verified, and how](#12-what-was-verified-and-how)

## How the pieces fit

```
create_sale / close_sale (anyone signs)
  -> Sealround contract   fairground.<you>.testnet
       request_execution(source = Project{"<you>.testnet/fairground-sealer", version_key = <sha256>},
                         secrets_ref = {profile "default", account_id "<you>.testnet"},
                         response_format "Text", input_data = the job request)
  -> OutLayer contract    outlayer.testnet / outlayer.near   (yield; the worker picks it up)
  -> OutLayer worker (TDX) downloads the version's wasm, checks its sha256,
       asks the keystore TEE for the secret row; the keystore checks the row's condition:
         And[ WasmHash{<sha256>}, Predecessor{ Whitelist[fairground.<you>.testnet] } ]
  -> our job (wasm32-wasip1): env PROTECTED_FAIRGROUND_MASTER, NEAR_PREDECESSOR_ID,
       NEAR_SENDER_ID, OUTLAYER_EXECUTION_TYPE=NEAR; stdin = input_data;
       stdout = one JSON answer, or a failed run with "fairground-sealer: refused: <code>" on stderr
  -> the answer comes back to the contract's callback as a JSON string (Text format);
     a failed run comes back as null
```

Four things pin this together, and each is set exactly once:

| What | Where it is set | Pinned by |
| --- | --- | --- |
| The job build (its wasm sha256) | `outlayer deploy` adds it as a project version named by its sha256 | the contract's `sealer_source.version_key` and `sealer_code_hash`; the secret's `WasmHash` leaf |
| The master secret | `outlayer secrets set --generate` makes it inside the keystore TEE | the row `(Project{<you>/fairground-sealer}, profile, owner <you>)` named by the contract's `sealer_secrets` |
| Who may read the master | the row's access condition | `Predecessor{Whitelist[<contract>]}` and `WasmHash{<sha256>}` |
| The contract's config | `new` at deploy | nothing can change it: no owner, no admin, no upgrade method |

The job also checks for itself that the run is an on-chain run
(`OUTLAYER_EXECUTION_TYPE` is `NEAR`) and that the request's `contract` is the
calling contract (`NEAR_PREDECESSOR_ID`), so even a run the keystore admits
can only derive keys for the contract that called it. It refuses anything but
a `pubkey` request that the contract account signed itself
(`NEAR_SENDER_ID` = `NEAR_PREDECESSOR_ID`; see section 11), and any request
that is not one JSON object with distinct keys. Those refusals, and a missing
or malformed master, fail the run (exit status 1) instead of answering, so
the contract sees `null` and retries later (section 10).

### What goes in and what comes out

`contracts/DESIGN.md` ("Sealer") fixes the formats. In short:

- **A sealed bid** is a libsodium sealed box of the canonical JSON
  ```
  {"sale_id":"<id>","bidder":"<account>","max_price":"<39 digits>","max_spend":"<39 digits>","salt":"<32 hex>"}
  ```
  Both amounts are left-padded with zeros to 39 digits (`u128::MAX` has 39),
  so the plaintext is `176 + len(sale_id) + len(bidder)` bytes and the box 48
  more: `224 + len(sale_id) + len(bidder)`, at most 320
  (`fairground_clearing::sealed_bid_len`). The length then says nothing about
  the amounts, and the contract refuses a TEE bid of any other length
  (`bid_rejected`, reason `wrong_ciphertext_length`).
  `crates/sealer/tests/fixtures/canonical_bids.json` holds the format row by
  row. The job still reads unpadded amounts; only the contract insists.
- **A `pubkey` answer**:
  ```
  {"v":1,"ok":true,"op":"pubkey","sale_id":"<id>","pubkey":"<64 hex>"}
  ```
- **A `clear` answer**, fields in this order:
  ```
  {"v":1,"ok":true,"op":"clear","sale_id":"<id>","bid_set_hash":"<64 hex>","pubkey":"<64 hex>",
   "clearing_price":"<price>","n_valid":<n>,"n_invalid":<n>,"invalid":[<index>, ...],
   "fills":[["<tokens>","<spent>"], ...]}
  ```
  `pubkey` is the sale key the bids were opened with; the contract compares
  it with the key the bids were sealed to, so a changed master cannot pass
  for "every bid is invalid". `invalid` lists the indices of the invalid
  bids, ascending; they pay the invalid-bid penalty. The contract reads a
  clear answer without either field as malformed. `fills` has one entry per
  bid in input order, `["0","0"]` for an invalid one. No bid's price or
  spend appears.
- **A refusal by `run`** (`crates/sealer/src/job.rs`):
  `{"v":1,"ok":false,"op":<op or null>,"sale_id":<id or null>,"error":"<code>"}`.
  Its codes: `invalid_json`, `duplicate_key`, `unsupported_version`,
  `unknown_op`, `unexpected_field`, `invalid_contract`,
  `predecessor_mismatch`, `invalid_sale_id`, `invalid_params`,
  `invalid_bid_set_hash`, `invalid_bids`, `invalid_ciphertext`,
  `bid_set_hash_mismatch`, `internal`, and the clearing crate's
  (`overflow`, ...). After any `"ok":false` answer the contract leaves the
  request to be retried (section 10).
- **A refusal by the job itself** fails the run: nothing on stdout, exit
  status 1, and `fairground-sealer: refused: <code>` on stderr. The codes, in
  the order they are checked (`job/src/main.rs`): `not_near_execution`,
  `missing_predecessor`, `missing_sender`, `input_unreadable`,
  `input_too_large` (over 4 MiB), `invalid_json`, `duplicate_key`,
  `signer_is_contract`, `missing_master`, `invalid_master`. Section 10 says
  what each means.

### The deploy scripts

| Script | Section |
| --- | --- |
| `deploy/1-publish-job.ps1` | [2](#2-publish-the-job) |
| `deploy/2-smoke-job.ps1` | [3](#3-smoke-test-the-job-on-its-own) |
| `deploy/3-master-secret.ps1` | [4](#4-generate-the-master-secret) |
| `deploy/4-deploy-contract.ps1` | [5](#5-deploy-the-sealround-contract) |
| `deploy/5-smoke-sale.ps1` | [6](#6-smoke-test-through-the-contract) |
| `deploy/7-smoke-clear.ps1` | [6b](#6b-smoke-test-a-clear) |
| `deploy/4-deploy-contract.ps1 -Lock` | [5](#5-deploy-the-sealround-contract), after 6b |
| `deploy/Verify-Attestation.ps1` | [7](#7-check-an-attestation) (read-only) |
| `deploy/6-upgrade-job.ps1` | [8](#8-upgrading-the-job-later) |

Each takes `-Network testnet|mainnet` (default testnet) and `-Account <you>`,
and **prints** its commands. Nothing is sent unless you add `-Execute`, and
then only after you type the network name. JSON arguments are rendered from
`deploy/templates/` into `deploy/out/<network>/` (git-ignored) and passed with
near CLI's `file-args`, because Windows PowerShell 5.1 strips the double
quotes from JSON passed inline to a native program. The files are UTF-8
without a byte order mark; a BOM makes near-sdk refuse the arguments.

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\1-publish-job.ps1 -Account alice.testnet
```

The examples below are run from the repository root and use these PowerShell
variables (bash: `ME=alice.testnet` and so on); replace `alice.testnet` with
your account. The scripts print the same commands with absolute paths.

```powershell
$ME  = 'alice.testnet'                 # you: owner of the OutLayer project and of the secret
$FG  = "fairground.$ME"                # the Sealround contract account
$SHA = (Get-FileHash enclave\res\fairground_sealer.wasm -Algorithm SHA256).Hash.ToLower()
$env:OUTLAYER_NETWORK = 'testnet'      # the outlayer CLI's network for every command
```

## 0. Prerequisites

Do not skip the versions: the commands were checked against these.

| Tool | Version checked | Install |
| --- | --- | --- |
| OutLayer CLI (`outlayer`) | 0.2.2 (tag v0.2.2 = commit `ebe90873`) | Windows: `outlayer-v0.2.2-x86_64-pc-windows-msvc.zip` from https://github.com/out-layer/outlayer-cli/releases, put `outlayer.exe` on PATH. Or `cargo install outlayer-cli --version 0.2.2 --locked` (Rust 1.86+). macOS/Linux: the `install.sh` in that repo (OutLayer docs/CLI.md:13-31). |
| near CLI (`near`, near-cli-rs) | 0.31.1 | Windows: the `.msi` or `near-cli-rs-installer.ps1` from https://github.com/near/near-cli-rs/releases; or `npx near-cli-rs`. |
| Docker | Docker Desktop (or Docker Engine) that runs `linux/amd64` images | **Required for the job build**: `scripts\build-enclave.ps1` builds in a pinned `rust:1.97.1-trixie` image, and only that build gives the sha256 everyone pins and can reproduce. Needs network access to Docker Hub, crates.io and static.rust-lang.org. |
| Rust | 1.97.1 with `wasm32-wasip1` (job) and `wasm32-unknown-unknown` (contracts) | `rustup`; `enclave/rust-toolchain.toml` pins the job's toolchain. Natively, only for the tests and `scripts\run-enclave.ps1`. |
| cargo-near | 0.23.0 | for `scripts\build-contracts.ps1` (contracts/DESIGN.md). |

**A funded account.** On testnet, create one with the faucet service built
into near CLI (it creates and funds the account, and saves the key in your OS
keychain):

```powershell
near account create-account sponsor-by-faucet-service alice.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account view-account-summary alice.testnet network-config testnet now
```

You need about **10 NEAR** on testnet: 6.5 for the contract account's storage
(its code is 548 KB because it embeds the per-sale token), about 1.73 for the
smoke sale, 0.3 attached (mostly refunded) for the project and the two secret
rows, and headroom, because a 300 TGas transaction must have 0.3 NEAR
available up front (gas is bought at 1e9 yoctoNEAR/gas and the unused part
refunded). If the faucet gave you less, top up from a testnet faucet before
section 5.

**Give the OutLayer CLI your key.** `outlayer login` asks for the account id
and the `ed25519:...` private key and stores both **in plain text** in
`~/.outlayer/<network>/credentials.json` (docs/CLI.md:72-74). Get the key from
near CLI:

```powershell
near account export-account alice.testnet using-private-key network-config testnet
outlayer login testnet
outlayer whoami
```

On a shared machine, run `outlayer logout` when you are done.

## 1. Build

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1           # Docker -> enclave\res\fairground_sealer.wasm (+ .sha256, build-info.json)
powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1 -Verify   # rebuild from nothing and compare with the committed .sha256: "verify: MATCH", exit 0
powershell -ExecutionPolicy Bypass -File scripts\build-contracts.ps1         # -> contracts\res\fairground.wasm
cd enclave; cargo test --locked -p fairground-sealer-job; cd ..               # the WASI program's native tests (from enclave\, so its rust-toolchain.toml applies)
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Test       # every enclave test, and the wasm tests again on enclave\res\fairground_sealer.wasm
```

**Only the Docker build gives the pinned hash.** A native
`cargo build --release --target wasm32-wasip1` embeds this machine's source
paths in the module (panic locations of dependencies), so its sha256 depends
on the user name, drive and checkout folder, and nobody can reproduce it.
Never upload or pin a native build. To check a hash someone else pinned (a
contract's `sealer_code_hash`), run
`scripts\build-enclave.ps1 -Verify -Expected <that sha256>` on the source
commit they published: it exits 0 only on a byte-for-byte match. Without
PowerShell, run the two `docker` commands at the top of
`enclave\build\build.sh` and read `out/fairground_sealer.wasm.sha256`.

`scripts\run-enclave.ps1 -Input <request.json> ...` runs a module the way
OutLayer's worker does (`enclave/tools/runner`, wasmtime 28 with fuel
metering) and prints its answer, instructions and time; by default it runs
`enclave\res\fairground_sealer.wasm`, `-Native` runs a native build of the
current sources. `enclave\PERF.md` has the measurements.

The job's sha256 **is** the job's identity from here on: OutLayer names the
version by it, the keystore admits only it, the contract pins it, and
attestations report it. Rebuilding with any change (code, dependency,
compiler, profile) gives a new hash, and a new hash means section 8. The
deploy scripts read `enclave\res\fairground_sealer.wasm` and refuse to go on if
its `.sha256` file disagrees with the bytes.

`enclave\res\fairground_sealer.wasm.sha256` is the source of truth for the
hash: every script and template takes it from there, and
`contracts/DESIGN.md` does not repeat it. This file and PERF.md record it
with a date, as what was measured and checked. The build of 10 Nov 2026
(276,156 bytes) is

```
f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb
```

It replaces `a4526703...` of 9 Nov 2026, which was never published: since
then bids are sealed padded, a clear's answer carries `pubkey` and `invalid`,
and the clearing price is found with a fixed-shape search (section 11).

The job is a WASI **Preview 1** module (`wasm32-wasip1`). That matters in the
next step.

## 2. Publish the job

`deploy\1-publish-job.ps1 -Account alice.testnet` prints these:

```powershell
outlayer upload enclave\res\fairground_sealer.wasm
outlayer deploy fairground-sealer "https://test.fastfs.io/$ME/outlayer.testnet/$SHA.wasm" --hash $SHA --target wasm32-wasip1
```

- `outlayer upload` writes the file to FastFS through NEAR transactions and
  prints `SHA256: ...` and `FastFS URL: https://test.fastfs.io/<you>/outlayer.testnet/<sha256>.wasm`
  (`main.fastfs.io` and `outlayer.near` on mainnet). Its transaction **fails
  on purpose** with "Exceeded the prepaid gas": gas is set to 1 and the FastFS
  indexer reads the arguments anyway (docs/CLI.md:362). Wait until the URL
  serves the file and check its hash before deploying:
  ```powershell
  Invoke-WebRequest -UseBasicParsing -Uri "https://test.fastfs.io/$ME/outlayer.testnet/$SHA.wasm" -OutFile job.wasm
  (Get-FileHash job.wasm -Algorithm SHA256).Hash.ToLower()    # must equal $SHA
  ```
  (The upload's own hint says `outlayer deploy <name> --wasm-url <url>`; the
  real syntax takes the URL as a positional argument, CLI src/main.rs:51-69.)
- `outlayer deploy` creates the project `<you>/fairground-sealer` with this
  version (`create_project`), or adds the version to an existing project and
  makes it active (`add_version`). It attaches 0.1 NEAR for storage and the
  contract refunds the rest (CLI src/commands/deploy.rs:47-83).
- **`--target wasm32-wasip1` is required.** The CLI defaults to `wasm32-wasip2`
  (CLI src/main.rs:62-64) and stores it in the version. The worker then runs
  only the P2 executor and does not fall back (OutLayer
  worker/src/executor/mod.rs:534-561), so every run of our P1 module would fail.
- `--hash $SHA` pins what you built; without it the CLI downloads the URL to
  hash it. The worker re-checks the bytes against the hash on every run.

Check what was stored:

```powershell
near contract call-function as-read-only outlayer.testnet get_version file-args enclave\deploy\out\testnet\get-version.json network-config testnet now
# {"project_id":"alice.testnet/fairground-sealer","version_key":"<sha256>"}  (the script writes this file)
```

The answer must show `"build_target":"wasm32-wasip1"` and `wasm_hash` equal
to `$SHA`. A version cannot be added twice under the same hash ("Version ...
already exists in project", OutLayer contract/src/projects.rs:187-192), so if
the target is wrong and no contract pins the project yet, delete the project
(`delete_project`, the script prints the exact command) and deploy again.

### How version pinning works

- A version **is** a wasm sha256: `version_key` = the `hash` of its WasmUrl
  source (OutLayer contract/src/projects.rs:729-735).
- The Sealround contract always sends `{"Project":{"project_id":...,"version_key":"<sha256>"}}`.
  Its config type cannot express `version_key: null` ("run whatever is
  active"), so the project owner switching the active version changes nothing
  for a deployed contract (contracts/fairground/src/config.rs). `new` also
  checks that `version_key == sealer_code_hash`.
- Later versions: build, then `1-publish-job.ps1` again. `outlayer deploy`
  makes the new version active (add `--no-activate` to keep the old one
  active; it does not matter to a pinned contract). An existing contract keeps
  running its pinned version; using the new one is section 8.
- **Never remove the pinned version or delete the project** while a contract
  pins it. OutLayer then refuses every request at the door ("Version not
  found" / "Project not found", contract/src/execution.rs:986-1005), sales
  cannot get keys or clear, and they end in refunds.

## 3. Smoke-test the job on its own

Before any contract exists, run the published job once from your own account,
exactly as the contract will call it. This uses a **separate** secret profile
`smoke`, so the production master (section 4) is never loosened.
`deploy\2-smoke-job.ps1 -Account alice.testnet` prints:

```powershell
# 1. a throwaway master, readable only by this build when called directly from your account
outlayer secrets set --generate PROTECTED_FAIRGROUND_MASTER:hex32 --project "$ME/fairground-sealer" --profile smoke --access allow-all --build $SHA --via $ME

# 2. the job: a pubkey request in which you are the "contract"
near contract call-function as-transaction outlayer.testnet request_execution file-args enclave\deploy\out\testnet\request-pubkey-smoke.json prepaid-gas '300 Tgas' attached-deposit '0.02 NEAR' sign-as $ME network-config testnet sign-with-keychain send
```

`request-pubkey-smoke.json` is the same request the contract builds
(contracts/fairground/src/outlayer.rs), with you as the caller:

```json
{
  "source": { "Project": { "project_id": "alice.testnet/fairground-sealer", "version_key": "<sha256>" } },
  "resource_limits": { "max_instructions": 50000000000, "max_execution_seconds": 60 },
  "input_data": "{\"v\":1,\"op\":\"pubkey\",\"contract\":\"alice.testnet\",\"sale_id\":\"smoke\"}",
  "secrets_ref": { "profile": "smoke", "account_id": "alice.testnet" },
  "response_format": "Text",
  "payer_account_id": null,
  "params": null
}
```

Expected, about 20 seconds later: near CLI prints the function's return value,
one JSON **string** (Text format) holding the job's answer:

```
"{\"v\":1,\"ok\":true,\"op\":\"pubkey\",\"sale_id\":\"smoke\",\"pubkey\":\"<64 hex>\"}"
```

- `null` means the run failed or was refused: by OutLayer, by the keystore,
  or by the job itself, whose own refusals (for example `missing_master`)
  fail the run. The reason is the `error_message` of OutLayer's
  `execution_completed` event in this transaction's logs; the job's reads
  `fairground-sealer: refused: <code>`. See [Troubleshooting](#10-troubleshooting).
- `"ok":false` with an `error` code means the job ran and refused the request
  itself (for example `predecessor_mismatch`).
- Here you sign the transaction and are also the predecessor. The job serves
  that only for a `pubkey` request; it would fail any other request signed by
  its own predecessor (`signer_is_contract`, section 11).
- OutLayer keeps about 0.001 NEAR plus 0.0001 NEAR per second of run time
  and refunds the rest of the 0.02 NEAR to you (live `get_pricing`).
- If near CLI says the transaction is not final yet, wait 30 seconds and run
  `near transaction view-status <tx hash> network-config testnet`.

Then check the attestation (section 7). Afterwards you may delete the smoke
row: `outlayer secrets delete --project "$ME/fairground-sealer" --profile smoke`.
That command has **no confirmation prompt** (CLI src/commands/secrets.rs:1419-1461).

> **`--profile` defaults to `default`, the production master.** Every
> `outlayer secrets` subcommand (`set`, `update`, `access`, `delete`) takes
> `--profile` with the default value `default` (outlayer-cli 0.2.2
> src/main.rs, `SecretsCommands`). A smoke-row command that loses its
> `--profile smoke` therefore acts on the production row: `delete` removes the
> master for good and every open sale's bids become unreadable; `set`
> generates a new master with the same effect. Copy the commands the scripts
> print (they always carry `--profile`); do not retype them.

## 4. Generate the master secret

`deploy\3-master-secret.ps1 -Account alice.testnet` prints one command:

```powershell
outlayer secrets set --generate PROTECTED_FAIRGROUND_MASTER:hex32 --project "$ME/fairground-sealer" --profile default --access allow-all --build $SHA --via $FG
```

- `--generate PROTECTED_FAIRGROUND_MASTER:hex32` makes 32 random bytes inside
  the keystore TEE. Nobody sees them, you included. The job reads them as the
  environment variable `PROTECTED_FAIRGROUND_MASTER` (64 hex characters).
- The resulting condition is exactly
  ```json
  {"Logic":{"operator":"And","conditions":[
    {"WasmHash":{"hash":"<sha256>"}},
    {"Predecessor":{"condition":{"Whitelist":{"accounts":["fairground.alice.testnet"]}}}}]}}
  ```
  How the CLI builds it (outlayer-cli 0.2.2 src/commands/secrets.rs):
  `--access allow-all` is the condition on the transaction **signer**, which
  must admit everyone because anyone may sign `close_sale`; `--build` turns
  AllowAll into the `WasmHash` leaf alone (`lock_to_build`, :220-235); `--via`
  then ANDs `Predecessor{Whitelist[...]}` on top, last of all
  (`with_callers`, :405-413, applied at :903). Without `--access`, a new
  project row admits only you as signer (:656-662), and every `close_sale`
  signed by someone else would be refused.
- The contract does not exist yet; that is fine. The keystore only compares
  the account name.
- `WasmHash` is judged against the hash the attested worker measured on the
  bytes it loaded, never a value from the request (OutLayer contract/src/types.rs,
  `WasmHash`; keystore-worker/src/api_support.rs:85-101).

Check it:

```powershell
near contract call-function as-read-only outlayer.testnet get_secrets file-args enclave\deploy\out\testnet\get-secrets-default.json network-config testnet now
# {"accessor":{"Project":{"project_id":"alice.testnet/fairground-sealer"}},"profile":"default","owner":"alice.testnet"}
```

The `access` field must be the condition above (the two parts may print in
either order).

**Fallback without the CLI's flags.** If your CLI version cannot express the
condition, store the secret with any condition and then set it with
`update_access`, which changes who may read and keeps the value (OutLayer
contract/src/secrets.rs:633-696):

```powershell
near contract call-function as-transaction outlayer.testnet update_access file-args enclave\deploy\out\testnet\update-access-default.json prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $ME network-config testnet sign-with-keychain send
```

```json
{
  "accessor": { "Project": { "project_id": "alice.testnet/fairground-sealer" } },
  "profile": "default",
  "new_access": { "Logic": { "operator": "And", "conditions": [
    { "WasmHash": { "hash": "<sha256>" } },
    { "Predecessor": { "condition": { "Whitelist": { "accounts": [ "fairground.alice.testnet" ] } } } } ] } }
}
```

`update_access` credits the deposit the row already holds and refunds the
excess of what you attach. The hash must be lowercase: the contract refuses
anything else ("a WasmHash condition must be the SHA-256 of the build as 64
lowercase hex characters").

**Optional negative check.** The script also prints a request that uses the
production profile from your own account. It must return `null`: the keystore
refuses, because the predecessor is you, not the contract.

**Never again on this profile:**

- `outlayer secrets set` on `--profile default` generates a **new** master.
  Every sale key changes, every open sale's bids become unreadable, and those
  sales end in refunds. With `-Execute` the script refuses if the row exists.
  To change who may read, use `outlayer secrets access` or `update_access`.
- `outlayer secrets delete --profile default` deletes the master for good,
  with no prompt. So does `outlayer secrets delete` with **no** `--profile`,
  because `default` is the CLI's default profile (section 3).

## 5. Deploy the Sealround contract

`deploy\4-deploy-contract.ps1 -Account alice.testnet` prints:

```powershell
near account create-account fund-myself $FG '6.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as $ME network-config testnet sign-with-keychain send
near contract deploy $FG use-file contracts\res\fairground.wasm with-init-call new file-args enclave\deploy\out\testnet\new-args.json prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
near contract call-function as-read-only $FG get_config file-args enclave\deploy\out\testnet\empty.json network-config testnet now
near account view-account-summary $FG network-config testnet now
```

- **Storage.** NEAR locks 1e19 yoctoNEAR per stored byte. The contract code
  embeds the per-sale token wasm (contracts/fairground/src/costs.rs,
  `TOKEN_WASM`), so `fairground.wasm` is large: 546,747 bytes on 12 Nov 2026
  (sha256 `bfc2f80059936d4344aafc136aacfed3b1ce37ace7814bfefde6e88cdc3ea800`),
  which is 5.48 NEAR for the code alone. The script reads the file on disk, prints its size and
  sha256, and computes the balance from it (code + 2 KB, plus 1 NEAR
  headroom: 6.5 NEAR for that file). Sale costs are paid by each sale's
  creator through `create_sale`'s deposit, not from this balance.
- **`new` is `#[private]`**: only the contract account may call it.
  `contract deploy ... with-init-call` deploys and initialises in one
  transaction signed by the contract account, so nobody can initialise it
  with their own sealer first.
- **Testnet `new` arguments** (`deploy/templates/new-args.testnet.json`):
  ```json
  {
    "outlayer": "outlayer.testnet",
    "sealer_source": { "Project": { "project_id": "alice.testnet/fairground-sealer", "version_key": "<sha256>" } },
    "sealer_code_hash": "<sha256>",
    "sealer_secrets": { "profile": "default", "account_id": "alice.testnet" },
    "allowed_quote_tokens": [
      "usdc.fakes.testnet",
      "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"
    ]
  }
  ```
- **Mainnet `new` arguments** (`deploy/templates/new-args.mainnet.json`):
  ```json
  {
    "outlayer": "outlayer.near",
    "sealer_source": { "Project": { "project_id": "<you>.near/fairground-sealer", "version_key": "<sha256>" } },
    "sealer_code_hash": "<sha256>",
    "sealer_secrets": { "profile": "default", "account_id": "<you>.near" },
    "allowed_quote_tokens": [ "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" ]
  }
  ```
  Names and types come from `Fairground::new` (contracts/fairground/src/lib.rs)
  and `Config::validate` (config.rs): `sealer_code_hash` is 64 lowercase hex
  and equals `version_key`; `project_id` contains `/`; the profile is 1-64
  letters, digits, `-` or `_`; quote tokens are non-empty and distinct.
  `sealer_secrets.account_id` is the **owner of the secret row** (you), not
  the contract.
- A failed `new` ("invalid config: ...") fails the whole transaction: nothing
  is left half-deployed. Fix the arguments and run the deploy again.
- `get_config` must echo the arguments; `view-account-summary` shows the code
  hash (the script prints the sha256 of your local `fairground.wasm` to compare).

> The rendered `new` and `create_sale` arguments were last run through the
> contract's own code on 10 Nov 2026 (section 12). If `contracts/` changes
> after that, re-check `new`'s argument names in
> `contracts/fairground/src/lib.rs` and the sale rules in `sale.rs` before a
> mainnet deploy; the scripts' templates are the place to change them.

**Required before anyone else bids, testnet demos included: lock the
contract.** `4-deploy-contract.ps1` creates the contract account with a
full-access key saved in your keychain. **Until that key is deleted, whoever
holds it can read every bid while bidding is open.** The contract account is
the predecessor the master secret admits, and the job believes the request it
is given (its `bid_set_hash` check binds the bids to the request, not to the
contract's state). So the key holder can have OutLayer "clear" made-up sales
around one real ciphertext and read its maximum price and spend from the
fills: about 128 runs at 0.001-0.002 NEAR each recover a price exactly. Two
ways, neither visible as a code change:

- **Direct call**: sign `request_execution` on OutLayer as the contract
  account. The keystore admits it (predecessor = contract, same build). The
  job now refuses this one (`signer_is_contract`: anything but a `pubkey`
  request signed by its own predecessor), but only as defence in depth.
- **New code**: deploy other code to the account that makes the calls, then
  call it from any account. That changes the account's code hash on chain,
  and nothing in the job can tell.

A meta-transaction (a delegate action the contract account signs, relayed by
another account) is refused like the direct call as long as OutLayer
recognises it, which its event monitor does for delegate actions addressed to
OutLayer itself; one it misses passes the job's check.

The keystore can refuse the direct call too, before the master is released:
OutLayer's conditions have `Not`, and a top-level `Whitelist` is judged on the
signer, so a third leaf
`{"Not":{"condition":{"Whitelist":{"accounts":["fairground.alice.testnet"]}}}}`
in the `And` of section 4 (set with `update_access`) admits every signer but
the contract account. It would also refuse the contract account's `pubkey`
requests, which nothing legitimate sends. `outlayer.testnet` accepts that
three-leaf condition (`estimate_storage_cost` view call, 9 Nov 2026:
0.0051 NEAR, against 0.00432 for the two leaves); the keystore's evaluation
of it was not exercised. The job's own check does not depend on it.

Delete the key after the smoke tests (sections 6 and 6b), which need no
contract key, and before you tell anyone the contract exists:

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Account $ME -Lock                       # prints the commands; add -Execute to list the keys
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Account $ME -Lock -PublicKey ed25519:... -Execute
# which runs:
near account list-keys $FG network-config testnet now
near account delete-keys $FG public-keys ed25519:<the key from the list> network-config testnet sign-with-keychain send
near account list-keys $FG network-config testnet now      # must list no keys
```

This cannot be undone. A locked contract can never be fixed or redeployed;
a new job build then means a new contract account (section 8), which is the
plan anyway. If you keep the key for a while, say so wherever you announce the
contract: "the deployer can read every bid".

## 6. Smoke-test through the contract

`deploy\5-smoke-sale.ps1 -Account alice.testnet` renders a throwaway TEE sale
(600 of 1000 SMOKE tokens, floor 0.002 USDC, deposits of 1 to 2 USDC, at most
2 bids, bidding opens in 5 minutes for 30 minutes) and prints:

```powershell
near contract call-function as-read-only $FG get_create_cost file-args enclave\deploy\out\testnet\create-sale.json network-config testnet now
near contract call-function as-transaction $FG create_sale file-args enclave\deploy\out\testnet\create-sale.json prepaid-gas '300 Tgas' attached-deposit '2 NEAR' sign-as $ME network-config testnet sign-with-keychain send
near contract call-function as-read-only $FG get_sale file-args enclave\deploy\out\testnet\sale-id.json network-config testnet now
```

- `get_create_cost` returned **1730850000000000000000000** (1.73085 NEAR) for
  this sale with `usdc.fakes.testnet`, as computed by the contract code of
  10 Nov 2026 (it changes with the token wasm size and the per-bid storage
  reserve, and is 0.0026 NEAR less once the contract is registered on that
  quote token). `create_sale` refunds anything above the cost in the same
  transaction. About 1.7 NEAR of it is the token account's own storage and
  stays there.
- The contract does not let a sale ask for less than 1 USDC per bid
  (`min_deposit` of at least 1000000), which is why the smoke sale takes
  1 to 2 USDC and its floor is 0.002 USDC: one 1 USDC bid then asks for
  500 of the 600 tokens (section 6b).
- `bid_start` must not be in the past when `create_sale` runs. The script
  writes times relative to now; run it again if you waited too long.
- About 30 seconds later, `get_sale` must show `"token_setup":"done"`,
  `"sealer_key_setup":"done"`, `"status":"upcoming"` (or `"open"`), a 64-hex
  `sealer_pubkey`, and `sealer_code_hash` equal to `$SHA`.
- Keep the `create_sale` transaction hash: the key request's attestation is
  filed under it (section 7).
- This proves the key path only. Closed without bids, the sale fails with
  `no_bids` and **nothing goes to OutLayer**: the clear is section 6b. (The
  script also prints `close_sale` and `claim_proceeds` for the no-bid case.)

## 6b. Smoke-test a clear

The clear is the step with the most moving parts, and section 6 never
reaches it: the input-storage deposit above 32 KB, `get_close_deposit`, the
5e10 instruction limit, OutLayer's two-step resolve for outputs over
1024 bytes, the Text parsing of the fills, and `result_sha256` against the
attestation's `output_hash`. `deploy\7-smoke-clear.ps1` runs it on the smoke
sale of section 6, in two phases. Build the bid sealer once (from
`enclave\`): `cargo build --profile tools -p fairground-runner -p fairground-harness`
(or `scripts\run-enclave.ps1 -Fixtures`).

**Phase Bid**, while the sale is `open` (it opens 5 minutes after
`create_sale` and stays open 30 minutes):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Account $ME -SaleId <sale id> -Phase Bid -GetTestUsdc
```

1. `get_sale`: status `open`, `sealer_pubkey` (64 hex), the deposit limits
   (smoke sale: 1000000 to 2000000 USDC base units, 1 to 2 USDC).
2. Seals `{"sale_id","bidder","max_price","max_spend","salt"}` to the sale's
   key with `enclave\target\tools\fairground-seal.exe` (16 random salt bytes)
   and writes the `ft_transfer_call` arguments
   `{"receiver_id":"<contract>","amount":"<deposit>","msg":"{\"sale_id\":..,\"ciphertext\":..}"}`
   to `deploy\out\<network>\bid-<sale>-<bidder>.json`. Defaults: deposit
   1000000 (1 USDC), max spend 1000000, max price 4000 (0.004 USDC per token).
   The tool seals the canonical padded plaintext ("What goes in and what
   comes out"), so the box is `224 + len(sale_id) + len(bidder)` bytes, 251
   for `smoke-11091200` and `alice.testnet`; the script checks that length
   before it writes the file, because the contract refuses any other. Print
   mode can do this step too with `-SealerPubkey <hex>`.
3. `-GetTestUsdc` (testnet, `usdc.fakes.testnet` only): `storage_deposit`
   for the bidder (0.00125 NEAR) and `mint {"account_id","amount"}`, which
   that token leaves open to anyone (its code exports `mint` and has no owner
   check; read from the deployed code, not run). Any other quote token: fund
   the bidder yourself.
4. `ft_transfer_call` on the quote token, `1 yoctoNEAR`, 100 TGas, signed by
   the bidder. **Expected**: return value `"1000000"` (the amount the sale
   kept) and `EVENT_JSON` `bid_placed`. `"0"` means the bid was refused and
   refunded; the `bid_rejected` event names the reason (`below_min_deposit`,
   `wrong_ciphertext_length`, ...).
5. `get_bids_summary`: `count` 1.

Run it again with `-Bidder <another account>` for a second bid.

**Phase Close**, after `bid_end`:

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Account $ME -SaleId <sale id> -Phase Close
```

1. `get_close_deposit`: **expected** `"14010000000000000000000"` (0.01401
   NEAR; plus 1e19 per input byte above 32 KB, none here).
2. `close_sale` with `-CloseDeposit` (default 0.02 NEAR; OutLayer refunds the
   unused part) and 300 TGas, signed by you (never by the contract account:
   the job refuses that, `signer_is_contract`). **Expected** after about
   20 s: return value `"settled"`; logs `sale_closed`, `clearing_requested`,
   OutLayer's `execution_completed` with `success: true`, and
   `sale_settled`. **Keep the transaction hash.** `"closed"` means the run
   failed or was refused (the `error_message` says why; run the phase again
   to retry); `"failed"` means the result failed the contract's checks.
3. `get_result`: **expected** with the defaults: `status` `"settled"`,
   `clearing_price` `"2000"` (the floor: 500 tokens asked, 600 for sale),
   `total_sold` `"500000000000000000000"`, `total_raised` `"1000000"`,
   `n_valid` 1, `n_invalid` 0, `total_penalties` `"0"`, `failed_checks`
   `[]`, and 64-hex `result_sha256` and `input_sha256`.
4. `get_fills`: one fill, 500 tokens, `spent` `"1000000"`, `refund` `"0"`,
   `penalty` `"0"`.
5. The attestation of the clear (section 7), on the `close_sale` hash:
   ```powershell
   powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network testnet -TxHash <close_sale tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId <sale id>
   ```
   `output_hash` must equal `result_sha256` and `input_hash` the
   `input_sha256`. The script prints the job's answer; with the defaults:
   ```
   {"v":1,"ok":true,"op":"clear","sale_id":"<sale id>","bid_set_hash":"<64 hex>","pubkey":"<the sale's sealer_pubkey>",
    "clearing_price":"2000","n_valid":1,"n_invalid":0,"invalid":[],"fills":[["500000000000000000000","1000000"]]}
   ```
6. `claim` (the bidder: 500 tokens and the unspent deposit) and
   `claim_proceeds` (you: 1 USDC, the reserve refund, and the 100 unsold
   tokens burned). Then lock the contract (section 5).

## 7. Check an attestation

Every run gets a TDX quote whose `report_data[0..32]` is a SHA-256 over the
task: build, input hash, output hash, block height, signer, project, secrets
reference, time (OutLayer worker/src/tdx_attestation.rs:173-217). Anyone can
fetch it, with CORS open to all origins:

```
GET https://testnet-api.outlayer.ai/attestations/by-tx/<transaction hash>     (mainnet: https://api.outlayer.ai)
GET https://testnet-api.outlayer.ai/attestations/by-request/<request id>
```

The transaction is the one the user signed: `create_sale` (pubkey) or
`close_sale` (clear). The record's `caller_account_id` is that signer, not the
contract.

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network testnet -TxHash <tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId <sale id>
```

It is read-only and checks:

| Check | Meaning |
| --- | --- |
| `wasm_hash`, `executed_wasm_sha256` | the attested and the measured build are the pinned `$SHA` |
| `input_hash` | sha256 of the `input_data` in the `request_execution` receipt |
| `output_hash` | sha256 of the exact bytes `on_execution_response` returned, which is what the contract's callback received |
| `task_hash`, `report_data_tail` | the quote's report data is the hash of the record's fields |
| `measurements` | the quote's MRTD and RTMR0-3 are approved by `worker.outlayer.testnet` (`is_measurements_approved`) |
| `request_source`, `request_caller` | the request named the pinned version and came from `$FG` |
| `sealer_pubkey` (pubkey and clear runs) | the `pubkey` in the job's answer (the sale's key; for a clear, the key the bids were opened with) equals `get_sale(...).sealer_pubkey` |
| `result_sha256`, `input_sha256` (clear runs) | equal `get_result(...)` (the contract keeps the last clear request's input hash) |

It does **not** check the quote's signature chain up to Intel; OutLayer's
dashboard verifier and its `outlayer-verify` tool do that. There is no nonce:
no attestation endpoint accepts one, so freshness rests on the block height
and timestamp in the record.

## 8. Upgrading the job later

The contract pins one build forever, and the secret admits one build from one
contract. A new build therefore takes three steps:

1. **Publish** the new build as a new version (`1-publish-job.ps1`).
2. **Move the secret's condition** to the new build and the new contract,
   keeping its value (`6-upgrade-job.ps1`). The master stays, so every
   existing sale keeps its key: a sale key is
   `HKDF(master, "sale-key" || 0 || contract || 0 || sale_id)`
   (crates/sealer/src/keys.rs). Sales of the new contract get different keys
   because the contract account differs.
3. **Deploy a new contract account** pinned to the new hash
   (`4-deploy-contract.ps1 -Contract fairground-v2.alice.testnet -Sha256 <new>`).
   The old contract cannot be repointed: it has no admin method, and its
   config is written once by `new`.

Two ways to do step 2:

- **Cutover** (default; use it when the old contract has no open sale):
  ```powershell
  outlayer secrets access --project "$ME/fairground-sealer" --profile default --build <new sha256> --via fairground-v2.alice.testnet
  ```
  The CLI swaps the `WasmHash` leaf and replaces the caller list, and keeps
  the value (CLI src/commands/secrets.rs:1235-1379). From then on the old
  contract's pinned build is refused the master: its open sales cannot clear
  and end in refunds after their settle timeout.
- **Transition** (`6-upgrade-job.ps1 -Transition`): both contracts keep
  working, each with its own build, through `update_access` with
  ```json
  {"Logic":{"operator":"And","conditions":[
    {"Logic":{"operator":"Or","conditions":[{"WasmHash":{"hash":"<old>"}},{"WasmHash":{"hash":"<new>"}}]}},
    {"Predecessor":{"condition":{"Whitelist":{"accounts":["fairground.alice.testnet","fairground-v2.alice.testnet"]}}}}]}}
  ```
  The CLI cannot write an Or of builds (it keeps a single lock), hence the
  direct call. Run the cutover once the old contract's sales are all final.

## 9. Mainnet

Run the same scripts with `-Network mainnet -Account <you>.near`.

| | testnet | mainnet |
| --- | --- | --- |
| OutLayer contract | `outlayer.testnet` | `outlayer.near` |
| OutLayer API | `https://testnet-api.outlayer.ai` | `https://api.outlayer.ai` |
| FastFS | `https://test.fastfs.io/<you>/outlayer.testnet/<sha256>.wasm` | `https://main.fastfs.io/<you>/outlayer.near/<sha256>.wasm` |
| Register contract (measurements) | `worker.outlayer.testnet` | `worker.outlayer.near` |
| Quote tokens | `usdc.fakes.testnet`, `3e2210e1...afcb8af` | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC) |
| `outlayer login` | `outlayer login testnet` | `outlayer login` |
| near CLI | `network-config testnet` | `network-config mainnet` |
| Funding | faucet | real NEAR, about 10 |

Pricing was identical on both networks on 9 Nov 2026 (`get_pricing`: base
0.001 NEAR, 1e14 yoctoNEAR per million instructions, 0.0001 NEAR per second).

Before mainnet, in addition to everything above:

- Build the job with `scripts\build-enclave.ps1` (Docker; only that build
  gives the hash to pin) from a clean checkout and publish the source commit
  next to the sha256, so anyone can rebuild it and compare. Check it the way
  they will:
  `powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1 -Verify -Expected <the sha256 you pin>`
  must print `verify: MATCH` and exit 0. Build the contract reproducibly too.
- Consider a **dedicated owner account** for the OutLayer project and the
  secret (section 11: whoever holds it can change who reads the master).
- **Lock the contract account** (section 5) before the sale is announced.
- Run the smoke tests (sections 3, 6 and 6b) on mainnet with small amounts,
  and check the attestation of each.

## 10. Troubleshooting

What the contract's callback can receive, and what it means
(contracts/fairground/src/outlayer.rs, `read_outcome`):

| Callback sees | Meaning | Contract does |
| --- | --- | --- |
| a JSON string with `"ok":true` | the job answered | stores the key / checks and settles |
| a JSON string with `"ok":false`, whatever its `op`, `sale_id` or `v` | `run` refused the request (its `error` code, below) | key: `sealer_key_setup` failed, the log names `sealer_error: <code>`; clear: sale `closed`, event `clearing_failed` with reason `sealer_error: <code>`; retry |
| the bytes `null`, or an empty string | the run failed: the job refused it (`fairground-sealer: refused: <code>`, below), it trapped or ran out of fuel, the worker or keystore refused it, or it timed out (200 blocks, about 117 s) | same as above |
| `Err` | `request_execution` panicked at the door; the deposit came back | refunds the payer, then as above |
| anything else: not the sealer's JSON, an `"ok":true` answer with another `v`, a clear answer that lacks a field (`pubkey` and `invalid` included) | a broken job or a forged result | key: failed, retry; clear: the sale **fails** (`output_well_formed`) and everyone is refunded |

The job's own refusals (missing secret row, HTTPS run, bad input) fail the
run rather than answer. They are about the run, and most come before the
request is understood, so an answer could not name its `op` or `sale_id`; a
failed run is what every version of the contract reads as "not now". `run`
can still answer `"ok":false` with `"op":null` for a request that is not a
request at all (no `op`, `{}`); the contract never sends one. The contract
of 10 Nov 2026 retries after any `"ok":false` answer, with or without `op`
and `sale_id` (contracts/fairground/src/settle.rs `on_clearing_result`,
setup.rs `on_sealer_key`); the one before it read such an answer as
malformed and failed the sale.

Retry paths: a failed key request is retried with `retry_setup(sale_id)`
(anyone; attach 0.01401 NEAR). A failed clear leaves the sale `closed`;
`close_sale(sale_id)` again with at least `get_close_deposit(sale_id)`. The
settle timeout always ends a stuck sale in refunds (`trigger_refund_mode`).

**Finding the reason for a `null`.** OutLayer does not pass the error to the
callback. It logs it in its `execution_completed` event (`success`,
`error_message`, `payment_charged`), which `on_execution_response` emits
(OutLayer contract/src/execution.rs:666, :738), so it sits in the logs of
**your own** transaction (`create_sale`, `close_sale` or the direct request):

```powershell
near transaction view-status <tx hash> network-config testnet    # look for EVENT_JSON ... "execution_completed"
```

`Verify-Attestation.ps1` prints the same event for a run that has an
attestation; a run refused before it started may have none (the
`by-tx` lookup then fails). Common causes:

| Symptom / error text | Cause | Fix |
| --- | --- | --- |
| "Not a valid WASI Preview 2 component" | version stored with `build_target` `wasm32-wasip2` (OutLayer worker/src/executor/wasi_p2.rs:388) | section 2: deploy with `--target wasm32-wasip1` |
| "Access denied by access condition: this secret is locked to build X and the running build is Y" | the run's build is not the row's `WasmHash` | the contract pins Y but the row admits X: move the lock (section 8) or fix the contract's pin |
| "Access denied by access condition" (other) | the keystore refused the row (OutLayer keystore-worker/src/types.rs:811-828) | check the row with `get_secrets`: the caller must be in `Predecessor{Whitelist}` (the contract, not you), `WasmHash` must be the pinned sha256, and the contract's `sealer_secrets` must name the row's owner and profile |
| `fairground-sealer: refused: missing_master` | the run got no `PROTECTED_FAIRGROUND_MASTER`. A row that does not exist is not an error for the worker: it runs the job without secrets (OutLayer worker/src/main.rs:2884-2904) | the contract's `sealer_secrets` names a row that does not exist (wrong owner or profile), or the row has no such key: section 4. Sales stay `closed` meanwhile; retry once fixed |
| `fairground-sealer: refused: invalid_master` | the variable is not 64 hex digits | a row someone wrote by hand; generate it as in section 4 |
| `fairground-sealer: refused: not_near_execution` | the run came over HTTPS, not from a transaction | the job only serves on-chain runs; use `request_execution` |
| `fairground-sealer: refused: missing_predecessor` / `missing_sender` | the worker gave no `NEAR_PREDECESSOR_ID` / `NEAR_SENDER_ID` | should not happen in a `NEAR` run; report it to OutLayer |
| `fairground-sealer: refused: signer_is_contract` | the transaction was signed by the calling contract account itself, and the request is not `pubkey` | expected: only the contract's users sign its transactions. Close the sale from another account; if you did not send it, someone holds the contract key: lock it (section 5) |
| `fairground-sealer: refused: invalid_json` / `duplicate_key` / `input_too_large` / `input_unreadable` | the input is not one JSON object with distinct keys, or over 4 MiB | the contract never sends such input: a contract bug or a hand-made request. (`run` refuses repeated keys too, with `"ok":false,"op":null,"sale_id":null,"error":"duplicate_key"`; the job refuses first, with the same code, so that answer never leaves it) |
| `fairground-sealer: internal error` | the job panicked | a bug; report it with the request |
| `"ok":false,"error":"predecessor_mismatch"` | the request's `contract` is not the calling account | expected for any caller but the contract itself |
| `"ok":false,"error":"bid_set_hash_mismatch"` | the bids sent are not the set the contract froze | a contract bug; report it |
| execution time over the limit / out of fuel | `resource_limits` too small | the contract asks for 5e10 instructions and 60 s (costs.rs); measure larger sales |
| nothing for about 2 minutes, then `null` | yield timeout (200 blocks) | OutLayer busy or workers down: check `https://testnet-api.outlayer.ai/health` and `/public/workers`, then retry |
| nothing for about 2 minutes, then `null`, every time, and the request never shows in `https://testnet-api.outlayer.ai/public/jobs?user_account_id=<sender>` | the request has no `resource_limits.max_memory_mb`: OutLayer's testnet scheduler never picks such a request up (seen 12 Nov 2026; seven requests without it timed out, every one with 128 ran) | the contract sends `max_memory_mb` 128 (`SEALER_MAX_MEMORY_MB`, costs.rs) and so does `templates/request-pubkey.json`; a hand-made request must too |

**`Err` (refused at the door).** The panic text is in the failed
`request_execution` receipt:

| Panic | Fix |
| --- | --- |
| "Insufficient payment: required N yoctoNEAR (... for compute, ... held for ... bytes of input_data beyond the free 32768), got M" | attach more. For `close_sale`, attach `get_close_deposit(sale_id)` or more; the whole attachment is forwarded and the unused part refunded |
| "Project not found" / "Version not found" | the pinned project or version was deleted (section 2) |
| "secrets_ref.profile must be ..." | bad profile name in the contract's config (cannot happen after `new`'s validation) |
| "Requested max_... exceeds hard limit" | limits above 5e11 instructions / 180 s / 4096 MB |
| "Contract is paused" | OutLayer's owner paused it; wait |

**Pricing changes.** OutLayer's owner can change prices at any time
(`set_pricing`, OutLayer contract/src/admin.rs:63). Check them with
`near contract call-function as-read-only outlayer.testnet get_pricing json-args '{}' network-config testnet now`
(answer: base fee, per million instructions, per ms, per compile ms, in
yoctoNEAR; `["1000000000000000000000","100000000000000","100000000000000000","100000000000000000"]`
on 9 Nov 2026). The
contract's key-request deposit is a constant, twice the 9 Nov 2026 estimate
(`OUTLAYER_COMPUTE_DEPOSIT` = 0.01401 NEAR, costs.rs). If prices more than
double, every key request is refused, and `retry_setup` forwards only that
constant, so TEE sales cannot be set up until a contract with new constants
is deployed. `close_sale` is not affected: it forwards the whole attachment.

**Other errors.**

| Error | Fix |
| --- | --- |
| FastFS URL returns 404 | the indexer has not picked up the upload yet; wait and retry |
| `outlayer upload` transaction "Exceeded the prepaid gas" | expected (section 2) |
| near-sdk "Failed to deserialize input from JSON. Error: ..." | JSON passed inline from PowerShell 5.1 lost its double quotes, or the file starts with a BOM: use the scripts' `file-args` files |
| "Insufficient deposit for this condition" (update_access) | attach more; the excess is refunded |
| "... is locked to build ... and --access would replace that condition" | the CLI protects the build lock: pass `--build` too, or use `outlayer secrets access --build` |
| "... is judged on the calling account ... Pass --direct and/or --via" | the CLI protects the Predecessor rule: pass `--via <contract>` |
| `create_sale`: "attached deposit X yoctoNEAR is below the required Y" | attach `get_create_cost` or more |
| `create_sale`: "invalid bid_start: must not be in the past" | regenerate the arguments (`5-smoke-sale.ps1`) and send within a few minutes |
| `create_sale`: "invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account" | a sale may not ask for less than 1 USDC per bid; the smoke template asks for 1 to 2 USDC |
| `ft_transfer_call` returns `"0"`, `bid_rejected` with reason `wrong_ciphertext_length` | the box is not `224 + len(sale_id) + len(bidder)` bytes, the bidder being the account that sends the transfer: it was sealed without padding (an app or tool older than 10 Nov 2026), or for ids of another length. Seal it again with the current app or `fairground-seal` |
| `ft_transfer_call` returns `"0"`, `bid_rejected` with reason `below_min_deposit` / `above_max_deposit` | the amount is outside the sale's limits (`get_sale`); the smoke sale takes 1000000 to 2000000 |
| `create_sale` / `close_sale`: "not enough gas: attach at least N TGas" | raise `prepaid-gas` (max 300 TGas for most wallets) |
| near CLI: "Transaction sent, but it is not final yet" | a yield is pending; wait and use `near transaction view-status <hash> network-config testnet` |

## 11. Trust assumptions

Bid privacy and correct clearing rest on the following. None of it is hidden;
most of it is OutLayer's own documentation.

**OutLayer (as of 9 Nov 2026, "Governance at this stage", OutLayer
docs/NON_CUSTODIAL.md:349-367):**

- `dao.outlayer.near` holds a full-access key that passes the keystore's
  `request_key` check, so its holder **can obtain the shared master secret
  outside any enclave**. Rows stored without `--vault-id` (ours) are encrypted
  under that shared master (OutLayer contract/src/secrets.rs, `store_secrets`
  docs), so as we read it, that key holder could decrypt
  `PROTECTED_FAIRGROUND_MASTER`, derive every sale key and read every bid.
  Every such use of the key is a public NEAR transaction. OutLayer's
  per-customer vaults (`--vault-id`, OutLayer VAULTS.md) derive the master
  through your own vault contract instead; that option was not evaluated for
  Sealround.
- **One account approves enclave measurements**; the DAO has one member.
- The OutLayer contract, the DAO contract and the register contract are
  **upgraded by key**, without a vote or delay.
- **Any key on `worker.outlayer.*` is the operator** (OutLayer
  register-contract/README.md:20-31). A full-access key there can resolve any
  request with any output, and reaches what a registered TEE worker reaches.
  The contract cannot tell; only the attestation check (section 7) can, after
  the fact.
- The coordinator (task queue, API) is closed source (OutLayer API.md:128).
  Generated `PROTECTED_` values never pass through it in plaintext;
  user-supplied secrets do.
- **The `Predecessor` and `WasmHash` leaves protect against other accounts,
  not against OutLayer's coordinator or operator.** The executing worker takes
  the run's predecessor, its HTTPS-or-NEAR flag and its `input_data` from the
  task the coordinator hands it (OutLayer worker/src/main.rs:720-764,
  :2446-2450); we found no re-read of the pending request on chain in that
  path (events are checked when tasks are created, event_monitor.rs:2068-2090).
  If that holds, a compromised coordinator could give an honest TEE worker a
  forged NEAR task (predecessor = the Sealround contract, a crafted `clear`
  input); the keystore would release the master and the job would act as the
  decryption oracle of section 5. Not verified: the coordinator is closed
  source. The job cannot check this itself (a WASI P1 job has no network).
  Open question for OutLayer: does the executing worker re-verify
  `get_request(request_id)` (input_data, sender, predecessor) before it asks
  the keystore for secrets?
- Liveness depends on OutLayer's workers. If they stop, sales cannot clear and
  end in refunds after their settle timeout.

**Public data:** `input_data` is a function-call argument, so it is public on
chain; inputs of 10,000 bytes or more also stay readable in OutLayer's state
through `get_request` (OutLayer contract/src/lib.rs:98). That is fine: bids
are sealed boxes, and the job's output holds only what is public anyway
(clearing price, totals, one fill per bid). What leaks besides:

- **Ciphertext length, while bidding is open: closed on 10 Nov 2026.** A
  sealed box is exactly 48 bytes longer than its plaintext, and its length
  is public (in `ft_on_transfer`'s `msg` and `get_bids`). While amounts were
  sealed as plain decimal strings and the contract took any length up to
  512, the length gave `digits(max_price) + digits(max_spend)`, and with the
  public deposit (usually = max spend) the order of magnitude of the max
  price, before the sale closed. Now `seal_bid` pads both amounts to 39
  digits, every plaintext is `176 + len(sale_id) + len(bidder)` bytes, and
  the contract refuses a TEE bid whose box is not 48 bytes more than that
  (`wrong_ciphertext_length`). So a bid sealed the old way is refused and
  refunded instead of leaking. The web app has to seal the same padded form
  (`crates/sealer/tests/fixtures/canonical_bids.json` is the fixture to
  check it against); an app that does not cannot bid. The job still reads
  unpadded amounts (tested: `padded_bids_clear_like_unpadded_ones`), which
  no longer reach it through the contract.
- **Instruction counts, after the clear: the top price no longer shows.**
  OutLayer publishes every run's `resources_used.instructions`. The fast
  price search took about log2(highest valid max price - floor) steps with a
  demand sum that stopped early, so a clear's count told the magnitude of
  the highest max price, which the uniform price hides. The job now clears
  with the clearing crate's fixed-shape search: 128 halvings over
  `[floor, u128::MAX]`, each computing every valid bid's demand
  (crates/clearing/src/clear.rs, `PriceSearch::FixedShape`). Same results,
  about 1 % more instructions (+30.4 M at 500 bids). Measured on the
  deployed module: two 500-bid books whose 25 top bids ask 1e4 and 1e30
  differ by 130 instructions in 3.13e9, against 2.09 M with the fast search
  (`the_top_max_price_does_not_change_the_instruction_count`, PERF.md). The
  contract's own `clear_onchain` keeps the fast search: commit-reveal prices
  are public by then. What the count still reflects: the number of bids, how
  many are valid, the input's size, and small data-dependent costs (u128
  division, which rule an invalid bid breaks, the allocation at the margin).
  None of that tells the top max price. Reading the master does not leak
  either: the job decodes it with the same instructions for every valid
  master (2,113,911 for a `pubkey` request whatever the digits).
- **Repeated keys.** The job refuses a request in which any object repeats a
  key (`duplicate_key`), so nobody checking the public `input_data` with a
  first-wins parser can read it differently from the job (serde_json keeps
  the last). `run` has the same check, for callers other than the job. Only
  the contract writes `input_data`, and it writes none.

**Our own keys:**

- **The secret row's owner** (`<you>`) can change the row's condition at any
  time (`update_access`), for example to admit a build that prints the
  master. Bidders therefore trust that account. On mainnet, consider a
  dedicated account for the project and the secret, and decide whether to
  delete its full-access key after setup: that freezes the condition, and also
  makes upgrades impossible.
- **The project owner** (same account) can remove the pinned version, delete
  the project, delete the secret or generate a new master. Each of these stops
  sales from clearing (they end in refunds), but cannot reveal bids.
- **The Sealround contract account's full-access key**, while it exists,
  lets its holder read every bid during bidding (section 5). The contract
  account is the whitelisted predecessor, and the job checks the bids against
  the `bid_set_hash` in the same request, so the request alone decides what
  is decrypted: one real ciphertext in self-made `clear` requests (an
  undersubscribed supply, the floor at the midpoint of a search) gives its max
  price in about 128 runs, and a floor of 1 gives its max spend. The holder can
  sign `request_execution` as the contract (no code change, the code hash
  stays the same: the job now refuses this, `signer_is_contract`), relay the
  same call as a meta-transaction OutLayer fails to recognise, or deploy other
  code there (visible as a new code hash); new code could also move the funds
  the contract holds. **Delete the key before anyone else bids**, on testnet
  too (section 5).
- The job itself never prints the master or a plaintext bid, refuses HTTPS
  runs and requests its own predecessor signed (but `pubkey`), and derives
  keys only for the contract that called it.

**Attestation:** the quote binds the result to an approved build and to the
input and output hashes; there is no verifier nonce, and the record's
`caller_account_id` is the signer, not the contract.

## 12. What was verified, and how

First on 9 Nov 2026; the items marked 10 Nov 2026 were done again for the
build `f8408a87...` and the contract source of that day. **No transaction was
signed and nothing was deployed** while writing this runbook.

- **CLI commands and flags**: read in the OutLayer CLI source at tag v0.2.2
  (= commit `ebe90873`, the release binaries): `src/main.rs` (arguments),
  `src/commands/{deploy,upload,run,versions,secrets}.rs`. The condition the
  `secrets set ... --access allow-all --build --via` line produces was traced
  through `lock_to_build`, `apply_caller_flags` and `with_callers`.
- **OutLayer contract and worker**: OutLayer repository commit `3079d756`
  (8 Nov 2026), whose `contract/res/local/outlayer_contract.wasm` has the same
  code hash as `outlayer.testnet` and `outlayer.near`.
- **near CLI grammar**: near-cli-rs v0.31.1 `docs/GUIDE.en.md` and source
  (`contract deploy ... with-init-call`, `file-args`, `create-account fund-myself`,
  `sponsor-by-faucet-service`, `delete-keys`, `transaction view-status`, the
  "not final yet" retry path).
- **JSON shapes against the live contracts (view calls only)**: the rendered
  `update_access` conditions (single and transition) through
  `estimate_storage_cost` on `outlayer.testnet` (and the single one on
  `outlayer.near`); an upper-case hash was refused as expected. The
  `request_execution` limits through `estimate_execution_cost` (0.007005
  NEAR). `get_secrets` / `get_version` / `get_project` argument files.
  `ft_metadata` and `storage_balance_bounds` of all three USDC ids.
- **Contract arguments against the contract's code**: a throwaway crate
  deserialised the rendered `new-args.json` and `create-sale.json` (testnet
  and mainnet) into `Fairground::new`'s argument types and `CreateSaleParams`
  (which refuses unknown fields), ran `new` (config validation),
  `get_create_cost` and `create_sale` in near-sdk's unit-test environment,
  and printed the `request_execution` the contract built; the direct smoke
  request (section 3) has the same shape. Again on 10 Nov 2026, with the
  new hash and the smoke sale's new amounts: `new` and `create_sale` accept
  them, and `get_create_cost` is the figure of section 6.
- **`Verify-Attestation.ps1`**: against a real testnet attestation and
  transaction (request 14806): the recomputed task hash equals the quote's
  report data; a wrong pinned hash fails. Online code path against a local
  mock server, including a synthetic Sealround pubkey run and clear run;
  the measurement offsets were confirmed on the live register contract
  (`is_measurements_approved` returned `true` for request 14806's quote).
  Again on 10 Nov 2026 against the mock, with a clear answer in today's
  format: the new `sealer_pubkey` check of a clear passes when the answer
  names the sale's key and fails when it names another; an `"ok":false`
  answer is reported without it.
- **Scripts**: every script run in print mode on Windows PowerShell 5.1 for
  testnet and mainnet (again on 10 Nov 2026, each exit 0); generated files
  checked to be BOM-free valid JSON. `7-smoke-clear.ps1` and
  `4-deploy-contract.ps1 -Lock` in print mode too; the transfer arguments it
  wrote parse, and their `msg` holds a 251-byte box for sale
  `smoke-11091200` and bidder `alice.testnet` (224 + 14 + 13).
- **The job's refusals and signer check**: the worker's environment
  (`merge_env_vars`, OutLayer worker/src/main.rs) sets `NEAR_SENDER_ID` in
  every `NEAR` run; for a delegate action addressed to OutLayer it is the
  delegate's signer, not the relayer (`DelegatedCalls`, event_monitor.rs).
  A non-zero exit with stderr becomes the run's `error_message`
  (executor/wasi_p1.rs) and the contract gets `null` (sandbox tests of the
  contract workflow). Tested: the job's unit and process tests, and the wasm
  tests under `enclave/tools/runner` on both the native build and
  `enclave\res\fairground_sealer.wasm` (`scripts\run-enclave.ps1 -Test`).
- **The 6b numbers** (10 Nov 2026): `7-smoke-clear.ps1` in print mode sealed
  the default bid with `fairground-seal` to the key the deployed module
  (`f8408a87...`) derives under a TEST master. Run under the runner on the
  smoke sale's parameters and that one bid, the module answered
  `"clearing_price":"2000","n_valid":1,"n_invalid":0,"invalid":[],"fills":[["500000000000000000000","1000000"]]`
  with that key as `pubkey`, byte for byte what the native `run` gives, in
  8,457,847 instructions.
- **The build** (10 Nov 2026): `scripts\build-enclave.ps1 -Verify` printed
  `verify: MATCH` for `f8408a87...`; `scripts\run-enclave.ps1 -Test` passed
  on the native build and on `enclave\res\fairground_sealer.wasm`; PERF.md
  has the measurements.
- **`usdc.fakes.testnet`**: its exported methods (`mint`, `storage_deposit`,
  ...) and `mint`'s arguments (`account_id`, `amount`) read from its deployed
  code with a `view_code` RPC call; `storage_balance_bounds` 0.00125 NEAR.

Not verified, because it needs signed transactions: the commands' actual
effects on testnet (6b's clear included), whether `usdc.fakes.testnet`'s
`mint` really admits any caller, the FastFS indexing delay, the faucet's
amount, and the keystore actually enforcing `Predecessor` and `WasmHash` (the
negative check in section 4 tests the last one on your deployment).
