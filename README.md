# Sealround

Sealed-bid, single-price token sales on NEAR. Bids are sealed in the browser and opened only inside an OutLayer TEE after the sale closes, and every winner pays the same clearing price, so bots and people pay the same.

- 90-second video: `<video link>`
- Hosted demo (no wallet, no funds): https://sealround-demo.vercel.app
- Tracks: Memecoins With Mechanics, Unstoppable DeFi, Privacy & Private AI, Open Innovation

The product was first called Fairground. Package names (`@fairground/*`), crate names (`fairground-*`), the contract's method, event and storage names, the wasm file names and the `NEXT_PUBLIC_FAIRGROUND_*` variables keep `fairground` for compatibility. They all refer to Sealround.

**Status.** The contracts are unaudited. Everything in this README marked "local sandbox" ran on a nearcore sandbox on our machine, with OutLayer's own contract and our pinned enclave job. The testnet deployment and the capped mainnet pilot are run by the project owner ([LAUNCH.md](LAUNCH.md)); their results go in [Pilot results](#7-pilot-results).

## Contents

1. [What Sealround is](#sealround) (above)
2. [Try it in 2 minutes with no funds](#2-try-it-in-2-minutes-with-no-funds)
3. [How the auction works](#3-how-the-auction-works)
4. [What NEAR does here](#4-what-near-does-here)
5. [Architecture and trust assumptions](#5-architecture-and-trust-assumptions)
6. [Bot Arena results](#6-bot-arena-results)
7. [Pilot results](#7-pilot-results)
8. [Run it locally](#8-run-it-locally)
9. [Argue against this idea](#9-argue-against-this-idea)
10. [Failure cases](#10-failure-cases)
11. [Sybil limits](#11-sybil-limits)
12. [Libraries, AI-assisted code, baseline](#12-libraries-ai-assisted-code-baseline)
13. [Roadmap (not built)](#13-roadmap-not-built)
14. [License](#14-license)

Also: [Repository layout](#repository-layout), [Deploying](#deploying).

## 2. Try it in 2 minutes with no funds

Judge mode runs a whole sale in your browser: 50 fictional people, 3 sniper bots and 1 copycat bid, the sale closes, the enclave clears it, and you get the result. The chain, the accounts, the enclave, its attestation and the gas relayer are simulated in the browser. The bid encryption (libsodium sealed box, the exact format the contract accepts) and the clearing math (`@fairground/clearing`, which the enclave runs as an exact Rust port) are the real code.

### On the hosted demo

| Do | See |
| --- | --- |
| Open [sealround-demo.vercel.app/judge](https://sealround-demo.vercel.app/judge) | "Judge mode", a **Run demo** button ("About 35 seconds. No wallet, no funds.") and "The run in nine steps" |
| Click **Run demo** | A live timeline: Create the sale, Enclave makes the sale key, 3 sniper bots bid at second 0, 50 people bid over the window, A copycat replays a sealed bid, The bid window runs out, Anyone closes the sale, Enclave clears the sale, Result. Bids stream in as ciphertext only. |
| Wait about 35 seconds | "Every winner paid one clearing price" with the price in USDC per token; **Bots paid** and **People paid** side by side at the same price; checks "Bots and people paid exactly the clearing price." and "The copycat's bid was void: 0 tokens, ... USDC back, ... USDC kept as the 1 % penalty."; a **Time to result** stat under the 2:00 goal |
| Click **Open the full result** | `/sale/judge-1/result`: clearing price, "Bot or person, same price", the **Verified** panel (5 of 5 checks, tagged "simulated"), "Where's my money", every fill with deposit, tokens, spent, penalty and refund, "Who got the tokens", and the transaction history |
| Optional: click **Connect** (top right), then **Run again** | A simulated wallet with 100 test USDC. During the run, the "Add your own sealed bid" form takes a max price, max spend and deposit; **Seal and bid** seals it in the browser. The summary then shows your fill at the same price as the bots. |

Other pages worth a minute:

| Page | What it shows |
| --- | --- |
| `/how` | The clearing rule, a worked example, what is public and what is sealed, trust assumptions, failure cases, honest limits |
| `/arena` | Bot Arena charts, all read from the output of `pnpm arena` ([section 6](#6-bot-arena-results)) |
| `/sale/lantern/result` | A settled, oversubscribed sale with sniper bots and a copycat whose bid was voided |
| `/sale/driftwood/result` | A sale that missed its minimum raise: everyone refunded |
| `/sale/ashfall` | A sale whose enclave never answered: refund mode after the settle timeout |
| `/sale/fairt` | An open sale (the spec's reference parameters) with **Fund from any chain**, live 1Click dry quotes and simulated swaps |
| `/create` | **Launch a sale**: the parameters, the **Bid privacy** choice (enclave by default, or commit-reveal), then **Review the rules** ("Nothing can be changed once the sale is created.") with the cost, and **Create sale and lock the rules** |

The demo state lives in your browser's localStorage. "Reset demo data" in the page footer wipes it.

### Locally

```powershell
pnpm install     # about 1 minute on a fresh clone
pnpm dev         # http://localhost:3000
```

Open http://localhost:3000/judge and follow the table above. Requirements: Node 24 and pnpm 12.3.4 (pinned in `package.json`; `corepack enable` installs it). Measured from a fresh clone on 11 Nov 2026, production build: judge mode reached the settled result in **0:33**.

## 3. How the auction works

Sealround runs a uniform-price, sealed-bid batch auction. Nobody sees bids until the window closes, and every winner pays the same clearing price.

1. **The creator sets the sale**: supply for sale, floor price, minimum raise, bid window, deposit limits, maximum number of bids, settle timeout. The contract deploys the sale's token with a fixed supply. Every parameter is locked at creation; there is no admin key.
2. **The bidder gets USDC on NEAR**, either already held or funded from another chain through NEAR Intents 1Click.
3. **The bidder places a sealed bid**: a public USDC deposit plus an encrypted payload (max price, max spend, salt) that only the sale's enclave can open. Encryption happens in the browser.
4. **The window closes.** Anyone can call `close_sale`. The bid set is frozen and its hash is already on chain.
5. **The enclave clears the sale.** It opens every bid, computes the clearing price and the fills, and returns a result. The contract checks it, then settles.
6. **Everyone claims.** Winners get tokens at the clearing price plus any unspent USDC. Losing bids get their deposit back. If the minimum raise is missed or clearing fails, everyone is refunded (an invalid bid less a 1 % penalty, see [Failure cases](#10-failure-cases)).

**The clearing rule.** For bids with max price $`p_i`$ and max spend $`m_i`$, sale supply $`S`$ and floor price $`F`$:

```math
P^* = \max \Big\{ P \ge F \;:\; \sum_{i \,:\, p_i \ge P} \frac{m_i}{P} \ge S \Big\}
```

| Case | Rule |
| --- | --- |
| Max price above $`P^*`$ | Filled in full at $`P^*`$ |
| Max price exactly $`P^*`$ | Ties share what is left, pro rata to how many tokens each bid could buy at that price |
| Max price below $`P^*`$ | Not filled; the whole deposit comes back |
| Rounding | Every share is rounded down to the smallest token unit; leftover units go out one at a time, in bid order |
| Undersubscribed | If demand at the floor is below $`S`$, then $`P^* = F`$, every valid bid fills in full, and the unsold tokens are burned (fixed at launch) |
| What you pay | `spent = ceil(tokens * P*)` in USDC base units, never above your max spend; the rest of the deposit is refunded |
| Invalid bid | Does not decrypt, copies another bidder's ciphertext, zero max spend, max spend above the deposit, or max price below the floor: counts as zero, deposit refunded less a 1 % penalty |
| Minimum raise | If the total raise is below the minimum, the sale fails and every valid bid is refunded in full |

Integer math only: USDC has 6 decimals, tokens 18 (0 to 24 allowed). Prices step in whole USDC base units, so in rare cases the bids above $`P^*`$ alone want more than $`S`$; they are then prorated the same way. The rule is implemented once in TypeScript (`packages/clearing`) and ported exactly to Rust (`crates/clearing`), which the contract and the enclave job both use. The two agree on all 389 shared clearing vectors (hand cases plus seeded random bid sets, `crates/clearing/tests/vectors.json`), and the TypeScript reference passes its invariant checks on 1,000 random bid sets.

**What is public, and when**

| Data | During the sale | After settlement |
| --- | --- | --- |
| Max price, max spend | Sealed | Never published; only the enclave sees them (in commit-reveal mode they become public at reveal) |
| Deposit, bidder account, bid time | Public on chain | Public |
| Ciphertext length | Public, but says nothing about the amounts: both are padded to 39 digits, so a sealed bid is exactly `224 + len(sale_id) + len(bidder)` bytes and the contract refuses any other length | Same |
| Clearing price, every fill, refund and penalty | Not known | Public |

The full mechanism, with the contract's exact formats, is in [contracts/DESIGN.md](contracts/DESIGN.md).

## 4. What NEAR does here

| Piece | What it does in Sealround | Where |
| --- | --- | --- |
| **OutLayer TEE** (Intel TDX) | Runs our sealer job, `fairground-sealer`. Each sale gets its own X25519 key, derived inside the enclave from an OutLayer secret: `HKDF-SHA256(master, salt "fairground/sealer/v1", info "sale-key" 0x00 contract_id 0x00 sale_id)`. At `create_sale` the contract asks the job for the sale's public key; at `close_sale` it sends the frozen bid set through OutLayer's yield/resume `request_execution`, and the job opens the bids and clears the sale. The job's wasm sha256 is fixed in the contract at deployment. | `enclave/`, `crates/sealer`, [enclave/README.md](enclave/README.md) |
| **Contract-side checks** | The contract trusts the enclave only for the hidden prices. Before settling it checks, by name: `sale_id_matches`, `bid_set_hash_matches`, `pubkey_matches`, `one_fill_per_bid`, `invalid_list_matches`, `price_at_least_floor`, `price_at_most_ceiling`, `sold_at_most_supply`, `spent_within_deposit_<i>`, `spent_equals_tokens_times_price_<i>`, `invalid_bid_unfilled_<i>`, `raise_at_least_min`, `something_sold`, plus `output_well_formed`. The failed names are stored and shown. | `contracts/fairground`, [contracts/DESIGN.md](contracts/DESIGN.md) "Methods" |
| **NEAR Intents 1Click** | "Fund from any chain" previews the cost and timing of a swap to USDC on NEAR with a dry quote. On a mainnet deployment configured for Circle's native USDC, the server flag `ONECLICK_REAL_SWAPS=1` also lets bidders request a deposit address. The bidder sends the quoted amount and asset from their origin-chain wallet, and Sealround tracks the status. Demo and testnet swaps are simulated. Live swaps are off by default, and verification so far uses local fixtures. | `apps/web/src/lib/oneclick.ts`, `apps/web/src/app/api/oneclick` |
| **Gas relayer** (NEP-366) | Bidders sign a delegate action; the relayer pays the gas, and the 1 yoctoNEAR `ft_transfer_call` needs, for bids, claims, reveals, `clear_onchain`, `claim_proceeds` and `trigger_refund_mode`. It also pays a new bidder's one-time USDC storage registration. It never relays a payable call (`create_sale`, `close_sale`, `retry_setup`), checks the exact sealed-bid length before paying, and stores only rate-limit counters in memory. A bidder needs USDC and no NEAR. | `apps/relayer`, `packages/relayer-client` |
| **NEP-141 token per sale** | The contract deploys each sale's token to `<sale_id>.<contract>`, mints the fixed supply to itself once, and burns unsold tokens. No mint method, no owner. | `contracts/token` |
| **NEAR Connect** | Wallet login (HOT, Meteor, Intear, MyNearWallet, NEAR Mobile, OKX and others) in NEAR mode. | `apps/web/src/lib/wallet.tsx` |
| Chain signatures | **Not shipped.** Delivery to Base through chain signatures is on the [roadmap](#13-roadmap-not-built). | |

A commit-reveal mode is also shipped, as a fallback that needs no TEE: bids are `sha256` commitments, a reveal window follows the close, and the contract clears on chain with `clear_onchain`. It is weaker (prices become public at reveal) and is selectable per sale on `/create`.

The privacy track brief centres on NEAR AI Cloud. Sealround uses OutLayer's TEE instead, since the sealed bids have to be opened by code that a NEAR contract calls and pins by hash.

## 5. Architecture and trust assumptions

The contract is the centre: it holds the money, deploys tokens and checks every clearing result. OutLayer only sees and sorts the hidden prices.

```
 Browser (apps/web, Next.js)
   seals each bid with a libsodium sealed box to the sale's X25519 public key
   |                                                   |
   | NEP-366 delegate (gasless)                        | 1Click quotes and status (/api/oneclick)
   v                                                   v
 Gas relayer (apps/relayer)                          NEAR Intents 1Click
   pays gas only                                       routes funding to the buyer's NEAR account
   |
   v
 USDC ft_transfer_call(msg = {sale_id, ciphertext}) --> Sealround contract (contracts/fairground)
                                                          holds USDC, deploys the sale token,
                                                          keeps a running bid-set hash,
                                                          checks every result, pays every claim
                                                          |  create_sale: "pubkey" request
                                                          |  close_sale:  "clear" request (yield)
                                                          v
                                                        OutLayer contract (outlayer.testnet / outlayer.near)
                                                          |  a TDX worker runs the pinned job
                                                          v
                                                        fairground-sealer job (enclave/)
                                                          derives the sale key, opens bids, clears
                                                          |  result (resume) -> on_clearing_result
                                                          v
                                                        contract checks -> Settled | Failed -> claim
```

Sale states (one way only; `Settled` and `Failed` both let everyone claim, so no path leaves funds stuck):

```
Setup -> Bidding (upcoming / open / awaiting_close)
  awaiting_close --close_sale--> Clearing (TEE) | Revealing (commit-reveal) | Failed (no bids)
  Clearing  --result passes every check--> Settled
  Clearing  --result fails a check, below min raise, nothing sold--> Failed
  Clearing  --run failed, timed out, or "ok:false"--> Closed (anyone retries close_sale)
  Revealing --clear_onchain after the reveal window--> Settled | Failed
  any unfinished state --settle_timeout passed, trigger_refund_mode--> Failed (full refunds)
```

### What you trust

- **OutLayer's TEE** keeps bid prices secret and runs the published job. The job's hash is pinned in the contract at deployment and cannot change; the contract only ever asks OutLayer to run that exact build.
- **OutLayer's master secret (known privacy risk).** OutLayer's own docs say a DAO full-access key can currently obtain the shared master secret outside an enclave. Whoever holds it could derive a sale's key and read its sealed bids. The contract would still check the clearing math and the payouts, but price privacy would not hold. OutLayer governance today (one account approves enclave measurements, contracts upgraded by key, a closed-source coordinator) is written up in [enclave/README.md](enclave/README.md), section 11.
- **OutLayer's liveness.** If its workers stop, sales cannot clear and end in full refunds after their settle timeout.
- **The deployer.** The contract account's full-access key must be deleted before anyone bids, or its holder could make OutLayer open bids (a deployment invariant, [contracts/DESIGN.md](contracts/DESIGN.md) "Deployment invariants"). The account that owns the OutLayer project and secret can stop sales from clearing (they then refund) and could change the secret's access condition to admit another build, so bidders trust that account too; any such change is a public NEAR transaction.
- **NEAR Intents 1Click** routes funding through solvers. When 1Click confirms a refund, it goes to the refund address the bidder supplied on the origin chain.
- **The gas relayer** only pays gas. It cannot move anyone's funds.
- **The contracts are unaudited.**

**Attestation.** OutLayer's attestation endpoints take no verifier nonce ([contracts/DESIGN.md](contracts/DESIGN.md), "Spec deviations" 1), so the Verified panel's first check ties the attested run to the sale by its input and output hashes instead. In judge mode the Verified panel runs its five checks against a simulated attestation and says so. In NEAR mode the app checks what the contract stored (the pinned code hash, the sale key, the sha256 of the clearing input and of the enclave's answer) and does not fetch a TDX quote; `enclave/deploy/Verify-Attestation.ps1` checks a real OutLayer attestation against those values.

### Pinned hashes

| Artifact | sha256 | How to check |
| --- | --- | --- |
| `contracts/res/fairground.wasm` (sale contract, embeds the token) | `bfc2f80059936d4344aafc136aacfed3b1ce37ace7814bfefde6e88cdc3ea800` | Built with `scripts\build-contracts.ps1`. The reproducible container build is configured (NEP-330 metadata) but has not been run yet, see [contracts/DESIGN.md](contracts/DESIGN.md) "Reproducible build" |
| `enclave/res/fairground_sealer.wasm` (the OutLayer job) | `f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb` | `powershell -File scripts\build-enclave.ps1 -Verify` rebuilds it in Docker and prints `verify: MATCH`. The single source of truth is `enclave/res/fairground_sealer.wasm.sha256` |
| `contracts/res/fairground_token.wasm` | `0b1673bf822def860a637059ff55e839cc47f8c1dacee46b284080bbe7450047` | Embedded in `fairground.wasm` |
| `contracts/res/outlayer_contract.wasm` (third party, tests only) | `74ab074a27ccddd9b6f400f3f8453c1039419acba556ba77dfb288759b3dbd0f` | [contracts/res/NOTICE.md](contracts/res/NOTICE.md) |

Measured costs: a 500-bid clear takes 3.14e9 wasm instructions and about 0.2 s on a laptop, against OutLayer's 60 s limit ([enclave/PERF.md](enclave/PERF.md)); closing a 500-bid TEE sale burns 132 TGas and fits one transaction ([contracts/GAS.md](contracts/GAS.md)).

## 6. Bot Arena results

The Bot Arena runs the same crowd through three launch types: a bonding curve (constant product with virtual reserves, pump.fun proportions), a first-come fixed-price sale, and Sealround (clearing by `clear()` from `@fairground/clearing`). Each run has 200 humans with private valuations and random arrival times, and 5 sniper bots that act at second 0 and sell into later human demand. 60 seeded runs, demand from 0.5x to 4x supply, seed `20261114`. Deterministic, no network, no LLM calls.

Averages over the 60 runs, from `apps/web/src/data/arena-results.json` (exactly what `pnpm arena` prints):

| Metric | Bonding curve | Fixed price, first come | Sealround |
| --- | ---: | ---: | ---: |
| Bot share of supply | 34.5% | 20.9% | 15.7% |
| Bot profit | 1,269 USDC | 177 USDC | 0 USDC |
| Human price premium (median human price ÷ bots' price) | 2.61x | 1.00x | 1.00x |
| Humans filled | 50.1% | 58.2% | 59.5% |
| Holder concentration (Gini) | 0.517 | 0.498 | 0.499 |

How to read it: in Sealround, bots still buy (15.7% of supply on average, in proportion to their budgets), and holder concentration is about the same as the other launches. What they lose is the speed advantage: they pay the same clearing price as every human (premium 1.00x), and their profit from selling to later buyers is 0 USDC in every one of the 60 runs. On the bonding curve, bot profit ranged from 700 to 2,068 USDC per run. This is a model with stated assumptions, not a forecast; every assumption is listed in [packages/arena/README.md](packages/arena/README.md) and on `/arena`.

**Rerun every chart:**

```powershell
pnpm arena                        # 60 runs, prints the table above, writes apps/web/src/data/arena-results.json
pnpm arena --seed 5 --no-write    # another seed, prints only
pnpm --filter @fairground/arena test
```

The `/arena` page reads `arena-results.json`, so every number on it comes from that command; none is typed by hand. A rerun from a fresh clone took under a second and reproduced the committed file byte for byte.

**Live bot.** `pnpm --filter web live-bot` runs an openly operated sniper bot against a real Sealround contract on testnet, mainnet or a local sandbox, through the same client code the web app uses in NEAR mode. `snipe` bids as soon as the sale opens with a high max price, `copycat` replays another bidder's sealed bid under the bot's own account, and `report` checks what the bot paid against the clearing price (`reveal` and `status` also exist). Its key comes from an environment variable or a near-cli credentials file, never a flag. Usage and options are in [apps/web/scripts/live-bot/README.md](apps/web/scripts/live-bot/README.md). The same attacks already run against the real contract and the pinned enclave job on a local sandbox: the end-to-end run's `tee-bids` scenario places a copied ciphertext, and the job voids it.

## 7. Pilot results

**To be filled after the pilot.** The pilot runs on NEAR testnet with community bidders and our own openly run sniper bot, which is the spec's documented fallback for a mainnet pilot that cannot be announced a day ahead. Same caps as the planned mainnet sale: a demo token with no utility, 10 USDC maximum deposit per account, at most 50 bids. If one real 1Click swap is recorded on mainnet, its link goes in the last row.

| Measure | Result |
| --- | --- |
| Contract account | `<to be filled>` |
| Sale id and bid window | `<to be filled>` |
| Bidders | `<to be filled>` |
| Chains used to fund (from 1Click statuses) | `<to be filled>` |
| Our own openly run bot: what it paid vs the clearing price | `<to be filled>` |
| Close to settlement time | `<to be filled>` |
| Refunds processed | `<to be filled>` |
| Verified panel | `<to be filled>` |
| Transaction links (create, close, settle, sample claims) | `<to be filled>` |
| Real 1Click swap on mainnet (optional) | `<to be filled>` |

## 8. Run it locally

**Requirements.** Node 24 (tested with 24.19.0) and pnpm 12.3.4 (`corepack enable`). For the full local stack also Docker Desktop (running), PowerShell, and Rust via rustup (the toolchains are pinned in the repo). The build and test scripts in `scripts/` are written for a Windows host.

### Mock mode (the demo)

```powershell
pnpm install
pnpm dev                  # = pnpm --filter web dev
```

Expected: `▲ Next.js 16.4.5 (Turbopack)`, `Local: http://localhost:3000`, `✓ Ready`. Mock mode is the default whenever `NEXT_PUBLIC_FAIRGROUND_CONTRACT` is unset.

Production build, which is what the hosted demo serves:

```powershell
pnpm build                # = pnpm --filter web build, about 20 s
pnpm --filter web start   # http://localhost:3000
```

Expected build output: `✓ Compiled successfully`, then a route table with `/`, `/arena`, `/create`, `/how`, `/judge`, `/sale/[id]`, `/sale/[id]/result`, and `/api/oneclick/{config,quote,status,submit,swap,tokens}`. The optional server-side `ONECLICK_JWT` authenticates the 1Click requests. Dry quotes work without it.

### Full local stack, end to end

```powershell
powershell -File scripts\sandbox.ps1          # once on a fresh clone: downloads the nearcore sandbox binary into .sandbox-bin
powershell -File scripts\sandbox.ps1 -Stop
pnpm --filter web e2e:sandbox
```

This drives the web app's NEAR client from Node, with no browser and no fakes in the money path: a nearcore sandbox in Docker (`near-sandbox-web`, RPC 127.0.0.1:3050), the committed `contracts/res/fairground.wasm`, OutLayer's own contract, the pinned `enclave/res/fairground_sealer.wasm` run by the enclave runner with a TEST master, and the real relayer as its own process on 127.0.0.1:8790. The first run builds the enclave runner (a few minutes). It prints every check, then a pass/fail table of **21 scenarios** (commit-reveal and TEE sales from create to claim, a copied and a void bid, enclave refusals with `retry_setup` and a second `close_sale`, storage sponsorship, every paid fallback when the relayer is down or out of budget, refund mode), exits 0 only if all pass, and removes the container. Logs: `apps/web/scripts/e2e/.run/`.

To point the web app at a local sandbox in a browser, see [apps/web/README.md](apps/web/README.md), "Local sandbox".

### Tests

From the repo root unless noted:

| Area | Command |
| --- | --- |
| All TypeScript packages | `pnpm test` (runs `vitest` in every package) |
| Rust | `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| Contracts, full (build, unit, sandbox integration; needs Docker) | `powershell -File scripts\test-contracts.ps1` |
| Enclave | `powershell -File scripts\run-enclave.ps1 -Test`, `powershell -File scripts\build-enclave.ps1 -Verify` |
| Clearing TS | `pnpm --filter @fairground/clearing test` |
| Relayer | in `apps/relayer`: `pnpm test`, `pnpm typecheck`, `pnpm test:sandbox` |
| Relayer client | in `packages/relayer-client`: `pnpm test`, `pnpm typecheck` |
| Web | in `apps/web`: `npx tsc --noEmit --incremental false`, `npx eslint src scripts`, `npx vitest run`, `pnpm build` |
| End to end | `pnpm --filter web e2e:sandbox` |

Last full pass (10 Nov 2026), all green: 178 Rust unit tests, 17 sandbox integration tests, 1,028 clearing TS, 386 relayer, 263 relayer client, 103 web, 21/21 end-to-end scenarios. On 11 Nov 2026, from a fresh clone: `pnpm test` passed (clearing 1,028, relayer 386 with its 10 sandbox tests skipped, relayer client 263 with 8 skipped, arena 16, web 103), and `cargo test --workspace --locked` passed 178 with 1 ignored, in about a minute.

## 9. Argue against this idea

- **It is not new.** Sealed-bid, single-price batch auctions have run on Ethereum for years.
- **Money still wins share.** They remove speed and information advantages, not capital. A whale still buys a large share at the clearing price.
- **Privacy rests on one provider.** Sealed prices depend on OutLayer's TEE and on how its master secret is held today, which its own docs say a DAO key can obtain.
- **A fair launch is not a fair market.** Most memecoin launches are speculation. A fair price at launch does not stop a dump later.
- **Token sales are regulated** in some countries. Anything beyond a capped, no-value experiment needs legal advice.

We build it anyway. Sniping is real at every launch. NEAR offers, in one stack, a TEE that a contract can call and pin by hash, cross-chain funding and gasless transactions. And the clearing checks live in a contract anyone can read.

## 10. Failure cases

| Case | What the contract does | Demo |
| --- | --- | --- |
| **Clearing times out or the enclave run fails** | OutLayer resumes the contract with `null` after its 200-block yield window (about 2 minutes), or the job answers `ok:false`. The sale goes back to `closed`, `clearing_failed` is logged with the reason, and anyone may call `close_sale` again. If there is still no result when the settle timeout (fixed at launch, 10 minutes to 7 days, 2 hours in the app) has passed, anyone calls `trigger_refund_mode`: the sale moves to Failed (`refund_mode`) and every deposit is refunded in full, with no penalty. The same switch works when nobody closes the sale at all. | `/sale/ashfall` |
| **A result fails a check** | If the enclave's answer is malformed or fails any integrity check (bid-set hash, sale key, fills, supply, deposits), the sale is Failed (`checks_failed`), the failed check names are stored, and everyone is refunded in full. | |
| **Invalid bids** | Refused at the door, in full, with a `bid_rejected` event and reason: wrong token, outside the window, below the minimum or above the per-account deposit, a second bid, sale full, malformed message, or a ciphertext of the wrong length. Accepted but invalid once opened (does not decrypt, copied from another bidder or sale, zero spend, spend above the deposit, price below the floor): counts as zero, no tokens, deposit refunded less a 1 % penalty (rounded up) that stays locked in the contract for good. Unrevealed commit-reveal bids pay the same. The rest of the sale clears normally. | `/sale/lantern/result` |
| **Failed funding** | `REFUNDED` confirms that 1Click returned funds to the refund address on the origin chain. `FAILED` reports a swap error. The funding panel shows the 1Click status and the quote reference for follow-up. | |
| **Missed minimum raise** | The sale is Failed (`below_min_raise`). Nobody gets tokens; every valid bid gets its whole deposit back; an invalid bid still loses its 1 %. No bids at all: Failed (`no_bids`) at close; no valid bids: Failed (`no_valid_bids`). | `/sale/driftwood/result` |

Claims: each part of a claim (tokens, refund) is marked paid before the transfer and restored if the transfer fails, so a claim can be retried and a second claim pays nothing. Anyone may push a claim for a bidder; funds only go to the bidder.

## 11. Sybil limits

- **Per-account limits.** Each sale fixes `min_deposit` (at least 1 USDC) and `max_deposit_per_account`, and takes one bid per account. These are demo-grade.
- **Sybils gain nothing on price.** Every winner pays the same clearing price, so splitting money across many wallets gets around the per-account cap but buys nothing cheaper.
- **Bid slots can be squatted.** A sale takes at most `max_bids` (up to 500) bids, first come, first served, and the contract cannot read a sealed bid. Junk bids cost 1 % of the deposit (at least 0.01 USDC) plus about 0.005 NEAR per throwaway account. Filling 500 slots at the 1 USDC minimum costs about 5 USDC lost, 2.5 NEAR, and 500 USDC held until the sale ends. A creator who expects this raises `min_deposit`.
- **Relayer limits.** 30 relays per sender per hour, 120 requests per IP per hour, a daily NEAR budget. A bidder over the limit can still bid by paying their own gas.
- No KYC or proof of personhood (a non-goal). Stronger sybil resistance is on the roadmap.

## 12. Libraries, AI-assisted code, baseline

### Libraries (direct dependencies)

**Web app** (`apps/web`)

| Library | Purpose |
| --- | --- |
| `next` 16.4.5, `react` / `react-dom` 19.3.0 | Framework |
| `near-api-js` 7.4.0 | RPC, transactions |
| `@hot-labs/near-connect` 0.12.0 | Wallets |
| `libsodium-wrappers` | Sealing |
| `recharts` | Charts |
| `motion` | Animation |
| `lucide-react` | Icons |
| `clsx` | Classnames |
| `tailwindcss` 4, `@tailwindcss/turbopack` | Styling |
| `typescript`, `eslint`, `eslint-config-next`, `vitest`, `tsx` | Tooling |

**Shared packages**

| Library | Used in | Purpose |
| --- | --- | --- |
| `@noble/hashes` | `packages/clearing` | Hashing |
| `near-api-js` 7.4.0 | `packages/relayer-client` | Delegates |
| `vitest`, `tsx`, `typescript` | all | Tooling |

**Relayer** (`apps/relayer`)

| Library | Purpose |
| --- | --- |
| `hono` 4.13.17, `@hono/node-server` 2.1.6 | Server |
| `near-api-js` 7.4.0 | Transactions |
| `borsh` 2.0.0 | Decoding |
| `typescript`, `vitest` | Tooling |

**Contracts** (`contracts/*`, `crates/clearing`)

| Crate | Purpose |
| --- | --- |
| `near-sdk` 5.30.1 | Contracts |
| `near-contract-standards` 5.30.1 | NEP-141/145/148 |
| `ethnum` | U256 math |
| `sha2` | Hashing |
| `near-workspaces` 0.24.0, `tokio`, `anyhow`, `futures`, `serde_json`, `base64`, `crypto_box` | Integration tests |

**Enclave** (`crates/sealer`, `enclave/`)

| Crate | Purpose |
| --- | --- |
| `crypto_box` 0.9.1 | Sealed boxes |
| `curve25519-dalek` | Key checks |
| `hkdf` | Key derivation |
| `sha2` | Hashing |
| `serde`, `serde_json` | JSON |
| `base64` | Encoding |
| `zeroize` | Secret wiping |
| `wasmtime` / `wasmtime-wasi` 28.0.1, `tokio`, `anyhow` | Local runner |
| `blake2` | Tests |

External services: OutLayer (TEE compute and secrets), NEAR Intents 1Click (`https://1click.chaindefuser.com`), NEAR RPC. Build images: `rust:1.97.1-trixie` (enclave, pinned by digest), `sourcescan/cargo-near:0.22.0-rust-1.97.1` (contract reproducible-build metadata), `debian:trixie-slim` with nearcore sandbox 2.14.0 (local chain).

### AI-assisted code

The code and documentation in this repository were written with AI coding agents (Claude Code and OpenAI Codex), directed and reviewed by the team. The agents worked from the project spec and shared notes in [AGENTS.md](AGENTS.md); every claim in this README was checked against the code and the test runs it cites.

### Baseline

The repository starts at commit `781f75b` (9 Nov 2026). There is no code from before 19 Oct 2026 in this repo, so no baseline diff applies. *(Owner to confirm.)*

## 13. Roadmap (not built)

Nothing in this section exists in the code.

**P1**

- Confidential funding: the 1Click `confidentiality` option, so origin wallets cannot be linked to bid accounts.
- Delivery to Base via chain signatures: the contract derives an EVM address through the MPC signer and signs ERC-20 transfers to winners (a fair mode for launchpads on Base, with NEAR as the logic layer).
- Per-bid inclusion proofs, so each bidder can verify their bid was counted.
- An optional anonymized demand-curve reveal after settlement.
- A TypeScript SDK package with one integration example.
- Liquidity at the clearing price. Today `claim_proceeds` pays the creator the raise and the creator allocation, and any trading pool is the creator's job. Planned: the creator sets a share of the raise and of the allocation at creation (locked with the other rules); at settlement the contract seeds a Rhea pool with both at the clearing price, so trading opens at the price the sale discovered, and holds the LP tokens until a lock date. An optional vesting schedule for the rest of the creator allocation goes with it.

**P2**

- NFT drops, ticket sales and GPU-slot sales on the same engine.
- AI agents bidding through the SDK or NEAR Agent Market.
- A meme.cooking integration.
- Stronger sybil resistance for per-person caps.

Also not done yet: a reproducible container build of the sale contract, and fetching a real OutLayer attestation in the browser.

## 14. License

MIT, see [LICENSE](LICENSE). The third-party `contracts/res/outlayer_contract.wasm` (OutLayer's contract, used only by the sandbox tests) is Apache-2.0; see [contracts/res/NOTICE.md](contracts/res/NOTICE.md) and `contracts/res/LICENSE-APACHE-2.0`.

## Repository layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js 16 app. Mock mode by default, NEAR mode when `NEXT_PUBLIC_FAIRGROUND_CONTRACT` is set ([README](apps/web/README.md)) |
| `apps/relayer` | NEP-366 gas relayer (Hono) ([README](apps/relayer/README.md)) |
| `packages/clearing` | TypeScript reference of the clearing rule and hashes |
| `packages/relayer-client` | Browser and Node client for the relayer ([README](packages/relayer-client/README.md)) |
| `packages/arena` | Bot Arena simulator ([README](packages/arena/README.md)) |
| `crates/clearing` | Rust clearing, shared by the contract and the enclave job |
| `crates/sealer` | Rust bid opening and the job's logic |
| `contracts/fairground` | The sale contract ([DESIGN](contracts/DESIGN.md), [GAS](contracts/GAS.md)) |
| `contracts/token`, `contracts/mock-ft` | Sale token, test USDC |
| `contracts/tests` | near-workspaces integration tests against a sandbox |
| `contracts/res` | Built wasm, committed on purpose ([NOTICE](contracts/res/NOTICE.md)) |
| `enclave/` | The OutLayer job, its runner, reproducible Docker build and deploy scripts ([README](enclave/README.md), [PERF](enclave/PERF.md)) |
| `scripts/` | PowerShell build, sandbox and test scripts |

## Deploying

Testnet and mainnet deployment, relayer hosting (Dockerfile) and the Vercel setup for the web app are in [LAUNCH.md](LAUNCH.md). Publishing the enclave job and creating its secret on OutLayer are in [enclave/README.md](enclave/README.md). Deploying, creating accounts and signing on public networks are done by the project owner.
