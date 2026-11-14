# Step 9: the Jury Round

The Jury Round is a real TEE sale on testnet that stays open while the judges
look at the project. A judge can bid in it from the hosted testnet app with a
testnet wallet and test USDC, without help. Ten sniper bots bid in the first
seconds. Bidding closes on **17 Nov 2026 at 12:00 UTC** and anyone can close
the sale after that. The enclave then opens the bids, every winner pays the
same price, and the supply that demand did not take is burned.

The project owner runs every command here. Nothing in this file has been run
yet. It was checked on 14 Nov 2026 against `8-evidence-sale.ps1` (agent A1's
version, with `-BidEndUtc`, `-SettleTimeoutMinutes`, `-StopAfterBids`) and
with read-only RPC calls. The Path B argument file was built in Windows
PowerShell 5.1 and `get_create_cost` accepted it.

| When (UTC) | What | Who |
| --- | --- | --- |
| Before creating | The checks in "Go or no-go" | owner |
| 14 Nov | Create the sale. Bidding opens 10 minutes later and the ten bots bid at the open | owner |
| After the bots | Add the README text below with the sale id filled in | Claude |
| 14 to 17 Nov | Judges bid from the hosted testnet app | judges |
| 17 Nov, 12:00 | Bidding ends. Anyone may close the sale | anyone, with the owner as backstop |
| 17 Nov, after the close | Seed the pool, push every claim, pay the creator (this is when the burn happens), run `verify-sale` | owner |
| 18 Nov, 12:00 | If nobody has closed the sale, anyone may switch it to refunds | anyone |

## Go or no-go

Create the sale only when checks 1, 2 and 4 hold. Publish the README text only
when check 3 holds as well.

1. **The contract is locked.** `view_access_key_list` on
   `sealround.itzbeast.testnet` must return no keys. On 14 Nov at 06:30 UTC it
   still had one full-access key. `-Phase Create` refuses to run while the
   contract has a key. Do not override that with `-AllowKeys`: a sale created
   before the lock can be read as "the owner could have opened bids early".
2. **The hosted testnet app runs the merged commit.** That commit contains the
   testnet wallet list and the "Get 10 test USDC" button. The app's env needs
   `NEXT_PUBLIC_FAIRGROUND_CONTRACT=sealround.itzbeast.testnet` and
   `NEXT_PUBLIC_NEAR_NETWORK=testnet`. It also needs `usdc.fakes.testnet` as
   the USDC contract, which is the default on testnet.
3. **One real bid from the hosted app works.** Use a phone or a fresh browser
   with a throwaway testnet account. Open a live sale on the contract: A1's
   swarm sale while it is open, or the Jury Round itself once the bots have
   bid. Then:
   1. Press **Connect wallet** and pick Meteor Wallet or Intear Wallet.
   2. Press **Get 10 test USDC** and approve. You should see "Added 10 test
      USDC. You have 10 USDC."
   3. Seal and place a bid. It should appear in the bid list.

   If any step fails, do not invite judges. The sale itself is still harmless
   (see "What can go wrong").
4. **`itzbeast.testnet` has enough NEAR.** `create_sale` costs 2.27969 NEAR on
   these terms (`get_create_cost`, read on 14 Nov). The script attaches
   2.33 NEAR and the rest comes back. New bot accounts need 0.03 NEAR each and
   0.00125 NEAR each to register on the test USDC. Plan for about 3 NEAR. The
   dry run prints the exact peak and says "NOT ENOUGH" when the account falls
   short. On 14 Nov at 06:30 UTC the account held 1.21 NEAR, so move NEAR in
   from `itzbeast-gas.testnet` first.

## The terms, and why

| Term | Value | Why |
| --- | --- | --- |
| Token | Jury Round, `JURY`, 18 decimals | |
| Sale id | `jury-<MMddHHmm>` (UTC at creation) | `-Phase Create` picks it from `-TokenSymbol` |
| Mode | TEE | Bids are opened only in the enclave |
| For sale | 200,000 JURY (`-SaleTokens 200000`) | The bots buy 55,000 at the floor. Selling out at the floor needs 145 USDC more, which is 15 judges at the 10 USDC cap. A handful of judges cannot get there, so the sale clears at the floor and burns |
| Total supply | 400,000 JURY | The script always sets total supply to twice the sale supply |
| Launch pool | 20 % of the raise and 40,000 JURY reserved, fee 0.3 % | The pool takes 20 % of the tokens sold. Whatever it does not take burns |
| Creator allocation | 160,000 JURY | Total supply minus the sale supply and the pool reserve |
| Floor price | 0.001 USDC per JURY | 10 USDC buys 10,000 JURY |
| Min raise | 5 USDC | The script sets it from the bots' demand (half of 55, capped at 5). The bots alone meet it, so the sale settles even if no judge bids |
| Deposit per account | 1 to 10 USDC | One press of "Get 10 test USDC" covers the largest bid |
| Bid slots | 64 (`-MaxBids 64`) | 10 bots plus up to 54 judges. 100 slots would cost 2.58 NEAR and 128 would cost 2.82 NEAR |
| Bidding | Opens 10 minutes after `create_sale` and ends 17 Nov 2026 12:00:00 UTC (`-BidEndUtc`, `bid_end` `1794916800000000000`) | The 10 minutes cover the token deploy, the enclave key and starting the bots. The window is about 3 days 5 hours, well under the contract's 30-day limit |
| Settle timeout | 1 day (`-SettleTimeoutMinutes 1440`) | Refund mode opens only at 18 Nov 12:00 UTC, so a late close still settles. The pool can be seeded until settlement plus 1 day. The script's default is 1 hour, which would let anyone start refunds at 13:00 on 17 Nov |
| Quote token | `usdc.fakes.testnet` | Ref Finance's test USDC. Anyone may call its `mint`, but it refuses an account that is not registered on the token, so the app registers the account first |

The bots come from the script's crowd for `-Bidders 10 -Snipers 10` at the
default `-Seed 1114`. The table below was worked out by replaying the
script's draws.

| Bot | Deposit and max spend | Max price |
| --- | ---: | ---: |
| `sniper` | 5 USDC | 0.004 |
| `swarm-01` | 6 | 0.00375 |
| `swarm-02` | 4 | 0.003 |
| `swarm-03` | 4 | 0.0035 |
| `swarm-04` | 7 | 0.003 |
| `swarm-05` | 4 | 0.00325 |
| `swarm-06` | 6 | 0.003 |
| `swarm-07` | 7 | 0.0045 |
| `swarm-08` | 4 | 0.0045 |
| `swarm-09` | 8 | 0.00425 |
| All ten | 55 USDC | |

The scenarios below assume each judge bids the 10 USDC cap at any max price at
or above the floor. The sale clears at the floor until it sells out. The burn
happens at the creator payout and covers the unsold supply plus the unused
pool reserve.

| Judges | Raised | Sold | Pool | Burned | Supply after |
| ---: | ---: | ---: | --- | ---: | ---: |
| 0 | 55 USDC | 55,000 (28 %) | 11 USDC + 11,000 JURY | 145,000 unsold + 29,000 reserve = 174,000 | 226,000 |
| 5 | 105 USDC | 105,000 (53 %) | 21 USDC + 21,000 JURY | 95,000 + 19,000 = 114,000 | 286,000 |
| 10 | 155 USDC | 155,000 (78 %) | 31 USDC + 31,000 JURY | 45,000 + 9,000 = 54,000 | 346,000 |
| 14 | 195 USDC | 195,000 (98 %) | 39 USDC + 39,000 JURY | 5,000 + 1,000 = 6,000 | 394,000 |
| 15 or more | 200 USDC | sold out | 40 USDC + 40,000 JURY | 0 | 400,000 |

With 15 or more judges the price depends on the judges' max prices. If they
bid at the floor, the price stays at the floor and their bids are filled pro
rata. If they bid higher, the price rises.

In every case the result shows the claim: the bots bid in the first seconds
and paid the same price as a judge who bid three days later.

## Create the sale and snipe the open

### Path A: `8-evidence-sale.ps1`

Run from the repo root in PowerShell. Without `-Execute` each phase only
prints its plan, and `-DryRun` is fully read-only. Pass the same crowd and
sale flags to the dry run, `Accounts` and `Create`. Later phases read the
saved sale.

```powershell
$ME = 'itzbeast.testnet'

# 1. Dry run (read-only).
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -DryRun `
  -Bidders 10 -Snipers 10 -TokenName 'Jury Round' -TokenSymbol JURY -SaleTokens 200000 -Demand Under `
  -Pool on -MaxBids 64 -StartInMinutes 10 -BidEndUtc 2026-11-17T12:00:00Z -SettleTimeoutMinutes 1440 -StopAfterBids
```

Before going on, check that the dry run shows all of the following:

- 200,000 tokens for sale of 400,000, a floor of 0.001 USDC, a min raise of
  5 USDC and a max deposit of 10 USDC
- 64 bid slots and pool on
- bidding ending at 2026-11-17 12:00 UTC, "settle timeout 1440 min" and "Bid
  stops after these bids and leaves the sale open."
- the ten bots from the table above
- an expected clearing at the floor, undersubscribed, selling 55,000 of
  200,000
- create_sale costing about 2.28 NEAR, and no "NOT ENOUGH"
- "No access keys ... locked" for the contract

If any of these is wrong, stop.

```powershell
# 2. Bot accounts: creates the missing swarm-NN accounts, tops up NEAR, registers them on the test USDC and mints each up to 10 USDC.
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Phase Accounts `
  -Bidders 10 -Snipers 10 -TokenName 'Jury Round' -TokenSymbol JURY -SaleTokens 200000 -Demand Under `
  -Pool on -MaxBids 64 -StartInMinutes 10 -BidEndUtc 2026-11-17T12:00:00Z -SettleTimeoutMinutes 1440 -StopAfterBids -Execute

# 3. The sale. Refuses while the contract has a key, then waits for the token and the enclave key.
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Phase Create `
  -Bidders 10 -Snipers 10 -TokenName 'Jury Round' -TokenSymbol JURY -SaleTokens 200000 -Demand Under `
  -Pool on -MaxBids 64 -StartInMinutes 10 -BidEndUtc 2026-11-17T12:00:00Z -SettleTimeoutMinutes 1440 -StopAfterBids -Execute
```

`Create` prints the sale id, for example `jury-11141430`. Set it, then start
the bots straight away, before the open. The snipers wait for the open and
bid in the first block they can. Half of them poll FastNear and half poll
`rpc.testnet.near.org`, because ten bots on one free endpoint from one machine
get rate limited. On 14 Nov FastNear answered 429 to every call from one
machine while other agents were running.

```powershell
$SALE = 'jury-11141430'   # the id Create printed

# 4. The snipe. Returns once the ten bids have landed and leaves the sale open.
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Phase Bid -SaleId $SALE `
  -BotRpc 'https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org' -Execute
```

Each bot's output goes to `enclave\deploy\out\testnet\run-<sale>\`, and the
run log is `run-<sale>.json`. The phase can be run again: bots that already
have a bid are skipped. A bot that misses the open bids late, which is fine.

The sale description comes from the script ("Sealround evidence sale: 10
sniper bots; one clearing price, the unsold supply burned, and a Rhea pool
opened at that price. Testnet; the token has no value."). The icon is the
script's crosshair.

### Path B: near CLI and the live bot, if the script cannot create the sale

The terms are the same. Only the icon and the description differ. Run step 2
of Path A first anyway, because it makes and funds the bot accounts. The
sale's arguments go into a file, so no JSON passes through the command line.

```powershell
$ME = 'itzbeast.testnet'
$FG = "sealround.$ME"
$SALE = 'jury-' + [DateTime]::UtcNow.ToString('MMddHHmm')
$one = '000000000000000000'   # 18 decimals
$startNs = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds() * 1000000
$svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b0d12'/>" +
  "<path d='M32 12v40M18 52h28' stroke='#f7f8f8' stroke-width='4' stroke-linecap='round'/>" +
  "<path d='M14 22h36' stroke='#3d7eff' stroke-width='4' stroke-linecap='round'/>" +
  "<path d='M14 22l-6 14h12zM50 22l-6 14h12z' fill='none' stroke='#3d7eff' stroke-width='3' stroke-linejoin='round'/></svg>"
$params = [ordered]@{
  sale_id = $SALE
  token_name = 'Jury Round'
  token_symbol = 'JURY'
  decimals = 18
  icon = 'data:image/svg+xml,' + [Uri]::EscapeDataString($svg)
  total_supply = "400000$one"
  sale_supply = "200000$one"
  floor_price = '1000'
  min_raise = '5000000'
  bid_start = "$startNs"
  bid_end = '1794916800000000000'
  min_deposit = '1000000'
  max_deposit_per_account = '10000000'
  max_bids = 64
  reveal_mode = 'Tee'
  settle_timeout = '86400000000000'
  quote_token = 'usdc.fakes.testnet'
  description = 'Sealround Jury Round: a live sealed-bid sale open to judges until 17 Nov 2026 12:00 UTC. Ten bots bid at the open. Every winner pays one price, and the supply demand does not take burns. Testnet; the token has no value.'
  liquidity = [ordered]@{ raise_share_bps = 2000; pool_tokens = "40000$one"; fee_bps = 30 }
}
$out = 'enclave\deploy\out\testnet'
New-Item -ItemType Directory -Force $out | Out-Null
$createArgs = "$out\create-$SALE.json"
$idArgs = "$out\sale-id-$SALE.json"
[IO.File]::WriteAllText($createArgs, (ConvertTo-Json ([ordered]@{ params = $params }) -Depth 5 -Compress))
[IO.File]::WriteAllText($idArgs, (ConvertTo-Json ([ordered]@{ sale_id = $SALE }) -Compress))

# Cost (read-only). Expect "2279000000000000000000005" (2.279 NEAR).
near contract call-function as-read-only $FG get_create_cost file-args $createArgs network-config testnet now

# Create. What is attached above the cost comes back.
near contract call-function as-transaction $FG create_sale file-args $createArgs prepaid-gas '300 Tgas' attached-deposit '2.35 NEAR' sign-as $ME network-config testnet sign-with-keychain send

# Wait until token_setup and sealer_key_setup are both "done" (one to three minutes).
near contract call-function as-read-only $FG get_sale file-args $idArgs network-config testnet now
```

If the key step ends `failed`, call `retry_setup`; see `enclave\README.md`,
Troubleshooting. Then start the ten snipers with the terms from the bot table.
They wait for the open.

```powershell
$bots = @(
  @{ n = 'sniper'; d = 5; p = '0.004' },    @{ n = 'swarm-01'; d = 6; p = '0.00375' },
  @{ n = 'swarm-02'; d = 4; p = '0.003' },  @{ n = 'swarm-03'; d = 4; p = '0.0035' },
  @{ n = 'swarm-04'; d = 7; p = '0.003' },  @{ n = 'swarm-05'; d = 4; p = '0.00325' },
  @{ n = 'swarm-06'; d = 6; p = '0.003' },  @{ n = 'swarm-07'; d = 7; p = '0.0045' },
  @{ n = 'swarm-08'; d = 4; p = '0.0045' }, @{ n = 'swarm-09'; d = 8; p = '0.00425' }
)
$root = (Get-Location).Path
$i = 0
$jobs = foreach ($b in $bots) {
  $rpc = if ($i++ % 2) { 'https://rpc.testnet.near.org' } else { 'https://rpc.testnet.fastnear.com' }
  $id = "$($b.n).$ME"
  Start-Job -ArgumentList $root, $id, $b.d, $b.p, $rpc, $FG, $SALE -ScriptBlock {
    param($root, $id, $deposit, $price, $rpc, $fg, $sale)
    Set-Location $root
    pnpm --filter web live-bot snipe --network testnet --rpc $rpc --contract $fg --sale $sale `
      --account $id --key-file "$HOME\.near-credentials\testnet\$id.json" `
      --deposit $deposit --max-spend $deposit --max-price $price --poll-ms 1000 --direct
  }
}
$jobs | Wait-Job | Receive-Job
```

With `--direct` each bot pays its own gas. If the Fly relayer is up, use
`--relayer <url>` instead. Each job prints its transaction hash and how long
after the open it landed. Keep these for the report.

### After the bots

- The sale page (or `get_bids_summary`) shows 10 bids. The "What the chain
  sees" block says every sealed bid is the same size.
- Open the sale on the hosted testnet app at 1440 and at 375 wide. You should
  see "Live", the countdown to 17 Nov 12:00 UTC, and "Get 10 test USDC" at the
  top of the bid form.
- Send Claude the sale id and the bots' transaction hashes (Path A: the run
  log) for the README.

## Text for the README: "Bid in the Jury Round"

Replace `<APP>` with the hosted testnet app's origin and `<SALE>` with the
sale id.

```markdown
### Bid in the Jury Round (open until 17 Nov 2026, 12:00 UTC)

A real sealed-bid sale on NEAR testnet, open through judging. Ten sniper bots
bid in the first seconds after it opened. Bid any time before the close: if
you win, you pay the same price they do.

| Do | You should see |
| --- | --- |
| Open <APP>/sale/<SALE> | "Jury Round", Live, a countdown to 17 Nov 12:00 UTC, and the bots' sealed bids, every one the same size |
| Press **Connect wallet** and pick **Meteor Wallet** or **Intear Wallet**. Both run in the browser; HOT and MyNearWallet have no testnet mode. No testnet account or testnet NEAR yet? Create a testnet account in the wallet, then get testnet NEAR at https://near-faucet.io | Your testnet account in the top bar |
| In **Place a sealed bid**, press **Get 10 test USDC** and approve in your wallet. The first time, the wallet may also ask for 0.00125 NEAR so your account can hold the token | "Added 10 test USDC. You have 10 USDC." The token is `usdc.fakes.testnet`: free, and worth nothing |
| Pick a max price (the **Floor** preset is fine) and a max spend of up to 10 USDC, press **Seal and place bid** and approve | Your bid is sealed in your browser and appears in the bid list, the same size as every other bid. Nobody can read your price, not even us |
| Come back after 17 Nov 12:00 UTC. If the page shows **Close sale**, anyone may press it. It attaches a small NEAR deposit for the enclave run (about 0.014 NEAR), and OutLayer returns what the run does not use | "Opening the sealed bids in the enclave", then the result: one clearing price for every winner, bots included, and the supply nobody bought burned |
| Check the result yourself: `pnpm install`, then `pnpm --filter web verify-sale --contract sealround.itzbeast.testnet --sale <SALE>` | Every attestation check and the bid set pass |

You can claim your tokens and any unspent USDC on the result page. We also
push every claim after the close. If nobody closes the sale by 18 Nov 12:00
UTC, anyone can press **Switch to refunds**, and every deposit comes back in
full.
```

## 17 Nov: close, seed, claims, burn, verify

Bidding ends at 12:00:00 UTC. A judge may close the sale first. If nobody has
closed it soon after, close it yourself.

**Path A.** The Close phase does everything below except the judges' claims:

1. It waits for the end of bidding.
2. It calls `close_sale`, attaching at least 0.02 NEAR (1.25 times
   `get_close_deposit`). It skips this step if someone else has already closed
   the sale.
3. It waits for the result.
4. It seeds the pool.
5. It claims for the ten bots.
6. It calls `claim_proceeds`, which does the burn.

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Phase Close -SaleId $SALE -Execute
```

The script prints "<account> is not one of this script's bidders: it claims
on its own" for each judge. Push those claims with the snippet below. Anyone
may push a claim, and the tokens and the unspent USDC always go to the bidder.
Then write the evidence.

```powershell
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account $ME -Phase Report -SaleId $SALE
```

**Path B, or the judges' claims after Path A.** Run from the repo root with
`$ME` and `$SALE` set. The `Read-View` helper reads the contract over RPC
without signing. It was tested in Windows PowerShell 5.1 against
`nosnipe-11140458`.

```powershell
$FG = "sealround.$ME"
$out = 'enclave\deploy\out\testnet'
$idArgs = "$out\sale-id-$SALE.json"
[IO.File]::WriteAllText($idArgs, (ConvertTo-Json ([ordered]@{ sale_id = $SALE }) -Compress))
function Read-View([string]$Method, $ArgsObject) {
  $a = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $ArgsObject -Compress)))
  $body = ConvertTo-Json -Depth 5 -Compress ([ordered]@{ jsonrpc = '2.0'; id = 'runbook'; method = 'query'
    params = [ordered]@{ request_type = 'call_function'; finality = 'final'; account_id = $FG; method_name = $Method; args_base64 = $a } })
  $r = Invoke-RestMethod -Method Post -Uri 'https://rpc.testnet.near.org' -ContentType 'application/json' -Body $body
  if ($r.error) { throw ($r.error | ConvertTo-Json -Depth 5 -Compress) }
  if ($r.result.error) { throw $r.result.error }
  $value = [Text.Encoding]::UTF8.GetString([byte[]]$r.result.result) | ConvertFrom-Json
  $value   # unrolls a JSON array into its items
}

# 1. Close (skip if the sale is already clearing or settled). The contract asks for at least get_close_deposit,
#    about 0.01401 NEAR for 64 bids or fewer; OutLayer returns what it does not use.
Read-View 'get_close_deposit' ([ordered]@{ sale_id = $SALE })
near contract call-function as-transaction $FG close_sale file-args $idArgs prepaid-gas '300 Tgas' attached-deposit '0.02 NEAR' sign-as $ME network-config testnet sign-with-keychain send

# 2. The result: wait for "settled". Expect clearing_price "1000" (the floor) unless 15 or more judges bid the cap.
Read-View 'get_result' ([ordered]@{ sale_id = $SALE }) | Select-Object status, clearing_price, sold, unsold

# 3. The launch pool, at exactly the clearing price. Run it again until liquidity.status is "seeded"
#    (steps already done are skipped). Bidders' tokens stay locked until then.
near contract call-function as-transaction $FG seed_liquidity file-args $idArgs prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send

# 4. Push every unclaimed claim.
$todo = @(Read-View 'get_bids' ([ordered]@{ sale_id = $SALE; from_index = 0; limit = 64 }) | Where-Object { -not $_.claimed } | ForEach-Object { [string]$_.bidder })
foreach ($bidder in $todo) {
  [IO.File]::WriteAllText("$out\claim.json", (ConvertTo-Json ([ordered]@{ sale_id = $SALE; bidder = $bidder }) -Compress))
  near contract call-function as-transaction $FG claim file-args "$out\claim.json" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
}

# 5. Pay the creator (Path B only; Path A did it). Burns the unsold supply and the unused pool reserve.
near contract call-function as-transaction $FG claim_proceeds file-args $idArgs prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
```

Then, on either path:

```powershell
pnpm --filter web verify-sale --contract sealround.itzbeast.testnet --sale $SALE
```

To check the burn, read `ft_total_supply` on `<sale>.sealround.itzbeast.testnet`.
It should be 400,000 JURY minus the burned amount from the scenario table, and
the result page's "Where every token went" should add up. Send Claude the
close, seed and `claim_proceeds` transaction hashes, the `verify-sale` output
and (Path A) the Report files.

## If nobody closes it

Nothing is lost. These are the contract's rules, from `contracts/DESIGN.md`
(States) and `trigger_refund_mode` in `contracts/fairground/src/settle.rs`:

- After 17 Nov 12:00 UTC the sale is `awaiting_close`. Anyone may call
  `close_sale` at any time, even after 18 Nov 12:00, until someone starts
  refund mode.
- From `bid_end` plus the settle timeout, which is **18 Nov 2026 12:00 UTC**,
  anyone may call `trigger_refund_mode` (the **Switch to refunds** button on
  the sale page). The sale becomes `failed` with reason `refund_mode`. Every
  bidder can then claim the whole deposit back, with no invalid-bid penalty.
  The pool is cancelled and its reserve burns, and `claim_proceeds` burns the
  sale supply.
- If the enclave does not answer a close (OutLayer down or slow), the sale
  stays `closed` and anyone may call `close_sale` again. In that case the
  1-day refund timer starts from that first close.
- After settlement the pool can be seeded until settlement plus 1 day. After
  that anyone may call `abandon_liquidity`, which unlocks the tokens.

## What can go wrong

- **No wallet bid works from the hosted app.** Do not publish the README text.
  The sale still runs with the bots and settles on 17 Nov at the floor with a
  burn, which is evidence on its own.
- **Bid slots filled with junk.** Test USDC is free, so someone with many
  testnet accounts could fill the 54 open slots with 1 USDC bids and lock
  judges out. Each junk bid loses at most 1 % of a worthless deposit. At
  hackathon scale this is unlikely. 100 slots would cost 0.30 NEAR more, and
  128 slots 0.54 NEAR more.
- **Rate-limited RPC.** The free FastNear endpoint limits each IP address. A
  judge's browser has its own address and should be fine. The bots all run on
  one machine, which is why they are split over two endpoints. FastNear's 429
  answers carry no CORS header, so a rate-limited browser shows "blocked by
  CORS policy" in the console.
- **A judge has no testnet NEAR.** Without the relayer, the judge's wallet pays
  for the bid, the USDC registration and the mint: a few thousandths of a NEAR,
  plus 0.00125 NEAR once for the registration. If the Fly relayer is up,
  Meteor and Intear can sign gasless bids. The mint is always paid by the
  wallet. Creating a testnet account inside Meteor or Intear was not checked.
- **The wallet list comes from GitHub at run time.** NEAR Connect loads its
  wallet manifest from `raw.githubusercontent.com` on each visit. If that
  fails, the app now says "No NEAR testnet wallet could be loaded. Reload the
  page and try again." instead of showing an empty picker.
- **`usdc.fakes.testnet` is someone else's token.** Its owner could change it.
  Anyone can also call its `set_decimals` and `set_token_name`. Those calls
  change only how wallets display amounts, not the amounts on chain.
