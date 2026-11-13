# Submission kit

For the project owner, not for judges. Everything here comes from the spec
(`Fairground — Project Requirements (NEAR HACKATHON).md`, "Submission package"
and "Track requirements checklist") adjusted to what the app does today.
Placeholders are in `<angle brackets>`.

Deadline: 14 Nov 2026, 23:59 UTC. Internal target: **14 Nov, 18:00 UTC**
(23:30 IST). Submit once at nearhackathon.com/#apply; corrections go through
the request-changes page.

## (a) Demo video, 1:28

**Opening line.** “On a first-come launch, the fastest bot gets first pick. On Sealround, a bot can bid at the opening second and pay the same price as someone who bids just before close.”

Record the testnet evidence in the order below. Show the chain or explorer timestamp beside each bid. Use “second 0” only if the bot’s recorded bid landed less than one second after opening. Have a person submit the late bid on camera, or say “late bidder” if both bids came from the evidence script. Show the actual numbers from the run.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0:00–0:09 | A first-come launch, then the Sealround sale. Show the bidding window and the sealed bid list. | “On a first-come launch, the fastest bot gets first pick. Sealround gives everyone a window to submit a sealed bid.” |
| 0:09–0:27 | Split screen: the bot submits at the open, then a person submits near close. Overlay their recorded times. Cut to **Close sale**. | “The bot bid at second zero. A person bid near close. Their prices and budgets stayed encrypted until OutLayer opened the bids.” |
| 0:27–0:47 | Open the result page in a browser that has not opened it before, with reduced motion off, so the reveal plays in the hero (about 2.5 s; **Replay** runs it again): the sealed bids, opened in the enclave, one price with “All <n> winners paid it”. Scroll to the fairness timeline under the heading “Early or late, one price” and hold on its headline, which gives the first and the last winning bid’s times and says “Both paid <clearing price> USDC per token”. Point at the transaction links. | “Both won. The timing was different. The price was the same: <clearing price> USDC per token. You can check each charge against its fill.” |
| 0:47–1:07 | Open the Rhea pool at creation. Show initial reserves, the sale contract’s LP share balance, and its empty access-key list. | “Part of the raise and the reserved tokens open a Rhea pool at that same clearing price. The keyless sale contract holds the LP shares.” |
| 1:07–1:28 | Open **Verified** and show the TDX report data, approved measurements, and frozen bid-set hash. End with the testnet result and Judge mode links. | “Your browser checks OutLayer’s Intel TDX evidence against the NEAR record and recomputes the frozen bid set. Open the testnet result yourself, or run Judge mode with no wallet.” |

The 1:28 cut meets the submission spec. An extended cut can run through **2:20**. Use 1:28–1:46 to open the input and output hashes and show one bidder’s inclusion check. Use 1:46–2:02 on `/create`: enter the evidence sale’s rules and let **Simulate this launch** run them from half to four times demand, showing what sells, what burns and what bots make before the parameters are chosen (the memecoin brief’s “simulate first, then pick the parameters”); it is labelled a simulation. Use 2:02–2:20 to show where the OutLayer verifier checks the quote’s signature chain up to Intel and where to find the pool’s first transaction.

On a real contract the timeline names bids, not bots: the chain stores no bidder roles, so its headline gives the first and the last winning bid by their times only. Say which account was the bot in the voice-over or an overlay. In Judge mode the same headline names a bot and a person.

**Evidence links to fill after the owner’s testnet run**

- Sale and result `<link>`
- Bot bid and human late bid transactions `<link>` and `<link>`
- Close and settlement transaction `<link>`
- Rhea pool and initial liquidity transaction `<link>` and `<link>`
- Sale contract LP balance and access keys `<link>` and `<link>`
- OutLayer attestation `<link>`

`LAUNCH.md` T7b runs this sale with `enclave\deploy\8-evidence-sale.ps1`. Its Report phase prints the contract, token and result page links, each bid’s time after the open, the fills and the pool as Markdown; the transaction links come from the hashes the phases print. `pnpm --filter web verify-sale --contract <contract> --sale <evidence sale id>` checks both enclave runs and the bid set from the command line.

The older testnet smoke sale verifies OutLayer’s sale-key run, clearing run, and bid-set hash. The local sandbox has a measured 0.8-second bot bid. Use the new testnet run for the combined story above. If it is unavailable, show the 35-second Judge run with **Simulated** visible and describe the pool and checks as simulated. Use the separate sandbox and smoke evidence with their own labels.

## (b) X thread

Use the testnet wording after the evidence links and on-screen timestamps are confirmed. Each post fits within 280 characters with each URL counted as 23. Attach the 1:28 video to post 1.

**Post 1**

```text
Token launches reward the fastest click. On Sealround, bids stay sealed until close and every winner pays one clearing price.

Watch a bot bid at second 0 and a person bid near close. Both pay the same on NEAR testnet.

@NEARProtocol #NEARHackathon
```

**Post 2**

```text
Part of the raise and the reserved tokens open a Rhea pool at the sale’s clearing price. The keyless sale contract holds the LP shares.

Rhea pool: <link>
Testnet result: <link>
```

The result link is last because X builds a post’s card from one link, normally the last. On the hosted testnet app it unfurls into the sale’s share card: the token, the clearing price and “Everyone paid the same price.” Check the card in the composer before posting; post 1 carries the video, so it shows none. The result page’s **Share on X** button drafts one factual sentence from the result (the price, and when the first and last winning bids landed) with the same link, for a reply or a quote post.

**Post 3**

```text
Open Verified to check OutLayer’s Intel TDX evidence against the NEAR record and recompute the frozen bid set. OutLayer’s verifier checks the Intel signature chain separately.

Judge mode, no wallet: https://sealround-demo.vercel.app/judge
Code: https://github.com/Vasanthdev2004/fairground
```

## (c) Submission form

| Field | Answer |
| --- | --- |
| Project name | Sealround |
| Team lead's name | `<team lead name>` |
| Contact email | `<contact email>` |
| Team size | `2 - 4` (confirm) |
| Tracks | `memecoins`, `defi`, `privacy`, `open`, and `agents` (Agent Economy: the MCP server and the bidding skill) if the owner enters it |
| Mainnet NEAR account for the payout | `<account>.near` |
| Public repo link | https://github.com/Vasanthdev2004/fairground (make it public first) |
| Public demo post link | `<X post link>` |
| Description | Below, 1,834 characters (limit 20 to 2,000) |
| Consent to the contact notice | Owner ticks it |

Description (1,834 characters, counted as one paragraph):

```text
Sealround is the fair mode for token launches on NEAR. Every launch today rewards speed or peeking: sniper bots buy in the first block of a bonding curve or a first-come sale, and in a public auction anyone can read the bids and outbid at the last second. Sealround replaces the race with a sealed-bid, single-price auction. A bidder locks a USDC deposit together with a bid encrypted in the browser (max price and max spend) that only the sale's enclave can open: not the creator, not the relayer, not us. After the window closes, an OutLayer TEE job, pinned by its code hash in the contract, opens every bid at once and computes one clearing price. The contract checks everything it can itself (the frozen bid-set hash, the sale key, supply, deposits, the cost of every fill) before it settles, and every winner, bot or human, pays the same price. Every sealed bid has the same length, a copied bid is refused or penalised, and there is no admin key; a missed minimum raise or an enclave that never answers refunds everyone. Buyers can fund from Solana, Ethereum, Bitcoin or Base through NEAR Intents 1Click, and a NEP-366 relayer pays their gas. Judge mode runs a full sale with 50 people, 3 sniper bots and a copycat in about 35 seconds, with no wallet and no funds. Our Bot Arena simulator (60 seeded runs, rerun with one command) shows bots earning 1,269 USDC on a bonding curve and 0 on Sealround, and a real sniper bot on a local NEAR chain paid exactly the clearing price. The same model runs on the create page, so a creator sees what sells and what burns before choosing the parameters. AI agents bid on the same terms: a local MCP server lets an agent place one sealed bid within a deposit cap the user approved, then read its result, claim and verify the sale. Bots can't snipe what they can't see. Open source under MIT.
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
- "What about liquidity after the sale?" The creator can reserve tokens and
  set aside part of the raise to seed a Rhea pool at the clearing price. The
  sale contract holds the LP shares. The new testnet run will show the
  initial reserves, LP ownership, and the contract's access-key list.
- "Whales still win." Yes: this removes the speed and information advantages,
  not the money advantage. Per-account deposit caps limit it; sybil resistance
  is a stated limit (README section 11).
- "Can an AI agent use it?" Yes, on the same terms as a person.
  `pnpm --silent --filter web mcp` starts a local MCP server with seven tools:
  list and read sales, place one sealed bid, read the agent's own bid and the
  result, claim, and verify the sale's enclave runs. A bid needs a
  `max_deposit` cap and is refused above it before anything is signed; writes
  on mainnet need an explicit setting; the key comes only from the
  environment and never appears in a tool result. The agent's bid is sealed
  like anyone's and, if it wins, pays the same clearing price. It is tested end to end on
  a local sandbox, not on testnet. `skills/sealround-bid/SKILL.md` does the
  same through the bot's command line.

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
| A testnet sale goes create → bids → close → clear → claim, correct to the smallest unit | Done on a local sandbox (end-to-end run, 21/21 scenarios and 483/483 checks, last run 12 Nov 2026 after the web redesign; integration tests check every balance). Testnet: the evidence sale, run by the owner ([LAUNCH.md](LAUNCH.md) T7b) |
| Every Verified panel check passes on the judge-mode sale | 11 of 11 pass in the browser against labelled simulated evidence. Separately, the old testnet smoke sale passed both sets of eight OutLayer checks and the bid-set comparison. |
| The live sniper bot pays exactly the clearing price, and the copycat attack is rejected | In judge mode and on the local sandbox (the copied ciphertext is voided by the pinned job). The live bot (`pnpm --filter web live-bot`) passed 8 of 8 sandbox scenarios: it bid 0.8 s after open and paid exactly the clearing price; the copycat was rejected or voided with the 1% penalty. Testnet run: the evidence sale's sniper and copycat ([LAUNCH.md](LAUNCH.md) T7b), run by the owner |
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
- The evidence links in (a) and the testnet result link in post 2, from the
  T7b run (`LAUNCH.md`): its Report Markdown, the `verify-sale` output, and
  the T8 `list-keys` output.
- The baseline sentence in README section 12 ("owner to confirm").
- Form fields: team lead name, contact email, team size, payout account, X post link.
