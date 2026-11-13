# Sealround contracts: design

This is the source of truth for the Rust side: the clearing crate, the sealer
library, the per-sale token, the Sealround contract and the integration tests.
The product spec is `../Fairground — Project Requirements (NEAR HACKATHON).md`
(sections "Smart contract spec" and "Sealed-bid enclave"). Where this file and
the spec differ, this file wins, and the difference is listed under "Spec
deviations" at the end.

Facts below about OutLayer, near-sdk and the protocol were verified on
9 Nov 2026 against source, live RPC and a local sandbox (protocol 88,
nearcore 2.14.0, near-sdk 5.30.1).

## Layout

```
Cargo.toml                 workspace: crates/*, contracts/{fairground,token,mock-ft}
.cargo/config.toml         AWS_LC_SYS_PREBUILT_NASM=1 (near-sdk unit tests on Windows)
crates/clearing            fairground-clearing: pure Rust, no near-sdk. Clearing rule,
                           contract checks, bid-set hash, commitment hash, U256 math.
crates/sealer              fairground-sealer: pure Rust lib. What the OutLayer job does:
                           key derivation, sealed-box open, input/output JSON, clearing.
enclave/                   its own workspace: job (the WASI binary around the sealer lib),
                           tools, deploy scripts. enclave/res holds the pinned job wasm and
                           its sha256 (see "The pinned job").
contracts/token            fairground-token: NEP-141, fixed supply, burn-own-balance, no admin.
contracts/fairground       fairground: the sale contract (factory + sales + claims).
contracts/mock-ft          mock-ft: test-only NEP-141 with open mint (stands in for USDC).
contracts/res/             built wasm, committed: fairground.wasm, fairground_token.wasm,
                           mock_ft.wasm, outlayer_contract.wasm (vendored, Apache-2.0: see
                           res/NOTICE.md and res/LICENSE-APACHE-2.0).
contracts/tests            fairground-integration: near-workspaces tests. NOT a workspace
                           member (own Cargo.lock): its deps must not leak into unit builds.
contracts/GAS.md           measured gas, storage and NEAR costs, and the formulas behind them.
scripts/                   build-contracts.ps1, sandbox.ps1, test-contracts.ps1
```

Toolchain on Windows: rustc 1.97.1, `wasm32-unknown-unknown`, cargo-near 0.23.0.
Build each contract with `cargo near build non-reproducible-wasm --no-abi` (ABI
generation fails on MSVC, cargo-near#188). Never build wasm without
`--cfg near`. Build order: token, mock-ft, then fairground (it embeds the token
wasm with `include_bytes!`). Release profile: `opt-level = "z"`, `lto = true`,
`codegen-units = 1`, `panic = "abort"`, `overflow-checks = true`, `debug = false`.

### Reproducible build

`contracts/fairground/Cargo.toml` and `contracts/token/Cargo.toml` carry
`[package.metadata.near.reproducible_build]` (NEP-330, the schema of cargo-near
0.23): `image = "sourcescan/cargo-near:0.22.0-rust-1.97.1"`, its
`image_digest` (the digest identifies the image; the tag only describes it),
`passed_env = []` and `container_build_command = ["cargo", "near", "build",
"non-reproducible-wasm", "--locked", "--no-abi"]`, the same build as
`scripts/build-contracts.ps1` with the lockfile enforced. `mock-ft` is
test-only and has none.

A wasm built this way can be checked by anyone: the contract's
`contract_source_metadata` view names the commit, the image and the command,
and rebuilding gives the same sha256. `cargo near build reproducible-wasm`
builds a clone of the last commit inside the image, so it needs Docker, the
sources committed and pushed to the `repository` in the root Cargo.toml, and
the root `Cargo.lock` in that commit. Order, because the sale contract embeds
the token wasm: build the token reproducibly, copy
`target/near/fairground_token/fairground_token.wasm` to `contracts/res`,
commit, then build the sale contract from that commit. Run the integration
tests against the wasm you will deploy (`scripts/test-contracts.ps1
-SkipBuild` after copying it to `contracts/res`): a container build is not
byte-identical to a Windows build of the same sources. Not run yet: the
contract sources were not committed when this was written, so only the
metadata was checked against cargo-near's parser and validation rules.

Integration tests run natively on Windows against a sandbox node in Docker
(`scripts/sandbox.ps1`: container `fairground-sandbox`, image `debian:trixie-slim`,
sandbox 2.14.0 cached in `.sandbox-bin`, validator key copied to `.sandbox-home`;
glibc >= 2.39 is required). A running container is reused (it must match
`-Port` and `-Version`, or the script stops and says so); anything else gets a
fresh chain. A stopped chain is never restarted: the tests' `fast_forward`s
leave its block time hours ahead of the wall clock, and a restarted node adds
only a nanosecond per block until its own forwards catch up, which stalls
every test that waits for a window. `-Stop` removes the container, `-Reset`
replaces it. near-workspaces 0.24.0 with `default-features = false, features = ["rustls"]`,
env `NEAR_SANDBOX_BIN_PATH` set to any path (skips the download) and
`AWS_LC_SYS_PREBUILT_NASM=1`. Connect with
`near_workspaces::sandbox().rpc_addr(..).validator_key(ValidatorKey::HomeDir(..))`.
Chain state persists while the container runs, so every test uses fresh
unique accounts. The sandbox makes about 8 blocks per second, so OutLayer's
200-block yield window is about 25 s of wall time there. `fast_forward(n)`
advances about 0.29 s of block time per block and moves the whole chain, so
the tests run one at a time (`--test-threads=1`); `Env::advance_to` fails at
once if a forward does not move the clock (a restarted chain).
`scripts/test-contracts.ps1` runs the build, the unit tests, the sandbox and
the integration tests (`-Gas` adds the gas calibration).

## Units

All amounts are integers.

- USDC (quote token): base units, 6 decimals. JSON: decimal string (`U128`).
- Token: base units, `decimals` (0..=24, default 18). `ONE = 10^decimals`.
- Price: USDC base units per WHOLE token. 0.001 USDC/token = `1000`.
- Time: nanoseconds, `U64` decimal string in JSON.
- NEAR: yoctoNEAR, `NearToken` / `U128` string.

## Clearing (crate `fairground-clearing`)

An exact port of `packages/clearing/src/clear.ts`. Same names, same semantics,
same rounding, byte-for-byte the same results:

- `validate_bid`, `tokens_for` (floor), `cost_of` (ceil), `demand_at`,
  `prorate` (floor shares, leftovers one unit at a time in array order, skipping
  entries already at their weight), `clear`, `contract_checks`.
- `Bid { bidder: String, deposit: u128, max_price: Option<u128>, max_spend: Option<u128>, mismatch: bool }`
- `SaleParams { sale_supply, floor_price, min_raise, decimals }` plus optional
  `max_price` ceiling (see below).
- `ClearingResult`, `Fill`, `InvalidReason`, `FailReason` mirror the TS types.
- Every product that can exceed u128 goes through a 256-bit `mul_div`
  (floor and ceil variants). Products: `spend * ONE`, `tokens * price`,
  `weight * amount` (prorate: `sale_supply^2` can exceed u128 when supply is
  1e24). Sums use checked/saturating adds such that comparisons stay correct.
  No input can make `clear` panic; impossible params return `Err`.
- Max price ceiling: if `max_price` is set, a decrypted max price above it is
  clamped to the ceiling before clearing (the mock already does this). The TS
  reference gets the same option so parity holds.

Parity: `packages/clearing/scripts/vectors.ts` (run with
`pnpm --filter @fairground/clearing vectors`) writes
`crates/clearing/tests/vectors.json`: hand cases plus at least 300 seeded random
bid sets (invalid bids, copycats, ties, under/oversubscribed, min raise fail,
decimals 0/6/18/24, huge supplies) with the full expected `ClearingResult`.
A Rust test asserts exact equality of every field. The vectors file is
committed; a TS test fails if it is stale.

### Bid-set hash (v1)

A running hash the contract updates on every accepted bid, so `close_sale`
never re-reads the bid book. The sealer recomputes it from its input.

```
h0 = sha256( "fairground/bidset/v1" || 0x00 || sale_id )
hi = sha256( h(i-1) || u32_be(i) || u8(len(bidder)) || bidder
             || u128_be(deposit) || sha256(payload) )      for bid index i = 0..n-1
bid_set_hash = hex(h_n)        (lowercase, 64 chars)
```

`payload` is the raw ciphertext bytes (TEE mode, base64-decoded) or the 32-byte
commitment (commit-reveal mode). Implemented in Rust (`bid_set_hash`,
incremental `BidSetHasher`) and in TS (`packages/clearing/src/hash.ts`), with
shared vectors.

### Commitment (commit-reveal mode)

```
commitment = sha256( "fairground/commit/v1" || 0x00 || sale_id || 0x00 || bidder || 0x00
                     || u128_be(max_price) || u128_be(max_spend) || salt )
```

`salt` is exactly 16 bytes (the app's 32 hex chars). Rust and TS, shared vectors.

## Sealer (crate `fairground-sealer`)

What the OutLayer job does, as a library (`fn run(input: &str, ctx: &Ctx) -> String`).
The WASI binary (`enclave/job`) reads stdin and the environment, refuses a
few requests itself (see "The WASI job's refusals") and prints what `run`
returns.

- Master secret: env `PROTECTED_FAIRGROUND_MASTER` (64 hex chars), generated
  inside the TEE by OutLayer. Never logged, never in output.
- Per-sale key: `sk = HKDF-SHA256(ikm = master, salt = "fairground/sealer/v1",
  info = "sale-key" || 0x00 || contract_id || 0x00 || sale_id)`, 32 bytes,
  used as an X25519 secret key. `pk = X25519(sk)`.
- Bids are libsodium sealed boxes (`crypto_box_seal`: X25519 + XSalsa20-Poly1305)
  of the canonical plaintext below, base64 (standard, padded). Use the
  `crypto_box` crate with the `seal` feature; a test opens a box produced by
  libsodium-wrappers (the app's library) to prove compatibility.
- Context check: answer `ok:false` (`predecessor_mismatch`) unless
  `ctx.predecessor == input.contract`. OutLayer secret conditions also pin
  the predecessor and the wasm hash.
- Price search: `run` clears with `clear_with(.., PriceSearch::FixedShape)`:
  always 128 halvings over `[floor, u128::MAX]`, every step computing every
  valid bid's demand, so the instruction count OutLayer publishes for a run
  does not show how high the top max price is. The result is identical to
  `clear` (same vectors, plus random books run through both). The contract's
  `clear_onchain` keeps the fast search (`clear`): commit-reveal prices are
  public once revealed, and on chain every step costs gas. What still varies
  with the bids in the enclave (the cost of each division, the bid checks,
  the allocation at the clearing price) is listed on `PriceSearch::FixedShape`
  in `crates/clearing`.

### Bid plaintext and its length

```
{"sale_id":"<sale id>","bidder":"<account id>","max_price":"<39 digits>","max_spend":"<39 digits>","salt":"<32 lowercase hex>"}
```

Exactly these keys in this order, no whitespace. `max_price` and `max_spend`
are decimal and padded on the left with zeros to 39 digits (`u128::MAX` has
39), so a bid's length says nothing about its amounts:

```
plaintext bytes = 176 + len(sale_id) + len(bidder)
sealed bytes    = plaintext + 48 = 224 + len(sale_id) + len(bidder)      (at most 224 + 32 + 64 = 320)
base64 chars    = 4 * ceil(sealed / 3)                                   (at most 428)
```

`fairground_clearing::sealed_bid_len(sale_id_len, bidder_len)` is that
formula (no features needed, usable in `const`). The contract refuses a TEE
bid of any other decoded length (`wrong_ciphertext_length`, see
`ft_on_transfer`), so an app that forgets to pad cannot place a bid that
leaks its digit counts while bidding is open. When opening a bid the sealer
still reads amounts with or without leading zeros. The fixture
`crates/sealer/tests/fixtures/canonical_bids.json` (56 rows: every field,
the exact plaintext, `plaintext_len`, `sealed_len`, `sealed_base64_len`) is
what the app, the relayer and the contract's unit tests check their own
implementations against; a Rust test fails if it is stale.

Input (`input_data`, JSON):

```json
{"v":1,"op":"pubkey","contract":"fairground.testnet","sale_id":"fairt"}
{"v":1,"op":"clear","contract":"fairground.testnet","sale_id":"fairt",
 "params":{"sale_supply":"600000000000000000000000","floor_price":"1000",
           "max_price":null,"min_raise":"50000000","decimals":18},
 "bid_set_hash":"<hex64>",
 "bids":[["alice.testnet","5000000","<base64 ciphertext>"], ...]}
```

Output (`response_format: "Text"`, so bytes are exact and u128 survive):

```json
{"v":1,"ok":true,"op":"pubkey","sale_id":"fairt","pubkey":"<hex64>"}
{"v":1,"ok":true,"op":"clear","sale_id":"fairt","bid_set_hash":"<hex64 recomputed from input>",
 "pubkey":"<hex64, the key the bids were opened with>",
 "clearing_price":"1600","n_valid":48,"n_invalid":1,
 "invalid":[7],                                   indices of the invalid bids, ascending
 "fills":[["<tokens>","<spent>"], ...]}          one entry per input bid, input order
{"v":1,"ok":false,"op":"clear","sale_id":"fairt","error":"<code>"}
{"v":1,"ok":false,"op":null,"sale_id":null,"error":"<code>"}
```

An `ok:false` answer echoes the request's `op` and `sale_id` when they are
strings, else `null` (always `null` for `invalid_json` and `duplicate_key`).
Codes: `invalid_json`, `duplicate_key` (some object in the request repeats a
key, at any depth, compared after unescaping), `unsupported_version`,
`unknown_op`, `unexpected_field`, `invalid_contract`, `predecessor_mismatch`,
`invalid_sale_id`, `invalid_params`, `invalid_bid_set_hash`, `invalid_bids`,
`invalid_ciphertext`, `bid_set_hash_mismatch`, `internal`, and the clearing
crate's `ClearingError::code()` values. The contract treats every `ok:false`
answer the same way, whatever its `op`, `sale_id` or `v`: "not now" (the
sale stays `closed` for another `close_sale`; a key request goes Failed for
`retry_setup`), with the code in the `clearing_failed` event or the log as
`sealer_error: <code>` (cut to 160 bytes).

The `bid_set_hash` the sealer checks arrives in the same request, so the
check binds the bids to the requester's own hash, not to the contract's
state. That the request holds the set the contract froze rests on the
contract's code and on nobody else being able to call OutLayer as the
contract (see "Deployment invariants").

A bid that does not decrypt, whose plaintext names another bidder or sale
(a copied ciphertext), or that breaks a bid rule (zero spend, spend above the
deposit, price below the floor) is invalid: it gets `["0","0"]` and is listed
in `invalid`, so the contract can charge it the invalid-bid penalty (see "Bid
slots and invalid bids"). Individual prices and spends never appear in the
output. A failed sale (below min raise, no valid bids) outputs all-zero fills
and still lists its invalid bids; the contract decides Failed from the
totals. `pubkey` lets the contract check that the bids were opened with the
key they were sealed to: if the master secret ever changed, every bid would
"fail to decrypt", and none of them must pay for that.

### The WASI job's refusals

The job (`enclave/job/src/main.rs`) refuses some runs itself, before `run`
sees the request. A refusal is a failed run, not an answer: exit status 1,
nothing on stdout, and one line on stderr, `fairground-sealer: refused:
<code>`. OutLayer reports a failed run to the contract's callback as `null`,
so the sale stays `closed` (anyone retries with `close_sale`) and a key
request goes Failed (`retry_setup`). The code still reaches the chain:
OutLayer's `execution_completed` event carries stderr as `error_message`.
The codes, in the order they are checked:

| Code | Why |
| --- | --- |
| `not_near_execution` | `OUTLAYER_EXECUTION_TYPE` is not `NEAR` (an HTTPS run, not an on-chain request) |
| `missing_predecessor` | `NEAR_PREDECESSOR_ID` is unset, empty or not Unicode |
| `missing_sender` | `NEAR_SENDER_ID` is unset, empty or not Unicode |
| `input_unreadable` | stdin could not be read |
| `input_too_large` | stdin holds more than 4 MiB |
| `invalid_json` | stdin is not one JSON object in UTF-8 |
| `duplicate_key` | some object in the request has the same key twice |
| `signer_is_contract` | `NEAR_SENDER_ID == NEAR_PREDECESSOR_ID` (the contract account signed the transaction itself) and `op` is not `pubkey` |
| `missing_master` | `PROTECTED_FAIRGROUND_MASTER` is unset: no secret row, or the row lacks it |
| `invalid_master` | `PROTECTED_FAIRGROUND_MASTER` is not 64 hex digits |

A panic also fails the run (stderr `fairground-sealer: internal error`).
Everything else is an answer from `run` on stdout with exit status 0, its
`ok:false` answers included. `run` can therefore still answer `ok:false`
with `op` and `sale_id` null (a request without a usable `op`, or its
`internal` answer); the contract retries those like any other `ok:false`.

### The pinned job

The job's wasm is built in Docker by `scripts/build-enclave.ps1` (`-Verify`
rebuilds and compares). Its sha256 is in
`enclave/res/fairground_sealer.wasm.sha256`. That file is the single source
of truth: this document does not repeat the hash, and anything that quotes
it (the enclave README, a deploy script) must be checked against the file.
The contract's `sealer_code_hash` (and the `version_key` or `hash` of
`sealer_source`), the OutLayer upload and the secret's `WasmHash` condition
must all equal it. Any change to `crates/sealer` or `crates/clearing`
changes the hash.

## Token (contract `fairground-token`)

NEP-141 + NEP-145 + NEP-148 using near-contract-standards 5.30.1.

- `#[init] new(owner_id, total_supply: U128, metadata)`: mints the whole supply
  to `owner_id` (the Sealround contract) once. No mint method, no owner
  methods, no upgrade method.
- `burn(amount: U128)`: any holder burns its own balance (total supply falls).
  Sealround uses it for unsold tokens. Emits the NEP-141 `ft_burn` event.
- Deployed by Sealround to `<sale_id>.<fairground account>`.

## Sealround contract

Source: `contracts/fairground/src` (lib, config, sale, setup, bids, outlayer,
settle, claims, liquidity, costs, events, views; unit tests in `tests/`). Built
wasm: `contracts/res/fairground.wasm` (about 592 KB, the token wasm included).

### Init and config (fixed at deploy; there is no owner and no admin method)

```rust
#[init] #[private] fn new(               // only the contract account itself can init (no front-running)
  outlayer: AccountId,                    // outlayer.testnet / outlayer.near
  sealer_source: SealerSource,            // {"Project":{"project_id","version_key"}} or
                                          //   {"WasmUrl":{"url","hash","build_target"}}; never version_key null
  sealer_code_hash: String,               // the pinned wasm sha256, 64 lowercase hex; copied into every sale
  sealer_secrets: Option<SecretsRef>,     // OutLayer secrets_ref {profile, account_id}
  allowed_quote_tokens: Vec<AccountId>,   // USDC ids accepted as quote_token
  dex: Option<AccountId>,                 // Rhea exchange for launch pools: ref-finance-101.testnet /
                                          //   v2.ref-finance.near; null (or absent) turns launch liquidity off
)
```

`new` refuses: a code hash that is not 64 lowercase hex; a Project
`version_key` (or WasmUrl `hash`) different from `sealer_code_hash`; a
`project_id` without `/`; a WasmUrl that is not `https://` (at most 2048
bytes); a secrets profile that is not 1-64 of `[A-Za-z0-9_-]`; an empty or
duplicated `allowed_quote_tokens`; a `dex` equal to `outlayer` or to a quote
token. Views: `get_config`.

### Sale parameters (`create_sale`)

One JSON argument, `params`. Unknown fields are refused (a misspelt optional
field must not fall back to its default).

| Field | Type | Rule |
| --- | --- | --- |
| `sale_id` | String | `^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$`, unique, and `<sale_id>.<contract>` must be a valid account id (no `--`, `__`, `-_`; at most 64 chars); the token goes there |
| `token_name`, `token_symbol` | String | 1-64 and 1-16 bytes, not blank |
| `decimals` | u8 | <= 24 |
| `icon` | Option<String> | a `data:` URL of at most 2048 bytes |
| `total_supply`, `sale_supply` | U128 | 0 < sale_supply <= total_supply |
| `floor_price`, `max_price` | U128, Option<U128> | floor > 0; max_price >= floor if set |
| `min_raise` | U128 | |
| `bid_start`, `bid_end` | U64 ns | now <= bid_start < bid_end; window <= 30 days |
| `min_deposit`, `max_deposit_per_account` | U128 | 1 USDC (`MIN_DEPOSIT_FLOOR`, 1000000) <= min <= max; `max * 10^decimals` fits u128 |
| `max_bids` | u32 | 1..=MAX_BIDS_PER_SALE (500, measured; see costs.rs) |
| `reveal_mode` | `"Tee"` / `"CommitReveal"` | |
| `reveal_window` | Option<U64> ns | CommitReveal only (refused for Tee); default 10 min; 1 min..=7 days |
| `settle_timeout` | U64 ns | 10 min..=7 days |
| `quote_token` | AccountId | must be in `allowed_quote_tokens` |
| `unsold_rule` | Option<`"Burn"`> | only value, the default |
| `description`, `website` | Option<String> | <= 280 and <= 200 bytes, display only |
| `liquidity` | Option<{`raise_share_bps`: u16, `pool_tokens`: U128, `fee_bps`: u16}> | launch pool, see "Launch liquidity": refused when `dex` is null; raise_share_bps 1..=5000, 0 < pool_tokens <= total_supply - sale_supply, fee_bps 1..=1000; unknown fields refused |

`creator_allocation = total_supply - sale_supply - pool_tokens` (no
`liquidity`: `total_supply - sale_supply`) goes to the creator at the end.

### Storage and cost

`ft_on_transfer` carries no NEAR, so bidders cannot pay for their own bid
storage. The creator prepays at `create_sale` (all byte counts measured in the
unit tests and again on chain by the integration tests, which agree to the
byte; `costs.rs` says how, `contracts/GAS.md` has the numbers; "* 1.15" is
`STORAGE_MARGIN_PERCENT`, rounded up to whole bytes):

```
create cost = (SALE_BASE_BYTES 1112 + 2 * len(sale_id) + 64 (creator, any length)
               + len(quote_token) + len(token account) + name + symbol + icon
               + description + website) * 1.15 * 1e19
            + token deploy balance  = (token wasm bytes + 100 + 280 + 200 + name + symbol + icon) * 1e19
            + max_bids * per-bid reserve = (624 Tee | 368 CommitReveal bytes) * 1.15 * 1e19 + 0.00125 NEAR
            + creator registrations on the sale token and the quote token (2 * 0.00125 NEAR)
            + this contract's registration on the quote token, first sale only (0.00125 NEAR + 112 B * 1.15)
            + Tee: OutLayer compute deposit for the key call (OUTLAYER_COMPUTE_DEPOSIT, 0.01401 NEAR)
            + liquidity only: the record (LIQUIDITY_RECORD_BYTES 168 * 1.15 * 1e19)
              + LIQUIDITY_NEAR_RESERVE (0.01508 NEAR: exchange account 0.00398, the exchange's
                registrations on both tokens 2 * 0.00125, pool 0.007, LP record 0.0016, 5 yoctoNEAR)
```

Measured on chain: a worst-case TEE bid (64-character bidder, 32-character
sale id, so the longest ciphertext there is, 320 bytes) stores 585 bytes,
plus a 32-byte fill at settlement and, if it is invalid, a 4-byte entry in
the sale's invalid-bid list (621 of the 624 charged before the margin); a
commit-reveal bid 297 + 32 (reveal) + 32 (fill) + 4 = 365 of 368.

`get_create_cost(params) -> U128` validates the params and returns exactly what
`create_sale` charges. `create_sale` is `#[payable]` and requires attached >=
cost. A commit-reveal sale refunds the excess at once; a TEE sale sends it to
OutLayer with the key deposit (headroom if OutLayer's prices rose), and
OutLayer refunds the creator what it does not charge. `claim_proceeds` returns
to the creator what is not needed (`get_reserve_refund(sale_id)` shows it):
unused bid slots (`max_bids - bid_count`) in full, the token registration of
every bid that won no tokens, the creator registrations not used (no
allocation, no raise), the token deploy balance if the token never
deployed, and the part of the liquidity reserve no step spent (see "Launch
liquidity"). The storage of used bid slots stays locked (records are kept).

Known leak, accepted: `claim` and `claim_proceeds` register the receiver
(NEP-145, 0.00125 NEAR from the reserve) before every token transfer. If the
receiver was already registered (a creator who holds USDC, a winner who
registered on the sale token early), the token refunds that deposit to this
contract, where nothing can move it. Checking `storage_balance_of` first
would add a cross-contract call to every payout, costing every claimer about
as much gas as the 0.00125 NEAR it would save in the rare case.

### States

```
Setup ──(token deployed && (CommitReveal || sealer key stored))──► Bidding
Bidding: Upcoming (now < bid_start) / Open / AwaitingClose (now >= bid_end)   [derived from time]
AwaitingClose ──close_sale──► Clearing (Tee) | Revealing (CommitReveal) | Failed (no bids)
Clearing ──callback ok + checks pass──► Settled
Clearing ──callback ok + checks fail / malformed / below min raise / nothing sold──► Failed
Clearing ──callback null / "" / Err / any ok=false answer──► Closed (frozen; close_sale retries)
Revealing ──(now >= reveal_end) clear_onchain──► Settled | Failed
Setup / Bidding / Closed / Clearing / Revealing ──(now >= reference + settle_timeout) trigger_refund_mode──► Failed
```

`reference` is `reveal_end` while Revealing, `closed_at` once closed, else
`bid_end` (`refund_mode_at` in the sale view). Bidding is included so a sale
whose bids nobody closes (the closer pays OutLayer) still refunds. A sale moves
one way only. Settled and Failed are final and both let everyone claim, so no
path leaves funds stuck. Status names in views: `setup`, `upcoming`, `open`,
`awaiting_close`, `clearing`, `closed`, `revealing`, `settled`, `failed`.
Fail reasons: `no_bids`, `no_valid_bids`, `below_min_raise`, `nothing_sold`,
`checks_failed`, `refund_mode`. The quote-token registration is not part of the
Setup gate (it is global per token); if it fails, `retry_setup` redoes it.

What "callback null" covers: every failed OutLayer run, which includes every
refusal the WASI job makes itself (see "The WASI job's refusals": a missing
secret row, a request signed by the contract account, and so on) and a
timeout. None of these fails a sale or a setup for good. In `clearing` the
sale goes back to `closed` and anyone may call `close_sale` again; in `setup`
the key step goes Failed and anyone may call `retry_setup`. The same holds
for an answer that says `ok:false`, even one with `op` and `sale_id` null:
it is a refusal, never "malformed output". Only an answer that says
`ok:true` and then fails a check, or output that is not the sealer's JSON at
all, fails the sale. If every retry is refused (the secret row is gone for
good, say), the sale stays `closed` until the settle timeout, and refund
mode then returns every deposit in full.

### Bid slots and invalid bids

Bid slots are first come, first served (`max_bids`, then `sale_full`), and the
contract cannot read a TEE ciphertext, so it accepts any bytes of the right
length (`sealed_bid_len`, see "Bid plaintext and its length"). Without
a cost, anyone could fill every slot with junk from throwaway accounts, have
every bid come back invalid, take every deposit back and block the launch.
So an invalid bid pays a penalty: 1 % of its deposit, rounded up, locked in
this contract for good (USDC cannot be burned), the same as an unrevealed
commit-reveal bid. Invalid means what the clearing rule says (does not
decrypt, copied from another bidder, zero spend, spend above the deposit,
price below the floor) plus, in commit-reveal, not revealed. The bids are
named by a trusted clearing only: the enclave's result once it passes every
integrity check (including `pubkey_matches`, so a changed master secret
cannot make honest bids "invalid"), or `clear_onchain`. A result that fails an
integrity check, and refund mode, refund everyone in full. The penalty applies whether
the sale then settles or fails. `min_deposit` is at least 1 USDC
(`MIN_DEPOSIT_FLOOR`), so a junk slot costs at least 0.01 USDC.

Residual risk: blocking a sale still costs only `max_bids x (1 % of
min_deposit + about 0.005 NEAR for an account and its USDC registration)`,
plus `max_bids x min_deposit` of capital held until the sale ends (500 slots
at the 1 USDC floor: 5 USDC, about 2.5 NEAR and 500 USDC held). A creator
who expects to be targeted raises `min_deposit`: at 100 USDC the same attack
costs 500 USDC lost and 50,000 USDC held. Honest bidders never pay it: the
app only seals valid bids, and a commit-reveal bidder pays it only by not
revealing or revealing a bid the rules refuse.

### Methods

All JSON; amounts are decimal strings. A method that fails returns an explicit
error message (`#[handle_result]`); `ft_on_transfer` and callbacks never fail.
A `sale_id` that breaks the sale id rule is never looked up (a storage key
over 2048 bytes would make the read panic): methods answer `unknown sale`,
views answer nothing.

- `create_sale(params) #[payable]`: validates, charges the cost, writes the sale
  (status `setup`), then:
  1. Token: `Promise::new(<sale_id>.<self>).create_account().transfer(deploy balance)
     .deploy_contract(TOKEN_WASM).function_call("new", {owner_id: self, total_supply,
     metadata: {spec "ft-1.0.0", name, symbol, icon, reference null, reference_hash null,
     decimals}}, 0, 20 TGas)` then `on_token_deployed(sale_id)`.
  2. Tee: OutLayer `request_execution` with `{"op":"pubkey",..}`, payer = creator,
     deposit = `OUTLAYER_COMPUTE_DEPOSIT` plus whatever the creator attached
     above the cost, then `on_sealer_key(sale_id, payer, deposit)`; stores
     `sealer_pubkey`. A request refused at the door hands the deposit back
     to the payer. Anything but an `ok:true`, `op:"pubkey"` answer for this
     sale with a 64-hex key leaves the key step Failed for `retry_setup`,
     and the log says why: `sealer key request failed (<reason>); retry_setup
     can retry it`, where the reason is `sealer_error: <code>` for an
     `ok:false` answer, `the job failed or timed out` for `null` (which is
     what a refusal by the WASI job looks like; its code is in OutLayer's
     event), `request refused by OutLayer`, or what is wrong with the output.
  3. First sale with a quote token: `storage_deposit(account_id: self,
     registration_only: true)` on it, then `on_quote_registered(quote_token)`.
  Needs about 160 TGas prepaid (checked up front); burns about 45 TGas.
- `retry_setup(sale_id) #[payable]`: anyone. In `setup`, redeploys a failed
  token (the failed batch returned its NEAR) and re-asks a failed key (attach
  at least `OUTLAYER_COMPUTE_DEPOSIT`; all of it goes to OutLayer as payment,
  the caller becomes the payer and OutLayer refunds what it does not charge,
  so attaching more gets a key through after OutLayer's owner raised prices
  past the deposit's 2x margin). Until the sale is final, also redoes a
  failed quote-token registration. Without a key retry, attached NEAR is
  refunded; errors if nothing failed.
- `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>`: msg is
  `{"sale_id":"..","ciphertext":"<base64>"}` (Tee) or
  `{"sale_id":"..","commitment":"<hex64>"}` (CommitReveal), no other fields.
  Never panics on user input: every rejection returns the full amount and logs
  `bid_rejected` with `reason`, checked in this order: `bad_msg`,
  `unknown_sale` (also an id that breaks the sale id rule, logged as
  `sale_id: null`), `wrong_token` (predecessor != sale.quote_token),
  `not_open`, `wrong_payload` (a ciphertext for a commit-reveal sale, a
  commitment for a TEE sale, both or neither), then for a ciphertext
  `ciphertext_too_long` (more than 428 base64 characters), `bad_base64` (not
  standard padded base64, or empty), `ciphertext_too_long` (more than 320
  bytes decoded) and `wrong_ciphertext_length` (not exactly
  `224 + len(sale_id) + len(sender_id)` bytes decoded:
  `fairground_clearing::sealed_bid_len`), or for a commitment `bad_hex`; then
  `below_min_deposit`, `above_max_deposit`, `already_bid`, `sale_full`,
  `overflow`. On accept: append the bid, update the bid-set hash and totals,
  write all of it to storage, and only then emit `bid_placed` (a receipt that
  runs out of gas while writing never shows the event); return 0. The whole
  `ft_transfer_call` burns 7.4-8.5 TGas, `ft_on_transfer` itself 2.8-2.9.
- `close_sale(sale_id) #[payable] -> status`: anyone, after bid_end. Freezes the
  bid set and records `closed_at` (first call only). No bids: Failed(no_bids),
  refunds the attached NEAR. CommitReveal: Revealing, `reveal_end = closed_at +
  reveal_window`, refunds the attached NEAR. Tee: builds the clearing input
  (reads every bid), requires attached >= `get_close_deposit(sale_id)`, builds
  the `request_execution` arguments (by hand: serde_json's string escaper cost
  20 TGas at 500 bids), checks the prepaid gas covers the rest
  (`outlayer_request_gas(input) + ON_CLEARING_RESULT_GAS + request_send_gas(args)
  + OWN_WORK_GAS`), forwards all the NEAR to `request_execution` with payer =
  caller (OutLayer refunds the unused part to the caller), status `clearing`,
  then `on_clearing_result(sale_id, closer, deposit)`. Also the retry path when
  the status is `closed`. Returns the new status (`"failed"`, `"revealing"`, or,
  in TEE mode, what the callback returns).
- `on_clearing_result(sale_id, closer, deposit) #[private] -> status`: reads the
  raw promise result with `env::promise_result_checked` (never a typed
  `#[callback_result]`). Never panics.
  - Err (request refused; the deposit came back to this contract, so it is sent
    to `closer`), bytes `null` (a failed run, which includes the WASI job's
    own refusals, or a timeout), the Text string `""` or only whitespace (the
    job printed nothing), or any answer that parses with `ok:false`, whatever
    its `op`, `sale_id` (both may be null or absent) or `v`: status `closed`,
    `clear_attempts += 1`, `clearing_failed` event with the reason (`request
    refused by OutLayer`, `the job failed or timed out`, or `sealer_error:
    <code>` with the answer's error code cut to 160 bytes). Anyone may retry
    with close_sale. This is decided before any other check of the answer.
  - Output that is not a JSON string (Text format) or not the sealer's JSON,
    or an `ok:true` answer with `v != 1`, without `op:"clear"` or missing a
    field: Failed (`checks_failed`, check `output_well_formed`).
  - Otherwise check, recording every failed check by name:
    `sale_id_matches`, `bid_set_hash_matches`, `pubkey_matches` (the sale's
    stored `sealer_pubkey`), `one_fill_per_bid`, `invalid_list_matches`
    (`invalid` strictly ascending, every index a bid, as long as `n_invalid`,
    and `n_valid + n_invalid == bid_count`), `price_at_least_floor`,
    `price_at_most_ceiling`, `sold_at_most_supply`, `spent_within_deposit_<i>`,
    `spent_equals_tokens_times_price_<i>` (`cost_of(tokens, price,
    10^decimals)`), `invalid_bid_unfilled_<i>`, `raise_at_least_min`,
    `something_sold`. Any but the last two fails (an integrity check): Failed
    (`checks_failed`), everyone refunded in full. Otherwise the listed bids
    pay the invalid-bid penalty, and: nothing sold: Failed (`no_valid_bids`
    if `n_valid == 0`, else `below_min_raise` if `min_raise > 0`, else
    `nothing_sold`); raise below the minimum: Failed (`below_min_raise`);
    otherwise Settled. The first 8 failed names are stored with the total
    count.
  - A result arriving after refund mode is ignored (an Err still refunds).
  - Stores `result_sha256 = sha256(bytes received)` (the JSON string, exactly
    what OutLayer's attestation `output_hash` covers) and fills as one value per
    sale (`Vec<(u128, u128)>`). Emits one `sale_settled` or `sale_failed`.
- `reveal_bid(sale_id, max_price: U128, max_spend: U128, salt: String)`:
  bidder only, `revealing`, before reveal_end; salt is 32 hex chars; checks the
  commitment.
- `clear_onchain(sale_id) -> status`: anyone, `revealing` and now >= reveal_end.
  Runs `fairground_clearing::clear` (the fast price search) with revealed
  bids (unrevealed = invalid). It takes no deposit and makes no promises, so
  the relayer relays it. With 500 revealed bids its receipt burns 51 TGas
  for a usual book and 102.5 TGas in the worst case measured (every max
  price `u128::MAX`: 128 search steps over every bid); a relayed call
  attaches 150 TGas, the relayer's cap; the gas calibration shows 120 is
  already enough for both (GAS.md, "Clearing on chain").
  Nothing sold fails it like the TEE path. Invalid bids (unrevealed, or
  revealed but breaking a bid rule) are refunded minus the 1 % invalid-bid
  penalty (ceil), which stays locked in the contract forever ("burned": there
  is no method that can move it). The penalty applies only to sales cleared
  this way or by a checked enclave result (Settled or Failed); refund mode
  refunds everyone in full.
- `claim(sale_id, bidder: Option<AccountId>) -> bool`: anyone may push a bidder's
  claim (funds only ever go to the bidder; default bidder = caller). Settled:
  tokens (after `storage_deposit` for the bidder on the token, paid from the
  reserve) plus the unspent deposit in USDC. Failed: the deposit. An invalid
  bid loses the penalty either way. Marks each part claimed before the promises;
  `on_claim(sale_id, index, tokens, refund)` restores whatever part failed so it
  can be claimed again. Nothing left: returns false with a log, never a second
  transfer. While a launch pool is being seeded the tokens wait: the refund
  is paid alone (with a log), and a claim with only tokens left fails with
  "sale tokens stay locked until the launch pool is seeded (seed_liquidity)
  or abandoned (abandon_liquidity)".
- `claim_proceeds(sale_id) -> bool`: anyone; pays the creator: the raise in USDC
  (Settled; less the pool's USDC), the allocation in tokens (each after
  registering the creator on that token), the NEAR reserve refund; burns the
  unsold sale tokens (and the pool reserve the pool does not take) with
  `token.burn` (1 yoctoNEAR attached). The sale records the amount paid for
  each part and each call pays what is owed minus what was paid; `on_proceeds`
  takes a failed part's amount off again, so it is claimed again and never
  twice, and an abandoned pool's USDC follows in a later call. Waits while a
  token deploy is still in flight. While a launch pool is being seeded the
  allocation waits, and a call with only the allocation left fails like
  `claim`.
- `seed_liquidity(sale_id)`, `abandon_liquidity(sale_id)`: see "Launch
  liquidity".
- `trigger_refund_mode(sale_id)`: anyone, see States.
- Views: `get_config`, `get_sale(sale_id) -> Option<SaleView>` (with
  `key_request_block`, the block height of the call that sent the latest
  sealer key request, TEE only, and `liquidity`, the launch pool terms with
  the exchange), `get_sales(from_index, limit)`, `get_bid(sale_id, bidder)`,
  `get_bids(sale_id, from_index, limit)` (index, bidder, deposit, payload
  base64, placed_at, revealed, claimed; never prices), `get_bids_summary(sale_id)`
  (count, max_bids, total_deposits, bid_set_hash), `get_result(sale_id)`
  (status, fail_reason, clearing_price, totals, unsold (what `claim_proceeds`
  burns, the unused pool reserve included: zero while the token is not
  deployed), n_valid, n_invalid, n_winners, failed_checks,
  failed_checks_total, result_sha256, input_sha256, clear_requests,
  `clear_request_block` (block height of the call that sent the latest
  clearing request, TEE only), clear_attempts, total_penalties, proceeds
  flags (a part counts as paid once everything it owes so far is paid),
  `liquidity`, the launch pool's progress),
  `get_fills(sale_id, from_index, limit)` (index, bidder, tokens, spent, refund,
  penalty, once final; refunds for a failed sale; `refund` is net of
  `penalty`), `get_create_cost(params)`,
  `get_close_deposit(sale_id)`, `get_reserve_refund(sale_id)`. Pages default to
  50 entries, at most 200.

### Launch liquidity

Optional, per sale (`src/liquidity.rs`). A sale with `liquidity` sets aside
`pool_tokens` sale tokens and `raise_share_bps` of its raise, and after it
settles seeds a constant-product pool on the Rhea exchange (formerly Ref
Finance; config `dex`) at exactly the clearing price. The LP shares stay with
this contract, which has no method that moves, transfers or redeems them, and
no key once deployed, so the liquidity can never be pulled. The terms are
fixed at `create_sale` and shown by `get_sale`; nobody can change them.

**Plan, at settlement.** With `raise` the total raised and `price` the
clearing price (USDC base units per whole token, `ONE = 10^decimals`):

```
budget = floor(raise * raise_share_bps / 10000)
tokens = min(floor(budget * ONE / price), pool_tokens)
usdc   = ceil(tokens * price / ONE)                    // <= budget
```

So `usdc * ONE - tokens * price` is in `[0, ONE)`: the pool's price is the
clearing price, at most one USDC base unit above it in total, never below.
If `tokens` or `usdc` comes to zero the pool is `skipped`: the whole raise goes
to the creator and the reserve is burned. The reserve the pool does not take
(`pool_tokens - tokens`) is burned at `claim_proceeds` with the unsold sale
supply (`get_result.unsold` includes it). The pool's USDC comes out of the
raise. A failed sale burns the whole reserve (stage `cancelled`).

**Stages** (`get_result.liquidity.status`): `waiting` (sale not final),
`seeding`, `seeded`, `skipped`, `cancelled`, `abandoned`.

**Seeding.** `seed_liquidity(sale_id) -> stage`: anyone, no deposit, while
`seeding` and before the deadline (settlement time + `settle_timeout`). It
runs the next step; each step's callback records the result and starts the
step after while the gas left covers it. 300 TGas runs all four (54.5 TGas
burnt in the sandbox); a relayed 150 TGas call runs one or two, so three
calls seed the pool. Steps, with what each call attaches:

1. `register`: one batch on the exchange,
   `storage_deposit({"account_id": <this contract>, "registration_only": false})`
   with 0.00398 NEAR (398 bytes: the 102-byte account record and a 148-byte
   entry for each token), 10 TGas, then
   `register_tokens({"token_ids": [<sale token>, <quote token>]})` with
   1 yoctoNEAR, 10 TGas. Alongside, on each token,
   `storage_deposit({"account_id": <dex>, "registration_only": true})` with
   0.00125 NEAR, 10 TGas. Callback `on_dex_registered`.
2. `create_pool`: first `get_number_of_pools({})` with no deposit, 10 TGas;
   `on_pool_count` (50 TGas static) keeps the count as `pool_search` and
   sends `add_simple_pool({"tokens": [<sale token>, <quote token>],
   "fee": fee_bps})` with 0.007 NEAR (the record measured 602 bytes with
   64-character token ids; the exchange refunds the rest to this contract),
   20 TGas. `on_pool_created` reads the pool id. The new pool's id is at
   least `pool_search`, so a pool whose id did not come back can be found.
3. `deposit`: on each token, `ft_transfer_call({"receiver_id": <dex>,
   "amount": <what is still missing>, "msg": ""})` with 1 yoctoNEAR, 50 TGas
   (a plain deposit into this contract's exchange account). `on_dex_deposit`
   reads how much each transfer kept.
4. `add_liquidity`: `add_liquidity({"pool_id": id, "amounts": [tokens, usdc],
   "min_amounts": [tokens, usdc]})` with 0.0016 NEAR (the LP share record
   measured 129 bytes for a 64-character account; the rest is refunded),
   20 TGas. `on_liquidity_added`: stage `seeded`, the minted shares recorded
   (1e24 for a new pool), `liquidity_seeded` event. If the call went through
   but the share count is unreadable or zero, the pool is not called seeded:
   the next step is `reconcile`, which reads the shares from the exchange.
   `seeded` always comes with the share count the exchange reported.

Each callback is `#[private]`, gets 15 TGas plus the call's unused gas, and
sets a flag only when it sees its promise succeed. A failed step changes
nothing else: `failures` goes up, `liquidity_step_failed` is logged, the run
stops, and the next `seed_liquidity` runs the same step again (a deposit
sends only what is still missing). One step runs at a time: while a step
waits for its callback both methods answer "a launch liquidity step is
waiting for its result". A pool the exchange refuses for good (paused,
a token frozen) is retried until the deadline and then abandoned.

Every step started gets the next number (`attempt`), passed to its callback
as the second argument (`on_dex_registered(sale_id, attempt, account,
on_token, on_quote)`, `on_pool_count(sale_id, attempt)`,
`on_pool_created(sale_id, attempt)`,
`on_dex_deposit(sale_id, attempt, tokens, usdc)`,
`on_liquidity_added(sale_id, attempt)`, `on_dex_withdraw(sale_id, attempt,
tokens, usdc)`, `on_dex_reconciled(sale_id, attempt, pool_id, search)`). A callback
whose step is not the one in flight, or whose number is older, changes
nothing and returns the stage: a result delivered twice, or one that arrives
after its step was given up on, is ignored.

**Lost results.** A callback receipt that fails (a bug here, or gas) leaves
its step in flight forever, which would block both methods and keep the
tokens locked. So a step counts as running for `STEP_TIMEOUT_BLOCKS` (600
blocks, about 6 to 10 minutes) after it started; after that the next
`seed_liquidity` or `abandon_liquidity` gives it up (`liquidity_step_lost`,
`failures` + 1) and runs `reconcile` instead:
`get_deposits({"account_id": <this contract>})` with 10 TGas and, if it has
a pool, `get_pool_shares({"pool_id": id, "account_id": <this contract>})`
with 10 TGas, or, if a pool may exist whose id never came back,
`get_pools({"from_index": pool_search, "limit": 20})` with 30 TGas, each as a
function call on the exchange with no deposit, then
`on_dex_reconciled(sale_id, attempt, pool_id, search)`. The balances replace
`tokens_on_dex` and `usdc_on_dex` (`liquidity_reconciled` {sale_id, pool_id,
tokens_on_dex, usdc_on_dex, shares}); LP shares mean `add_liquidity` went
through, so the stage becomes `seeded` with that share count (even from
`abandoned`); otherwise the run goes on from what is really there (the
deposit step sends only what is missing, `abandon_liquidity` withdraws only
what is there). In a page of pools, the first empty `SIMPLE_POOL` of
`[<sale token>, <quote token>]` in that order with the sale's fee becomes the
sale's pool (its id is `from_index` plus its place in the page). Any such
pool will do: nobody else holds the sale token while the pool is seeded, so
an empty pool of the pair cannot have been priced by anyone. A full page
without one moves `pool_search` 20 on and reads again; a shorter one means
`add_simple_pool` failed, and the pool step runs again. A pool is never
created twice for a sale whose `add_simple_pool` went through. Until a
reconcile succeeds the record is `unsure`: the next step is `reconcile`
again, and a failed one is retried like any step. A lost `on_pool_count`
sent nothing, so the pool step simply runs again. A lost `register` cannot be
read back, so it runs again (it is safe to repeat), and the NEAR it attached
counts as spent (`near_lost`, at most 0.00648 NEAR per lost step, not refunded to the
creator; the repeat is paid from this contract's balance). Not covered: a
step whose receipts are delayed more than 600 blocks and land after the
reconcile read; a deposit could then be sent twice, and the extra would stay
on this contract's exchange account.

No caller can make a callback fail: each callback's gas is static and
reserved when the step starts (a method refuses to start a step without it),
and callbacks never panic. The lost-result path covers a bug or a protocol
change; the sandbox tests reach it by rewriting the record.

**Token lock.** While the stage is `waiting` or `seeding`, no sale token
leaves this contract: `claim` pays refunds only and `claim_proceeds` pays the
raise (less the pool's USDC), the burn and the NEAR, but not the allocation.
The token's whole supply was minted to this contract, so nobody else holds
any of it and nobody can put liquidity into the new pool at another price
first. `min_amounts = amounts` would refuse a pool that somehow had another
ratio. Seeded, skipped, cancelled or abandoned: the tokens unlock.

**Fallback.** From the deadline on, `abandon_liquidity(sale_id) -> stage`:
anyone, no deposit. The first call sets `abandoned` (tokens unlock at once)
and logs `liquidity_abandoned`; then it withdraws whatever this contract has
on the exchange: `withdraw({"token_id": <token>, "amount": <amount>})` with
1 yoctoNEAR, 50 TGas, for each token with a balance there (the exchange
sends the tokens with `ft_transfer` and answers with the amount, or 0 when
the transfer failed, in which case it credits the amount again).
`on_dex_withdraw` logs `liquidity_withdrawn` with any `failed` part; calling
`abandon_liquidity` again retries it. `claim_proceeds` then pays the pool's
USDC to the creator and burns its tokens, in the same call or a later one.
A pool created but never filled stays on the exchange, empty. If a step's
result was lost, abandoning still unlocks the tokens at once and then runs
`reconcile` first; until it succeeds, `claim_proceeds` holds all of the
pool's USDC and tokens (and the LP deposit), since any of it may be on the
exchange. If the exchange never answers again, that share stays held: it is
the only case where the pool's funds wait on the exchange, and the rest of
the sale (refunds, tokens, the raise less the pool's share, the allocation)
is paid as usual.

**Views.** `get_sale.liquidity`: `{dex, raise_share_bps, pool_tokens,
fee_bps}`. `get_result.liquidity`: `{status, next_step, in_flight, dex,
pool_id, usdc, tokens, shares, usdc_on_dex, tokens_on_dex, failures,
deadline}`, where `next_step` is what `seed_liquidity` (or, abandoned,
`abandon_liquidity`) would run now: `register`, `create_pool`, `deposit`,
`add_liquidity`, `withdraw`, `reconcile` or null.

**NEAR.** `create_sale` charges the record's storage and
`LIQUIDITY_NEAR_RESERVE` (0.01508 NEAR; "Storage and cost"). `claim_proceeds`
returns all of it for a skipped or cancelled pool, and for a seeded or
abandoned one what no completed step sent, less `near_lost`. What the exchange refunds (the
pool and LP deposits above what it charged) or a token refunds (the
exchange's registration when it already had one, as it has on mainnet USDC)
stays in this contract: under 0.006 NEAR per sale.

**What Rhea controls.** The exchange is outside this contract. Its owner and
guardians can pause it, freeze a token, change a pool's fee and upgrade the
contract. A pause or freeze makes a step fail (retried, or abandoned after the
deadline); after seeding it can stop trading in the pool. This contract only
guarantees that it never removes the liquidity itself.

**Assumption.** Both tokens' `ft_resolve_transfer` does not fail (true of the
NEP-141 reference and of the sale token here). If it did, a deposit the
exchange kept could look failed and be sent again; the extra would sit in
this contract's exchange account.

### OutLayer call

```rust
// request_execution(source, resource_limits, input_data, secrets_ref, response_format,
//                   payer_account_id, params) #[payable]
source:          config.sealer_source            // pinned hash
resource_limits: {"max_instructions": 50000000000, "max_execution_seconds": 60}
                 // 60 s is well inside the 200-block yield window; 5e10 instructions cost
                 // 0.000005 NEAR and leave room to open 500 sealed boxes (the default is 1e9)
input_data:      the JSON above (String)
secrets_ref:     config.sealer_secrets
response_format: "Text"
payer_account_id: caller (creator for pubkey, closer or retrier for clear)
params:          null
```

Deposit: `OUTLAYER_COMPUTE_DEPOSIT` = 2 x OutLayer's worst-case estimate for
our limits at the live prices (0.007005 NEAR: 0.001 base + 60 s x 0.0001 per
second + 5e10 instructions x 1e-10 NEAR per million instructions) = 0.01401
NEAR (14,010,000,000,000,000,000,000 yoctoNEAR; `costs.rs` computes it from
the prices and limits, and a test pins the figure), plus 1e19 yoctoNEAR per
input byte above 32 KB (held and returned by OutLayer). OutLayer's owner can change its prices, so every request forwards
all the NEAR its caller attached (`close_sale` and `retry_setup`; `create_sale`
adds whatever the creator attached above the cost): a caller gets a request
through after a price rise by attaching more, and OutLayer refunds the payer
what it does not charge. Gas: 60 TGas + 75 MGas per input byte + 25 MGas per
byte above 32 KB, weight 1 (it also gets the unused gas), then
`.then(on_clearing_result)` with 30 TGas static (measured 12.3 TGas at 500
worst-case bids).
Behaviour verified in the sandbox integration tests with OutLayer's own wasm: a
small result resolved with `resolve_execution` arrives as Ok(bytes); a large
one goes through `submit_execution_output_and_resolve`; a failed run or a
timeout (200 blocks, about 117 s on testnet) arrives as Ok(b"null"); a run
that exits 0 having printed nothing arrives as Ok(b"\"\"") (in Text format
only an empty *Json* output becomes `null`), so the WASI wrapper must flush
stdout before it exits; a refused request (OutLayer paused, or a deposit
below its estimate) arrives as Err and the deposit goes back to the payer; a
worker answer after the timeout is refused. What the payer gets back: the
deposit minus OutLayer's charge (the reported run's cost, or the 0.001 NEAR
base fee after a timeout); all of it when refused. Measured with 500
worst-case bids (262 KB input, 31 KB output): close_sale's own receipt 83 TGas,
the whole transaction 132 TGas burnt, and its gas check asks for 213 TGas
prepaid, so it fits the 300 TGas a transaction can attach (contracts/GAS.md).
The check's per-byte part (`REQUEST_SEND_GAS_PER_BYTE`) is the protocol's
fees for sending a function call's arguments to another account (send
47.68 + execution 2.24 MGas per byte, plus 3.80 MGas per byte to read them out
of wasm memory: 53.72 MGas, what the calibration measured) plus 12 %; it
must follow those fees if a protocol upgrade changes them.

### Events (NEP-297, standard `fairground`, version `1.0.0`)

`EVENT_JSON:{"standard":"fairground","version":"1.0.0","event":..,"data":{..}}`,
`data` is one object:

- `sale_created` {sale_id, creator, token, quote_token, reveal_mode, bid_start, bid_end, max_bids, cost}
- `sale_ready` {sale_id, token, sealer_pubkey (hex or null)}
- `bid_placed` {sale_id, bidder, index, deposit, bid_set_hash}
- `bid_rejected` {sale_id (null if the msg is unreadable or the id breaks the sale id rule), sender_id, token, amount, reason}
- `sale_closed` {sale_id, closed_at, bid_count, total_deposits, bid_set_hash, reveal_end}
- `clearing_requested` {sale_id, request, closer, deposit, input_bytes, input_sha256}
- `clearing_failed` {sale_id, attempt, reason}
- `sale_settled` {sale_id, clearing_price, total_sold, total_raised, unsold, n_valid, n_invalid, n_winners, result_sha256}
- `sale_failed` {sale_id, reason, failed_checks, failed_checks_total, result_sha256}
- `bid_revealed` {sale_id, bidder, index}
- `claimed` {sale_id, bidder, index, tokens, refund, failed: ["tokens"|"refund"]}
- `proceeds_claimed` {sale_id, creator, raise, allocation, burned, near_refund, failed}
- `refund_mode` {sale_id, from (the status before)}
- `liquidity_planned` {sale_id, dex, stage (`seeding` or `skipped`), usdc, tokens, price, unused_tokens, deadline}
- `liquidity_step_failed` {sale_id, step, failures}
- `liquidity_step_lost` {sale_id, step, failures} (no result after `STEP_TIMEOUT_BLOCKS`)
- `liquidity_reconciled` {sale_id, pool_id, tokens_on_dex, usdc_on_dex, shares}
- `liquidity_seeded` {sale_id, dex, pool_id, usdc, tokens, price, shares}
- `liquidity_abandoned` {sale_id, pool_id, usdc, tokens, usdc_on_dex, tokens_on_dex, failures}
- `liquidity_withdrawn` {sale_id, tokens, usdc, failed: ["tokens"|"usdc"]}

Logs are capped at 100 per call and 16 KB, so settlement emits one summary
event, never one per bid.

`bid_rejected.reason` is one of the `ft_on_transfer` reasons above.
`clearing_failed.reason` is `request refused by OutLayer`, `the job failed or
timed out`, `no promise result`, or `sealer_error: <code>` (`sealer_error`
alone if the answer gave no code). A reader of events must ignore those of a
failed receipt: its state changes were rolled back. `bid_placed` is logged
after the bid is written, so a receipt that ran out of gas writing it shows
no event at all.

### Safety rules

- No owner, no admin, no upgrade. Parameters never change after creation.
  The one outside party a sale can depend on is the exchange of a launch
  pool, and only for that pool (see "Launch liquidity", "What Rhea controls").
- State is written before any promise; every callback is `#[private]`,
  handles every promise outcome and never panics.
- Only `quote_token` deposits count; anything else is returned.
- Every path ends in Settled or Failed and both pay everyone.

### Deployment invariants

The contract cannot enforce these; whoever deploys must.

- **Delete the contract account's full-access key before any real bid,
  testnet demos included.** The sealer believes the request it is given
  (its `bid_set_hash` arrives in the same request), and the secret's
  conditions trust the contract account as predecessor. Until the key is
  gone, its holder can read every sealed bid: by calling OutLayer's
  `request_execution` as the contract with made-up sales around a real
  ciphertext (the job refuses a request the contract account signed itself,
  `signer_is_contract`, but that is defence in depth only), by relaying the
  same call as a meta-transaction OutLayer does not recognise as one, or by
  deploying new code to the account. `new` is `#[private]`, so the key is
  needed once, to deploy and initialise; delete it right after the smoke
  tests (`enclave/README.md` has the steps).
- **Optional signer-side condition on the secret.** The secret row's access
  condition can add a leaf that refuses runs signed by the contract account:
  `And[WasmHash, Predecessor{Whitelist[contract]}, Not{Whitelist[contract]}]`.
  OutLayer's `estimate_storage_cost` accepts this shape; that the keystore
  evaluates the `Not` leaf was not tested.
- **A new sealer build means a new contract account.** The config is fixed
  at `new` and no method changes it, so `sealer_code_hash` and
  `sealer_source` can never follow a rebuilt job. Deploy a new contract
  account with the new hash and move the secret's `WasmHash` and
  `Predecessor` leaves to the new hash and the new account. Sales on the old
  account keep the old job.
- **Closers and creators must not be the contract account.** A `close_sale`
  signed by the contract account itself asks for a `clear`, which the job
  refuses (`signer_is_contract`): the sale stays `closed` until someone else
  closes it. Key requests (`create_sale`, `retry_setup`) are `pubkey`
  requests, which the job does not refuse, but no sale should be created
  from the contract account either: `claim_proceeds` pays the creator, and
  an account whose key is deleted can never move the raise or the
  allocation it receives.

### Meta-transactions (NEP-366)

The contract identifies callers by `predecessor_account_id` only, which under
NEP-366 is the account that signed the delegate action, so every method
works the same when relayed. What the gas relayer (`apps/relayer`) relays:

- the bid itself: `ft_transfer_call` on the quote token to this contract;
- `claim`, `claim_proceeds`, `reveal_bid`, `trigger_refund_mode` and
  `clear_onchain`: none takes a deposit. Gas the client attaches: see
  `contracts/GAS.md`, "Relayed calls".

`seed_liquidity` and `abandon_liquidity` take no deposit either and each
step fits 150 TGas, but the relayer's policy does not list them yet.

Never relayed: the payable methods `create_sale`, `close_sale` and
`retry_setup`. Their deposits pay for storage and for OutLayer, and under
NEP-366 an inner action's deposit is paid by the relayer.

Under NEP-366 the relayer's account pays for everything in the delegate
action: the gas and every attached deposit, including the 1 yoctoNEAR
`ft_transfer_call` requires. Measured on a sandbox: a relayed bid leaves the
bidder's NEAR balance unchanged to the yoctoNEAR. A relayed bid must be
signed with a full-access key of the bidder: a function-call access key
cannot sign an action with a deposit, so it cannot sign `ft_transfer_call`.

## Integration tests (crate `fairground-integration`)

`contracts/tests`: a harness library (`src/`) and one test binary
(`tests/sandbox/`). Each test makes a fresh parent account
`<tag><unique>.test.near` and deploys under it: `fairground.wasm`,
`mock_ft.wasm` as USDC, and OutLayer's own `outlayer_contract.wasm`
(contracts/res, vendored, see NOTICE.md) initialised with the test as owner and
operator. The test plays the worker: it reads the pending request, runs
`fairground_sealer::run` with a test master secret and ctx.predecessor = the
Sealround account, and answers like the real worker (`resolve_execution` under
1024 bytes, else `submit_execution_output_and_resolve`). Bids are sealed with
the real sealed-box code to the pubkey the sealer published. Every scenario
checks USDC and token balances end to end, not only statuses, and every
claim is repeated to prove a second claim pays nothing. Where OutLayer is
paid, the payer's NEAR is checked too: it loses its gas plus exactly what
OutLayer's `[[yNEAR charged]]` log says, to the yoctoNEAR, so a lost or
misrouted refund fails the test.

Scenarios: undersubscribed (unsold burned, supply falls), oversubscribed with
a tie at the clearing price, invalid and copied ciphertexts (penalty), junk
bids filling every slot (`sale_full` for an honest bid, `no_valid_bids`,
penalty), max price ceiling, failed run then an empty output then retry
(closer refunds), OutLayer timeout (fast_forward 205) then retry and a refused
late answer (base fee kept), refused request (OutLayer paused) then retry
(full refund), a failed key job then `retry_setup` (creator and retrier
refunds), an OutLayer price rise past the key deposit (refused key, retry
with more attached, create with NEAR to spare), settle-timeout refund mode
from `closed` and from `awaiting_close`, below min raise, no bids, results
that fail the checks (and malformed output, full refunds), every
`bid_rejected` reason (window, cap, min, second bid, sale full, wrong token,
bad msg, payload errors including a ciphertext one byte short and a real
box of the old unpadded plaintext, an over-long sale id), commit-reveal with an
unrevealed and a revealed-invalid bid (penalties), claim_proceeds (raise,
allocation, unsold burn, NEAR reserve equal to `get_reserve_refund`) and
claims pushed by a third party, `#[init]` once and `#[private]` callbacks.
Launch liquidity runs against the Rhea exchange's own wasm, read from
`ref-finance-101.testnet` (`contracts/tests/res`, see its NOTICE.md), with the
test as the exchange's owner: a pool seeded in one call at the clearing
price (pool amounts and fee, every LP share Fairground's, nothing left on its
exchange account, a stranger cannot remove or move shares, the wasm names no
method that could), refunds but no tokens before seeding, a paused exchange
(the step fails, then succeeds), relayed 150 TGas calls, a frozen token (the
deposit fails twice, the retry sends only what is missing) then abandonment
with a failed and then a retried withdrawal, an abandoned pool with both
deposits made, the exchange's storage at 64-character ids against the
constants, lost results (the record rewritten with `patch_state` so that the
deposit step, or the pool step after `add_simple_pool` went through, waits
forever: busy until `STEP_TIMEOUT_BLOCKS`, then one call reads the exchange,
finds the deposits or the pool past a stranger's pools of the same tokens,
and seeds it without a second pool), and two callers sending
`seed_liquidity` or `abandon_liquidity` at once (each step and each
withdrawal runs once). Each ends with no USDC or sale token left in
Fairground.
The gas calibration (`--ignored`: 100 / 300 / 500 worst-case TEE bids, each
the longest sealed bid there is, and 500 commit-reveal bids twice, once
with a usual book and once with every max price at `u128::MAX`, the longest
price search) feeds `contracts/GAS.md` and asserts what the constants rest
on: `close_sale`'s gas check asks at most 300 TGas and a close with exactly
that much settles; `clear_onchain` settles with the gas a relayed call
attaches; a bid's on-chain storage plus its fill and invalid-list entry fits
`BID_BYTES_TEE` / `BID_BYTES_COMMIT_REVEAL` (read from costs.rs); the token
account's balance covers its storage.

## Spec deviations

1. The Verified panel cannot use a "fresh random nonce": OutLayer's attestation
   endpoints take no nonce. The panel checks the TDX quote's task hash, the
   approved measurements, `input_hash` against the on-chain input and
   `output_hash` against `result_sha256` instead.
2. Fills are positional (one `[tokens, spent]` per bid in contract order), not
   `{bidder, tokens, spent}`. The contract owns the bidder list; positional
   fills are smaller and the bidder check becomes a length check.
3. Bid storage is prepaid by the creator (`max_bids`), because `ft_on_transfer`
   carries no NEAR.
4. `claim` can be pushed by anyone for a bidder; funds still go only to the bidder.
5. A clearing failure that is not the enclave's fault (timeout, run failure)
   leaves the sale Closed for a retry instead of failing it at once; the settle
   timeout still guarantees refunds.
6. The commit-reveal penalty is locked in the contract forever, since USDC
   cannot be burned.
7. The commit-reveal penalty applies only when the sale is cleared on chain
   (`clear_onchain`); a sale that ends in refund mode refunds every deposit in
   full.
8. The token account is `<sale_id>.<fairground account>` (for example
   `fairt.fairground.testnet`), not `<symbol>.fairground.<network>`: sale ids
   are unique and fixed, symbols are neither.
9. The per-sale key is `HKDF-SHA256(ikm = master, salt =
   "fairground/sealer/v1", info = "sale-key" || 0x00 || contract_id || 0x00 ||
   sale_id)` (see "Sealer"), not `HKDF(master, "fairground" || sale_id)`.
   Binding the contract id means a key cannot leak through a direct OutLayer
   call made for another contract; the separators keep the input unambiguous.
10. The commitment is `sha256("fairground/commit/v1" || 0x00 || sale_id ||
    0x00 || bidder || 0x00 || u128_be(max_price) || u128_be(max_spend) ||
    salt)` with a 16-byte salt (see "Commitment"), not
    `sha256(sale_id || bidder || max_price || max_spend || salt)`: the domain
    separator and fixed-width amounts make it unambiguous. A commitment built
    from the spec's formula never matches (`CommitmentMismatch`). Scripts and
    copy that compute commitments or keys must use these formulas.
11. Invalid bids pay the 1 % penalty in both modes, not only unrevealed
    commit-reveal bids: a TEE bid the enclave finds invalid (the spec says
    "fully refunded") and a commit-reveal bid revealed but invalid. Without
    it, bid slots could be filled with junk for free and a launch blocked
    (see "Bid slots and invalid bids"). For the same reason `min_deposit` is
    at least 1 USDC. The sealer's output names the invalid bids (`invalid`)
    and its key (`pubkey`) so the contract can apply and trust the penalty.
12. The spec's gas relayer section says the 1 yoctoNEAR that
    `ft_transfer_call` needs "still comes from the bidder's account". Under
    NEP-366 it cannot: the relayer pays the gas and every deposit inside the
    delegate action, that 1 yoctoNEAR included (measured on a sandbox: the
    bidder's NEAR balance does not change at all). So a relayed bid costs
    the bidder no NEAR, and it must be signed with a full-access key (a
    function-call key cannot sign a deposit). The relayer relays the bid,
    `claim`, `claim_proceeds`, `reveal_bid`, `trigger_refund_mode` and
    `clear_onchain`; the payable methods (`create_sale`, `close_sale`,
    `retry_setup`) are never relayed (see "Meta-transactions").
13. The bid plaintext pads `max_price` and `max_spend` to 39 digits, and the
    contract accepts a TEE bid only at the exact sealed length for its sale
    id and bidder (`wrong_ciphertext_length` otherwise). The spec's plain
    `{sale_id, bidder, max_price, max_spend, salt}` JSON would let anyone
    read the number of digits of a bid's amounts from its length while
    bidding is open.
14. A run the enclave job refuses (no secret, a request signed by the
    contract account, unreadable input, ...) is a failed OutLayer run, which
    the contract sees as `null` and retries; the refusal's code is in
    OutLayer's `execution_completed` event, not in a contract event. An
    `ok:false` answer is retried too and its code is in `clearing_failed`.
