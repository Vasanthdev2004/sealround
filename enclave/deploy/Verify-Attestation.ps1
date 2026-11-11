<#
.SYNOPSIS
Checks OutLayer's attestation of one enclave-job run against the chain.
Read-only: it never signs anything.

.DESCRIPTION
Fetches the attestation the worker filed for a transaction
(GET {api}/attestations/by-tx/{hash}, OutLayer API.md:124) and the
transaction's receipts (NEAR RPC EXPERIMENTAL_tx_status), then checks:

  wasm_hash             the attested build is the pinned sha256
  executed_wasm_sha256  the bytes the worker measured are the pinned build
  input_hash            sha256 of the input_data in the request_execution receipt
  output_hash           sha256 of the exact bytes OutLayer's on_execution_response
                        returned (what the Fairground callback received)
  task_hash             SHA-256 over the attested fields (OutLayer worker/src/
                        tdx_attestation.rs:173-213) equals the quote's
                        report_data[0..32], and report_data[32..64] is zero
  measurements          MRTD and RTMR0-3 from the quote are approved by the
                        register contract (worker.outlayer.testnet / .near,
                        is_measurements_approved)
With -Contract and -SaleId it also checks that the request came from that
contract with the pinned source, and compares the job's answer with what the
contract stored: sealer_pubkey (a pubkey answer gives the sale's key, a clear
answer names the key it opened the bids with) and, for a clear, result_sha256
and input_sha256.

Not checked here: the quote's signature chain up to Intel. OutLayer's
dashboard verifier and its outlayer-verify tool do that.

Quote layout (TDX quote v4): header 48 bytes, then the TD report: MRTD at 184,
RTMR0-3 at 376/424/472/520 (48 bytes each), report_data at 568. Checked on
9 Nov 2026: measurements read this way from testnet request 14806's quote are
approved by worker.outlayer.testnet.

.PARAMETER TxHash
The transaction that led to the run: create_sale (pubkey) or close_sale
(clear), or your direct request_execution.

.PARAMETER Signer
The account that signed that transaction (RPC needs it to find the tx).

.PARAMETER AttestationFile
.PARAMETER TxStatusFile
Offline mode: read saved JSON instead of fetching.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -TxHash 6Kq... -Signer alice.testnet -ExpectedWasmSha256 <sha256> -Contract fairground.alice.testnet -SaleId smoke-11091530
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [string]$TxHash,
    [string]$Signer,
    [Parameter(Mandatory)][string]$ExpectedWasmSha256,
    [string]$Contract,
    [string]$SaleId,
    [string]$AttestationFile,
    [string]$TxStatusFile,
    [string]$RpcUrl,
    [string]$ApiUrl,
    [switch]$SkipMeasurements
)

. (Join-Path $PSScriptRoot '_common.ps1')

$net = Get-DeployNetwork $Network
if (-not $RpcUrl) { $RpcUrl = $net.rpcUrl }
if (-not $ApiUrl) { $ApiUrl = $net.outlayerApi }
$expected = $ExpectedWasmSha256.Trim().ToLowerInvariant()
Assert-Sha256 $expected '-ExpectedWasmSha256'
if ($Contract) { Assert-AccountId $Contract '-Contract' }

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$Check, [bool]$Ok, [string]$Detail) {
    $results.Add([pscustomobject]@{ Check = $Check; Result = $(if ($Ok) { 'PASS' } else { 'FAIL' }); Detail = $Detail })
}
function Get-Field($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    $null
}
function From-Base64Utf8([string]$Text) { $script:Utf8NoBom.GetString([Convert]::FromBase64String($Text)) }
function Get-Hex([byte[]]$Bytes, [int]$Offset, [int]$Length) {
    (($Bytes[$Offset..($Offset + $Length - 1)] | ForEach-Object { $_.ToString('x2') }) -join '')
}

# --- Load the attestation and the transaction ---
if ($AttestationFile) {
    $att = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $AttestationFile).Path) | ConvertFrom-Json
} else {
    if (-not $TxHash) { throw 'Pass -TxHash (or -AttestationFile and -TxStatusFile).' }
    $att = Invoke-RestMethod -Method Get -Uri "$ApiUrl/attestations/by-tx/$TxHash"
}
if ($TxStatusFile) {
    $tx = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $TxStatusFile).Path) | ConvertFrom-Json
} else {
    if (-not ($TxHash -and $Signer)) { throw 'Pass -TxHash and -Signer (or -TxStatusFile).' }
    $body = [ordered]@{
        jsonrpc = '2.0'; id = 'fairground'; method = 'EXPERIMENTAL_tx_status'
        params = [ordered]@{ tx_hash = $TxHash; sender_account_id = $Signer; wait_until = 'FINAL' }
    } | ConvertTo-Json -Compress
    $tx = Invoke-RestMethod -Method Post -Uri $RpcUrl -ContentType 'application/json' -Body $body
    if ((Get-Field $tx 'error')) { throw "RPC: $($tx.error | ConvertTo-Json -Compress -Depth 10)" }
}
if (Get-Field $tx 'result') { $tx = $tx.result }

# --- Find the OutLayer receipts: the request and the callback that returned the output ---
$outlayer = $net.outlayerContract
$requests = New-Object System.Collections.Generic.List[object]
$callbacks = New-Object System.Collections.Generic.List[object]
foreach ($r in @($tx.receipts)) {
    if ($r.receiver_id -ne $outlayer) { continue }
    $action = Get-Field $r.receipt 'Action'
    if (-not $action) { continue }
    foreach ($a in @($action.actions)) {
        $call = Get-Field $a 'FunctionCall'
        if (-not $call) { continue }
        if ($call.method_name -eq 'request_execution') { $requests.Add([pscustomobject]@{ Receipt = $r; Call = $call }) }
        if ($call.method_name -eq 'on_execution_response') { $callbacks.Add($r) }
    }
}
if ($requests.Count -ne 1 -or $callbacks.Count -ne 1) {
    throw "Expected one request_execution and one on_execution_response receipt to $outlayer, found $($requests.Count) and $($callbacks.Count). Is the transaction final, and on $Network?"
}
$request = $requests[0]
$requestArgs = From-Base64Utf8 $request.Call.args | ConvertFrom-Json
$inputData = [string]$requestArgs.input_data
$outcome = @($tx.receipts_outcome | Where-Object { $_.id -eq $callbacks[0].receipt_id })[0]
# OutLayer's own record of the run, logged by on_execution_response (OutLayer
# contract/src/execution.rs:666/738, events.rs ExecutionCompletedEventData).
# Its error_message is the only place a failed run's reason reaches the chain.
$completed = $null
foreach ($log in @(Get-Field $outcome.outcome 'logs')) {
    if ([string]$log -like 'EVENT_JSON:*"execution_completed"*') {
        $completed = @(([string]$log).Substring(11) | ConvertFrom-Json | ForEach-Object { $_.data })[0]
    }
}
$successValue = Get-Field $outcome.outcome.status 'SuccessValue'
if ($null -eq $successValue) { throw "on_execution_response did not succeed: $($outcome.outcome.status | ConvertTo-Json -Compress)" }
$outputBytes = [Convert]::FromBase64String([string]$successValue)

# --- Hashes ---
$wasmHash = [string](Get-Field $att 'wasm_hash')
Add-Result 'wasm_hash' ($wasmHash -eq $expected) "attested $wasmHash"
$executed = Get-Field $att 'executed_wasm_sha256'
if ($null -ne $executed) { Add-Result 'executed_wasm_sha256' ([string]$executed -eq $expected) "measured $executed" }
$inputHash = Get-Sha256Hex -Bytes $script:Utf8NoBom.GetBytes($inputData)
Add-Result 'input_hash' ($inputHash -eq [string]$att.input_hash) "sha256(input_data) = $inputHash"
$outputHash = Get-Sha256Hex -Bytes $outputBytes
Add-Result 'output_hash' ($outputHash -eq [string]$att.output_hash) "sha256($($outputBytes.Length) returned bytes) = $outputHash"

# --- Task hash against the quote's report_data (worker/src/tdx_attestation.rs) ---
if (-not [BitConverter]::IsLittleEndian) { throw 'This check assumes a little-endian machine.' }
$stream = New-Object IO.MemoryStream
function Add-Text($Value) { if ($null -ne $Value -and [string]$Value -ne '') { $b = $script:Utf8NoBom.GetBytes([string]$Value); $stream.Write($b, 0, $b.Length) } }
function Add-Le64($Value) { $b = [BitConverter]::GetBytes([long]$Value); $stream.Write($b, 0, 8) }
Add-Text $att.task_type
Add-Le64 $att.task_id
foreach ($name in 'repo', 'commit', 'build_target', 'wasm_hash', 'input_hash') { Add-Text (Get-Field $att $name) }
Add-Text $att.output_hash
if ($null -ne (Get-Field $att 'block_height')) { Add-Le64 $att.block_height }
foreach ($name in 'caller_account_id', 'project_id', 'secrets_ref') { Add-Text (Get-Field $att $name) }
Add-Le64 $att.timestamp
Add-Text (Get-Field $att 'attached_usd')
$taskHash = Get-Sha256Hex -Bytes $stream.ToArray()
$quote = [Convert]::FromBase64String([string]$att.tdx_quote)
$version = [BitConverter]::ToUInt16($quote, 0)
$teeType = [BitConverter]::ToUInt32($quote, 4)
if ($version -ne 4 -or $teeType -ne 0x81 -or $quote.Length -lt 632) {
    Add-Result 'quote_format' $false "version $version, tee_type 0x$($teeType.ToString('x')), $($quote.Length) bytes: not a TDX v4 quote"
} else {
    $reportData = Get-Hex $quote 568 32
    Add-Result 'task_hash' ($reportData -eq $taskHash) "recomputed $taskHash, quote $reportData"
    Add-Result 'report_data_tail' ((Get-Hex $quote 600 32) -eq ('0' * 64)) 'report_data[32..64] is zero'
    $measurements = [ordered]@{
        mrtd = Get-Hex $quote 184 48; rtmr0 = Get-Hex $quote 376 48; rtmr1 = Get-Hex $quote 424 48
        rtmr2 = Get-Hex $quote 472 48; rtmr3 = Get-Hex $quote 520 48
    }
    if (-not $SkipMeasurements) {
        $argsJson = ConvertTo-Json -InputObject ([ordered]@{ measurements = $measurements }) -Compress
        $approved = Invoke-NearView -RpcUrl $RpcUrl -Account $net.registerContract -Method 'is_measurements_approved' -ArgsJson $argsJson
        Add-Result 'measurements' ($approved -eq $true) "$($net.registerContract).is_measurements_approved = $approved (rtmr3 $($measurements.rtmr3.Substring(0, 16))...)"
    }
}

# --- The request itself, and the job's answer ---
$source = $requestArgs.source | ConvertTo-Json -Compress -Depth 5
$pinned = (Get-Field (Get-Field $requestArgs.source 'Project') 'version_key') -eq $expected -or
          (Get-Field (Get-Field $requestArgs.source 'WasmUrl') 'hash') -eq $expected
Add-Result 'request_source' $pinned "source $source"
$answer = $null
$text = $script:Utf8NoBom.GetString($outputBytes)
try {
    $inner = $text | ConvertFrom-Json
    if ($inner -is [string]) { $answer = $inner | ConvertFrom-Json }
} catch { $answer = $null }
if ($Contract) {
    Add-Result 'request_caller' ($request.Receipt.predecessor_id -eq $Contract) "predecessor $($request.Receipt.predecessor_id)"
    if (-not $answer) {
        Add-Result 'job_answer' $false "the output is not the sealer's Text answer: $($text.Substring(0, [math]::Min(120, $text.Length)))"
    } elseif ($SaleId) {
        $saleArgs = ConvertTo-Json -InputObject ([ordered]@{ sale_id = $SaleId }) -Compress
        if ($answer.op -eq 'pubkey') {
            $sale = Invoke-NearView -RpcUrl $RpcUrl -Account $Contract -Method 'get_sale' -ArgsJson $saleArgs
            Add-Result 'sealer_pubkey' ($answer.ok -and $sale -and $answer.pubkey -eq $sale.sealer_pubkey) "job $($answer.pubkey), contract $(Get-Field $sale 'sealer_pubkey')"
        } elseif ($answer.op -eq 'clear') {
            $result = Invoke-NearView -RpcUrl $RpcUrl -Account $Contract -Method 'get_result' -ArgsJson $saleArgs
            Add-Result 'result_sha256' ((Get-Field $result 'result_sha256') -eq $outputHash) "contract stored $(Get-Field $result 'result_sha256')"
            Add-Result 'input_sha256' ((Get-Field $result 'input_sha256') -eq $inputHash) "contract stored $(Get-Field $result 'input_sha256') (the LAST clear request)"
            if ($answer.ok) {
                # A clear names the key it opened the bids with: the key they were sealed to.
                $sale = Invoke-NearView -RpcUrl $RpcUrl -Account $Contract -Method 'get_sale' -ArgsJson $saleArgs
                $opened = Get-Field $answer 'pubkey'
                Add-Result 'sealer_pubkey' ([bool]$opened -and $sale -and $opened -eq (Get-Field $sale 'sealer_pubkey')) "job $opened, contract $(Get-Field $sale 'sealer_pubkey')"
            }
        }
    }
}

Write-Host ''
Write-Host "Attestation $($att.id): request $($att.request_id), block $($att.block_height), signer $($att.caller_account_id)"
Write-Host "project $(Get-Field $att 'project_id'), secrets $(Get-Field $att 'secrets_ref'), build_target $(Get-Field $att 'build_target')"
if ($completed) {
    Write-Host ("OutLayer execution_completed: success {0}, error {1}, charged {2} yoctoNEAR, refunded {3}" -f
        $completed.success, $(if ($completed.error_message) { $completed.error_message } else { 'none' }),
        $completed.payment_charged, $completed.payment_refunded)
}
if ($answer) { Write-Host "job answer: $($answer | ConvertTo-Json -Compress -Depth 4)" }
$results | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host
Write-Host 'Not checked: the quote''s signature chain up to Intel (use the OutLayer dashboard verifier or outlayer-verify).' -ForegroundColor DarkGray
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
if ($failed) {
    Write-Host "$failed check(s) FAILED." -ForegroundColor Red
    exit 1
}
Write-Host 'All checks passed.' -ForegroundColor Green
