# Sealround MCP server

A stdio [MCP](https://modelcontextprotocol.io) server that lets an AI agent
read Sealround sales, place one sealed bid within a budget the user approved,
read its result, claim, and check a sale's enclave attestation. It runs on your
machine and uses the web app's own code: the NEAR client, the bid sealing
(`src/lib/crypto.ts`), the relayer client and the attestation checks
(`src/lib/near/attestation.ts`, `src/lib/bid-inclusion.ts`). Before it sends a
bid it runs the same checks as `live-bot bid` (`scripts/live-bot/bot.ts`).

```text
pnpm --silent --filter web mcp
```

`--silent` stops pnpm from printing anything to stdout, which carries the
protocol. The server itself writes only protocol messages to stdout; its log
lines go to stderr.

## Tools

Amounts are whole quote-token units (USDC, for example) written as decimals,
such as `"0.02"`, not base units. Every tool returns one JSON text block. A
refusal or failure has `isError` set and returns
`{ ok: false, error: { code, message, ... } }`. When the server refused before
anything was signed or sent, the error includes `nothingSent: true`.

| Tool | Needs a key | What it does |
| --- | --- | --- |
| `sealround_list_sales` | no | The contract's sales, newest first: phase, bid window, floor price, bid count, total deposits. `phase` filters (`all`, `upcoming`, `open`, `closing`, `settled`, `failed`, `final`); `limit` defaults to 50. |
| `sealround_get_sale` | no | One sale's rules (floor and max price, deposit limits, supply, liquidity terms), phase and timing by the chain clock, public totals, the enclave's sealer hash and sale key, and the frozen bid-set hash once the sale has closed. Nothing sealed. With an account configured it also returns that account's quote-token balance and its public bid. |
| `sealround_place_bid` | yes | Places one sealed bid from the configured account. Inputs: `sale_id`, `max_price` (per whole sale token), `max_spend`, `max_deposit` (required cap), optional `deposit` (default `max_spend`), optional `direct`. Returns the transaction hash, the bid's index, who paid the gas, the public deposit and the path of the bid secret file. It never returns the max price, max spend, salt or ciphertext. |
| `sealround_my_bid` | no | The configured account's bid: its public record (index, deposit, time, claimed), the status of the local bid secret file, and once the sale is settled or failed, its fill and what it can claim. |
| `sealround_get_result` | no | Once the sale is settled: clearing price, tokens sold, raise, valid and invalid bids, whether every winner paid the clearing price, the contract's checks, launch liquidity, and the fill and claimable amounts for `account` (default: the configured account). Use `include_fills` to list every bid's fill. Use `wait_seconds` (at most 300) to poll every 3 s until the sale is final. Before then it returns `final: false` and the phase. |
| `sealround_claim` | yes | Claims the configured account's tokens and refund once the sale is settled or failed. Zero deposit. Returns tokens, refund, what arrived, the transaction hash and who paid the gas. Refuses a claim already made, an account with no bid and a sale that is not settled yet. While the launch pool is seeding, a claim pays the refund only and the tokens follow once the pool is seeded. |
| `sealround_verify_sale` | no | The same checks as `pnpm --filter web verify-sale`. For each enclave run (the sale key and the clearing) it finds the transaction, fetches OutLayer's attestation and checks eight things: build, executed, input, output, task, measurements, request and key. It then recomputes the frozen bid-set hash from every listed bid. The result gives `pass`, `fail` or `not_run` for each check, with the evidence, plus a verdict of `pass`, `fail` or `incomplete`. `ok` is true only for `pass`. The signature chain up to Intel is not checked here; the result links OutLayer's verifier for that step. |

Each tool carries MCP annotations. The five reads are `readOnlyHint: true`.
`place_bid` is not idempotent, and `claim` is idempotent.

Error codes an agent can act on:

| Code | Meaning |
| --- | --- |
| `over_budget` | The deposit is above `max_deposit`. |
| `invalid_terms` | The bid would be void, for example a max price below the floor or a max spend too small to buy one token. |
| `sale_closed` | The sale is not open for bids. |
| `already_bid` | The account already has a bid in this sale. |
| `insufficient_usdc` | The account holds less quote token than the deposit. |
| `not_sponsored` | The relayer will not pay for this call, or no relayer is set. Pass `direct: true` only if the user agrees to pay NEAR gas. |
| `missing_key`, `bad_key`, `key_mismatch` | No usable key, or the key is not a full-access key of the account. |
| `account_not_found`, `contract_not_found`, `sale_not_found` | That account, contract or sale does not exist on this network. |
| `mainnet_not_confirmed` | A write on mainnet without `SEALROUND_ALLOW_MAINNET=1`. |
| `wrong_network` | The RPC's chain id does not match `SEALROUND_NETWORK`. |
| `config` | A setting is missing or contradicts another; the message names it. |
| `not_settled` | The sale is not final yet. |
| `already_claimed` | The account has already claimed. |
| `no_bid` | The account has no bid in this sale. |
| `bid_failed` | The send failed. Check `maybeSubmitted` and `txHash`, then call `sealround_my_bid` before you retry. |

## Settings

The server reads its settings from the environment only. A key never goes in
a tool argument.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SEALROUND_NETWORK` | yes | `sandbox`, `testnet` or `mainnet` |
| `SEALROUND_CONTRACT` | yes | The Sealround contract account |
| `SEALROUND_RPC_URL` | no | NEAR RPC. Defaults to the network's public RPC, or `http://127.0.0.1:3030` on a sandbox |
| `SEALROUND_RELAYER_URL` | no | The gas relayer. Without it, both writes need `direct: true` |
| `SEALROUND_ACCOUNT` | for writes and "my" reads | The account that bids and claims. Defaults to the key file's `account_id` |
| `SEALROUND_PRIVATE_KEY` | for writes | The account's full-access key, `ed25519:...` |
| `SEALROUND_KEY_FILE` | for writes | Path to a near-cli credentials JSON file, instead of `SEALROUND_PRIVATE_KEY` |
| `SEALROUND_ALLOW_MAINNET` | no | `1` allows `place_bid` and `claim` on mainnet |
| `SEALROUND_SECRET_DIR` | no | Where bid secret files go. Defaults to `apps/web/scripts/mcp/.run/bid-secrets`, which git ignores |

The read tools work with only the network and the contract set. When the
settings are wrong, the server still starts, and every tool call returns a
`config` error that names the problem.

## Add it to a client

Claude Code, from the repository root. Point it at a key file rather than
putting the key on the command line:

```text
claude mcp add sealround \
  --env SEALROUND_NETWORK=sandbox \
  --env SEALROUND_CONTRACT=fairground.test.near \
  --env SEALROUND_RPC_URL=http://127.0.0.1:3030 \
  --env SEALROUND_RELAYER_URL=http://127.0.0.1:8790 \
  --env SEALROUND_KEY_FILE=/path/to/agent.test.near.json \
  -- pnpm --silent --filter web mcp
```

Claude Desktop (`claude_desktop_config.json`). It runs tsx from the web app's
dependencies, so it needs no shell and no working directory. Replace `<repo>`
with the absolute path of the checkout:

```json
{
  "mcpServers": {
    "sealround": {
      "command": "node",
      "args": [
        "<repo>/apps/web/node_modules/tsx/dist/cli.mjs",
        "<repo>/apps/web/scripts/mcp/server.ts"
      ],
      "env": {
        "SEALROUND_NETWORK": "testnet",
        "SEALROUND_CONTRACT": "fairground.itzbeast.testnet"
      }
    }
  }
}
```

This example is read-only. Add `SEALROUND_ACCOUNT`, `SEALROUND_KEY_FILE` and
`SEALROUND_RELAYER_URL` to let the agent bid and claim.

## Safety rules

These match `live-bot bid`.

- **Budget.** `place_bid` requires `max_deposit`. It refuses a deposit above
  that cap twice: once on the decimal you passed, before any network call,
  and again in base units after it reads the token's decimals.
- **Nothing sent on a refusal.** Before it signs, `place_bid` checks
  everything it can: that the bid terms are valid, the sale is an open TEE
  sale, the deposit is within the sale's minimum and maximum, the account has
  no bid yet, the account holds enough quote token, and the relayer will
  sponsor the call.
- **Network.** The server checks the RPC's chain id against
  `SEALROUND_NETWORK`, and refuses a sandbox setting that points at a public
  chain. It also checks that the contract exists and answers `get_config`.
- **Mainnet.** `place_bid` and `claim` are refused on mainnet unless
  `SEALROUND_ALLOW_MAINNET=1`. Reads are allowed.
- **Key.** The key comes only from `SEALROUND_PRIVATE_KEY` or
  `SEALROUND_KEY_FILE`, never both. It must be a full-access key of the
  account, which the server checks on chain before signing. The server keeps
  the key in a private field, never logs or returns it, and removes any copy
  of it from every tool result before the result leaves the process.
- **Gas.** Both writes go through the relayer and cost the account no NEAR. If
  the relayer will not sponsor a call, the tool refuses it unless
  `direct: true` is passed, in which case the account signs and pays the gas.
  A relayer failure never falls back to a paid call.
- **Bid secret file.** Before it sends a bid, `place_bid` writes the bid's
  max price, max spend, salt, the sale key and the ciphertext's sha256 to
  `<SEALROUND_SECRET_DIR>/<network>/<contract>/<sale>/<account>.json` with
  mode 600. The file's status starts as `sending` and changes to `placed`,
  `not_placed` or `unknown`. Keep the file private. It is the only record of
  the sealed terms outside the enclave.
- **After an unclear send.** When a send fails with `maybeSubmitted`, call
  `sealround_my_bid` before you retry. The contract accepts only one bid per
  account.
- **Scope.** The tools bid only in TEE sales. Commit-reveal sales need a reveal
  step, which the server does not do; use the live bot or the app for them.

The server's instructions to the agent ask it never to bid without the user's
approval of `max_price`, `max_spend` and `max_deposit`, and to use
`direct: true` only when the user agreed to pay gas. The checks above hold
either way.

## Test

```text
pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts --offline
pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts
```

Each test starts the server as its own process with the MCP SDK's client, in
the same way an MCP client starts it.

The offline test covers the handshake, the tool list and every refusal that
must happen before any network call. It needs nothing running.

The full test also runs the sandbox end-to-end world (`scripts/e2e`). It needs
Docker, because the sandbox node runs in the `near-sandbox-web` container. It
also starts the real contract, OutLayer's contract with the stand-in worker,
and the relayer on port 8790. In that world it:

- lists and reads sales.
- checks that refusals change no nonce and no balance.
- places a relayed bid and a direct bid.
- has people bid through the web client.
- closes and clears the sale, then checks `get_result` and `my_bid` against the
  reference clearing in `@fairground/clearing` to the base unit.
- runs `verify_sale` (a sandbox has no OutLayer attestation service, so both
  runs report `no_service`, and the bid set must match).
- claims the fill gasless.
- checks that the key appears in no output or log.

Logs go to `scripts/mcp/.run/sandbox-test/`.
