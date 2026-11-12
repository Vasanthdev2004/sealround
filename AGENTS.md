# Sealround: notes for coding agents

Read this first. It is shared by every agent working in this repo (Claude Code,
GPT/Codex, anyone else). Tool-specific notes live next to the code they cover
(for example `apps/web/AGENTS.md` for the Next.js app).

## What this is

Sealround runs sealed-bid, single-price token sales on NEAR. Bids are sealed in
the browser, opened only inside an OutLayer TEE job after the sale closes, and
every winner pays the same clearing price, so bots and people pay the same.
The spec is `Fairground — Project Requirements (NEAR HACKATHON).md`.

## Layout

| Path | What | Docs |
| --- | --- | --- |
| `apps/web` | Next.js 16 app (React 19, Tailwind v4, React Compiler). Mock mode by default, NEAR mode when `NEXT_PUBLIC_FAIRGROUND_CONTRACT` is set | `apps/web/README.md`, `apps/web/UI-DIRECTION.md`, `apps/web/AGENTS.md` |
| `apps/relayer` | NEP-366 gas relayer (Hono). Pays gas for bids, claims, reveals, `clear_onchain`, refund mode; never relays payable calls | `apps/relayer/README.md` |
| `packages/clearing` | TypeScript reference of the clearing algorithm and hashes | |
| `packages/relayer-client` | Browser client for the relayer | `packages/relayer-client/README.md` |
| `packages/arena` | Bot-vs-people simulation behind the Arena page | `packages/arena/README.md` |
| `crates/clearing` | Rust clearing, shared by the contract and the sealer | |
| `crates/sealer` | Rust bid opening (sealed box, padded plaintext) | |
| `contracts/fairground` | The sale contract | `contracts/DESIGN.md`, `contracts/GAS.md` |
| `contracts/token`, `contracts/mock-ft` | Sale token template, test USDC | |
| `contracts/tests` | near-workspaces integration tests against a sandbox | |
| `contracts/res` | Built wasm, committed on purpose | `contracts/res/NOTICE.md` |
| `enclave/` | WASI sealer job, runner, reproducible Docker build | `enclave/README.md`, `enclave/PERF.md` |
| `scripts/` | PowerShell build and test scripts (Windows host, Docker for Linux bits) | headers of each script |

## Run it

```powershell
pnpm install
pnpm dev                          # web app, http://localhost:3000, mock mode
pnpm --filter web e2e:sandbox     # full local stack: sandbox chain + contract + relayer + mock OutLayer, 21 scenarios
```

NEAR mode against a local sandbox: see `apps/web/.env.example` and
`apps/web/README.md`. The sandbox node runs in Docker (`scripts/sandbox.ps1`);
start Docker Desktop first.

## Checks

Run the ones that cover what you touched before you hand work back.

| Area | Command (from repo root unless noted) |
| --- | --- |
| Rust | `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| Contracts, full | `powershell -File scripts\test-contracts.ps1` (builds, unit + integration, needs Docker) |
| Enclave | `powershell -File scripts\run-enclave.ps1 -Test`, `powershell -File scripts\build-enclave.ps1 -Verify` |
| Clearing TS | `pnpm --filter @fairground/clearing test` |
| Relayer | in `apps/relayer`: `pnpm test`, `pnpm typecheck`, `pnpm test:sandbox` |
| Relayer client | in `packages/relayer-client`: `pnpm test`, `pnpm typecheck` |
| Web | in `apps/web`: `npx tsc --noEmit --incremental false`, `npx eslint src scripts`, `npx vitest run`, `pnpm build` |
| End to end | `pnpm --filter web e2e:sandbox` |

Last full pass (2026-11-10): all green. 178 Rust unit, 17 integration, 1028
clearing TS, 386 relayer, 263 relayer client, 103 web, 21/21 e2e scenarios.

## Rules that bite

- **Do not run `next build`, `next typegen` or a second `next dev` while a dev
  server runs from `apps/web`.** They share `.next` and corrupt each other.
  Stop the dev server first, or skip the build.
- **Next.js 16 differs from what you know.** Read the guide in
  `apps/web/node_modules/next/dist/docs/` before writing Next code.
- **Pinned hashes.** `contracts/res/fairground.wasm` (sha256 `bfc2f800…a800`)
  and `enclave/res/fairground_sealer.wasm` (sha256 `f8408a87…d8cb`) are
  pinned in docs, the contract and the web config. Any change under
  `contracts/fairground`, `crates/*` or `enclave/job` changes a hash: rebuild
  with `scripts\build-contracts.ps1` / `scripts\build-enclave.ps1` and update
  every place the old hash appears (search for it).
- **The sealed-bid format is shared by five places**: `crates/sealer`,
  `packages/clearing`, the web sealing code, the relayer policy and the
  contract. Plaintext pads both amounts to 39 digits; ciphertext length is
  `224 + len(sale_id) + len(bidder)` bytes and the contract refuses any other
  length. Change one, change all, and run the e2e.
- **No public networks.** No testnet or mainnet deploys, no account creation,
  no real keys or signing. Sandbox only. The project owner does those steps.
- **Secrets.** Every `NEXT_PUBLIC_` variable ships to the browser. Dev keys
  only on a localhost sandbox.
- Write code, comments and docs in plain, direct prose.

## Working alongside another agent

Two agents share one working tree. To keep out of each other's way:

1. Read `WORKBOARD.md` before you start.
2. Claim your task there: one row in "In progress" with your name, the area,
   and the files or folders you will edit. Do not edit files another agent has
   claimed; ask the owner (in chat) to coordinate instead.
3. Keep tasks small and finish them. When done, move your row to "Done", note
   what changed, which checks you ran, and anything the next agent must know.
4. Do not reformat, rename or "tidy" files outside your task.
5. Only the project owner decides commits, pushes, deploys and design
   direction. Commit only when asked.
6. If you find a bug in someone else's claimed area, write it under "Notes"
   in `WORKBOARD.md` rather than fixing it yourself.
