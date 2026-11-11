<#
.SYNOPSIS
Step 2: run the published job once, directly from your own account, on a
throwaway secret profile.

.DESCRIPTION
Proves the whole OutLayer path before any contract exists: project version,
wasm32-wasip1 target, a PROTECTED_ master generated in the TEE, the keystore's
WasmHash and Predecessor checks, and the job's own predecessor check.

It uses a separate profile ("smoke") whose master is a different random value
than the production one (step 3), and whose condition admits calls from your
own account only:

  And[ WasmHash{<sha256>}, Predecessor{ Whitelist[<Account>] } ]

The request is exactly what the Fairground contract sends (contracts/
fairground/src/outlayer.rs: same source, limits and Text format), except that
the predecessor is you, so the input names you as the "contract". The job
refuses any request whose "contract" is not the predecessor
(predecessor_mismatch, crates/sealer/src/job.rs), so this run can only ever derive keys for
<Account>, never for a Fairground contract. You also sign the transaction, so
signer = predecessor; the job serves that only for a pubkey request (it fails
any other such run with signer_is_contract, enclave/job/src/main.rs).

Every `outlayer secrets` subcommand uses --profile default when --profile is
left out, and default is the PRODUCTION master's row. Copy the commands this
script prints (they always carry --profile) rather than typing them.

.PARAMETER Account
Your NEAR account: the project and secret owner, and the caller here.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\2-smoke-job.ps1 -Account alice.testnet
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [string]$Project = 'fairground-sealer',
    [string]$Wasm,
    [string]$Sha256,
    [string]$Profile = 'smoke',
    [string]$SaleId = 'smoke',
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')
if (-not $Wasm) { $Wasm = Get-DefaultJobWasm }

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if ($Profile -cnotmatch '^[A-Za-z0-9_-]{1,64}$') { throw "-Profile must be 1-64 letters, digits, '-' or '_'." }
if ($Profile -eq 'default') { throw "Use a separate profile for the smoke test, not the production profile 'default'." }
if ($SaleId -cnotmatch '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$') { throw "-SaleId '$SaleId' breaks the sale id rule." }
$sha = Get-JobSha256 -Wasm $Wasm -Sha256 $Sha256
$projectId = "$Account/$Project"

$requestArgs = New-ArgsFile -Template 'request-pubkey.json' -Network $Network -OutName "request-pubkey-$Profile.json" -Values @{
    PROJECT_ID = $projectId; SHA256 = $sha; CALLER = $Account; SALE_ID = $SaleId; PROFILE = $Profile; OWNER = $Account
}
$secretsArgs = New-JsonFile -Network $Network -OutName "get-secrets-$Profile.json" -Object ([ordered]@{
    accessor = [ordered]@{ Project = [ordered]@{ project_id = $projectId } }; profile = $Profile; owner = $Account
})
$expectedAccess = '{"Logic":{"operator":"And","conditions":[{"WasmHash":{"hash":"' + $sha +
    '"}},{"Predecessor":{"condition":{"Whitelist":{"accounts":["' + $Account + '"]}}}}]}}'

$plan = New-Plan
Add-Check $plan "Say whether a '$Profile' row exists already" {
    $row = Invoke-NearView -RpcUrl $net.rpcUrl -Account $net.outlayerContract -Method 'get_secrets' -ArgsJson ([IO.File]::ReadAllText($secretsArgs))
    if ($row) { Write-Host "Profile '$Profile' already exists; generating again only replaces the smoke master. Continuing." -ForegroundColor Yellow }
}
Add-Command $plan "Generate a throwaway master in the TEE under profile '$Profile', readable only by this build called from $Account" 'outlayer' `
    @('secrets', 'set', '--generate', 'PROTECTED_FAIRGROUND_MASTER:hex32', '--project', $projectId, '--profile', $Profile,
      '--access', 'allow-all', '--build', $sha, '--via', $Account) -Signs `
    -Expect ("The CLI prints 'Locked to build: ...', 'Calls admitted only from: $Account' and`n" +
             "'Secrets stored (profile: $Profile, protected (TEE): PROTECTED_FAIRGROUND_MASTER)'. 0.1 NEAR attached, excess refunded.")
Add-Command $plan 'Read the stored condition back' 'near' `
    @('contract', 'call-function', 'as-read-only', $net.outlayerContract, 'get_secrets', 'file-args', $secretsArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect "access: $expectedAccess (the two conditions may print in either order)"
Add-Command $plan "Run the job: a pubkey request for sale '$SaleId' of 'contract' $Account" 'near' `
    @('contract', 'call-function', 'as-transaction', $net.outlayerContract, 'request_execution', 'file-args', $requestArgs,
      'prepaid-gas', '300 Tgas', 'attached-deposit', '0.02 NEAR', 'sign-as', $Account,
      'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
    -Expect ("Return value, a JSON string (Text format), about 20 s later:`n" +
             "  `"{\`"v\`":1,\`"ok\`":true,\`"op\`":\`"pubkey\`",\`"sale_id\`":\`"$SaleId\`",\`"pubkey\`":\`"<64 hex>\`"}`"`n" +
             "null = the run failed or was refused, by OutLayer or by the job itself; the reason is the error_message of the`n" +
             "  execution_completed event in this transaction's logs (the job's own: 'fairground-sealer: refused: <code>'). See README, Troubleshooting.`n" +
             "ok:false = the job ran and refused the request itself (for example predecessor_mismatch).`n" +
             "OutLayer keeps about 0.001 NEAR + 0.0001 NEAR per second of run time and refunds the rest to you.`n" +
             "If near CLI says the transaction is not final yet, wait 30 s and run: near transaction view-status <tx hash> network-config $($net.nearCliNetwork)")
Add-Note $plan 'Check the attestation of that run' `
    ("powershell -ExecutionPolicy Bypass -File enclave\deploy\Verify-Attestation.ps1 -Network $Network -TxHash <tx hash> -Signer $Account -ExpectedWasmSha256 $sha")
Add-Note $plan "Optional: delete the smoke row afterwards (refunds its storage)" `
    ("outlayer secrets delete --project $projectId --profile $Profile`n" +
     "There is NO confirmation prompt. Copy this line; do not type it. Leaving --profile out means --profile default,`n" +
     "and that deletes the PRODUCTION master for good: every open sale's bids become unreadable.")

$preamble = Write-Preamble $net $Account "# Project: $projectId   version_key: $sha   profile: $Profile"
if ($Execute) {
    $env:OUTLAYER_NETWORK = $Network
    Invoke-Plan $plan $Network
} else {
    $preamble += "`$env:OUTLAYER_NETWORK = '$Network'"
    Show-Plan $plan $preamble
}
