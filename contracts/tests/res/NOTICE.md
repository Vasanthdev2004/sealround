# Third-party files in contracts/tests/res

## ref_exchange.wasm

The Rhea (formerly Ref Finance) exchange contract, used only by the sandbox
integration tests (`contracts/tests`, launch liquidity). Fairground never
deploys it; on testnet and mainnet the contract calls the exchange that is
already there (`ref-finance-101.testnet`, `v2.ref-finance.near`).

- Source: the code deployed on `ref-finance-101.testnet`, read with the RPC
  `view_code` query (read-only, https://rpc.testnet.near.org) at block
  277,345,406 on 12 Nov 2026. Saved unmodified.
- Version: `get_metadata` on that account reports 1.9.19.
- NEAR code hash: `AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX`.
- sha256: `8918c505017ceb57646bdd863c34e4fe56e2edc7756963d6f4a1f38d6f9c34d2`
  (894,284 bytes).
- License: not confirmed. The public `ref-finance/ref-contracts` repository
  was not reachable when this copy was made. Confirm the license before this
  file is published with the repository, or fetch it at test time instead.

To fetch it again:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"ref-finance-101.testnet"}}'
$r = Invoke-RestMethod -Method Post -Uri https://rpc.testnet.near.org -ContentType application/json -Body $body
[IO.File]::WriteAllBytes("contracts\tests\res\ref_exchange.wasm", [Convert]::FromBase64String($r.result.code_base64))
```

The exchange may have been upgraded since; check its `hash` in the same
response against the code hash above.
