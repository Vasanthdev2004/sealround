# Workboard

Shared task board for the agents in this repo. Rules are in `AGENTS.md`
("Working alongside another agent"). Newest entries first.

## In progress

| Agent | Task | Files claimed | Started | Notes |
| --- | --- | --- | --- | --- |
| Codex | Push the release and verify the Vercel mock demo | `WORKBOARD.md`, mock deployment instructions in `LAUNCH.md` | 2026-11-11 | Owner authorized the release commit, push and mock Vercel deployment. |
| Claude | Measured Designeer spec and current UI replacement audit | `UI-AUDIT.md`, this workboard row | 2026-11-11 | Supports Claude's redesign decisions. |

## Backlog

Pick one, move it to "In progress" with your claim.

- **Web decisions to confirm with the owner**: `maxBids` default 100,
  commit-reveal selectable on `/create`, the "sim" tag on `TxLink` in mock mode,
  wording of the "Verified" panel.

## Done

| Agent | Task | Result | Checks |
| --- | --- | --- | --- |
| Codex | Live 1Click deposit quotes and status tracking | Kept dry previews separate. Mainnet deposit quotes require server-only `ONECLICK_REAL_SWAPS=1` and Circle's native NEAR USDC. Checked quote terms before showing payment instructions. The receipt persists across reloads and tracks delivery or refund. Updated the launch and web docs. | 18 focused route and funding tests with local fixtures, 121 web tests total, ESLint, TypeScript and the production build passed. The built app returned `liveSwaps: false` by default and rejected deposit and status requests. No public-chain swap was attempted. Claude completed the bot sandbox test separately. |
| Claude | Root README, LICENSE, SUBMISSION.md, fresh-clone check; MIT license fields | `README.md` follows the spec`s 14-section outline; `LICENSE` is MIT; `SUBMISSION.md` has the video shot list, X post (single and thread), form answers and the rules checklist. Rust `license` fields changed to `MIT` to match; contract and sealer hashes unchanged (`0061c856…921e`, `f8408a87…d8cb`), `enclave/res/build-info.json` refreshed for the new Cargo.toml checksums. Owner fills: video, demo and repo links, pilot results, form personal fields, and confirms the baseline sentence in README section 12. | Fresh clone: install, `pnpm build`, judge mode settled in 0:33, `pnpm arena` byte-identical, all TS and Rust unit tests pass. `build-enclave.ps1 -Verify` MATCH. Contracts rebuilt to the same hashes. |
| Claude | Live sniper bot (`pnpm --filter web live-bot` with status, snipe, copycat, report, reveal) | Reuses the web client and sealing code. Key only from `LIVE_BOT_PRIVATE_KEY` or `--key-file`; checks network and key before signing; mainnet needs `--yes-mainnet`. See `apps/web/scripts/live-bot/README.md`. | Sandbox test (`pnpm --filter web exec tsx scripts/live-bot/sandbox-test.ts`): 8/8 scenarios, 62/62 checks. Snipe landed 0.8 s after open; bot paid exactly the clearing price; copycat rejected (different length) or voided with the 1 % penalty (same length). Never run on a public network. |
| Claude | Launch runbook | `LAUNCH.md`: testnet T1 to T8 via `enclave/deploy/*.ps1`, relayer on Fly.io (`apps/relayer/Dockerfile`, build from repo root), web on Vercel (mock demo, testnet, mainnet projects), testnet dry run of the pilot, mainnet pilot caps (`max_deposit_per_account` 10 USDC, `max_bids` 50), rollback and pre-submission checklist. Added a mainnet-only unaudited notice in the app shell and NEAR-mode copy in `how/limits.tsx`. | Relayer image builds (266 MB) and starts offline. Web TypeScript and ESLint pass. End to end on the rebuilt contract: 21/21 scenarios, 483/483 checks. |
| Codex | Verify the web release while Claude prepares launch materials | The normal Turbopack build passed when run directly via Node from `apps/web` with font access. The Webpack fallback compiled without Tailwind utilities because the repo config wires Tailwind through Turbopack. Use the Turbopack build for previews. Claude retained the shared sandbox for bot testing. | All 103 web tests and baseline web ESLint passed. All seven routes rendered in the production preview at 1440px and 375px. The phone Judge demo settled in 33 seconds and opened its full result. |
| Claude | Baseline commit, local paths removed, pushed (owner asked) | `main` is `ee5c419`, pushed to origin. `scripts/build-contracts.ps1` now passes `--remap-path-prefix` through cargo-near `--env RUSTFLAGS=...` and refuses a wasm that still contains the home or checkout path. Rebuilt contracts: `fairground.wasm` sha256 `0061c856…921e` (546,701 bytes), token 167,069 bytes; AGENTS.md, enclave/README.md and contracts/GAS.md updated. | Contracts: 178 unit and 17 sandbox integration tests pass. e2e not rerun. |
| Claude | Base blue palette (owner picked option A; task moved from Codex to Claude by the owner) | `globals.css` tokens only: neutral near-black canvas and hairlines again, Base blue `#0052FF` for primary buttons, selections and the price (`#3d7eff` as text on dark), state colours retuned for black. Light theme is the same blue on a neutral white canvas. Kept Codex`s light theme, theme toggle and token names; no component changed. `UI-DIRECTION.md` token table updated. | Web TypeScript, ESLint and 103/103 tests pass. All routes checked at 1440px dark, Home, Sale, Result and Arena in light, Home and Sale at 375px with no horizontal scroll. |
| Codex | Fix the amber simulation labels found in browser feedback | Changed the funding panel's network label and the other simulation tags to the shared neutral style. | Verified the funding badge and other visible sale tags at 957px and 375px. Checked result tags at 375px. Web ESLint, TypeScript and all 103 web tests passed. |
| Codex | Refine sale states and timing after browser feedback | Used neutral phase icons and labels on Home, Sale and Result. Removed colored dots from routine counters and simulation disclosures. Used text weight for action hints and surfaced close and refund hints on phones. Updated the shared UI direction. | Verified the Home table at 957px and 375px, the filter with keyboard input, and Sale and Result links. Smoke-checked all seven routes at 1440px and 375px. No page-level overflow observed. Web ESLint, TypeScript and 103 web tests passed. |
| Claude | Finishing pass on Sale, Result, Judge, Create, Arena and How to the Home page's level | Every route except Home now follows `apps/web/UI-DIRECTION.md`: one panel level (no boxes inside cards), text cut to what affects money or a decision, shared `Button`/`Segmented`/`Field` controls only, `.num` on every figure, skeletons that match the settled layout. Create re-confirms when the NEAR creation cost changes before signing. Result labels claims by what the account gets. Removed `lib/poster.ts` (now `lib/palette.ts`), `visual/token-art.tsx`, `visual/seal-scene.tsx`, `sale/clearing-visual.tsx`, `sale/chain-glyph.tsx`, and the unused legacy classes and tokens in `globals.css`. Added `--line-hover` and a 44px `square` Button size, used by the shell menu and close buttons. `apps/web/src` is free to edit again outside Codex's Home claim. | Web TypeScript, ESLint (`src scripts`) and 103/103 web tests pass. Every route at 1440px and 375px: no page-level horizontal scroll, no console exceptions. Drawer opens, moves focus to Close, and the menu button hides on desktop. Production build skipped because the dev server is running. |
| Codex | Rename the product to Sealround | Updated the app wordmark, page titles, guide, Arena report, bid-secret download name, user-facing messages, and project docs. Existing package, contract, storage, and export identifiers remain compatible. | Verified Home, How, Arena, Create, Sale, and Result in the running app. Web ESLint, TypeScript, 103 web tests, and 16 Arena tests passed. |
| Codex | Cross-route UI and iconography rework | Applied the near-black Inter foundation to Home, Sale, Result, Create, Judge, Arena, and How. Simplified decorative marks and repeated panels, improved transaction hierarchy, and made prices readable at full contrast. | Running React app on desktop and mobile. Web TypeScript and ESLint passed. All 103 web tests passed. See Notes for browser checks and the fixed mobile issue. |
| Codex | Fairground logo and favicon | Replaced the header and drawer mark with a solid split seal, set the Fairground wordmark in Inter, and replaced the stock favicon with the matching mark. Logo files are available to Claude again. | Real app at 1440px and 375px. Verified the 44px logo target, mobile drawer and return-to-Home link. Shell ESLint and favicon frames at 16, 32 and 48px passed. |
| Codex | Designeer research and Fairground redesign plan | [UI redesign plan](UI-REDESIGN-PLAN.md) proposes a quiet charcoal gallery, a shared cobalt action palette, a complete route and control brief, and implementation ownership. Claude's UI and audit claims remain active. | Reviewed public Designeer browse sections and shortlisted references, all three HTML studies, and the running Home, Sale and Result. |
| Claude | Reconcile contract, enclave, relayer, web data layer; full verification | Contract and sealer hashes pinned (`20e54626…`, since rebuilt as `0061c856…` without local paths; `f8408a87…`); bid length leak closed; penalties for invalid bids; sealer error retries; `clear_onchain` at 150 TGas | Everything in `AGENTS.md` "Checks", all green on 2026-11-10 |

## Notes

### Mainnet 1Click follow-up

- Live 1Click has local fixture coverage. Before enabling it on the pilot, verify the provider's signed quote and check that a live response passes recipient and refund address validation. The owner records the first completed swap.

- **Resolved during Claude's Create pass.** The preview previously showed a missing `LockedRow` export. Create rendered in the browser and web TypeScript passed after the files were integrated.

### Desktop and mobile QA after the cross-route rework

- All seven routes rendered at 1440px and 375px with zero page-level horizontal overflow. Home and its wallet controls also passed at 320px.
- **Fixed: clipped wallet control on narrow screens.** At 320px, the header could cut off Connect and the account menu could extend off-screen. The header now fits the full label, uses a short Wallet label on phones, and places the open menu inside the viewport. Retested both signed-in and signed-out states. The drawer also restores scrolling after resizing to desktop.
- On the simulated chain, verified Home filter arrow keys, a mobile Fair Test bid and its saved receipt, Judge demo settlement and a token and refund claim, and all five simulated verification checks. Create rejected empty fields and kept the draft when returning from review. The Arena demand slider and How section links worked by keyboard or click.
- Browser QA used the local app in mock mode. Public-network wallet signing and live settlement were outside this run.

- Dev server: `pnpm dev` on :3000. Do not build while it runs.
