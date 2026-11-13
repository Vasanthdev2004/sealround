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

`http://localhost:3000` is the landing page; the app's sales board is at
`/sales`. `http://app.localhost:3000` is the app host: the same deployment
with the sales board at `/`. Every other page (`/sale/<id>`, `/token/<id>`,
`/create`, `/judge`, `/arena`, `/how`) has the same path on both hosts.

## Routes

| Group | Layout | Pages |
| --- | --- | --- |
| `src/app/(site)` | `SiteShell`: slim bar, footer | `/`, the landing page (`components/site`) |
| `src/app/(app)` | `AppShell`: app bar, wallet, page transition | `/sales`, `/sale/[id]`, `/sale/[id]/result`, `/sale/[id]/kit`, `/token/[id]`, `/create`, `/judge`, `/arena`, `/how`, `/lab` |
| `src/app/deploy` | its own page, no shell | `/deploy` |
| `src/app/api` | route handlers | `/api/oneclick/*` (1Click proxy), `/api/og/bid`, `/api/og/win`, `/api/og/countdown` (share card images, see Share cards), `/api/deploy/wasm` (dev server only) |

`/sale/[id]/kit/share-card` is a route handler too: the sale's link preview
as a PNG for the launch kit's download button.

What each page has:

| Page | What is on it |
| --- | --- |
| `/` | The landing page, including the burn counter "Demand sets the supply.": the average share of supply burned per launch over the newest 20 final sales, failed sales counted apart, and the 5 newest launches linking their token pages (`components/burn`, `lib/burn-total.ts`) |
| `/sales` | The sales board (token icons; settled rows link their token page) and the fair-launch leaderboard: finished sales ranked by top 10 share, Gini or bots' share (mock only), with the burned share and the winners, refunded sales listed last without a rank (`components/home`) |
| `/sale/[id]` | The rules, countdown and status (add the reveal to a calendar as an `.ics` file, copy the watch link; at close "Opening N sealed bids in the enclave", then on to the result), the demand panel (deposits against the min raise and a sell-out at the floor, bids over time, the sealed-bid size check), the sealed bid form, after a bid the "I'm in" share block, funding from another chain, where's-my-money and the event log. "Launch kit" in the header for the connected creator while the sale is upcoming or open. After the creator payout, the burn moment shows the amount burned and the supply left, once the views confirm the burn. After close, the Bid set panel: the frozen bid-set hash recomputed in the browser from `get_bids`, and "your bid is #k of N" for any account |
| `/sale/[id]/result` | The reveal (four steps from the sealed bids to one price, played once per browser, then shown at rest), the fairness timeline (when each bid landed in the window and what each winner paid per token; max prices stay sealed), Share on X, your result and claims (a winner gets "Share your win", the winner card), "Where every token went" (the supply at launch and after, every part, the mint and burn log), the launch pool panel for a sale with launch liquidity (Trade on Rhea once seeded), the Verified panel, every fill, and the fair-launch scorecard against the Bot Arena's simulated launches |
| `/sale/[id]/kit` | The creator's launch kit, public for anyone: key times in UTC and the viewer's zone, add the reveal to a calendar, the countdown image and the link preview with PNG downloads, three posts for X with their lengths counted the X way, the watch link, a QR code of the sale URL (PNG and SVG, made in the browser with `qrcode-generator`) and what bidders need. `/create` opens it after a sale is created. A settled or failed sale gets "This sale is over" |
| `/token/[id]` | A token's page after its sale (id = sale id): launch price, pool opening price when seeded, Trade on Rhea, supply now, burned, holders at launch, raise, the burn line, the supply story and how it launched. Not settled, failed and unknown ids get their own states. Tab title "$SYMBOL on Sealround" |
| `/create` | Meme launch presets (Pure fair launch, Pool first, Community burn) with Undo, the sale form with the token icon picker (generated letters or emoji, or an upload shrunk to fit 2,048 bytes), the optional launch pool section, Simulate this launch, review and the cost check before signing |
| `/judge` | Judge mode: a seeded sale with 50 simulated bidders and 3 sniper bots, closed, cleared and settled in the browser. Mock mode only |
| `/arena` | Bot Arena: Sealround, a bonding curve and a first-come sale over the 60 seeded runs, the supply Sealround burned as demand changes, and one run you can repeat in the browser from a seed |
| `/how` | How a sale works, and its limits |
| `/lab` | Every control in every state, for design review. Not linked, noindex |
| `/deploy` | Owner tool for `LAUNCH.md` T5 and T8: create, deploy, check and lock the testnet contract. Dev server only (a production build answers 404), noindex |

"Simulate this launch" on `/create` runs the Bot Arena's crowd model
(`@fairground/arena`) against the creator's own rules, from half to four
times the demand that would buy every token at the floor, and shows what
sells, what burns, whether the min raise is met and what bots make. It runs
in the browser and is labelled a simulation in both modes.

The launch pool section on `/create` appears only when the contract's
`get_config` names a `dex` (always in mock mode). It sets the share of the
raise, the reserved tokens and the pool fee; after settlement anyone seeds
the pool at the clearing price from the result page (`contracts/DESIGN.md`,
"Launch liquidity").

`src/proxy.ts` rewrites `/` to `/sales` on any host that starts with `app.`.
When `NEXT_PUBLIC_APP_URL` is set, it also redirects app paths on the landing
host to the app host (see `.env.example` and `LAUNCH.md` part 4). Links
inside the app go to `/sales`, which works on both hosts.

Checks (from `apps/web`):

```powershell
npx tsc --noEmit --incremental false
npx eslint src scripts
pnpm test             # vitest: every src/**/*.test.ts
```

Do not run `pnpm build` or `pnpm typecheck` (it runs `next typegen`) while
`next dev` runs from this folder: they share `.next` and corrupt each other.

## Scripts

From the repository root. Each script runs the web app's own code from Node.

| Command | What it does |
| --- | --- |
| `pnpm --filter web dev` | The dev server on :3000 |
| `pnpm --filter web test` | vitest |
| `pnpm --filter web e2e:sandbox` | The whole local stack: a sandbox chain in Docker (`near-sandbox-web`, RPC on 127.0.0.1:3050), the real contract, OutLayer's contract with a stand-in worker running the pinned sealer, and the relayer on :8790. Runs every scenario through the NEAR client and exits 0 only if all pass. Needs Docker and the built `contracts/res` and `enclave/res` (header of `scripts/e2e/run.ts`) |
| `pnpm --filter web live-bot <command>` | The live sniper bot: `status`, `bid`, `snipe`, `copycat`, `report`, `reveal`, `result` (`scripts/live-bot/README.md`) |
| `pnpm --filter web verify-sale --contract <contract> --sale <sale id>` | Checks a sale's enclave runs and its bid set, read-only, with no key: the same checks as the Verified panel. Options: `--network testnet` (default) or `mainnet`, `--rpc <url>`, `--json`. Exit code 0 when every check passed, 1 when one failed or could not run, 2 on bad options |
| `pnpm --silent --filter web mcp` | A stdio MCP server that lets an AI agent read sales, place one sealed bid within a deposit cap, claim and verify a sale (`scripts/mcp/README.md`). `--silent` keeps pnpm's own output off stdout, which carries the protocol |

Their sandbox tests: `pnpm --filter web exec tsx scripts/live-bot/sandbox-test.ts`
and `pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts` (add `--offline`
for the MCP checks that need no chain). The agent skill
`skills/sealround-bid/SKILL.md` drives `live-bot bid` and `live-bot result`.

## Mock mode

What is real: every bid is sealed in the browser with a libsodium sealed box,
with the same padded plaintext and the same exact ciphertext length the
contract enforces; the clearing algorithm is the shared `@fairground/clearing`
package; the bid-set hash and commit-reveal commitments are the contract's v1
formulas; the mock applies the contract's rules (the rejection reasons, the
result checks, the 1 % penalty on invalid bids, the 1 USDC minimum deposit,
sale id rules, commit-reveal with on-chain clearing).

What is simulated: the chain itself, transaction hashes, the enclave (its key
sits in this browser), the TDX attestation, test USDC, the launch pool and its
exchange, and the relayer (every call counts as gasless). The UI labels all of
it. The Verified panel runs the same checks as in NEAR mode over a simulated,
unsigned attestation, with real sha256 over the simulated request and answer,
and labels every row simulated. The judge-mode sale opens a simulated launch
pool after it settles.

State is kept in localStorage under `fairground:mock:v2`. "Reset demo data" in
the page footer wipes it. A store from an older build gets the demo sales it
lacks (for example Thistle) on its next load.

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
`.env.example` has a ready block for the hosted testnet app.

In either mode, `NEXT_PUBLIC_APP_URL` is the app's own origin when the
landing page and the app run on two hosts (see Routes); it is also the base
of the share cards' URLs (see Share cards). The server-only `ONECLICK_*`
variables are under "Funding from another chain".

### Reads

Views go straight to the RPC node with `fetch` (`src/lib/near/rpc.ts`) and are
translated in `src/lib/near/views.ts`. Results are reused for 3 seconds, so
the pages' one-second polling does not become one RPC call per second.

The contract has no event view. The event log on a sale page is derived from
the views (`eventsFromViews`): creation, every bid and the close carry their
real block times; reveals, the outcome, claims, creator payouts and the launch
pool's stages are visible in the views but not timed there, so those rows are
marked approximate. Transaction hashes, and bids the contract returned, are
known only for calls this browser sent (kept in localStorage under
`fairground:txlog:v1`).

The fairness timeline on the result page uses only public data: each bid's
`placed_at` from `get_bids` and the fills from `get_fills`. A real contract
stores no bidder roles, so on chain its headline names the first and the last
winning bid; on the simulated chain it names a bot and a person.

### Writes and the relayer

The relayer (`apps/relayer`) pays the gas of the calls that attach no NEAR:
bids (a USDC `ft_transfer_call`, whose 1 yoctoNEAR the relayer also pays),
claims, reveals, `clear_onchain`, `claim_proceeds`, `trigger_refund_mode`,
and the launch pool's `seed_liquidity` and `abandon_liquidity`. The wallet
signs a NEP-366 delegate; the relayer submits it. A relayed pool call gets
150 TGas and runs one or two of the seeding steps, so a pool can take more
than one call; paid from the wallet it gets 300 TGas and runs them all. The
app relays a pool call only when the relayer's `GET /policy` lists the
method.

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

### The Verified panel

The result page checks each enclave run of the sale (the sale key and the
clearing) in the browser, read-only (`src/lib/near/attestation.ts`, a port of
`enclave/deploy/Verify-Attestation.ps1`). For each run it finds the
transaction, fetches OutLayer's attestation for it and checks eight things:
the attested build is the sealer the contract pins, the worker measured that
build, the input and output hashes match the chain, the TDX quote's report
data commits to this record, the enclave measurements are approved on
OutLayer's register contract (`worker.outlayer.testnet` / `.near`), the
request came from the sale contract for this sale, and the job's answer names
the sale's key. It then recomputes the frozen bid-set hash from every bid the
contract lists (`src/lib/bid-inclusion.ts`) and shows where any account's bid
sits in it. Not checked here: the quote's signature chain up to Intel; the
panel links OutLayer's verifier for that. OutLayer takes no nonce, so the
panel shows how fresh each run is instead (block, time).

The contract stores no transaction hashes, so `src/lib/near/attestation-sources.ts`
finds each run's transaction by scanning the block the contract recorded for
the request (`get_sale.key_request_block`, `get_result.clear_request_block`)
and the few before it, then this browser's transaction log, then OutLayer's
public job list for the sealer project; every candidate is confirmed from its
receipts. History calls fall back to an archival RPC node. On a local sandbox
there is no OutLayer service, so both runs show as not checked and only the
bid set is compared. `pnpm --filter web verify-sale` runs the same code from
the command line.

### What NEAR mode does not have

- Judge mode and the demo sales: they need the simulated chain.
- Bidder roles: the chain stores none, so the leaderboard drops the bots'
  share column and the result's scorecard says "Not on chain" for it.
- The time a sale settled, and transaction hashes of other people's calls: the
  views do not hold them.

### Funding from another chain

Preview quotes are dry. Mock, testnet and sandbox funding simulates the swap.
The server enables deposit quotes only when `ONECLICK_REAL_SWAPS=1`, the app
is configured for NEAR mainnet and Circle's native USDC, and the server has
`ONECLICK_RECEIPT_SECRET`, `ONECLICK_REDIS_URL`, and `ONECLICK_REDIS_TOKEN`.
Set these in the server environment. Use an Upstash Redis database shared by
all instances of the deployment. The proxy allows 40 calls per client and
300 in total per 60 seconds. Live requests stop if the quota store is
unavailable. Without Redis, only anonymous previews run under a local
limit. `ONECLICK_JWT` is optional and sent only with shared quotas.

An enabled swap requires a connected NEAR account that can receive USDC and
a refund address on the origin chain. The funding panel shows the exact input,
deposit address, expiry and minimum output before the user sends from their
own origin wallet. The browser keeps a signed tracking credential for the
deposit. It expires after 30 days and is required for status and deposit
submission. Keep the signing key stable between deploys. If a receipt is
expired or predates signed tracking, use the original transaction and quote
reference for support. Funding credits the connected NEAR account. Placing
a sealed bid is a separate action.

With live swaps on, the funding panel can also ask 1Click for a confidential
swap (`confidentiality: "basic"`). The proxy refuses a quote whose answer
omits or changes the requested mode, and the receipt records it. The NEAR bid
deposit stays public either way.

| Server-only variable | Meaning |
| --- | --- |
| `ONECLICK_JWT` | optional 1Click partner key, sent only with shared quotas |
| `ONECLICK_REDIS_URL`, `ONECLICK_REDIS_TOKEN` | Upstash Redis REST URL and token for the shared quota |
| `ONECLICK_RECEIPT_SECRET` | 32 random bytes as 64 hex characters; signs deposit receipts. Keep it stable across deploys |
| `ONECLICK_REAL_SWAPS` | `1` turns on live deposit quotes; needs mainnet, Circle's native USDC, both Redis values and the receipt secret |

To exercise deposit quotes and status locally without sending funds, run
`pnpm --filter web exec vitest run src/app/api/oneclick`.

## Share cards

Every page in the two route groups has an Open Graph card, which X also reads
(`twitter:card` is `summary_large_image`). Each group has an `opengraph-image.tsx`: the
landing page, the app, one sale (`src/app/(app)/sale/[id]/opengraph-image.tsx`,
which the result page and the launch kit inherit) and one token
(`src/app/(app)/token/[id]/opengraph-image.tsx`). The cards are drawn in `src/lib/og/`.

- In NEAR mode a sale's card and page title are read on the server from
  `get_sale` and `get_result` (3 s RPC timeout): the token, the phase and,
  once settled, the one clearing price. A token's card shows its launch
  price, supply, burn, holders and raise, and "Trading on Rhea" only for a
  seeded pool; before settlement or after a failed sale it is the sale's own
  card. In mock mode sales live in the visitor's browser, so a sale or token
  page gets the generic app card.
- Three image routes, each 1200x630, take what they draw from the link in
  mock mode (labelled "Simulated sale") and read the chain in NEAR mode:

  | Route | Card | Where it is used |
  | --- | --- | --- |
  | `/api/og/bid?sale=<id>&bid=<n>` | "I'm in. Sealed bid #n in $TICKER", the reveal time; price and amount "Sealed" | the "I'm in" block after a bid; the sale page serves it as its preview with `?bid=` |
  | `/api/og/win?sale=<id>&win=<n>` | "No bot paid less. I got N $TICKER at P USDC each.", the winners and the clearing price | "Share your win" on the result page; the result page serves it as its preview with `?win=` |
  | `/api/og/countdown?sale=<id>` | "Bids open" or "Sealed bids close" at a UTC time, the floor | the launch kit |

  Mock-mode parameters: `name`, `ticker` and `end` (bid); `name`, `ticker`,
  `got`, `dec`, `price`, `winners`, `bids` (win); `name`, `ticker`, `start`,
  `end`, `floor` (countdown). On the bid and win cards `by=<account>` shows
  the account, in NEAR mode only when it is that bid's own bidder. No card
  carries a max price or a deposit. Bad input, an unknown or unsettled sale, an RPC error or a
  timeout give the generic app card, never a 500. The tests next to each
  route cover every fallback.
- `metadataBase` in the root layout makes the card URLs absolute
  (`src/lib/og/site-url.ts`): `NEXT_PUBLIC_APP_URL`, else the Vercel URL of
  the deployment (the production domain on production), else
  `http://localhost:<PORT>`.
- The cards use Inter, fetched from Google Fonts once per server process.
  Offline they fall back to `next/og`'s bundled font; a card is always served.

"Share on X" on the result page is a plain link to X's post intent with one
factual sentence from the result (the clearing price, and when the first and
last winning bids landed) and the result's URL. No script from X loads. A
judge-mode sale exists only in the browser that ran it, so its share link
points at `/judge`. The token page, the "I'm in" block, "Share your win" and
the launch kit's posts use the same kind of link; in mock mode their text
ends "Simulated sale on Sealround." (the token page: "Simulated sealed-bid
launch on Sealround.").

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

## Dependencies

The direct dependencies are in `package.json` and in the root README,
section 12. The newest is `qrcode-generator` 2.0.4 (MIT, by Kazuhiko Arase,
no dependencies of its own, ships its own typings), pinned exactly. It draws
the launch kit's QR code in the browser (`src/components/kit/qr.ts`).

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
| `src/lib/near/attestation.ts`, `attestation-sources.ts` | the Verified panel's checks, and the read-only fetches behind them |
| `src/lib/bid-inclusion.ts` | the bid-set hash recomputed from `get_bids`, and one bid's place in it |
| `src/lib/liquidity.ts` | launch pool maths and stages, over `poolPlan` in `@fairground/clearing` |
| `src/lib/crypto.ts` | bid sealing (padded plaintext), commitments |
| `src/lib/bid-secrets.ts` | commit-reveal salts kept in the browser |
| `src/lib/wallet.tsx` | wallet context: demo account, NEAR Connect, dev accounts |
| `src/lib/oneclick.ts` | 1Click preview and deposit quotes, status tracking, simulated funding, USDC storage registration |
| `src/lib/og/` | share cards (sale, token), sale and token page titles, `metadataBase` |
| `src/app/api/og/` | the bid, win and countdown card routes, their link builders and tests |
| `src/lib/token-icon.ts`, `src/components/ui/token-mark.tsx` | the contract's icon rule (a `data:image/` URL of at most 2,048 bytes) and the icon shown everywhere, with a monogram fallback |
| `src/lib/burn-total.ts`, `src/components/burn/` | the burn counter's average, the token page's burn line, the burn moment after the creator payout |
| `src/components/sale/` | sale page: status, demand panel, bids over time, reveal reminder (`.ics`), the clearing moment, bid form |
| `src/components/result/` | result page: reveal, fairness timeline, Share on X, winner card, supply story and mint and burn log (`supply.ts`), scorecard, Trade on Rhea, pool panel, Verified panel, bid inclusion |
| `src/components/token/` | the token page |
| `src/components/kit/` | the launch kit, its post texts (`kit-text.ts`) and QR code (`qr.ts`) |
| `src/components/home/` | the sales board and the fair-launch leaderboard (`leaderboard.ts`) |
| `src/components/create/` | create form, presets, icon picker, pool section, launch simulator |
| `src/components/deploy/` | the `/deploy` page |
| `src/lib/__tests__/` | vitest suites, including byte parity with the Rust sealer |
| `scripts/` | `e2e/`, `live-bot/`, `mcp/`, `verify-sale.ts` (see Scripts) |
| `UI-DIRECTION.md` | the design brief |
