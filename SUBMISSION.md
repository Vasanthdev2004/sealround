# Submission kit

For the project owner, not for judges. Everything here comes from the spec
(`Fairground — Project Requirements (NEAR HACKATHON).md`, "Submission package"
and "Track requirements checklist") adjusted to what the app does today.
Placeholders are in `<angle brackets>`.

Deadline: 14 Nov 2026, 23:59 UTC. Internal target: **14 Nov, 18:00 UTC**
(23:30 IST). Submit once at nearhackathon.com/#apply; corrections go through
the request-changes page.

## (a) Demo video, 60 to 90 seconds

Record the production build, not the dev server (no dev overlay, steadier
frame rate): `pnpm build`, then `pnpm --filter web start`, at 1440 x 900.
Click "Reset demo data" (page footer) before each take. Judge mode takes
about 35 seconds of real time; cut or speed up the middle of it.

If the testnet contract and the live bot are up by recording day, use the
live-bot shots marked **[live]** instead of the judge-mode ones. In judge mode
the Verified panel carries a "simulated" tag; leave it visible rather than
cropping it.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0 to 8 s | `/arena`, scroll to **Run one yourself**: raise the demand slider and show the price chart, with the "Bonding curve price" climbing after the "Bot buys at second 0" markers, and the dashed "Sealround clearing price" flat beside it | "Every launch, bots buy first and dump on you." |
| 8 to 20 s | `/sale/fairt` (the open "Fair Test" sale): the **Public bids** table, where every row is only a "Sealed bid", then **Place a sealed bid** ("Sealed in this browser to sale key ...") | "On Sealround, bids are sealed until the sale closes, and everyone pays one price." |
| 20 to 45 s | `/judge`, click **Run demo**: the timeline steps "3 sniper bots bid at second 0", "50 people bid over the window", "A copycat replays a sealed bid", "Enclave clears the sale". End on the summary: **Bots paid** and **People paid** at the same price, the check "Bots and people paid exactly the clearing price.", the copycat's void bid. Click **Open the full result** and show **Verified: 5 of 5 checks passed**. **[live]** Terminal with `pnpm --filter web live-bot snipe` firing at the opening second, the sale page at close, then `pnpm --filter web live-bot report` printing the bot's price next to the clearing price; `copycat` rejected. | "The bot was faster. It didn't matter." |
| 45 to 60 s | `/sale/fairt`, **Fund from any chain**: choose USDC on Base, enter an amount ("Enter an amount for a live dry quote."), show the live quote with fees and time, then the **Where's my money** panel hop by hop. If the pilot ran a real swap, use that recording instead. | "Pay from any chain through NEAR Intents." |
| 60 to 75 s | `/arena`, top of the page: "What bots made and what people paid, by launch type", then **Results by launch type** | Read the real numbers: "Across 60 simulated launches, sniper bots made 1,269 USDC on a bonding curve, 177 on a first-come sale, and zero on Sealround." |
| 75 to 90 s | The pilot results table from README section 7 (or the pilot's result page), then the repo and the demo link on screen | "Try it with no funds. Link below." |

Arena numbers to quote (from `apps/web/src/data/arena-results.json`, seed
20261114, 60 runs): bot profit 1,269 / 177 / 0 USDC; human price premium
2.61x / 1.00x / 1.00x; bot share of supply 34.5% / 20.9% / 15.7% (bonding
curve / fixed price / Sealround). Do not say bots "get nothing": they still
buy 15.7% of supply on average, at the same price as everyone else.

## (b) X post

The spec's draft is 447 characters (links counted as 23), so it needs X
Premium or a thread.

**Long version (spec draft):**

```text
Every token launch, bots buy in the first block and dump on you.

Sealround fixes it: sealed bids, one clearing price. Bot or human, everyone pays the same.

Bids stay sealed inside a TEE on NEAR until the sale closes. Pay from any chain through NEAR Intents.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon @NearBuilders @out_layer

Try it with no funds: <demo link>
Code: <repo link>

What would you launch with it?
```

**Thread version (each post under 280 characters):**

Post 1 (271 characters), with the video attached:

```text
Every token launch, bots buy in the first block and dump on you.

Sealround: sealed bids, one clearing price. Bot or human, everyone pays the same. Bids stay sealed in a TEE on NEAR until close.

Try it with no funds: <demo link>

@NEARProtocol #NEARHackathon
```

Post 2 (250 characters):

```text
In 60 simulated launches, sniper bots made 1,269 USDC on a bonding curve and 0 on Sealround. Pay from any chain through NEAR Intents.

Built at NEAR HACKATHON with @NearBuilders @out_layer
Code: <repo link>

What would you launch with it?
```

Check before posting: that "Sealround" is free on X, GitHub and as a domain
(spec, Risks), and that the handles above are the right accounts.

## (c) Submission form

| Field | Answer |
| --- | --- |
| Project name | Sealround |
| Team lead's name | `<team lead name>` |
| Contact email | `<contact email>` |
| Team size | `2 - 4` (confirm) |
| Tracks | `memecoins`, `defi`, `privacy`, `open` |
| Mainnet NEAR account for the payout | `<account>.near` |
| Public repo link | `<repo link>` (git `origin` is currently `https://github.com/Vasanthdev2004/fairground`) |
| Public demo post link | `<X post link>` |
| Description | Below, 1,195 characters (limit 20 to 2,000) |
| Consent to the contact notice | Owner ticks it |

Description (1,195 characters, counted with the line as one paragraph):

```text
Every token launch rewards speed: sniper bots buy in the first block and sell to the people who arrive later. Sealround replaces the race with a sealed-bid, single-price auction on NEAR. A bidder locks a USDC deposit together with a bid encrypted in the browser (max price and max spend) that only the sale's enclave can open. After the window closes, an OutLayer TEE job, pinned by its code hash in the contract, opens the bids and computes one clearing price. The contract checks everything it can itself (the frozen bid-set hash, the sale key, supply, deposits, the cost of every fill) before it settles, and every winner, bot or human, pays the same price. Unfilled deposits come back; a missed minimum raise or an enclave that never answers refunds everyone. Buyers can fund from Solana, Ethereum, Bitcoin or Base through NEAR Intents 1Click, and a NEP-366 relayer pays their gas, so they need USDC and no NEAR. Judge mode runs a full sale with 50 people, 3 sniper bots and a copycat in about 35 seconds, with no wallet and no funds. Our Bot Arena simulator (60 seeded runs, rerun with one command) shows bots earning 1,269 USDC on a bonding curve and 0 on Sealround. Open source under MIT.
```

If the pilot ran, add one sentence with its real numbers (bidders, chains,
close-to-settle time) and trim elsewhere. If no real 1Click swap happened by
submission, change "Buyers can fund" to "Buyers get live quotes to fund".

## (d) Checklists

### Hackathon rules (HACKATHON.md, as listed in the spec)

| Rule | Status | Who |
| --- | --- | --- |
| Repo public by 14 Nov, 23:59 UTC, with a LICENSE file (MIT) | `LICENSE` added (MIT). Repo still private. Note: the Rust workspace manifests (`Cargo.toml`, `enclave/Cargo.toml`) declare `license = "MIT OR Apache-2.0"`; make them agree with `LICENSE` or add the Apache text. | Owner: make public; decide the Cargo license field |
| README with "do X → see Y" steps, every library listed, AI-written parts disclosed | Done in `README.md` (sections 2 and 12) | Done |
| Code from before 19 Oct separated by branch or tags, with a diff link | README says the repo starts at `781f75b` (9 Nov 2026) with no earlier code, so no baseline diff applies. Marked "owner to confirm". | Owner: confirm nothing from openlaunch or earlier work was copied in |
| No secrets anywhere in git history | Quick scan of all 3 commits: no `ed25519:` secret keys, no `.env` files (only the two `.env.example` with placeholders). `.env*`, `.sandbox-bin/`, `.sandbox-home/` are git-ignored. | Owner: run a real scanner (for example gitleaks) right before making the repo public |
| Hosted demo up through 18 Nov, ideally 25 Nov | Not deployed yet. Mock mode needs no chain, so it can be hosted as is ([LAUNCH.md](LAUNCH.md), Vercel). | Owner |
| Demo post on X tagging @NEARProtocol and #NEARHackathon, with video | Drafts above | Owner |
| Mainnet NEAR account ready for the prize payout | | Owner |
| Exactly one submission | | Owner |

### Definition of done (spec)

| Item | Status |
| --- | --- |
| A fresh clone plus the README commands reproduces judge mode with no errors | Done on 11 Nov 2026: clone, `pnpm install` (1 min), `pnpm build` (16 s), `pnpm --filter web start`, `/judge`, **Run demo**: settled result in 0:33 |
| A testnet sale goes create → bids → close → clear → claim, correct to the smallest unit | Done on a local sandbox (end-to-end run, 21/21 scenarios, 10 Nov 2026; integration tests check every balance). Testnet: owner deploys ([LAUNCH.md](LAUNCH.md)) |
| Every Verified panel check passes on the judge-mode sale | 5 of 5 pass, against a simulated attestation (labelled as such) |
| The live sniper bot pays exactly the clearing price, and the copycat attack is rejected | In judge mode and on the local sandbox (the copied ciphertext is voided by the pinned job). Live bot on testnet: `pnpm --filter web live-bot`, being built by another agent |
| Timeout refund works: no path leaves funds stuck | Sandbox integration tests (refund mode from `closed` and from `awaiting_close`) and the end-to-end `refund-mode` scenario |
| Bot Arena charts rebuild from one command | `pnpm arena`; rerun from a fresh clone reproduced the committed JSON byte for byte |
| The pilot ran, or the documented fallback did | Not yet. Fill README section 7 |
| Repo public, video posted, submission sent by Sat 18:00 UTC | Owner |

### Success metrics (spec)

| Metric | Target | Now |
| --- | --- | --- |
| Judge-mode time to a result | Under 2 minutes | 0:33 (fresh clone, production build) |
| Bot advantage in Sealround | Zero price advantage over humans | Simulator: premium 1.00x and bot profit 0 USDC in all 60 runs; judge mode: bots and people pay the same price |
| Pilot bidders | 20 or more | Pending pilot |
| Chains used to fund the pilot | 2 or more | Pending pilot |
| Close to settlement time | Under 2 minutes | Pending pilot (OutLayer's yield window is 200 blocks, about 2 minutes; a 500-bid clear runs in about 0.2 s) |
| Clearing implementations agreeing | 1,000 of 1,000 random sets | Rust and TypeScript agree exactly on all 389 shared clearing vectors (hand cases plus seeded random sets); the TypeScript reference also passes invariants on 1,000 random sets. A 1,000-set cross-language run has not been done. |

### Still to fill in

- `<video link>`, `<demo link>` in `README.md` (top) and in the X posts.
- `<repo link>` in the X posts and the form.
- README section 7, pilot results, with transaction links.
- The baseline sentence in README section 12 ("owner to confirm").
- Form fields: team lead name, contact email, team size, payout account, X post link.
- `LAUNCH.md` and `apps/web/scripts/live-bot/README.md` are linked from the README and are being written by other agents; check both exist before the repo goes public.
