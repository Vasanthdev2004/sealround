# @fairground/relayer-client

The app's side of the Sealround gas relayer (`apps/relayer`). It builds the
Sealround calls, has a wallet or an in-memory key sign them as NEP-366
delegates, and submits them to the relayer. When the relayer cannot pay, it
falls back to a normal transaction the user pays for, and the result says so.

It runs in the browser and in Node: the only dependency is near-api-js, and
the library is type-checked with no Node types. ESM, `sideEffects: false`.

## Use in apps/web

```ts
import { NearConnector } from "@hot-labs/near-connect";
import { bidAction, bidOutcome, createRelayerClient, submitAction, walletSigner } from "@fairground/relayer-client";

const relayer = createRelayerClient({ url: process.env.NEXT_PUBLIC_RELAYER_URL! });
const wallet = await connector.wallet(); // NEAR Connect 0.12; the client depends only on its shape
const signer = walletSigner(wallet, { signerId: accountId });

// A sealed bid names its bidder: the account that signs it, as sealed inside the box.
const result = await submitAction(bidAction(USDC, FAIRGROUND, saleId, depositUsdc, { ciphertext, bidder: accountId }), {
  signer,
  relayer,
  fairgroundContract: FAIRGROUND,
  onPaidFallback: (reason) => notify(`Gasless relay unavailable (${reason}): your wallet will ask you to pay the gas.`),
});
// result.paidBy is "relayer" or "user"; result.status is "succeeded" | "failed" | "pending".
const outcome = bidOutcome(result.events); // { kind: "placed" } | { kind: "rejected", reason } | { kind: "unknown" }
```

`succeeded` does not mean the bid was accepted: Sealround refunds a refused bid
(below the minimum, sale full, already bid, ...) without failing, so read
`bidOutcome`. Events count only from Sealround receipts that succeeded: a
receipt that fails keeps its logs while its state change is undone. `pending`
means the transaction is in a block but its outcome was not known in time (the
relayer waited `RELAY_WAIT_MS`); check `get_bid`, or the transaction
`result.txHash` whose sender is the policy's `relayer_account_id`.

The other calls work the same way:

| Builder | Call | Gas | Deposit | Who may sign |
| --- | --- | --- | --- | --- |
| `bidAction(usdc, fairground, saleId, amount, { ciphertext, bidder } \| { commitment })` | USDC `ft_transfer_call` | 100 TGas | 1 yocto (the relayer pays it) | the bidder, full-access key |
| `claimAction(fairground, saleId, bidder?)` | `claim` | 100 TGas | 0 | anyone; funds go to `bidder` |
| `claimProceedsAction(fairground, saleId)` | `claim_proceeds` | 150 TGas | 0 | anyone; funds go to the creator |
| `revealAction(fairground, saleId, { maxPrice, maxSpend, salt })` | `reveal_bid` | 30 TGas | 0 | the bidder |
| `clearOnchainAction(fairground, saleId)` | `clear_onchain` | 150 TGas | 0 | anyone, once the reveal window has ended |
| `triggerRefundModeAction(fairground, saleId)` | `trigger_refund_mode` | 30 TGas | 0 | anyone |

`clearOnchainAction` settles or fails a commit-reveal sale once its reveal
window is over (status `revealing`, chain time at or past `reveal_end`).
Unrevealed bids, and revealed bids that break a bid rule, pay the 1 % invalid-bid
penalty. Only the first call for a sale succeeds; the relayer refuses the rest
with `wrong_phase`. Its gas follows the revealed prices: with 500 revealed
bids the transaction burns 51.2 TGas for a usual book and 102.8 TGas when every
max price is `u128::MAX`, the longest search measured and not proven to be the
limit (contracts/GAS.md, "Clearing on chain"). The builder attaches 150 TGas,
which leaves 47 TGas over that and is exactly the relayer's default
`MAX_GAS_TGAS`: a relayer run with a lower cap refuses it with `gas_too_high`
(as it would `claimProceedsAction`, also 150). Unused gas is refunded.

Builders check their inputs against the contract's rules (sale id, u128
amounts, sealed-bid length, 64-hex commitment, 32-hex salt) and throw a
`RangeError` before anything is signed. Payable calls (`create_sale`,
`close_sale` with or without `get_close_deposit`, `retry_setup`) are not
relayed: send them with the wallet directly.

### Sealed bids have one exact length

A TEE sale takes a sealed bid only if its ciphertext decodes to exactly
`sealedBidLength(saleId, bidder)` bytes: 224 plus the byte lengths of the sale
id and of the bidder's account id (242 for `fairt` and `alice.testnet`, at most
320). That is the canonical bid JSON with `max_price` and `max_spend`
zero-padded to 39 digits (176 bytes plus the two ids) inside a sealed box (48
more), so no bid's length shows how many digits its amounts have. The formula
is `fairground_clearing::sealed_bid_len` (crates/clearing/src/sealed_bid.rs),
and `test/sealed-bid.test.ts` checks it against every row of
crates/sealer/tests/fixtures/canonical_bids.json.

`bidAction` therefore needs the `bidder` next to the `ciphertext`: the account
that will sign the transfer, which must be the bidder sealed inside the box. It
throws a `RangeError` for canonical base64 of any other length, before a wallet
is asked to sign. `bidder` is only checked, never sent. The relayer applies the
same rule to the delegate's sender and refuses with `wrong_ciphertext_length`;
the contract refunds such a bid with a `bid_rejected` event of the same reason.
An app that still seals unpadded amounts gets this error on every sealed bid.

Before a new user's first funding, `await relayer.sponsorStorage(accountId)`
registers them on USDC at the relayer's cost (a no-op when already registered).

## Bots, judge mode, scripts

```ts
import { JsonRpcProvider, KeyPair } from "near-api-js";
import { keyPairSigner } from "@fairground/relayer-client";

const signer = keyPairSigner({ accountId, keyPair: KeyPair.fromString(secret), provider: new JsonRpcProvider({ url }) });
```

It reads the key's nonce and the head from the RPC, never reuses a nonce for
delegates signed before the last one lands, and makes delegates valid for 200
blocks (`validityBlocks`). Its paid fallback is the key's own transaction.

## When it falls back, and when it throws

`submitAction` pays with the user's wallet only when that cannot double a
relayed call:

- the wallet cannot sign delegates (`manifest.features.signDelegateActions`
  is not set: MyNearWallet, OKX, Nightly, ...): `fallbackReason: "delegates_unsupported"`;
- the relayer refused with `rate_limited`, `budget_exhausted` or `relay_failed`.
  It refuses before sending anything.

Everything else is thrown as a `RelayerError` with `reason` (the relayer's code,
or `timeout` / `network_error` / `bad_response`), `status`, `requestId` and
`maybeSubmitted`. When `maybeSubmitted` is true (no answer, an unreadable one,
or `internal_error`), the call may still land: check the chain before offering
to send it again. A refusal of the call itself (`wrong_deposit`, `expired`,
`nonce_already_used`, `needs_full_access_key`, ...) would not be fixed by
paying, and `sender_busy` means the user's previous call is still landing.
`wrong_ciphertext_length` is one of these: the sealed bid is not the length the
contract takes for this sale and sender (see above), so the contract would
refund it however it is sent. `bidAction` catches it first unless `bidder` is
not the account that signs.

The relayer also reads the contract state before paying and refuses a call
that would fail now, with a code the UI can show: `unknown_sale`, `wrong_phase`
(sale not open for a bid, not final for a claim, outside the reveal window,
reveal window still open or sale already cleared for `clear_onchain`,
refund mode not yet open), `wrong_quote_token`, `wrong_payload` (a sealed bid
on a commit-reveal sale or the reverse), `insufficient_balance`, `no_bid`,
`already_claimed`, `already_revealed`. A paid transaction would fail the same
way, so these are thrown too.

`relay` and `sponsorStorage` are never retried; `getPolicy` is retried twice
on network errors and 5xx answers.

## Tests

```powershell
pnpm --filter @fairground/relayer-client typecheck     # library as browser code, then tests
pnpm --filter @fairground/relayer-client test          # unit tests + the real relayer app in process
pnpm --filter @fairground/relayer-client test:sandbox  # end to end on a fresh local chain
```

`test:sandbox` starts the relayer's sandbox (`apps/relayer/scripts/sandbox.ps1`:
container `near-sandbox-relayer`, RPC on 127.0.0.1:3040), deploys
`contracts/res/fairground.wasm` and `mock_ft.wasm` as USDC, runs the relayer in
process, takes a commit-reveal sale through bid, paid fallback, refused bid,
reveal, `clear_onchain` (refused while the reveal window is open, relayed once
it has ended, refused again once the sale is settled), claim, claim_proceeds,
the penalised refund of an unrevealed bid, and a second sale through refund
mode, then removes the container.

The stand-in NEAR Connect wallet in the tests (`test/helpers.ts`) does not sign
through near-api-js: it writes the NEP-366 borsh by hand and signs with
node:crypto, as a wallet's own code would. The relayer decodes those bytes, and
a unit test checks that `keyPairSigner` produces them byte for byte.
