<#
.SYNOPSIS
Step 8: the evidence sale. One meme-token sale on testnet with launch
liquidity, a sniper bot that bids in the first block, four people, a copycat
and a late bid, cleared by the enclave, its Rhea pool seeded at the clearing
price, and every claim. Its links go into README section 7 for the judges.

.DESCRIPTION
Run the phases in order. Each phase prints its commands; -Execute runs them
after you type the network name. Nothing here signs without -Execute, and the
project owner runs it: it signs as -Account and as the bidder accounts.

  Accounts  Creates the bidders as sub-accounts of -Account (0.25 NEAR each;
            near CLI saves their keys to the legacy keychain,
            ~/.near-credentials/<network>/<account>.json, where the bot reads
            them), registers them on the test USDC and mints them 10 USDC each.
  Create    Creates the sale with launch liquidity. Bidding opens
            -StartInMinutes from now and lasts -DurationMinutes. Waits for the
            sale's key from the enclave. Saves the sale's times for the next
            phases in deploy\out\<network>\evidence-sale.json.
  Bid       Starts the sniper, which waits for the open and bids in the first
            block it can. Then ana, ravi and mei bid, copy replays ravi's
            sealed bid, and late bids in the last two minutes.
  Close     After bid_end: closes the sale (the enclave clears it), seeds the
            Rhea pool, and claims for every bidder and for the creator.
  Report    Read-only. Prints the evidence as Markdown for README section 7.

The bids, in USDC (max price per whole token):

  bidder  deposit  max price  max spend
  sniper  5        0.004      5          first block
  ana     6        0.003      5
  ravi    5        0.0025     5
  mei     3        0.0015     3          below the clearing price: refunded
  copy    5        (ravi's sealed bytes) same id length as ravi: voided, 1 % penalty
  late    6        0.0035     5          last two minutes

The sale: 10,000 NOSNIPE for sale, floor 0.001. Demand above 0.002 is 20 USDC
from four bidders, exactly 10,000 tokens at 0.002, so the clearing price is
0.002 (twice the floor): sniper, ana, ravi and late each get 2,500 tokens for
5 USDC, ana and late get 1 USDC back, mei gets all 3 USDC back. 20 % of the
raise (4 USDC) and 2,000 reserved tokens open the pool at exactly 0.002. The
creator keeps 8,000 tokens and 16 USDC.

.PARAMETER Account
The owner: creates the bidder accounts, the sale, and signs close, seed and
claim_proceeds.

.PARAMETER Contract
Default sealround.<Account>.

.PARAMETER SaleId
Default nosnipe-<MMddHHmm> (UTC) in phase Create; later phases read it from
evidence-sale.json.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\8-evidence-sale.ps1 -Account alice.testnet -Phase Accounts
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [Parameter(Mandatory)][ValidateSet('Accounts', 'Create', 'Bid', 'Close', 'Report')][string]$Phase,
    [string]$Contract,
    [string]$SaleId,
    [string]$QuoteToken = 'usdc.fakes.testnet',
    [ValidateRange(3, 120)][int]$StartInMinutes = 6,
    [ValidateRange(6, 240)][int]$DurationMinutes = 10,
    [string]$Deposit = '3',
    [string]$AppUrl = '',
    # The bots' RPC. rpc.testnet.near.org dropped bot calls during the first
    # run ("Could not reach the NEAR RPC node"); FastNear answered every read.
    [string]$BotRpc = 'https://rpc.testnet.fastnear.com',
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')

if ($Network -ne 'testnet') { throw 'The evidence sale is a testnet run; mainnet has its own capped pilot (LAUNCH.md).' }
$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $Contract) { $Contract = "sealround.$Account" }
Assert-AccountId $Contract '-Contract'
Assert-AccountId $QuoteToken '-QuoteToken'
if ($Deposit -notmatch '^\d+(\.\d+)?$') { throw '-Deposit is a NEAR amount such as 3 or 2.5.' }

$stateFile = Join-Path (Get-OutDir $Network) 'evidence-sale.json'
$keyDir = Join-Path (Join-Path $HOME '.near-credentials') $Network
$usdc = [decimal]1000000    # base units per USDC (6 decimals)

# Bidders. Names are short so every account id stays valid; copy and ravi have
# the same length, so copy's replay of ravi's bid passes the length check and
# is voided by the enclave instead.
$bidders = [ordered]@{
    sniper = @{ deposit = '5'; price = '0.004'; spend = '5' }
    ana    = @{ deposit = '6'; price = '0.003'; spend = '5' }
    ravi   = @{ deposit = '5'; price = '0.0025'; spend = '5' }
    mei    = @{ deposit = '3'; price = '0.0015'; spend = '3' }
    copy   = @{ deposit = '5' }
    late   = @{ deposit = '6'; price = '0.0035'; spend = '5' }
}
function Get-BidderId { param([string]$Name) "$Name.$Account" }
foreach ($name in $bidders.Keys) { Assert-AccountId (Get-BidderId $name) "Bidder $name" }
if ((Get-BidderId 'copy').Length -ne (Get-BidderId 'ravi').Length) { throw 'copy and ravi must have account ids of the same length.' }

function Get-KeyFile { param([string]$Name) Join-Path $keyDir ((Get-BidderId $Name) + '.json') }

function Read-State {
    if (-not (Test-Path -LiteralPath $stateFile)) { throw "No $stateFile. Run -Phase Create first." }
    [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
}

function Get-NowNs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000L }
function Format-Ns { param([long]$Ns) [DateTimeOffset]::FromUnixTimeMilliseconds([long]($Ns / 1000000L)).UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss') + ' UTC' }

function Wait-Until {
    param([long]$Ns, [string]$What)
    while ($true) {
        $left = [long](($Ns - (Get-NowNs)) / 1000000000L)
        if ($left -le 0) { break }
        Write-Host ("{0}: {1} s left" -f $What, $left)
        Start-Sleep -Seconds ([Math]::Min(30, [Math]::Max(1, $left)))
    }
}

# The live bot, through pnpm from the repo root. Settings it shares go in the
# environment; the key always comes from a key file.
function Get-BotArguments {
    param([string]$Command, [string[]]$Extra)
    # The bot needs --account as well as --key-file; the key file is <account>.json.
    $account = @()
    $i = [Array]::IndexOf($Extra, '--key-file')
    if ($i -ge 0) { $account = @('--account', [IO.Path]::GetFileNameWithoutExtension($Extra[$i + 1])) }
    @('--filter', 'web', 'live-bot', $Command, '--network', $Network, '--rpc', $BotRpc, '--contract', $Contract, '--sale', $script:Sale) + $account + $Extra
}

<# The bidder's bid in this sale (read-only), or $null when it has none or the read fails. #>
function Get-BidOf {
    param([string]$Name)
    try {
        Invoke-NearView -RpcUrl $BotRpc -Account $Contract -Method 'get_bid' `
            -ArgsJson (ConvertTo-Json -Compress @{ sale_id = $script:Sale; bidder = (Get-BidderId $Name) })
    } catch { $null }
}

$sale = $null
if ($Phase -ne 'Accounts' -and $Phase -ne 'Create') {
    $state = Read-State
    if ($state.contract -ne $Contract) { throw "evidence-sale.json is for $($state.contract), not $Contract." }
    $script:Sale = $state.sale_id
} elseif ($Phase -eq 'Create') {
    if (-not $SaleId) { $SaleId = 'nosnipe-' + [DateTime]::UtcNow.ToString('MMddHHmm') }
    if ($SaleId -cnotmatch '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$') { throw "-SaleId '$SaleId' breaks the sale id rule." }
    Assert-AccountId "$SaleId.$Contract" 'The token account <SaleId>.<Contract>'
    $script:Sale = $SaleId
}

$plan = New-Plan
$preamble = Write-Preamble $net $Account "# Contract: $Contract   phase: $Phase"

switch ($Phase) {
    'Accounts' {
        foreach ($name in $bidders.Keys) {
            $id = Get-BidderId $name
            Add-Command $plan "Create $id (0.25 NEAR, key saved to the legacy keychain)" 'near' `
                @('account', 'create-account', 'fund-myself', $id, '0.25 NEAR', 'autogenerate-new-keypair',
                  'save-to-legacy-keychain', 'sign-as', $Account, 'network-config', $net.nearCliNetwork,
                  'sign-with-keychain', 'send') -Signs `
                -Expect "New account $id. Its key file: $(Get-KeyFile $name)"
        }
        foreach ($name in $bidders.Keys) {
            $id = Get-BidderId $name
            $register = New-JsonFile -Network $Network -OutName "register-$id.json" -Object ([ordered]@{ account_id = $id; registration_only = $true })
            $mint = New-JsonFile -Network $Network -OutName "mint-$id.json" -Object ([ordered]@{ account_id = $id; amount = '10000000' })
            Add-Command $plan "Register $id on $QuoteToken (paid by $Account)" 'near' `
                @('contract', 'call-function', 'as-transaction', $QuoteToken, 'storage_deposit', 'file-args', $register,
                  'prepaid-gas', '30 Tgas', 'attached-deposit', '0.00125 NEAR', 'sign-as', $Account,
                  'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs
            Add-Command $plan "Mint 10 test USDC to $id" 'near' `
                @('contract', 'call-function', 'as-transaction', $QuoteToken, 'mint', 'file-args', $mint,
                  'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', $Account,
                  'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs
        }
        Add-Check $plan 'Check every bidder: key file, NEAR and USDC' {
            foreach ($name in $bidders.Keys) {
                $id = Get-BidderId $name
                if (-not (Test-Path -LiteralPath (Get-KeyFile $name))) { throw "No key file for $id at $(Get-KeyFile $name)." }
                $balance = Invoke-NearView -RpcUrl $net.rpcUrl -Account $QuoteToken -Method 'ft_balance_of' -ArgsJson (ConvertTo-Json -Compress @{ account_id = $id })
                Write-Host ("{0}: key file ok, {1} USDC" -f $id, ([decimal]$balance / $usdc))
            }
        }
    }

    'Create' {
        $nowNs = Get-NowNs
        $bidStart = $nowNs + [long]$StartInMinutes * 60L * 1000000000L
        $bidEnd = $bidStart + [long]$DurationMinutes * 60L * 1000000000L
        $one = '000000000000000000'    # 18 decimals
        # The token's face: a crosshair struck through. The contract takes a data: URL of at most 2,048 bytes.
        $svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b0d12'/>" +
            "<circle cx='32' cy='32' r='17' fill='none' stroke='#3d7eff' stroke-width='4'/>" +
            "<path d='M32 9v10M32 45v10M9 32h10M45 32h10' stroke='#3d7eff' stroke-width='4' stroke-linecap='round'/>" +
            "<path d='M14 50L50 14' stroke='#ff5c5c' stroke-width='5' stroke-linecap='round'/></svg>"
        $icon = 'data:image/svg+xml,' + [Uri]::EscapeDataString($svg)
        if ($icon.Length -gt 2048) { throw "The token icon is $($icon.Length) bytes; the contract takes at most 2,048." }
        $params = [ordered]@{
            sale_id = $SaleId
            token_name = 'No Snipe'
            token_symbol = 'NOSNIPE'
            decimals = 18
            icon = $icon
            total_supply = "20000$one"
            sale_supply = "10000$one"
            floor_price = '1000'
            min_raise = '5000000'
            bid_start = "$bidStart"
            bid_end = "$bidEnd"
            min_deposit = '1000000'
            max_deposit_per_account = '10000000'
            max_bids = 8
            reveal_mode = 'Tee'
            settle_timeout = '3600000000000'
            quote_token = $QuoteToken
            description = 'Sealround evidence sale: a sniper bot, four people, a copycat and a late bid, one clearing price, and a Rhea pool opened at that price. Testnet; the token has no value.'
            liquidity = [ordered]@{ raise_share_bps = 2000; pool_tokens = "2000$one"; fee_bps = 30 }
        }
        $saleArgs = New-JsonFile -Network $Network -OutName 'create-evidence-sale.json' -Object ([ordered]@{ params = $params })
        $saleIdArgs = New-JsonFile -Network $Network -OutName "sale-id-$SaleId.json" -Object ([ordered]@{ sale_id = $SaleId })
        Add-Check $plan "Check that $Deposit NEAR covers create_sale" {
            $cost = [decimal](Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_create_cost' -ArgsJson ([IO.File]::ReadAllText($saleArgs)))
            $attached = [decimal]::Parse($Deposit, [Globalization.CultureInfo]::InvariantCulture) * [decimal]1e24
            if ($attached -lt $cost) { throw "create_sale costs $cost yoctoNEAR; -Deposit $Deposit NEAR is too little." }
            Write-Host ("create_sale costs {0:N5} NEAR; attaching {1} NEAR (the excess is refunded)." -f ($cost / [decimal]1e24), $Deposit)
            $config = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_config' -ArgsJson '{}'
            if (-not $config.PSObject.Properties['dex'] -or -not $config.dex) { throw "$Contract has no dex in get_config: launch liquidity is off." }
            Write-Host "Launch liquidity on $($config.dex)."
        }
        Add-Command $plan "Create sale '$SaleId' (No Snipe, NOSNIPE; 20 % of the raise opens a Rhea pool)" 'near' `
            @('contract', 'call-function', 'as-transaction', $Contract, 'create_sale', 'file-args', $saleArgs,
              'prepaid-gas', '300 Tgas', 'attached-deposit', "$Deposit NEAR", 'sign-as', $Account,
              'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
            -Expect 'Logs sale_created, then the token deploy and the key request. Keep the transaction hash.'
        Add-Check $plan 'Wait for the sale key and save the sale for the next phases' {
            $view = $null
            for ($i = 1; $i -le 18; $i++) {
                $view = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_sale' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
                if ($view -and $view.sealer_key_setup -ne 'pending' -and $view.token_setup -ne 'pending') { break }
                Write-Host "Still in setup ($i/18); waiting 10 s..."
                Start-Sleep -Seconds 10
            }
            if (-not $view -or $view.sealer_key_setup -ne 'done' -or $view.token_setup -ne 'done') {
                throw "Setup did not finish: token $($view.token_setup), key $($view.sealer_key_setup). See enclave\README.md, Troubleshooting."
            }
            $saved = [ordered]@{ contract = $Contract; sale_id = $SaleId; token = $view.token; bid_start = $view.bid_start; bid_end = $view.bid_end; created_by = $Account }
            [IO.File]::WriteAllText($stateFile, (ConvertTo-Json $saved -Compress), $script:Utf8NoBom)
            Write-Host "Sale $SaleId is ready. Sealer key $($view.sealer_pubkey)."
            Write-Host "Bidding: $(Format-Ns ([long]$view.bid_start)) to $(Format-Ns ([long]$view.bid_end))."
            Write-Host 'Next, before the open: -Phase Bid -Execute'
        }
    }

    'Bid' {
        $start = [long]$state.bid_start
        $end = [long]$state.bid_end
        foreach ($name in $bidders.Keys) {
            if (-not (Test-Path -LiteralPath (Get-KeyFile $name))) { throw "No key file for $(Get-BidderId $name): run -Phase Accounts." }
        }
        # The phase can be run again after a failed step: bidders that already
        # have a bid (read-only) are left out of the plan.
        $placed = @{}
        foreach ($name in $bidders.Keys) { $placed[$name] = [bool](Get-BidOf $name) }
        if (-not $placed['late'] -and (Get-NowNs) -ge $end - 150L * 1000000000L) { throw "Too late: bidding ends $(Format-Ns $end) and the late bid needs two minutes." }
        $logDir = Get-OutDir $Network
        $sniperLog = Join-Path $logDir "evidence-sniper-$($script:Sale).log"
        $s = $bidders['sniper']
        $sniperArgs = Get-BotArguments 'snipe' @('--key-file', (Get-KeyFile 'sniper'), '--deposit', $s.deposit, '--max-price', $s.price, '--max-spend', $s.spend)
        if ($placed['sniper']) {
            Add-Note $plan 'sniper has a bid already. Skipping.'
        } else { Add-Check $plan "Start the sniper: it waits for $(Format-Ns $start) and bids in the first block" {
            # pnpm.cmd, not the .ps1 shim: Start-Process runs executables. No
            # argument has a space (key files live under the user's home).
            $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
            foreach ($arg in $sniperArgs) { if ($arg -match '\s') { throw "Argument '$arg' has a space; move the key file." } }
            $script:SniperProcess = Start-Process -FilePath $pnpm -ArgumentList $sniperArgs -WorkingDirectory $script:RepoRoot `
                -RedirectStandardOutput $sniperLog -RedirectStandardError "$sniperLog.err" -WindowStyle Hidden -PassThru
            Write-Host "Sniper started (process $($script:SniperProcess.Id)); log: $sniperLog"
        } }
        Add-Check $plan 'Wait for the open, plus 30 seconds' { Wait-Until ($start + 30L * 1000000000L) 'Until the people bid' }
        foreach ($name in @('ana', 'ravi', 'mei')) {
            $b = $bidders[$name]
            if ($placed[$name]) { Add-Note $plan "$name has a bid already. Skipping."; continue }
            Add-Command $plan "$name bids: deposit $($b.deposit), max price $($b.price), max spend $($b.spend)" 'pnpm' `
                (Get-BotArguments 'bid' @('--key-file', (Get-KeyFile $name), '--budget', $b.deposit, '--deposit', $b.deposit,
                    '--max-price', $b.price, '--max-spend', $b.spend, '--direct')) -Signs `
                -Expect 'bid_placed with its index; the deposit is public, the price and spend are sealed.'
        }
        if ($placed['copy']) {
            Add-Note $plan 'copy has a bid already. Skipping.'
        } else {
            Add-Command $plan 'copy replays ravi''s sealed bid from its own account' 'pnpm' `
                (Get-BotArguments 'copycat' @('--key-file', (Get-KeyFile 'copy'), '--victim', (Get-BidderId 'ravi'),
                    '--deposit', $bidders['copy'].deposit)) -Signs `
                -Expect 'Accepted (same id length): the enclave finds that the sealed bid names ravi, voids it, and copy pays the 1 % penalty.'
        }
        $l = $bidders['late']
        if ($placed['late']) {
            Add-Note $plan 'late has a bid already. Skipping.'
        } else {
            Add-Check $plan 'Wait for the last two minutes of the window' { Wait-Until ($end - 120L * 1000000000L) 'Until the late bid' }
            Add-Command $plan "late bids: deposit $($l.deposit), max price $($l.price), max spend $($l.spend)" 'pnpm' `
                (Get-BotArguments 'bid' @('--key-file', (Get-KeyFile 'late'), '--budget', $l.deposit, '--deposit', $l.deposit,
                    '--max-price', $l.price, '--max-spend', $l.spend, '--direct')) -Signs
        }
        Add-Check $plan 'The sniper''s result' {
            if ($script:SniperProcess -and -not $script:SniperProcess.HasExited) { $script:SniperProcess.WaitForExit(60000) | Out-Null }
            foreach ($file in @($sniperLog, "$sniperLog.err")) {
                if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file | Write-Host }
            }
            Write-Host "Next, after $(Format-Ns $end): -Phase Close -Execute"
        }
    }

    'Close' {
        $saleIdArgs = New-JsonFile -Network $Network -OutName "sale-id-$($script:Sale).json" -Object ([ordered]@{ sale_id = $script:Sale })
        $end = [long]$state.bid_end

        # The phase can be run again after a failed step: read what is already done
        # (read-only) and leave those steps out of the plan.
        $now = $null
        try {
            $now = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_result' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
        } catch {
            Write-Host "Could not read the sale's result ($($_.Exception.Message)); planning every step."
        }
        $closed = $now -and @('settled', 'failed') -contains [string]$now.status
        $seeded = $now -and $now.liquidity -and [string]$now.liquidity.status -eq 'seeded'
        # A sold-out sale has nothing to burn, so its unsold_burned flag stays false.
        $proceedsDone = $now -and $now.proceeds -and $now.proceeds.raise_paid -and $now.proceeds.allocation_paid -and
            ($now.proceeds.unsold_burned -or [string]$now.unsold -eq '0') -and $now.proceeds.reserve_returned

        if ($closed) {
            Add-Note $plan "Already closed: the sale is $($now.status). Skipping close_sale."
        } else {
            Add-Check $plan 'Wait for the end of bidding' { Wait-Until ($end + 5L * 1000000000L) 'Until bidding ends' }
            Add-Command $plan 'Close the sale: the frozen bid set goes to the enclave' 'near' `
                @('contract', 'call-function', 'as-transaction', $Contract, 'close_sale', 'file-args', $saleIdArgs,
                  'prepaid-gas', '300 Tgas', 'attached-deposit', '0.02 NEAR', 'sign-as', $Account,
                  'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
                -Expect 'Return value "settled": sale_closed, clearing_requested, OutLayer execution_completed, sale_settled with clearing_price "2000".'
        }
        Add-Check $plan 'Read the result' {
            $result = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_result' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
            $failed = @($result.failed_checks)
            Write-Host ("status {0}, clearing price {1} USDC, raised {2} USDC, {3} valid, {4} invalid, failed checks: {5}" -f `
                $result.status, ([decimal]$result.clearing_price / $usdc), ([decimal]$result.total_raised / $usdc),
                $result.n_valid, $result.n_invalid, $(if ($failed.Count) { $failed -join ', ' } else { 'none' }))
            if ($result.status -ne 'settled') {
                throw "The sale is $($result.status), not settled. If it is still clearing, wait and run this phase again. If it failed, every bidder gets a refund: run this phase again to claim them."
            }
        }
        if ($seeded) {
            Add-Note $plan "Already seeded: pool $($now.liquidity.pool_id). Skipping seed_liquidity."
        } else {
            Add-Command $plan 'Seed the Rhea pool at the clearing price (anyone may call it)' 'near' `
                @('contract', 'call-function', 'as-transaction', $Contract, 'seed_liquidity', 'file-args', $saleIdArgs,
                  'prepaid-gas', '300 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', $Account,
                  'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
                -Expect 'liquidity_seeded with the pool id, 4 USDC and 2,000 NOSNIPE. If a step failed, run this phase again: done steps are skipped.'
            Add-Check $plan 'Check the pool' {
                $result = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_result' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
                $liq = $result.liquidity
                Write-Host "Liquidity: $($liq.status), pool $($liq.pool_id) on $($liq.dex), LP shares $($liq.shares)"
                if ($liq.status -ne 'seeded') { throw "The pool is $($liq.status) (next step $($liq.next_step)). Run this phase again to call seed_liquidity again." }
            }
        }
        foreach ($name in $bidders.Keys) {
            $bid = Get-BidOf $name
            if (-not $bid) {
                Add-Note $plan "$name has no bid in this sale. Nothing to claim."
                continue
            }
            if ($bid.claimed) {
                Add-Note $plan "$name has claimed already. Skipping."
                continue
            }
            Add-Command $plan "$name claims (tokens and refund) and checks its price" 'pnpm' `
                (Get-BotArguments 'report' @('--key-file', (Get-KeyFile $name), '--claim', '--direct')) -Signs
        }
        if ($proceedsDone) {
            Add-Note $plan 'The creator has claimed the proceeds already. Skipping claim_proceeds.'
        } else {
            Add-Command $plan 'The creator claims the raise, the allocation and the NEAR reserve; unsold tokens burn' 'near' `
                @('contract', 'call-function', 'as-transaction', $Contract, 'claim_proceeds', 'file-args', $saleIdArgs,
                  'prepaid-gas', '300 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', $Account,
                  'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs
        }
        Add-Note $plan 'Next: -Phase Report (read-only) prints the evidence for README section 7'
    }

    'Report' {
        $saleIdArgs = New-JsonFile -Network $Network -OutName "sale-id-$($script:Sale).json" -Object ([ordered]@{ sale_id = $script:Sale })
        Add-Check $plan 'Evidence for README section 7' {
            $view = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_sale' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
            $result = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_result' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
            $fills = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_fills' -ArgsJson (ConvertTo-Json -Compress @{ sale_id = $script:Sale; from_index = 0; limit = 50 })
            $explorer = 'https://testnet.nearblocks.io/address/'
            $keysBody = [ordered]@{
                jsonrpc = '2.0'; id = 'fairground'; method = 'query'
                params = [ordered]@{ request_type = 'view_access_key_list'; finality = 'final'; account_id = $Contract }
            } | ConvertTo-Json -Depth 4 -Compress
            $keyCount = @((Invoke-RestMethod -Method Post -Uri $net.rpcUrl -ContentType 'application/json' -Body $keysBody).result.keys).Count
            $keyNote = if ($keyCount -eq 0) { 'no access keys: locked' } else { "$keyCount access key(s): not locked yet (LAUNCH.md T8)" }
            $failedChecks = @($result.failed_checks)
            $failedText = if ($failedChecks.Count) { $failedChecks -join ', ' } else { 'none' }
            $lines = @(
                "### Testnet evidence sale: $($script:Sale)",
                '',
                "- Contract: [$Contract]($explorer$Contract) ($keyNote; check with ``near account list-keys $Contract network-config testnet now``)",
                "- Token: [$($view.token)]($explorer$($view.token)) (NOSNIPE, fixed supply)",
                "- Bidding: $(Format-Ns ([long]$view.bid_start)) to $(Format-Ns ([long]$view.bid_end))",
                "- Clearing price: $([decimal]$result.clearing_price / $usdc) USDC per token (floor $([decimal]$view.floor_price / $usdc)); raised $([decimal]$result.total_raised / $usdc) USDC; $($result.n_valid) valid bids, $($result.n_invalid) voided; failed checks: $failedText",
                ''
            )
            if ($AppUrl) { $lines += "- Result page with the Verified panel: $AppUrl/sale/$($script:Sale)/result"; $lines += '' }
            $lines += '| Bidder | Bid placed | Tokens | Spent (USDC) | Refund | Penalty |'
            $lines += '| --- | --- | --- | --- | --- | --- |'
            foreach ($f in @($fills)) {
                $bid = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_bid' -ArgsJson (ConvertTo-Json -Compress @{ sale_id = $script:Sale; bidder = $f.bidder })
                $placed = if ($bid) { [long](([long]$bid.placed_at - [long]$view.bid_start) / 1000000L) } else { $null }
                $lines += ('| {0} | +{1:N1} s | {2:N0} | {3} | {4} | {5} |' -f $f.bidder, ($placed / 1000.0), ([decimal]$f.tokens / [decimal]1e18),
                    ([decimal]$f.spent / $usdc), ([decimal]$f.refund / $usdc), ([decimal]$f.penalty / $usdc))
            }
            $liq = $result.liquidity
            if ($liq) {
                $lines += ''
                $lines += "- Launch pool: $($liq.status), pool $($liq.pool_id) on $($liq.dex): $([decimal]$liq.usdc / $usdc) USDC and $([decimal]$liq.tokens / [decimal]1e18) NOSNIPE; LP shares $($liq.shares) held by $Contract"
                if ($null -ne $liq.pool_id) {
                    $pool = Invoke-NearView -RpcUrl $net.rpcUrl -Account $liq.dex -Method 'get_pool' -ArgsJson (ConvertTo-Json -Compress @{ pool_id = [long]$liq.pool_id })
                    $ids = @($pool.token_account_ids)
                    $amounts = @($pool.amounts)
                    $tokenAt = [array]::IndexOf($ids, $view.token)
                    $quoteAt = [array]::IndexOf($ids, $QuoteToken)
                    if ($tokenAt -ge 0 -and $quoteAt -ge 0 -and [decimal]$amounts[$tokenAt] -gt 0) {
                        $price = ([decimal]$amounts[$quoteAt] / $usdc) / ([decimal]$amounts[$tokenAt] / [decimal]1e18)
                        $lines += "- Pool reserves now: $([decimal]$amounts[$quoteAt] / $usdc) USDC and $([decimal]$amounts[$tokenAt] / [decimal]1e18) NOSNIPE, price $price USDC per token"
                    }
                }
            }
            $lines += ''
            $lines += 'Check it yourself (read-only, no key, any OS with Node 24):'
            $lines += ''
            $lines += '```'
            $lines += "pnpm --filter web verify-sale --network $Network --contract $Contract --sale $($script:Sale)"
            $lines += '```'
            $lines += ''
            $lines += 'It finds the create_sale and close_sale transactions, fetches OutLayer''s TDX attestation for each, checks the build, input, output, quote report data, enclave measurements, caller and key, and recomputes the frozen bid set.'
            $text = $lines -join "`n"
            $out = Join-Path (Get-OutDir $Network) "evidence-$($script:Sale).md"
            [IO.File]::WriteAllText($out, $text, $script:Utf8NoBom)
            Write-Host $text
            Write-Host ''
            Write-Host "Saved to $out"
        }
    }
}

if ($Execute -or $Phase -eq 'Report') {
    if ($Phase -eq 'Report') {
        foreach ($step in $plan) { & $step.Check }
    } else {
        Invoke-Plan $plan $Network
    }
} else {
    Show-Plan $plan $preamble
}
