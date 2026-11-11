# Sealround web app

The Next.js app for Sealround: sealed-bid, single-price token sales on NEAR.
It runs in one of two modes, chosen at build time by one variable.

| | Mock mode (default) | NEAR mode |
| --- | --- | --- |
| Switched on by | nothing: `NEXT_PUBLIC_FAIRGROUND_CONTRACT` is not set | `NEXT_PUBLIC_FAIRGROUND_CONTRACT=<contract account>` |
| Chain | simulated in the browser (`src/lib/client/mock.ts`), state in localStorage | the deployed contract, read over JSON-RPC |
| Wallet | a simulated guest account with 100 test USDC | NEAR Connect (HOT, Meteor, Intear, MyNearWallet, ...), or dev keys on a local sandbox |
| Gas | none | paid by the relayer when it can, else by the user |
| Judge mode, demo sales, "Reset demo data" | yes | no |
| Needs | nothing | a deployed contract; a relayer for gasless calls |

Every page uses one interface, `FairgroundClient` (`src/lib/client/index.ts`),
so the pages do not know which mode they are in unless they ask
(`getClient().mode`, `getClient().capabilities`).

## Run it

```powershell
pnpm install          # from the repo root
pnpm --filter web dev # http://localhost:3000, mock mode
```

Checks (from `apps/web`):

```powershell
npx tsc --noEmit --incremental false
npx eslint src
pnpm test             # vitest: the data layer in src/lib
```

## Mock mode

What is real: every bid is sealed in the browser with a libsodium sealed box,
with the same padded plaintext and the same exact ciphertext length the
contract enforces; the clearing algorithm is the shared `@fairground/clearing`
package; the bid-set hash and commit-reveal commitments are the contract's v1
formulas; the mock applies the contract's rules (the rejection reasons, the
result checks, the 1 % penalty on invalid bids, the 1 USDC minimum deposit,
sale id rules, commit-reveal with on-chain clearing).

What is simulated: the chain itself, transaction hashes, the enclave (its key
sits in this browser), the TDX attestation, test USDC, and the relayer (every
call counts as gasless). The UI labels all of it.

State is kept in localStorage under `fairground:mock:v2`. "Reset demo data" in
the sidebar wipes it.

## NEAR mode

Copy `.env.example` to `.env.local`, set the variables, and restart the dev
server. Every variable is documented in `.env.example`; in short:

| Variable | Meaning |
| --- | --- |
| `NEXT_PUBLIC_FAIRGROUND_CONTRACT` | the contract account; setting it switches NEAR mode on |
| `NEXT_PUBLIC_NEAR_NETWORK` | `testnet` (default), `mainnet` or `sandbox` |
| `NEXT_PUBLIC_NEAR_RPC_URL` | JSON-RPC endpoint for views |
| `NEXT_PUBLIC_USDC_CONTRACT` | the USDC (NEP-141) contract; required on a sandbox |
| `NEXT_PUBLIC_RELAYER_URL` | the gas relayer; without it every call is paid by the user |
| `NEXT_PUBLIC_SEALER_CODE_HASH` | sha256 of the reproducible sealer build, to compare with the contract's |
| `NEXT_PUBLIC_DEV_ACCOUNTS` | sandbox only: accounts and their secret keys, used instead of a wallet |

An unusable value stops the app with a message that names the variable.

### Reads

Views go straight to the RPC node with `fetch` (`src/lib/near/rpc.ts`) and are
translated in `src/lib/near/views.ts`. Results are reused for 3 seconds, so
the pages' one-second polling does not become one RPC call per second.

The contract has no event view. The timeline on a sale page is derived from
the views (`eventsFromViews`): creation, every bid and the close carry their
real block times; reveals, the outcome, claims and creator payouts are visible
in the views but not timed there, so those rows are marked approximate.
Transaction hashes, and bids the contract returned, are known only for calls
this browser sent (kept in localStorage under `fairground:txlog:v1`).

### Writes and the relayer

The relayer (`apps/relayer`) pays the gas of the calls that attach no NEAR:
bids (a USDC `ft_transfer_call`, whose 1 yoctoNEAR the relayer also pays),
claims, reveals, `clear_onchain`, `claim_proceeds` and `trigger_refund_mode`.
The wallet signs a NEP-366 delegate; the relayer submits it.

The app pays with the user's wallet instead, and says so first, when:

- the wallet cannot sign delegates (MyNearWallet, OKX, Nightly, ...);
- the relayer cannot be reached, or its policy does not cover the call (the
  app asks `GET /policy` before anything is signed);
- the relayer refuses for a reason of its own: rate limit, daily budget used
  up, its transaction not accepted;
- no relayer is configured.

Bids need a wallet that signs with a full-access key, because they move USDC.

`create_sale`, `close_sale` and `retry_setup` attach NEAR and are always
normal wallet transactions. The app reads the amount from the contract first
(`get_create_cost`, `get_close_deposit`).

A call is never sent twice. If the relayer's answer is lost, the app polls the
contract (`get_bid`, `get_sale`) and either finds the call landed or reports
that it may still land; it does not resend by itself, and the UI must not
offer a paid retry until the chain shows the call did not land.

Commit-reveal bids need their salt to be revealed. It is saved in this
browser before the bid is sent (`src/lib/bid-secrets.ts`, localStorage key
`fairground:bid-secrets:v1`) and can be exported to a file and imported on
another device. A bid that is not revealed pays the 1 % penalty.

### What NEAR mode does not have

- Judge mode and the demo sales: they need the simulated chain.
- A fresh attestation fetch: the "Verified" data comes from what the contract
  stored (the pinned code hash, the sale key, the sha256 of the clearing input
  and of the enclave's answer). No TDX quote is fetched.
- Real 1Click swaps: quotes are live, the swap itself is still simulated and
  ends by minting test USDC (testnet and sandbox only).
- The time a sale settled, and transaction hashes of other people's calls: the
  views do not hold them.

## Local sandbox

For development against a real contract on this machine, without a wallet:

1. Build the contracts (`scripts/build-contracts.ps1`) and start a chain and a
   relayer. `apps/relayer/README.md` has a ready recipe: its `sandbox.ps1`
   starts a chain on 127.0.0.1:3040, `node scripts/dev-chain.ts` deploys the
   mock USDC and the Sealround sale contract and writes `apps/relayer/.env.sandbox`, and
   `pnpm dev:sandbox` runs the relayer on :8787. That chain has no OutLayer,
   so only commit-reveal sales complete on it.
2. Create one or more accounts with full-access keys on that chain and mint
   them mock USDC (`mint({account_id, amount})` on the USDC account is open).
3. In `apps/web/.env.local`:

   ```ini
   NEXT_PUBLIC_FAIRGROUND_CONTRACT=<FAIRGROUND_CONTRACT from .env.sandbox>
   NEXT_PUBLIC_NEAR_NETWORK=sandbox
   NEXT_PUBLIC_NEAR_RPC_URL=http://127.0.0.1:3040
   NEXT_PUBLIC_USDC_CONTRACT=<USDC_CONTRACTS from .env.sandbox>
   NEXT_PUBLIC_RELAYER_URL=http://127.0.0.1:8787
   NEXT_PUBLIC_DEV_ACCOUNTS=<account>=ed25519:<secret>,<account>=ed25519:<secret>
   ```

4. Restart the dev server. "Connect" signs in the first dev account;
   `useWallet().connectDev(accountId)` switches to another.

Dev accounts are plain secret keys in the browser bundle. The app uses them
only when the network is `sandbox` and the RPC URL is on `localhost` or
`127.0.0.1`; anywhere else they are dropped when the config is read
(`src/lib/config.ts`) and refused again when a signer is built
(`src/lib/near/dev-signer.ts`). Tests cover both. Never put a testnet or
mainnet key in `NEXT_PUBLIC_DEV_ACCOUNTS`.

The same client runs outside the browser, which is how scripts drive it:

```ts
import { NearClient } from "./src/lib/client/near";
import { parseConfig } from "./src/lib/config";
import { devSigners } from "./src/lib/near/dev-signer";

const config = parseConfig({ NEXT_PUBLIC_FAIRGROUND_CONTRACT: "...", NEXT_PUBLIC_NEAR_NETWORK: "sandbox", /* ... */ });
if (config.mode !== "near") throw new Error("set the contract");
const client = new NearClient(config.near, { signers: devSigners(config.near), cacheMs: 0 });
```

## Where things are

| Path | What |
| --- | --- |
| `src/lib/config.ts` | reads the `NEXT_PUBLIC_*` variables; mock or NEAR mode |
| `src/lib/client/index.ts` | `FairgroundClient`, `getClient()` |
| `src/lib/client/mock.ts` | the simulated chain |
| `src/lib/client/near.ts` | the NEAR client (loaded on demand in NEAR mode) |
| `src/lib/client/rules.ts` | the contract's rules both clients share |
| `src/lib/client/errors.ts` | `FairgroundError`, messages for every rejection and relayer refusal |
| `src/lib/near/` | RPC reader, view translation, signers, dev signer, local transaction log |
| `src/lib/crypto.ts` | bid sealing (padded plaintext), commitments |
| `src/lib/bid-secrets.ts` | commit-reveal salts kept in the browser |
| `src/lib/wallet.tsx` | wallet context: demo account, NEAR Connect, dev accounts |
| `src/lib/oneclick.ts` | 1Click quotes, simulated funding, USDC storage registration |
| `src/lib/__tests__/` | vitest suites, including byte parity with the Rust sealer |
| `UI-DIRECTION.md` | the design brief |
