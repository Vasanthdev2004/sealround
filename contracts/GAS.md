# Sealround: measured gas, storage and costs

Measured on 10 Nov 2026 on a local nearcore 2.14.0 sandbox (protocol 88 fees)
with the contracts in `contracts/res`, OutLayer's own contract
(`outlayer_contract.wasm`) and the test playing the OutLayer worker. Reproduce
with:

```
powershell -ExecutionPolicy Bypass -File scripts\test-contracts.ps1 -Gas
```

or only the calibration, against a running sandbox (`scripts\sandbox.ps1`):

```
cargo test --manifest-path contracts\tests\Cargo.toml --test sandbox -- --ignored --test-threads=1 --nocapture gas::
```

Every TEE bid in the calibration is a worst case: a 64-character bidder id in
a sale with a 32-character id, so its sealed box (a real one, made by
`fairground_sealer::seal_bid`) is the longest the contract accepts, 320
bytes, and a 21-digit deposit, in a sale whose supply is near `u128::MAX`, so
the fills carry 36-digit token amounts. All bids are valid and the sale
settles with winners and losers. Gas is in TGas, burnt gas as reported per
receipt.

Until 10 Nov 2026 a TEE ciphertext could be any 1 to 512 bytes and the
calibration used 512-byte boxes. A sealed bid now has exactly one length,
`224 + len(sale_id) + len(bidder)` bytes (at most 320), so the largest
clearing input fell from 390,304 to 262,330 bytes and every figure that
depends on it fell with it. "What the measurements changed" at the end still
quotes the 512-byte figures where it tells the history.

## Closing a TEE sale

`close_sale` with `get_close_deposit` attached and exactly the prepaid gas
its own check asks for (the calibration asserts that this is at most 300 TGas
and that the sale then settles); the worker answers with the sealer's real
output.

| Bids | Input bytes | Output bytes | Close deposit | close_sale receipt | request_execution | OutLayer callback | on_clearing_result | Whole tx | Gas check asks | Real need |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 52,730 | 6,806 | 0.214 NEAR | 19.2 | 7.0 | 5.2 | 4.7 | 37.3 | 127 | 116 |
| 300 | 157,530 | 20,105 | 1.262 NEAR | 50.9 | 14.4 | 9.8 | 8.8 | 85.1 | 170 | 158 |
| 500 | 262,330 | 30,795 | 2.310 NEAR | 82.5 | 22.0 | 14.2 | 12.3 | 132.2 | 213 | 200 |

- *Gas check asks*: the prepaid gas `close_sale` requires (its own check,
  read from the `NotEnoughGas` error of a call with too little gas). A close
  attaching exactly that much settles at every size.
- *Real need*: the close receipt's burnt gas, plus the static gas it attaches
  (`outlayer_request_gas(input)` + `ON_CLEARING_RESULT_GAS`: 94.5, 104.9 and
  115.4 TGas), plus the execution fees of the two receipts it sends, which
  the sender prepays and which are charged as used, not burnt: 2 x (0.78
  function call + 0.108 receipt) + 0.036 data dependency + 2.24 MGas per
  argument byte, so 1.9, 2.2 and 2.4 TGas. Above it, every unused TGas goes
  to OutLayer (weight 1).
- 500 bids fit a 300 TGas transaction with 87 TGas to spare over what the
  check asks and 100 TGas over the real need, so `MAX_BIDS_PER_SALE` stays 500.
- The close receipt at 500 bids. Its parts were measured with temporary gas
  logs when the input was 390 KB: building the input 55.6 (500 storage reads
  and base64; about 0.11 TGas per bid), hashing it (`input_sha256`) 10.9,
  writing the request arguments 11.2, sending them 23.3, in all 100.9. The
  last three follow the input's size, so at 262 KB they come to about 7, 8
  and 14; the rest of the 82.5 now measured, about 53, is building the input
  (the same 500 storage reads, less base64). The split was not measured
  again. Sending costs 53.72 MGas per argument byte, which is the protocol's
  fees for a function call to another account: 47.68 send
  (`action_function_call_per_byte.send_not_sir`) + 2.24 execution + 3.80 to
  read the bytes out of wasm memory (`read_memory_byte`). The gas check's
  `REQUEST_SEND_GAS_PER_BYTE` is derived from these three fees plus 12 %
  (60.17 MGas), so it must follow them if a protocol upgrade changes them.
- OutLayer's `request_execution` burns 22.0 of the 85.4 TGas it is given and
  reserves 55.7 TGas (50 + 25 MGas per byte above 32 KB) for its callback,
  which burns 14.2. The worker's own transaction (not the closer's) burns 11.9,
  27.3 and 42.2 TGas.
- The closer paid 0.0047, 0.0094 and 0.0142 NEAR: gas at the sandbox's gas
  price plus OutLayer's charge for the reported run (base 0.001 NEAR + 0.0001
  NEAR per second + 1e-10 NEAR per million instructions; 0.00101 NEAR for the
  100 ms and 1M instructions the test reports). The rest of the deposit,
  including the part held for the input above 32 KB, comes back to the
  closer in the same transaction (the integration tests check this to the
  yoctoNEAR on every OutLayer path).

## Clearing on chain (commit-reveal)

`clear_onchain` reads every bid, clears with the fast price search
(`fairground_clearing::clear`) and stores the fills, all in one receipt with
no promises. Its gas depends on the revealed prices: the search halves the
range from the floor to the highest revealed max price, and each step adds up
the demand of every bid whose max price reaches the step's price.

| 500 revealed bids, all valid | Whole tx | `clear_onchain` receipt |
| --- | ---: | ---: |
| Usual book (max prices 100 to 999, floor 1: about 10 steps) | 51.2 | 50.9 |
| Longest search (every max price `u128::MAX`: 128 steps, every bid in each) | 102.8 | 102.5 |

- The second row was built to be the worst case under the contract's
  limits: 500 bids, 128 steps, no bid skipped, and products of about 10^38,
  close to the 2^128 that `max_deposit x 10^decimals` must stay under (so
  the 256-bit path is never taken). That it is the true maximum is not
  proven. A step only visits the bids whose max price reaches it, so a few
  bids with very high max prices should add little (not measured); it takes
  most of the book bidding near `u128::MAX` to get near the second row.
- Both runs attached 120 TGas and settled: the calibration asserts it, so 120
  is the least a caller may rely on. The relayer client attaches 150 TGas, the
  relayer's `MAX_GAS_TGAS`, which leaves 47.5 TGas over the longest search
  measured (unused gas is refunded). A call that runs out changes nothing and
  can be sent again with up to 300 TGas by anyone.
- The enclave does not use this search: it uses the fixed-shape one
  (`PriceSearch::FixedShape`, always 128 steps over every bid), so its
  instruction count does not depend on the prices.

## Relayed calls

What `@fairground/relayer-client` attaches (`GAS` in
`packages/relayer-client/src/actions.ts`), against what the calls burn. The
relayer refuses a call that attaches more than `MAX_GAS_TGAS` (150).

| Call | Attached | Whole tx burns | Notes |
| --- | ---: | ---: | --- |
| bid: `ft_transfer_call` on the quote token | 100 | 7.4-8.5 | the token keeps about 30 for itself and its resolve |
| `claim` | 100 | 8.8-13.4 | hands up to 40 TGas of static gas to its promises |
| `claim_proceeds` | 150 | 10.5-10.6, plus 2-4 per extra part | hands up to 60 TGas of static gas to its promises |
| `clear_onchain` | 150 | 51.2 usual, 102.8 worst case measured | no promises |
| `reveal_bid` | 30 | 2.6 | no promises |
| `trigger_refund_mode` | 30 | not measured here | no promises; the integration tests pass with 10 |

## Other calls

| Call | Whole tx | Notes |
| --- | ---: | --- |
| `create_sale`, TEE | 45.5 | Sealround 14.7, token account (create, deploy 167 KB, `new`) 20.2, sealer `pubkey` request 3.5, callbacks 4.0, USDC registration 1.5. The gas check asks about 160 TGas prepaid. |
| `create_sale`, commit-reveal | 40.6-41.1 | no OutLayer call (40.58 and 41.07 in this run) |
| TEE bid (`ft_transfer_call`) | 7.4-8.5 | `ft_on_transfer` 2.8-2.9 |
| commit-reveal bid | 7.5 | |
| `close_sale`, commit-reveal | 2.5 | |
| `reveal_bid` | 2.6 | |
| `clear_onchain`, 500 revealed bids | 51.2-102.8 | see "Clearing on chain" |
| `claim`, tokens and refund | 12.8-13.4 | registers the bidder on the token first; attach 100 TGas |
| `claim`, refund only | 8.8 | |
| `claim_proceeds`, raise and reserve | 10.5-10.6 | each extra part (allocation, burn) adds 2-4 TGas; attach 150 TGas |

## Storage (bytes, as NEAR counts it: key + value + 40 per record)

| What | Measured on chain | Charged for |
| --- | ---: | --- |
| TEE bid, worst case (320-byte ciphertext, 64-character bidder) | 585, plus a 32-byte fill at settlement and, if invalid, a 4-byte entry in the invalid-bid list = 621 | `BID_BYTES_TEE` 624 x 1.15 = 718 |
| First bid of a sale | +49 (the sale's deposits list) | in `SALE_BASE_BYTES` |
| Commit-reveal bid | 297 + 32 (reveal) + 32 (fill) + 4 (invalid-bid entry) = 365 | `BID_BYTES_COMMIT_REVEAL` 368 x 1.15 = 424 |
| Settlement | 32 per bid + 121 | fills in the per-bid bytes, the rest in `SALE_BASE_BYTES` |
| Sale at creation, 32-character sale id (first sale: with the 110-byte quote-token entry) | 886 | formula below, which also covers the largest stored result |
| Token account (37-byte token name) | 167,443 (code 167,069 + 374) | sent 167,690 bytes' worth |

The unit tests (`contracts/fairground/src/tests/costs.rs`) measure the same
sizes at their largest and agree to the byte; the gas calibration asserts
that a bid's on-chain storage plus its fill and invalid-bid entry fits the
`BID_BYTES_*` constants (read from costs.rs) and that the token account can
pay for its storage.

## Formulas

All storage at 1e19 yoctoNEAR per byte; "x 1.15" is `STORAGE_MARGIN_PERCENT`,
rounded up to whole bytes. Constants are in `contracts/fairground/src/costs.rs`.

`get_create_cost(params)`, which `create_sale` charges exactly:

```
sale storage   = (1040 + 2 * len(sale_id) + 64 + len(quote_token) + len(token account)
                  + len(name) + len(symbol) + len(icon) + len(description) + len(website)) x 1.15
token deploy   = (len(token wasm) 167,069 + 100 + 280 + 200 + len(name) + len(symbol) + len(icon)) bytes
bid reserve    = max_bids x (624 x 1.15 bytes + 0.00125 NEAR)        Tee:          0.00843 NEAR per slot
               = max_bids x (368 x 1.15 bytes + 0.00125 NEAR)        CommitReveal: 0.00549 NEAR per slot
creator        = 2 x 0.00125 NEAR       (registrations on the sale token and the quote token)
quote token    = 0.00125 NEAR + 112 x 1.15 bytes, only for the first sale on that token
sealer key     = 0.01401 NEAR (Tee only; OutLayer refunds what the pubkey run does not use)
```

Measured `create_sale` charges for the calibration sales (no icon, first
sale on the quote token; the TEE sales have a 32-character sale id and a
37-byte name, the commit-reveal one a 5-character id and a 10-byte name):

| Sale | Charged |
| --- | ---: |
| TEE, 100 bids | 2.5577 NEAR |
| TEE, 300 bids | 4.2437 NEAR |
| TEE, 500 bids | 5.9297 NEAR = 4.215 bid reserve + 1.6807 token + 0.0150 sale storage + 0.019 registrations and key deposit |
| commit-reveal, 500 bids | 4.4441 NEAR |

`claim_proceeds` returns the unused part (`get_reserve_refund`).

`get_close_deposit(sale_id)` (TEE, with bids):

```
close deposit = 0.01401 NEAR + max(0, input_bytes - 32,768) x 1e19
input_bytes  ~= 280 + sum over bids (len(bidder) + digits(deposit) + 4 x ceil(len(ciphertext) / 3) + 10)
len(ciphertext) = 224 + len(sale_id) + len(bidder)
```

The input passes 32,768 bytes at 62 bids of the longest kind, or at about
88 bids with 20-character bidder ids, a 5-character sale id and 8-digit
deposits (370 bytes each); below that the close deposit is 0.01401 NEAR.

OutLayer holds the input part and refunds it, and everything it does not
charge, to the closer.

`close_sale`'s gas check (TEE):

```
prepaid >= gas used so far (building and hashing the input, writing the arguments)
         + outlayer_request_gas(input) = 60 TGas + 75 MGas x input + 25 MGas x (input - 32,768)
         + ON_CLEARING_RESULT_GAS      = 30 TGas
         + request_send_gas(args)      = 60.17 MGas x argument bytes
                                         (send 47.68 + exec 2.24 + read_memory 3.80, + 12 %)
         + OWN_WORK_GAS                = 15 TGas
```

## What the measurements changed

- `close_sale` wrote the `request_execution` arguments with serde_json, whose
  string escaper cost 20.8 TGas for a 390 KB input; a hand-written writer
  (`outlayer::request_args`) costs 11.2. The input buffer is now sized for the
  largest bids, so it never grows by copying.
- The gas check left 15 TGas for the work after it, which measured 44 TGas at
  500 bids (writing and sending 394 KB of arguments). A caller attaching what
  the check asked (221 TGas) would have run out of gas. The arguments are now
  built before the check, which adds `request_send_gas`; it asks 245 TGas and
  the call needs 232 (229 burnt or attached, plus 2.7 of execution fees).
- `ON_CLEARING_RESULT_GAS` 40 to 30 TGas (measured 12.3; the largest possible
  output extrapolates to 16).
- `STORAGE_MARGIN_PERCENT` 20 to 15: the byte counts are exact.
- Per-bid check names are formatted only when stored (at most 8), so a result
  failing every check costs no more to reject than to accept.

Before these changes, 500 bids needed 249 TGas and the check asked 221; after
them they needed 232 and the check asked 245, and the calibration asserts
that a close attaching exactly what the check asks settles.

All of the above was measured when a ciphertext could be up to 512 bytes
(a 390 KB input at 500 bids). On 10 Nov 2026:

- A TEE bid must be exactly `224 + len(sale_id) + len(bidder)` bytes
  (`wrong_ciphertext_length` otherwise), so `MAX_CIPHERTEXT_BYTES` went from
  512 to 320 and `BID_BYTES_TEE` from 816 to 624: a TEE bid slot costs the
  creator 0.00843 NEAR instead of 0.01064, and a 500-slot TEE sale 5.93 NEAR
  instead of 7.03.
- The largest clearing input went from 390,304 to 262,330 bytes. At 500
  worst-case bids the close deposit is 2.310 NEAR instead of 3.589, the
  whole close burns 132 TGas instead of 162, it needs 200 instead of 232 and
  the check asks 213 instead of 245. No gas constant changed: the formulas
  follow the size of the input.
- `clear_onchain` is relayed, so its longest price search was measured for
  the first time: 102.5 TGas, twice the usual book (see "Clearing on chain").
- `bid_placed` is logged after the bid is written to storage (four explicit
  flushes instead of the writes at the end of the call). The bid's gas did
  not change: `ft_on_transfer` burns 2.8-2.9 TGas.
