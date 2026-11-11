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
| `<owner>` | your account name without `.testnet` / `.near`. Keep it short: each sale's token lives at `<sale id>.fairground.<owner>.testnet`, at most 64 characters | `alice` |
| `<relayer>.testnet` | a separate testnet account that only relays | `sealround-relayer-alice.testnet` |
| `<bidder>` | a testnet account in a browser wallet that signs delegates (HOT, Meteor or Intear) | `alice-bids.testnet` |
| `<relayer-app-testnet>`, `<relayer-app-mainnet>` | Fly.io app names (globally unique) | `sealround-relayer-testnet` |
| `<web-demo>`, `<web-testnet>`, `<web-pilot>` | Vercel project names; each serves at `https://<name>.vercel.app` | `sealround`, `sealround-testnet`, `sealround-pilot` |
| `<sale id>` | the smoke sale's id, printed by `5-smoke-sale.ps1` | `smoke-11111530` |
| `<tx hash>` | a transaction hash from near CLI's output | |
| `<rpc-url>` | a mainnet JSON-RPC URL from a provider (the public `rpc.mainnet.near.org` is rate limited) | |
| `<pilot start>` | the announced pilot start, UTC, at least a day ahead | `2026-11-13T12:00:00Z` |

Session variables. Set them in every new PowerShell window (switch to the
mainnet values in part 6):

```powershell
$NET = 'testnet'                      # mainnet: 'mainnet'
$ME  = '<owner>.testnet'              # mainnet: '<owner>.near'
$FG  = "fairground.$ME"               # the contract account; 4-deploy-contract.ps1 creates it
$SHA = (Get-FileHash enclave\res\fairground_sealer.wasm -Algorithm SHA256).Hash.ToLower()
$env:OUTLAYER_NETWORK = $NET
$out = Join-Path $PWD "enclave\deploy\out\$NET"
```

Keep the default contract name `fairground.<owner>`. Another name works, but
then every script needs the same `-Contract` value, and the master secret
(step T4) must name it.

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
# 0061c8569e7b2ad87fe3a0d863cc31cab1deee91273572af6231418f0e0f921e   (546,701 bytes, 11 Nov 2026)
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
| `<owner>.testnet` | testnet | owner of the OutLayer project `<owner>.testnet/fairground-sealer` and of its secret row; parent of the contract; creates and closes test sales | about 15 NEAR | 6.5 for the contract account, about 1.73 for the smoke sale, about 2.2 per pilot-shaped dry run (two), 0.3 attached to OutLayer (mostly refunded), and headroom: a 300 TGas call needs 0.3 NEAR free up front |
| `fairground.<owner>.testnet` | testnet | the sale contract; created by step T5 | 6.5 NEAR, sent by the owner | the script: (wasm bytes + 2,000) x 1e19 yoctoNEAR plus 1 NEAR |
| `<relayer>.testnet` | testnet | pays gas for bids, claims and refund mode, and new bidders' USDC registration | about 6 NEAR | `/health` reports `ok` from 5 NEAR, `low` below that, `empty` (503) below 0.5 |
| `<bidder>` | testnet | you, bidding in the browser | whatever the wallet or faucet gives; test USDC comes from the app | |
| `<owner>.near` | mainnet | the same roles as on testnet | about 12 NEAR and 2 USDC (native USDC on NEAR) | 6.5 contract, 1.73 smoke sale, about 2.2 pilot sale (50 bid slots; `get_create_cost` gives the exact figure), 0.3 OutLayer, headroom. 1 USDC for the smoke bid |
| `fairground.<owner>.near` | mainnet | the sale contract | 6.5 NEAR, sent by the owner | as on testnet |
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

If the owner holds less than about 15 NEAR, create one more faucet account
and send from it:
`near tokens <spare>.testnet send-near <owner>.testnet '9 NEAR' network-config testnet sign-with-keychain send`.
Create `<bidder>` inside the browser wallet you will test with.

### Secrets and where they live

| Secret | Lives in | Never in |
| --- | --- | --- |
| account keys | near CLI's keychain (your OS) | the repo |
| OutLayer CLI login | `~/.outlayer/<network>/credentials.json`, plain text. Run `outlayer logout` on a shared machine | the repo |
| relayer key | Fly secrets only | `fly.toml`, the image, any `NEXT_PUBLIC_` variable |
| 1Click API key (`ONECLICK_JWT`) | Vercel environment variables, server side only | any `NEXT_PUBLIC_` variable |

Get the 1Click key at partners.near-intents.org (spec, "Cross-chain funding
and settlement"). Without it the quotes still work, with higher fees.

`enclave/deploy/out/<network>/` receives the JSON arguments the scripts
render: account ids, hashes and sealed bids, no keys. It is git-ignored
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
powershell -ExecutionPolicy Bypass -File enclave\deploy\3-master-secret.ps1 -Network $NET -Account $ME -Execute
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

### T5. Deploy the contract (README 5)

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Network $NET -Account $ME -Execute
```

- Does: checks that the version and the secret row exist, creates `$FG`
  with 6.5 NEAR, then deploys `contracts\res\fairground.wasm` and calls `new`
  in the same transaction (signed by `$FG`, so nobody can front-run the
  init), and reads the config back.
- `new` arguments, rendered from `enclave\deploy\templates\new-args.testnet.json`
  into `enclave\deploy\out\testnet\new-args.json`:

  ```json
  {
    "outlayer": "outlayer.testnet",
    "sealer_source": { "Project": { "project_id": "<owner>.testnet/fairground-sealer", "version_key": "<$SHA>" } },
    "sealer_code_hash": "<$SHA>",
    "sealer_secrets": { "profile": "default", "account_id": "<owner>.testnet" },
    "allowed_quote_tokens": [ "usdc.fakes.testnet", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af" ]
  }
  ```

  Mainnet uses `outlayer.near` and only
  `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC).
  The contract has no owner, no admin and no upgrade method; this config
  never changes.
- Success: `New account <$FG> created successfully`, the deploy succeeds,
  `get_config` echoes the arguments, and `view-account-summary` shows
  `Contract (SHA-256 checksum hex): 0061c856...921e`.
- If it fails: `invalid config: ...` names the rule; nothing is half
  deployed. If the account was created but the deploy failed, running
  `-Execute` again stops at the account creation: run the printed
  `near contract deploy ...` line by hand instead.

### T6. Smoke sale: the key path (README 6)

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\5-smoke-sale.ps1 -Network $NET -Account $ME -StartInMinutes 3 -DurationMinutes 10 -Execute
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $NET -TxHash <create_sale tx hash> -Signer $ME -ExpectedWasmSha256 $SHA -Contract $FG -SaleId <sale id>
```

- Does: creates a throwaway TEE sale (bids open in 3 minutes for 10 minutes,
  1 to 2 USDC per bid). The contract deploys the sale token and asks the
  enclave for the sale's public key.
- Success: `get_sale` shows `"token_setup":"done"`,
  `"sealer_key_setup":"done"`, a 64-hex `sealer_pubkey` and
  `sealer_code_hash` equal to `$SHA`; the attestation check passes. Note the
  sale id and the `create_sale` transaction hash.
- If it fails: "bid_start: must not be in the past": run the line again (the
  times are relative to now). `sealer_key_setup` `"failed"`: README 10, then
  `retry_setup` (part 7).

### T7. Smoke clear (README 6b)

Once the sale is open (3 minutes after T6):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $NET -Account $ME -SaleId <sale id> -Phase Bid -GetTestUsdc -Execute
```

Success: the transfer returns `"1000000"` and logs `bid_placed`;
`get_bids_summary` shows `count` 1. `"0"` means the bid was refunded, and
`bid_rejected` says why (`wrong_ciphertext_length`: rebuild the seal tool).

After `bid_end` (10 minutes later):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $NET -Account $ME -SaleId <sale id> -Phase Close -Execute
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

### T8. Lock the contract. Irreversible

When: after T7 passes, and before anyone else learns the contract or the
testnet web URL. Until the contract account's full-access key is deleted,
whoever holds it can read every sealed bid (README 5, `contracts/DESIGN.md`
"Deployment invariants"). After it, nobody can redeploy or fix `$FG`.

```powershell
near account list-keys $FG network-config $NET now      # one full-access key, the one near CLI made in T5
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Network $NET -Account $ME -Lock -PublicKey ed25519:<that key> -Execute
```

- Does: checks the key belongs to `$FG`, deletes it, lists the keys again.
  (`-Lock` without `-PublicKey` and `-Execute` only prints these steps.)
- Success: the last `list-keys` shows no keys.
- If T5 to T7 showed a problem in the contract itself, do not lock this
  account. Deploy a fresh one (`-Contract fairground2.$ME` on
  `4-deploy-contract.ps1` and every later script, and update `$FG`). First
  point the secret at it: `3-master-secret.ps1 -Network $NET -Account $ME -Contract fairground2.$ME`
  without `-Execute` renders `update-access-default.json` for the new
  account and prints the `update_access` command to run (with `-Execute` it
  refuses, because the row exists).

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

### fly.toml

Save this as `apps/relayer/fly.toml`. It holds no secrets and serves both
apps (the app name comes from `-a`):

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

Copy `apps\relayer\.env.example` to a git-ignored file
(`apps\relayer\.env.fly-testnet` matches `.env*` in `.gitignore`) and set:

| Variable | Testnet | Mainnet | Where the value comes from |
| --- | --- | --- | --- |
| `NETWORK` | `testnet` | `mainnet` | |
| `NEAR_RPC_URL` | `https://rpc.testnet.near.org` | `<rpc-url>` | your RPC provider for mainnet |
| `RELAYER_ACCOUNT_ID` | `<relayer>.testnet` | `relayer.<owner>.near` | part 1, step M1 |
| `RELAYER_PRIVATE_KEY` | `ed25519:...` | `ed25519:...` | `near account export-account <relayer account> using-private-key network-config <network>` |
| `FAIRGROUND_CONTRACT` | `fairground.<owner>.testnet` | `fairground.<owner>.near` | `$FG`, step T5 |
| `USDC_CONTRACTS` | `usdc.fakes.testnet,3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | the contract's `allowed_quote_tokens`; the first entry must be the web app's USDC |
| `CORS_ORIGINS` | `https://<web-testnet>.vercel.app` | `https://<web-pilot>.vercel.app` | the Vercel production URL (part 4): exact origin, no trailing slash; add a custom domain after a comma |
| `CLIENT_IP_HEADER` | `fly-client-ip` | `fly-client-ip` | set by Fly's proxy |
| `TRUSTED_PROXY_HOPS` | `1` | `1` | default |
| `DAILY_BUDGET_NEAR` | `5` | `2` | hard cap per UTC day on relay spend |
| `STORAGE_BUDGET_NEAR` | `0.5` | `0.2` | hard cap per UTC day on USDC registrations |
| `PORT` | `8787` | `8787` | must match `internal_port` |
| the rest | defaults from `.env.example` | same | |

### Deploy

```powershell
fly auth login
fly auth docker                                   # lets docker push to registry.fly.io
fly apps create <relayer-app-testnet>
Copy-Item apps\relayer\.env.example apps\relayer\.env.fly-testnet
notepad apps\relayer\.env.fly-testnet             # fill in the table above
Get-Content apps\relayer\.env.fly-testnet | Where-Object { $_ -match '^[A-Z_]+=.+' } | fly secrets import --stage -a <relayer-app-testnet>
Remove-Item apps\relayer\.env.fly-testnet
docker build -f apps/relayer/Dockerfile -t registry.fly.io/<relayer-app-testnet>:v1 .
docker push registry.fly.io/<relayer-app-testnet>:v1
fly deploy --config apps\relayer\fly.toml -a <relayer-app-testnet> --image registry.fly.io/<relayer-app-testnet>:v1 --ha=false
```

The `Where-Object` filter passes only `NAME=value` lines (no comments, no
empty values). `--ha=false` keeps one machine: a second one would double the
budgets and split the rate limits.

Success:

```powershell
fly status -a <relayer-app-testnet>                                # one machine, started
fly logs -a <relayer-app-testnet>                                  # {"msg":"listening","port":8787,"network":"testnet","relayer":"<relayer>.testnet"}
Invoke-RestMethod https://<relayer-app-testnet>.fly.dev/health     # ok True, network testnet, balance ok
Invoke-RestMethod https://<relayer-app-testnet>.fly.dev/policy     # fairground_contract = $FG
(Invoke-WebRequest -UseBasicParsing https://<relayer-app-testnet>.fly.dev/policy -Headers @{ Origin = 'https://<web-testnet>.vercel.app' }).Headers['Access-Control-Allow-Origin']
# prints https://<web-testnet>.vercel.app
```

If it fails:

- `invalid relayer configuration:` in the logs lists every bad variable. Fix
  each one, which restarts the machine:
  `'CORS_ORIGINS=https://<web-testnet>.vercel.app' | fly secrets import -a <relayer-app-testnet>`.
  For the key, use the file and pipe above rather than typing it.
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

pnpm is pinned because the lockfile was written by pnpm 12.3.4 (the root
`package.json` `packageManager`); an older pnpm may not read it. These
commands were not run on Vercel.

Environment variables:

| Variable | `<web-demo>` | `<web-testnet>` | `<web-pilot>` | Where the value comes from |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_FAIRGROUND_CONTRACT` | not set | `fairground.<owner>.testnet` | `fairground.<owner>.near` | `$FG` (T5, M2) |
| `NEXT_PUBLIC_NEAR_NETWORK` | not set | `testnet` | `mainnet` | |
| `NEXT_PUBLIC_NEAR_RPC_URL` | not set | optional, default `https://rpc.testnet.near.org` | `<rpc-url>` | your RPC provider |
| `NEXT_PUBLIC_USDC_CONTRACT` | not set | optional, default `usdc.fakes.testnet` | optional, default `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | must be in the contract's `allowed_quote_tokens` and first in the relayer's `USDC_CONTRACTS` |
| `NEXT_PUBLIC_RELAYER_URL` | not set | `https://<relayer-app-testnet>.fly.dev` | `https://<relayer-app-mainnet>.fly.dev` | part 3 (no trailing slash) |
| `NEXT_PUBLIC_SEALER_CODE_HASH` | not set | `f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb` | same | `$SHA`; without it the code-hash check cannot pass |
| `NEXT_PUBLIC_DEV_ACCOUNTS` | never | never | never | sandbox only; its keys would ship to every visitor |
| `ONECLICK_JWT` | the 1Click key | same | same | partners.near-intents.org. Server only (the `/api/oneclick/*` routes); mark it Sensitive |
| `ONECLICK_REAL_SWAPS` | not set | not set | `1` when the owner enables 1Click funding | Server only. Requires mainnet and Circle's native USDC. See M6. |

Checks after each deploy, on the production URL:

- `<web-demo>`: the footer reads "Sealround is unaudited. In this demo the
  chain is simulated in your browser." Judge mode reaches a result in under
  2 minutes in a fresh browser (time it). `/arena`, `/how` and `/create`
  render, also at phone width.
  `https://<web-demo>.vercel.app/api/oneclick/tokens` returns a JSON list.
- `<web-testnet>`: the footer reads "Sealround runs on NEAR testnet.
  Unaudited." The smoke sale from T6 is listed. In the browser's network tab,
  `GET <relayer>/policy` returns 200 with no CORS error. Part 5 tests bidding.
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
- T6: `get_create_cost` is about 1.73 NEAR on mainnet.
- T7 `-Phase Bid`: leave out `-GetTestUsdc` (mainnet has no test USDC). The
  bid uses 1 USDC of yours, and the sale settles it as on testnet.
- The attestation check compares the measurements with
  `worker.outlayer.near`.

### M3. Lock before anything is announced

Step T8 with the mainnet variables, after T7 passes and before the pilot sale
is created or announced.

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

Live swaps are off by default. To enable them, set the server-only
`ONECLICK_REAL_SWAPS=1` on `<web-pilot>` and redeploy. The app must be
configured for NEAR mainnet and Circle's native USDC. Check that
`GET /api/oneclick/config` returns `{"liveSwaps":true}` for the pilot and
`{"liveSwaps":false}` for the demo and testnet.

The funding panel previews the price with a dry quote. A connected bidder
enters an origin-chain refund address and requests a separate deposit quote.
The panel shows the exact amount and asset, the 1Click deposit address, and
the deadline. The bidder sends the transfer from their own origin-chain
wallet. Sealround polls 1Click for delivery or refund status.

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

Run the openly announced bot if it is ready: `apps/web/scripts/live-bot`
(its CLI was still being written on 11 Nov; see the header of `bot.ts`).
Screen-record the window.

### M9. Close, verify, claim

After `bid_end` (anyone can close; the closer attaches `get_close_deposit`,
0.01401 NEAR for 50 bids, and OutLayer refunds what it does not charge):

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network mainnet -Account $ME -SaleId pilot -Phase Close -Execute
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
| Clear failed, sale `"closed"` | read `execution_completed`'s `error_message` (README 10) and close again (`7-smoke-clear.ps1 -Phase Close` or the app) |
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
- [ ] Contracts locked: `near account list-keys fairground.<owner>.testnet network-config testnet now`
      and the same for `fairground.<owner>.near` on mainnet list no keys.
- [ ] Hosted demo up: judge mode on `<web-demo>` under 2 minutes from a
      fresh browser; `<web-testnet>` lists sales; the relayer's `/health` says
      `ok`. All of it stays up through 18 Nov (ideally 25 Nov).
- [ ] README links: demo URL, testnet URL, contract accounts, pilot
      transaction links, `$SHA` with its source commit.
- [ ] Mainnet NEAR account ready for the prize payout.
- [ ] Code from before 19 Oct (openlaunch) separated by a branch or tag, with
      a diff link.
- [ ] Video recorded; X post with `@NEARProtocol` and `#NEARHackathon`.
- [ ] Exactly one submission at nearhackathon.com/#apply.
- [ ] `outlayer logout` on any shared machine.
