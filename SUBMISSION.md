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

The pitch, in one line, for the voice-over and every caption: **Sealround is
the fair mode for token launches. Bots can't snipe what they can't see.** Say
"fair mode", not "launchpad": judges have seen many launchpads, and the new
part is the sale itself.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0 to 8 s | `/arena`, scroll to **Run one yourself**: raise the demand slider and show the price chart, with the "Bonding curve price" climbing after the "Bot buys at second 0" markers, and the dashed "Sealround clearing price" flat beside it | "Every launch, bots buy first and dump on you." |
| 8 to 20 s | `/sale/fairt` (the open "Fair Test" sale): the **Public bids** table, where every row is only a "Sealed bid", then **Place a sealed bid** ("Sealed in this browser to sale key ...") | "On Sealround, bids are sealed until the sale closes, and everyone pays one price." |
| 20 to 45 s | `/judge`, click **Run demo**: the timeline steps "3 sniper bots bid at second 0", "50 people bid over the window", "A copycat replays a sealed bid", "Enclave clears the sale". End on the summary: **Bots paid** and **People paid** at the same price, the check "Bots and people paid exactly the clearing price.", the copycat's void bid. Click **Open the full result** and show **Verified: 5 of 5 checks passed**. **[live]** Terminal with `pnpm --filter web live-bot snipe` firing at the opening second, the sale page at close, then `pnpm --filter web live-bot report` printing the bot's price next to the clearing price; `copycat` rejected. | "The bot was faster. It didn't matter." |
| 45 to 60 s | `/sale/fairt`, **Fund from any chain**: choose USDC on Base, enter an amount ("Enter an amount for a live dry quote."), show the live quote with fees and time, then the **Where's my money** panel hop by hop. If the pilot ran a real swap, use that recording instead. | "Pay from any chain through NEAR Intents." |
| 60 to 75 s | `/arena`, top of the page: "What bots made and what people paid, by launch type", then **Results by launch type** | Read the real numbers: "Across 60 simulated launches, sniper bots made 1,269 USDC on a bonding curve, 177 on a first-come sale, and zero on Sealround." |
| 75 to 90 s | The pilot results table from README section 7 (or the pilot's result page). End on the landing page (`/`), section **Not another launchpad. The fair mode for one.** (the comparison table), with the repo and the demo link on screen | "Bots can't snipe what they can't see. Try it with no funds. Link below." |

Arena numbers to quote (from `apps/web/src/data/arena-results.json`, seed
20261114, 60 runs): bot profit 1,269 / 177 / 0 USDC; human price premium
2.61x / 1.00x / 1.00x; bot share of supply 34.5% / 20.9% / 15.7% (bonding
curve / fixed price / Sealround). Do not say bots "get nothing": they still
buy 15.7% of supply on average, at the same price as everyone else.

## (b) X post

Lengths are counted the way X counts them (every link is 23 characters).
The long version is 515 characters, so it needs X Premium; otherwise post the
thread.

**Long version:**

```text
Every token launch, bots buy in the first block and dump on you.

Sealround is the fair mode for token launches on NEAR. Bids stay sealed inside a TEE until the sale closes, then every winner pays one clearing price. Bot or human, the same price.

Bots can't snipe what they can't see.

Pay from any chain through NEAR Intents.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon @NearBuilders @out_layer

Try it with no funds: https://sealround-demo.vercel.app/judge
Code: https://github.com/Vasanthdev2004/fairground

What would you launch with it?
```

**Thread version (each post under 280 characters):**

Post 1 (278 characters), with the video attached:

```text
At every launch, bots buy first and dump on you.

Sealround is the fair mode for launches on NEAR: bids stay sealed in a TEE until close, then everyone pays one price.

Bots can't snipe what they can't see.

Try it, no funds: https://sealround-demo.vercel.app/judge
@NEARProtocol #NEARHackathon
```

Post 2 (278 characters):

```text
In 60 simulated launches, sniper bots made 1,269 USDC on a bonding curve, 177 on first come and 0 on Sealround.

On a local NEAR chain, a real sniper bot bid 0.8 s after open and paid exactly the clearing price.

Built with @NearBuilders @out_layer
Code: https://github.com/Vasanthdev2004/fairground
```

If the testnet pilot ran by posting day, replace "On a local NEAR chain" with
the pilot's real numbers (bidders, chains, what the bot paid).

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
| Public repo link | https://github.com/Vasanthdev2004/fairground (make it public first) |
| Public demo post link | `<X post link>` |
| Description | Below, 1,542 characters (limit 20 to 2,000) |
| Consent to the contact notice | Owner ticks it |

Description (1,542 characters, counted as one paragraph):

```text
Sealround is the fair mode for token launches on NEAR. Every launch today rewards speed or peeking: sniper bots buy in the first block of a bonding curve or a first-come sale, and in a public auction anyone can read the bids and outbid at the last second. Sealround replaces the race with a sealed-bid, single-price auction. A bidder locks a USDC deposit together with a bid encrypted in the browser (max price and max spend) that only the sale's enclave can open: not the creator, not the relayer, not us. After the window closes, an OutLayer TEE job, pinned by its code hash in the contract, opens every bid at once and computes one clearing price. The contract checks everything it can itself (the frozen bid-set hash, the sale key, supply, deposits, the cost of every fill) before it settles, and every winner, bot or human, pays the same price. Every sealed bid has the same length, a copied bid is refused or penalised, and there is no admin key; a missed minimum raise or an enclave that never answers refunds everyone. Buyers can fund from Solana, Ethereum, Bitcoin or Base through NEAR Intents 1Click, and a NEP-366 relayer pays their gas. Judge mode runs a full sale with 50 people, 3 sniper bots and a copycat in about 35 seconds, with no wallet and no funds. Our Bot Arena simulator (60 seeded runs, rerun with one command) shows bots earning 1,269 USDC on a bonding curve and 0 on Sealround, and a real sniper bot on a local NEAR chain paid exactly the clearing price. Bots can't snipe what they can't see. Open source under MIT.
```

Questions judges are likely to ask, and the short answers (README sections 9
to 11 have the long ones):

- "Isn't this just a launchpad?" It is the sale mechanism a launchpad runs.
  Sealround ships a minimal launchpad around it to show it working; the new
  part is sealed bids that an attested enclave opens after close, with one
  clearing price and a result anyone can check.
- "Sealed-bid uniform-price auctions already exist." On-chain batch auctions
  show every bid before close. Here nobody can read a bid until the window
  ends, and the contract checks the enclave's result before it settles.
- "What about liquidity after the sale?" Today the creator gets the raise and
  the creator allocation and sets up any pool. Seeding a Rhea pool at the
  clearing price, with the LP tokens held until a lock date, is P1 on the
  roadmap (README section 13).
- "Whales still win." Yes: this removes the speed and information advantages,
  not the money advantage. Per-account deposit caps limit it; sybil resistance
  is a stated limit (README section 11).

If the pilot ran, add one sentence with its real numbers (bidders, chains,
close-to-settle time) and trim elsewhere. If no real 1Click swap happened by
submission, change "Buyers can fund" to "Buyers get live quotes to fund".

## (d) Checklists

### Hackathon rules (HACKATHON.md, as listed in the spec)

| Rule | Status | Who |
| --- | --- | --- |
| Repo public by 14 Nov, 23:59 UTC, with a LICENSE file (MIT) | `LICENSE` added (MIT); `Cargo.toml` and `enclave/Cargo.toml` say `license = "MIT"` to match. Repo still private. | Owner: make public |
| README with "do X → see Y" steps, every library listed, AI-written parts disclosed | Done in `README.md` (sections 2 and 12) | Done |
| Code from before 19 Oct separated by branch or tags, with a diff link | README says the repo starts at `781f75b` (9 Nov 2026) with no earlier code, so no baseline diff applies. Marked "owner to confirm". | Owner: confirm nothing from openlaunch or earlier work was copied in |
| No secrets anywhere in git history | Pattern scan of every commit on 12 Nov 2026 (through `cf41407`): no NEAR secret keys (one all-`1` placeholder in a test), no PEM private keys, no JWTs, and no `.env` files (only the two `.env.example` with placeholders). `.env*`, `.sandbox-bin/`, `.sandbox-home/` are git-ignored. | Owner: run a real scanner (for example gitleaks) right before making the repo public |
| Hosted demo up through 18 Nov, ideally 25 Nov | Live at https://sealround-demo.vercel.app (mock mode; the landing page at `/`, judge mode at `/judge`). Vercel redeploys on every push to `main`. | Owner: keep the project up through 25 Nov |
| Demo post on X tagging @NEARProtocol and #NEARHackathon, with video | Drafts above | Owner |
| Mainnet NEAR account ready for the prize payout | | Owner |
| Exactly one submission | | Owner |

### Definition of done (spec)

| Item | Status |
| --- | --- |
| A fresh clone plus the README commands reproduces judge mode with no errors | Done on 11 Nov 2026: clone, `pnpm install` (1 min), `pnpm build` (16 s), `pnpm --filter web start`, `/judge`, **Run demo**: settled result in 0:33 |
| A testnet sale goes create → bids → close → clear → claim, correct to the smallest unit | Done on a local sandbox (end-to-end run, 21/21 scenarios and 483/483 checks, last run 12 Nov 2026 after the web redesign; integration tests check every balance). Testnet: owner deploys ([LAUNCH.md](LAUNCH.md)) |
| Every Verified panel check passes on the judge-mode sale | 5 of 5 pass, against a simulated attestation (labelled as such) |
| The live sniper bot pays exactly the clearing price, and the copycat attack is rejected | In judge mode and on the local sandbox (the copied ciphertext is voided by the pinned job). The live bot (`pnpm --filter web live-bot`) passed 8 of 8 sandbox scenarios: it bid 0.8 s after open and paid exactly the clearing price; the copycat was rejected or voided with the 1% penalty. Testnet run: owner |
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

- `<video link>` in `README.md` (top). The demo link is filled in: https://sealround-demo.vercel.app
- The repo link is filled in; make the repository public before posting.
- README section 7, pilot results, with transaction links.
- The baseline sentence in README section 12 ("owner to confirm").
- Form fields: team lead name, contact email, team size, payout account, X post link.
