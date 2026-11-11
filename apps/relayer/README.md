# @fairground/relayer

A small gas relayer for Sealround. Bidders sign a NEP-366 meta transaction (a
`SignedDelegate`) in their wallet; the relayer wraps it in a transaction of its
own and pays the gas. It also pays the one-time USDC storage registration for a
new bidder. It keeps nothing but rate-limit counters, the accounts it sponsored
and the day's spend, in memory.

It is a [Hono](https://hono.dev) app, so the same code runs as a plain Node
server, as a Vercel Function or inside a Next.js route handler.

## What it pays for

Under NEP-366 the relayer pays the gas **and every deposit attached to the
inner calls**: nearcore charges the outer signer for them, while the inner
call's predecessor is still the user. (The project spec says the 1 yoctoNEAR of
`ft_transfer_call` comes from the bidder; on protocol 88 it does not. The
sandbox test checks that the bidder's NEAR balance does not move at all.) So
every allowed call has an exact deposit, and nothing payable is relayed:

| Delegate receiver | Method | Deposit (paid by the relayer) | Arguments, exactly |
| --- | --- | --- | --- |
| `FAIRGROUND_CONTRACT` | `claim` | 0 | `{sale_id, bidder?}` |
| `FAIRGROUND_CONTRACT` | `claim_proceeds`, `clear_onchain`, `trigger_refund_mode` | 0 | `{sale_id}` |
| `FAIRGROUND_CONTRACT` | `reveal_bid` | 0 | `{sale_id, max_price, max_spend, salt}` |
| one of `USDC_CONTRACTS` | `ft_transfer_call` | 1 yoctoNEAR | `{receiver_id: FAIRGROUND_CONTRACT, amount, msg}` with `msg` exactly `{"sale_id", "ciphertext"}` (canonical base64 of exactly the sealed-bid length, see below) or `{"sale_id", "commitment"}` (64 hex), the contract's own rules |

`close_sale`, `retry_setup` and `create_sale` are payable, so they stay normal
wallet transactions (otherwise the relayer would fund OutLayer and storage).
`clear_onchain` (commit-reveal: clear the sale once the reveal window has
ended) takes no deposit and anyone may push it, so it is relayed. The client
attaches 150 TGas, exactly the default `MAX_GAS_TGAS`: with 500 revealed bids
the call burns 51.2 TGas for a usual book and 102.8 TGas when every max price
is `u128::MAX`, the longest search measured (contracts/GAS.md, "Clearing on
chain").

Arguments must be the exact text `JSON.stringify` writes: no byte-order mark,
no duplicate keys, no extra whitespace. JSON.parse and the contracts' serde
would read anything else differently, and near-api-js and NEAR Connect wallets
always write it this way.

A sealed bid has one exact length. The ciphertext must decode to
`sealedBidLength(sale_id, sender)` bytes: 224 plus the byte lengths of the sale
id and of the delegate's sender, who is the bidder (`src/policy.ts`,
`SEALED_BID_FIXED_BYTES`). That is `fairground_clearing::sealed_bid_len`
(crates/clearing/src/sealed_bid.rs): the canonical bid with both amounts
zero-padded to 39 digits is 176 bytes plus the two ids, and the sealed box adds
48. The contract enforces the same length and refunds any other with
`bid_rejected`, reason `wrong_ciphertext_length`; the relayer refuses it with
the same code before paying. `test/sealed-bid.test.ts` checks the formula
against every row of crates/sealer/tests/fixtures/canonical_bids.json and
against real libsodium boxes.

Also on every delegate: 1 or 2 FunctionCall actions, at most `MAX_GAS_TGAS`
in total, a sender other than the relayer, and valid account ids. It must have
5 to `MAX_DELEGATE_BLOCKS` blocks left before `max_block_height`, and a nonce
below `head * 10^6`. On chain, the signing key must belong to the sender and the
nonce must be unused. A bid carries a deposit, so it needs a **full-access
key**: a function-call key gets `DepositWithFunctionCall`. A function-call key
may sign one zero-deposit call within its permission (for example `reveal_bid`).

Before paying, it reads the contract state and refuses a call that would fail
or do nothing now (`preflight.ts`): a bid needs an open sale quoted in that
USDC, the payload kind the sale's mode takes, and a USDC balance of at least
the amount (an unregistered account reads as 0). A claim needs a final sale and
an unpaid bid; `claim_proceeds` a final sale; a reveal an unrevealed bid of the
sender inside the reveal window; `clear_onchain` a sale whose status is
`revealing` at a head time at or past `reveal_end` (so it is refused while the
window is open, and again once someone has cleared the sale);
`trigger_refund_mode` a sale past `refund_mode_at`. Rules Sealround answers
with a `bid_rejected` event and a refund (deposit limits, already bid, sale
full) are left to the contract, which tells the bidder why.

`POST /storage` calls `storage_deposit({account_id, registration_only: true})`
from the relayer's own account, so a NEP-145 refund comes back to the relayer.
It attaches exactly `storage_balance_bounds().min`, and only for an existing
account that is not yet registered.

## What it refuses

Every refusal is checked before anything is sent and costs the relayer nothing.
A failed delegate still costs gas once relayed, which is why each check below
exists. Codes are listed in `src/api.ts`:

- request: `bad_request`, `body_too_large` (over 8 KB)
- decoding: `bad_encoding` (not base64, not borsh, trailing bytes, non-canonical, invalid account ids), `unsupported_key_type` (not ed25519), `action_not_allowed` (any non-FunctionCall action: transfer, add/delete key, deploy, stake, nested delegate), `bad_signature`
- policy: `sender_is_relayer`, `no_actions`, `too_many_actions`, `receiver_not_allowed`, `method_not_allowed`, `wrong_deposit`, `gas_too_high`, `bad_transfer_args`, `transfer_not_to_fairground`, `bad_bid_msg`, `wrong_ciphertext_length` (a sealed bid that is canonical base64 but not the length the contract takes for this sale id and sender), `bad_call_args`, `expired`, `validity_too_long`, `nonce_too_large`
- the key: `unknown_access_key` (also a sender that does not exist), `nonce_already_used` (replay), `needs_full_access_key`, `key_not_allowed`
- contract state: `unknown_sale`, `wrong_phase`, `wrong_quote_token`, `wrong_payload`, `insufficient_balance`, `no_bid`, `already_claimed`, `already_revealed`
- storage: `unknown_account`, `unknown_token`
- limits: `rate_limited` (429), `sender_busy` (409: one relay per sender in flight), `budget_exhausted` (503)
- submission: `relay_failed` (502: the RPC refused the transaction, or a storage_deposit failed), `internal_error` (500)

The checks run in this order: everything that needs no RPC call first, then the
key (one RPC call), then contract state, and a counter that could lock someone
out is touched only once the request is proven to come from them and the
relayer is about to pay.

## API

All bodies are JSON with snake_case fields. Amounts are decimal strings in
yoctoNEAR or gas. Every response has an `x-request-id` header; errors are
`{"error": <code>, "request_id": "..."}`. Types: `src/api.ts` (importable as
`@fairground/relayer/api`).

- `POST /relay` with `{"signed_delegate": "<base64(borsh(SignedDelegate))>"}`, the string
  NEAR Connect's `signDelegateActions` returns (and near-api-js `encodeSignedDelegate`).
  - `200 {"tx_hash", "status": "succeeded" | "failed", "outcome": {"failures", "events", "relayer_cost"}}`
  - `202 {"tx_hash", "status": "pending", "outcome": null}` when the transaction is in a block
    but its outcome took longer than `RELAY_WAIT_MS`
  - The top-level status of a relayed transaction is `SuccessValue("")` even when the
    inner call fails, so `status` is computed from every receipt. `succeeded` does not
    mean a bid was accepted: Sealround refunds a refused bid without failing. Read
    `events` (`bid_placed`, or `bid_rejected` with its `reason`), or `get_bid`. Events
    come only from Sealround receipts that succeeded.
- `POST /storage` with `{"account_id", "token_id"?}` returns `{"status": "registered" | "already_registered" | "pending", "token_id", "tx_hash"?}`
- `GET /policy`: the receivers, methods, deposits and limits above, so the app can build matching delegates
- `GET /health`: `{"ok", "network", "balance": "ok" | "low" | "empty" | "unknown", "budget_exhausted"}` (503 when not ok); the exact balance is not exposed, and it is read at most every 15 s

```sh
curl -s localhost:8787/policy
curl -s -X POST localhost:8787/relay -H 'content-type: application/json' -d '{"signed_delegate":"..."}'
```

## Configuration

Environment variables, checked at startup. Every problem is listed at once, and
the key's value never appears. See `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NETWORK` | required | `sandbox`, `testnet` or `mainnet` |
| `NEAR_RPC_URL` | required | JSON-RPC endpoint |
| `RELAYER_ACCOUNT_ID` | required | the paying account |
| `RELAYER_PRIVATE_KEY` | required | its full-access `ed25519:` secret key |
| `FAIRGROUND_CONTRACT` | required | Sealround contract account |
| `USDC_CONTRACTS` | required | comma-separated; the first is the `/storage` default |
| `RELAYS_PER_SENDER_PER_HOUR` | 30 | relays the relayer pays for per sender; refusals do not count, so nobody but the sender can use them up |
| `REQUESTS_PER_IP_PER_HOUR` | 120 | every POST, before any decoding |
| `STORAGE_PER_IP_PER_DAY` | 3 | registrations paid per IP; plus once per account per 30 days |
| `DAILY_BUDGET_NEAR` | 5 | hard cap per UTC day on what relays cost (gas burnt + deposits) |
| `STORAGE_BUDGET_NEAR` | 0.5 | hard cap per UTC day on storage registrations, apart from the relay budget so they cannot starve bids (about 350 registrations) |
| `MAX_GAS_TGAS` | 150 | per delegate, 1..300; the largest calls the client builds (`claim_proceeds`, `clear_onchain`) attach exactly 150, so a lower cap refuses them with `gas_too_high` |
| `MAX_DELEGATE_BLOCKS` | 1200 | most blocks a delegate may have left (Ledger signs with 900, near-api-js with 200) |
| `RELAY_WAIT_MS` | 15000 | how long to wait for the outcome once the transaction is in a block, before answering 202; 0 answers as soon as it is |
| `PORT` | 8787 | Node server port |
| `CORS_ORIGINS` | none | browser origins allowed to call it |
| `CLIENT_IP_HEADER` | none | behind a proxy, the header carrying the client IP (see Deploying) |
| `TRUSTED_PROXY_HOPS` | 1 | how many of your proxies append to `CLIENT_IP_HEADER`; the client is that many entries from the right |

IPv6 clients count per /64 (one subscriber usually holds a whole /64), and an
IPv4-mapped address counts as its IPv4 address.

## Running

From the repo root:

```powershell
pnpm install
pnpm --filter @fairground/relayer typecheck
pnpm --filter @fairground/relayer test          # unit tests (the sandbox suite is skipped)
pnpm --filter @fairground/relayer test:sandbox  # end to end on a fresh local chain
```

`test:sandbox` runs `scripts/test-sandbox.ps1`. It starts the relayer's own
sandbox (`scripts/sandbox.ps1`: Docker container `near-sandbox-relayer`, RPC
on 127.0.0.1:3040, separate from the contracts sandbox on 3030). It deploys
`contracts/res/fairground.wasm`, `mock_ft.wasm` (as USDC) and
`outlayer_contract.wasm`, opens a commit-reveal sale, runs the suite, then
removes the container. One test also creates a TEE sale, answers OutLayer's
key request as its worker would, relays a sealed bid of the exact length, and
checks that the contract refunds one that is a byte short with
`wrong_ciphertext_length`. The relayed `clear_onchain` (reveal, clear, claims)
runs in the client's suite: `pnpm --filter @fairground/relayer-client test:sandbox`. Pass
`-SandboxBin <path>` if the binary is not at `.sandbox-bin/2.14.0/Linux-x86_64/near-sandbox`.

Run the server against a local chain, from `apps/relayer` (the wasm files in
`contracts/res` come from the repo's `scripts/build-contracts.ps1`):

```powershell
cd apps/relayer
powershell -ExecutionPolicy Bypass -File scripts/sandbox.ps1   # chain on 127.0.0.1:3040
node scripts/dev-chain.ts      # relayer account, mock USDC, Sealround; writes .env.sandbox
pnpm dev:sandbox               # the relayer on :8787 with .env.sandbox
powershell -ExecutionPolicy Bypass -File scripts/sandbox.ps1 -Stop   # when done
```

The local Sealround instance has no OutLayer, so only commit-reveal sales work there,
and anyone can mint the mock USDC (`mint({account_id, amount})`).

Against testnet, from `apps/relayer`:

```powershell
cd apps/relayer
Copy-Item .env.example .env    # then fill it in (git-ignored)
pnpm dev                       # node --watch src/main.ts (Node 24 strips the types)
pnpm build                     # tsc to dist/
pnpm start                     # node dist/main.js
```

Create a dedicated account (for example `fairground-relayer.testnet`), fund it,
and point the variables at `fairground.testnet` and the testnet USDC ids. At
startup the server refuses to run unless the key is a full-access key of that
account.

## Deploying

- **Any Node host** (Fly, Railway, a VM): `pnpm build && pnpm start` with the
  variables set. Put it behind TLS. Without `CLIENT_IP_HEADER` the relayer
  limits by the socket address, which behind a proxy is the proxy, so every
  caller would share one bucket.
- **Client IP behind a proxy.** Prefer a single-value header the proxy
  overwrites: `x-real-ip` on Vercel, `fly-client-ip` on Fly, `cf-connecting-ip`
  behind Cloudflare. With `x-forwarded-for`, only the entries your own proxies
  appended can be trusted; everything to their left is whatever the client
  wrote. So the relayer takes the entry `TRUSTED_PROXY_HOPS` from the right (the
  right-most with one proxy) and never the left-most. A value that is not one IP
  address counts as no address (one shared bucket).
- **Vercel Function** (not deployed yet; this is the shape): the app is a
  standard fetch handler.
  ```ts
  // api/[[...route]].ts in a Vercel project rooted at apps/relayer
  import { Hono } from "hono";
  import { createRelayer, loadConfig } from "../src/lib.ts";
  const app = new Hono().basePath("/api").route("/", createRelayer(loadConfig(process.env)));
  export const GET = (request: Request) => app.fetch(request);
  export const POST = (request: Request) => app.fetch(request);
  ```
  Set `CLIENT_IP_HEADER=x-real-ip`. Limits and budgets live in memory, so they
  apply per function instance and reset on cold starts. Plug shared stores into
  `Limiters` (`RateLimitStore`, `SponsorLedger`: Upstash, Vercel KV) for global
  limits.
- **Next.js route handler** (`app/api/relayer/[[...route]]/route.ts`): mount the
  app under a base path with `new Hono().basePath("/api/relayer").route("/", app)`
  and export `GET`/`POST` as `(req: Request) => app.fetch(req)`, with
  `runtime = "nodejs"`. That puts the relayer key in the web app's environment,
  so a separate deployment is preferable.

## Security notes

- **Dedicated account, small balance.** The relayer key can spend everything on
  its account, so the account should hold only working funds, topped up as
  needed. Each transaction in flight needs `attached gas x 1e9` yocto (protocol
  88 sells prepaid gas at no less than 1e9 yocto/gas): 0.1 NEAR for a bid, 0.15
  for the largest call at the default `MAX_GAS_TGAS`. The unused part comes back
  in refund receipts a few blocks later, so keep about (relays in flight at
  once) x 0.15 NEAR plus a margin. A relay the RPC refuses for lack of balance
  costs nothing and answers `relay_failed`, on which the client pays itself.
  `/health` reports `empty` below 0.5 NEAR.
- **Why a full-access key.** The outer transaction carries a `Delegate` action
  and goes to whichever account signed the delegate. `storage_deposit` attaches
  NEAR. A function-call key can sign neither.
- **Rotate** by adding a new full-access key to the relayer account, switching
  `RELAYER_PRIVATE_KEY`, then deleting the old key. A leaked key costs at most
  the account's balance, which is why the balance stays small.
- **Budget caps.** `DAILY_BUDGET_NEAR` and `STORAGE_BUDGET_NEAR` are hard
  stops. Each transaction reserves its worst case (attached gas x gas price +
  5 TGas overhead + deposits) before it is sent, and is settled to the real cost
  from the outcome's `tokens_burnt` plus deposits. An outcome that never arrives
  stays counted at its worst case. They live in memory, so a restart resets them.
- **Cost per action** (sandbox, gas price 1e8): a bid relay costs about
  0.00075 NEAR, and a USDC registration about 0.0014 NEAR (0.00125 of it is the
  storage deposit).
- **Limits cannot be spent by someone else.** The per-sender quota counts only
  relays the relayer pays for, after the sender's own key and a fresh nonce
  passed, so forged or replayed delegates in someone's name cost them nothing.
  A storage request takes the account's once-per-30-days slot only when the
  registration is sent, and gives it back if the RPC refuses it.
- **Limit stores.** Each limit has its own store, so flooding one cannot reset
  another. The per-IP store gets a key for every POST, so when full (100,000
  addresses) it drops its oldest window; the others only get a key just before
  the relayer pays and, when full, refuse rather than forget a live window.
- **Storage sponsorship can still be farmed a little.** Anyone can ask for any
  existing, unregistered account, and `storage_unregister` refunds the deposit
  to that account. The once-per-account and per-IP limits and the separate
  storage budget bound the loss, and bids keep their own budget. A restart
  forgets which accounts were sponsored. A NEP-413 proof of account ownership
  would close it.
- **Signatures** are checked with the cofactorless ed25519 equation nearcore
  uses (OpenSSL through node:crypto), not near-api-js's cofactored
  `PublicKey.verify`, which also accepts signatures nearcore refuses.
- **Privacy.** Request bodies carry sealed bids. They are parsed in memory and
  never stored or logged. Log lines have a fixed set of fields (`src/log.ts`):
  request id, endpoint, decision, reason code, account (only once the account's
  own key is proven, or the account being registered), tx hash, status, cost,
  error, duration. IPs are kept only as salted hashes inside the rate-limit
  keys, with a salt that is random per process.
