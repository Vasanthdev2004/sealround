# Test Meme Chapters locally

Run from the repository root after `pnpm install`. Docker needs the cached
`debian:trixie-slim` image and the NEAR sandbox 2.14.0 binary used by
`scripts/sandbox.ps1`. The runner opens a random loopback port and removes its
own container when it finishes. Each run uses a fresh chain and local keys.

```powershell
cargo near build non-reproducible-wasm --locked --no-abi --manifest-path contracts/chapters/Cargo.toml
pnpm --filter web exec tsx scripts/chapters/sandbox.ts
```

Use `--wasm <path>` to select a different artifact. The path is relative to
the repository root unless absolute. The default is
`target/near/sealround_chapters/sealround_chapters.wasm`.

The test launches a local Lantern sale with the existing sale contract and
checks that the voters receive the sale token. Two artists sign and submit
their own images. The curator selects the entries, sponsors fund the bounty,
and holders vote, reveal and finalize both chapters on the separate contract.
The second chapter uses the first winning panel's SHA-256. The test checks both artists' payouts,
holder withdrawals including a missed reveal, rejected funding and voting
transfers, duplicate actions, retries after failed token transfers, and
sponsor refunds after a tie or missed quorum. It reconstructs the tally from
public vote pages and checks finalized token transfers and their callback
receipts, including a successful retry after a failed transfer.

## Fair Test creator setup

Build the factory as well as the escrow. Run the factory integration
against a fresh sandbox or leave it running for the browser.

```powershell
cargo near build non-reproducible-wasm --locked --no-abi --manifest-path contracts/chapters/factory/Cargo.toml
pnpm --filter web exec tsx scripts/chapters/sandbox.ts --fair-test
pnpm --filter web exec tsx scripts/chapters/sandbox.ts --serve --fair-test
```

The automated run checks that only the settled sale creator can open the
story, that the factory creates a keyless child from the published code
hash, and that both token registrations succeed. It then runs the linked
chapters and verifies both payouts against finalized receipts.

The fixture settles Fair Test and configures `NEXT_PUBLIC_CHAPTERS_FACTORY`.
Load its `sandbox.env` in an isolated web dev process as shown below and
open `http://localhost:3101/token/fairt#meme-chapters`. Connect the sale
creator, `sponsor.test.near`, and choose **Enable Chapters**. Give the story
a title and artist brief. Review the setup deposit and confirm. The factory
reads the settled sale and creates a keyless escrow with the sale's voting
token and payout token. Use **Register escrow** to review and pay the two
token registration deposits before accepting funds. Each registration can
be retried on its own.

Switch to Mira and Sora to submit two artworks, then switch back to the
creator to select both, create the round and fund its bounty. Follow the
voting and payout steps below with FAIRT as the voting token.

## Lantern fixture

For the original browser fixture run the sandbox command with `--serve --creator`. It
launches Lantern and leaves the Chapters contract empty. The first connected
wallet is `sponsor.test.near`, the curator. In the wallet menu switch to
`mira.test.near` and `sora.test.near` in turn. Use **Submit artwork** to pick
a different JPEG, PNG or WebP from each wallet. Review the 48 KiB preview
and exact storage deposit before confirming. Switch back to the sponsor,
open **Set up chapter**, select both entries, review the terms and exact
storage deposit, create it, then use **Fund artist bounty**.
`--serve` alone seeds a completed first chapter and opens the second for five
minutes of voting followed by five minutes of reveals. Keep the fixture running
while you use it. It prints the path to its ignored `sandbox.env` file. Use that file only
with a dev server bound to localhost. It contains generated sandbox keys.
If a Next dev server is already running from this checkout, use an isolated
checkout for the browser fixture so the servers have separate `.next`
directories. Run the following in a dedicated PowerShell session from the
`apps/web` you want to serve. Set the path to the ignored file the fixture printed.

```powershell
$fixtureEnv = 'scripts/chapters/.run/sandbox.env'
foreach ($line in Get-Content -LiteralPath $fixtureEnv) {
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}
node node_modules/next/dist/bin/next dev --hostname localhost --port 3101
```

Open `http://localhost:3101/token/lantern#meme-chapters`. Switch to
`alice.test.near` and lock enough LNTN to meet the chapter quorum. After the
commit deadline, follow the reveal link in Activity and reveal from the same
browser. **Add reveal reminder** downloads a calendar event. Import it into a
calendar to receive the alert. After the reveal deadline, finalize, withdraw
the lock, and switch to the winner to claim the bounty. After the first round,
the second submission form shows the winning panel. Submit two new panels
that continue it, then repeat the curator and voting steps.

After a bounty claim, **Run public checks** checks the tally, both artwork
hashes, the payout record and the token transfer receipt. The claimant's
browser fills in the transaction hash and can copy a verification link.
Visitors can open that link, or paste the claim hash, and run the checks
without connecting a wallet. The evidence JSON includes the linked transfer
and callback receipt IDs. These lookups require the same sandbox and its
transaction history. The browser-only demo simulates payments.

To fast-forward, read
`starts_at`, `commit_end` and `reveal_end` from `get_round` and pass the target
time to the existing `Chain.advanceTo` sandbox helper. Stop the local fixture with Ctrl+C and
close the dev shell. If an interrupted shell leaves the container running,
remove the exact container name printed by the fixture with `docker rm -f`.

## Owner handoff for NEAR testnet

Use a separate testnet app deployment configured for the sale contract that the
factory will read. Confirm that the sale contract uses the configured test USDC
and that an independent creator can settle a sale and holders can claim its
token. The factory supports one escrow per settled sale. The escrow has no
access keys and stores Chapter artwork, vote locks and bounty funds separately.
Trading stays on Rhea.

Reserve a testnet factory
account of at most 32 characters and provision it and the global code publisher
with testnet NEAR. The owner runs the following commands with their own testnet
signer. `sign-with-keychain` assumes the owner already has the signing accounts
in the NEAR CLI keychain. The publication fee for code stored globally is a
one-time charge to the publisher. See
[NEAR Global Contracts](https://docs.near.org/smart-contracts/global-contracts).

Run the helper with PowerShell from the repository root. The first command
builds both artifacts and prints their hashes and factory init arguments.
The next two commands sign and send testnet transactions. The defaults are
`itzbeast.testnet`, `chapters.itzbeast.testnet` and
`sealround.itzbeast.testnet`. Override them with `-Publisher`, `-Factory`
and `-SaleContract` as needed.

```powershell
./apps/web/scripts/chapters/testnet.ps1 -Build
./apps/web/scripts/chapters/testnet.ps1 -PublishEscrow
./apps/web/scripts/chapters/testnet.ps1 -DeployFactory
```

Wait for the global code publication to finish before initializing the factory.
Keep both deployment hashes and the local WASM hashes for the release evidence.
The deploy helper also calls the factory's public `enable_cost` view.
Set `NEXT_PUBLIC_CHAPTERS_FACTORY` to the initialized account in the testnet
app's build environment, alongside `NEXT_PUBLIC_NEAR_NETWORK=testnet` and its
existing sale contract and RPC values. Omit `NEXT_PUBLIC_DEV_ACCOUNTS`. Use an
RPC that serves finalized transaction receipts. If the primary node prunes
older claims, add a receipt-capable testnet endpoint to
`NEXT_PUBLIC_NEAR_RPC_FALLBACKS`.

1. Have the independent sale creator open the settled token page, choose
   **Enable Chapters**, review the setup deposit and sign with a testnet wallet.
   Register the escrow with the voting and payout tokens. Approve each
   registration separately if the wallet opens a new page.
2. Have two artists upload and sign their own distinct Chapter 1 panels. The
   creator selects both, reviews the timings, quorum and selected panels, and
   creates the round. The designated sponsor signs **Fund artist bounty**.
   Each signer needs testnet NEAR for gas. The sponsor needs enough of the
   sale's payout token.
3. Have holders lock their sale tokens and seal their votes. Save the reveal
   code privately until reveal. Use Activity or the calendar reminder after
   voting closes and reveal before the deadline. After it ends, finalize and
   have holders withdraw their locks. The winner claims the bounty. If their
   wallet needs payout-token registration, review and confirm its storage
   deposit and then claim.
4. Have the artists continue the winning panel for Chapter 2. The submission
   form binds both entries to the winner's SHA-256. Repeat selection, funding,
   voting, revealing and payout with returning holders.
5. Open each payout verification link in a signed-out browser and run the
   public checks. If the claimant's browser has no transaction hash, paste the
   claim hash from the wallet's history. Publish the token page, two verification
   links, two evidence JSON files and two claim hashes for judges. Check each
   export identifies the winning artist and quote asset, matches the amount and
   contains both receipt IDs. The tally and artwork checks are public. Never
   include a private reveal code or wallet recovery material in evidence.
