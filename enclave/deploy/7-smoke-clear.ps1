<#
.SYNOPSIS
Step 5b: bid on the smoke sale with a sealed bid, close it, and check that the
enclave job cleared it: the whole clear path through OutLayer.

.DESCRIPTION
5-smoke-sale.ps1 proves the key path only: a sale without bids fails with
no_bids at close_sale and nothing is sent to OutLayer. This script sends a
clear through OutLayer, in two phases:

-Phase Bid (while the sale is open; once per bidder, -Bidder defaults to
-Account):
  1. reads the sale (get_sale) for its sealer_pubkey and deposit limits,
  2. seals the bid {sale_id, bidder, max_price, max_spend, salt} to that key
     with enclave\target\tools\fairground-seal.exe, as the app does: the
     canonical plaintext with both amounts zero-padded to 39 digits, so the
     box is 224 + len(sale_id) + len(bidder) bytes whatever the amounts. Its
     length, public while bidding is open, then says nothing about them, and
     the contract refuses a TEE bid of any other length
     (wrong_ciphertext_length),
  3. with -GetTestUsdc (usdc.fakes.testnet only): registers the bidder on it
     and mints test USDC (its mint(account_id, amount) is open to anyone),
  4. sends ft_transfer_call to the quote token with
     msg {"sale_id": ..., "ciphertext": ...}, 1 yoctoNEAR, 100 TGas.

-Phase Close (after bid_end):
  1. reads get_close_deposit (0.01401 NEAR for a small sale),
  2. sends close_sale with -CloseDeposit NEAR (the unused part comes back from
     OutLayer) and 300 TGas. The contract freezes the bids and asks OutLayer
     for a clear with max_instructions 5e10 and 60 s; the job decrypts and
     clears; the callback checks the result and settles the sale,
  3. reads get_result and get_fills, and prints the attestation check and the
     claims.

The closer (-Account) must not be the contract account: the job refuses a
clear the contract account signed itself (signer_is_contract).

Seal tool: build it once from enclave/ with
  cargo build --profile tools -p fairground-runner -p fairground-harness
(scripts\run-enclave.ps1 -Fixtures does the same).

With the defaults (one bid: deposit 1 USDC, the least a sale may ask for, max
spend 1 USDC, max price 0.004 USDC per token, against 600 tokens at a
0.002 USDC floor) the sale is undersubscribed: it settles at the floor, the
bid gets 500 tokens for exactly 1 USDC, and 100 tokens are burned at
claim_proceeds. The job's answer for that clear, which Verify-Attestation.ps1
prints, is
  {"v":1,"ok":true,"op":"clear","sale_id":"<sale>","bid_set_hash":"<64 hex>",
   "pubkey":"<the sale's sealer_pubkey>","clearing_price":"2000","n_valid":1,
   "n_invalid":0,"invalid":[],"fills":[["500000000000000000000","1000000"]]}

.PARAMETER Account
Signs close_sale (the closer, who pays OutLayer) and, by default, the bid.

.PARAMETER SaleId
The sale 5-smoke-sale.ps1 created (its name is in that script's output).

.PARAMETER Bidder
The account that bids (signs ft_transfer_call). Default -Account. Its key
must be in near CLI's keychain.

.PARAMETER SealerPubkey
The sale's sealer_pubkey (64 hex, from get_sale). Lets the print mode seal
the bid and write the transfer arguments now; -Execute reads it itself.

.PARAMETER CloseDeposit
NEAR attached to close_sale. At least get_close_deposit; the rest is refunded.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Account alice.testnet -SaleId smoke-11091200 -Phase Bid -GetTestUsdc

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Account alice.testnet -SaleId smoke-11091200 -Phase Close
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [Parameter(Mandatory)][string]$SaleId,
    [Parameter(Mandatory)][ValidateSet('Bid', 'Close')][string]$Phase,
    [string]$Contract,
    [string]$Bidder,
    [string]$QuoteToken,
    [string]$SealerPubkey,
    [string]$Deposit = '1000000',
    [string]$MaxPrice = '4000',
    [string]$MaxSpend = '1000000',
    [switch]$GetTestUsdc,
    [string]$CloseDeposit = '0.02',
    [string]$Wasm,
    [string]$Sha256,
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $Contract) { $Contract = "sealround.$Account" }
Assert-AccountId $Contract '-Contract'
if (-not $Bidder) { $Bidder = $Account }
Assert-AccountId $Bidder '-Bidder'
if ($SaleId -cnotmatch '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$') { throw "-SaleId '$SaleId' breaks the sale id rule." }
if (-not $QuoteToken) {
    $template = [IO.File]::ReadAllText((Join-Path $script:DeployDir "templates\new-args.$Network.json")) | ConvertFrom-Json
    $QuoteToken = @($template.allowed_quote_tokens)[0]
}
Assert-AccountId $QuoteToken '-QuoteToken'
foreach ($amount in @(@('-Deposit', $Deposit), @('-MaxPrice', $MaxPrice), @('-MaxSpend', $MaxSpend))) {
    if ($amount[1] -notmatch '^[1-9]\d{0,37}$') { throw "$($amount[0]) is a whole number of USDC base units (6 decimals), got '$($amount[1])'." }
}
if ($CloseDeposit -notmatch '^\d+(\.\d+)?$') { throw '-CloseDeposit is a NEAR amount such as 0.02.' }
if ($SealerPubkey -and $SealerPubkey -cnotmatch '^[0-9a-f]{64}$') { throw '-SealerPubkey must be 64 lowercase hex digits (get_sale ... sealer_pubkey).' }

$saleIdArgs = New-JsonFile -Network $Network -OutName "sale-id-$SaleId.json" -Object ([ordered]@{ sale_id = $SaleId })
$plan = New-Plan

if ($Phase -eq 'Bid') {
    $sealTool = Join-Path $script:EnclaveDir 'target\tools\fairground-seal.exe'
    $bidArgs = Join-Path (Get-OutDir $Network) "bid-$SaleId-$Bidder.json"
    $bidderArgs = New-JsonFile -Network $Network -OutName "account-$Bidder.json" -Object ([ordered]@{ account_id = $Bidder })
    $registerArgs = New-JsonFile -Network $Network -OutName "register-$Bidder.json" -Object ([ordered]@{ account_id = $Bidder; registration_only = $true })
    $mintAmount = ([decimal]::Parse($Deposit) * 2).ToString('0', [Globalization.CultureInfo]::InvariantCulture)
    $mintArgs = New-JsonFile -Network $Network -OutName "mint-$Bidder.json" -Object ([ordered]@{ account_id = $Bidder; amount = $mintAmount })

    # Seals the bid to $Pubkey and writes the ft_transfer_call arguments.
    $writeBid = {
        param([string]$Pubkey)
        if (-not (Test-Path -LiteralPath $sealTool)) {
            throw "No $sealTool. Build it from enclave\: cargo build --profile tools -p fairground-runner -p fairground-harness"
        }
        $sealArgs = @('--pubkey', $Pubkey, '--sale-id', $SaleId, '--bidder', $Bidder, '--max-price', $MaxPrice, '--max-spend', $MaxSpend)
        $ciphertext = (& $sealTool @sealArgs | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $ciphertext -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw "fairground-seal failed: $ciphertext" }
        # The only length the contract accepts (fairground_clearing::sealed_bid_len).
        $boxBytes = [Convert]::FromBase64String($ciphertext).Length
        $wantBytes = 224 + $SaleId.Length + $Bidder.Length
        if ($boxBytes -ne $wantBytes) {
            throw "fairground-seal wrote a $boxBytes-byte box, but the contract accepts only $wantBytes bytes for this sale id and bidder. Rebuild the tool (see the top of this script)."
        }
        # The msg is a JSON string inside the JSON arguments; both are escaped by the serializer.
        $msg = ([ordered]@{ sale_id = $SaleId; ciphertext = $ciphertext } | ConvertTo-Json -Compress)
        $text = [ordered]@{ receiver_id = $Contract; amount = $Deposit; msg = $msg } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($bidArgs, $text, $script:Utf8NoBom)
        Write-Host "Sealed a bid of $Bidder ($boxBytes bytes of ciphertext: 224 + sale id + bidder) into $bidArgs"
    }

    if ($SealerPubkey) {
        & $writeBid $SealerPubkey
    }
    Add-Command $plan "Read sale '$SaleId'" 'near' `
        @('contract', 'call-function', 'as-read-only', $Contract, 'get_sale', 'file-args', $saleIdArgs,
          'network-config', $net.nearCliNetwork, 'now') `
        -Expect ("status `"open`", reveal_mode `"Tee`", sealer_pubkey: 64 hex, quote_token $QuoteToken,`n" +
                 "min_deposit <= $Deposit <= max_deposit_per_account (USDC base units).")
    Add-Check $plan "Check the sale and seal the bid to its key" {
        $sale = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_sale' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
        if (-not $sale) { throw "No sale '$SaleId' on $Contract." }
        if ($sale.status -ne 'open') { throw "Sale '$SaleId' is $($sale.status), not open: bids are accepted between bid_start and bid_end." }
        if ($sale.reveal_mode -ne 'Tee' -or -not $sale.sealer_pubkey) { throw "Sale '$SaleId' has no sealer key (reveal_mode $($sale.reveal_mode))." }
        if ($sale.quote_token -ne $QuoteToken) { throw "Sale '$SaleId' takes $($sale.quote_token), not $QuoteToken (pass -QuoteToken)." }
        if ([decimal]$Deposit -lt [decimal]$sale.min_deposit -or [decimal]$Deposit -gt [decimal]$sale.max_deposit_per_account) {
            throw "-Deposit $Deposit is outside [$($sale.min_deposit), $($sale.max_deposit_per_account)]."
        }
        if ($SealerPubkey -and $SealerPubkey -ne $sale.sealer_pubkey) { throw "-SealerPubkey is not this sale's key ($($sale.sealer_pubkey))." }
        & $writeBid $sale.sealer_pubkey
    }
    if ($GetTestUsdc) {
        if ($QuoteToken -ne 'usdc.fakes.testnet') { throw '-GetTestUsdc only knows usdc.fakes.testnet; fund the bidder with the other token yourself.' }
        Add-Command $plan "Register $Bidder on $QuoteToken (storage deposit, 0.00125 NEAR)" 'near' `
            @('contract', 'call-function', 'as-transaction', $QuoteToken, 'storage_deposit', 'file-args', $registerArgs,
              'prepaid-gas', '30 Tgas', 'attached-deposit', '0.00125 NEAR', 'sign-as', $Bidder,
              'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
            -Expect 'A storage balance. If the account was registered already, the deposit is refunded.'
        Add-Command $plan "Mint $mintAmount test USDC base units to $Bidder" 'near' `
            @('contract', 'call-function', 'as-transaction', $QuoteToken, 'mint', 'file-args', $mintArgs,
              'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', $Bidder,
              'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
            -Expect 'Succeeds with no return value (mint takes no deposit).'
    } else {
        Add-Note $plan "The bidder needs at least $Deposit base units of $QuoteToken" `
            ('On testnet with usdc.fakes.testnet, add -GetTestUsdc: it registers the bidder and calls the token''s open mint.')
    }
    Add-Command $plan "Balance of $Bidder" 'near' `
        @('contract', 'call-function', 'as-read-only', $QuoteToken, 'ft_balance_of', 'file-args', $bidderArgs,
          'network-config', $net.nearCliNetwork, 'now') `
        -Expect "At least `"$Deposit`"."
    Add-Command $plan "Bid: send $Deposit to $Contract with the sealed bid" 'near' `
        @('contract', 'call-function', 'as-transaction', $QuoteToken, 'ft_transfer_call', 'file-args', $bidArgs,
          'prepaid-gas', '100 Tgas', 'attached-deposit', '1 yoctoNEAR', 'sign-as', $Bidder,
          'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
        -Expect ("Return value `"$Deposit`" (the amount the sale kept) and EVENT_JSON bid_placed {sale_id, bidder, index, deposit, bid_set_hash}.`n" +
                 "`"0`" means the sale refused the bid and refunded it: the bid_rejected event names the reason (contracts/DESIGN.md, ft_on_transfer),`n" +
                 "for example below_min_deposit, or wrong_ciphertext_length for a box that is not 224 + sale id + bidder bytes long.")
    Add-Command $plan 'Read the bid book summary' 'near' `
        @('contract', 'call-function', 'as-read-only', $Contract, 'get_bids_summary', 'file-args', $saleIdArgs,
          'network-config', $net.nearCliNetwork, 'now') `
        -Expect 'count 1 (one per bidder so far), total_deposits, bid_set_hash.'
    Add-Note $plan 'After bid_end: close the sale' `
        ("powershell -ExecutionPolicy Bypass -File enclave\deploy\7-smoke-clear.ps1 -Network $Network -Account $Account -Contract $Contract -SaleId $SaleId -Phase Close")
    $extra = "# Contract: $Contract   sale: $SaleId   bidder: $Bidder   deposit $Deposit, max price $MaxPrice, max spend $MaxSpend (USDC base units)"
    if (-not $SealerPubkey) { $extra += "`n# The bid arguments ($bidArgs) are written by -Execute, or now with -SealerPubkey <get_sale ... sealer_pubkey>." }
    $preamble = Write-Preamble $net $Bidder $extra
} else {
    if ($Account -eq $Contract) { throw 'The closer must not be the contract account: the job refuses a clear it signed itself (signer_is_contract).' }
    $sha = $null
    $jobWasm = if ($Wasm) { $Wasm } else { Get-DefaultJobWasm }
    if ($Sha256 -or (Test-Path -LiteralPath $jobWasm)) { $sha = Get-JobSha256 -Wasm $jobWasm -Sha256 $Sha256 }
    $fillsArgs = New-JsonFile -Network $Network -OutName "fills-$SaleId.json" -Object ([ordered]@{ sale_id = $SaleId; from_index = 0; limit = 50 })

    Add-Command $plan 'What close_sale needs attached (yoctoNEAR)' 'near' `
        @('contract', 'call-function', 'as-read-only', $Contract, 'get_close_deposit', 'file-args', $saleIdArgs,
          'network-config', $net.nearCliNetwork, 'now') `
        -Expect ("`"14010000000000000000000`" (0.01401 NEAR: twice OutLayer's estimate at 5e10 instructions and 60 s)`n" +
                 "plus 1e19 per input byte above 32 KB (none for a few bids). `"0`" = no bids or not TEE: nothing goes to OutLayer.")
    Add-Check $plan "Check that the sale awaits closing and that $CloseDeposit NEAR covers the deposit" {
        $sale = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_sale' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
        if (-not $sale) { throw "No sale '$SaleId' on $Contract." }
        if ($sale.status -notin @('awaiting_close', 'closed')) { throw "Sale '$SaleId' is $($sale.status); close_sale works once bidding ended (awaiting_close) or to retry (closed)." }
        if ($sale.bid_count -lt 1) { throw "Sale '$SaleId' has no bids: close_sale would fail it with no_bids. Run -Phase Bid while it is open." }
        $need = [decimal](Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_close_deposit' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs)))
        $attached = [decimal]::Parse($CloseDeposit, [Globalization.CultureInfo]::InvariantCulture) * [decimal]1e24
        if ($attached -lt $need) { throw "close_sale needs $need yoctoNEAR; -CloseDeposit $CloseDeposit NEAR is too little." }
        Write-Host "$($sale.bid_count) bid(s); close_sale needs $need yoctoNEAR, attaching $CloseDeposit NEAR."
    }
    Add-Command $plan "Close sale '$SaleId' (asks OutLayer to clear it)" 'near' `
        @('contract', 'call-function', 'as-transaction', $Contract, 'close_sale', 'file-args', $saleIdArgs,
          'prepaid-gas', '300 Tgas', 'attached-deposit', "$CloseDeposit NEAR", 'sign-as', $Account,
          'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
        -Expect ("About 20 s (the yield waits for the worker). Return value `"settled`" (the callback's verdict); logs: sale_closed,`n" +
                 "clearing_requested, then OutLayer's execution_completed (success true) and sale_settled. KEEP THE TRANSACTION HASH.`n" +
                 "`"closed`" = the run failed or was refused: execution_completed's error_message says why (README, Troubleshooting);`n" +
                 "  run this phase again to retry. `"failed`" = the result failed the contract's checks: get_result names them.`n" +
                 "If near CLI says the transaction is not final yet, wait 30 s: near transaction view-status <tx hash> network-config $($net.nearCliNetwork)")
    Add-Check $plan 'Wait for the clear to come back' {
        for ($i = 1; $i -le 12; $i++) {
            $result = Invoke-NearView -RpcUrl $net.rpcUrl -Account $Contract -Method 'get_result' -ArgsJson ([IO.File]::ReadAllText($saleIdArgs))
            if ($result -and $result.status -ne 'clearing') { Write-Host "Status: $($result.status)"; break }
            Write-Host "Still clearing ($i/12); waiting 10 s..."
            Start-Sleep -Seconds 10
        }
    }
    Add-Command $plan 'Read the result' 'near' `
        @('contract', 'call-function', 'as-read-only', $Contract, 'get_result', 'file-args', $saleIdArgs,
          'network-config', $net.nearCliNetwork, 'now') `
        -Expect ("status `"settled`", fail_reason null, failed_checks [], clear_requests 1, n_valid = the bids placed, n_invalid 0,`n" +
                 "total_penalties `"0`", result_sha256 and input_sha256 (64 hex).`n" +
                 "With the defaults: clearing_price `"2000`" (the floor), total_sold `"500000000000000000000`" (500 tokens), total_raised `"1000000`", unsold 100 tokens.")
    Add-Command $plan 'Read the fills' 'near' `
        @('contract', 'call-function', 'as-read-only', $Contract, 'get_fills', 'file-args', $fillsArgs,
          'network-config', $net.nearCliNetwork, 'now') `
        -Expect 'One entry per bid: index, bidder, tokens, spent, refund, penalty (zero for a valid bid). Defaults: 500 tokens, spent "1000000", refund "0", penalty "0".'
    $shaText = if ($sha) { $sha } else { '<job sha256>' }
    Add-Note $plan 'Check the clear run''s attestation (read-only)' `
        ("powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $Network -TxHash <close_sale tx hash> -Signer $Account " +
         "-ExpectedWasmSha256 $shaText -Contract $Contract -SaleId $SaleId`n" +
         "Its output_hash must equal get_result's result_sha256, its input_hash the input_sha256. It prints the job's answer; with the defaults:`n" +
         '{"v":1,"ok":true,"op":"clear","sale_id":"<sale>","bid_set_hash":"<64 hex>","pubkey":"<the sale''s sealer_pubkey>",' + "`n" +
         ' "clearing_price":"2000","n_valid":1,"n_invalid":0,"invalid":[],"fills":[["500000000000000000000","1000000"]]}')
    Add-Note $plan 'Then claim: each bidder its tokens and refund, the creator the raise and the reserve' `
        ("near contract call-function as-transaction $Contract claim file-args '$saleIdArgs' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as <bidder> network-config $($net.nearCliNetwork) sign-with-keychain send`n" +
         "near contract call-function as-transaction $Contract claim_proceeds file-args '$saleIdArgs' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as <creator> network-config $($net.nearCliNetwork) sign-with-keychain send")
    Add-Note $plan 'Then lock the contract (before anyone else bids)' `
        "powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Network $Network -Account $Account -Contract $Contract -Lock"
    $preamble = Write-Preamble $net $Account "# Contract: $Contract   sale: $SaleId   closer: $Account   close deposit: $CloseDeposit NEAR"
}

if ($Execute) {
    Invoke-Plan $plan $Network
} else {
    Show-Plan $plan $preamble
}
