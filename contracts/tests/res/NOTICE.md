# Third-party files in contracts/tests/res

## ref_exchange.wasm (not in git)

The Rhea (formerly Ref Finance) exchange contract, used only by the sandbox
integration tests (`contracts/tests`, launch liquidity). Fairground never
deploys it; on testnet and mainnet the contract calls the exchange that is
already there (`ref-finance-101.testnet`, `v2.ref-finance.near`).

The file is not committed: its licence is not confirmed, so this repository
does not redistribute it. `scripts/fetch-rhea-wasm.mjs` fetches it, and
`scripts/test-contracts.ps1` runs that script before the integration tests:

```
node scripts/fetch-rhea-wasm.mjs
```

It reads the code deployed on `ref-finance-101.testnet` with the read-only RPC
`view_code` query and writes `contracts/tests/res/ref_exchange.wasm` only if
the sha256 matches the pinned build below. If the exchange has been upgraded
since, it reads the pinned block from an archival node
(`archival-rpc.testnet.fastnear.com`) instead.

- Version: `get_metadata` on that account reports 1.9.19.
- First read at block 277,345,406 on 12 Nov 2026.
- NEAR code hash: `AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX`.
- sha256: `8918c505017ceb57646bdd863c34e4fe56e2edc7756963d6f4a1f38d6f9c34d2`
  (894,284 bytes).
- License: not confirmed.
