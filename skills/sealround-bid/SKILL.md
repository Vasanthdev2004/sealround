---
name: sealround-bid
description: Place one sealed bid within a user-approved deposit budget on a Sealround enclave sale, or read the account's allocation, spend, refund, and clearing price. Use for Sealround bids and results.
---

# Sealround bid

Run from the Sealround repository root with its pnpm dependencies installed. The commands use the same NEAR client, bid sealing, and relayer as the app. Agents and people who win pay the same clearing price, with spend rounded up to the smallest quote-token unit.

## Check the sale

Use the user's network, contract, sale ID, and bidder account. Check the sale status and the quote token contract, symbol, and decimals before applying the budget. Bidding requires an open TEE sale and an account with enough of that sale's quote token. This repository limits agent signing to a local sandbox. The project owner handles public-network transactions.

```text
pnpm --filter web live-bot status --network sandbox --rpc <local-rpc> --contract <contract> --sale <sale-id> --account <bidder> --json
```

## Bid once

Use the approved deposit, deposit cap, maximum price per whole sale token, and maximum total spend. Set `--budget` explicitly. The CLI compares the **entire public deposit** to the cap in base units before signing. The maximum spend defaults to the deposit. If the user approved a lower spend, provide it separately.

```text
pnpm --filter web live-bot bid --network sandbox --rpc <local-rpc> --contract <contract> --sale <sale-id> --account <bidder> --relayer <local-relayer> --budget 5 --deposit 5 --max-price 0.02 --max-spend 3 --json
```

The numbers above are examples in whole quote-token units. Use a sandbox key supplied through `LIVE_BOT_PRIVATE_KEY` or `--key-file`. Keep keys and private bid limits out of shared logs. If necessary, pass the bid limits privately through `LIVE_BOT_MAX_PRICE` and `LIVE_BOT_MAX_SPEND`.

A relayer failure stops the bid before a paid fallback. Use `--direct` only when the user has authorized paying NEAR transaction fees separately from the deposit budget. Report the accepted bid index, transaction hash, and public deposit. After an ambiguous send, check `status` for the account's bid and verify the transaction outcome before retrying.

## Read the result

```text
pnpm --filter web live-bot result --network sandbox --rpc <local-rpc> --contract <contract> --sale <sale-id> --account <bidder> --json
```

The result command reads without a key or claim. For a pending sale, report its phase or use `--wait --max-wait <seconds>` for a bounded wait. Read `saleStatus` and `fill` to tell whether the bid won tokens or is due a refund. `ok` describes the report checks. Format `clearingPrice`, `fill.spent`, `fill.refund`, and `fill.penalty` with the quote token decimals, and `fill.tokens` with the sale token decimals.

## Use the MCP server instead

If the client has the `sealround` MCP server (`pnpm --silent --filter web mcp`, set up in `apps/web/scripts/mcp/README.md`), use its tools instead of the CLI. They take the same checks and the same sealing.

- `sealround_get_sale` replaces `status`. It returns the phase, the rules, the quote token, and the configured account's balance and bid.
- `sealround_place_bid` replaces `bid`. Pass the user-approved `max_price`, `max_spend` and `max_deposit` (the cap; required), and `deposit` only if it differs from `max_spend`. A deposit above the cap is refused before any network call. Set `direct: true` only when the user has authorized paying NEAR gas.
- `sealround_get_result` and `sealround_my_bid` replace `result`. Amounts are already in whole token units. `wait_seconds` (at most 300) gives a bounded wait.
- `sealround_claim` claims tokens and refund after settlement, gasless when the relayer sponsors it.
- `sealround_verify_sale` runs the `verify-sale` checks and returns pass, fail or not run for each check.

The key comes only from the server's environment (`SEALROUND_PRIVATE_KEY` or `SEALROUND_KEY_FILE`). Never pass a key as a tool argument. If a tool returns `ok: false` with `nothingSent: true`, nothing was signed. If it returns `maybeSubmitted`, call `sealround_my_bid` before retrying.
