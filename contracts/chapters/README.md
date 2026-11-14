# Meme Chapters contract

An optional NEP-141 escrow for a token's post-launch story. One contract binds
one voting token and one quote token. The sale and token contracts retain
their existing code. Rhea continues to handle swaps.

Build the contract from the repository root, with the workspace lockfile:

```powershell
cargo near build non-reproducible-wasm --locked --no-abi --manifest-path contracts/chapters/Cargo.toml
cargo near build non-reproducible-wasm --locked --no-abi --manifest-path contracts/chapters/factory/Cargo.toml
cargo test -p sealround-chapters -p sealround-chapters-factory --locked
cargo clippy -p sealround-chapters -p sealround-chapters-factory --all-targets --locked -- -D warnings
```

The optimized sandbox WASM is in
`target/near/sealround_chapters/sealround_chapters.wasm`. Submission storage,
lineage and receipt identifiers require a fresh local deployment. The factory
artifact is `target/near/sealround_chapters_factory/sealround_chapters_factory.wasm`.
Keep deployments and signing on a local sandbox during development.

## Enabling a story

The sandbox fixture publishes the escrow WASM as a global contract by code
hash. It then deploys the factory and initializes it with the pinned sale
account and the published hash. The factory account ID can be up to 32 bytes.
The older Lantern fixture still initializes a standalone escrow directly.

The sale creator calls `enable_chapters({sale_id, title, brief})` with at least
160 TGas and the exact deposit returned by `enable_cost()`. The factory reads
`get_sale` from the configured sale contract and checks that the sale is
settled and the caller is its creator. The escrow account is unique to the
sale and has no keys. It uses the configured global code hash and the voting
and payout tokens from the sale record. The deposit funds permanent registry
storage and the child account's starting storage. An authenticated concurrent
request receives its deposit back. A failed deployment releases its slot and
returns the setup deposit separately from transaction fees.

`get_chapters({sale_id})` returns the immutable title, brief and escrow details
when a deployment is pending or complete. Wait for `phase == "enabled"`
before using the escrow. Each round created through the factory requires two
wallet-signed artwork entries.

The creator reviews the factory cost and both tokens' NEP-145 minimums. After
deployment the creator's wallet registers the escrow directly with each token.
This sends any duplicate-registration refund back to the payer. The app reads
both registrations before continuing and skips completed registrations on a retry.
Payout recipients also need quote-token storage registration.

## How rounds work

1. The curator invites two to eight named artists using
   `set_artists({round_id, artists})` and the deposit from
   `artist_roster_cost({round_id})`. After the first list, changes cost zero
   and may replace unused invitations. Signed submissions keep their slots.
   An invited artist can use `submit_art({round_id, title, mime_type, image_base64,
   parent_sha256})` to submit their artwork for the next round. Each account
   signs for its own entry and prepays the exact quote from
   `art_storage_cost({byte_length})`. The quote reserves the file size plus
   512 bytes for metadata and storage keys. The contract stores the bytes
   and computes their SHA-256. It accepts standard padded base64, matches the
   JPEG, PNG or WebP signature against `mime_type`, and caps files at 48 KiB.
2. The curator creates a round with two `submission_ids` and the matching
   candidate titles, content digests and artist accounts in ballot order.
   Artists and digests must be distinct. The round also records a sponsor,
   an exact bounty, a minimum revealed weight and three fixed times. Amounts
   are strings in token base units and times are strings in nanoseconds.
   The bundled-art fixture path can omit `submission_ids` when the round
   has zero submissions and the previous round used bundled art or does
   not exist. Its digests refer to externally hosted bytes.
3. The curator attaches the amount returned by
   `storage_cost({max_voters})` to `create_round`. This reserves round state
   and every indexed vote slot, currently 2,048 plus 512 bytes per slot at NEAR's
   storage cost. This storage reserve remains in the contract, including unused
   slots. Votes and their claim state remain readable after finalization.
4. Before the start, the named sponsor calls the quote token's
   `ft_transfer_call` with the exact bounty and message
   `{"kind":"fund","round_id":1}`. An unfunded round never accepts votes.
5. During commit, a holder calls the voting token's `ft_transfer_call` with
   at least the round's `min_lock` and message
   `{"kind":"commit","round_id":1,"commitment":"<lowercase hex>"}`.
   The minimum is the quorum divided by voter slots, rounded up in base
   units. A refused transfer returns the full amount using the token's resolver.
6. The browser generates the 32-byte salt with Web Crypto and saves it with
   the candidate index before sending the lock.
   Keep a backup under the voter's control until the vote is revealed. The
   commitment is the lowercase hex SHA-256 of the UTF-8 preimage
   `sealround-chapter-v1|<chapters account>|<round id>|<voter account>|<0 or 1>|<64 lowercase salt hex>`.
   After commit closes, the same account calls
   `reveal({round_id, candidate_index, salt})`. Lock amounts and identities
   are public. Choices become public at reveal.
7. Anyone calls `finalize({round_id})` after reveal ends or once an unfunded
   round misses its start. If the revealed weight meets quorum and one
   candidate has more weight, the on-chain winner identifies the next panel
   and its artist. Round 1 artwork has a null `parent_sha256`. The next
   round's submitted artwork must differ from the most recent winning panel
   and name that winner's digest as its parent. A tie, missed quorum or
   unfunded round keeps its own history. A fresh attempt uses the most recent
   winner, or a null parent if a winner has yet to be published.
8. Each holder can call `withdraw_vote({round_id})` even if they missed the
   reveal. The winning artist calls `claim_bounty({round_id})`. The sponsor
   can claim the bounty back after a funded tie or missed quorum. Each claim
   takes one yoctoNEAR and at least 70 TGas. The contract reserves 30 TGas for
   the token transfer and 15 TGas for its callback. Only the recipient can
   claim, and the contract records pending and paid states.

Read `get_config()`, `get_round_count()`, `get_round({round_id})` and
`get_vote({round_id, account_id})` to show the state. Round IDs start at 1.
The round's `locked` and `revealed` fields record cumulative weights, while
`withdrawal_state` records whether an individual lock was returned.

## Public verification

- `get_votes({round_id, from_index, limit})` returns votes in commit order,
  starting at zero. The default page size is 32 and the maximum is 64. Each
  row gives the account, amount, commitment, revealed choice if any, and
  withdrawal state. The page index never changes once a vote is accepted.
  Sum the weights of revealed choices and compare them with the reported
  tally and quorum. An unrevealed vote contributes to `locked` but not to
  either candidate's tally.
- `get_round` lists the frozen SHA-256 digest and optional submission ID for
  each candidate. `get_submissions({round_id})` returns the immutable entry
  metadata in arrival order. `get_art({round_id, submission_id})` returns
  the original base64 bytes for an entry or null. Decode and hash the bytes
  and compare them with the digest on the round. Compare `parent_sha256`
  with the preceding round's winning candidate digest to verify the link.
- `get_payout({round_id})` returns the recipient, quote token, amount, state
  and a nullable `paid_at` in nanoseconds, plus the latest numeric `attempt`.
  It returns null until the outcome is final or when the round was unfunded.
  A successful token-transfer callback records the payment and confirmation
  time. Failed or pending transfers have no payment timestamp. Inspect the
  quote token transfer receipt for `Sealround chapter {round_id} payout
  {attempt}` and the Chapters callback event `bounty_payment` for the same
  round, attempt, recipient, amount, token and payment time.

## Limits

The curator chooses the ballot before opening each round. There are up to
64 rounds, eight submissions from distinct accounts per round, and 512 voter
slots per round. Submissions stay public whether or not they are selected.
The parent digest records which work the artist chose to continue. The
artist and curator decide how the visual work builds on it. Funding and
voting deadlines cannot be extended. Slots are first come, first served.
Votes carry the weight of tokens actually locked. Splitting tokens across
accounts can still use multiple slots if every lock meets the minimum.
Artists rely on the curator for invitations and selection. Larger holders can decide
an outcome. Missing a reveal forfeits the vote, with the lock still
withdrawable after finalization. Each bounty has its own sponsor and escrow.

Token transfers are asynchronous. An observed failure, including a missing
storage registration, makes the claim retryable. A pending transfer with no
conclusive callback remains pending to avoid duplicate payment. Fund and vote
through `ft_transfer_call`. A direct `ft_transfer` to the contract does
not open a tracked claim.
