# Fairground — Project Requirements (NEAR HACKATHON)

Nov 9, 2026 · @Vasanth

## Summary

Fairground is a sealed-bid, single-price sale protocol on NEAR. Bids stay hidden inside a TEE until the sale closes, everyone pays one clearing price, and buyers can pay from any chain. One line: **bots and you pay the same price.**

- **Hackathon goal:** 1st place in Memecoins With Mechanics, while contending in Unstoppable DeFi, Privacy & Private AI and Open Innovation.
- **What ships by Saturday:** a working fair launch on NEAR testnet, one capped mainnet pilot with real cross-chain bids, and a Bot Arena that proves snipers gain nothing.
- **What we pitch:** fair-sale infrastructure for anything scarce. Token launches come first; NFT drops, tickets and GPU slots are roadmap.
- **Track ids for the submission:** `memecoins`, `defi`, `privacy`, `open`.
- **Deadline:** 14 Nov 2026, 23:59 UTC (15 Nov, 05:29 IST). Internal submit target: 14 Nov, 18:00 UTC (23:30 IST). Judging runs 16 to 18 Nov ([HACKATHON.md](https://nearhackathon.com/HACKATHON.md)).
- **Name:** Fairground is a working name. Check availability before the first public post.

## Problem and users

First-come launches reward speed, not demand. Sniper bots buy in the first block, insiders front-run, and regular buyers become exit liquidity. NFT mints and ticket drops have the same problem.

Token sales are a real market: Coinbase bought Echo, whose Sonar product runs public token sales, for about $375M in October 2025, after Echo handled $200M+ across roughly 300 deals ([Decrypt](https://decrypt.co/345168/coinbase-acquires-echo-375-million)). Fairground's angle is permissionless, any chain, private bids and no speed advantage.

| User | What they want | What Fairground gives them | Phase |
| --- | --- | --- | --- |
| Buyer | The same price insiders get, paying from the chain they already use | Sealed bids, one clearing price, funding from any chain via NEAR Intents | P0 |
| Creator | Real holders, not bot wallets; a launch nobody can rig | Rules locked at launch, no admin key, public result with proof | P0 |
| Launchpad (openlaunch first) | A "fair mode" to offer its creators | SDK plus a hosted sale page | P0 for openlaunch users, P1 for the SDK |
| AI agents | Bid on behalf of a user within a budget | The same bid API, no special path | P2 |

## How it works

Fairground runs a uniform-price, sealed-bid batch auction: nobody sees bids until the window closes, and every winner pays the same clearing price.

1. **Creator sets the sale.** Supply for sale, floor price, minimum raise, bid window and caps. Fairground deploys the token with a fixed supply. Every parameter is locked; there is no admin key.
2. **Bidder gets USDC on NEAR.** Either they already hold it, or they fund from SOL, ETH, BTC or USDC on another chain through 1Click.
3. **Bidder submits a sealed bid.** A public USDC deposit plus an encrypted payload (max price, max spend, salt) that only the sale's enclave can open. Encryption happens in the browser.
4. **Window closes.** Anyone can call close. The bid set is frozen on-chain.
5. **Enclave clears the sale.** It decrypts every bid, computes the clearing price and fills, and returns a signed result. The contract checks the arithmetic, then settles.
6. **Everyone claims.** Winners get tokens at the clearing price plus any unspent USDC. Losing bids get a full refund. If the minimum raise is missed or clearing fails, everyone is refunded in full.

**Clearing rule.** For bids with max price p and max spend m, sale supply S and floor price F:

```latex
P^* = \max \Big\{ P \ge F \;:\; \sum_{i \,:\, p_i \ge P} \frac{m_i}{P} \ge S \Big\}
```

Every bid with max price above P\* is filled in full at P\*. Bids exactly at P\* share the remainder pro-rata. If demand at the floor is below S, P\* equals the floor, everyone is filled, and unsold tokens are burned (a rule fixed at launch).

| Data | During the sale | After settlement |
| --- | --- | --- |
| Max price | Hidden (encrypted) | Never published by default |
| Max spend | Hidden (it can be lower than the deposit) | Never published by default |
| Deposit amount, bidder account, bid time | Public on-chain | Public |
| Clearing price, each fill, each refund | Not known | Public |
| Anonymized demand curve | Not known | Optional, chosen at launch (P1) |

**Honest limits.** Fairground removes the speed advantage and the information advantage. It does not remove the capital advantage: a whale can still buy a large share at P\*. Sybil wallets gain nothing on price but can dodge per-wallet caps. Privacy depends on the OutLayer TEE. Trading after the sale is out of scope.

## Scope

P0 is the whole submission: if it works end to end, we are competitive. P1 is added only after the Wednesday gate passes. P2 appears only in the README roadmap, clearly labelled.

**P0: must ship by Saturday**

- [ ] Sale contract on testnet: create, bid, close, settle, claim, refund, timeout refund
- [ ] Token factory: fixed supply, no mint, no admin key
- [ ] Sealed bids in the OutLayer TEE, or the commit-reveal fallback if the Tuesday gate fails
- [ ] Clearing logic in the enclave, with contract-side checks of the result
- [ ] Fund from any chain via 1Click (dry quotes always, real quotes on mainnet)
- [ ] Gas relayer for bid and claim transactions
- [ ] Web app: create page, sale page, result page, Verified panel, where's-my-money panel
- [ ] Bot Arena: simulator plus a live sniper bot on testnet
- [ ] Judge mode: a seeded testnet sale anyone can run with no funds
- [ ] One capped mainnet pilot with real bidders
- [ ] README, demo video, X post, submission

**P1: stretch, only after the Wednesday gate**

- [ ] Confidential funding: 1Click `confidentiality`, so origin wallets cannot be linked to bid accounts
- [ ] Delivery to Base via chain signatures (openlaunch fair mode, NEAR as the logic layer)
- [ ] Per-bid inclusion proofs, so each bidder can verify their bid was counted
- [ ] Optional anonymized demand-curve reveal after settlement
- [ ] TypeScript SDK package with one integration example

**P2: roadmap only**

- NFT drops, ticket sales and GPU-slot sales on the same engine
- AI agents bidding through the SDK or NEAR Agent Market
- Seeding a Rhea pool at the clearing price; a meme.cooking integration
- Stronger sybil resistance for per-person caps

**Non-goals:** promoting a token, secondary trading, custody of user keys, KYC, and any mainnet sale beyond the capped pilot.

## Architecture

The contract is the centre: it holds the money, deploys tokens and checks every clearing result, while OutLayer only sees and sorts the hidden prices.

&#91;embedded content: Fairground architecture · 8 components\]

Funding goes through 1Click to the buyer's own NEAR account; the bid and its USDC go to the contract in one transfer; at close the contract sends the sealed bids to OutLayer and checks what comes back.

**Trust assumptions**

- OutLayer's TEE keeps bid prices secret and runs the published code; the app checks the attestation.
- OutLayer's docs say a DAO full-access key can currently obtain its master secret outside an enclave.
- The contract trusts the TEE only for hidden prices. Totals, caps and the bid-set hash it checks itself.
- 1Click routes funding through solvers; a failed swap refunds to the origin address.
- The relayer only pays gas; it cannot move anyone's funds.

## Smart contract spec

One Rust contract (near-sdk) holds every sale, deploys each sale's token, and enforces the money rules itself. Deploy it as `fairground.testnet` for development and judge mode, and on mainnet only for the capped pilot (account name to be confirmed).

&#91;embedded content: Sale states · 7 states, fallback dashed\]

A sale moves one way only. The dashed path is the commit-reveal fallback; anything that goes wrong lands in Failed, where every bidder gets a full refund.

**Sale parameters (all fixed at `create_sale`, readable through views)**

| Parameter | Type | Demo value | Note |
| --- | --- | --- | --- |
| `token_name`, `token_symbol`, `decimals` | string, string, u8 | Fair Test, FAIRT, 18 | Token deployed to `<symbol>.fairground.<network>` |
| `total_supply` | u128 | 1,000,000 tokens | Minted once to the contract, no mint function |
| `sale_supply` | u128 | 600,000 tokens | Rest goes to `creator_allocation` and LP reserve |
| `floor_price` | u128, USDC units per token | 0.001 USDC | No fill below the floor |
| `min_raise` | u128, USDC units | 50 USDC | Below this the sale fails and everyone is refunded |
| `bid_start`, `bid_end` | u64, nanoseconds | 30 min window in judge mode | Shortened timers allowed on testnet |
| `min_deposit`, `max_deposit_per_account` | u128, USDC units | 1 and 10 USDC (pilot) | Per-account cap, sybil limits stated in the README |
| `reveal_mode` | enum `Tee` or `CommitReveal` | `Tee` | Fallback mode if the TEE gate fails |
| `sealer_code_hash`, `sealer_pubkey` | bytes | From OutLayer | Set by the attested key call, never by a person |
| `unsold_rule` | enum | `Burn` | Fixed at launch |
| `settle_timeout` | u64, nanoseconds | 2 hours | After this, anyone can switch the sale to refund mode |
| `quote_token` | AccountId | USDC (NEP-141) | Only this token is accepted as a deposit |

**Methods**

| Method | Called by | When | What it does |
| --- | --- | --- | --- |
| `create_sale(params)` | Creator | Any time | Takes storage payment, deploys the token, mints supply to the contract, requests the sealer public key (TEE mode) |
| `ft_on_transfer(sender_id, amount, msg)` | USDC contract, via `ft_transfer_call` | Open | Records a bid: deposit plus ciphertext (TEE) or commitment (fallback). Rejects wrong token, out-of-window bids and over-cap deposits by returning the funds |
| `close_sale(sale_id)` | Anyone | After `bid_end` | Freezes the bid set and stores its hash. TEE: sends the clearing request to OutLayer (yield/resume). Fallback: opens the reveal window |
| `on_clearing_result(result)` | OutLayer resume | Clearing | Checks the result (below), then sets Settled or Failed |
| `reveal_bid(...)`, `clear_onchain(sale_id)` | Bidder; anyone | Fallback only | Reveal, then compute the clearing price on-chain |
| `claim(sale_id)` | Bidder | Settled or Failed | Sends tokens plus unspent USDC, or a full refund. Once per bid |
| `trigger_refund_mode(sale_id)` | Anyone | After `settle_timeout` | Moves an unsettled sale to Failed so funds can always leave |
| `get_sale`, `get_bid`, `get_result`, `get_bids_summary` | Anyone | Any time | Views for the app and judges |

**Checks on every clearing result.** These make the contract verify what it can, so the TEE is trusted only for the hidden prices.

- The callback comes from OutLayer for the registered `sealer_code_hash`, and the sale is in Clearing.
- The result's bid-set hash equals the hash the contract stored at close.
- The clearing price is at least the floor; total tokens filled are at most `sale_supply`.
- For every fill, tokens × price is at most that bidder's deposit, and the bidder exists in the bid set.
- Total raise is at least `min_raise`; otherwise the sale is Failed.

**Safety rules**

- No owner or admin methods; parameters cannot change after creation.
- Every path ends in Settled or Failed, and both let every bidder claim. No funds can be stuck.
- State is written before any cross-contract promise, and callbacks handle failed promises.
- Tests with near-workspaces: undersubscribed, oversubscribed, ties at the clearing price, invalid ciphertext, failed clearing, timeout refund, double claim, wrong deposit token.

## Sealed-bid enclave (OutLayer TEE)

An OutLayer job named `fairground-sealer` holds each sale's private key and does the clearing. It is Rust compiled to WASM, running inside Intel TDX, and its attestation covers the code hash, input hash and output ([OutLayer on docs.near.org](https://docs.near.org/primitives/off-chain-compute/outlayer.md)). The contract calls it through NEAR's yield/resume flow: `outlayer.testnet` on testnet, `outlayer.near` on mainnet ([near-outlayer repo](https://github.com/fastnear/near-outlayer)).

**Keys**

- Each sale gets its own X25519 key pair, derived inside the enclave: `sk = HKDF(master_secret, "fairground" || sale_id)`. The master secret is an OutLayer encrypted secret.
- At `create_sale`, a key call returns the public key. The contract stores it next to the attested code hash, so the app never takes the key from our server.
- Trust note for the README: OutLayer's docs say a DAO full-access key can currently obtain the shared master secret outside an enclave. We state that assumption plainly.

**Bid format**

- Plaintext: `{sale_id, bidder, max_price, max_spend, salt}` as canonical JSON.
- Encrypted in the browser with a libsodium sealed box (`crypto_box_seal`, X25519 plus XSalsa20-Poly1305) to the sale's public key.
- The enclave rejects a bid whose `bidder` or `sale_id` does not match the on-chain record, so nobody can copy someone else's ciphertext.

**Clearing job**

1. Input: sale parameters plus every `(bidder, deposit, ciphertext)` in contract order.
2. Decrypt each bid. An invalid one (bad decrypt, max spend above deposit, price below floor) counts as zero and is fully refunded.
3. Compute the clearing price and fills with the rule in How it works. Integer math only (u128, USDC with 6 decimals, token with 18). Ties at the clearing price are pro-rata; rounding remainders go by bid order.
4. Output: `{sale_id, clearing_price, fills: [{bidder, tokens, spent}], bid_set_hash, n_valid, n_invalid}`. Individual prices are never in the output.
5. The same algorithm also lives in TypeScript (the simulator). Both are run on the same random bid sets and must agree exactly.

**Limits to measure on day 1:** OutLayer input size, run time, and cost per call. Yield/resume waits about 200 blocks (about 2 minutes), so clearing must finish within that or be retried. Load test with 500 bids.

**Fallback: commit-reveal mode.** If the TEE gate fails by Tuesday 12:00 UTC, bids become `commit = sha256(sale_id || bidder || max_price || max_spend || salt)`. A 10-minute reveal window follows the close, and the contract clears on-chain. Bidders who don't reveal are refunded minus a 1% penalty that is burned. This mode is weaker: prices become public at reveal, and the README must say so.

## Cross-chain funding and settlement

Buyers fund from any chain through 1Click, but every bid is placed from the buyer's own NEAR account. 1Click deposit addresses are created per quote and expire in about 10 minutes, so a payment sent straight to the contract could not be tied to a bid.

**Funding flow (P0)**

1. The buyer connects a NEAR wallet through `@hot-labs/near-connect` (HOT, Meteor, Intear, MyNearWallet, NEAR Mobile, OKX and others).
2. They pick an origin asset (for example SOL, ETH, BTC, or USDC on Base) and an amount. The app shows a dry quote (`dry: true`) with fees and time.
3. On confirm, the app requests a real quote with the recipient set to the buyer's NEAR account and USDC (NEP-141) as the output, then shows the deposit address.
4. The app polls `/v0/status` and shows every state, including REFUNDED and FAILED.
5. When USDC lands, the app prompts the bid: `ft_transfer_call` to the contract with the ciphertext in `msg`.

API flow: `GET /v0/tokens` → `POST /v0/quote` (dry) → `POST /v0/quote` (real) → deposit → `POST /v0/deposit/submit` → `GET /v0/status`. Base URL `https://1click.chaindefuser.com`, TypeScript SDK `@defuse-protocol/one-click-sdk-typescript` ([NEAR Intents docs](https://docs.near-intents.org/)). There is no Intents testnet, so real funding happens only in the mainnet pilot; testnet and judge mode use dry quotes.

**Fees.** Without an API key, 1Click adds 0.2 to 0.25% (HACKATHON.md and the fee page disagree). With a key from partners.near-intents.org, stablecoin pairs drop to 0.01% ([fee page](https://docs.near-intents.org/resources/fees)). Get a key on day 1.

**Gas relayer (P0).** A small Node service relays NEP-366 meta transactions and pays gas only for calls to the Fairground contract and USDC transfers into it. It also covers the one-time USDC storage deposit for a new bidder. The 1 yoctoNEAR that `ft_transfer_call` needs still comes from the bidder's account. Rate-limited per account; stores nothing else.

**Withdraw.** After claiming, unspent USDC can go back to any chain through a 1Click quote in the other direction.

**Confidential funding (P1).** Add the 1Click `confidentiality` option so a buyer's origin wallet cannot be linked on-chain to their NEAR bid account. This uses NEAR's Confidential Intents, a product the judges know.

**Delivery to Base via chain signatures (P1).** The contract derives an EVM address through the MPC signer (`v1.signer-prod.testnet`, secp256k1 domain 0). That address holds the sale tokens on Base; after settlement the contract signs ERC-20 transfers to winners' Base addresses, and a relayer broadcasts them. Each signature needs at least 1 yoctoNEAR and about 250 Tgas, and returns asynchronously ([chain signatures reference](https://github.com/near/agent-skills/blob/main/skills/near-smart-contracts/rules/chain-signatures.md)). This is what turns Fairground into a fair mode for openlaunch on Base, with NEAR as the logic layer.

## Frontend

A Next.js and TypeScript app on Vercel, with every screen built so a judge can reach a result in under two minutes without funds.

| Page | Purpose | Must have |
| --- | --- | --- |
| `/` | Live and upcoming sales | One-line pitch, a judge-mode button |
| `/create` | Creator wizard | Parameter form, "rules locked forever" summary, cost preview |
| `/sale/[id]` | Bid during the window | Countdown, max price and max spend inputs, in-browser encryption, Fund from any chain, my bid status |
| `/sale/[id]/result` | Outcome and claims | Clearing price, fills table, my tokens and refund, Claim button, Verified panel |
| `/arena` | Bot Arena | Simulator charts, live bot replay |
| `/how` | Rules and trust | Mechanism, trust assumptions, failure cases, argue-against paragraph |

**Verified panel** (result page). Each check shows pass or fail, plus a link:

- OutLayer attestation fetched with a fresh random nonce
- Enclave code hash equals the hash of our reproducible build from the public repo
- Sealer public key on-chain matches the one the attestation reports
- Result's bid-set hash equals the contract's stored hash
- All contract-side checks passed (listed by name)

**Where's-my-money panel** (sale and result pages). One row per hop, with a status and an explorer link: origin chain → 1Click deposit address → your NEAR account → Fairground contract → tokens and refund claimed. REFUNDED and FAILED states are shown in plain words.

**Judge mode.** A seeded testnet sale and a "run it" button that adds 50 simulated bidders and 3 sniper bots, closes the sale, clears it and opens the result. Funding shows live dry quotes.

**Privacy rule:** bids are encrypted in the browser, and no server stores bid contents. The relayer stores only rate-limit counters.

## Bot Arena

The Bot Arena turns "bots gain nothing" from a claim into numbers a judge can rerun. It has a simulator and a live bot, and every number in the demo comes from them: none is typed by hand.

**1. Simulator (TypeScript, deterministic, seeded, no LLM calls)**

- The same crowd goes through three launch types: a bonding-curve launch (constant-product with virtual reserves, as on popular meme launchpads), a first-come fixed-price sale, and Fairground.
- Crowd per run: 200 humans with private valuations and random arrival times, plus 5 sniper bots that buy at second 0 and sell into the first human demand.
- 60 runs with different demand levels, which also meets the memecoin brief's "simulate first" requirement.
- One command rebuilds every chart: `pnpm arena`.

| Metric | Definition |
| --- | --- |
| Bot share of supply | Tokens bought by bots ÷ tokens sold |
| Bot profit | What bots make by selling to later humans, in USDC |
| Human price premium | Median human entry price ÷ the price bots paid |
| Humans filled | Share of humans who got any tokens |
| Holder concentration | Gini coefficient of final holdings |

**The chart for the video:** bot share and human price premium for the three launch types, side by side, averaged over the 60 runs. Values are filled in from the simulator output on Thursday.

**2. Live bot on testnet**

- A sniper script bids at second 0 with a high max price. A human bids in the last minute. Both pay the same clearing price, recorded on screen.
- Copycat attack: the bot resubmits another bidder's ciphertext under its own account. The enclave rejects it.
- Peek attack: the bot reads all contract state during the window and finds only ciphertext.

**Honesty rule:** publish the simulator code and every assumption next to the chart. Real launches will vary.

## Real launch pilot

One small mainnet sale with real people and real cross-chain bids is the evidence no rival can fake in a week. Only 6 hackathon repos even mention mainnet.

| Limit | Value | Why |
| --- | --- | --- |
| Token | A demo token with no utility and no promises | It is an experiment, not an investment |
| Max deposit per account | 10 USDC | Keeps any loss small |
| Total raise cap | 500 USDC | Same |
| Bid window | 2 to 6 hours, announced a day ahead | Time for people in several time zones |
| Contract status | Unaudited, with a banner saying so | Honesty |
| Refund path | Tested on testnet first, including timeout refund | Funds can always leave |

**Who joins:** the openlaunch community, mostly Base users. They fund with USDC on Base through 1Click, which is exactly the cross-chain story. Announce on X and Telegram on Thursday.

**What to record:** number of bidders, chains used, our own openly-run bot's result, time from close to settlement, refunds processed, and the Verified panel passing. Screenshot and screen-record everything for the video and README.

**Legal caution:** token sales are regulated in some countries. Keep it a capped, no-value experiment and decide as a team whether you are comfortable running it. This is not legal advice.

**Fallback:** if the mainnet pilot is blocked, run the same pilot on testnet with community members, and record one real 1Click swap on mainnet to show the funding path.

## Track requirements checklist

Each track brief lists what its judges expect; this table maps every item to the part of Fairground that answers it. Briefs: [memecoins](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/11-memecoins.md), [DeFi](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md), [privacy](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/03-privacy.md), [open](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/13-open.md).

| Track | The brief asks for | How Fairground meets it |
| --- | --- | --- |
| Memecoins | The mechanic in the contract, not a backend someone could switch off | Clearing checks and payouts live in the contract; only hidden prices live in the TEE |
| Memecoins | All parameters set at launch, readable, no admin key | Immutable sale parameters, view methods, no owner methods |
| Memecoins | Demo-grade sybil resistance, limits stated in the README | Per-account deposit cap; README says sybils gain nothing on price but can split across wallets |
| Memecoins | A page showing progress and a log | Sale page with countdown, bid count and an event log |
| Memecoins | Simulate behaviour first | Bot Arena, 60 seeded runs |
| DeFi | Handle REFUNDED and FAILED statuses | Funding flow shows every 1Click status |
| DeFi | Show where funds sit at every step | Where's-my-money panel |
| DeFi | Dry-run mode with real quotes, so judges need no funds | Judge mode plus live dry quotes |
| DeFi | History with explorer links | Bid and claim history on the result page |
| Privacy | TEE-backed processing, attestation fetched with a fresh nonce | OutLayer sealer plus the Verified panel |
| Privacy | A Verified panel listing what was checked | Five named checks on the result page |
| Privacy | Nothing kept server-side | In-browser encryption; the relayer stores only rate limits |
| Privacy | Fictional sample data | The judge-mode sale uses invented bidders |
| Open | Rules readable in the contract | Parameters and checks documented in code and README |
| Open | Testnet demo with timers shortened to minutes | 30-minute judge-mode sale |
| Open | A failure-cases section; argue against the idea first | README sections drafted in Submission package |

The privacy brief centres on NEAR AI Cloud. Fairground uses OutLayer's TEE instead; the rules call hints "hints, not requirements", but say so in the README.

**Rules for every entry** ([HACKATHON.md](https://nearhackathon.com/HACKATHON.md)):

- [ ] Repo public by 14 Nov, 23:59 UTC, with a LICENSE file (MIT)
- [ ] README with "do X → see Y" steps, every library listed, AI-written parts disclosed
- [ ] Code from before 19 Oct (openlaunch) separated by branch or tags, with a diff link
- [ ] No secrets anywhere in git history
- [ ] Hosted demo up through 18 Nov, ideally 25 Nov
- [ ] Demo post on X tagging @NEARProtocol and #NEARHackathon, with video
- [ ] Mainnet NEAR account ready for the prize payout
- [ ] Exactly one submission; mistakes go through the request-changes page

## Team split and 5-day plan

Split the work by layer so the three of you never block each other, and let each day end with a gate that must pass before moving on. Assign names to roles A, B and C yourselves.

&#91;embedded content: 5-day roadmap · 6 days, 4 gates\]

If a gate fails, cut scope to P0 rather than slipping the next day; the checklists below say who does what.

| Role | Owns | P1 if time allows |
| --- | --- | --- |
| A: Contracts | Sale contract, token factory, result checks, claims and refunds, tests, commit-reveal fallback | Chain-signature delivery to Base |
| B: Enclave and cross-chain | OutLayer sealer, keys, attestation, 1Click funding flow, gas relayer | Confidential funding |
| C: Product and proof | Web app, Verified and where's-my-money panels, Bot Arena, pilot with the openlaunch community, README, video, X post | SDK package |

**Mon 9 Nov (rest of today)**

- [ ] B: OutLayer hello-world on testnet: contract calls OutLayer, OutLayer resumes the contract
- [ ] B: confirm per-sale key derivation from an OutLayer secret; get a 1Click API key; run one dry quote
- [ ] A: repo, contract skeleton, `create_sale` with the token factory
- [ ] C: Next.js scaffold with wallet login; simulator skeleton; tell the openlaunch community a pilot is coming Friday

**Tue 10 Nov: gate at 12:00 UTC: TEE path works on a toy input, or switch to commit-reveal**

- [ ] A: bids through `ft_on_transfer`, `close_sale`, result checks, claims, refunds, unit tests
- [ ] B: sealer decrypts, clears and outputs; TypeScript and Rust clearing agree on 1,000 random bid sets
- [ ] C: sale page with in-browser encryption; first simulator numbers

**Wed 11 Nov: gate at end of day: create, bid, clear and claim all work on testnet**

- [ ] A: near-workspaces tests for every edge case; timeout refund; testnet deploy
- [ ] B: funding flow with dry quotes and every status; relayer live
- [ ] C: result page, Verified panel, where's-my-money panel, judge mode

**Thu 12 Nov**

- [ ] A: mainnet deploy with pilot caps; P1 Base delivery if Wednesday's gate passed
- [ ] B: one real 1Click funding on mainnet; P1 confidential funding
- [ ] C: final Bot Arena charts; live bot script; announce the pilot time

**Fri 13 Nov: feature freeze at 18:00 UTC**

- [ ] All: run the pilot and collect its numbers
- [ ] C: README tested from a fresh clone; hosted demo up
- [ ] A and B: fix only bugs found in the pilot

**Sat 14 Nov: submit by 18:00 UTC (23:30 IST)**

- [ ] Record the video; publish the X post
- [ ] Make the repo public; check LICENSE and git history for secrets
- [ ] Submit once at nearhackathon.com/#apply

## Risks and day-1 unknowns

The biggest risk is the OutLayer integration; every other risk has a cheap fallback.

| Risk | Impact if it hits | Fallback | Decide by |
| --- | --- | --- | --- |
| OutLayer can't hold per-sale keys, or yield/resume integration is slow | No sealed bids in the TEE | Commit-reveal mode; keep the Verified panel for what remains | Tue 10 Nov, 12:00 UTC |
| OutLayer input size or run time too small for many bids | Clearing fails for big sales | Cap bids per sale for the demo; retry on timeout; refund mode guarantees exit | Tue 10 Nov |
| 1Click can't deliver USDC to a new or unregistered NEAR account | Cross-chain funding breaks for new users | Relayer pre-registers USDC storage; ask users to connect an existing wallet | Mon 9 Nov |
| Clearing math bug | Wrong fills, lost trust | TypeScript and Rust implementations must match on 1,000 random bid sets | Wed 11 Nov |
| Mainnet pilot blocked (legal comfort, bugs, low turnout) | Weaker evidence | Testnet pilot with the community plus one recorded mainnet swap | Thu 12 Nov |
| Chain-signature Base delivery takes too long | Lose the openlaunch-on-Base story | Leave it as P1 and show it in the roadmap | Thu 12 Nov |
| Scope creep | Nothing works fully | P0 only until the Wednesday gate; feature freeze Fri 18:00 UTC | Daily |
| A look-alike project appears | Less novelty | Check the directory daily (its open `/api/projects` endpoint); sharpen the pitch | Daily |
| "Fairground" is taken | Rename late | Check X, GitHub and domains before the first public post | Wed 11 Nov |

**Unknowns to verify on day 1**

- [ ] OutLayer: secrets, key derivation inside the job, yield/resume round trip, input size limit, cost per run
- [ ] OutLayer attestation: what the app can fetch and verify in the browser, with a nonce
- [ ] 1Click: delivery to a fresh NEAR account; USDC token id on NEAR; quote time for SOL and Base USDC
- [ ] Meta transactions: relaying `ft_transfer_call` with its 1 yoctoNEAR attached deposit
- [ ] Token factory: deploy cost per sale (storage), or a shared global contract to cut it
- [ ] Chain signatures on testnet: derive an EVM address and sign one Base Sepolia transfer

## Submission package

The repo is what judges review, and Claude Code and Codex screen it first, so the README must let a machine reproduce every claim.

**README outline**

1. What Fairground is, in two lines, plus the 90-second video
2. Try it in 2 minutes with no funds: "do X → see Y" steps for judge mode
3. How the auction works: the rule and the clearing formula
4. What NEAR does here: OutLayer TEE, NEAR Intents funding, contract-side checks, chain signatures if shipped
5. Architecture and trust assumptions, stated plainly
6. Bot Arena results and how to rerun them (`pnpm arena`)
7. Pilot results with transaction links
8. Run it locally: exact commands and expected output
9. Argue against this idea (below)
10. Failure cases: clearing timeout, invalid bids, failed funding, missed minimum raise
11. Sybil limits
12. Libraries used, AI-assisted code, and the openlaunch baseline diff
13. Roadmap (P2), clearly labelled as not built
14. License

**Argue against this idea (draft)**

Sealed-bid, single-price auctions are not new; batch auctions have run on Ethereum for years. They remove speed and information advantages but not money: a whale still buys a large share at the clearing price. Privacy rests on OutLayer's TEE and on how its master secret is held today. Most memecoin launches are speculation, so a fair price at launch does not stop a dump later. Token sales are regulated in some countries. We build it anyway because the sniping problem is real at every launch, NEAR is the one stack with a TEE, cross-chain funding and chain signatures together, and the clearing checks live in a contract anyone can read.

**Demo video (60 to 90 seconds)**

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0 to 8 s | A bonding-curve launch: bots buy in the first block | "Every launch, bots buy first and dump on you." |
| 8 to 20 s | Sale page with sealed bids | "On Fairground, bids are sealed until close, and everyone pays one price." |
| 20 to 45 s | Live bot bids at second 0, a human at the last minute; the sale clears; both pay the same price; Verified panel goes green | "The bot was faster. It didn't matter." |
| 45 to 60 s | An openlaunch user funds with USDC on Base; where's-my-money panel | "Pay from any chain through NEAR Intents." |
| 60 to 75 s | Bot Arena chart from the simulator | Read the real numbers from the chart |
| 75 to 90 s | Pilot numbers, repo and try-it link | "Try it with no funds. Link below." |

**X post draft** (the human posts it; fill in links and numbers)

```markdown
Every token launch, bots buy in the first block and dump on you.

Fairground fixes it: sealed bids, one clearing price. Bot or human, everyone pays the same.

Bids stay sealed inside a TEE on NEAR until the sale closes. Pay from any chain through NEAR Intents.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon @NearBuilders @out_layer

Try it with no funds: <demo link>
Code: <repo link>

What would you launch with it?
```

**Submission form fields**

- [ ] Project name and team lead's name
- [ ] Contact email
- [ ] Team size: `2 - 4`
- [ ] Tracks: `memecoins`, `defi`, `privacy`, `open`
- [ ] Mainnet NEAR account for the payout
- [ ] Public repo link and public demo post link
- [ ] Description, 20 to 2,000 characters: the problem, what we built, how NEAR fits
- [ ] Consent to the contact notice

## Definition of done and success metrics

Fairground is done when a judge with no funds can run a sale end to end from the README, and the pilot has real numbers behind it.

- [ ] A fresh clone plus the README commands reproduces judge mode with no errors
- [ ] A testnet sale goes create → bids → close → clear → claim, with tokens and refunds correct to the smallest unit
- [ ] Every Verified panel check passes on the judge-mode sale
- [ ] The live sniper bot pays exactly the clearing price, and the copycat attack is rejected
- [ ] Timeout refund works: no path leaves funds stuck
- [ ] Bot Arena charts rebuild from one command
- [ ] The pilot ran, or the documented fallback did
- [ ] Repo public, video posted, submission sent by Sat 18:00 UTC

| Metric | Target | Source |
| --- | --- | --- |
| Judge-mode time to a result | Under 2 minutes | Timed from the README |
| Bot advantage in Fairground | Zero price advantage over humans | Live bot and simulator |
| Pilot bidders | 20 or more | Contract events |
| Chains used to fund the pilot | 2 or more | 1Click statuses |
| Close to settlement time | Under 2 minutes | Contract events |
| Clearing implementations agreeing | 1,000 of 1,000 random sets | Parity test |

## Sources

- [NEAR HACKATHON rules (HACKATHON.md)](https://nearhackathon.com/HACKATHON.md)
- [NEAR HACKATHON project directory](https://nearhackathon.com/#projects)
- [Track prompt examples](https://github.com/nearai/near-hackathon-prompt-examples)
- [OutLayer on docs.near.org](https://docs.near.org/primitives/off-chain-compute/outlayer.md) and [near-outlayer repo](https://github.com/fastnear/near-outlayer)
- [NEAR Intents docs](https://docs.near-intents.org/) and [fee page](https://docs.near-intents.org/resources/fees)
- [Chain signatures reference](https://github.com/near/agent-skills/blob/main/skills/near-smart-contracts/rules/chain-signatures.md)
- [Coinbase acquires Echo (Decrypt)](https://decrypt.co/345168/coinbase-acquires-echo-375-million)
