<#
.SYNOPSIS
Step 8: the live evidence sales on testnet. One sale per run: a crowd of
bidder accounts (sniper bots, people on a schedule, a copycat, a late bid)
bids in a real Sealround sale, which is closed and cleared (by the enclave,
or on chain in commit-reveal mode), its Rhea pool seeded, and every claim
made. The report holds every transaction, block and timing for README
section 7, and a settled sale is added to evidence/sales.json.

.DESCRIPTION
Run the phases in order. Each phase prints its commands; -Execute runs them
after you type the network name. Nothing here signs without -Execute, and
the project owner runs it: it signs as -Account and as the bidder accounts.
-DryRun is read-only: the whole plan, the bidders and what it costs in NEAR.

  Accounts  Creates the missing bidders as sub-accounts of -Account
            (-FundNear NEAR each; near CLI saves their keys to the legacy
            keychain, ~/.near-credentials/<network>/<account>.json, where
            the bot reads them), tops up bidders low on NEAR, registers them
            on the test USDC and mints each up to 10 USDC. Skips what is done.
  Create    Reads the contract's access keys and refuses unless there are
            none (-AllowKeys overrides), creates the sale (bidding opens
            -StartInMinutes from now), saves the sale and its crowd in
            deploy\out\<network>\evidence-sale-<sale>.json and waits for the
            sale's setup. With -SaleId of a sale that exists, it only saves
            and waits.
  Bid       Run it before the open. Starts the snipers as parallel
            background processes that wait for the open and bid in the
            first block they can, and the copycat (it waits for its victim's
            bid). Then the people bid on a seeded schedule over
            -PeopleMinutes and the late bidder in the last two minutes. A bid
            that fails before it lands is tried once more through the next
            -BotRpc URL. With -StopAfterBids the sale is left open after
            these bids (close it later with -Phase Close).
  Close     After bid_end. TEE: close_sale, and the enclave clears the sale.
            Commit-reveal: close_sale, every bidder reveals, then
            clear_onchain once the reveal window is over. Then
            seed_liquidity (when the sale has a pool), every bidder's claim,
            and claim_proceeds, where the unsold supply burns.
  Report    Read-only. Markdown and JSON in deploy\out\<network>\evidence-
            <sale>.{md,json}: every transaction and block, ms after the
            open, ciphertext lengths, fills, and the contract's access keys
            when the sale was created and now. Adds a settled sale to
            evidence/sales.json once.

Every phase can be run again after a failed step: it reads what is done on
chain first and leaves those steps out. Later phases read the sale from
evidence-sale.json (the newest) or, with -SaleId, from its own file.

The crowd. -Bidders N accounts: -Snipers K sniper bots; of the rest, one
copycat (when 2 or more are left), one late bidder (3 or more, never with
-StopAfterBids) and people. The six bidders of the first evidence sale keep
their names and terms (sniper; ravi, ana and mei as the first people; copy,
which replays ravi's bid because their ids have the same length; late).
The others are swarm-01, swarm-02, ... with terms drawn from -Seed: snipers
deposit 4 to 8 USDC at 3 to 5 times the floor; people 2 to 8 USDC, a
quarter of them below twice the floor, some with a max spend under their
deposit. -FreshAccounts uses only swarm-NN accounts, so every bidder id, and
every sealed bid, has the same length.

The supply. -Demand Over sizes the sale so the valid bids at twice the
floor buy it exactly: it clears at twice the floor. -Demand Under makes it
2.5 times what the bids buy at the floor: it clears at the floor and about
60 % of the sale supply burns at claim_proceeds. -SaleTokens sets it by
hand. The total supply is twice the sale supply. With -Pool on, 20 % of the
raise and 20 % of the sale supply open a Rhea pool at the clearing price.

The defaults are the first evidence sale: 6 bidders, 1 sniper, TEE, pool,
10,000 NOSNIPE for sale, clearing at 0.002, eight bid slots.

.PARAMETER Account
The owner: creates the bidder accounts and the sale, and signs close_sale,
clear_onchain, seed_liquidity and claim_proceeds.

.PARAMETER Contract
Default sealround.<Account>.

.PARAMETER SaleId
Default <symbol>-<MMddHHmm> (UTC) in phase Create. Later phases read the
newest sale from evidence-sale.json unless -SaleId names another.

.PARAMETER Rpc
Comma-separated RPC URLs for this script's own reads, tried in turn when one
is rate limited. Default: the network's rpcUrl in networks.json.

.PARAMETER BotRpc
Comma-separated RPC URLs for the bots. Bidder i uses URL i (mod count), and
a retry the next one, so a list spreads the snipers' polling.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account alice.testnet -DryRun

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account alice.testnet -Bidders 30 -Snipers 10 -BidWindowMinutes 25 -TokenName Swarm -TokenSymbol SWARM -Phase Accounts
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [ValidateSet('Accounts', 'Create', 'Bid', 'Close', 'Report')][string]$Phase,
    [string]$Contract,
    [string]$SaleId,
    [string]$QuoteToken = 'usdc.fakes.testnet',
    # The crowd.
    [ValidateRange(1, 99)][int]$Bidders = 6,
    [ValidateRange(0, 99)][int]$Snipers = 1,
    [ValidateSet('Tee', 'CommitReveal')][string]$Mode = 'Tee',
    [ValidateSet('Over', 'Under')][string]$Demand = 'Over',
    [ValidateSet('on', 'off')][string]$Pool = 'on',
    # Bid slots; 0 = the bidders plus 2, at least 8.
    [ValidateRange(0, 500)][int]$MaxBids = 0,
    [int]$Seed = 1114,
    [switch]$FreshAccounts,
    # The sale.
    [string]$TokenName = 'No Snipe',
    [string]$TokenSymbol = 'NOSNIPE',
    # Whole tokens for sale; 0 = sized from the crowd and -Demand.
    [ValidateRange(0, 1000000000)][long]$SaleTokens = 0,
    [string]$FloorPrice = '0.001',
    # Times.
    [ValidateRange(3, 120)][int]$StartInMinutes = 6,
    [Alias('DurationMinutes')][ValidateRange(6, 43200)][int]$BidWindowMinutes = 10,
    # An absolute end of bidding instead of -BidWindowMinutes, e.g. 2026-11-17T12:00:00Z.
    [string]$BidEndUtc = '',
    [ValidateRange(1, 1440)][int]$PeopleMinutes = 20,
    [ValidateRange(10, 10080)][int]$SettleTimeoutMinutes = 60,
    [ValidateRange(1, 10080)][int]$RevealWindowMinutes = 10,
    [switch]$StopAfterBids,
    [switch]$AllowKeys,
    # NEAR attached to create_sale; empty = get_create_cost plus 0.05, rounded up.
    [string]$Deposit = '',
    # NEAR each new bidder account starts with.
    [string]$FundNear = '0.13',
    # The snipers' head polling in the last seconds before the open.
    [ValidateRange(100, 10000)][int]$PollMs = 1000,
    # Reveals and claims run this many bots at once.
    [ValidateRange(1, 30)][int]$Parallel = 6,
    [string]$AppUrl = '',
    [string]$Rpc = '',
    [string]$BotRpc = 'https://rpc.testnet.fastnear.com',
    [switch]$DryRun,
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')

$script:Bound = [ordered]@{}
foreach ($key in $PSBoundParameters.Keys) { $script:Bound[$key] = $PSBoundParameters[$key] }
$script:Inv = [Globalization.CultureInfo]::InvariantCulture

# --- Checks on the arguments -------------------------------------------------

if ($Network -ne 'testnet') { throw 'The evidence sales are a testnet run; mainnet has its own capped pilot (LAUNCH.md).' }
if ($DryRun -and $Execute) { throw '-DryRun is read-only: leave out -Execute.' }
if (-not $DryRun -and -not $Phase) { throw 'Pass -Phase Accounts, Create, Bid, Close or Report, or -DryRun for the whole plan and what it costs.' }
$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $Contract) { $Contract = "sealround.$Account" }
Assert-AccountId $Contract '-Contract'
Assert-AccountId $QuoteToken '-QuoteToken'

function Split-Urls {
    param([string]$Text, [string]$Name)
    $urls = @($Text -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($urls.Count -eq 0) { throw "$Name needs at least one URL." }
    foreach ($u in $urls) {
        if ($u -notmatch '^https?://[^\s,]+$') { throw "$Name`: '$u' is not an http(s) URL." }
    }
    $urls
}
$script:ReadRpcs = @(if ($Rpc) { Split-Urls $Rpc '-Rpc' } else { $net.rpcUrl })
$script:BotRpcs = @(Split-Urls $BotRpc '-BotRpc')

if ($Snipers -gt $Bidders) { throw "-Snipers $Snipers is more than -Bidders $Bidders." }
if ($FloorPrice -notmatch '^\d+(\.\d{1,6})?$') { throw '-FloorPrice is USDC per whole token with at most 6 decimals, such as 0.001.' }
$script:FloorUnits = [long]([decimal]::Parse($FloorPrice, $script:Inv) * 1000000)
if ($script:FloorUnits -lt 1) { throw '-FloorPrice must be at least 0.000001.' }
if ($FundNear -notmatch '^\d+(\.\d+)?$') { throw '-FundNear is a NEAR amount such as 0.13.' }
$script:Fund = [decimal]::Parse($FundNear, $script:Inv)
if ($script:Fund -lt 0.005 -or $script:Fund -gt 1) { throw '-FundNear must be between 0.005 and 1 NEAR (a bidder needs about 0.002 for its account and about 0.101 free for a 100 TGas call).' }
if ($Deposit -and $Deposit -notmatch '^\d+(\.\d+)?$') { throw '-Deposit is a NEAR amount such as 3 or 2.5.' }
if (-not $TokenName.Trim() -or $TokenName.Length -gt 64) { throw '-TokenName must be 1 to 64 characters.' }
if ($TokenSymbol -cnotmatch '^[A-Z0-9]{1,16}$') { throw '-TokenSymbol must be 1 to 16 capital letters or digits.' }
$script:MaxBidsValue = $MaxBids
if ($script:MaxBidsValue -eq 0) { $script:MaxBidsValue = [Math]::Max(8, $Bidders + 2) }
if ($script:MaxBidsValue -lt $Bidders) { throw "-MaxBids $($script:MaxBidsValue) is below -Bidders $Bidders`: every bidder needs a bid slot." }
$script:BidEndAbsNs = 0L
if ($BidEndUtc) {
    try {
        $at = [DateTimeOffset]::Parse($BidEndUtc, $script:Inv, [Globalization.DateTimeStyles]::AssumeUniversal)
    } catch { throw "-BidEndUtc '$BidEndUtc' is not a date and time, such as 2026-11-17T12:00:00Z." }
    $script:BidEndAbsNs = $at.ToUnixTimeMilliseconds() * 1000000L
}

$script:OutDir = Get-OutDir $Network
$script:LatestFile = Join-Path $script:OutDir 'evidence-sale.json'
$script:KeyDir = Join-Path (Join-Path $HOME '.near-credentials') $Network
$script:SalesFile = Join-Path (Join-Path $script:RepoRoot 'evidence') 'sales.json'
$script:Yocto = [decimal]::Parse('1000000000000000000000000')
$script:One = [System.Numerics.BigInteger]::Pow(10, 18)
$usdc = [decimal]1000000    # base units per USDC (6 decimals)
$second = 1000000000L       # nanoseconds

# --- Small helpers -------------------------------------------------------------

function Fmt { param([string]$Format) [string]::Format($script:Inv, $Format, $args) }
function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { $p.Value } else { $null }
}
function Get-NowNs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000L }
function Format-Ns { param([long]$Ns) [DateTimeOffset]::FromUnixTimeMilliseconds([long]($Ns / 1000000L)).UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss', $script:Inv) + ' UTC' }
function Format-Usdc { param($Units) ([decimal]$Units / 1000000).ToString('0.######', $script:Inv) }
function Format-Near { param([decimal]$Near) $Near.ToString('0.#####', $script:Inv) }
function Format-Tokens { param([string]$Base, [int]$Decimals = 18) ([decimal]::Parse($Base, $script:Inv) / [decimal]::Parse('1' + ('0' * $Decimals), $script:Inv)).ToString('#,0.##', $script:Inv) }
function Format-Offset {
    param([long]$Ms)
    if ($Ms -le 0) { return 'at the open' }
    $s = [long][Math]::Round($Ms / 1000.0)
    if ($s -lt 3600) { return (Fmt '+{0} m {1:00} s' ([long][Math]::Floor($s / 60)) ($s % 60)) }
    Fmt '+{0} h {1:00} m' ([long][Math]::Floor($s / 3600)) ([long][Math]::Floor(($s % 3600) / 60))
}
function ConvertTo-JsonText {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"' { [void]$sb.Append('\"') }
            '\' { [void]$sb.Append('\\') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default {
                if ([int]$ch -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) } else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    $sb.ToString()
}

function Wait-Until {
    param([long]$Ns, [string]$What)
    $said = [DateTime]::MinValue
    while ($true) {
        if ($script:Runs.Count) { Update-Bots }
        $left = [long](($Ns - (Get-NowNs)) / $second)
        if ($left -le 0) { break }
        if (([DateTime]::UtcNow - $said).TotalSeconds -ge 60) {
            Write-Host ("{0}: {1} s left" -f $What, $left)
            $said = [DateTime]::UtcNow
        }
        Start-Sleep -Seconds ([Math]::Min(3, [Math]::Max(1, $left)))
    }
}

# Chain reads (read-only, with retries over -Rpc).
function Read-View {
    param([string]$Method, $Arguments = '{}', [string]$On = $Contract)
    $json = $Arguments
    if ($Arguments -isnot [string]) { $json = ConvertTo-Json -InputObject $Arguments -Depth 10 -Compress }
    Invoke-NearViewRetry -RpcUrl $script:ReadRpcs -Account $On -Method $Method -ArgsJson $json
}
<#
One bidder's bid, or $null when it has none. An RPC failure throws (after the
retries in Invoke-NearViewRetry): it is never read as "no bid", which once
left a bidder out of the claims.
#>
function Get-BidOf {
    param([string]$Id)
    Read-View 'get_bid' ([ordered]@{ sale_id = $script:Sale; bidder = $Id })
}
<# Every bid of the sale, by bidder account, read at the moment it is called. #>
function Get-BidMap {
    $map = @{}
    foreach ($bid in @(Get-AllPages 'get_bids')) { $map[[string]$bid.bidder] = $bid }
    $map
}
function Get-AllPages {
    param([string]$Method)
    $all = @()
    $from = 0
    while ($true) {
        # Windows PowerShell's ConvertFrom-Json hands back a JSON array as one object: piping the
        # variable enumerates it (an empty array gives nothing).
        $raw = Read-View $Method ([ordered]@{ sale_id = $script:Sale; from_index = $from; limit = 100 })
        $page = @($raw | ForEach-Object { $_ } | Where-Object { $null -ne $_ })
        $all += $page
        if ($page.Count -lt 100) { break }
        $from += 100
    }
    $all
}
$script:BlockCache = @{}
function Get-BlockHeight {
    param([string]$Hash)
    if (-not $Hash) { return $null }
    if ($script:BlockCache.ContainsKey($Hash)) { return $script:BlockCache[$Hash] }
    $r = Invoke-NearRpc -RpcUrl $script:ReadRpcs -Method 'block' -Params ([ordered]@{ block_id = $Hash })
    $h = $null
    if (-not (Get-Prop $r 'error')) { $h = [long]$r.result.header.height }
    $script:BlockCache[$Hash] = $h
    $h
}
<# The block a transaction was included in, and the block whose receipt logged bid_placed (bids only). $null when not found. #>
function Get-TxInfo {
    param([string]$Tx, [string]$Sender)
    if (-not $Tx -or -not $Sender) { return $null }
    try {
        $r = Invoke-NearRpc -RpcUrl $script:ReadRpcs -Method 'tx' -Params ([ordered]@{ tx_hash = $Tx; sender_account_id = $Sender }) -Tries 4
        if (Get-Prop $r 'error') { return $null }
        $bidBlock = $null
        foreach ($o in @($r.result.receipts_outcome)) {
            if ($o.outcome.executor_id -eq $Contract -and ((@($o.outcome.logs) -join "`n") -match '"bid_placed"')) {
                $bidBlock = Get-BlockHeight $o.block_hash
                break
            }
        }
        [pscustomobject]@{ txBlock = (Get-BlockHeight $r.result.transaction_outcome.block_hash); bidBlock = $bidBlock }
    } catch { $null }
}

# --- The crowd -----------------------------------------------------------------

function New-SwarmName { $name = Fmt 'swarm-{0:00}' $script:SwarmNext; $script:SwarmNext++; $name }
function New-Bidder {
    param([string]$Name, [string]$Role, [int]$DepositUsdc, [double]$Mult, [int]$SpendUsdc)
    $price = 0L
    if ($Mult -gt 0) { $price = [long][Math]::Round($script:FloorUnits * $Mult) }
    [pscustomobject]@{
        name = $Name; id = "$Name.$Account"; role = $Role
        deposit = $DepositUsdc; price = $price; spend = $SpendUsdc
        victim = ''; frac = 0.0; offset_ms = 0L; rpc = 0
    }
}

<#
The bidders, their terms and their place in time, all from the seed: the same
arguments give the same crowd in every phase. Times are set by Set-CrowdTimes
once the bid window is known.
#>
function New-Crowd {
    param([int]$Count, [int]$SniperCount, [int]$RandomSeed, [bool]$Fresh, [bool]$NoLate)
    $rng = New-Object System.Random $RandomSeed
    $k = [Math]::Min($SniperCount, $Count)
    $rest = $Count - $k
    $hasCopy = $rest -ge 2
    $hasLate = ($rest -ge 3) -and -not $NoLate
    $nPeople = $rest - [int]$hasCopy - [int]$hasLate
    $script:SwarmNext = 1
    $crowd = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $k; $i++) {
        $d = $rng.Next(4, 9)
        $step = $rng.Next(0, 9)
        if (-not $Fresh -and $i -eq 0) { $crowd.Add((New-Bidder 'sniper' 'sniper' 5 4.0 5)); continue }
        $crowd.Add((New-Bidder (New-SwarmName) 'sniper' $d (3.0 + 0.25 * $step) $d))
    }
    # The first evidence sale's people, in this order so the copycat's victim (ravi) is always there.
    $classic = @(@('ravi', 5, 2.5, 5), @('ana', 6, 3.0, 5), @('mei', 3, 1.5, 3))
    for ($i = 0; $i -lt $nPeople; $i++) {
        $d = $rng.Next(2, 9)
        $cut = $rng.NextDouble()
        $low = $rng.NextDouble()
        $step = $rng.Next(0, 21)
        if (-not $Fresh -and $i -lt 3) {
            $c = $classic[$i]
            $crowd.Add((New-Bidder $c[0] 'person' $c[1] $c[2] $c[3]))
            continue
        }
        $spend = $d
        if ($d -ge 3 -and $cut -lt 0.3) { $spend = $d - 1 }
        $mult = 2.0 + 0.1 * $step
        if ($low -lt 0.25) { $mult = 1.0 + 0.1 * ($step % 10) }
        $crowd.Add((New-Bidder (New-SwarmName) 'person' $d $mult $spend))
    }
    if ($hasCopy) {
        # The first person: a copy of a bid from an id of the same length passes the
        # contract's length check, so the enclave (or the missing reveal) voids it.
        $victim = @($crowd | Where-Object { $_.role -eq 'person' })[0]
        if (-not $Fresh -and $victim.name -eq 'ravi') { $copy = New-Bidder 'copy' 'copycat' 5 0 0 }
        else { $copy = New-Bidder (New-SwarmName) 'copycat' 2 0 0 }
        $copy.victim = $victim.name
        $crowd.Add($copy)
    }
    if ($hasLate) {
        $lateName = 'late'
        if ($Fresh) { $lateName = New-SwarmName }
        $crowd.Add((New-Bidder $lateName 'late' 6 3.5 5))
    }
    $fracs = @(@(for ($i = 0; $i -lt $nPeople; $i++) { $rng.NextDouble() }) | Sort-Object)
    $p = 0
    foreach ($b in $crowd) {
        if ($b.role -eq 'person') { $b.frac = $fracs[$p]; $p++ }
        elseif ($b.role -eq 'late') { $b.frac = $rng.NextDouble() }
    }
    for ($i = 0; $i -lt $crowd.Count; $i++) { $crowd[$i].rpc = $i }
    $crowd.ToArray()
}

<# People between 30 s after the open and -PeopleMinutes (at most 3 minutes before the end); the late bid 1 to 2 minutes before the end. #>
function Set-CrowdTimes {
    param($Crowd, [long]$WindowMs)
    $lo = 30000L
    $hi = [Math]::Min([long]$PeopleMinutes * 60000L, $WindowMs - 180000L)
    if ($hi -lt $lo) { $hi = $lo }
    foreach ($b in $Crowd) {
        switch ($b.role) {
            'person' { $b.offset_ms = $lo + [long](($hi - $lo) * [double]$b.frac) }
            'late' { $b.offset_ms = $WindowMs - 120000L + [long](60000 * [double]$b.frac) }
            default { $b.offset_ms = 0L }
        }
    }
}

function Get-ScriptCrowd { @(New-Crowd -Count $Bidders -SniperCount $Snipers -RandomSeed $Seed -Fresh ([bool]$FreshAccounts) -NoLate ([bool]$StopAfterBids)) }
function Get-KeyFile { param([string]$Id) Join-Path $script:KeyDir "$Id.json" }
function Format-Price { param([long]$Units) Format-Usdc $Units }

# --- Expected clearing (the reference rule, for planning only) ------------------

function Get-ValidBids {
    param($Crowd, [long]$Floor)
    @($Crowd | Where-Object { $_.role -ne 'copycat' -and [long]$_.price -ge $Floor -and [int]$_.spend -gt 0 -and [int]$_.spend -le [int]$_.deposit })
}
function Get-TokensFor {
    param([int]$SpendUsdc, [long]$Price)
    [System.Numerics.BigInteger]::Divide([System.Numerics.BigInteger]([long]$SpendUsdc * 1000000L) * $script:One, [System.Numerics.BigInteger]$Price)
}
function Get-Demand {
    param($Valid, [long]$Price)
    $d = [System.Numerics.BigInteger]::Zero
    foreach ($b in $Valid) { if ([long]$b.price -ge $Price) { $d = $d + (Get-TokensFor $b.spend $Price) } }
    $d
}
function Get-CostOf {
    param([System.Numerics.BigInteger]$Tokens, [long]$Price)
    $t = $Tokens * [System.Numerics.BigInteger]$Price
    [System.Numerics.BigInteger]::Divide($t + $script:One - 1, $script:One)
}
<# P* = max { P >= floor : D(P) >= S } (floor when undersubscribed), the fills at P*, sold, raised and unsold. #>
function Get-Estimate {
    param($Crowd, [long]$SupplyTokens, [long]$Floor)
    $valid = Get-ValidBids $Crowd $Floor
    $s = [System.Numerics.BigInteger]$SupplyTokens * $script:One
    $price = $Floor
    $over = (Get-Demand $valid $Floor) -ge $s
    if ($over -and $valid.Count) {
        $lo = $Floor
        $hi = [long](@($valid | ForEach-Object { [long]$_.price }) | Measure-Object -Maximum).Maximum
        while ($lo -lt $hi) {
            $mid = [long][Math]::Floor(($lo + $hi + 1) / 2)
            if ((Get-Demand $valid $mid) -ge $s) { $lo = $mid } else { $hi = $mid - 1 }
        }
        $price = $lo
    }
    $tokens = @{}
    foreach ($b in $valid) { $tokens[$b.name] = [System.Numerics.BigInteger]::Zero }
    $tier1 = @($valid | Where-Object { [long]$_.price -gt $price })
    $tier2 = @($valid | Where-Object { [long]$_.price -eq $price })
    $sum1 = [System.Numerics.BigInteger]::Zero
    foreach ($b in $tier1) { $tokens[$b.name] = Get-TokensFor $b.spend $price; $sum1 = $sum1 + $tokens[$b.name] }
    if ($sum1 -gt $s) {
        foreach ($b in $tier1) { $tokens[$b.name] = [System.Numerics.BigInteger]::Divide($tokens[$b.name] * $s, $sum1) }
    } else {
        $left = $s - $sum1
        $sum2 = [System.Numerics.BigInteger]::Zero
        foreach ($b in $tier2) { $sum2 = $sum2 + (Get-TokensFor $b.spend $price) }
        foreach ($b in $tier2) {
            $full = Get-TokensFor $b.spend $price
            if ($sum2 -gt $left) { $full = [System.Numerics.BigInteger]::Divide($full * $left, $sum2) }
            $tokens[$b.name] = $full
        }
    }
    $sold = [System.Numerics.BigInteger]::Zero
    $raised = [System.Numerics.BigInteger]::Zero
    $fills = @{}
    foreach ($b in $valid) {
        $spent = Get-CostOf $tokens[$b.name] $price
        $fills[$b.name] = [pscustomobject]@{ tokens = $tokens[$b.name]; spent = $spent }
        $sold = $sold + $tokens[$b.name]
        $raised = $raised + $spent
    }
    $unsold = $s - $sold
    if ($unsold -lt 0) { $unsold = [System.Numerics.BigInteger]::Zero }
    [pscustomobject]@{ price = $price; over = $over; sold = $sold; raised = $raised; unsold = $unsold; fills = $fills; supply = $s }
}
<# Whole tokens for sale: -SaleTokens, or sized so the sale clears at twice the floor (Over) or at the floor with about 60 % unsold (Under). #>
function Get-SupplyTokens {
    param($Crowd)
    if ($SaleTokens -gt 0) { return [long]$SaleTokens }
    $valid = Get-ValidBids $Crowd $script:FloorUnits
    if ($Demand -eq 'Over') {
        $t = [long][System.Numerics.BigInteger]::Divide((Get-Demand $valid (2L * $script:FloorUnits)), $script:One)
        if ($t -lt 1) { $t = [long][System.Numerics.BigInteger]::Divide((Get-Demand $valid $script:FloorUnits), $script:One) }
        return [Math]::Max(1L, $t)
    }
    $atFloor = Get-Demand $valid $script:FloorUnits
    $t = [long][System.Numerics.BigInteger]::Divide($atFloor * 5, $script:One * 2)
    [Math]::Max(1000L, [long]([Math]::Ceiling(($t + 1) / 1000.0) * 1000))
}

# --- The sale's arguments --------------------------------------------------------

function New-SaleIdText { ($TokenSymbol.ToLowerInvariant() -replace '[^a-z0-9]', '') + '-' + [DateTime]::UtcNow.ToString('MMddHHmm', $script:Inv) }
function Get-ModeText { param([string]$M) if ($M -eq 'CommitReveal' -or $M -eq 'commit-reveal') { 'commit-reveal' } else { 'tee' } }

<#
The sale's on-chain description, built only from this run's parameters: the
crowd the script will run (counted by role), the mode, the bid window and the
pool. It states what the script was started with, never an outcome, and points
at the result page for the bids that landed. At most 280 bytes (the contract's
limit); the least important parts go first when it is too long.
#>
function Get-Description {
    param($Crowd, [long]$WindowMs, [long]$EndNs)
    $n = @{}
    foreach ($r in 'sniper', 'person', 'copycat', 'late') { $n[$r] = @($Crowd | Where-Object { $_.role -eq $r }).Count }
    $parts = @()
    if ($n.sniper) { $parts += Fmt '{0} sniper bot{1} at the open' $n.sniper $(if ($n.sniper -eq 1) { '' } else { 's' }) }
    if ($n.person) {
        $last = @($Crowd | Where-Object { $_.role -eq 'person' } | ForEach-Object { [long]$_.offset_ms } | Measure-Object -Maximum).Maximum
        $parts += Fmt '{0} {1} in the first {2} min' $n.person $(if ($n.person -eq 1) { 'person' } else { 'people' }) ([long][Math]::Ceiling(($last + 1) / 60000.0))
    }
    if ($n.copycat) { $parts += '1 copycat' }
    if ($n.late) { $parts += '1 late bid' }
    $how = 'sealed bids opened in the OutLayer TEE'
    if ($Mode -eq 'CommitReveal') { $how = "commit-reveal with a $RevealWindowMinutes min reveal window, cleared on chain" }
    $window = Fmt '{0} min of bidding' ([long][Math]::Round($WindowMs / 60000.0))
    if ($script:BidEndAbsNs) { $window = 'bidding until ' + [DateTimeOffset]::FromUnixTimeMilliseconds([long]($EndNs / 1000000L)).UtcDateTime.ToString('d MMM HH:mm', $script:Inv) + ' UTC' }
    $poolText = ''
    if ($Pool -eq 'on') { $poolText = '; a Rhea pool at that price' }
    $head = 'Testnet evidence run; the token has no value.'
    $body = Fmt 'Started with {0} bidder account{1} ({2}); {3}; {4}; one clearing price{5}.' $Crowd.Count $(if ($Crowd.Count -eq 1) { '' } else { 's' }) ($parts -join ', ') $how $window $poolText
    $tail = 'The result page lists the bids that landed.'
    foreach ($text in "$head $body $tail", "$head $body", "$body $tail", $body) {
        if ([Text.Encoding]::UTF8.GetByteCount($text) -le 280) { return $text }
    }
    throw "The sale description is $([Text.Encoding]::UTF8.GetByteCount($body)) bytes; the contract takes at most 280."
}

function New-SaleParams {
    param([string]$Id, [long]$StartNs, [long]$EndNs, [string]$Description, [long]$Supply, [long]$MinRaise, [int]$Slots)
    $one = '000000000000000000'    # 18 decimals
    # The token's face: a crosshair struck through. The contract takes a data: URL of at most 2,048 bytes.
    $svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b0d12'/>" +
        "<circle cx='32' cy='32' r='17' fill='none' stroke='#3d7eff' stroke-width='4'/>" +
        "<path d='M32 9v10M32 45v10M9 32h10M45 32h10' stroke='#3d7eff' stroke-width='4' stroke-linecap='round'/>" +
        "<path d='M14 50L50 14' stroke='#ff5c5c' stroke-width='5' stroke-linecap='round'/></svg>"
    $icon = 'data:image/svg+xml,' + [Uri]::EscapeDataString($svg)
    if ($icon.Length -gt 2048) { throw "The token icon is $($icon.Length) bytes; the contract takes at most 2,048." }
    $params = [ordered]@{
        sale_id = $Id
        token_name = $TokenName
        token_symbol = $TokenSymbol
        decimals = 18
        icon = $icon
        total_supply = "$(2L * $Supply)$one"
        sale_supply = "$Supply$one"
        floor_price = "$($script:FloorUnits)"
        min_raise = "$MinRaise"
        bid_start = "$StartNs"
        bid_end = "$EndNs"
        min_deposit = '1000000'
        max_deposit_per_account = '10000000'
        max_bids = $Slots
        reveal_mode = $Mode
        settle_timeout = "$([long]$SettleTimeoutMinutes * 60L * $second)"
        quote_token = $QuoteToken
        description = $Description
    }
    if ($Mode -eq 'CommitReveal') { $params['reveal_window'] = "$([long]$RevealWindowMinutes * 60L * $second)" }
    if ($Pool -eq 'on') {
        $poolTokens = [long][Math]::Ceiling($Supply / 5.0)
        $params['liquidity'] = [ordered]@{ raise_share_bps = 2000; pool_tokens = "$poolTokens$one"; fee_bps = 30 }
    }
    $params
}

<# Everything Create and the dry run need: times, crowd, supply, the expected clearing and the create_sale arguments. #>
function Get-SaleDesign {
    param([string]$Id)
    $startNs = (Get-NowNs) + [long]$StartInMinutes * 60L * $second
    $endNs = $startNs + [long]$BidWindowMinutes * 60L * $second
    if ($script:BidEndAbsNs) { $endNs = $script:BidEndAbsNs }
    $windowMs = [long](($endNs - $startNs) / 1000000L)
    if ($windowMs -lt 6L * 60000L) { throw "The bid window would be $([Math]::Round($windowMs / 60000.0, 1)) minutes; it must be at least 6. Move -BidEndUtc later or -StartInMinutes earlier." }
    if ($windowMs -gt 30L * 24L * 3600000L) { throw 'The bid window would be over 30 days, the contract''s limit.' }
    $crowd = Get-ScriptCrowd
    Set-CrowdTimes $crowd $windowMs
    $supply = Get-SupplyTokens $crowd
    $estimate = Get-Estimate $crowd $supply $script:FloorUnits
    $minRaise = [long][Math]::Min(5000000, [Math]::Max(1000000, [Math]::Floor([double][long]$estimate.raised / 2000000.0) * 1000000))
    $params = New-SaleParams $Id $startNs $endNs (Get-Description $crowd $windowMs $endNs) $supply $minRaise $script:MaxBidsValue
    [pscustomobject]@{ StartNs = $startNs; EndNs = $endNs; WindowMs = $windowMs; Crowd = $crowd; Supply = $supply; Estimate = $estimate; MinRaise = $minRaise; Params = $params }
}

function Format-CrowdTable {
    param($Crowd)
    $lines = @(Fmt '{0,-8} {1,-30} {2,7} {3,10} {4,9}  {5}' 'role' 'account' 'deposit' 'max price' 'max spend' 'when')
    foreach ($b in $Crowd) {
        if ($b.role -eq 'copycat') {
            $lines += Fmt '{0,-8} {1,-30} {2,7} {3,-20}  {4}' $b.role $b.id $b.deposit "copies $($b.victim)" 'after its victim bids'
        } else {
            $lines += Fmt '{0,-8} {1,-30} {2,7} {3,10} {4,9}  {5}' $b.role $b.id $b.deposit (Format-Price $b.price) $b.spend (Format-Offset $b.offset_ms)
        }
    }
    $lines
}

# --- Sale state and the run log ----------------------------------------------------

function Get-StateFile { param([string]$Id) Join-Path $script:OutDir "evidence-sale-$Id.json" }
function Save-SaleState {
    param($State)
    $text = ConvertTo-Json -InputObject $State -Depth 8
    [IO.File]::WriteAllText((Get-StateFile $State.sale_id), $text, $script:Utf8NoBom)
    [IO.File]::WriteAllText($script:LatestFile, $text, $script:Utf8NoBom)
}
function Read-SaleState {
    if ($SaleId) {
        $file = Get-StateFile $SaleId
        if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file) | ConvertFrom-Json) }
        if (Test-Path -LiteralPath $script:LatestFile) {
            $latest = [IO.File]::ReadAllText($script:LatestFile) | ConvertFrom-Json
            if ($latest.sale_id -eq $SaleId) { return $latest }
        }
        # A sale this script did not save: read it from the chain.
        $script:Sale = $SaleId
        $view = Read-View 'get_sale' ([ordered]@{ sale_id = $SaleId })
        if (-not $view) { throw "There is no sale $SaleId on $Contract." }
        return [pscustomobject]@{ contract = $Contract; sale_id = $SaleId; token = $view.token; bid_start = $view.bid_start; bid_end = $view.bid_end; created_by = $view.creator; mode = (Get-ModeText $view.reveal_mode) }
    }
    if (-not (Test-Path -LiteralPath $script:LatestFile)) { throw "No $($script:LatestFile). Run -Phase Create first, or pass -SaleId." }
    [IO.File]::ReadAllText($script:LatestFile) | ConvertFrom-Json
}
<# The crowd saved with the sale; a sale saved by the first version of this script had the six classic bidders. #>
function Get-StateCrowd {
    param($State)
    $saved = Get-Prop $State 'crowd'
    if ($saved) { return @($saved) }
    $crowd = @(New-Crowd -Count 6 -SniperCount 1 -RandomSeed 1114 -Fresh $false -NoLate $false)
    Set-CrowdTimes $crowd ([long](([long]$State.bid_end - [long]$State.bid_start) / 1000000L))
    $crowd
}

function Get-RunLogFile { Join-Path $script:OutDir "run-$($script:Sale).json" }
function Read-RunEvents {
    $file = Get-RunLogFile
    if (-not (Test-Path -LiteralPath $file)) { return @() }
    $log = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    @(@($log.events) | Where-Object { $null -ne $_ })
}
function Add-RunEvent {
    param([string]$Kind, [string]$Who, [bool]$Ok, [string]$Tx = '', $Data = $null)
    $events = @(Read-RunEvents)
    $events += [ordered]@{ at = [DateTime]::UtcNow.ToString('o', $script:Inv); kind = $Kind; who = $Who; ok = $Ok; tx = $Tx; data = $Data }
    $log = [ordered]@{ v = 1; contract = $Contract; sale = $script:Sale; events = $events }
    [IO.File]::WriteAllText((Get-RunLogFile), (ConvertTo-Json -InputObject $log -Depth 10), $script:Utf8NoBom)
}
function Get-LastEvent {
    param($Events, [string]$Kind, [string]$Who, [string[]]$Commands = @(), [switch]$OkOnly)
    $found = $null
    foreach ($e in $Events) {
        if ($e.kind -ne $Kind -or $e.who -ne $Who) { continue }
        if ($OkOnly -and -not $e.ok) { continue }
        if ($Commands.Count -and ($Commands -notcontains [string](Get-Prop $e.data 'command'))) { continue }
        $found = $e
    }
    $found
}

# --- Owner calls through near CLI, with the transaction hash recorded ------------------

function Get-NearCall {
    param([string]$Method, [string]$ArgsFile, [string]$Gas = '300 Tgas', [string]$Attach = '0 NEAR')
    @('contract', 'call-function', 'as-transaction', $Contract, $Method, 'file-args', $ArgsFile,
      'prepaid-gas', $Gas, 'attached-deposit', $Attach, 'sign-as', $Account,
      'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send')
}
function Invoke-OwnerCall {
    param([string]$Step, [string[]]$Arguments, [string]$Expect = '')
    Write-Host (Format-CommandLine ([pscustomobject]@{ Exe = 'near'; Arguments = $Arguments })) -ForegroundColor DarkGray
    $r = Invoke-NativeCaptured -Exe 'near' -Arguments $Arguments
    $tx = Get-NearTxHash $r.Lines
    Add-RunEvent -Kind 'owner' -Who $Step -Ok ($r.ExitCode -eq 0) -Tx $tx -Data ([ordered]@{ exit = $r.ExitCode })
    if ($r.ExitCode -ne 0) { throw "$Step failed (exit code $($r.ExitCode)). Fix it and run this phase again: done steps are left out." }
    if ($tx) { Write-Host "Recorded the $Step transaction $tx." -ForegroundColor DarkGray }
    else { Write-Host "near CLI printed no transaction hash for $Step; the report will show it as not recorded." -ForegroundColor Yellow }
    if ($Expect) { Write-Host ('Expected: ' + $Expect) -ForegroundColor DarkGray }
}
function Add-OwnerCommand {
    param($Plan, [string]$Step, [string]$Title, [string[]]$Arguments, [string]$Expect = '')
    Add-Command $Plan $Title 'near' $Arguments -Signs -Expect $Expect
    $Plan[$Plan.Count - 1] | Add-Member -NotePropertyName Record -NotePropertyValue $Step
}

# --- The bots: one background process per bid, reveal or claim ------------------------

$script:Runs = New-Object System.Collections.Generic.List[object]
$script:Pnpm = $null
$script:RefusalCodes = @('usage', 'missing_key', 'bad_key', 'key_mismatch', 'mainnet_not_confirmed', 'wrong_network', 'contract_not_found',
    'not_fairground', 'account_not_found', 'sale_not_found', 'sale_closed', 'already_bid', 'no_bid', 'no_receipt', 'invalid_terms',
    'over_budget', 'insufficient_usdc')

function Get-RunDir {
    $dir = Join-Path $script:OutDir "run-$($script:Sale)"
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $dir
}
function Get-BotArguments {
    param([string]$Command, $Bidder, [string[]]$Extra, [string]$RpcUrl)
    @('--silent', '--filter', 'web', 'live-bot', $Command, '--network', $Network, '--rpc', $RpcUrl, '--contract', $Contract,
      '--sale', $script:Sale, '--account', $Bidder.id, '--key-file', (Get-KeyFile $Bidder.id), '--direct', '--json') + @($Extra)
}
function Get-SecondsLeft { param([long]$UntilNs) [long][Math]::Max(60, [Math]::Ceiling(($UntilNs - (Get-NowNs)) / [double]$second) + 60) }

<# The bot command and options for a bidder's bid. TEE: snipe (snipers), bid (people), copycat. Commit-reveal: snipe commits for everyone but the copycat. #>
function Get-BidCommand {
    param($Bidder)
    if ($Bidder.role -eq 'copycat') { return 'copycat' }
    if ($Bidder.role -eq 'sniper' -or $script:SaleMode -eq 'commit-reveal') { return 'snipe' }
    'bid'
}
function Get-BidExtra {
    param($Bidder)
    $wait = "$(Get-SecondsLeft $script:BidEnd)"
    switch (Get-BidCommand $Bidder) {
        'copycat' { return @('--victim', "$($Bidder.victim).$Account", '--deposit', "$($Bidder.deposit)", '--max-wait', $wait) }
        'snipe' { return @('--deposit', "$($Bidder.deposit)", '--max-price', (Format-Price $Bidder.price), '--max-spend', "$($Bidder.spend)", '--poll-ms', "$PollMs", '--max-wait', $wait) }
        default { return @('--budget', "$($Bidder.deposit)", '--deposit', "$($Bidder.deposit)", '--max-price', (Format-Price $Bidder.price), '--max-spend', "$($Bidder.spend)") }
    }
}

function Start-Bot {
    param($Bidder, [string]$Command, [string[]]$Extra, [int]$Attempt = 1)
    if (-not $script:Pnpm) { $script:Pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source }
    $rpcUrl = $script:BotRpcs[([int]$Bidder.rpc + $Attempt - 1) % $script:BotRpcs.Count]
    $argv = @(Get-BotArguments $Command $Bidder $Extra $rpcUrl)
    # Start-Process joins its arguments with spaces and does not quote them.
    foreach ($a in $argv) { if ($a -match '\s') { throw "Argument '$a' has a space, which Start-Process would split; move the key file." } }
    $base = Join-Path (Get-RunDir) ("{0}.{1}.{2}" -f $Bidder.name, $Command, $Attempt)
    $p = Start-Process -FilePath $script:Pnpm -ArgumentList $argv -WorkingDirectory $script:RepoRoot `
        -RedirectStandardOutput "$base.json" -RedirectStandardError "$base.err" -WindowStyle Hidden -PassThru
    $null = $p.Handle    # Windows PowerShell 5.1 loses ExitCode without this
    [pscustomobject]@{
        Bidder = $Bidder; Command = $Command; Extra = $Extra; Attempt = $Attempt; Process = $p
        Out = "$base.json"; Err = "$base.err"; Rpc = $rpcUrl; Done = $false; Result = $null
    }
}

function ConvertFrom-BotOutput {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    # A bot's child process (pnpm, then node) can still hold the redirected
    # output file for a moment after the process we started exits. Read it
    # with sharing allowed and try again for up to 10 s while it is locked.
    $text = $null
    for ($try = 1; $null -eq $text; $try++) {
        try {
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
            try { $text = (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
        } catch [IO.IOException] {
            if ($try -ge 40) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    $at = $text.IndexOf('{')
    if ($at -lt 0) { return $null }
    try { $text.Substring($at) | ConvertFrom-Json } catch { $null }
}

<# Waits for one bot, reads its JSON, records it in the run log and prints one line. #>
function Complete-Bot {
    param($Run, [int]$TimeoutSec = 600)
    if (-not $Run.Process.WaitForExit($TimeoutSec * 1000)) {
        Write-Host "$($Run.Bidder.name): $($Run.Command) did not finish in $TimeoutSec s; stopping it." -ForegroundColor Yellow
        try { $null = & taskkill.exe /T /F /PID $Run.Process.Id 2>&1 } catch { }
    }
    $Run.Process.WaitForExit()
    $json = ConvertFrom-BotOutput $Run.Out
    $exit = $Run.Process.ExitCode
    $ok = [bool]($json -and (Get-Prop $json 'ok') -eq $true)
    $err = Get-Prop $json 'error'
    $claim = Get-Prop $json 'claim'
    $tx = [string](Get-Prop $json 'txHash')
    if ($claim) { $tx = [string](Get-Prop $claim 'txHash') }
    $data = [ordered]@{ command = $Run.Command; attempt = $Run.Attempt; rpc = $Run.Rpc; exit = $exit; account = $Run.Bidder.id; role = $Run.Bidder.role }
    foreach ($name in 'index', 'landedAfterMs', 'landedInSecond', 'bidBlock', 'openBlock', 'sealedBytes', 'attempts', 'paidBy', 'outcome', 'reason', 'payloadBytes', 'expectedBytes', 'victim') {
        $v = Get-Prop $json $name
        if ($null -ne $v) { $data[$name] = $v }
    }
    if ($claim) { $data['claim'] = [ordered]@{ status = (Get-Prop $claim 'status'); tokens = (Get-Prop $claim 'tokens'); refund = (Get-Prop $claim 'refund') } }
    if ($err) { $data['error'] = [ordered]@{ code = (Get-Prop $err 'code'); message = (Get-Prop $err 'message') } }
    if (-not $json) {
        $tail = ''
        if (Test-Path -LiteralPath $Run.Err) { $tail = (@(Get-Content -LiteralPath $Run.Err -Tail 3) -join ' / ') }
        $data['error'] = [ordered]@{ code = 'no_output'; message = "No JSON from the bot (exit $exit). $tail" }
    }
    Add-RunEvent -Kind 'bot' -Who $Run.Bidder.name -Ok $ok -Tx $tx -Data $data
    $Run.Done = $true
    $Run.Result = [pscustomobject]@{ Ok = $ok; Json = $json; Code = [string](Get-Prop $data['error'] 'code'); Message = [string](Get-Prop $data['error'] 'message'); Tx = $tx }
    $who = Fmt '{0,-9} {1,-8}' $Run.Bidder.name $Run.Command
    if ($ok) {
        $line = 'ok'
        switch ($Run.Command) {
            'snipe' { $line = Fmt 'bid #{0}, {1:0.000} s after bid_start (block {2}), {3}' (Get-Prop $json 'index') ([double](Get-Prop $json 'landedAfterMs') / 1000) (Get-Prop $json 'bidBlock') $(if (Get-Prop $json 'sealedBytes') { "$(Get-Prop $json 'sealedBytes') bytes sealed" } else { 'committed' }) }
            'bid' { $line = "bid #$(Get-Prop $json 'index')" }
            'copycat' { $line = "$(Get-Prop $json 'outcome') (copied $(Get-Prop $json 'victim')'s bid #$(Get-Prop $json 'victimIndex'))" }
            'reveal' { $line = 'revealed' }
            'report' { $line = Fmt 'claim {0}: {1} tokens, {2} USDC back' (Get-Prop $claim 'status') (Format-Tokens ([string](Get-Prop $claim 'tokens'))) (Format-Usdc ([string](Get-Prop $claim 'refund'))) }
        }
        Write-Host "$who $line$(if ($tx) { ", tx $tx" })" -ForegroundColor Green
    } else {
        Write-Host "$who FAILED ($($Run.Result.Code)): $($Run.Result.Message)  [log: $($Run.Err)]" -ForegroundColor Red
    }
    $Run.Result
}

<# True when a failed bot should be run once more: nothing it was meant to do is on chain, the chain still allows it, and the failure was not a refusal that a retry repeats. #>
function Test-Retry {
    param($Run)
    if ($Run.Result.Ok -or $Run.Attempt -ge 2) { return $false }
    if ($script:RefusalCodes -contains $Run.Result.Code) { return $false }
    # When the chain cannot be read, try again: the bot itself refuses a second bid or claim before it signs.
    try { $bid = Get-BidOf $Run.Bidder.id } catch { return $true }
    switch ($Run.Command) {
        'reveal' { return [bool]($bid -and -not $bid.revealed -and (Get-NowNs) -lt $script:RevealEnd - 15L * $second) }
        'report' { return [bool]($bid -and -not $bid.claimed) }
        default { return [bool](-not $bid -and (Get-NowNs) -lt $script:BidEnd - 15L * $second) }
    }
}

<# Collects every bot that has finished (all of them with -Wait) and starts the retries. #>
function Update-Bots {
    param([switch]$Wait)
    do {
        $started = 0
        foreach ($run in @($script:Runs.ToArray())) {
            if ($run.Done) { continue }
            if (-not $Wait -and -not $run.Process.HasExited) { continue }
            $null = Complete-Bot $run
            if (Test-Retry $run) {
                Write-Host "$($run.Bidder.name): trying $($run.Command) once more through the next RPC URL." -ForegroundColor Yellow
                $script:Runs.Add((Start-Bot $run.Bidder $run.Command $run.Extra ($run.Attempt + 1)))
                $started++
            }
        }
    } while ($Wait -and $started -gt 0)
}

<# Runs one bot per job, -Parallel at a time, and waits for all of them (and their retries). #>
function Invoke-BotBatch {
    param($Jobs)
    $queue = New-Object System.Collections.Generic.Queue[object]
    foreach ($j in $Jobs) { $queue.Enqueue($j) }
    while ($queue.Count -gt 0 -or @($script:Runs | Where-Object { -not $_.Done }).Count -gt 0) {
        while ($queue.Count -gt 0 -and @($script:Runs | Where-Object { -not $_.Done }).Count -lt $Parallel) {
            $j = $queue.Dequeue()
            $script:Runs.Add((Start-Bot $j.Bidder $j.Command $j.Extra))
        }
        Start-Sleep -Seconds 2
        Update-Bots
    }
}

# --- Bid phase steps --------------------------------------------------------------------

function Start-FirstBids {
    foreach ($b in $script:First) {
        $command = Get-BidCommand $b
        $script:Runs.Add((Start-Bot $b $command (Get-BidExtra $b)))
        if ($b.role -eq 'copycat') { Write-Host "$($b.name): copycat started; it waits for $($b.victim)'s bid." }
        else { Write-Host "$($b.name): $command started; it waits for $(Format-Ns $script:BidStart)." }
    }
    Write-Host "Logs: $(Get-RunDir)"
}

function Invoke-Schedule {
    foreach ($b in $script:Later) {
        $at = $script:BidStart + [long]$b.offset_ms * 1000000L
        if ((Get-NowNs) -ge $script:BidEnd - 20L * $second) {
            Write-Host "$($b.name): too late to bid (bidding ends $(Format-Ns $script:BidEnd)); left out." -ForegroundColor Yellow
            continue
        }
        Wait-Until $at "Next: $($b.name) ($($b.role)) at $(Format-Ns $at)"
        $script:Runs.Add((Start-Bot $b (Get-BidCommand $b) (Get-BidExtra $b)))
        Write-Host ("{0} ({1}) bids: deposit {2}, max price {3}, max spend {4}" -f $b.name, $b.role, $b.deposit, (Format-Price $b.price), $b.spend)
    }
}

function Show-BidSummary {
    $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
    $bids = Get-BidMap
    $missing = @()
    Write-Host ''
    Write-Host (Fmt '{0,-9} {1,-8} {2,5} {3,12} {4,6}' 'bidder' 'role' 'index' 'after open' 'bytes')
    foreach ($b in $script:Crowd) {
        $bid = $bids[$b.id]
        if (-not $bid) { $missing += $b.name; Write-Host (Fmt '{0,-9} {1,-8} {2,5}' $b.name $b.role '-'); continue }
        $ms = ([decimal]([long]$bid.placed_at - [long]$view.bid_start)) / 1000000
        Write-Host (Fmt '{0,-9} {1,-8} {2,5} {3,10:0.000} s {4,6}' $b.name $b.role $bid.index ($ms / 1000) ([Convert]::FromBase64String($bid.payload).Length))
    }
    Write-Host ''
    Write-Host "The sale has $($view.bid_count) bid(s) of $($view.max_bids) slots; deposits $(Format-Usdc $view.total_deposits) USDC."
    if ($missing.Count) {
        Write-Host "No bid from: $($missing -join ', '). Run -Phase Bid -Execute again before $(Format-Ns $script:BidEnd) to place them." -ForegroundColor Yellow
    }
    if ($StopAfterBids -or (Get-Prop $script:State 'stop_after_bids')) {
        Write-Host "The sale stays open until $(Format-Ns ([long]$view.bid_end)). After that: -Phase Close -SaleId $($script:Sale) -Execute, then -Phase Report."
    } else {
        Write-Host "Next, after $(Format-Ns ([long]$view.bid_end)): -Phase Close -Execute"
    }
}

# --- Close phase steps ------------------------------------------------------------------

function Wait-Result {
    for ($i = 1; $i -le 60; $i++) {
        $result = Read-View 'get_result' ([ordered]@{ sale_id = $script:Sale })
        if ($result.status -ne 'clearing') { break }
        if ($i -eq 1 -or $i % 6 -eq 0) { Write-Host "The enclave is clearing the sale ($i/60); waiting 10 s..." }
        Start-Sleep -Seconds 10
    }
    $failed = @($result.failed_checks)
    Write-Host ("status {0}, clearing price {1} USDC, raised {2} USDC, {3} valid, {4} invalid, unsold {5}, failed checks: {6}" -f `
        $result.status, (Format-Usdc $result.clearing_price), (Format-Usdc $result.total_raised), $result.n_valid, $result.n_invalid,
        (Format-Tokens ([string]$result.unsold)), $(if ($failed.Count) { $failed -join ', ' } else { 'none' }))
    switch ([string]$result.status) {
        'settled' { }
        'failed' { Write-Host "The sale failed ($($result.fail_reason)): every bid's deposit comes back at the claims below (less the 1 % penalty of a void bid)." -ForegroundColor Yellow }
        'closed' { throw 'The clearing failed and the sale is closed for a retry: run this phase again, which calls close_sale again.' }
        default { throw "The sale is $($result.status), not final. Wait and run this phase again." }
    }
}

function Invoke-Reveals {
    $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
    if (@('settled', 'failed') -contains [string]$view.status) { Write-Host "The sale is $($view.status) already: nothing to reveal."; return }
    if ($view.status -ne 'revealing') { throw "The sale is $($view.status): bids are revealed while it is revealing, after close_sale." }
    $script:RevealEnd = [long]$view.reveal_end
    if ((Get-NowNs) -ge $script:RevealEnd) { Write-Host 'The reveal window is over.' -ForegroundColor Yellow; return }
    # The bids are read now, after the close: the bid set is frozen, so no bid placed late is missed.
    $bids = Get-BidMap
    $jobs = @()
    foreach ($b in $script:Crowd) {
        if ($b.role -eq 'copycat') { continue }    # its copied commitment binds the victim's id: it cannot be revealed
        $bid = $bids[$b.id]
        if ($bid -and -not $bid.revealed) { $jobs += [pscustomobject]@{ Bidder = $b; Command = 'reveal'; Extra = @() } }
    }
    Write-Host "$($jobs.Count) bid(s) to reveal before $(Format-Ns $script:RevealEnd)."
    Invoke-BotBatch $jobs
    $bids = Get-BidMap
    $left = @($script:Crowd | Where-Object { $_.role -ne 'copycat' -and $bids[$_.id] -and -not $bids[$_.id].revealed })
    if ($left.Count) { Write-Host "Not revealed: $(@($left | ForEach-Object { $_.name }) -join ', '). An unrevealed bid is void and pays the 1 % penalty." -ForegroundColor Yellow }
}

function Invoke-Seed {
    for ($i = 1; $i -le 3; $i++) {
        $result = Read-View 'get_result' ([ordered]@{ sale_id = $script:Sale })
        $liq = Get-Prop $result 'liquidity'
        if (-not $liq) { Write-Host 'This sale has no launch pool.'; return }
        if ($liq.status -ne 'seeding') { break }
        Invoke-OwnerCall 'seed_liquidity' (Get-NearCall 'seed_liquidity' $script:SaleIdArgs) 'liquidity_seeded with the pool id. If a step failed, run this phase again: done steps are skipped.'
        Start-Sleep -Seconds 3
    }
    $result = Read-View 'get_result' ([ordered]@{ sale_id = $script:Sale })
    $liq = $result.liquidity
    Write-Host "Liquidity: $($liq.status), pool $($liq.pool_id) on $($liq.dex), $(Format-Usdc $liq.usdc) USDC and $(Format-Tokens ([string]$liq.tokens)) tokens, LP shares $($liq.shares)"
    if ($liq.status -eq 'seeding') { throw "The pool is still seeding (next step $($liq.next_step), in flight $($liq.in_flight)). Run this phase again to call seed_liquidity again." }
}

function Invoke-Claims {
    $result = Read-View 'get_result' ([ordered]@{ sale_id = $script:Sale })
    if (@('settled', 'failed') -contains [string]$result.status) { } else { throw "The sale is $($result.status): claims open once it is settled or failed." }
    # Who claims is decided here, from every bid on chain after the sale is final, not when the plan
    # was printed: the first version of this script decided before it waited for the end of bidding,
    # so a bid placed after that (late, in nosnipe-11140458) was never claimed.
    $bids = Get-BidMap
    $byId = @{}
    foreach ($b in $script:Crowd) { $byId[$b.id] = $b }
    $jobs = @()
    foreach ($id in @($bids.Keys | Sort-Object { [int]$bids[$_].index })) {
        if ($bids[$id].claimed) { continue }
        $b = $byId[$id]
        if (-not $b) { Write-Host "$id is not one of this script's bidders: it claims on its own (the sale page or the bot)." -ForegroundColor Yellow; continue }
        if (-not (Test-Path -LiteralPath (Get-KeyFile $id))) { Write-Host "$id has no key file at $(Get-KeyFile $id): it cannot be claimed from here." -ForegroundColor Yellow; continue }
        $jobs += [pscustomobject]@{ Bidder = $b; Command = 'report'; Extra = @('--claim') }
    }
    Write-Host "$($jobs.Count) bid(s) to claim of $($bids.Count), $Parallel at a time."
    Invoke-BotBatch $jobs
    $bids = Get-BidMap
    $left = @($bids.Keys | Where-Object { -not $bids[$_].claimed -and $byId[$_] })
    if ($left.Count) { throw "Not claimed yet: $($left -join ', '). Run this phase again." }
    $outside = @($bids.Keys | Where-Object { -not $bids[$_].claimed })
    if ($outside.Count) { Write-Host "Unclaimed bids from other accounts: $($outside -join ', ')." -ForegroundColor Yellow }
    else { Write-Host "All $($bids.Count) bids are claimed." }
}

# --- Report ---------------------------------------------------------------------------------

function Invoke-Report {
    $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
    if (-not $view) { throw "There is no sale $($script:Sale) on $Contract." }
    $result = Read-View 'get_result' ([ordered]@{ sale_id = $script:Sale })
    $bids = @(Get-AllPages 'get_bids')
    $fills = @(Get-AllPages 'get_fills')
    $keysNow = Get-AccessKeyList -RpcUrl $script:ReadRpcs -Account $Contract
    $events = @(Read-RunEvents)
    $keysEvent = Get-LastEvent $events 'keys' 'create'
    $keysAtCreate = $null
    if ($keysEvent) { $keysAtCreate = [pscustomobject]@{ count = [int](Get-Prop $keysEvent.data 'count'); block = (Get-Prop $keysEvent.data 'block') } }
    $saleMode = Get-ModeText $view.reveal_mode
    $decimals = [int]$view.decimals
    $one = [System.Numerics.BigInteger]::Pow(10, $decimals)
    $price = [System.Numerics.BigInteger]::Parse([string]$result.clearing_price)
    $floor = [long]$view.floor_price
    $start = [long]$view.bid_start
    $final = @('settled', 'failed') -contains [string]$result.status
    $byAccount = @{}
    foreach ($b in $script:Crowd) { $byAccount[$b.id] = $b }
    $fillAt = @{}
    foreach ($f in $fills) { $fillAt[[int]$f.index] = $f }

    $rows = @()
    foreach ($bid in @($bids | Sort-Object { [int]$_.index })) {
        $who = $byAccount[[string]$bid.bidder]
        $name = ''
        $role = 'outside'
        if ($who) { $name = $who.name; $role = $who.role }
        $bytes = [Convert]::FromBase64String($bid.payload).Length
        $expected = 32
        if ($saleMode -eq 'tee') { $expected = 224 + $script:Sale.Length + ([string]$bid.bidder).Length }
        $bidEvent = $null
        $claimEvent = $null
        $revealEvent = $null
        if ($name) {
            $bidEvent = Get-LastEvent $events 'bot' $name @('snipe', 'bid', 'copycat') -OkOnly
            $claimEvent = Get-LastEvent $events 'bot' $name @('report') -OkOnly
            $revealEvent = Get-LastEvent $events 'bot' $name @('reveal') -OkOnly
        }
        $tx = ''
        if ($bidEvent) { $tx = [string]$bidEvent.tx }
        $info = $null
        if ($tx) { $info = Get-TxInfo $tx ([string]$bid.bidder) }
        $f = $fillAt[[int]$bid.index]
        $tokens = $null; $spent = $null; $refund = $null; $penalty = $null; $pays = $null
        if ($f) {
            $tokens = [string]$f.tokens; $spent = [string]$f.spent; $refund = [string]$f.refund; $penalty = [string]$f.penalty
            $t = [System.Numerics.BigInteger]::Parse($tokens)
            if ($t -gt 0) {
                $owed = [System.Numerics.BigInteger]::Divide($t * $price + $one - 1, $one)
                $pays = ($owed -eq [System.Numerics.BigInteger]::Parse($spent))
            }
        }
        $rows += [pscustomobject][ordered]@{
            index = [int]$bid.index; bidder = [string]$bid.bidder; name = $name; role = $role
            deposit = [string]$bid.deposit; placed_at = [string]$bid.placed_at
            ms_after_open = [decimal]([long]$bid.placed_at - $start) / 1000000
            payload_bytes = $bytes; expected_bytes = $expected; revealed = [bool]$bid.revealed; claimed = [bool]$bid.claimed
            tx = $tx; tx_block = $(if ($info) { $info.txBlock } else { $null }); bid_block = $(if ($info) { $info.bidBlock } else { $null })
            landed_after_ms_bot = $(if ($bidEvent) { Get-Prop $bidEvent.data 'landedAfterMs' } else { $null })
            reveal_tx = $(if ($revealEvent) { [string]$revealEvent.tx } else { '' })
            claim_tx = $(if ($claimEvent) { [string]$claimEvent.tx } else { '' })
            tokens = $tokens; spent = $spent; refund = $refund; penalty = $penalty; pays_clearing_price = $pays
        }
    }

    $owner = @()
    foreach ($step in 'create_sale', 'close_sale', 'clear_onchain', 'seed_liquidity', 'claim_proceeds') {
        $e = Get-LastEvent $events 'owner' $step -OkOnly
        if (-not $e) { continue }
        $info = Get-TxInfo ([string]$e.tx) $Account
        $owner += [pscustomobject][ordered]@{ step = $step; tx = [string]$e.tx; block = $(if ($info) { $info.txBlock } else { $null }); at = [string]$e.at }
    }

    # Facts the evidence rests on.
    $winners = @($rows | Where-Object { $_.tokens -and [System.Numerics.BigInteger]::Parse($_.tokens) -gt 0 })
    $paying = @($winners | Where-Object { $_.pays_clearing_price })
    $sniperRows = @($rows | Where-Object { $_.role -eq 'sniper' })
    $lengthsOk = @($rows | Where-Object { $_.payload_bytes -eq $_.expected_bytes }).Count
    $sizes = @($rows | Group-Object payload_bytes | Sort-Object { [int]$_.Name } | ForEach-Object { "$($_.Name) bytes x $($_.Count)" })
    $firstFive = @($rows | Where-Object { $_.ms_after_open -lt 5000 }).Count
    $copies = @($rows | Where-Object { $_.role -eq 'copycat' })
    $mult = ''
    if ($floor -gt 0 -and $final) { $mult = ([decimal][string]$price / $floor).ToString('0.##', $script:Inv) }
    $explorer = 'https://testnet.nearblocks.io/address/'
    $txUrl = $net.explorerTx
    function Get-TxLink { param([string]$Hash) if ($Hash) { "[$($Hash.Substring(0, 8))...]($txUrl$Hash)" } else { 'not recorded' } }
    function Get-KeyText {
        param($Count, $Block)
        if ($null -eq $Count) { return 'not recorded' }
        if ([int]$Count -eq 0) { return "none (locked), read at block $Block" }
        "$Count key(s), read at block $Block"
    }

    $modeText = 'sealed bids opened only inside the OutLayer TEE after the close'
    if ($saleMode -eq 'commit-reveal') { $modeText = 'commit-reveal: hash commitments while bidding, revealed after the close, cleared on chain by clear_onchain' }
    $lines = @(
        "### Testnet evidence sale: $($script:Sale)",
        '',
        "- Contract: [$Contract]($explorer$Contract). Access keys when the sale was created: $(Get-KeyText $(if ($keysAtCreate) { $keysAtCreate.count } else { $null }) $(if ($keysAtCreate) { $keysAtCreate.block } else { $null })); now: $(Get-KeyText @($keysNow.Keys).Count $keysNow.Block). Check: ``near account list-keys $Contract network-config testnet now``",
        "- Token: [$($view.token)]($explorer$($view.token)) ($($view.token_symbol), $(Format-Tokens ([string]$view.total_supply) $decimals) total, $(Format-Tokens ([string]$view.sale_supply) $decimals) for sale)",
        "- Mode: $modeText",
        "- Bidding: $(Format-Ns $start) to $(Format-Ns ([long]$view.bid_end)); $($view.bid_count) bids of $($view.max_bids) slots",
        ''
    )
    if ($final) {
        $failed = @($result.failed_checks)
        $burn = 'nothing unsold'
        if ([System.Numerics.BigInteger]::Parse([string]$result.unsold) -gt 0) {
            $burn = "$(Format-Tokens ([string]$result.unsold) $decimals) unsold, $(if ($result.proceeds.unsold_burned) { 'burned at claim_proceeds' } else { 'to burn at claim_proceeds' })"
        }
        $lines += "- Result: $($result.status)$(if ($result.fail_reason) { " ($($result.fail_reason))" }) at $(Format-Usdc ([string]$price)) USDC per token ($mult x the floor of $(Format-Usdc $floor)); raised $(Format-Usdc $result.total_raised) USDC; sold $(Format-Tokens ([string]$result.total_sold) $decimals); $burn; $($result.n_valid) valid bids, $($result.n_invalid) void; failed checks: $(if ($failed.Count) { $failed -join ', ' } else { 'none' })"
        $lines += "- Winners: $($winners.Count); $($paying.Count) of them paid exactly ceil(tokens x clearing price), the same rule for everyone"
    } else {
        $lines += "- Result: not final yet (status $($result.status))."
    }
    if ($sniperRows.Count) {
        $landed = @($sniperRows | ForEach-Object { $_.ms_after_open } | Measure-Object -Minimum -Maximum)
        $lines += Fmt '- Sniper bots: {0}, placed {1:0.0} s to {2:0.0} s after the open; {3} bid(s) in the first 5 seconds' $sniperRows.Count ($landed.Minimum / 1000) ($landed.Maximum / 1000) $firstFive
    }
    if ($saleMode -eq 'tee') {
        $lines += "- Sealed bids: $lengthsOk of $($rows.Count) are exactly 224 + len(sale id) + len(bidder) bytes ($($sizes -join ', ')): the length says nothing about the price"
    } else {
        $lines += "- Commitments: $lengthsOk of $($rows.Count) are 32 bytes; $(@($rows | Where-Object { $_.revealed }).Count) revealed"
    }
    foreach ($c in $copies) {
        $lines += "- Copycat: $($c.bidder) replayed the bid of $((@($script:Crowd | Where-Object { $_.name -eq $c.name }) | ForEach-Object { $_.victim }) -join '').$Account$(if ($c.penalty) { ": void, penalty $(Format-Usdc $c.penalty) USDC, refund $(Format-Usdc $c.refund) USDC" })"
    }
    if ($AppUrl) { $lines += "- Result page with the Verified panel: $AppUrl/sale/$($script:Sale)/result" }
    $lines += ''
    if ($owner.Count) {
        $lines += '| Step | Transaction | Block |'
        $lines += '| --- | --- | --- |'
        foreach ($o in $owner) { $lines += "| $($o.step) | $(Get-TxLink $o.tx) | $($o.block) |" }
        $lines += ''
    }
    $lines += '| # | Bidder | Role | After open | Bid tx | Block | Bytes | Deposit | Tokens | Spent | Refund | Penalty | Claim |'
    $lines += '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    foreach ($r in $rows) {
        $lines += (Fmt '| {0} | {1} | {2} | {3:0.000} s | {4} | {5} | {6} | {7} | {8} | {9} | {10} | {11} | {12} |' $r.index $r.bidder $r.role ($r.ms_after_open / 1000) `
            (Get-TxLink $r.tx) $(if ($r.bid_block) { $r.bid_block } else { '' }) $r.payload_bytes (Format-Usdc $r.deposit) `
            $(if ($r.tokens) { Format-Tokens $r.tokens $decimals } else { '' }) $(if ($r.spent) { Format-Usdc $r.spent } else { '' }) `
            $(if ($r.refund) { Format-Usdc $r.refund } else { '' }) $(if ($r.penalty) { Format-Usdc $r.penalty } else { '' }) $(if ($r.claim_tx) { Get-TxLink $r.claim_tx } elseif ($r.claimed) { 'claimed' } else { 'not claimed' }))
    }
    $poolInfo = $null
    $liq = Get-Prop $result 'liquidity'
    if ($liq) {
        $lines += ''
        $lines += "- Launch pool: $($liq.status), pool $($liq.pool_id) on $($liq.dex): $(Format-Usdc $liq.usdc) USDC and $(Format-Tokens ([string]$liq.tokens) $decimals) $($view.token_symbol); LP shares $($liq.shares) held by $Contract"
        $poolInfo = [ordered]@{ status = $liq.status; dex = $liq.dex; pool_id = $liq.pool_id; usdc = $liq.usdc; tokens = $liq.tokens; shares = $liq.shares }
        if ($null -ne $liq.pool_id) {
            try {
                $p = Read-View 'get_pool' ([ordered]@{ pool_id = [long]$liq.pool_id }) -On ([string]$liq.dex)
                $ids = @($p.token_account_ids)
                $amounts = @($p.amounts)
                $tokenAt = [array]::IndexOf($ids, [string]$view.token)
                $quoteAt = [array]::IndexOf($ids, [string]$view.quote_token)
                if ($tokenAt -ge 0 -and $quoteAt -ge 0 -and [decimal]$amounts[$tokenAt] -gt 0) {
                    $poolPrice = ([decimal]$amounts[$quoteAt] / $usdc) / ([decimal]::Parse([string]$amounts[$tokenAt]) / [decimal]::Parse('1' + ('0' * $decimals)))
                    $lines += "- Pool reserves now: $(Format-Usdc $amounts[$quoteAt]) USDC and $(Format-Tokens ([string]$amounts[$tokenAt]) $decimals) $($view.token_symbol), price $($poolPrice.ToString('0.########', $script:Inv)) USDC per token"
                    $poolInfo['price_now'] = $poolPrice.ToString('0.########', $script:Inv)
                }
            } catch { $lines += "- Pool reserves: could not read get_pool ($($_.Exception.Message))" }
        }
    }
    $lines += ''
    $lines += 'Check it yourself (read-only, no key, any OS with Node 24):'
    $lines += ''
    $lines += '```'
    $lines += "pnpm --filter web verify-sale --network $Network --contract $Contract --sale $($script:Sale)"
    $lines += '```'
    $text = $lines -join "`n"

    $report = [ordered]@{
        network = $Network; contract = $Contract; sale = $script:Sale; mode = $saleMode; token = $view.token; symbol = $view.token_symbol
        bid_start = $view.bid_start; bid_end = $view.bid_end; floor_price = $view.floor_price; max_bids = $view.max_bids
        keys_at_create = $keysAtCreate
        keys_now = [ordered]@{ count = @($keysNow.Keys).Count; block = $keysNow.Block; keys = @($keysNow.Keys) }
        status = $result.status; fail_reason = $result.fail_reason; clearing_price = $result.clearing_price
        total_sold = $result.total_sold; total_raised = $result.total_raised; unsold = $result.unsold; unsold_burned = $result.proceeds.unsold_burned
        n_valid = $result.n_valid; n_invalid = $result.n_invalid; failed_checks = @($result.failed_checks)
        winners = $winners.Count; winners_paying_clearing_price = $paying.Count; bids_in_first_5s = $firstFive
        ciphertext_lengths_ok = $lengthsOk; owner_txs = $owner; bids = $rows; pool = $poolInfo
    }
    $md = Join-Path $script:OutDir "evidence-$($script:Sale).md"
    $js = Join-Path $script:OutDir "evidence-$($script:Sale).json"
    [IO.File]::WriteAllText($md, $text, $script:Utf8NoBom)
    [IO.File]::WriteAllText($js, (ConvertTo-Json -InputObject $report -Depth 8), $script:Utf8NoBom)
    Write-Host $text
    Write-Host ''
    Write-Host "Saved $md and $js"

    if ([string]$result.status -eq 'settled') {
        $after = $false
        if ($keysAtCreate) { $after = ($keysAtCreate.count -eq 0) }
        $note = Get-SaleNote $rows $result $view $saleMode $mult $liq $keysAtCreate
        Add-SaleEntry $saleMode $after $note
    } else {
        Write-Host "Not added to $($script:SalesFile): the sale is $($result.status), not settled."
    }
}

function Get-SaleNote {
    param($Rows, $Result, $View, [string]$SaleMode, [string]$Mult, $Liq, $KeysAtCreate)
    $n = $Rows.Count
    $sn = @($Rows | Where-Object { $_.role -eq 'sniper' })
    $people = @($Rows | Where-Object { $_.role -eq 'person' -or $_.role -eq 'outside' }).Count
    $parts = @()
    if ($sn.Count) { $parts += Fmt '{0} sniper bot(s) from {1:0.0} s after open' $sn.Count ((@($sn | ForEach-Object { $_.ms_after_open }) | Measure-Object -Minimum).Minimum / 1000) }
    if ($people) { $parts += "$people people" }
    if (@($Rows | Where-Object { $_.role -eq 'copycat' }).Count) { $parts += 'a copycat voided' }
    if (@($Rows | Where-Object { $_.role -eq 'late' }).Count) { $parts += 'a late bid' }
    $how = ''
    if ($SaleMode -eq 'commit-reveal') { $how = 'Commit-reveal, cleared on chain. ' }
    $at = "settled at $(Format-Usdc $Result.clearing_price) ($Mult x floor)"
    $burn = ''
    if ([System.Numerics.BigInteger]::Parse([string]$Result.unsold) -gt 0) { $burn = ", $(Format-Tokens ([string]$Result.unsold) ([int]$View.decimals)) unsold burned" }
    $poolText = ''
    if ($Liq -and $Liq.status -eq 'seeded') { $poolText = ", pool $($Liq.pool_id)" }
    $lock = 'Key list at create not recorded.'
    if ($KeysAtCreate) { $lock = $(if ($KeysAtCreate.count -eq 0) { 'Ran after the contract key was deleted.' } else { 'Ran before the contract key was deleted.' }) }
    "$how$n bids: $($parts -join ', '); $at$burn$poolText. $lock"
}

<# Appends the sale to evidence/sales.json once, keeping the file's two-space layout. #>
function Add-SaleEntry {
    param([string]$SaleMode, [bool]$AfterLock, [string]$Note)
    if (-not (Test-Path -LiteralPath $script:SalesFile)) { Write-Host "No $($script:SalesFile); not adding the sale." -ForegroundColor Yellow; return }
    $text = [IO.File]::ReadAllText($script:SalesFile)
    $list = $text | ConvertFrom-Json
    foreach ($s in @($list.sales)) {
        if ($s.contract -eq $Contract -and $s.sale -eq $script:Sale) { Write-Host "$($script:Sale) is listed in $($script:SalesFile) already."; return }
    }
    $entry = @(
        '    {',
        "      `"contract`": $(ConvertTo-JsonText $Contract),",
        "      `"sale`": $(ConvertTo-JsonText $script:Sale),",
        "      `"mode`": $(ConvertTo-JsonText $SaleMode),",
        "      `"afterLock`": $(if ($AfterLock) { 'true' } else { 'false' }),",
        "      `"note`": $(ConvertTo-JsonText $Note)",
        '    }'
    ) -join "`n"
    $end = $text.LastIndexOf(']')
    if ($end -lt 0) { throw "$($script:SalesFile) has no sales list." }
    $head = $text.Substring(0, $end).TrimEnd()
    $sep = ",`n"
    if ($head.EndsWith('[')) { $sep = "`n" }
    $new = $head + $sep + $entry + "`n  " + $text.Substring($end)
    $null = $new | ConvertFrom-Json    # still valid JSON
    [IO.File]::WriteAllText($script:SalesFile, $new, $script:Utf8NoBom)
    Write-Host "Added $($script:Sale) to $($script:SalesFile) (afterLock $($AfterLock.ToString().ToLowerInvariant()))."
}

# --- Dry run ----------------------------------------------------------------------------------

function Get-BidderState {
    param($Bidder)
    $acc = Get-NearAccount -RpcUrl $script:ReadRpcs -Account $Bidder.id
    $state = [pscustomobject]@{ Bidder = $Bidder; Exists = [bool]$acc; Available = [decimal]0; Registered = $false; Usdc = [decimal]0; KeyFile = (Test-Path -LiteralPath (Get-KeyFile $Bidder.id)) }
    if ($acc) {
        $state.Available = ([decimal]::Parse([string]$acc.amount, $script:Inv) - [decimal]$acc.storage_usage * [decimal]::Parse('10000000000000000000')) / $script:Yocto
        $state.Registered = $null -ne (Read-View 'storage_balance_of' ([ordered]@{ account_id = $Bidder.id }) -On $QuoteToken)
        $state.Usdc = [decimal]::Parse([string](Read-View 'ft_balance_of' ([ordered]@{ account_id = $Bidder.id }) -On $QuoteToken), $script:Inv) / $usdc
    }
    $state
}
# A bidder with less free NEAR than this gets a top-up to -FundNear. Before it
# accepts a transaction, NEAR reserves its gas at a worst-case price: a 100 TGas
# bid or claim needs about 0.101 NEAR free on testnet (it burns far less, about
# 0.003). The swarm accounts made with the old 0.03 default failed every bid.
$script:LowNear = [decimal]0.11
function Get-TopUp { param($State) [Math]::Ceiling(($script:Fund - $State.Available) * 100) / 100 }

function Get-OwnerCommandLine {
    param([string]$ForPhase, [switch]$WithExecute)
    $parts = @('powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1')
    foreach ($key in $script:Bound.Keys) {
        if (@('DryRun', 'Phase', 'Execute') -contains $key) { continue }
        $value = $script:Bound[$key]
        if ($value -is [System.Management.Automation.SwitchParameter]) { if ($value.IsPresent) { $parts += "-$key" }; continue }
        $parts += "-$key $(Format-Argument ([string]$value))"
    }
    $parts += "-Phase $ForPhase"
    if ($WithExecute) { $parts += '-Execute' }
    $parts -join ' '
}

function Show-DryRun {
    $id = $SaleId
    if (-not $id) { $id = New-SaleIdText }
    $design = Get-SaleDesign $id
    $crowd = $design.Crowd
    $est = $design.Estimate
    Write-Host "# Dry run, read-only. Network $Network, contract $Contract, owner $Account, reads via $($script:ReadRpcs -join ', ')" -ForegroundColor Cyan
    Write-Host ''
    Write-Host '## The sale' -ForegroundColor Cyan
    Write-Host "id $id (Create picks the minute it runs), $TokenName ($TokenSymbol), mode $Mode, pool $Pool, $($script:MaxBidsValue) bid slots"
    Write-Host (Fmt 'for sale {0:N0} tokens of {1:N0}, floor {2} USDC, min raise {3} USDC, max deposit 10 USDC' $design.Supply (2L * $design.Supply) (Format-Price $script:FloorUnits) (Format-Usdc $design.MinRaise))
    Write-Host "bidding $(Format-Ns $design.StartNs) to $(Format-Ns $design.EndNs) if Create ran now ($([Math]::Round($design.WindowMs / 60000.0, 1)) min)$(if ($Mode -eq 'CommitReveal') { "; reveal window $RevealWindowMinutes min after the close" }); settle timeout $SettleTimeoutMinutes min"
    if ($StopAfterBids) { Write-Host 'Bid stops after these bids and leaves the sale open.' }
    Write-Host "description ($([Text.Encoding]::UTF8.GetByteCount($design.Params.description)) of 280 bytes): $($design.Params.description)"
    Write-Host ''
    Write-Host '## The crowd' -ForegroundColor Cyan
    $states = @()
    foreach ($b in $crowd) { $states += Get-BidderState $b }
    Write-Host (Fmt '{0,-8} {1,-30} {2,7} {3,10} {4,9}  {5,-14} {6}' 'role' 'account' 'deposit' 'max price' 'max spend' 'when' 'now on chain')
    foreach ($s in $states) {
        $b = $s.Bidder
        $now = 'missing: Accounts creates it'
        if ($s.Exists) {
            $now = Fmt '{0} NEAR free, {1} USDC{2}{3}' (Format-Near $s.Available) $s.Usdc $(if ($s.Registered) { '' } else { ', not registered' }) $(if ($s.KeyFile) { '' } else { ', NO KEY FILE' })
        }
        $terms = Fmt '{0,10} {1,9}' (Format-Price $b.price) $b.spend
        if ($b.role -eq 'copycat') { $terms = Fmt '{0,-20}' "copies $($b.victim)" }
        Write-Host (Fmt '{0,-8} {1,-30} {2,7} {3}  {4,-14} {5}' $b.role $b.id $b.deposit $terms (Format-Offset $b.offset_ms) $now)
    }
    $lens = @($crowd | ForEach-Object { 224 + $id.Length + $_.id.Length } | Sort-Object -Unique)
    if ($Mode -eq 'Tee') { Write-Host "Sealed bid sizes: $($lens -join ', ') bytes (224 + len(sale id) + len(bidder))." }
    Write-Host ''
    Write-Host '## Expected clearing (the reference rule on these terms; the enclave or clear_onchain decides)' -ForegroundColor Cyan
    $soldText = Format-Tokens $est.sold.ToString()
    Write-Host (Fmt 'price {0} USDC ({1:0.##} x the floor), {2}; sold {3} of {4:N0}, raised {5} USDC, unsold {6} (burned at claim_proceeds)' `
        (Format-Price $est.price) ($est.price / [double]$script:FloorUnits) $(if ($est.over) { 'oversubscribed' } else { 'undersubscribed' }) $soldText $design.Supply `
        (Format-Usdc $est.raised.ToString()) (Format-Tokens $est.unsold.ToString()))
    foreach ($b in $crowd) {
        if ($b.role -eq 'copycat') { Write-Host (Fmt '  {0,-9} void (copied bid), pays 1 % of {1} USDC' $b.name $b.deposit); continue }
        $f = $est.fills[$b.name]
        if (-not $f) { Write-Host (Fmt '  {0,-9} invalid terms' $b.name); continue }
        Write-Host (Fmt '  {0,-9} {1,12} tokens for {2,9} USDC, {3} USDC back' $b.name (Format-Tokens $f.tokens.ToString()) (Format-Usdc $f.spent.ToString()) (Format-Usdc ([decimal]$b.deposit * 1000000 - [decimal]::Parse($f.spent.ToString()))))
    }
    Write-Host ''

    Write-Host '## NEAR' -ForegroundColor Cyan
    $saleArgs = ConvertTo-Json -InputObject ([ordered]@{ params = $design.Params }) -Depth 10 -Compress
    $cost = [decimal]::Parse([string](Read-View 'get_create_cost' $saleArgs), $script:Inv) / $script:Yocto
    $one = $design.Params
    $one['max_bids'] = 1
    $costOne = [decimal]::Parse([string](Read-View 'get_create_cost' (ConvertTo-Json -InputObject ([ordered]@{ params = $one }) -Depth 10 -Compress)), $script:Inv) / $script:Yocto
    $one['max_bids'] = $script:MaxBidsValue
    $perSlot = [decimal]0
    if ($script:MaxBidsValue -gt 1) { $perSlot = ($cost - $costOne) / ($script:MaxBidsValue - 1) }
    $attach = $cost + [decimal]0.05
    if ($Deposit) { $attach = [decimal]::Parse($Deposit, $script:Inv) }
    $attach = [Math]::Ceiling($attach * 100) / 100
    $newAccounts = @($states | Where-Object { -not $_.Exists })
    $topUps = @($states | Where-Object { $_.Exists -and $_.Available -lt $script:LowNear })
    $registers = @($states | Where-Object { -not $_.Registered })
    $mints = @($states | Where-Object { -not $_.Exists -or $_.Usdc -lt [decimal]$_.Bidder.deposit })
    $topUpSum = [decimal]0
    foreach ($s in $topUps) { $topUpSum += Get-TopUp $s }
    $fundSum = $script:Fund * $newAccounts.Count
    $registerSum = [decimal]0.00125 * $registers.Count
    $calls = $newAccounts.Count + $topUps.Count + $registers.Count + $mints.Count + 5
    $gas = [decimal]0.001 * $calls
    $closeAttach = [decimal]0
    if ($Mode -eq 'Tee') { $closeAttach = [decimal]0.05 }
    $peak = $attach + $fundSum + $topUpSum + $registerSum + $gas + $closeAttach + [decimal]0.31
    $slotsBack = $perSlot * [Math]::Max(0, $script:MaxBidsValue - $crowd.Count)
    Write-Host (Fmt 'create_sale costs {0} NEAR (get_create_cost; {1} NEAR per bid slot); attach {2} (the rest comes back at once or from OutLayer)' (Format-Near $cost) (Format-Near $perSlot) (Format-Near $attach))
    Write-Host (Fmt '  about {0} NEAR of it comes back at claim_proceeds: {1} unused slots{2}; the token account''s storage (about 1.7) does not' (Format-Near ($slotsBack + $(if ($Pool -eq 'on') { [decimal]0.015 } else { [decimal]0 }))) ([Math]::Max(0, $script:MaxBidsValue - $crowd.Count)) $(if ($Pool -eq 'on') { ' and most of the 0.015 pool reserve' } else { '' }))
    Write-Host (Fmt 'accounts: {0} new x {1} = {2}; {3} top-up(s) = {4}; {5} USDC registration(s) x 0.00125 = {6}; {7} mint(s)' $newAccounts.Count (Format-Near $script:Fund) (Format-Near $fundSum) $topUps.Count (Format-Near $topUpSum) $registers.Count (Format-Near $registerSum) $mints.Count)
    Write-Host (Fmt 'owner gas for about {0} calls: up to {1}; close_sale attaches {2} (OutLayer returns what it does not charge); about 0.31 free for a 300 TGas call (reserved at a worst-case gas price)' $calls (Format-Near $gas) (Format-Near $closeAttach))
    $owner = Get-NearAccount -RpcUrl $script:ReadRpcs -Account $Account
    $free = [decimal]0
    if ($owner) { $free = ([decimal]::Parse([string]$owner.amount, $script:Inv) - [decimal]$owner.storage_usage * [decimal]::Parse('10000000000000000000')) / $script:Yocto }
    Write-Host (Fmt 'peak the owner needs: about {0} NEAR; leaves the owner for good: about {1} NEAR (the bidders keep what is left of their funding). {2} has {3} NEAR free{4}.' (Format-Near $peak) (Format-Near ($cost - $slotsBack + $fundSum + $topUpSum + $registerSum + $gas)) $Account (Format-Near $free) $(if ($free -lt $peak) { ': NOT ENOUGH, move NEAR in first' } else { '' })) -ForegroundColor $(if ($free -lt $peak) { 'Yellow' } else { 'Gray' })
    Write-Host 'Each bidder pays its own gas (about 0.002 to 0.005 NEAR a sale) from its account.'
    Write-Host ''

    Write-Host '## The contract' -ForegroundColor Cyan
    $keys = Get-AccessKeyList -RpcUrl $script:ReadRpcs -Account $Contract
    if (@($keys.Keys).Count -eq 0) { Write-Host "No access keys at block $($keys.Block): locked. Create records this as afterLock true." }
    else { Write-Host "$(@($keys.Keys).Count) access key(s) at block $($keys.Block): NOT locked. Create refuses until the key is deleted (or -AllowKeys)." -ForegroundColor Yellow }
    if ($Pool -eq 'on') {
        $config = Read-View 'get_config'
        if (-not (Get-Prop $config 'dex')) { Write-Host "$Contract has no dex: -Pool on cannot work." -ForegroundColor Yellow } else { Write-Host "Launch pool on $($config.dex)." }
    }
    if ($SaleId -and (Read-View 'get_sale' ([ordered]@{ sale_id = $SaleId }))) { Write-Host "Sale $SaleId exists already: Create will only save it and wait for its setup." -ForegroundColor Yellow }
    Write-Host ''

    Write-Host '## Phases (the owner runs each with -Execute and types the network name)' -ForegroundColor Cyan
    Write-Host '1. Accounts: create, top up, register and mint as needed'
    Write-Host "   $(Get-OwnerCommandLine 'Accounts' -WithExecute)"
    Write-Host "2. Create: bidding opens $StartInMinutes min after it runs"
    Write-Host "   $(Get-OwnerCommandLine 'Create' -WithExecute)"
    Write-Host '3. Bid: right after Create, before the open; it runs until the last bid'
    Write-Host "   $(Get-OwnerCommandLine 'Bid' -WithExecute)"
    if ($StopAfterBids) {
        Write-Host '4. Close: after the end of bidding (the sale stays open until then)'
    } else {
        Write-Host '4. Close: after the end of bidding'
    }
    Write-Host "   $(Get-OwnerCommandLine 'Close' -WithExecute)"
    Write-Host '5. Report: read-only; adds the sale to evidence/sales.json once settled'
    Write-Host "   $(Get-OwnerCommandLine 'Report')"
}

# --- Running a plan -------------------------------------------------------------------------

<# Invoke-Plan with one addition: owner commands marked Record run through near CLI with their output captured, so the transaction hash goes into the run log. #>
function Invoke-EvidencePlan {
    param([Parameter(Mandatory)]$Plan)
    $signing = @($Plan | Where-Object { $_.Signs }).Count
    Write-Host "About to run $($Plan.Count) steps on $Network ($signing of them sign transactions)." -ForegroundColor Yellow
    $answer = Read-Host "Type '$Network' to continue"
    if ($answer -ne $Network) { throw 'Not confirmed; nothing was run.' }
    $n = 0
    foreach ($step in $Plan) {
        $n++
        Write-Host ''
        Write-Host ("# {0}. {1}" -f $n, $step.Title) -ForegroundColor Cyan
        switch ($step.Kind) {
            'note' { if ($step.Expect) { Write-Host $step.Expect -ForegroundColor DarkGray } }
            'check' { & $step.Check }
            'command' {
                $record = Get-Prop $step 'Record'
                if ($record) {
                    Invoke-OwnerCall $record $step.Arguments $step.Expect
                } else {
                    Write-Host (Format-CommandLine $step) -ForegroundColor DarkGray
                    if (-not (Get-Command $step.Exe -ErrorAction SilentlyContinue)) { throw "'$($step.Exe)' is not on PATH. See enclave\README.md, Prerequisites." }
                    $stepArgs = @($step.Arguments)
                    & $step.Exe @stepArgs
                    if ($LASTEXITCODE -ne 0) { throw "Step $n failed (exit code $LASTEXITCODE). Fix it and run the script again." }
                    if ($step.Expect) { Write-Host ("Expected: " + $step.Expect) -ForegroundColor DarkGray }
                }
            }
        }
    }
}

# --- The phases --------------------------------------------------------------------------------

if ($DryRun) {
    Show-DryRun
    return
}

$script:Sale = $null
$script:State = $null
$script:Crowd = @()
$script:SaleMode = Get-ModeText $Mode
$script:BidStart = 0L
$script:BidEnd = 0L
$script:RevealEnd = 0L
if ($Phase -eq 'Create') {
    if (-not $SaleId) { $SaleId = New-SaleIdText }
    if ($SaleId -cnotmatch '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$') { throw "-SaleId '$SaleId' breaks the sale id rule." }
    Assert-AccountId "$SaleId.$Contract" 'The token account <SaleId>.<Contract>'
    $script:Sale = $SaleId
} elseif ($Phase -ne 'Accounts') {
    $script:State = Read-SaleState
    if ($script:State.contract -ne $Contract) { throw "The saved sale is on $($script:State.contract), not $Contract. Pass -Contract or -SaleId." }
    $script:Sale = [string]$script:State.sale_id
    $script:Crowd = @(Get-StateCrowd $script:State)
    $script:BidStart = [long]$script:State.bid_start
    $script:BidEnd = [long]$script:State.bid_end
    $savedMode = Get-Prop $script:State 'mode'
    if ($savedMode) { $script:SaleMode = [string]$savedMode } else { $script:SaleMode = 'tee' }
}

$plan = New-Plan
$preamble = Write-Preamble $net $Account "# Contract: $Contract   phase: $Phase$(if ($script:Sale) { "   sale: $($script:Sale)" })"

switch ($Phase) {
    'Accounts' {
        $crowd = Get-ScriptCrowd
        Write-Host "Reading $($crowd.Count) bidder accounts (read-only)..."
        foreach ($b in $crowd) {
            $s = Get-BidderState $b
            $id = $b.id
            if (-not $s.Exists) {
                Add-Command $plan "Create $id ($(Format-Near $script:Fund) NEAR, key saved to the legacy keychain)" 'near' `
                    @('account', 'create-account', 'fund-myself', $id, "$(Format-Near $script:Fund) NEAR", 'autogenerate-new-keypair',
                      'save-to-legacy-keychain', 'sign-as', $Account, 'network-config', $net.nearCliNetwork,
                      'sign-with-keychain', 'send') -Signs `
                    -Expect "New account $id. Its key file: $(Get-KeyFile $id)"
            } elseif (-not $s.KeyFile) {
                throw "$id exists but there is no key file at $(Get-KeyFile $id), so the bot cannot bid as it. Put its key file there, or leave it out (-FreshAccounts, another -Seed or fewer -Bidders)."
            } elseif ($s.Available -lt $script:LowNear) {
                $amount = Get-TopUp $s
                Add-Command $plan "Top up $id ($(Format-Near $s.Available) NEAR free) with $(Format-Near $amount) NEAR" 'near' `
                    @('tokens', $Account, 'send-near', $id, "$(Format-Near $amount) NEAR", 'network-config', $net.nearCliNetwork,
                      'sign-with-keychain', 'send') -Signs
            }
            if (-not $s.Registered) {
                $register = New-JsonFile -Network $Network -OutName "register-$id.json" -Object ([ordered]@{ account_id = $id; registration_only = $true })
                Add-Command $plan "Register $id on $QuoteToken (paid by $Account)" 'near' `
                    @('contract', 'call-function', 'as-transaction', $QuoteToken, 'storage_deposit', 'file-args', $register,
                      'prepaid-gas', '30 Tgas', 'attached-deposit', '0.00125 NEAR', 'sign-as', $Account,
                      'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs
            }
            if ($s.Usdc -lt [decimal]$b.deposit) {
                $units = [long](([decimal]10 - $s.Usdc) * $usdc)
                $mint = New-JsonFile -Network $Network -OutName "mint-$id.json" -Object ([ordered]@{ account_id = $id; amount = "$units" })
                Add-Command $plan "Mint $(Format-Usdc $units) test USDC to $id (holds $($s.Usdc), bids $($b.deposit))" 'near' `
                    @('contract', 'call-function', 'as-transaction', $QuoteToken, 'mint', 'file-args', $mint,
                      'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', $Account,
                      'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs
            }
        }
        if ($plan.Count -eq 0) { Add-Note $plan "All $($crowd.Count) bidders exist, hold NEAR and enough USDC, and have key files. Nothing to do." }
        $script:AccountsCrowd = $crowd
        Add-Check $plan 'Check every bidder: key file, NEAR and USDC' {
            $bad = @()
            foreach ($b in $script:AccountsCrowd) {
                $s = Get-BidderState $b
                Write-Host (Fmt '{0,-30} key file {1}, {2} NEAR free, {3} USDC (bids {4})' $b.id $(if ($s.KeyFile) { 'ok' } else { 'MISSING' }) (Format-Near $s.Available) $s.Usdc $b.deposit)
                if (-not $s.KeyFile -or -not $s.Exists -or $s.Usdc -lt [decimal]$b.deposit -or $s.Available -lt [decimal]0.011) { $bad += $b.id }
            }
            if ($bad.Count) { throw "Not ready: $($bad -join ', '). Run this phase again." }
            Write-Host 'Every bidder is ready. Next: -Phase Create -Execute'
        }
    }

    'Create' {
        $existing = Read-View 'get_sale' ([ordered]@{ sale_id = $SaleId })
        $design = Get-SaleDesign $SaleId
        $script:Design = $design
        $saleArgs = New-JsonFile -Network $Network -OutName "create-$SaleId.json" -Object ([ordered]@{ params = $design.Params })
        $script:SaleIdArgs = New-JsonFile -Network $Network -OutName "sale-id-$SaleId.json" -Object ([ordered]@{ sale_id = $SaleId })
        $est = $design.Estimate
        Add-Note $plan "Sale $SaleId`: $TokenName ($TokenSymbol), $Mode, pool $Pool, $(Fmt '{0:N0}' $design.Supply) for sale at a floor of $(Format-Price $script:FloorUnits), $($script:MaxBidsValue) slots" `
            ((@("Bidding $(Format-Ns $design.StartNs) to $(Format-Ns $design.EndNs) (fixed in the arguments file now: confirm within $StartInMinutes min).",
                "Description: $($design.Params.description)",
                (Fmt 'Expected (reference rule): {0} USDC, {1:0.##} x the floor, unsold {2} tokens.' (Format-Price $est.price) ($est.price / [double]$script:FloorUnits) (Format-Tokens $est.unsold.ToString()))) + @(Format-CrowdTable $design.Crowd)) -join "`n")
        if ($existing) {
            if ($existing.creator -ne $Account) { throw "Sale $SaleId exists and was created by $($existing.creator), not $Account." }
            Add-Note $plan "Sale $SaleId exists already (status $($existing.status)). Skipping create_sale: saving it and waiting for its setup."
        } else {
            Add-Check $plan 'Read the contract''s access keys (a locked contract has none)' {
                $k = Get-AccessKeyList -RpcUrl $script:ReadRpcs -Account $Contract
                $count = @($k.Keys).Count
                Add-RunEvent -Kind 'keys' -Who 'create' -Ok $true -Data ([ordered]@{ count = $count; block = $k.Block; keys = @($k.Keys) })
                if ($count -eq 0) { Write-Host "No access keys at block $($k.Block): the contract is locked. Recorded for the report." }
                elseif ($AllowKeys) { Write-Host "$count access key(s) at block $($k.Block): not locked. -AllowKeys: going on; this sale counts as before the lock." -ForegroundColor Yellow }
                else { throw "$Contract has $count access key(s) at block $($k.Block): it is not locked. Delete its key first (/deploy step 8, LAUNCH.md T8), or pass -AllowKeys for a sale that counts as before the lock." }
            }
            Add-Check $plan 'Check the cost, the exchange and the bidders' {
                $cost = [decimal]::Parse([string](Read-View 'get_create_cost' ([IO.File]::ReadAllText($script:CreateArgsFile))), $script:Inv)
                if ($script:CreateAttach * $script:Yocto -lt $cost) { throw "create_sale costs $(Format-Near ($cost / $script:Yocto)) NEAR; attaching $($script:CreateAttach) is too little." }
                Write-Host "create_sale costs $(Format-Near ($cost / $script:Yocto)) NEAR; attaching $($script:CreateAttach) NEAR (the excess comes back)."
                if ($Pool -eq 'on') {
                    $config = Read-View 'get_config'
                    if (-not (Get-Prop $config 'dex')) { throw "$Contract has no dex in get_config: launch liquidity is off. Use -Pool off." }
                    Write-Host "Launch liquidity on $($config.dex)."
                }
                $bad = @()
                foreach ($b in $script:Design.Crowd) {
                    if (-not (Test-Path -LiteralPath (Get-KeyFile $b.id))) { $bad += "$($b.id) (no key file)"; continue }
                    $held = [decimal]::Parse([string](Read-View 'ft_balance_of' ([ordered]@{ account_id = $b.id }) -On $QuoteToken), $script:Inv) / $usdc
                    if ($held -lt [decimal]$b.deposit) { $bad += "$($b.id) (holds $held USDC, bids $($b.deposit))" }
                }
                if ($bad.Count) { throw "Bidders not ready: $($bad -join '; '). Run -Phase Accounts -Execute with the same arguments first." }
                Write-Host "All $(@($script:Design.Crowd).Count) bidders have key files and USDC."
            }
            $attach = $Deposit
            if (-not $attach) {
                $cost = [decimal]::Parse([string](Read-View 'get_create_cost' ([IO.File]::ReadAllText($saleArgs))), $script:Inv) / $script:Yocto
                $attach = Format-Near ([Math]::Ceiling(($cost + [decimal]0.05) * 100) / 100)
            }
            $script:CreateArgsFile = $saleArgs
            $script:CreateAttach = [decimal]::Parse($attach, $script:Inv)
            $title = "Create sale '$SaleId' ($TokenName, $TokenSymbol; $Mode$(if ($Pool -eq 'on') { '; 20 % of the raise opens a Rhea pool' }))"
            Add-OwnerCommand $plan 'create_sale' $title (Get-NearCall 'create_sale' $saleArgs '300 Tgas' "$attach NEAR") `
                'Logs sale_created, then the token deploy (and in TEE mode the key request).'
        }
        Add-Check $plan 'Save the sale and its crowd, then wait for its setup' {
            $view = $null
            for ($i = 1; $i -le 12 -and -not $view; $i++) {
                $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
                if (-not $view) { Start-Sleep -Seconds 3 }
            }
            if (-not $view) { throw "Sale $($script:Sale) is not on chain. Check the create_sale output." }
            $crowd = @($script:Design.Crowd)
            Set-CrowdTimes $crowd ([long](([long]$view.bid_end - [long]$view.bid_start) / 1000000L))
            $saved = [ordered]@{
                v = 2; contract = $Contract; sale_id = $script:Sale; token = $view.token; bid_start = $view.bid_start; bid_end = $view.bid_end
                created_by = $Account; mode = (Get-ModeText $view.reveal_mode); pool = [bool]$view.liquidity; stop_after_bids = [bool]$StopAfterBids
                people_minutes = $PeopleMinutes; seed = $Seed; demand = $Demand; floor_price = $view.floor_price; sale_supply = $view.sale_supply
                crowd = $crowd
            }
            Save-SaleState $saved
            Write-Host "Saved $(Get-StateFile $script:Sale)."
            for ($i = 1; $i -le 30; $i++) {
                if ($view.sealer_key_setup -ne 'pending' -and $view.token_setup -ne 'pending') { break }
                if ($i -eq 1 -or $i % 3 -eq 0) { Write-Host "Still in setup (token $($view.token_setup), key $($view.sealer_key_setup)); waiting..." }
                Start-Sleep -Seconds 10
                $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
            }
            if ($view.sealer_key_setup -ne 'done' -or $view.token_setup -ne 'done') {
                throw "Setup did not finish: token $($view.token_setup), key $($view.sealer_key_setup). See enclave\README.md, Troubleshooting; run this phase again with -SaleId $($script:Sale) to wait again."
            }
            Write-Host "Sale $($script:Sale) is ready$(if ($view.sealer_pubkey) { ". Sale key $($view.sealer_pubkey)" })."
            Write-Host "Bidding: $(Format-Ns ([long]$view.bid_start)) to $(Format-Ns ([long]$view.bid_end))."
            Write-Host "Next, now (before the open): -Phase Bid -Execute" -ForegroundColor Green
        }
    }

    'Bid' {
        foreach ($b in $script:Crowd) {
            if (-not (Test-Path -LiteralPath (Get-KeyFile $b.id))) { throw "No key file for $($b.id): run -Phase Accounts." }
        }
        if ((Get-NowNs) -ge $script:BidEnd - 20L * $second) { throw "Bidding ended (or ends in under 20 s) at $(Format-Ns $script:BidEnd)." }
        $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
        if (@('setup', 'upcoming', 'open') -notcontains [string]$view.status) { throw "Sale $($script:Sale) is $($view.status): nothing to bid on." }
        # The phase can be run again: bidders with a bid (read-only) are left out.
        $bids = Get-BidMap
        $todo = @()
        foreach ($b in $script:Crowd) {
            if ($bids[$b.id]) { Add-Note $plan "$($b.name) has a bid already. Skipping." } else { $todo += $b }
        }
        $script:First = @($todo | Where-Object { $_.role -eq 'sniper' -or $_.role -eq 'copycat' })
        $script:Later = @($todo | Where-Object { $_.role -eq 'person' -or $_.role -eq 'late' } | Sort-Object { [long]$_.offset_ms })
        $examples = @()
        foreach ($role in 'sniper', 'person', 'copycat', 'late') {
            $b = @($todo | Where-Object { $_.role -eq $role })[0]
            if ($b) { $examples += "  pnpm $(@(Get-BotArguments (Get-BidCommand $b) $b (Get-BidExtra $b) $script:BotRpcs[[int]$b.rpc % $script:BotRpcs.Count]) -join ' ')" }
        }
        $table = (@("Bidding $(Format-Ns $script:BidStart) to $(Format-Ns $script:BidEnd); mode $($script:SaleMode).") + @(Format-CrowdTable $todo) +
            @('One background process per bid; a command of each kind:') + $examples + @("Output: $(Join-Path $script:OutDir "run-$($script:Sale)")\<name>.<command>.<attempt>.json|err")) -join "`n"
        if ($todo.Count -eq 0) {
            Add-Note $plan 'Every bidder has a bid.'
        } else {
            Add-Note $plan "$($todo.Count) bid(s) to place" $table
        }
        if ($script:First.Count) {
            Add-Check $plan "Start $($script:First.Count) bot(s) at once: the snipers wait for the open, the copycat for its victim's bid (signs $($script:First.Count) bid(s))" { Start-FirstBids }
            $plan[$plan.Count - 1].Signs = $true
        }
        if ($script:Later.Count) {
            Add-Check $plan "People bid on their schedule, then the late bid (signs $($script:Later.Count) bid(s))" { Invoke-Schedule }
            $plan[$plan.Count - 1].Signs = $true
        }
        Add-Check $plan 'Wait for every bot, record the bids, and show the bid set' {
            if ($script:Runs.Count -and (Get-NowNs) -lt $script:BidStart) { Wait-Until ($script:BidStart + 5L * $second) 'Until the open' }
            Update-Bots -Wait
            Show-BidSummary
        }
    }

    'Close' {
        $script:SaleIdArgs = New-JsonFile -Network $Network -OutName "sale-id-$($script:Sale).json" -Object ([ordered]@{ sale_id = $script:Sale })
        $view = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
        $result = Read-View 'get_result' ([ordered]@{ sale_id = $script:Sale })
        $status = [string]$view.status
        $cr = [string]$view.reveal_mode -eq 'CommitReveal'
        $final = @('settled', 'failed') -contains $status
        $proceedsDone = $final -and $result.proceeds.raise_paid -and $result.proceeds.allocation_paid -and
            ($result.proceeds.unsold_burned -or [string]$result.unsold -eq '0') -and $result.proceeds.reserve_returned
        if ($final) {
            Add-Note $plan "The sale is $status already. Skipping the close$(if ($cr) { ', the reveals and clear_onchain' })."
        } elseif ($cr) {
            if (@('setup', 'upcoming', 'open', 'awaiting_close') -contains $status) {
                Add-Check $plan 'Wait for the end of bidding' { Wait-Until ($script:BidEnd + 5L * $second) 'Until bidding ends' }
                Add-OwnerCommand $plan 'close_sale' 'Close the sale: the bid set freezes and the reveal window opens' `
                    (Get-NearCall 'close_sale' $script:SaleIdArgs '100 Tgas' '0 NEAR') 'Return value "revealing".'
            }
            Add-Check $plan 'Every bidder reveals its bid from its snipe receipt (the copycat cannot)' { Invoke-Reveals }
            $plan[$plan.Count - 1].Signs = $true
            Add-Check $plan 'Wait for the end of the reveal window' {
                $v = Read-View 'get_sale' ([ordered]@{ sale_id = $script:Sale })
                if ($v.status -eq 'revealing') { Wait-Until ([long]$v.reveal_end + 5L * $second) 'Until the reveal window ends' }
            }
            Add-OwnerCommand $plan 'clear_onchain' 'Clear the sale on chain: the contract runs the clearing itself (anyone may call it)' `
                (Get-NearCall 'clear_onchain' $script:SaleIdArgs '300 Tgas' '0 NEAR') 'Return value "settled"; unrevealed bids are void and pay the 1 % penalty.'
        } elseif ($status -eq 'clearing') {
            Add-Note $plan 'The enclave is clearing the sale already. Skipping close_sale.'
        } else {
            $required = [decimal]0
            try { $required = [decimal]::Parse([string](Read-View 'get_close_deposit' ([ordered]@{ sale_id = $script:Sale })), $script:Inv) / $script:Yocto } catch { $required = [decimal]0.02 }
            $attach = Format-Near ([Math]::Max([decimal]0.02, [Math]::Ceiling($required * [decimal]1.25 * 1000) / 1000))
            Add-Check $plan 'Wait for the end of bidding' { Wait-Until ($script:BidEnd + 5L * $second) 'Until bidding ends' }
            Add-OwnerCommand $plan 'close_sale' "Close the sale: the frozen bid set goes to the enclave (attaches $attach NEAR; get_close_deposit says $(Format-Near $required))" `
                (Get-NearCall 'close_sale' $script:SaleIdArgs '300 Tgas' "$attach NEAR") 'sale_closed, clearing_requested, OutLayer execution_completed, sale_settled.'
        }
        Add-Check $plan 'Read the result (waits while the enclave clears)' { Wait-Result }
        if ($view.liquidity) {
            Add-Check $plan 'Seed the Rhea pool at the clearing price (anyone may call it)' { Invoke-Seed } `
                -Text ("Runs while the pool is seeding:`n" + (Format-CommandLine ([pscustomobject]@{ Exe = 'near'; Arguments = (Get-NearCall 'seed_liquidity' $script:SaleIdArgs) })))
            $plan[$plan.Count - 1].Signs = $true
        }
        $nowBids = Get-BidMap
        $unclaimed = @($nowBids.Keys | Where-Object { -not $nowBids[$_].claimed } | Sort-Object { [int]$nowBids[$_].index })
        Add-Check $plan "Every bidder claims its tokens and refund ($Parallel at a time)" { Invoke-Claims } `
            -Text ("Reads every bid again once the result is final and claims each unclaimed one with`n" +
                "pnpm --silent --filter web live-bot report --claim --direct --json ... (one bot per bidder)`n" +
                "Unclaimed right now ($($nowBids.Count) bids): $(if ($unclaimed.Count) { $unclaimed -join ', ' } else { 'none' })")
        $plan[$plan.Count - 1].Signs = $true
        if ($proceedsDone) {
            Add-Note $plan 'The creator has claimed the proceeds already. Skipping claim_proceeds.'
        } else {
            Add-OwnerCommand $plan 'claim_proceeds' 'The creator claims the raise, the allocation and the NEAR reserve; the unsold supply burns' `
                (Get-NearCall 'claim_proceeds' $script:SaleIdArgs '300 Tgas' '0 NEAR')
        }
        Add-Note $plan 'Next: -Phase Report (read-only) writes the evidence and adds the sale to evidence/sales.json'
    }

    'Report' {
        Add-Check $plan 'Evidence for README section 7' { Invoke-Report }
    }
}

if ($Phase -eq 'Report') {
    foreach ($step in $plan) { & $step.Check }
} elseif ($Execute) {
    Invoke-EvidencePlan $plan
} else {
    Show-Plan $plan $preamble
}
