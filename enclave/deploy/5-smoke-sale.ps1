<#
.SYNOPSIS
Step 5: create a tiny TEE sale through the deployed contract and check that
the enclave job gave it a public key.

.DESCRIPTION
create_sale writes the sale, deploys its token to <SaleId>.<Contract> and asks
the job for the sale's X25519 public key (contracts/fairground/src/setup.rs).
When both finish, get_sale shows token_setup "done", sealer_key_setup "done"
and sealer_pubkey (64 hex). That proves the contract -> OutLayer -> keystore
-> job path with the production master and its Predecessor condition.

The sale is a throwaway: 600 of 1000 SMOKE tokens, floor 0.002 USDC, deposits
of 1 to 2 USDC (1 USDC is the least the contract lets a sale ask for), at most
2 bids, bidding opens -StartInMinutes from now and lasts -DurationMinutes.
create_sale needs bid_start >= the block time, so create it within those
minutes of running this script (or run the script again for fresh times).

The deposit: create_sale charges get_create_cost(params) (sale storage, the
token account's code and state, 2 bid slots, registrations, and the OutLayer
compute deposit for the key) and refunds the excess in the same transaction.
Most of it (the token account's code, about 1.7 NEAR) stays in the token
account; unused bid slots come back through claim_proceeds.

.PARAMETER Account
The creator: signs create_sale and pays for it.

.PARAMETER Contract
Default sealround.<Account>.

.PARAMETER QuoteToken
Default: the first allowed quote token in templates\new-args.<network>.json.

.PARAMETER Deposit
NEAR to attach. Must be at least get_create_cost; the rest is refunded.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\5-smoke-sale.ps1 -Account alice.testnet
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [string]$Contract,
    [string]$SaleId,
    [string]$QuoteToken,
    [ValidateRange(2, 1440)][int]$StartInMinutes = 5,
    [ValidateRange(1, 1440)][int]$DurationMinutes = 30,
    [string]$Deposit = '2',
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $Contract) { $Contract = "sealround.$Account" }
Assert-AccountId $Contract '-Contract'
if (-not $SaleId) { $SaleId = 'smoke-' + [DateTime]::UtcNow.ToString('MMddHHmm') }
if ($SaleId -cnotmatch '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$') { throw "-SaleId '$SaleId' breaks the sale id rule." }
Assert-AccountId "$SaleId.$Contract" 'The token account <SaleId>.<Contract>'
if (-not $QuoteToken) {
    $template = [IO.File]::ReadAllText((Join-Path $script:DeployDir "templates\new-args.$Network.json")) | ConvertFrom-Json
    $QuoteToken = @($template.allowed_quote_tokens)[0]
}
Assert-AccountId $QuoteToken '-QuoteToken'
if ($Deposit -notmatch '^\d+(\.\d+)?$') { throw "-Deposit is a NEAR amount such as 2 or 2.5." }

# Block time is nanoseconds since the Unix epoch.
$nowNs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000L
$bidStart = $nowNs + [long]$StartInMinutes * 60L * 1000000000L
$bidEnd = $bidStart + [long]$DurationMinutes * 60L * 1000000000L

$saleArgs = New-ArgsFile -Template 'create-sale-smoke.json' -Network $Network -OutName 'create-sale.json' -Values @{
    SALE_ID = $SaleId; BID_START_NS = $bidStart; BID_END_NS = $bidEnd; QUOTE_TOKEN = $QuoteToken
}
$saleIdArgs = New-JsonFile -Network $Network -OutName 'sale-id.json' -Object ([ordered]@{ sale_id = $SaleId })
$emptyArgs = New-JsonFile -Network $Network -OutName 'empty.json' -Object ([ordered]@{})
$bidEndUtc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]($bidEnd / 1000000L)).UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss')

$plan = New-Plan
Add-Command $plan 'What create_sale will charge (yoctoNEAR)' 'near' `
    @('contract', 'call-function', 'as-read-only', $Contract, 'get_create_cost', 'file-args', $saleArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect ("`"1730850000000000000000000`" (1.73085 NEAR) for this sale with usdc.fakes.testnet, computed by the contract code of 10 Nov 2026`n" +
             "(it changes with the token wasm size, the per-bid reserve and the quote token id: 1.73134 NEAR with mainnet USDC).`n" +
             "Attach at least this; the excess is refunded.")
Add-Check $plan "Check that $Deposit NEAR covers it" {
    $cost = [decimal](Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_create_cost' -ArgsJson ([IO.File]::ReadAllText($saleArgs)))
    $attached = [decimal]::Parse($Deposit, [Globalization.CultureInfo]::InvariantCulture) * [decimal]1e24
    if ($attached -lt $cost) { throw "create_sale costs $cost yoctoNEAR; -Deposit $Deposit NEAR is too little." }
    Write-Host "create_sale costs $cost yoctoNEAR; attaching $Deposit NEAR (the excess is refunded)."
}
Add-Command $plan "Create sale '$SaleId' (TEE mode, quote token $QuoteToken)" 'near' `
    @('contract', 'call-function', 'as-transaction', $Contract, 'create_sale', 'file-args', $saleArgs,
      'prepaid-gas', '300 Tgas', 'attached-deposit', "$Deposit NEAR", 'sign-as', $Account,
      'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
    -Expect ("Logs EVENT_JSON sale_created; the token deploy and the key request run in later receipts.`n" +
             "Keep the transaction hash: the job's attestation is filed under it.")
Add-Note $plan 'Wait about 30 seconds for the key request to come back' ''
Add-Check $plan 'Wait for the sale to leave setup' {
    for ($i = 1; $i -le 12; $i++) {
        $sale = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_sale' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
        if ($sale -and $sale.sealer_key_setup -ne 'pending' -and $sale.token_setup -ne 'pending') { break }
        Write-Host "Still in setup ($i/12); waiting 10 s..."
        Start-Sleep -Seconds 10
    }
}
Add-Command $plan 'Read the sale' 'near' `
    @('contract', 'call-function', 'as-read-only', $Contract, 'get_sale', 'file-args', $saleIdArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect ("status `"upcoming`" (or `"open`"), token_setup `"done`", sealer_key_setup `"done`",`n" +
             "sealer_pubkey: 64 hex characters, sealer_code_hash: the job sha256 in get_config.`n" +
             "sealer_key_setup `"failed`": see README, Troubleshooting; retry_setup retries it (attach 0.01401 NEAR).")
Add-Command $plan 'Compare with the pinned config' 'near' `
    @('contract', 'call-function', 'as-read-only', $Contract, 'get_config', 'file-args', $emptyArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect 'sealer_code_hash here equals the sale''s sealer_code_hash.'
Add-Note $plan 'Check the attestation of the key request' `
    ("powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $Network -TxHash <create_sale tx hash> -Signer $Account " +
     "-ExpectedWasmSha256 <job sha256> -Contract $Contract -SaleId $SaleId")
Add-Note $plan "Next: test the clear (README 6b): bid while the sale is open, close after $bidEndUtc UTC" `
    ("powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $Network -Account $Account -Contract $Contract -SaleId $SaleId -Phase Bid`n" +
     "powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $Network -Account $Account -Contract $Contract -SaleId $SaleId -Phase Close`n" +
     "This sale with no bids only proves the key path: close_sale then fails it with no_bids and sends nothing to OutLayer:`n" +
     "near contract call-function as-transaction $Contract close_sale file-args '$saleIdArgs' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as $Account network-config $($net.nearCliNetwork) sign-with-keychain send`n" +
     "near contract call-function as-transaction $Contract claim_proceeds file-args '$saleIdArgs' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as $Account network-config $($net.nearCliNetwork) sign-with-keychain send")

$preamble = Write-Preamble $net $Account "# Contract: $Contract   sale: $SaleId   bidding: +$StartInMinutes min for $DurationMinutes min"
if ($Execute) {
    Invoke-Plan $plan $Network
} else {
    Show-Plan $plan $preamble
}
