# Sealround

Sealed-bid, single-price token sales on NEAR. Bids are sealed in the browser and opened only inside an OutLayer TEE (Intel TDX) after the sale closes, and every winner pays the same clearing price, so bots and people pay the same. After settlement the sale can open a Rhea pool at exactly that price, with the LP shares held by the sale contract.

- 90-second video: `<video link>`
- Hosted demo, judge mode (no wallet, no funds): https://sealround-demo.vercel.app/judge (an older build; see [section 2](#2-try-it-in-2-minutes-with-no-funds))
- Testnet results and transaction links: [section 7](#7-testnet-results)
- Tracks: Memecoins With Mechanics; also Privacy & Private AI, Unstoppable DeFi, Open Innovation, Agent Economy

The product was first called Fairground. Package names (`@fairground/*`), crate names (`fairground-*`), the contract's method, event and storage names, the wasm file names and the `NEXT_PUBLIC_FAIRGROUND_*` variables keep `fairground` for compatibility. They all refer to Sealround.

**Status.** The contracts are unaudited. Nothing has run on mainnet. Testnet deployments, account creation and signing on public networks are done by the project owner ([LAUNCH.md](LAUNCH.md)).

**AI-written code.** The code and documentation were written with AI coding agents (Claude Code and OpenAI Codex), directed and reviewed by the team. See [section 12](#ai-assisted-code).

### Three ways to run it

Every claim below says which of these it was checked in.

| Mode | Real | Simulated | Start it |
| --- | --- | --- | --- |
| **Judge mode** (mock, the default) | Bid encryption (libsodium sealed box, the exact format the contract accepts), the clearing math (`@fairground/clearing`, the reference the Rust port matches), the launch pool maths, the bid-set hash | The chain, the accounts, the enclave and its attestation, the gas relayer, the Rhea pool. The pages label these "simulated" or "sim". | The hosted demo, or `pnpm dev` and open `/judge` |
| **Local sandbox** | A nearcore sandbox chain in Docker, the committed `contracts/res/fairground.wasm`, OutLayer's own contract, the pinned enclave job (`enclave/res/fairground_sealer.wasm`) run by a local wasmtime runner with a test master secret, the real relayer | The TDX hardware and OutLayer's worker: a stand-in serves the contract's requests with the pinned job. No attestation exists. | `pnpm --filter web e2e:sandbox` |
| **Testnet** | The contract on NEAR testnet, OutLayer's testnet TDX workers, OutLayer's attestations, Rhea on testnet (`ref-finance-101.testnet`) | Nothing, but the USDC is a test token (`usdc.fakes.testnet`) | [Section 7](#7-testnet-results) |

### Claims and how to check them

"Needs" is what you need beyond a clone: **Browser** (nothing to install), **Node 24** (`pnpm install` first), **Rust** (1.97.1, pinned), **Docker** (the sandbox runs in a container; the scripts are written for a Windows host with PowerShell), **testnet RPC** (read-only access to `rpc.testnet.near.org` and `testnet-api.outlayer.ai`). Every command below was run on 13 Nov 2026 on Windows 11 with Node 24.19.0, with the result shown, unless the row says otherwise. Rows C15 to C23 were checked on 13 Nov 2026 against `pnpm dev` at commit `576047c`, in a browser with no stored demo data. The seeded demo sales (Lantern, Thistle, Driftwood, Ashfall, Kiln, Fair Test, Moth) come out the same in every fresh browser; judge runs and sales you create add to the board, the leaderboard and the burn counter, and "Reset demo data" in the footer starts over.

| # | Claim | How to check: do, then see | Mode | Needs |
| --- | --- | --- | --- | --- |
| C1 | Every winner pays one clearing price, bots included. | Open `/judge`, click **Run demo**, wait about 35 s. See "Bots paid" and "People paid" at the same price and "Bots and people paid exactly the clearing price." marked Passed. On a chain: `pnpm --filter web e2e:sandbox`; scenario 11 prints "contract get_fills: tokens, spent, refund and penalty of every bid = reference clearing". | Mock; sandbox | Browser; Docker |
| C2 | Bids are sealed in the browser, and the chain sees no price and no amount. | `pnpm --filter web e2e:sandbox`; scenario 10 prints, for every bid, "the sealed box is 224 + len(sale id) + len(bidder) = 246 bytes" and "the contract stores the box unchanged". Both amounts are padded to 39 digits, so the length says nothing. Sealing code: `apps/web/src/lib/crypto.ts`. | Sandbox | Docker |
| C3 | Bids are opened only by the pinned enclave job, in an attested Intel TDX enclave. | `pnpm --filter web verify-sale --contract fairground.itzbeast.testnet --sale smoke-11120830`. See 16 `[PASS]` lines (8 for each enclave run), including "Attested build is the sealer the contract pins" and "The TDX quote commits to this record", then "Every check passed." and exit code 0. | Testnet | Node 24, testnet RPC |
| C4 | The contract re-checks the enclave's result and fails the sale on any mismatch. | `cargo test -p fairground --locked every_check_can_fail_the_sale` passes: each named check fails the sale on its own. On testnet, `get_result` for `smoke-11120830` shows `"failed_checks":[]` (commands below). | Unit; testnet | Rust; testnet RPC |
| C5 | No admin key: a sale's rules are fixed at `create_sale`, and a deployed contract account has no access key. | Read [contracts/DESIGN.md](contracts/DESIGN.md) "Safety rules" and `contracts/fairground/src/lib.rs`: no owner, no admin, no upgrade method. On testnet, `keys <contract>` (below) must print `"keys":[]`. For the evidence contract: `<link: access key list of sealround.itzbeast.testnet after lock>`. The smoke-sale contract `fairground.itzbeast.testnet` still has its deployer's full-access key: it was never locked (section 7). | Testnet | testnet RPC |
| C6 | A failed sale refunds everyone. | Judge mode: `/sale/driftwood/result` (missed its minimum raise, everyone refunded), `/sale/ashfall` (the enclave never answered; past the settle timeout, "Switch this sale to refunds" lets anyone trigger full refunds). Sandbox: scenario 20 "refund mode: nobody closes the sale, everyone gets the whole deposit back" and scenario 13 (the enclave refuses, `retry_setup` and a second `close_sale` recover). | Mock; sandbox | Browser; Docker |
| C7 | Unsold supply is burned. | `view smoke-11120830.fairground.itzbeast.testnet ft_total_supply '{}'` (below) prints `"900000000000000000000"`: 1,000 tokens were minted once, 100 of the 600 for sale went unsold and were burned at `claim_proceeds`. In judge mode, `/sale/thistle/result` shows 292,200 THSL burned (C15), a `/judge` run at **Low** demand burns about 52,800 of its tokens at the creator payout, `/create` "Simulate this launch" has a "Burned" row and `/arena` has "Sealround: supply burned as demand changes". | Testnet; mock | testnet RPC; Browser |
| C8 | The launch pool opens on Rhea at exactly the clearing price, and the LP shares stay with the keyless contract. | `powershell -File scripts\test-contracts.ps1` runs 9 liquidity integration tests against Rhea's own wasm (v1.9.19); 26 integration tests passed on 12 Nov 2026 (not rerun on 13 Nov). Judge mode: the result page's **Launch pool** panel shows "Pool price equals the clearing price" Passed, labelled simulated. Testnet: `<link: evidence sale pool, section 7>`. | Sandbox; mock; testnet pending | Docker and PowerShell; Browser |
| C9 | Bidders need no NEAR: the relayer pays the gas. | `pnpm --filter web e2e:sandbox`; scenarios 4 and 10 print "alice.test.near's NEAR balance moved by exactly 0" (and the same for every other bidder) for every bid, scenarios 8 and 12 for every claim. `cd apps/relayer && pnpm test`: 411 passed, 10 sandbox tests skipped. | Sandbox; unit | Docker; Node 24 |
| C10 | Anyone can verify a sale without trusting the app or us. | Same command as C3. It also recomputes the bid set: "Bid set: [PASS] 1 of 1 bids listed; recomputed 4019e54c… = frozen 4019e54c…". In NEAR mode the result page's **Verified** panel runs the same code in the browser. In judge mode it shows "11 of 11 checks passed" against an unsigned, simulated attestation, labelled simulated. | Testnet; mock | Node 24, testnet RPC; Browser |
| C11 | A creator can simulate the launch before choosing its parameters. | Open `/create`, scroll to **Simulate this launch**. With the form's defaults and 200 people per crowd, the table shows bot profit 1.58, 3.97, 7.36 and 9.46 USDC at 0.5×, 1×, 2× and 4× demand. `pnpm --filter @fairground/arena test`: 27 passed. | Mock (a model) | Browser; Node 24 |
| C12 | An AI agent can bid through MCP, within a budget the user set, without seeing the key. | `pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts --offline`: 3/3 scenarios, 24/24 checks (handshake, the seven tools, refusals before any network call). Without `--offline`: 13/13 scenarios, 90/90 checks, including a relayed bid, a gasless claim and "no key in any tool answer or server log". | Sandbox | Node 24; Docker for the full test |
| C13 | The Bot Arena numbers are reproducible. | `pnpm arena` prints the table in section 6 and rewrites `apps/web/src/data/arena-results.json`; `git status` then shows no change to that file. | Model | Node 24 |
| C14 | The TypeScript and Rust clearing agree. | `pnpm --filter @fairground/clearing test` (1,032 passed) and `cargo test -p fairground-clearing --locked` both run the 389 shared clearing vectors in `crates/clearing/tests/vectors.json`. | Unit | Node 24; Rust |
| C15 | Demand sets the final supply: tokens nobody bought are burned, and every mint and burn is logged. | Open `/sale/thistle/result` (a seeded sale that drew too little demand). See "107,800 of 400,000 THSL sold" and "27%", and the reveal ending "292.2K THSL burned". Under **Where every token went**: "Supply at launch 1,000,000", "Supply after the sale 707,800 THSL, 29% less", and a table (sold to winners 107,800, creator allocation 100,000, LP reserve 500,000, burned 292,200) that adds up to 1,000,000; the page says the LP reserve row exists only on the simulated chain. Under **Mint and burn log**: "Minted 1,000,000 THSL" at sale creation and "Burned 292,200 THSL" by the creator payout (`claim_proceeds`), each with its transaction, then "Token supply now: 707,800 THSL". A sold-out sale burns nothing: `/sale/lantern/result`. | Mock | Browser |
| C16 | Each token gets its own page after the sale. | Open `/token/thistle`, or click **Token page** in a settled result's header or on a settled row of `/sales`. See the tab title "$THSL on Sealround", launch price "0.001 USDC per THSL", "Supply now 707,800", "Burned at launch 292,200, 29% of the launch supply", "Holders at launch 19", "Raised 107.8 USDC", the line "This launch burned 29% of its supply because demand did not take it.", the supply story from C15, and "How it launched: 19 bids, one price." `/token/driftwood` says "No DRFT to trade" (the sale failed and refunds every valid bid); `/token/moth` says "$MOTH launches when sale moth settles". | Mock | Browser |
| C17 | The landing page shows how much supply demand burned across launches. | Open `/` and scroll to "Demand sets the supply.". In a fresh browser: "15%" "of each launch's supply burned because demand did not take it, on average across 2 launches"; Launches 2, Burned 1, Sold out 1; a note that 1 sale missed its minimum raise and is counted apart; newest launches "Thistle $THSL 29% burned" and "Lantern $LNTN 0% sold out", each linking its token page. Every judge run or sale you settle adds a launch and moves the average. | Mock | Browser |
| C18 | Finished sales are ranked by how widely their tokens spread. | Open `/sales`, scroll to **Fair-launch leaderboard**. In a fresh browser, by Top 10 share: 1 Lantern (top 10 share 39.8%, Gini 0.29, bots' share 12.5%, burned 0%, 41 of 49 winners, 0.0016 USDC), 2 Thistle (72.5%, 0.25, 9.3%, 29%, 19 of 19, 0.001 USDC), then Driftwood without a rank: "Refunded. Missed its minimum raise." **Rank by** Gini puts Thistle first; **Bots' share** is the third option (mock only: a real contract stores no roles). | Mock | Browser |
| C19 | The result page compares the sale with the Arena's launches and hands winners off to trading. | On `/sale/thistle/result`, **Fair-launch scorecard** (after "Who got the tokens"): this sale, then the Arena's averages for Sealround, bonding curve and first come. Bots' share of tokens sold 9.3% (15.7%, 34.5%, 20.9%); price people paid over bots 1.00× (1.00×, 2.61×, 1.00×); bot profit 0 USDC (0, 1,269, 177); Gini 0.25 (0.50, 0.52, 0.50). Thistle and Lantern have no pool and say "No Sealround pool". After a `/judge` run, its full result's **Launch pool** panel ends with **Trade on Rhea** and "Simulated pool: nothing trades on it, so this opens Rhea's home page." | Mock | Browser |
| C20 | A sale page shows live demand and the reveal, with no price visible. | Open `/sale/kiln` (window ended, not closed). **Demand at the close**: "217.36 USDC from 33 sealed bids", the 50 USDC min raise "Covered", "Covered 1.81×" and "the clearing price cannot go above 0.001811 USDC" (a bound from the public deposits, not a forecast); **Bids over time** with **Show as a table**; **What the chain sees**: "228 bytes + the account name" and "33 of 33" bids at exactly that size. Click **Close sale** (no wallet needed): the status panel says "Opening 33 sealed bids in the enclave" with three steps, then moves to `/sale/kiln/result` within seconds (0.00149 USDC, all 29 winners, 120,000 of 120,000 KILN sold). On the open sale `/sale/fairt`: the countdown, **Add the reveal to your calendar** (an `.ics` file made in the browser), **Copy watch link** and **Demand so far**. | Mock | Browser |
| C21 | A creator can start from a meme launch preset and give the token an icon. | Open `/create`. **Start from a preset**: **Pure fair launch** fills 900,000 for sale, floor 0.001 USDC, min raise 100 USDC, deposits 2 to 25 USDC and a 5-minute window; **Pool first** adds a launch pool with 20 % of the raise; **Community burn** sets floor 0.002 USDC and min raise 900 USDC. Name, symbol, icon and description stay as typed; editing a number shows "Custom"; **Undo** restores the values from before the first preset. **Icon**: **Generate** (up to 3 letters or one emoji), **Upload** (shrunk until it fits the contract's 2,048-byte limit) or **None**. Seeded sales show their marks on `/sales` and in the sale and result headers. | Mock | Browser |
| C22 | After `/create`, the creator gets a launch kit. | On `/create` pick a preset, type a name and symbol, click **Review**, **Connect to create** (the demo wallet), then **Create sale and lock the rules**: the app lands on `/sale/<id>/kit`, "Your launch kit". Or open `/sale/moth/kit` directly (it is public). See bids open, close and reveal times in UTC and in your time zone, **Add the reveal to a calendar**, a countdown image and a link preview with **Download PNG**, three posts for X, each with its length counted the X way ("N of 280") and ending "Simulated sale on Sealround." plus the sale link, a watch link, a QR code (**Download PNG**, **Download SVG**) and "What bidders need". | Mock | Browser |
| C23 | Share cards: "I'm in" after a bid, "No bot paid less" after a win, a countdown for the creator. None shows a max price or a deposit. | With `pnpm dev` running: `curl -s -o bid.png "http://localhost:3000/api/og/bid?sale=fairt&bid=29&name=Fair+Test&ticker=FAIRT"`, `curl -s -o win.png "http://localhost:3000/api/og/win?sale=thistle&win=2&name=Thistle&ticker=THSL&got=3280000000000000000000&dec=18&price=1000&winners=19&bids=19"` and `curl -s -o countdown.png "http://localhost:3000/api/og/countdown?sale=moth&name=Moth&ticker=MOTH&start=1798761600000&end=1798783200000&floor=1500"` each give a 1200x630 PNG: "I'm in. Sealed bid #29 in $FAIRT"; "No bot paid less. I got 3,280 $THSL at 0.001 USDC each."; "Bids open 00:00 UTC Fri, 1 Jan 2027". Each says "Simulated sale". A bad or missing parameter gives the generic app card, never an error. `curl -s "http://localhost:3000/sale/fairt?bid=29&name=Fair+Test&ticker=FAIRT" \| grep og:image` points at `/api/og/bid`. In the app: bid on `/sale/fairt` (Connect first): **Show you're in** appears under the bid; on the result of a `/judge` run in which your own bid won: **Share your win**. | Mock | Browser, curl |

Read-only testnet helpers used above (bash; Node 24 has `fetch`):

```sh
view() { node -e 'const [a,m,j]=process.argv.slice(1);fetch("https://rpc.testnet.near.org",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:a,method_name:m,args_base64:Buffer.from(j).toString("base64")}})}).then(r=>r.json()).then(r=>console.log(Buffer.from(r.result.result).toString()))' "$1" "$2" "$3"; }
keys() { curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}}"; echo; }

view fairground.itzbeast.testnet get_result '{"sale_id":"smoke-11120830"}'   # "status":"settled","clearing_price":"2000",...,"failed_checks":[]
view smoke-11120830.fairground.itzbeast.testnet ft_total_supply '{}'          # "900000000000000000000"
keys fairground.itzbeast.testnet                                              # one FullAccess key: this contract was never locked
```

### Where each Memecoins With Mechanics brief item is

| Brief item | Where |
| --- | --- |
| A mechanic in an NEP-141 contract | Each sale deploys its own NEP-141 token (`contracts/token`) to `<sale_id>.<contract>`, mints the fixed supply once to the sale contract and burns what does not sell. The token has no mint method and no owner, and emits NEP-297 `ft_mint` and `ft_burn` events. The auction itself is `contracts/fairground`. |
| Parameters fixed at launch, no admin key | C5 |
| Sybil limits written plainly | [Section 11](#11-sybil-limits) |
| Supply that reacts to the community | The sealed bids set the clearing price, and every token they did not take burns at the creator payout, so demand sets the final supply. Seeded sale Thistle: 107,800 of 400,000 sold, 292,200 burned, supply 1,000,000 to 707,800 (`/sale/thistle/result` "Where every token went", C15; `/token/thistle`, C16). The landing page's "Demand sets the supply." averages the burn across launches (C17); `/sales` ranks finished sales with their burned share (C18). |
| A progress page with a log of every mint and burn | Progress: `/sale/<id>` shows the countdown, deposits against the minimum raise, bids over time and the sealed-bid size check while bids are open, then "Opening N sealed bids in the enclave" at close (C20). Mint and burn log: `/sale/<id>/result` and `/token/<id>` list the one mint at sale creation and the burn at the creator payout with their transactions and the supply now (C15, C16). The sale's on-chain event log ("History") has creation, bids, close, settlement, every claim, the creator payout with the burn and the launch pool's events. The token's own `ft_mint` and `ft_burn` events are on the explorer. |
| A simulation of community behaviour before choosing parameters | C11 and the Bot Arena ([section 6](#6-bot-arena-results)) |

## Contents

1. [What Sealround is](#sealround) (above, with the claims table)
2. [Try it in 2 minutes with no funds](#2-try-it-in-2-minutes-with-no-funds)
3. [How the auction works](#3-how-the-auction-works), including [the launch pool](#launch-pool-at-the-clearing-price)
4. [What NEAR does here](#4-what-near-does-here)
5. [Architecture and trust assumptions](#5-architecture-and-trust-assumptions), including [verify a sale yourself](#verify-a-sale-yourself)
6. [Bot Arena results](#6-bot-arena-results), including [simulate your own launch](#simulate-your-own-launch)
7. [Testnet results](#7-testnet-results)
8. [Run it locally](#8-run-it-locally), including [tests](#tests) and [bidding from an AI agent](#bid-from-an-ai-agent-mcp-server-and-skill)
9. [Argue against this idea](#9-argue-against-this-idea)
10. [Failure cases](#10-failure-cases)
11. [Sybil limits](#11-sybil-limits)
12. [Libraries, AI-assisted code, baseline](#12-libraries-ai-assisted-code-baseline)
13. [Roadmap (not built)](#13-roadmap-not-built)
14. [License](#14-license)

Also: [Repository layout](#repository-layout), [Deploying](#deploying).

## 2. Try it in 2 minutes with no funds

Judge mode runs a whole sale in your browser: 50 fictional people, 3 sniper bots and 1 copycat bid, the sale closes, the enclave clears it, the launch pool is seeded, and you get the result. The chain, the accounts, the enclave, its attestation, the relayer and the pool are simulated; the bid encryption and the clearing math are the real code (see [Three ways to run it](#three-ways-to-run-it)).

**Hosted demo.** As of 13 Nov 2026, https://sealround-demo.vercel.app serves a build from before commit `e59239c`, although `main` is at `576047c`. It has judge mode, but nothing added in `e59239c`, `4bd6e5a` or `576047c`: no launch pool, launch simulator, real attestation checks, fairness timeline, share cards, token icons, presets, demand meter, supply story, scorecard, token pages, leaderboard, burn counter or launch kit (`/token/thistle` and `/sale/moth/kit` answer 404 there). Claims C15 to C23 need a local run until the owner redeploys. `<owner: delete this paragraph after redeploying the demo>`. Locally, everything below works:

```sh
pnpm install     # about 1 minute on a fresh clone
pnpm dev         # http://localhost:3000
```

Requirements: Node 24 and pnpm 12.3.4 (pinned in `package.json`; `corepack enable` installs it).

| Do | See |
| --- | --- |
| Open `/judge` | "Judge mode", a **Run demo** button ("About 35 seconds. No wallet, no funds.") and "The run in nine steps" |
| Optional: under **Demand**, pick **Low**, **Normal** (the default) or **High** before **Run demo** | The same sale with a smaller or larger crowd. **Low**: it clears at the floor (0.001 USDC), about 56 % of the 100,000 for sale sells, and the run pays the creator, so about 52,800 tokens burn. The summary then reads, for the first run in a fresh browser, "Demand took 56,010 of the 100,000 JDG1 for sale, so every valid bid filled in full at the floor. 52,788 JDG1 burned at the creator payout". **High**: it sells out at roughly 3.5x to 4.1x the floor. The choice is remembered in this browser. |
| Click **Run demo** | A live timeline: Create the sale, Enclave makes the sale key, 3 sniper bots bid at second 0, 50 people bid over the window, A copycat replays a sealed bid, The bid window runs out, Anyone closes the sale, Enclave clears the sale, Result. Bids stream in as ciphertext only. |
| Wait about 35 seconds | "Every winner paid one clearing price" with the price in USDC per token; **Bots paid** and **People paid** side by side at the same price; "Bots and people paid exactly the clearing price." and "The copycat's bid was void: 0 tokens, ... USDC back, ... USDC kept as the 1 % penalty."; a **Time to result** stat under the 2:00 goal (0:34 on 13 Nov 2026 with the dev server) |
| Click **Open the full result** | `/sale/judge-<n>/result` (`judge-1` in a fresh browser), described in the next table |
| Optional: click **Connect** (top right), then **Run again** | A simulated wallet with 100 test USDC. During the run, the "Add your own sealed bid" form takes a max price, max spend and deposit; **Seal and bid** seals it in the browser. The summary then shows your fill at the same price as the bots. |

The result page, top to bottom (all present in judge mode, labelled simulated where they are):

| Part | What it shows |
| --- | --- |
| Header | The token's icon, **Token page** (C16), the clearing price, the multiple of the floor, "All N winners paid this price", **Share on X** (a plain link to X's post intent with one factual sentence and the result link; no script from X loads) |
| "Your result" | The connected account's fill and claim. A winner also gets **Share your win**, the winner card (C23) |
| "From sealed bids to one price" | The reveal: sealed bids, opened in the enclave (valid and void), one price, sold out or burned. It plays once per browser, then shows its final state. |
| "Early or late, one price" | The fairness timeline: every bid placed by when it landed in the window. Winners sit on the clearing-price line, the first bot and the last person among them. Max prices are never shown. |
| "Bot or person, same price" | What bots and people each paid per token |
| "Where every token went" | Supply at launch and after the sale, a table of every part that adds up to the total supply, and the mint and burn log (C15) |
| **Launch pool** | Stage, pool id, amounts, pool price next to the clearing price, who holds the LP shares, the **Seed** or **Abandon** buttons anyone can press, and **Trade on Rhea** once seeded (C19) |
| **Verified** | The attestation checks ([section 5](#verify-a-sale-yourself)), the recomputed bid set, "Check any account" (your bid is #k of N), the contract's 14 checks |
| "Where's my money", fills, "Who got the tokens", History | Every bid's deposit, tokens, spent, penalty and refund; the holder spread and the fair-launch scorecard (C19); the on-chain event log |

Other pages:

| Page | What it shows |
| --- | --- |
| `/` | Landing page: the comparison with bonding curves, first-come sales and public auctions, and the burn counter "Demand sets the supply." (C17) |
| `/sales` | The sales board (settled rows link their token page) and the fair-launch leaderboard (C18) |
| `/how` | The clearing rule, a worked example, what is public and what is sealed, trust assumptions, failure cases, honest limits |
| `/arena` | Bot Arena charts, all read from the output of `pnpm arena` ([section 6](#6-bot-arena-results)) |
| `/sale/lantern/result` | A settled, oversubscribed sale with sniper bots and a copycat whose bid was voided; sold out, so nothing burns |
| `/sale/thistle/result` | A settled, undersubscribed sale: 27 % sold at the floor, 292,200 THSL burned (C15) |
| `/sale/driftwood/result` | A sale that missed its minimum raise: everyone refunded |
| `/sale/ashfall` | A sale whose enclave never answered: refund mode after the settle timeout |
| `/sale/kiln` | A sale whose window has ended: **Close sale** (no wallet) shows the enclave opening the bids, then the result (C20) |
| `/sale/fairt` | An open sale (the spec's reference parameters) with the live demand meter and countdown (C20), **Fund from any chain**, live 1Click dry quotes and simulated swaps |
| `/sale/moth` | An upcoming sale; its launch kit is `/sale/moth/kit` (C22) |
| `/token/<id>` | A token's page after its sale: launch price, supply now, burned, holders, raise, trading, the supply story (C16) |
| `/sale/<id>/kit` | The creator's launch kit: times, countdown image, posts for X, QR code (C22) |
| `/create` | **Launch a sale**: **Start from a preset** (C21), the token with its icon, the parameters, **Bid privacy** (enclave by default, or commit-reveal), the optional **Launch pool**, **Simulate this launch** ([section 6](#simulate-your-own-launch)), then **Review the rules** ("Nothing can be changed once the sale is created.") with the cost, and **Create sale and lock the rules**, which opens the launch kit |

The demo state lives in your browser's localStorage. "Reset demo data" in the page footer wipes it.

**Share cards.** Every page has an Open Graph and X card (`apps/web/src/lib/og/`). In NEAR mode a sale's and a token's card are drawn on the server from the contract's views (the clearing price once settled; for a token, its launch price, supply, burn, holders and raise). In mock mode the server cannot see sales that live in your browser, so a sale or token page gets the generic card. Check: `curl -s http://localhost:3000/sale/lantern/result | grep og:image` prints an `opengraph-image` URL that returns a PNG. Three image routes take what they draw from the link in mock mode and from the chain in NEAR mode: `/api/og/bid` ("I'm in", served as the sale page's preview with `?bid=`), `/api/og/win` ("No bot paid less", the result page's preview with `?win=`) and `/api/og/countdown` (the launch kit's countdown). C23 has the commands.

## 3. How the auction works

Sealround runs a uniform-price, sealed-bid batch auction. Nobody sees bids until the window closes, and every winner pays the same clearing price.

1. **The creator sets the sale**: supply for sale, floor price, minimum raise, bid window, deposit limits, maximum number of bids, settle timeout, and optionally a launch pool. The contract deploys the sale's token with a fixed supply. Every parameter is locked at creation; there is no admin key.
2. **The bidder gets USDC on NEAR**, either already held or funded from another chain through NEAR Intents 1Click.
3. **The bidder places a sealed bid**: a public USDC deposit plus an encrypted payload (max price, max spend, salt) that only the sale's enclave can open. Encryption happens in the browser.
4. **The window closes.** Anyone can call `close_sale`. The bid set is frozen and its hash is already on chain.
5. **The enclave clears the sale.** It opens every bid, computes the clearing price and the fills, and returns a result. The contract checks it, then settles.
6. **The pool is seeded**, if the sale has one: anyone calls `seed_liquidity` (below).
7. **Everyone claims.** Winners get tokens at the clearing price plus any unspent USDC. Losing bids get their deposit back. If the minimum raise is missed or clearing fails, everyone is refunded (an invalid bid less a 1 % penalty, see [Failure cases](#10-failure-cases)).

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

### Launch pool at the clearing price

Optional, per sale, and fixed at `create_sale` with the other rules: `liquidity: {raise_share_bps, pool_tokens, fee_bps}` (share of the raise 0.01 % to 50 %, the sale tokens reserved for the pool, pool fee 0.01 % to 10 %). On `/create` the **Launch pool** section is off by default; turned on, it suggests 20 % of the raise and a 0.3 % fee. It is shown only when the contract's config names an exchange (`dex`: `ref-finance-101.testnet` on testnet, `v2.ref-finance.near` on mainnet).

At settlement the contract plans the pool from the raise and the clearing price (`ONE` = one whole token in base units):

```
budget = floor(raise * raise_share_bps / 10000)
tokens = min(floor(budget * ONE / price), pool_tokens)
usdc   = ceil(tokens * price / ONE)
```

So the pool's price is the clearing price, at most one USDC base unit above it in total and never below. Reserved tokens the pool does not take are burned with the unsold supply.

- **Seeding.** Anyone calls `seed_liquidity(sale_id)`, with no deposit (the relayer policy sponsors it). It runs four steps on Rhea: register, create the pool, deposit both tokens, then `add_liquidity` with `min_amounts` equal to the amounts. 300 TGas runs all four (54.5 TGas burnt in the sandbox); a relayed 150 TGas call runs one or two ([contracts/GAS.md](contracts/GAS.md) "Launch liquidity").
- **LP shares.** They stay with the sale contract, which has no method that moves, transfers or redeems them and no access key once deployed. The liquidity cannot be pulled.
- **Token lock.** Until the pool is seeded, no sale token leaves the contract: claims pay refunds only and the creator's allocation waits. The whole supply was minted to the contract, so nobody else can open a pool at another price first.
- **Fallback.** If seeding has not finished by the deadline (settlement plus `settle_timeout`), anyone calls `abandon_liquidity`: the tokens unlock at once, whatever is on the exchange is withdrawn, the pool's USDC goes to the creator and its tokens are burned. A failed sale burns the whole reserve.
- **Lost results.** A step with no result after 600 blocks is given up; the next call reads the exchange (`get_deposits`, then `get_pool_shares` or a page of `get_pools`) before it goes on, so no pool is created twice and no deposit is sent twice. Each callback carries an attempt number, so a late or duplicate result changes nothing.
- **What Rhea controls.** Rhea's owner and guardians can pause the exchange, freeze a token or change a pool's fee. The contract only guarantees that it never removes the liquidity itself.

Code and tests: `contracts/fairground/src/liquidity.rs`, 22 unit tests (`contracts/fairground/src/tests/liquidity.rs`), 9 sandbox integration tests against Rhea's v1.9.19 wasm (`contracts/tests/src/liquidity.rs`). Full design: [contracts/DESIGN.md](contracts/DESIGN.md) "Launch liquidity". Not yet run on testnet: see the evidence sale in [section 7](#7-testnet-results).

## 4. What NEAR does here

| Piece | What it does in Sealround | Where |
| --- | --- | --- |
| **OutLayer TEE** (Intel TDX) | Runs our sealer job, `fairground-sealer`. Each sale gets its own X25519 key, derived inside the enclave from an OutLayer secret: `HKDF-SHA256(master, salt "fairground/sealer/v1", info "sale-key" 0x00 contract_id 0x00 sale_id)`. At `create_sale` the contract asks the job for the sale's public key; at `close_sale` it sends the frozen bid set through OutLayer's yield/resume `request_execution`, and the job opens the bids and clears the sale. The job's wasm sha256 is fixed in the contract at deployment. The contract records the block of each request (`get_sale.key_request_block`, `get_result.clear_request_block`), which the verifier uses to find the run. | `enclave/`, `crates/sealer`, [enclave/README.md](enclave/README.md) |
| **Contract-side checks** | The contract trusts the enclave only for the hidden prices. Before settling it checks, by name: `sale_id_matches`, `bid_set_hash_matches`, `pubkey_matches`, `one_fill_per_bid`, `invalid_list_matches`, `price_at_least_floor`, `price_at_most_ceiling`, `sold_at_most_supply`, `spent_within_deposit_<i>`, `spent_equals_tokens_times_price_<i>`, `invalid_bid_unfilled_<i>`, `raise_at_least_min`, `something_sold`, plus `output_well_formed`. The failed names are stored and shown. | `contracts/fairground`, [contracts/DESIGN.md](contracts/DESIGN.md) "Methods" |
| **Rhea** (formerly Ref Finance) | The optional launch pool: a constant-product pool opened at the clearing price, its LP shares held by the sale contract ([section 3](#launch-pool-at-the-clearing-price)). | `contracts/fairground/src/liquidity.rs` |
| **NEAR Intents 1Click** | "Fund from any chain" previews the cost and timing of a swap to USDC on NEAR with a dry quote. On a mainnet deployment configured for Circle's native USDC, the server flag `ONECLICK_REAL_SWAPS=1` also lets bidders request a deposit address; it also requires a receipt signing secret and a shared Redis quota. Status and submit calls need a signed, expiring receipt for the deposit, and responses leave out the private quote. On mainnet the bidder can ask for 1Click's `confidentiality: "basic"` mode; the proxy refuses a response that drops it, and the form says the NEAR bid deposit itself stays public. Demo and testnet swaps are simulated; live swaps are off by default and are tested with local fixtures only. | `apps/web/src/lib/oneclick.ts`, `apps/web/src/app/api/oneclick` |
| **Gas relayer** (NEP-366) | Bidders sign a delegate action; the relayer pays the gas, and the 1 yoctoNEAR `ft_transfer_call` needs, for bids, claims, reveals, `clear_onchain`, `claim_proceeds`, `trigger_refund_mode`, `seed_liquidity` and `abandon_liquidity`. It also pays a new bidder's one-time USDC storage registration. It never relays a payable call (`create_sale`, `close_sale`, `retry_setup`), checks the exact sealed-bid length before paying, checks that a creator payout or pool step is due before paying for it, and stores only rate-limit counters and pending reservations in memory. A bidder needs USDC and no NEAR. | `apps/relayer`, `packages/relayer-client` |
| **NEP-141 token per sale** | The contract deploys each sale's token to `<sale_id>.<contract>`, mints the fixed supply to itself once, and burns unsold tokens. No mint method, no owner. | `contracts/token` |
| **NEAR Connect** | Wallet login (HOT, Meteor, Intear, MyNearWallet, NEAR Mobile, OKX and others) in NEAR mode. | `apps/web/src/lib/wallet.tsx` |
| Chain signatures | **Not shipped.** Delivery to Base through chain signatures is on the [roadmap](#13-roadmap-not-built). | |

A commit-reveal mode is also shipped, as a fallback that needs no TEE: bids are `sha256` commitments, a reveal window follows the close, and the contract clears on chain with `clear_onchain`. It is weaker (prices become public at reveal) and is selectable per sale on `/create`.

The privacy track brief centres on NEAR AI Cloud. Sealround uses OutLayer's TEE instead, since the sealed bids have to be opened by code that a NEAR contract calls and pins by hash.

## 5. Architecture and trust assumptions

The contract is the centre: it holds the money, deploys tokens, checks every clearing result and holds the pool's LP shares. OutLayer only sees and sorts the hidden prices.

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
                                                          |  optional, after Settled: seed_liquidity
                                                          v
                                                        Rhea exchange: pool at the clearing price,
                                                          LP shares owned by the sale contract
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

Launch pool, only for a sale with one:
  waiting (sale not final) -> seeding (Settled) -> seeded
                                                -> abandoned (deadline passed, abandon_liquidity)
                           -> skipped (pool would be empty) | cancelled (sale Failed)
```

### What you trust

- **OutLayer's TEE** keeps bid prices secret and runs the published job. The job's hash is pinned in the contract at deployment and cannot change; the contract only ever asks OutLayer to run that exact build.
- **OutLayer's master secret (known privacy risk).** OutLayer's own docs say a DAO full-access key can currently obtain the shared master secret outside an enclave. Whoever holds it could derive a sale's key and read its sealed bids. The contract would still check the clearing math and the payouts, but price privacy would not hold. OutLayer governance today (one account approves enclave measurements, contracts upgraded by key, a closed-source coordinator) is written up in [enclave/README.md](enclave/README.md), section 11.
- **OutLayer's liveness.** If its workers stop, sales cannot clear and end in full refunds after their settle timeout.
- **The deployer.** The contract account's full-access key must be deleted before anyone bids, or its holder could make OutLayer open bids (a deployment invariant, [contracts/DESIGN.md](contracts/DESIGN.md) "Deployment invariants"). Check it with `keys <contract>` ([claims](#claims-and-how-to-check-them), C5). The account that owns the OutLayer project and secret can stop sales from clearing (they then refund) and could change the secret's access condition to admit another build, so bidders trust that account too; any such change is a public NEAR transaction.
- **Rhea**, only for a sale with a launch pool. Its owner can pause the exchange, freeze a token or change the pool's fee. A paused exchange makes seeding fail until the deadline, after which the pool is abandoned and the tokens unlock.
- **NEAR Intents 1Click** routes funding through solvers. When 1Click confirms a refund, it goes to the refund address the bidder supplied on the origin chain.
- **The gas relayer** only pays gas. It cannot move anyone's funds.
- **The contracts are unaudited.**

### Verify a sale yourself

The result page's **Verified** panel and the `verify-sale` command run the same code (`apps/web/src/lib/near/attestation.ts`, `attestation-sources.ts`, `apps/web/src/lib/bid-inclusion.ts`). Both are read-only: no key, no transaction.

```sh
pnpm --filter web verify-sale --contract <contract> --sale <sale-id> [--network testnet|mainnet] [--rpc <url>] [--json]
```

For each enclave run of the sale (the sale key at `create_sale`, the clearing at `close_sale`) it finds the transaction (by scanning the block the contract recorded, then OutLayer's job list), fetches OutLayer's attestation for it (`/attestations/by-tx/<hash>`) and runs eight checks:

| Check | Passes when |
| --- | --- |
| build | The attested wasm hash equals the sealer hash the contract pins |
| executed | The worker measured the same build |
| input | sha256 of the request input on chain equals the attested input hash (and, for the clearing, the contract's stored `input_sha256`) |
| output | sha256 of the bytes the contract received equals the attested output hash (and the stored `result_sha256`) |
| task | The TDX quote's report data commits to this attestation record |
| measurements | OutLayer's register contract (`worker.outlayer.testnet` or `.near`) answers `is_measurements_approved: true` for the quote's measurements |
| request | The request came from the sale contract, for this sale and this operation |
| key | The job's answer names the sale's public key stored on chain |

Then it lists every bid (`get_bids`), recomputes the bid-set hash chain and compares it with the hash the contract froze at close. On the result page, "Check any account" finds a bidder's bid in that set ("bid #k of N, counted").

Not checked here: the quote's signature chain up to Intel. The panel and the command link OutLayer's verifier for that step. OutLayer's attestation endpoints take no verifier nonce ([contracts/DESIGN.md](contracts/DESIGN.md) "Spec deviations" 1), so each run is tied to the sale by its hashes, and its block and time are shown.

By mode: on testnet everything above is real (16 of 16 for `smoke-11120830`, section 7). On a local sandbox no attestation service exists, so both runs report "no OutLayer service" and only the bid set is checked. In judge mode the panel shows the same rows against an unsigned, simulated attestation, labelled simulated; the sha256 values are real hashes of the simulated request and answer. `enclave/deploy/Verify-Attestation.ps1` is the PowerShell original of these checks.

### Pinned hashes

| Artifact | sha256 | How to check |
| --- | --- | --- |
| `contracts/res/fairground.wasm` (sale contract, embeds the token; 616,196 bytes) | `e93c42759bd63edfba428cf16f043bdad1ae2f3a54d45ca8f9f41e74fe65a941` | `sha256sum contracts/res/fairground.wasm`. On chain, `view_account` reports it in base58 as `GhTHg5s7c97X8gALyghMchc8o51AnjYD4qDeStHPvMM2`. Built with `scripts\build-contracts.ps1`. The reproducible container build is configured (NEP-330 metadata) but has not been run yet, see [contracts/DESIGN.md](contracts/DESIGN.md) "Reproducible build" |
| `enclave/res/fairground_sealer.wasm` (the OutLayer job) | `f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb` | `powershell -File scripts\build-enclave.ps1 -Verify` rebuilds it in Docker and prints `verify: MATCH`. The single source of truth is `enclave/res/fairground_sealer.wasm.sha256` |
| `contracts/res/fairground_token.wasm` | `0b1673bf822def860a637059ff55e839cc47f8c1dacee46b284080bbe7450047` | Embedded in `fairground.wasm` |
| `contracts/res/outlayer_contract.wasm` (third party, tests only) | `74ab074a27ccddd9b6f400f3f8453c1039419acba556ba77dfb288759b3dbd0f` | [contracts/res/NOTICE.md](contracts/res/NOTICE.md) |
| `contracts/tests/res/ref_exchange.wasm` (Rhea v1.9.19, third party, tests only, not in git) | `8918c505017ceb57646bdd863c34e4fe56e2edc7756963d6f4a1f38d6f9c34d2` | `node scripts/fetch-rhea-wasm.mjs` reads it from `ref-finance-101.testnet` and keeps it only if this hash matches; [contracts/tests/res/NOTICE.md](contracts/tests/res/NOTICE.md) |

Measured costs: a 500-bid clear takes 3.14e9 wasm instructions and about 0.2 s on a laptop, against OutLayer's 60 s limit ([enclave/PERF.md](enclave/PERF.md)); closing a 500-bid TEE sale burns 132 TGas and fits one transaction; seeding a launch pool in one call burns 54.5 TGas ([contracts/GAS.md](contracts/GAS.md)).

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

```sh
pnpm arena                        # 60 runs, prints the table above, writes apps/web/src/data/arena-results.json
pnpm arena --seed 5 --no-write    # another seed, prints only
pnpm --filter @fairground/arena test
```

The `/arena` page reads `arena-results.json`, so every number on it comes from that command; none is typed by hand. On 13 Nov 2026 `pnpm arena` took 91 ms for the 60 runs and left the committed file unchanged. `/arena` also charts "Sealround: supply burned as demand changes": the share of the sale supply nobody bought, which is burned when the creator is paid.

### Simulate your own launch

`/create` has a **Simulate this launch** section. It runs the Arena's crowd model (`packages/arena/src/creator.ts`) against the creator's own rules: sale supply, floor, max price, minimum raise, deposit limits, the 100 bid slots and the launch pool. It sweeps demand from 0.5× to 4×, five crowds per level, with 50, 200 or 1,000 people per crowd plus 5 sniper bots that bid first. It shows whether the minimum raise is met, the clearing price, the raise, what sells and what is burned, how many people find the bid slots full, and what the bots make. It runs in the browser; changing a field reruns it.

The bots' profit is not always zero here, and the page says why. With the form's defaults (600,000 tokens at a 0.001 USDC floor, 50 USDC minimum raise, 1 to 10 USDC deposits, 100 bid slots) and 200 people per crowd, the bots pay the clearing price like everyone else, but after the sale they make 1.58, 3.97, 7.36 and 9.46 USDC at 0.5×, 1×, 2× and 4× demand (up to 9.70 at 3×). They sell to people the sale turned away (all bid slots taken) or held to the 10 USDC cap. With bid slots and a cap that fit every bid, their profit is 0 at every level, matching the Arena. `pnpm --filter @fairground/arena test` checks both ("bots profit only from demand the sale turned away or capped").

### Live bot

`pnpm --filter web live-bot` runs an openly operated sniper bot against a real Sealround contract on testnet, mainnet or a local sandbox, through the same client code the web app uses in NEAR mode. `snipe` bids as soon as the sale opens with a high max price, `copycat` replays another bidder's sealed bid under the bot's own account, and `report` checks what the bot paid against the clearing price. `bid` places one sealed bid within an explicit `--budget`, `result` reads a fill and the clearing price with no key, and `reveal` and `status` also exist. Its key comes from an environment variable or a near-cli credentials file, never a flag. Usage: [apps/web/scripts/live-bot/README.md](apps/web/scripts/live-bot/README.md).

`pnpm --filter web exec tsx scripts/live-bot/sandbox-test.ts` runs the bot against the real contract and the pinned enclave job on a local sandbox (Docker): 8/8 scenarios, 69/69 checks on 13 Nov 2026. The bot bids in the first block it can after the open, two copycats replay sealed bids (one refused for its length, one voided with the 1 % penalty), and `report` shows the bot paid exactly the clearing price.

## 7. Testnet results

Two contract builds are involved. The smoke sale ran on the build before launch liquidity; the evidence sale runs on the current build (`e93c4275…a941`). Placeholders in angle brackets are filled by the owner from `powershell -File enclave\deploy\8-evidence-sale.ps1 -Phase Report`, which prints this section's evidence as Markdown.

### Smoke sale `smoke-11120830` (12 Nov 2026, older contract build)

- Contract: [`fairground.itzbeast.testnet`](https://testnet.nearblocks.io/address/fairground.itzbeast.testnet). Its code hash is `bfc2f80059936d4344aafc136aacfed3b1ce37ace7814bfefde6e88cdc3ea800`, the `contracts/res/fairground.wasm` committed at `721b00d` (check: `git show 721b00d:contracts/res/fairground.wasm | sha256sum`). That build has no launch pool.
- **Not locked.** The account still has its deployer's full-access key (`keys fairground.itzbeast.testnet`). This sale proves the TEE path on testnet; it does not prove the no-admin-key claim.
- One bidder (the project owner), signing directly rather than through the relayer. Token `SMOKE`, 1,000 minted, 600 for sale, floor 0.002 USDC.

| Step | Transaction | What happened |
| --- | --- | --- |
| Contract deployed, `new` | [GQbGQHxR…](https://testnet.nearblocks.io/txns/GQbGQHxR8kZkVQj14szyvMhf4k3c82TvgjSXYKkFbzaW) | 08:30:11 UTC |
| `create_sale` | [9VTgvUt8…](https://testnet.nearblocks.io/txns/9VTgvUt8FhEPq2U22wFJDWv8hVf7g6q2wD8rY8qhZdem) | The enclave made the sale key. OutLayer request 29835, attestation #65871 ([record](https://testnet-api.outlayer.ai/attestations/by-tx/9VTgvUt8FhEPq2U22wFJDWv8hVf7g6q2wD8rY8qhZdem), [OutLayer verifier](https://app.outlayer.ai/attestation/71518?network=testnet)) |
| Bid (`ft_transfer_call` on `usdc.fakes.testnet`) | [BjRCTZGW…](https://testnet.nearblocks.io/txns/BjRCTZGWB8NvhWCUwTWHw6hiLJnrT6EgFU7vWFTMFhN3) | 1 USDC deposit, 107 s after the 08:33:12 open; 10-minute window |
| `close_sale` | [E7CEppqP…](https://testnet.nearblocks.io/txns/E7CEppqPTqGuT5E7eXEMTWaJGzjFrTDw4wDFmVinDVDS) | 08:48:26. The enclave cleared the sale. OutLayer request 29915, attestation #66245 at 08:48:30 ([record](https://testnet-api.outlayer.ai/attestations/by-tx/E7CEppqPTqGuT5E7eXEMTWaJGzjFrTDw4wDFmVinDVDS), [OutLayer verifier](https://app.outlayer.ai/attestation/71893?network=testnet)) |
| Result (`get_result`) | | Settled at 0.002 USDC per token (the floor: undersubscribed). 500 tokens sold for 1 USDC, 1 valid bid, 0 invalid, `failed_checks: []` |
| `claim` | [CNd94pWy…](https://testnet.nearblocks.io/txns/CNd94pWyABEScoi5bUuBv76YN6EHgdVyATUtUcLK1SUk) | The bidder's 500 tokens paid (`get_bids` shows `claimed: true`) |
| `claim_proceeds` | [HEoku3ii…](https://testnet.nearblocks.io/txns/HEoku3iijLQjkqiCU31k8Li5VMQrHA51kfca6GGz2S7C) | Raise and creator allocation paid; the 100 unsold tokens burned (`ft_total_supply` is 900 tokens) |

Check it yourself (read-only, ran on 13 Nov 2026):

```sh
pnpm --filter web verify-sale --contract fairground.itzbeast.testnet --sale smoke-11120830
```

Output: both runs found through OutLayer's job list; 8 of 8 checks pass for the sale key run and 8 of 8 for the clearing run; "Bid set: [PASS] 1 of 1 bids listed; recomputed 4019e54cc1dc35323be5145d0238dd930c6ccf6715f82038f5395df07d055608 = frozen 4019e54cc1dc35323be5145d0238dd930c6ccf6715f82038f5395df07d055608"; "Every check passed." If it times out while searching for a transaction, run it again: the public testnet RPC is sometimes slow.

### Evidence sale (current contract, pending)

Planned by `enclave/deploy/8-evidence-sale.ps1`: a meme token (`NOSNIPE`, 10,000 for sale, floor 0.001 USDC) with a launch pool (20 % of the raise). A sniper bot bids in the first block after the open, three people bid, a copycat replays one sealed bid, one person bids in the last two minutes; the enclave clears it, anyone seeds the pool, everyone claims. The script's plan expects a clearing price of 0.002 USDC; the real numbers go below.

| Item | Result |
| --- | --- |
| Contract (code hash must be `GhTHg5s7c97X8gALyghMchc8o51AnjYD4qDeStHPvMM2`) | `<link: sealround.itzbeast.testnet>` |
| Contract locked: `keys sealround.itzbeast.testnet` prints `"keys":[]` | `<link: delete-key transaction>` |
| Sale id and bid window | `<to be filled>` |
| Sniper bot bid at the open, and the second it landed | `<link>` |
| Copycat bid: voided, 1 % penalty | `<link>` |
| Late bid by a person | `<link>` |
| `close_sale` and the clearing attestation | `<link>` |
| Clearing price; what the bot and the late person each paid per token | `<to be filled>` |
| Pool seeded on Rhea: pool id, amounts, pool price, LP shares held by the contract | `<link>` |
| Claims and `claim_proceeds` (with the burn) | `<link>` |
| `verify-sale` output | `<to be filled>` |
| Result page with the Verified panel | `<testnet app link>/sale/<sale id>/result` |

A capped mainnet pilot is planned in [LAUNCH.md](LAUNCH.md) (10 USDC maximum deposit per account, at most 50 bids). It has not run: `<to be filled if it runs>`.

## 8. Run it locally

**Requirements.** Node 24 (tested with 24.19.0 on Windows and 24.22.3 on Linux) and pnpm 12.3.4 (`corepack enable`). For the full local stack also Docker Desktop (running), PowerShell, and Rust via rustup (the toolchains are pinned in the repo). The build and test scripts in `scripts/` are written for a Windows host; `pnpm check` (below) runs on Linux and Windows.

### Mock mode (the demo)

```sh
pnpm install
pnpm dev                  # = pnpm --filter web dev
```

Expected: `▲ Next.js 16.4.5 (Turbopack)`, `Local: http://localhost:3000`, `✓ Ready`. Mock mode is the default whenever `NEXT_PUBLIC_FAIRGROUND_CONTRACT` is unset. `/` is the landing page and `/sales` the sales board; on a host whose name starts with `app.` the sales board is served at `/` (`apps/web/src/proxy.ts`).

Production build, which is what the hosted demo serves (do not run it while `pnpm dev` runs from the same checkout: they share `apps/web/.next`):

```sh
pnpm build                # = pnpm --filter web build
pnpm --filter web start   # http://localhost:3000
```

Expected: `✓ Compiled successfully`, then a route table with the pages in [section 2](#2-try-it-in-2-minutes-with-no-funds) (including `/token/[id]` and `/sale/[id]/kit`), their `opengraph-image` routes, `/sale/[id]/kit/share-card`, `/api/og/{bid,win,countdown}` and `/api/oneclick/{config,quote,status,submit,swap,tokens}`. `/deploy` (the owner's testnet deploy page) answers 404 in a production build. The optional server-side `ONECLICK_JWT` authenticates the 1Click requests. Dry quotes work without it.

### Full local stack, end to end

```powershell
powershell -File scripts\sandbox.ps1          # once on a fresh clone: downloads the nearcore sandbox binary into .sandbox-bin
powershell -File scripts\sandbox.ps1 -Stop
pnpm --filter web e2e:sandbox
```

This drives the web app's NEAR client from Node, with no browser and no fakes in the money path: a nearcore sandbox in Docker (`near-sandbox-web`, RPC 127.0.0.1:3050), the committed `contracts/res/fairground.wasm`, OutLayer's own contract, the pinned `enclave/res/fairground_sealer.wasm` run by the enclave runner with a TEST master, and the real relayer as its own process on 127.0.0.1:8790. The first run builds the enclave runner with cargo (a few minutes). It prints every check, then a pass/fail table of **21 scenarios** (commit-reveal and TEE sales from create to claim, a copied and a void bid, enclave refusals with `retry_setup` and a second `close_sale`, storage sponsorship, every paid fallback when the relayer is down or out of budget, refund mode), exits 0 only if all pass, and removes the container. Logs: `apps/web/scripts/e2e/.run/`. The launch pool is not part of this run; it is covered by the contract's sandbox integration tests against Rhea's wasm.

To point the web app at a local sandbox in a browser, see [apps/web/README.md](apps/web/README.md), "Local sandbox".

### Tests

One command runs every check that needs neither Docker nor PowerShell. From the repository root:

```sh
rustup toolchain install 1.97.1 --profile minimal --target wasm32-wasip1
rustup override set 1.97.1
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` (`scripts/check.mjs`) runs the Rust workspace unit tests, the enclave job's native tests, the Vitest suites and TypeScript of `clearing`, `relayer-client`, `relayer` and `arena`, then the web tests, web TypeScript and web ESLint. It prints a pass/fail summary and ends with `13/13 passed`. It passed on Linux x86_64 (12 Nov 2026, Node 24.22.3, from a clean archive of the commit before `e59239c` plus `scripts/check.mjs`) and on Windows 11 (13 Nov 2026, commit `e59239c`).

Results on 13 Nov 2026, Windows 11. The last column names the commit each run was on. From `e59239c` to `576047c` only the web app (with its scripts and tests), the `enclave/deploy` PowerShell scripts, the docs and the lockfile changed; no contract, crate, relayer or package code.

| Suite | Command (from the repo root unless noted) | Result | Commit |
| --- | --- | --- | --- |
| Everything without Docker | `pnpm check` | 13/13 passed | `e59239c` |
| Rust unit (contract, clearing, sealer, token, test USDC) | `cargo test --workspace --locked` | 201 passed, 1 ignored | `e59239c` |
| Enclave job, native | in `enclave/`: `cargo test --locked -p fairground-sealer-job` | 20 passed | `e59239c` |
| Clearing TS | `pnpm --filter @fairground/clearing test` | 1,032 passed | `576047c` |
| Arena | `pnpm --filter @fairground/arena test` | 27 passed | `576047c` |
| Relayer | in `apps/relayer`: `pnpm test` | 411 passed, 10 sandbox tests skipped | `e59239c` |
| Relayer client | in `packages/relayer-client`: `pnpm test` | 269 passed, 8 sandbox tests skipped | `e59239c` |
| Web | in `apps/web`: `npx vitest run` | 500 passed in 33 files | `576047c` |
| End to end (Docker) | `pnpm --filter web e2e:sandbox` | 21/21 scenarios, 484/484 checks | `576047c` |
| MCP server (Docker) | `pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts` | 13/13 scenarios, 90/90 checks, 44 s | `e59239c` |
| Live bot (Docker) | `pnpm --filter web exec tsx scripts/live-bot/sandbox-test.ts` | 8/8 scenarios, 69/69 checks, 109 s | `e59239c` |
| Contracts, full: build, unit, sandbox integration (Docker, PowerShell) | `powershell -File scripts\test-contracts.ps1` | 26 integration tests passed, 9 of them launch liquidity against Rhea's wasm | 12 Nov 2026, contract unchanged since; not rerun on 13 Nov |

Other checks: `cargo clippy --workspace --all-targets --locked -- -D warnings`; `powershell -File scripts\run-enclave.ps1 -Test`; `powershell -File scripts\build-enclave.ps1 -Verify` (Docker, prints `verify: MATCH`); `pnpm typecheck` in `apps/relayer` and `packages/relayer-client`; `pnpm test:sandbox` in `apps/relayer`.

### Bid from an AI agent (MCP server and skill)

`apps/web/scripts/mcp` is a stdio MCP server that lets an AI agent read Sealround sales, place one sealed bid within a budget the user approved, read its result, claim, and verify a sale. It reuses the web app's NEAR client, bid sealing, relayer client and attestation checks. Full reference: [apps/web/scripts/mcp/README.md](apps/web/scripts/mcp/README.md).

```sh
pnpm --silent --filter web mcp
```

| Tool | Needs a key | What it does |
| --- | --- | --- |
| `sealround_list_sales`, `sealround_get_sale` | no | Sales by phase; one sale's rules, timing and public totals. Nothing sealed. |
| `sealround_place_bid` | yes | One sealed bid. `max_deposit` is required and the deposit may not exceed it. Returns the transaction and the bid's index, never the sealed terms. |
| `sealround_my_bid`, `sealround_get_result` | no | The account's public bid and, once final, its fill; the clearing price and every check |
| `sealround_claim` | yes | Tokens and refund, gasless |
| `sealround_verify_sale` | no | The same checks as `verify-sale` |

Settings come from the environment only (`SEALROUND_NETWORK`, `SEALROUND_CONTRACT`, and for writes `SEALROUND_KEY_FILE` or `SEALROUND_PRIVATE_KEY`); a key is never a tool argument, never logged and never returned. Before it signs, `place_bid` checks the bid terms, the sale, the deposit limits, the balance and the relayer's sponsorship, and sends nothing on a refusal. Writes on mainnet are refused unless `SEALROUND_ALLOW_MAINNET=1`. Tests: C12 in the [claims table](#claims-and-how-to-check-them).

`skills/sealround-bid/SKILL.md` is an agent skill for the same task through the live bot's `bid` and `result` commands. It caps the public deposit with `--budget` and needs the relayer's sponsorship or an explicit `--direct`.

## 9. Argue against this idea

- **It is not new.** Sealed-bid, single-price batch auctions have run on Ethereum for years.
- **Money still wins share.** They remove speed and information advantages, not capital. A whale still buys a large share at the clearing price.
- **Privacy rests on one provider.** Sealed prices depend on OutLayer's TEE and on how its master secret is held today, which its own docs say a DAO key can obtain.
- **A fair launch is not a fair market.** Most memecoin launches are speculation. A fair price at launch, and a pool that opens at that price, do not stop a dump later.
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
| **The launch pool cannot be seeded** | A failed step changes nothing else and can be retried by anyone. A step with no result after 600 blocks is given up and the exchange is read before going on. If the pool is not seeded by its deadline, anyone calls `abandon_liquidity`: the tokens unlock, whatever is on the exchange is withdrawn, the pool's USDC goes to the creator and its tokens are burned. Until then, claims pay refunds only. | Tests: `contracts/fairground/src/tests/liquidity.rs`, `contracts/tests/src/liquidity.rs` (paused exchange, lost deposit result, lost pool result, abandoned pools) |

Claims: each part of a claim (tokens, refund) is marked paid before the transfer and restored if the transfer fails, so a claim can be retried and a second claim pays nothing. Anyone may push a claim for a bidder; funds only go to the bidder.

## 11. Sybil limits

- **Per-account limits.** Each sale fixes `min_deposit` (at least 1 USDC) and `max_deposit_per_account`, and takes one bid per account. These are demo-grade.
- **Sybils gain nothing on price.** Every winner pays the same clearing price, so splitting money across many wallets gets around the per-account cap but buys nothing cheaper.
- **Bid slots can be squatted.** A sale takes at most `max_bids` (up to 500) bids, first come, first served, and the contract cannot read a sealed bid. Junk bids cost 1 % of the deposit (at least 0.01 USDC) plus about 0.005 NEAR per throwaway account. Filling 500 slots at the 1 USDC minimum costs about 5 USDC lost, 2.5 NEAR, and 500 USDC held until the sale ends. A creator who expects this raises `min_deposit`. **Simulate this launch** on `/create` shows how many people a given slot count and deposit cap turn away.
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
| `qrcode-generator` 2.0.4 (MIT) | The launch kit's QR code, made in the browser |
| `tailwindcss` 4, `@tailwindcss/turbopack` | Styling |
| `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7 | MCP server (development dependencies) |
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

External services: OutLayer (TEE compute, secrets, attestations), NEAR Intents 1Click (`https://1click.chaindefuser.com`), Rhea (the launch pool), NEAR RPC. Build images: `rust:1.97.1-trixie` (enclave, pinned by digest), `sourcescan/cargo-near:0.22.0-rust-1.97.1` (contract reproducible-build metadata), `debian:trixie-slim` with nearcore sandbox 2.14.0 (local chain). Third-party wasm used only by the sandbox tests: OutLayer's contract and Rhea's exchange ([section 14](#14-license)).

### AI-assisted code

The code and documentation in this repository were written with AI coding agents (Claude Code and OpenAI Codex), directed and reviewed by the team. The agents worked from the project spec and shared notes in [AGENTS.md](AGENTS.md) and [WORKBOARD.md](WORKBOARD.md). The claims in this README were checked against the code and against the runs it quotes, with the date of each run.

### Baseline

Every commit in this repository was made during the hackathon, which opened with the announcement on 19 Oct 2026. The first commit is `781f75b` (9 Nov 2026), and no code from before 19 Oct 2026 was copied in, so there is no pre-hackathon baseline to separate and no baseline diff applies: the whole history is hackathon work.

Commit `ee5c419` (11 Nov 2026) has "Baseline" in its title only because it was the first commit of the combined contracts, enclave, relayer and web app, which the later commits build on. It is hackathon work, not pre-existing code.

## 13. Roadmap (not built)

Nothing in this section exists in the code.

**P1**

- Delivery to Base via chain signatures: the contract derives an EVM address through the MPC signer and signs ERC-20 transfers to winners (a fair mode for launchpads on Base, with NEAR as the logic layer).
- An optional anonymized demand-curve reveal after settlement.
- A TypeScript SDK package with one integration example.
- An optional vesting schedule for the creator allocation, and an LP lock that ends on a date (today the pool's LP shares are held for good).

**P2**

- NFT drops, ticket sales and GPU-slot sales on the same engine.
- Agents bidding through NEAR Agent Market (an MCP server and a skill exist today, [section 8](#bid-from-an-ai-agent-mcp-server-and-skill)).
- A meme.cooking integration.
- Stronger sybil resistance for per-person caps.

Also not done yet: a reproducible container build of the sale contract, checking the TDX quote's signature chain up to Intel in the browser (OutLayer's verifier is linked instead), live 1Click swaps on mainnet, and a mainnet deployment.

Built since the first roadmap: the launch pool at the clearing price ([section 3](#launch-pool-at-the-clearing-price)), per-bid inclusion checks and real attestation checks ([section 5](#verify-a-sale-yourself)), 1Click confidential funding on mainnet (section 4), and the MCP server for agents.

## 14. License

MIT, see [LICENSE](LICENSE). Two third-party wasm files are used only by the sandbox tests and are never deployed by this project:

- `contracts/res/outlayer_contract.wasm` (OutLayer's contract) is Apache-2.0 and is in the repository; see [contracts/res/NOTICE.md](contracts/res/NOTICE.md) and `contracts/res/LICENSE-APACHE-2.0`.
- `contracts/tests/res/ref_exchange.wasm` (Rhea's exchange, v1.9.19) is not in the repository, because its licence is not confirmed. `scripts/fetch-rhea-wasm.mjs` reads it from `ref-finance-101.testnet` and checks its pinned sha256; `scripts/test-contracts.ps1` runs it before the integration tests. See [contracts/tests/res/NOTICE.md](contracts/tests/res/NOTICE.md).

## Repository layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js 16 app. Mock mode by default, NEAR mode when `NEXT_PUBLIC_FAIRGROUND_CONTRACT` is set ([README](apps/web/README.md)) |
| `apps/web/scripts` | `verify-sale.ts`, the end-to-end harness (`e2e/`), the live bot (`live-bot/`), the MCP server (`mcp/`) |
| `apps/relayer` | NEP-366 gas relayer (Hono) ([README](apps/relayer/README.md)) |
| `packages/clearing` | TypeScript reference of the clearing rule, the hashes and the launch pool plan |
| `packages/relayer-client` | Browser and Node client for the relayer ([README](packages/relayer-client/README.md)) |
| `packages/arena` | Bot Arena and launch simulator ([README](packages/arena/README.md)) |
| `crates/clearing` | Rust clearing, shared by the contract and the enclave job |
| `crates/sealer` | Rust bid opening and the job's logic |
| `contracts/fairground` | The sale contract, including the launch pool ([DESIGN](contracts/DESIGN.md), [GAS](contracts/GAS.md)) |
| `contracts/token`, `contracts/mock-ft` | Sale token, test USDC |
| `contracts/tests` | near-workspaces integration tests against a sandbox |
| `contracts/res` | Built wasm, committed on purpose ([NOTICE](contracts/res/NOTICE.md)) |
| `enclave/` | The OutLayer job, its runner, reproducible Docker build and deploy scripts ([README](enclave/README.md), [PERF](enclave/PERF.md)) |
| `skills/sealround-bid` | Agent skill for bidding |
| `scripts/` | `check.mjs` (`pnpm check`) and the PowerShell build, sandbox and test scripts |

## Deploying

Testnet and mainnet deployment, relayer hosting (Dockerfile, Fly.io) and the Vercel setup for the web app are in [LAUNCH.md](LAUNCH.md). Publishing the enclave job and creating its secret on OutLayer are in [enclave/README.md](enclave/README.md). Deploying, creating accounts and signing on public networks are done by the project owner.
