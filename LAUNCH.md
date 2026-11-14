# Sealround launch runbook

From this repository to a testnet deployment, a hosted relayer and web app,
and the capped mainnet pilot. The owner runs every command. Agents do not
deploy, sign or touch a public network (`AGENTS.md`).

- Commands are PowerShell, run from the repository root.
- Every deploy script prints its plan first. Read it, then run the same line
  with `-Execute`; the script then asks you to type the network name before it
  sends anything.
- Deadline: submit by Sat 14 Nov 2026 18:00 UTC. The hosted demo must stay up
  through 18 Nov (ideally 25 Nov).
- Background for every step: `enclave/README.md` (sections are cited as
  "README 5" and so on), `contracts/DESIGN.md`, `contracts/GAS.md`,
  `apps/relayer/README.md`, `apps/web/README.md`.

Contents: [placeholders](#placeholders) ·
[1 prerequisites](#1-prerequisites) · [2 testnet deploy](#2-testnet-deploy) ·
[3 relayer on Fly.io](#3-relayer-on-flyio) · [4 web on Vercel](#4-web-on-vercel) ·
[5 testnet end to end and pilot dry run](#5-testnet-end-to-end-and-pilot-dry-run) ·
[6 mainnet pilot](#6-mainnet-pilot) · [7 if something breaks](#7-if-something-breaks) ·
[8 pre-submission checklist](#8-pre-submission-checklist)

## Placeholders

| Placeholder | What it is | Example |
| --- | --- | --- |
| `<owner>` | your account name without `.testnet` / `.near`. Keep it short: each sale's token lives at `<sale id>.sealround.<owner>.testnet`, at most 64 characters | `alice` |
| `<relayer>.testnet` | a separate testnet account that only relays | `sealround-relayer-alice.testnet` |
| `<bidder>` | a testnet account in a browser wallet that signs delegates (HOT, Meteor or Intear) | `alice-bids.testnet` |
| `<relayer-app-testnet>`, `<relayer-app-mainnet>` | Fly.io app names (globally unique) | `sealround-relayer-testnet` |
| `<web-demo>`, `<web-testnet>`, `<web-pilot>` | Vercel project names; each serves at `https://<name>.vercel.app` | `sealround`, `sealround-testnet`, `sealround-pilot` |
| `<sale id>` | the smoke sale's id, printed by `5-smoke-sale.ps1` | `smoke-11111530` |
| `<evidence sale id>` | the evidence sale's id, printed by `8-evidence-sale.ps1 -Phase Create` and kept in `enclave\deploy\out\testnet\evidence-sale.json` | `nosnipe-11131200` |
| `<tx hash>` | a transaction hash from near CLI's output | |
| `<rpc-url>` | a mainnet JSON-RPC URL from a provider (the public `rpc.mainnet.near.org` is deprecated and rate limited; FastNear's public `rpc.mainnet.fastnear.com` is also rate limited) | |
| `<pilot start>` | the announced pilot start, UTC, at least a day ahead | `2026-11-13T12:00:00Z` |

Session variables. Set them in every new PowerShell window (switch to the
mainnet values in part 6):

```powershell
$NET = 'testnet'                      # mainnet: 'mainnet'
$ME  = '<owner>.testnet'              # mainnet: '<owner>.near'
$FG  = "sealround.$ME"                # the contract account (T5); mainnet: "fairground.$ME" (part 6)
$SHA = (Get-FileHash enclave\res\fairground_sealer.wasm -Algorithm SHA256).Hash.ToLower()
$env:OUTLAYER_NETWORK = $NET
$out = Join-Path $PWD "enclave\deploy\out\$NET"
```

The testnet contract is `sealround.<owner>.testnet`. The `/deploy` page (T5)
and `8-evidence-sale.ps1` default to that name, and the hosted relayer and web
app (parts 3 and 4) point at it. Scripts 3 to 7 default to
`fairground.<owner>`, so every line below passes `-Contract $FG`. The master
secret must name the same account (T4, or T4b when the account changes).

Suggested timeline (from the spec's plan):

| When (UTC) | What |
| --- | --- |
| Wed 11 Nov | Testnet deploy (part 2), relayer and web hosted (parts 3 and 4), testnet end to end (part 5) |
| Thu 12 Nov | Pilot dry run on testnet with the timeout refund (part 5). Mainnet deploy, smoke tests, lock, pilot sale created and announced (part 6) |
| Fri 13 Nov | Pilot window of 2 to 6 hours, close, claims, numbers recorded. Feature freeze 18:00 |
| Sat 14 Nov | Checklist (part 8), submit by 18:00 |

## 1. Prerequisites

### Tools

| Tool | Version | Check | Needed for |
| --- | --- | --- | --- |
| near CLI (near-cli-rs) | 0.31.1 | `near --version` | every chain command (the scripts call `near`) |
| OutLayer CLI | 0.2.2 | `outlayer --version` | publishing the job, the master secret |
| Docker Desktop | Linux containers (amd64) | `docker version` | the relayer image; `scripts\build-enclave.ps1 -Verify` |
| Rust | 1.97.1 | `cargo --version` | the bid seal tool `enclave\target\tools\fairground-seal.exe` (already built on this machine; rebuild with `cd enclave; cargo build --profile tools -p fairground-runner -p fairground-harness; cd ..`) |
| cargo-near | 0.23.0 | `cargo near --version` | only to rebuild contracts; the deploy uses the committed `contracts\res\fairground.wasm` |
| Node | 24 (24.19.0 checked) | `node --version` | local checks |
| pnpm | 12.3.4 | `pnpm --version` | local checks |
| flyctl | current | `fly version` | relayer hosting (Fly asks for a payment method) |
| Vercel account | | | web hosting, from the dashboard |

Install links for near CLI and the OutLayer CLI: README 0.

### The builds you deploy

```powershell
(Get-FileHash contracts\res\fairground.wasm -Algorithm SHA256).Hash.ToLower()
# e93c42759bd63edfba428cf16f043bdad1ae2f3a54d45ca8f9f41e74fe65a941   (616,196 bytes, 12 Nov 2026)
$SHA
# f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb   (276,156 bytes, 10 Nov 2026)
```

A different value means someone rebuilt the file. The scripts deploy what is
on disk, so that is fine, but `NEXT_PUBLIC_SEALER_CODE_HASH` (part 4) must
equal `$SHA`, and `AGENTS.md` should list both hashes. Before mainnet, also
run `powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1 -Verify`:
it rebuilds the job in Docker and must print `verify: MATCH`.

### Accounts and funding

"About" marks an estimate, derived from the scripts, README 0 and 5 and
`contracts/GAS.md`. `near account view-account-summary <account> network-config <network> now`
shows the real balance.

| Account | Network | Role | Fund | Why that amount |
| --- | --- | --- | --- | --- |
| `<owner>.testnet` | testnet | owner of the OutLayer project `<owner>.testnet/fairground-sealer` and of its secret row; parent of the contract and of the evidence bidders; creates and closes test sales | about 20 NEAR | 7.2 for the contract account, about 1.73 for the smoke sale, about 3.3 for the evidence sale (1.5 for its six bidder accounts, about 1.8 for `create_sale` with 8 bid slots and a pool; the script attaches 3 and the excess comes back), about 2.2 per pilot-shaped dry run (two), 0.3 attached to OutLayer (mostly refunded), and headroom: a 300 TGas call needs 0.3 NEAR free up front |
| `sealround.<owner>.testnet` | testnet | the sale contract; created by step T5 | 7.2 NEAR, sent by the owner | the `/deploy` page and the script: (wasm bytes + 2,000) x 1e19 yoctoNEAR plus 1 NEAR, rounded up to 0.1 |
| `sniper`, `ana`, `ravi`, `mei`, `copy`, `late` `.<owner>.testnet` | testnet | the evidence sale's bidders; created by step T7b | 0.25 NEAR each, sent by the owner, and 10 test USDC each | each signs its own bid and claim and pays the gas |
| `<relayer>.testnet` | testnet | pays gas for bids, claims, refund mode and launch pool steps, and new bidders' USDC registration | about 6 NEAR | `/health` reports `ok` from 5 NEAR, `low` below that, `empty` (503) below 0.5 |
| `<bidder>` | testnet | you, bidding in the browser | whatever the wallet or faucet gives; test USDC comes from the app | |
| `<owner>.near` | mainnet | the same roles as on testnet | about 13 NEAR and 2 USDC (native USDC on NEAR) | 7.2 contract, 1.73 smoke sale, about 2.2 pilot sale (50 bid slots; `get_create_cost` gives the exact figure), 0.3 OutLayer, headroom. 1 USDC for the smoke bid |
| `fairground.<owner>.near` | mainnet | the sale contract | 7.2 NEAR, sent by the owner | as on testnet |
| `relayer.<owner>.near` | mainnet | relayer | about 3 NEAR | each relay in flight holds about 0.15 NEAR until its gas refund; a bid relay costs about 0.001 NEAR (`apps/relayer/README.md`, "Security notes") |
| prize payout account | mainnet | hackathon payout | any mainnet account you control; `<owner>.near` works | spec, "Rules for every entry" |

No separate OutLayer account is needed: the owner account owns the OutLayer
project and the secret. On mainnet, consider a dedicated owner account
(README 9 and 11).

Create the testnet accounts with near CLI's faucet service. It funds them and
saves their keys in your OS keychain:

```powershell
near account create-account sponsor-by-faucet-service <owner>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service <relayer>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account view-account-summary <owner>.testnet network-config testnet now
```

If the owner holds less than about 20 NEAR, create one more faucet account
and send from it:
`near tokens <spare>.testnet send-near <owner>.testnet '9 NEAR' network-config testnet sign-with-keychain send`.
Create `<bidder>` inside the browser wallet you will test with.

### Secrets and where they live

| Secret | Lives in | Never in |
| --- | --- | --- |
| account keys | near CLI's keychain (your OS) | the repo |
| the contract account's key from `/deploy` (T5) | the key file you downloaded, and that browser tab's session storage, until T8 deletes the key | the repo, chat, screenshots |
| the evidence bidders' keys | `~/.near-credentials/testnet/<bidder>.<owner>.testnet.json` (near CLI's legacy keychain, plain text; the bot reads them there) | the repo |
| OutLayer CLI login | `~/.outlayer/<network>/credentials.json`, plain text. Run `outlayer logout` on a shared machine | the repo |
| relayer key | Fly secrets only | `fly.toml`, the image, any `NEXT_PUBLIC_` variable |
| 1Click API key (`ONECLICK_JWT`) | Vercel environment variables, server side only | any `NEXT_PUBLIC_` variable |

Get the 1Click key at partners.near-intents.org (spec, "Cross-chain funding
and settlement"). Without it the quotes still work, with higher fees.

`enclave/deploy/out/<network>/` receives the JSON arguments the scripts
render: account ids, hashes and sealed bids, no keys. T7b also writes
`evidence-sale.json`, the sniper's log and the evidence Markdown there. It is
git-ignored
(`enclave/deploy/.gitignore`). It still holds example files for
`alice.testnet` and `alice.near`; the scripts overwrite what they use.

## 2. Testnet deploy

Every script below: run it once without `-Execute`, read the plan, then run
it with `-Execute`. On failure, fix the cause and run the same line again.

### T1. Log the OutLayer CLI in

```powershell
near account export-account $ME using-private-key network-config $NET   # prints ed25519:...
outlayer login $NET                                                      # paste the account id and that key
outlayer whoami
```

Success: `outlayer whoami` names `<owner>.testnet` on testnet.

### T2. Publish the enclave job (README 2)

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\1-publish-job.ps1 -Network $NET -Account $ME -SkipLogin -Execute
```

- Does: uploads `enclave\res\fairground_sealer.wasm` to FastFS, checks the
  served bytes, creates the OutLayer project `<owner>.testnet/fairground-sealer`
  with version `$SHA`, reads it back.
- Success: `FastFS serves the expected bytes (<$SHA>)`, then `get_version`
  shows `wasm_hash` equal to `$SHA` and `"build_target":"wasm32-wasip1"`. The
  upload transaction fails with "Exceeded the prepaid gas" on purpose.
- If it fails: a FastFS 404 is retried 20 times, 15 s apart; if it still
  fails, run the line again later. A version stored as `wasm32-wasip2` must be
  deleted with the `delete_project` command the script prints; then run T2
  again.

### T3. Smoke-test the job on its own (README 3)

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\2-smoke-job.ps1 -Network $NET -Account $ME -Execute
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $NET -TxHash <tx hash> -Signer $ME -ExpectedWasmSha256 $SHA
```

- Does: makes a throwaway master under the profile `smoke` and runs one key
  request from your own account; then checks that run's TDX attestation
  (read only).
- Success: the return value is
  `"{\"v\":1,\"ok\":true,\"op\":\"pubkey\",\"sale_id\":\"smoke\",\"pubkey\":\"<64 hex>\"}"`,
  and the attestation check ends with `All checks passed.`
- If it fails: a `null` return means the run failed. Run
  `near transaction view-status <tx hash> network-config $NET`, find the
  `execution_completed` event, and look its `error_message` up in README 10.
  "Not final yet": wait 30 s and run that `view-status`.
- Leave the `smoke` row in place. Deleting it saves little, and the delete
  command without `--profile smoke` deletes the production master with no
  prompt.

### T4. Generate the master secret (README 4). Once per network

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\3-master-secret.ps1 -Network $NET -Account $ME -Contract $FG -Execute
```

- Does: generates `PROTECTED_FAIRGROUND_MASTER` inside OutLayer's keystore
  TEE. Only build `$SHA`, called from `$FG`, can read it. Nobody sees it.
- Success: `Secrets stored (profile: default, protected (TEE): PROTECTED_FAIRGROUND_MASTER)`,
  and `get_secrets` shows `WasmHash` = `$SHA` and `Predecessor` whitelist
  `[$FG]`.
- If it fails: "already exists" means the master is there; do not generate it
  again. If the CLI cannot express the condition, use the `update_access`
  fallback the script prints.
- Never run `outlayer secrets set` or `outlayer secrets delete` on the
  `default` profile again: a new master breaks every open sale, and a delete
  is final.

### T4b. Point the master secret at a new contract account

When: the contract account changes but the job build does not, as in the
move from `fairground.<owner>.testnet` to `sealround.<owner>.testnet`. Skip it
when T4 already named `$FG`. A new build goes through `6-upgrade-job.ps1`
instead (it refuses a build with the same sha256).

Print the plan; do not add `-Execute` (it refuses, because the row exists):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\3-master-secret.ps1 -Network $NET -Account $ME -Contract $FG
```

It renders `enclave\deploy\out\testnet\update-access-default.json`, the T4
condition with `$FG` as the only caller, and prints the `update_access` line
under "Fallback". Run that line; it is this one:

```powershell
near contract call-function as-transaction outlayer.testnet update_access file-args "$out\update-access-default.json" prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $ME network-config testnet sign-with-keychain send
near contract call-function as-read-only outlayer.testnet get_secrets file-args "$out\get-secrets-default.json" network-config testnet now
```

- Does: replaces the row's access condition and keeps its value, so the
  master stays the same. From then on only build `$SHA` called from `$FG`
  can read it. The deposit the row already holds is credited; the excess of
  the 0.01 NEAR comes back.
- Success: the call logs `Access control updated: ...`, and `get_secrets`
  shows `WasmHash` `$SHA` and the `Predecessor` whitelist `[$FG]` (the two
  conditions may print in either order). The `/deploy` page's step 3 runs
  the same check.
- The old contract account is no longer admitted: a sale of it that is still
  open can no longer clear and ends in refunds after its settle timeout. Run
  T4b only when the old contract has no open sale.

### T5. Deploy the contract (README 5)

From the browser, with no testnet wallet. Start the dev server and open
`http://localhost:3000/deploy` (dev server only; a production build answers
404):

```powershell
pnpm dev
```

1. **Your owner account**: type `$ME`.
2. **Settings and build**: the contract account defaults to
   `sealround.<owner>.testnet` (`$FG`); leave the project
   (`fairground-sealer`), sealer build (`$SHA`) and secret profile
   (`default`) as they are. Press **Load from the repo**: the page reads
   `contracts\res\fairground.wasm`, checks its sha256 against the pinned
   `e93c4275...a941` (616,196 bytes) and computes the funding, 7.2 NEAR.
   **The new arguments** shows what `new` will get (below).
3. **Run the checks**: OutLayer has version `$SHA` (T2), the secret row names
   `$SHA` and `$FG` (T4 or T4b), `$FG` does not exist yet, and `$ME` holds
   7.2 NEAR plus 0.5 for gas.
4. **Create `$FG`**: make the key, press **Download the key file** and
   tick "I saved the key file". The file is the only copy of `$FG`'s key, and
   T8 needs it; it has the same fields as a near CLI credentials file. Run
   the line the page prints, which near CLI signs as `$ME`:

   ```powershell
   near account create-account fund-myself $FG '7.2 NEAR' use-manually-provided-public-key ed25519:<the page's key> sign-as $ME network-config testnet sign-with-keychain send
   ```

   Then press **I ran it, check the account**. A wallet with testnet
   support (Meteor, Intear, Nightly) connected in step 1 can sign it instead.
5. **Deploy and call new**: the tab signs the wasm and `new` in one
   transaction with `$FG`'s own key (100 TGas, paid from its 7.2 NEAR), so
   nobody can call `new` first.
6. **Check what was deployed**: code hash, `get_config` and storage.

Steps 7 and 8 of the page are T6 and T7 (the smoke tests) and T8 (the lock).

- `new` arguments (`newArgs` in `apps/web/src/components/deploy/chain.ts`,
  the same as `enclave\deploy\templates\new-args.testnet.json`):

  ```json
  {
    "outlayer": "outlayer.testnet",
    "sealer_source": { "Project": { "project_id": "<owner>.testnet/fairground-sealer", "version_key": "<$SHA>" } },
    "sealer_code_hash": "<$SHA>",
    "sealer_secrets": { "profile": "default", "account_id": "<owner>.testnet" },
    "allowed_quote_tokens": [ "usdc.fakes.testnet", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af" ],
    "dex": "ref-finance-101.testnet"
  }
  ```

  `dex` is the Rhea exchange that launch pools are seeded on; `null` turns
  launch liquidity off. Mainnet uses `outlayer.near`, only
  `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC)
  and `"dex": "v2.ref-finance.near"`. The contract has no owner, no admin and
  no upgrade method; this config never changes.
- Success: every row of the page's step 6 passes, and
  `near account view-account-summary $FG network-config testnet now` shows
  `Contract (SHA-256 checksum hex): e93c4275...a941`.
- If it fails: `invalid config: ...` names the rule; nothing is half
  deployed. Step 3 "The master secret names this build and this contract"
  fails: run T4b. Step 3 says `$FG` already holds a contract: pick another
  name and run T4b for it. The tab was closed after step 4: **Import the key
  file** in step 4 and go on.
- Without the browser (and on mainnet, where `/deploy` does not work), the
  script does the same and keeps `$FG`'s key in near CLI's keychain:
  `powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Network $NET -Account $ME -Contract $FG -Execute`.
  If the account was created but the deploy failed, running `-Execute`
  again stops at the account creation: run the printed
  `near contract deploy ...` line by hand instead.

### T6. Smoke sale: the key path (README 6)

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\5-smoke-sale.ps1 -Network $NET -Account $ME -Contract $FG -StartInMinutes 3 -DurationMinutes 10 -Execute
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $NET -TxHash <create_sale tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId <sale id>
```

- Does: creates a throwaway TEE sale (bids open in 3 minutes for 10 minutes,
  1 to 2 USDC per bid). The contract deploys the sale token and asks the
  enclave for the sale's public key.
- Success: `get_sale` shows `"token_setup":"done"`,
  `"sealer_key_setup":"done"`, a 64-hex `sealer_pubkey` and
  `sealer_code_hash` equal to `$SHA`; the attestation check passes. Note the
  sale id and the `create_sale` transaction hash.
- The same check without the transaction hash, on any OS with Node:
  `pnpm --filter web verify-sale --network testnet --contract $FG --sale <sale id>`
  finds the transaction from the block the contract recorded and checks the
  sale key run (the clearing run follows after T7).
- If it fails: "bid_start: must not be in the past": run the line again (the
  times are relative to now). `sealer_key_setup` `"failed"`: README 10, then
  `retry_setup` (part 7).

### T7. Smoke clear (README 6b)

The evidence sale (T7b) closes and clears the same way with six bidders.
This step needs one 1 USDC bid and finds a clear problem before the bidder
accounts are made.

Once the sale is open (3 minutes after T6):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $NET -Account $ME -Contract $FG -SaleId <sale id> -Phase Bid -GetTestUsdc -Execute
```

Success: the transfer returns `"1000000"` and logs `bid_placed`;
`get_bids_summary` shows `count` 1. `"0"` means the bid was refunded, and
`bid_rejected` says why (`wrong_ciphertext_length`: rebuild the seal tool).

After `bid_end` (10 minutes later):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $NET -Account $ME -Contract $FG -SaleId <sale id> -Phase Close -Execute
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $NET -TxHash <close_sale tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId <sale id>
```

- Does: closes the sale; OutLayer runs the job, which opens the bid and
  clears; the contract checks the answer and settles.
- Success: `close_sale` returns `"settled"`. `get_result`: `status`
  `"settled"`, `clearing_price` `"2000"`, `total_raised` `"1000000"`,
  `failed_checks` `[]`. `get_fills`: 500 tokens, `spent` `"1000000"`. The
  attestation check passes (`result_sha256` and `input_sha256` included).
- Then run the `claim` and `claim_proceeds` lines the script prints, with
  `sign-as $ME` in both.
- If it fails: `"closed"` means the run failed or was refused; read
  `error_message` (README 10) and run `-Phase Close` again. `"failed"` means
  the answer failed the contract's checks; `get_result` names them. Do not
  lock (T8) until this step passes.

### T7b. Evidence sale (README section 7)

One sale on `$FG` that shows the whole story with links: a sniper bot bids
as the window opens, four people bid, a copycat replays a sealed bid, a late
bidder bids in the last two minutes; the enclave clears it at one price, a
Rhea pool opens at exactly that price, and everyone claims.
`enclave\deploy\8-evidence-sale.ps1` runs it in five phases (its header has
the numbers). Every phase except Report prints its plan without `-Execute`;
with `-Execute` it asks you to type `testnet` once, then runs the whole
phase, waits included. It signs as `$ME` and as the bidder accounts. Testnet
only. `-Contract` defaults to `sealround.<owner>.testnet`; it is passed below
so it always matches `$FG`.

The sale: 20,000 NOSNIPE in all, 10,000 for sale at a floor of 0.001 USDC,
2,000 reserved for the pool and 8,000 for the creator; 1 to 10 USDC per
bidder, 8 bid slots, 20 % of the raise to the pool at a 0.3 % fee. The
script's header works out the expected result: a clearing price of 0.002
USDC, 2,500 tokens each for sniper, ana, ravi and late, mei refunded, copy
voided with the 1 % penalty, and a pool of 4 USDC and 2,000 NOSNIPE.

1. **Accounts**, once, any time before Create:

   ```powershell
   powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Contract $FG -Phase Accounts -Execute
   ```

   Creates `sniper`, `ana`, `ravi`, `mei`, `copy` and `late` as
   sub-accounts of `$ME` with 0.25 NEAR each (keys in
   `~/.near-credentials/testnet/`, where the bot reads them), registers each
   on `usdc.fakes.testnet` and mints it 10 USDC. Success: the last check
   prints `key file ok, 10 USDC` for all six. Your home folder's path must
   have no space (the sniper is started with the key file path as an
   argument).

2. **Create**:

   ```powershell
   powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Contract $FG -Phase Create -Execute
   ```

   Checks that the 3 NEAR it attaches covers `get_create_cost` and that
   `get_config` has a `dex`, creates the sale `nosnipe-<MMddHHmm>` (UTC; or
   `-SaleId`), waits up to 3 minutes for the token and the sale key, and
   saves the sale to `enclave\deploy\out\testnet\evidence-sale.json` for the
   later phases. Bidding opens 6 minutes after the command starts and lasts
   10 (`-StartInMinutes` 3 to 120, `-DurationMinutes` 6 to 240). Success:
   `Sale <evidence sale id> is ready`, then `Bidding: <start> to <end>`. Keep
   the `create_sale` transaction hash.

3. **Bid**, straight away, before the open time Create printed:

   ```powershell
   powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Contract $FG -Phase Bid -Execute
   ```

   Starts the sniper in the background (`live-bot snipe`; log in
   `enclave\deploy\out\testnet\evidence-sniper-<evidence sale id>.log`). It
   seals its bid early and sends it in the first block at or after
   `bid_start`, so it can land at second 0 only if this phase starts before
   the open. Then the phase waits until 30 s after the open; ana, ravi and
   mei bid; copy replays ravi's sealed bytes; the phase waits for the last
   two minutes; late bids; and it prints the sniper's log (transaction hash,
   bid index, the second it landed). It refuses to start less than 150 s
   before the end. Type `testnet` at its prompt before the open, and keep
   the PowerShell window open until the phase ends, about two minutes before
   the close. Success: each bid logs `bid_placed`; copy's bid is accepted (its
   account id has ravi's length) and voided later by the enclave.

4. **Close**, after the bid window (it waits for `bid_end` itself, so you can
   start it as soon as Bid finishes):

   ```powershell
   powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Contract $FG -Phase Close -Execute
   ```

   Closes the sale (0.02 NEAR attached, the rest refunded), reads the result,
   calls `seed_liquidity` at 300 TGas, checks that the pool is `seeded`, then
   claims for each of the six bidders (`live-bot report --claim`, which also
   checks each fill against the clearing price) and calls `claim_proceeds`
   for the creator (the raise less the pool's USDC, the creator's 8,000
   tokens and the unspent NEAR reserve; unsold tokens burn). Success:
   `close_sale` returns `"settled"`; `status settled, clearing price 0.002`,
   `raised 20 USDC` and nothing after `failed checks:`;
   `Liquidity: seeded, pool <id> on ref-finance-101.testnet`. Keep the
   `close_sale`, `seed_liquidity` and claim transaction hashes.
   - `close_sale` returned `"closed"` (the run failed or was refused): run
     the phase again; it closes again.
   - The sale settled but the pool is not `seeded`: do not run the phase
     again, because `close_sale` refuses a settled sale and the run stops
     there. Run the phase without `-Execute` to print its lines, and run the
     `seed_liquidity` line until `get_result` shows `seeded` (or press
     **Seed the pool** in the result page's pool panel), then the claim lines and
     `claim_proceeds`.

5. **Check it**, read-only, any time after Close:

   ```powershell
   pnpm --filter web verify-sale --network testnet --contract $FG --sale <evidence sale id>
   ```

   Finds the `create_sale` and `close_sale` transactions, fetches OutLayer's
   TDX attestation for each run, checks the eight run checks for each, and
   recomputes the frozen bid set. Success: `Every check passed.` (exit code
   0). Keep the output for README section 7.

6. **Report**, read-only, after T8 so its "no access keys" line is true (it
   can run again at any time):

   ```powershell
   powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Contract $FG -Phase Report -AppUrl https://<web-testnet>.vercel.app
   ```

   Prints the evidence as Markdown for README section 7 and saves it to
   `enclave\deploy\out\testnet\evidence-<evidence sale id>.md` (git-ignored,
   so copy it into the README): the contract and token links, the bidding
   window, the clearing price, raise and valid bids, each bidder's time after
   the open, tokens, spend, refund and penalty, the pool and its reserves and
   price now, and the `verify-sale` line. Leave out `-AppUrl` while the
   testnet web app is not hosted.

### T8. Lock the contract. Irreversible

When: after the evidence sale (T7b) has closed, its pool is seeded and its
claims are done, and before anyone else learns the contract or the testnet
web URL. Until the contract account's full-access key is deleted, whoever
holds it can read every sealed bid (README 5, `contracts/DESIGN.md`
"Deployment invariants"). After it, nobody can redeploy or fix `$FG`. The
lock comes after T7b because the evidence sale is the first pool on the real
Rhea exchange: a problem found there needs a fresh account (below), not a
locked one. Every bidder in it is your own account, so no one else's bid was
readable while the key existed. The lock transaction's time is public.

From `/deploy` (T5): step 8 of the page, with the key file imported if the
tab was closed. It refuses unless `$FG` has exactly that one key, asks you to
type `$FG`, deletes the key and checks that no keys are left. Keep the lock
transaction hash from the page's Transactions panel.

If you deployed with `4-deploy-contract.ps1`, near CLI holds the key:

```powershell
near account list-keys $FG network-config $NET now      # one full-access key, the one near CLI made in T5
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Network $NET -Account $ME -Contract $FG -Lock -PublicKey ed25519:<that key> -Execute
```

(`-Lock` without `-PublicKey` and `-Execute` only prints these steps.)

Record the result either way, for README section 7 and the checklist in
part 8:

```powershell
near account list-keys $FG network-config $NET now
```

- Success: `list-keys` shows no keys. Save its output and the lock
  transaction hash with the evidence; then run T7b's Report.
- If T5 to T7b showed a problem in the contract itself, do not lock this
  account. Deploy a fresh one (for example `sealround2.$ME`): set `$FG` to
  it, point the secret at it with T4b, deploy it with T5 (type the new name
  in step 2 of `/deploy`), and run T6 to T7b on it. The hosted relayer
  (`FAIRGROUND_CONTRACT` in `apps/relayer/fly.testnet.toml`) and web app
  (`NEXT_PUBLIC_FAIRGROUND_CONTRACT`) name `sealround.<owner>.testnet` and
  must then be pointed at the new account (parts 3 and 4).

## 3. Relayer on Fly.io

Fly sets a single `Fly-Client-IP` header that the relayer's per-IP limits can
trust (`apps/relayer/README.md`, "Deploying"), and runs one always-on machine,
which keeps the in-memory limits and budgets. Railway or Render can run the
same image (Dockerfile `apps/relayer/Dockerfile`, build context the repo
root), but their client-IP headers are less clear-cut: test the per-IP limit
there before relying on it.

One relayer serves one network, so testnet and mainnet each get their own
Fly app.

### The image

`apps/relayer/Dockerfile` builds from the repository root (the pnpm lockfile
lives there): `node:24-slim` installs from the lockfile with pnpm 12.3.4 and
compiles `src/` to `dist/`, then `node:24-alpine` runs `node dist/main.js` as
the user `node`, with production dependencies only. It reads configuration
from environment variables only and listens on `$PORT` (8787).
`apps/relayer/Dockerfile.dockerignore` keeps everything else (node_modules,
`target/`, `.env` files, `enclave/deploy/out/`) out of the build: Docker reads
`<Dockerfile name>.dockerignore` next to the Dockerfile, and a `.dockerignore`
inside `apps/relayer` would be ignored because the context is the root.

```powershell
docker build -f apps/relayer/Dockerfile -t sealround-relayer .
```

Checked on 11 Nov 2026: it builds (18 files in the context), the image is
266 MB, and without configuration it exits with `invalid relayer configuration`
and the list of missing variables.

### Fly configuration

For testnet, use [`apps/relayer/fly.testnet.toml`](apps/relayer/fly.testnet.toml).
It points to `sealround.itzbeast.testnet`, the `$FG` of part 2. Before
hosting, check that T4b (the master secret names that account) and T5
(deployed with both testnet quote tokens) are done for it, and lock it (T8)
before the testnet web URL is shared.

The policy sponsors `claim`, `claim_proceeds`, `clear_onchain`,
`reveal_bid`, and `trigger_refund_mode` with zero attached deposit.
It also sponsors approved USDC `ft_transfer_call` bids to that contract
with 1 yoctoNEAR attached. It sponsors `seed_liquidity` and
`abandon_liquidity` when the pool is ready for the requested step. Each
sponsored call uses 150 TGas. A pool may need more than one call. The
wallet path uses 300 TGas, and payable calls still use the wallet.

For mainnet, save the following as `apps/relayer/fly.toml`. Supply the app
name with `-a`.

```toml
# Sealround relayer on Fly.io. Configuration, the key included, is set with
# `fly secrets import` (LAUNCH.md, part 3). One machine: limits and budgets
# live in memory.
primary_region = "fra"   # any region

[http_service]
  internal_port = 8787
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  # /policy answers without an RPC call. /health returns 503 when the RPC
  # blips or the daily budget is used up, so it must not be the host check.
  [[http_service.checks]]
    grace_period = "20s"
    interval = "30s"
    method = "GET"
    path = "/policy"
    timeout = "5s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

### Relayer environment

The testnet TOML supplies the network, contract, tokens, limits and port.
Set `RELAYER_ACCOUNT_ID`, `RELAYER_PRIVATE_KEY`, and `CORS_ORIGINS` on
the Fly app as shown below. If reusing a Fly app, check `fly secrets list`
for older settings that conflict with the TOML. Fly Secrets take precedence.
For mainnet, supply the mainnet settings from the table through the same
stdin import. Enter the private key at the masked prompt.

| Variable | Testnet | Mainnet | Where the value comes from |
| --- | --- | --- | --- |
| `NETWORK` | `testnet` | `mainnet` | |
| `NEAR_RPC_URL` | `https://rpc.testnet.fastnear.com` | `<rpc-url>` | your RPC provider for mainnet |
| `RELAYER_ACCOUNT_ID` | `<relayer>.testnet` | `relayer.<owner>.near` | part 1, step M1 |
| `RELAYER_PRIVATE_KEY` | `ed25519:...` | `ed25519:...` | `near account export-account <relayer account> using-private-key network-config <network>` |
| `FAIRGROUND_CONTRACT` | `sealround.itzbeast.testnet` | `fairground.<owner>.near` | the deployed account |
| `USDC_CONTRACTS` | `usdc.fakes.testnet,3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | the contract's `allowed_quote_tokens`; the first entry must be the web app's USDC |
| `CORS_ORIGINS` | `https://<web-testnet>.vercel.app` | `https://<web-pilot>.vercel.app` | the Vercel production URL (part 4): exact origin, no trailing slash; add a custom domain after a comma |
| `CLIENT_IP_HEADER` | `fly-client-ip` | `fly-client-ip` | set by Fly's proxy |
| `TRUSTED_PROXY_HOPS` | `1` | `1` | default |
| `DAILY_BUDGET_NEAR` | `5` | `2` | hard cap per UTC day on relay spend |
| `STORAGE_BUDGET_NEAR` | `0.5` | `0.2` | hard cap per UTC day on USDC registrations |
| `PORT` | `8787` | `8787` | must match `internal_port` |
| the rest | defaults from `.env.example` | same | |

### Deploy the testnet relayer

```powershell
$FlyApp = Read-Host 'Fly app name for the testnet relayer'
$RelayerAccount = Read-Host 'Dedicated relayer account ending in .testnet'
$WebOrigin = Read-Host 'Exact testnet Vercel production origin with https'
fly auth login
fly auth docker
fly apps create $FlyApp   # skip if the app already exists

$testnetKey = Read-Host 'Full-access testnet relayer key' -AsSecureString
try {
  $flyKey = [pscredential]::new('relayer', $testnetKey).GetNetworkCredential().Password
  @("RELAYER_ACCOUNT_ID=$RelayerAccount", "CORS_ORIGINS=$WebOrigin", "RELAYER_PRIVATE_KEY=$flyKey") |
    fly secrets import --stage -a $FlyApp
  if ($LASTEXITCODE -ne 0) { throw 'Fly secret import failed.' }
} finally {
  Remove-Variable flyKey, testnetKey -ErrorAction SilentlyContinue
}

$Image = "registry.fly.io/${FlyApp}:v1"
docker build -f apps/relayer/Dockerfile -t $Image .
docker push $Image
fly deploy --config apps\relayer\fly.testnet.toml -a $FlyApp --image $Image --ha=false
```

The import passes the key through stdin and keeps it out of files and shell
history. `--ha=false` starts one machine. Check the machine count if you
are reusing a Fly app, since budgets and rate limits are per process.

Success:

```powershell
$RelayerUrl = "https://$FlyApp.fly.dev"
fly status -a $FlyApp                                              # one machine, started
Invoke-RestMethod "$RelayerUrl/health"                             # ok True, network testnet, balance ok
Invoke-RestMethod "$RelayerUrl/policy"                             # fairground_contract = sealround.itzbeast.testnet
(Invoke-WebRequest -UseBasicParsing "$RelayerUrl/policy" -Headers @{ Origin = $WebOrigin }).Headers['Access-Control-Allow-Origin']
# prints $WebOrigin
```

If it fails:

- `invalid relayer configuration:` in the logs lists every bad variable. Fix
  each one, which restarts the machine:
  `'CORS_ORIGINS=https://<web-testnet>.vercel.app' | fly secrets import -a <relayer-app-testnet>`.
  For the key, use the masked prompt and stdin import above.
- A startup error about the key: it is not a full-access key of
  `RELAYER_ACCOUNT_ID`.
- `/health` 503 with `balance` `empty`: fund the relayer. `unknown`: the RPC
  is unreachable.
- CORS header missing: `CORS_ORIGINS` does not match the page's origin
  exactly.

Update: build and push a new tag (`:v2`), then the same `fly deploy` with
that tag. Roll back: deploy the previous tag.

## 4. Web on Vercel

How the mode is chosen (`apps/web/src/lib/config.ts`): at build time, by
`NEXT_PUBLIC_FAIRGROUND_CONTRACT` alone.

- Unset or empty: mock mode. Simulated chain and wallet in the browser, judge
  mode, demo sales, "Reset demo data". Every other `NEXT_PUBLIC_` variable is
  ignored, so judge mode works with no NEAR variables at all.
- Set: NEAR mode on that contract. Judge mode and the demo sales are not
  available.
- A malformed value (bad account id, unknown network, bad URL or hash) stops
  the app with an error that names the variable.
- `NEXT_PUBLIC_` values are compiled in: after changing one, redeploy.

So the same repo becomes three Vercel projects:

| Project | Mode | For |
| --- | --- | --- |
| `<web-demo>` | mock | judges: judge mode in under 2 minutes with no wallet or funds. The README's demo link |
| `<web-testnet>` | NEAR, testnet | the real contract, relayer and enclave on testnet |
| `<web-pilot>` | NEAR, mainnet | the pilot; deploy it after the mainnet lock (step M3) |

Project settings, the same for all three (Vercel: Add New, Project, import the
GitHub repository; the code must be pushed first, which is the owner's call):

| Setting | Value |
| --- | --- |
| Framework preset | Next.js |
| Root Directory | `apps/web` |
| Include files outside the Root Directory in the build | on (the app imports `packages/*` from source) |
| Install Command | `npx --yes pnpm@12.3.4 install --frozen-lockfile` |
| Build Command | `npx --yes pnpm@12.3.4 run build` |
| Output Directory | default |
| Node.js Version | 24.x |

pnpm is pinned because version 12.3.4 wrote the lockfile. Use the settings
above for the separate testnet Vercel project.

In the testnet project, open Settings → Environment Variables and set the
six `NEXT_PUBLIC_` entries with values in the testnet column for Production.
Replace `<relayer-app-testnet>` with the Fly app name and redeploy. Use the
production origin as the relayer's `CORS_ORIGINS`. The matching block in
`apps/web/.env.example` can also configure a local testnet view.

| Variable | `<web-demo>` | `<web-testnet>` | `<web-pilot>` | Where the value comes from |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_FAIRGROUND_CONTRACT` | not set | `sealround.itzbeast.testnet` | `fairground.<owner>.near` | the deployed account |
| `NEXT_PUBLIC_NEAR_NETWORK` | not set | `testnet` | `mainnet` | |
| `NEXT_PUBLIC_NEAR_RPC_URL` | not set | `https://rpc.testnet.fastnear.com` | `<rpc-url>` | your RPC provider |
| `NEXT_PUBLIC_USDC_CONTRACT` | not set | `usdc.fakes.testnet` | optional, default `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | must be in the contract's `allowed_quote_tokens` and first in the relayer's `USDC_CONTRACTS` |
| `NEXT_PUBLIC_RELAYER_URL` | not set | `https://<relayer-app-testnet>.fly.dev` | `https://<relayer-app-mainnet>.fly.dev` | part 3 (no trailing slash) |
| `NEXT_PUBLIC_SEALER_CODE_HASH` | not set | `f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb` | same | `$SHA`; without it the code-hash check cannot pass |
| `NEXT_PUBLIC_DEV_ACCOUNTS` | never | never | never | sandbox only; its keys would ship to every visitor |
| `ONECLICK_JWT` | the 1Click key | optional, dry quotes | the 1Click key | partners.near-intents.org. Server only (the `/api/oneclick/*` routes). Mark it Sensitive. |
| `ONECLICK_REDIS_URL` and `ONECLICK_REDIS_TOKEN` | optional | optional | required for live swaps | Server-only Upstash Redis REST URL and token. Shared by every instance of this deployment. |
| `ONECLICK_RECEIPT_SECRET` | not set | not set | required for live swaps | Server-only 32-byte signing secret in hex. Keep it stable across deploys. |
| `ONECLICK_REAL_SWAPS` | not set | not set | `1` when the owner enables 1Click funding | Server only. Requires mainnet, Circle's native USDC, receipt signing and shared quotas. See M6. |
| `NEXT_PUBLIC_APP_URL` | not set | optional, `https://app.<domain>` | optional, `https://app.<domain>` | only with the custom domains below; no trailing slash |

Custom domains (optional). One project can serve the landing page and the app
on two hosts. `src/proxy.ts` decides by host name:

- The root domain (`<domain>`) serves the landing page at `/`. The app is
  under `/sales`, `/sale/...`, `/create`, `/judge`, `/arena` and `/how`.
- A host that starts with `app.` (`app.<domain>`) serves the sales board at
  `/`. Every other path is the same page as on the root domain.
- With `NEXT_PUBLIC_APP_URL=https://app.<domain>`, the landing page's links
  point at the app host, and an app path opened on the root domain redirects
  (308) to the same path on the app host. Without it nothing redirects, which
  is right for a single host such as `<web-demo>.vercel.app`.

To set it up: in the Vercel project, Settings, Domains, add `<domain>` and
`app.<domain>` to the same project, add the DNS records Vercel shows, set
`NEXT_PUBLIC_APP_URL`, redeploy, and add `https://app.<domain>` to the
relayer's `CORS_ORIGINS`. Locally, `http://app.localhost:3000` is the app host
with no setup.

Checks after each deploy, on the production URL:

- `<web-demo>`: the footer reads "Sealround is unaudited. In this demo the
  chain is simulated in your browser." Judge mode reaches a result in under
  2 minutes in a fresh browser (time it). `/arena`, `/how` and `/create`
  render, also at phone width.
  `https://<web-demo>.vercel.app/api/oneclick/tokens` returns a JSON list.
- `<web-testnet>`: the footer reads "Sealround runs on NEAR testnet.
  Unaudited." The smoke sale from T6 and the evidence sale from T7b are
  listed. In the browser's network tab,
  `GET <relayer>/policy` returns 200 with no CORS error and shows
  `fairground_contract: sealround.itzbeast.testnet`. The evidence sale's
  result page shows the reveal, the fairness timeline, the launch pool panel
  (pool price equal to the clearing price, LP shares held by the contract)
  and the Verified panel with every check passing. Its link, pasted into X's
  composer, shows the sale's share card with the clearing price. Part 5
  tests bidding.
- `<web-pilot>`: the same, with "mainnet".
- Use the production URLs only. Preview deployments have other origins,
  which the relayer's CORS refuses (the app then falls back to paid
  transactions), and can sit behind Vercel's login.

Keep all three projects, both relayers and their balances in place through
18 Nov (ideally 25 Nov). Check `/health` daily.

## 5. Testnet end to end and pilot dry run

The spec asks for the refund path, including the timeout refund, to be tested
on testnet before the pilot. This dry run uses the pilot's own parameters
(part 6), the hosted app, the relayer and a browser wallet.

Values for the dry run (part 6 lists the mainnet ones):

```powershell
$SALE   = 'dryrun1'                          # next run: dryrun2
$NAME   = 'Sealround Dry Run'; $SYMBOL = 'DRY'
$QUOTE  = 'usdc.fakes.testnet'
$START  = [DateTimeOffset]::UtcNow.AddMinutes(5)
$END    = $START.AddMinutes(15)
$SETTLE = '600000000000'                     # 10 minutes, the contract's minimum: the timeout refund comes quickly
```

Render the arguments. The same block serves the pilot. It writes UTF-8
without a byte order mark, which near-sdk needs:

```powershell
New-Item -ItemType Directory -Force $out | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
$ns = { param($t) ([long]$t.ToUnixTimeMilliseconds() * 1000000L).ToString() }
$params = [ordered]@{
    sale_id                 = $SALE
    token_name              = $NAME
    token_symbol            = $SYMBOL
    decimals                = 18
    total_supply            = '1000000000000000000000000'   # 1,000,000 tokens
    sale_supply             = '1000000000000000000000000'   # all for sale, nothing kept by the creator
    floor_price             = '100'                         # 0.0001 USDC per whole token
    min_raise               = '0'
    bid_start               = (& $ns $START)
    bid_end                 = (& $ns $END)
    min_deposit             = '1000000'                     # 1 USDC, the contract's minimum
    max_deposit_per_account = '10000000'                    # 10 USDC per account (pilot cap)
    max_bids                = 50                            # 50 x 10 USDC = 500 USDC at most (pilot cap)
    reveal_mode             = 'Tee'
    settle_timeout          = $SETTLE
    quote_token             = $QUOTE
    description             = 'Capped pilot on an unaudited contract. Demo token with no utility and no value. At most 10 USDC per account.'
}
[IO.File]::WriteAllText("$out\create-sale-$SALE.json", (ConvertTo-Json -InputObject ([ordered]@{ params = $params }) -Depth 5 -Compress), $utf8)
[IO.File]::WriteAllText("$out\sale-id-$SALE.json", (ConvertTo-Json -InputObject ([ordered]@{ sale_id = $SALE }) -Compress), $utf8)
[IO.File]::WriteAllText("$out\fills-$SALE.json", (ConvertTo-Json -InputObject ([ordered]@{ sale_id = $SALE; from_index = 0; limit = 50 }) -Compress), $utf8)
```

Create the sale within 5 minutes of rendering (`bid_start` must not be in the
past):

```powershell
near contract call-function as-read-only $FG get_create_cost file-args "$out\create-sale-$SALE.json" network-config $NET now
near contract call-function as-transaction $FG create_sale file-args "$out\create-sale-$SALE.json" prepaid-gas '300 Tgas' attached-deposit '2.5 NEAR' sign-as $ME network-config $NET sign-with-keychain send
near contract call-function as-read-only $FG get_sale file-args "$out\sale-id-$SALE.json" network-config $NET now
```

Success: `get_create_cost` is about 2.2 NEAR (in yoctoNEAR); the excess of the
2.5 NEAR comes back. About 30 seconds later `get_sale` shows
`sealer_key_setup` `"done"`, `max_deposit_per_account` `"10000000"`,
`max_bids` 50 and `refund_mode_at`.

**Dry run 1: timeout refund.**

1. When the sale opens, go to `https://<web-testnet>.vercel.app/sale/dryrun1`
   as `<bidder>`, get test USDC from the app, and bid, for example 5 USDC.
   Expected: no network fee in the wallet (the relayer paid) and the bid shows
   as placed. A bid above 10 USDC must be refused.
2. Do not close the sale. After `refund_mode_at` (bid end plus 10 minutes),
   trigger refund mode and claim in the app (the relayer pays both), or from
   the CLI:

   ```powershell
   near contract call-function as-transaction $FG trigger_refund_mode file-args "$out\sale-id-$SALE.json" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config $NET sign-with-keychain send
   [IO.File]::WriteAllText("$out\claim-$SALE.json", (ConvertTo-Json -InputObject ([ordered]@{ sale_id = $SALE; bidder = '<bidder>' }) -Compress), $utf8)
   near contract call-function as-transaction $FG claim file-args "$out\claim-$SALE.json" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config $NET sign-with-keychain send
   near contract call-function as-transaction $FG claim_proceeds file-args "$out\sale-id-$SALE.json" prepaid-gas '150 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config $NET sign-with-keychain send
   near contract call-function as-read-only $FG get_fills file-args "$out\fills-$SALE.json" network-config $NET now
   ```

   Anyone may push a bidder's `claim`; the funds only ever go to the bidder.
3. Success: `get_result` shows `status` `"failed"` with `fail_reason`
   `"refund_mode"`, every fill has `refund` equal to the deposit and
   `penalty` `"0"`, and the bidder's USDC balance is back where it started.

**Dry run 2 (optional, about 30 minutes): a clear in the app.** Render again
with `$SALE = 'dryrun2'`, bid from two accounts, close the sale from the app
after `bid_end` (a wallet transaction that attaches about 0.014 NEAR, mostly
refunded; `close_sale` is never relayed), claim, and check the result page's
Verified panel.

## 6. Mainnet pilot

Gate: part 5 passed on testnet, including the timeout refund.

### Pilot caps and the fields that set them

From the spec, "Real launch pilot". The contract has no total-raise field, so
the raise is capped through the number of bid slots:

| Spec limit | `create_sale` field | Value |
| --- | --- | --- |
| Max deposit per account: 10 USDC | `max_deposit_per_account` | `"10000000"` (USDC has 6 decimals). One bid per account: a second is refunded with `already_bid` |
| Total raise cap: 500 USDC | `max_bids` x `max_deposit_per_account` bounds every deposit | `max_bids` 50: at most 500 USDC deposited, so at most 500 USDC raised. At most 50 bidders, first come first served |
| Bid window: 2 to 6 hours, announced a day ahead | `bid_start`, `bid_end` (nanoseconds) | 4 hours from `<pilot start>` |
| Smallest bid | `min_deposit` | `"1000000"` (1 USDC, the contract's floor) |
| Demo token, no utility, no promises | `token_name`, `token_symbol`, `description` | your choice; the description above says it |
| Funds can always leave | `settle_timeout` | 1 hour: if the sale is not settled 1 hour after it closes (or after `bid_end` if nobody closes it), anyone can trigger refund mode, and every bidder claims the full deposit |
| Unaudited, with a banner | the web app | step M5 |
| Refund path tested on testnet first | | part 5 |

`max_price` (optional) would cap the clearing price as well; with 50 slots it
is not needed.

### M1. Mainnet accounts

```powershell
near account import-account                       # import <owner>.near; follow the prompts
near account create-account fund-myself relayer.<owner>.near '3 NEAR' autogenerate-new-keypair save-to-keychain sign-as <owner>.near network-config mainnet sign-with-keychain send
```

`<owner>.near` must hold about 12 NEAR and at least 1 USDC (native USDC on
NEAR, `17208628...`) for the smoke bid.

### M2. Deploy and smoke-test on mainnet

```powershell
$NET = 'mainnet'; $ME = '<owner>.near'; $FG = "fairground.$ME"
$env:OUTLAYER_NETWORK = $NET
$out = Join-Path $PWD "enclave\deploy\out\$NET"
```

Run `scripts\build-enclave.ps1 -Verify` first (part 1), then steps T1 to T7
with these variables. Differences:

- T1: `outlayer login mainnet`.
- T4 names `$FG` directly, so T4b does not apply.
- T5: `/deploy` is testnet only. Use `4-deploy-contract.ps1 -Network mainnet -Account $ME -Contract $FG -Execute`;
  its `new` arguments come from `new-args.mainnet.json`, with
  `"dex": "v2.ref-finance.near"`.
- T6: `get_create_cost` is about 1.73 NEAR on mainnet.
- T7 `-Phase Bid`: leave out `-GetTestUsdc` (mainnet has no test USDC). The
  bid uses 1 USDC of yours, and the sale settles it as on testnet.
- The attestation check compares the measurements with
  `worker.outlayer.near`.
- T7b is testnet only (the script refuses mainnet).

### M3. Lock before anything is announced

Step T8 with the mainnet variables and `4-deploy-contract.ps1 -Lock`, after
T7 passes and before the pilot sale is created or announced.

### M4. Mainnet relayer and web app

- Relayer: part 3 with `<relayer-app-mainnet>`, `apps\relayer\.env.fly-mainnet`
  and the mainnet column. `/health` shows `balance` `low` (under 5 NEAR) with
  `ok` true; that is expected at 3 NEAR.
- Web: the `<web-pilot>` project from part 4, mainnet column.

### M5. The unaudited banner (gate)

The mainnet app shows an "Unaudited experiment" banner above the page.
Open the hosted pilot URL and confirm the banner is visible before announcing
the sale.

### M6. Enable 1Click funding for the mainnet pilot

Live swaps are off by default. On `<web-pilot>`, configure NEAR mainnet and
Circle's native USDC. Set the server-only Redis REST URL and token for a
database dedicated to the pilot. Set `ONECLICK_RECEIPT_SECRET` to 32 random
bytes encoded as 64 hex characters and keep it stable across redeploys.
The shared quota covers every 1Click call with limits of 40 per client and
300 overall in 60 seconds. With those values in place, set
`ONECLICK_REAL_SWAPS=1` and redeploy. Check that
`GET /api/oneclick/config` returns `{"liveSwaps":true}` for the pilot and
`{"liveSwaps":false}` for the demo and testnet.

The funding panel previews the price with a dry quote. A connected bidder
enters an origin-chain refund address and requests a separate deposit quote.
The panel shows the exact amount and asset, the 1Click deposit address, and
the deadline. The bidder sends the transfer from their own origin-chain
wallet. Sealround polls 1Click for delivery or refund status using a signed
receipt valid for 30 days.

Verification so far uses local fixtures. Record the first completed mainnet
swap as pilot evidence after the owner enables the feature.

### M7. Create the pilot sale, a day ahead

```powershell
$SALE   = 'pilot'
$NAME   = '<demo token name>'; $SYMBOL = '<SYMBOL>'
$QUOTE  = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
$START  = [DateTimeOffset]::Parse('<pilot start>')     # for example 2026-11-13T12:00:00Z
$END    = $START.AddHours(4)                           # 2 to 6 hours
$SETTLE = '3600000000000'                              # 1 hour
```

Run the render block from part 5, then the same three `get_create_cost`,
`create_sale` (attach 2.5 NEAR) and `get_sale` lines. Then check the key
request's attestation:

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network mainnet -TxHash <create_sale tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId pilot
```

Success: `get_sale` shows `"reveal_mode":"Tee"`, `"sealer_key_setup":"done"`,
`min_deposit` `"1000000"`, `max_deposit_per_account` `"10000000"`,
`max_bids` 50, and the announced times; the attestation check passes.
Announce `https://<web-pilot>.vercel.app/sale/pilot`, the window and the
funding note from M6 at least a day ahead.

### M8. During the window

```powershell
near contract call-function as-read-only $FG get_bids_summary file-args "$out\sale-id-pilot.json" network-config mainnet now
Invoke-RestMethod https://<relayer-app-mainnet>.fly.dev/health
fly logs -a <relayer-app-mainnet>
```

Run the openly announced bot: `pnpm --filter web live-bot snipe` with
`--network mainnet` and `--yes-mainnet` (`apps/web/scripts/live-bot/README.md`).
Screen-record the window.

### M9. Close, verify, claim

After `bid_end` (anyone can close; the closer attaches `get_close_deposit`,
0.01401 NEAR for 50 bids, and OutLayer refunds what it does not charge):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network mainnet -Account $ME -Contract $FG -SaleId pilot -Phase Close -Execute
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network mainnet -TxHash <close_sale tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId pilot
```

Ignore the script's smoke-sale numbers (`"2000"`, 500 tokens). Success:
`"settled"`, `failed_checks` `[]`, and the attestation check passes. Bidders
claim in the app; run the `claim_proceeds` line the script prints. If the
clear keeps failing, run `-Phase Close` again; if it cannot settle, refund
mode opens at `refund_mode_at` (part 7).

### M10. What to record

From the spec, "What to record":

| Metric | How |
| --- | --- |
| Number of bidders | `get_bids_summary` `count`; `get_bids` lists them |
| Chains used to fund | ask bidders (the app does not see funding done outside it) |
| Your own bot's result | the bot's report next to `get_result` `clearing_price` |
| Time from close to settlement (target under 2 minutes) | the `close_sale` transaction and its `sale_settled` receipt on nearblocks.io |
| Refunds processed | `get_fills` (`refund`, `penalty`) and `get_bids` (`claimed`) |
| Verified panel passing | screenshot of `/sale/pilot/result` |
| Transaction links for the README | `create_sale`, a bid, `close_sale`, a claim, the attestation output |

## 7. If something breaks

| Symptom | Action |
| --- | --- |
| A web deploy broke the site | Vercel, Deployments: promote the previous deployment (instant rollback) |
| NEAR mode is down and judges are waiting | point them at `<web-demo>` (mock mode); it does not depend on the chain or the relayer |
| Relayer down or misbehaving | the app falls back to wallet-paid transactions by itself. Stop it with `fly scale count 0 -a <app>`; roll back with `fly deploy ... --image registry.fly.io/<app>:<previous tag>` |
| Relayer key exposed | it can spend only the relayer's balance. Add a new full-access key to the relayer account, import the new `RELAYER_PRIVATE_KEY` with the pipe from part 3, delete the old key (`apps/relayer/README.md`, "Rotate") |
| `/health` shows `budget_exhausted` | the budget resets at 00:00 UTC. To raise it, import a new `DAILY_BUDGET_NEAR` (this restarts the machine, which also resets every in-memory counter) |
| `sealer_key_setup` `"failed"` | `near contract call-function as-transaction $FG retry_setup file-args "$out\sale-id-<sale>.json" prepaid-gas '300 Tgas' attached-deposit '0.02 NEAR' sign-as $ME network-config $NET sign-with-keychain send` (anyone may; README 10) |
| Clear failed, sale `"closed"` | read `execution_completed`'s `error_message` (README 10) and close again (`7-smoke-clear.ps1 -Phase Close`, `8-evidence-sale.ps1 -Phase Close`, or the app) |
| Launch pool not seeded after settlement | anyone calls `seed_liquidity` again (the line `8-evidence-sale.ps1 -Phase Close` prints without `-Execute`, or **Seed the pool** on the result page); each call runs the next step. A step waiting 600 blocks for its result is given up by the next call, which reads the exchange first. From the deadline, `abandon_liquidity` unlocks the tokens (`contracts/DESIGN.md`, "Launch liquidity") |
| OutLayer down, sale stuck | wait. After `refund_mode_at` anyone calls `trigger_refund_mode` (part 5), then everyone claims the full deposit |
| Bug in the contract after the lock | it cannot be patched or paused. Stop promoting the sale, let it settle or time out into refunds, then deploy a new contract account (README 8) and point the relayer and the web app at it |
| Bug before the lock | deploy a fresh contract account as in T8, and lock that one |

Never, on any network: `outlayer secrets set` or `outlayer secrets delete`
on the `default` profile, or deleting the OutLayer project or its pinned
version. Each makes every open sale end in refunds.

## 8. Pre-submission checklist

- [ ] Repository public by 14 Nov 23:59 UTC; submission by 18:00 UTC.
- [ ] `LICENSE` (MIT) at the root and committed, matching `license` in the
      root `Cargo.toml`.
- [ ] No secrets in git history. Both commands must print nothing but
      `.env.example` files:
      ```powershell
      git grep -nE "ed25519:[1-9A-HJ-NP-Za-km-z]{60,}" $(git rev-list --all)
      git log --all --name-only --format= | Sort-Object -Unique | Select-String '\.env|credentials|deploy/out'
      ```
- [ ] Contracts locked: `near account list-keys sealround.<owner>.testnet network-config testnet now`
      and the same for `fairground.<owner>.near` on mainnet list no keys.
- [ ] Hosted demo up: judge mode on `<web-demo>` under 2 minutes from a
      fresh browser; `<web-testnet>` lists sales; the relayer's `/health` says
      `ok`. All of it stays up through 18 Nov (ideally 25 Nov).
- [ ] README links: demo URL, testnet URL, contract accounts, pilot
      transaction links, `$SHA` with its source commit.
- [ ] README section 7 has the evidence sale (T7b): the Report's Markdown,
      the `verify-sale` output, and T8's `list-keys` output and lock
      transaction.
- [ ] Mainnet NEAR account ready for the prize payout.
- [ ] Code from before 19 Oct (openlaunch) separated by a branch or tag, with
      a diff link.
- [ ] Video recorded; X post with `@NEARProtocol` and `#NEARHackathon`.
- [ ] Exactly one submission at nearhackathon.com/#apply.
- [ ] `outlayer logout` on any shared machine.
