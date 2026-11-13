# Live sniper bot

A command-line bot that bids on a real Sealround sale the way a sniper would,
for the spec's "Bot Arena", demo video and definition of done. It proves on
chain that:

1. **A bot that bids in the first block of a sale gains nothing.** `snipe`
   waits for the sale to open and places its sealed bid the moment the chain
   clock reaches `bid_start`, then prints the transaction and the second it
   landed in. After settlement, `report` shows the bot paid exactly the
   clearing price, to the smallest unit, by the same rule as every other
   winner: `spent = ceil(tokens x clearing price / 10^decimals)`.
2. **A copycat is rejected.** `copycat` reads another bidder's sealed bid
   from the chain and submits the same bytes from the bot's account. A sealed
   bid names its bidder inside the encryption, and its length depends on the
   bidder's account id, so:
   - from an account id of a **different length**, the contract refuses it on
     the spot (`bid_rejected`, reason `wrong_ciphertext_length`) and returns
     the deposit. The app and the relayer refuse it first; the bot sends it
     as its own transaction anyway to show the contract's refusal;
   - from an account id of the **same length**, the contract accepts the
     bytes (it cannot read them), and the enclave finds that the plaintext
     names the victim: the bid is void, wins nothing and pays the 1 % invalid
     bid penalty. `report` for the copycat account shows it;
   - in a commit-reveal sale a copied commitment can never be revealed (it
     binds the victim's account id), so it is void with the same penalty.

The bot runs the web app's own NEAR code (`src/lib/client/near.ts`, the bid
sealing in `src/lib/crypto.ts`, the relayer client's signer), not a copy of
it, so it bids exactly as the app does: gasless through the relayer, or paid
by the bot with `--direct`.

## Commands

```
pnpm --filter web live-bot <command> [options]        (from the repo root)
```

| Command | What it does | Needs the key |
| --- | --- | --- |
| `status` | The sale, the bot account, the relayer. Sends nothing. Run it before the sale opens. | no |
| `bid` | Places one sealed bid in an open TEE sale. Requires an explicit `--budget` covering the deposit, plus a relayer or `--direct`. | yes |
| `result` | Reads the bidder's fill and clearing price after settlement or refund. `--wait` waits for a final result. | no |
| `snipe` | Seals the bid and saves a receipt, waits for the open, bids in the first block it can, prints the tx hash, the bid's index and the second it landed in. | yes |
| `copycat` | Replays `--victim`'s sealed bid (or commitment) from the bot account and shows it rejected. Waits for the sale to open and for the victim's bid. | yes |
| `report` | After settlement: the bot's fill against the clearing price, every bid of the sale, and the checks. `--claim` also claims the bot's tokens and refund; `--wait` waits for the settlement. | only with `--claim` |
| `reveal` | Commit-reveal sales only: reveals the bot's bid with the salt from its snipe receipt. `--wait` waits for the close. | yes |

`pnpm --filter web live-bot --help` lists every option. Each option can also
be set with an environment variable (`LIVE_BOT_NETWORK`, `LIVE_BOT_CONTRACT`,
`LIVE_BOT_SALE`, `LIVE_BOT_ACCOUNT`, `LIVE_BOT_RELAYER_URL`, ...).

For the agent workflow and examples, see [the Sealround bidding skill](../../../../skills/sealround-bid/SKILL.md).

Amounts are in USDC: `--deposit 5`, `--max-spend 2`, and `--max-price 0.02`
(USDC per whole token). `report` prints them in base units too.

Output is a readable summary; `--json` prints one JSON object on stdout
instead (progress goes to stderr). Exit code 0 on success, 1 when a command
failed on the way or a `report` check failed, 2 when it refused before
sending anything: bad options, wrong network, missing or wrong key, unknown
sale, sale already closed, second bid, sale not settled yet.

## The key

The bot needs a **full-access** key of its account (a bid is an
`ft_transfer_call` with 1 yoctoNEAR attached). It is never a command-line
flag, which would be saved in your shell history; the bot refuses `--key`
and similar flags. Give it one of two ways:

- `--key-file <path>`: a near-cli credentials file, for example
  `~/.near-credentials/testnet/<bot>.testnet.json`. The account id is read
  from it too.
- `LIVE_BOT_PRIVATE_KEY` in the environment, typed at a prompt so it is not
  in the history:

  ```powershell
  # PowerShell 7
  $env:LIVE_BOT_PRIVATE_KEY = Read-Host -MaskInput "bot key (ed25519:...)"
  # ... run the bot ...
  Remove-Item Env:LIVE_BOT_PRIVATE_KEY
  ```

  ```bash
  read -rs LIVE_BOT_PRIVATE_KEY && export LIVE_BOT_PRIVATE_KEY
  # ... run the bot ...
  unset LIVE_BOT_PRIVATE_KEY
  ```

The key stays in the bot's process and is never printed. Before it signs
anything the bot checks that the key is a full-access key of `--account` on
the network named, and that the RPC serves that network (`chain_id`).

Receipts go to `scripts/live-bot/.run/receipts/` (git-ignored, or
`--receipt-dir`). A snipe receipt holds the bid's max price, max spend and
salt: keep it private until the sale has closed, and keep it until a
commit-reveal bid is revealed.

## On testnet (the owner runs this)

Before the sale: the bot account and a copycat account exist on testnet,
hold NEAR for gas and test USDC of the sale's quote token (the app's faucet,
or `usdc.fakes.testnet`'s `mint`), and the relayer is up.

```powershell
# This shell's settings (placeholders in <>)
$env:LIVE_BOT_NETWORK     = "testnet"
$env:LIVE_BOT_CONTRACT    = "<fairground>.testnet"
$env:LIVE_BOT_SALE        = "<sale-id>"
$env:LIVE_BOT_RELAYER_URL = "https://<relayer-host>"
$key = "$HOME\.near-credentials\testnet"

# 1. Check everything; sends nothing
pnpm --filter web live-bot status --key-file "$key\<bot>.testnet.json"

# 2. Snipe: start it any time before the open; it waits, then bids in the first block
pnpm --filter web live-bot snipe --key-file "$key\<bot>.testnet.json" --deposit 5 --max-price 0.02 --max-spend 2

# 3. Copycat, from a second account, once <someone>.testnet has bid.
#    Same account id length as the victim: accepted, then voided by the enclave.
#    Another length: refused by the contract at once, deposit returned.
pnpm --filter web live-bot copycat --key-file "$key\<copycat>.testnet.json" --victim <someone>.testnet

# 4. After the bid window, anyone closes the sale (the sale page's Close button) and the enclave clears it.
pnpm --filter web live-bot report --key-file "$key\<bot>.testnet.json" --wait --claim
pnpm --filter web live-bot report --account <copycat>.testnet
```

`--rpc <url>` picks another RPC than `https://rpc.testnet.near.org`.
Without `LIVE_BOT_RELAYER_URL` (or with `--direct`) the bot signs and pays
for its own transactions, which skips the relayer's round trip.

**Mainnet** works the same with `--network mainnet` (or
`LIVE_BOT_NETWORK=mainnet`) and `--yes-mainnet`, which the bot requires before
it does anything there. It uses real USDC and NEAR.

What "first block" means: the bot polls the head block every `--poll-ms`
(200 by default) and sends the bid as soon as a block's timestamp reaches
`bid_start`, the clock the contract checks. The bid lands a few blocks later:
the relayer's round trip, then the transaction and the USDC transfer's
receipts (0.8 s and 6 blocks on the local sandbox, whose blocks are about
0.13 s). `snipe` prints the exact delay in milliseconds, the second of the
sale it landed in, and the block numbers. A bid sent before the open
would be refused (`not_open`), so the bot never fires early; if a lagging
RPC node or the relayer still sees the sale closed, it sends again at once.

## Sandbox test

```
pnpm --filter web exec tsx scripts/live-bot/sandbox-test.ts
```

It builds the sandbox end-to-end harness's world (`scripts/e2e`: a local
chain in Docker, the real contract, OutLayer's contract with the pinned
enclave job, the relayer), then runs the bot's CLI against it as separate
processes with the key in `LIVE_BOT_PRIVATE_KEY`: a sealed-bid sale with a
snipe at the open, three later bidders, two copycats (one voided by the
enclave, one refused by the contract), the close, the enclave's clearing and
`report --claim`, checked against the reference clearing of
`@fairground/clearing`; then a commit-reveal sale with a snipe, a copied
commitment, `reveal`, `clear_onchain` and `report`; and the bot's refusals
(wrong network, mainnet without `--yes-mainnet`, missing or wrong key,
unknown sale, second bid, early report, closed sale, a key passed as a flag).

It needs what `pnpm --filter web e2e:sandbox` needs (Docker running, the
built wasm in `contracts/res` and `enclave/res`, the sandbox binary in
`.sandbox-bin`, Node 24), uses the same container name and ports, and so
refuses to start while that run is going. It always removes its container and
stops its relayer. Logs and receipts: `scripts/live-bot/.run/sandbox-test/`.
It never touches a public network.

## Files

| File | What |
| --- | --- |
| `run.ts` | The CLI: options, environment, the key, output. |
| `bot.ts` | The commands: network and key checks, snipe, copycat, report, reveal, status. |
| `render.ts` | The readable output. |
| `sandbox-test.ts` | The end-to-end test on a local chain. |
