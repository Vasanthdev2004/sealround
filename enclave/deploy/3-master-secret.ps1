<#
.SYNOPSIS
Step 3: generate the production master secret inside OutLayer's keystore TEE,
readable only by the pinned build when the Fairground contract calls.

.DESCRIPTION
Prints (or runs) one `outlayer secrets set` that generates
PROTECTED_FAIRGROUND_MASTER (32 random bytes, hex) in the TEE and stores it on
the project row <Account>/<Project>, profile -Profile, with the condition

  And[ WasmHash{<sha256>}, Predecessor{ Whitelist[<Contract>] } ]

How the CLI builds it (outlayer-cli 0.2.2 src/commands/secrets.rs):
`--access allow-all` is the signer-side condition (anyone may SIGN the
transaction: close_sale is open to everyone); `--build` turns AllowAll into the
WasmHash leaf alone (lock_to_build, :220-235); `--via` then ANDs
Predecessor{Whitelist[...]} on top (with_callers, :405-413; applied last, :903).
The contract is named before it exists; the keystore only compares names.

Without --access a NEW project row admits only the signer
(default_access, :656-662), which would refuse every close_sale signed by
someone else. The live contract accepts this exact condition
(estimate_storage_cost on outlayer.testnet and outlayer.near, 9 Nov 2026).

NEVER run `secrets set` again on this profile once sales exist: it generates
a NEW master, every sale key changes, and every open sale's bids become
unreadable (those sales end in refunds). To change who may read, use
`outlayer secrets access` (6-upgrade-job.ps1) or update_access; both keep the
value. With -Execute this script refuses if the row already exists.

Every `outlayer secrets` subcommand (set, update, access, delete) uses
--profile default when --profile is left out, so a command meant for the
smoke row that loses its --profile hits this production row, and `secrets
delete` asks no confirmation. Copy the printed commands; do not retype them.

.PARAMETER Contract
The Fairground contract account that will call OutLayer. Default:
fairground.<Account>.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\3-master-secret.ps1 -Account alice.testnet
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [string]$Contract,
    [string]$Project = 'fairground-sealer',
    [string]$Wasm,
    [string]$Sha256,
    [string]$Profile = 'default',
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')
if (-not $Wasm) { $Wasm = Get-DefaultJobWasm }

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $Contract) { $Contract = "fairground.$Account" }
Assert-AccountId $Contract '-Contract'
if ($Profile -cnotmatch '^[A-Za-z0-9_-]{1,64}$') { throw "-Profile must be 1-64 letters, digits, '-' or '_'." }
$sha = Get-JobSha256 -Wasm $Wasm -Sha256 $Sha256
$projectId = "$Account/$Project"

$secretsArgs = New-JsonFile -Network $Network -OutName "get-secrets-$Profile.json" -Object ([ordered]@{
    accessor = [ordered]@{ Project = [ordered]@{ project_id = $projectId } }; profile = $Profile; owner = $Account
})
$updateArgs = New-ArgsFile -Template 'update-access.json' -Network $Network -OutName "update-access-$Profile.json" -Values @{
    PROJECT_ID = $projectId; PROFILE = $Profile; SHA256 = $sha; CALLER = $Contract
}
$negativeArgs = New-ArgsFile -Template 'request-pubkey.json' -Network $Network -OutName "request-pubkey-$Profile-negative.json" -Values @{
    PROJECT_ID = $projectId; SHA256 = $sha; CALLER = $Account; SALE_ID = 'negative'; PROFILE = $Profile; OWNER = $Account
}
$expectedAccess = '{"Logic":{"operator":"And","conditions":[{"WasmHash":{"hash":"' + $sha +
    '"}},{"Predecessor":{"condition":{"Whitelist":{"accounts":["' + $Contract + '"]}}}}]}}'

$plan = New-Plan
Add-Check $plan "Refuse if profile '$Profile' already holds a master" {
    $row = Invoke-NearView -RpcUrl $net.rpcUrl -Account $net.outlayerContract -Method 'get_secrets' -ArgsJson ([IO.File]::ReadAllText($secretsArgs))
    if ($row) {
        throw ("Profile '$Profile' of $projectId already exists. Generating again would REPLACE the master and break every open sale. " +
               "To change its condition use 6-upgrade-job.ps1 (outlayer secrets access) instead.")
    }
    Write-Host "No row yet for $projectId / $Profile."
}
Add-Command $plan "Generate the master in the TEE, readable only by build $($sha.Substring(0, 12))... called from $Contract" 'outlayer' `
    @('secrets', 'set', '--generate', 'PROTECTED_FAIRGROUND_MASTER:hex32', '--project', $projectId, '--profile', $Profile,
      '--access', 'allow-all', '--build', $sha, '--via', $Contract) -Signs `
    -Expect ("'Locked to build: ...', 'Calls admitted only from: $Contract',`n" +
             "'Secrets stored (profile: $Profile, protected (TEE): PROTECTED_FAIRGROUND_MASTER)'. Nobody, you included, ever sees the value.")
Add-Command $plan 'Read the stored condition back' 'near' `
    @('contract', 'call-function', 'as-read-only', $net.outlayerContract, 'get_secrets', 'file-args', $secretsArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect "access: $expectedAccess (the two conditions may print in either order)"
Add-Note $plan 'Fallback: set the same condition with update_access (keeps the value; use only if the CLI cannot express it)' `
    ("near contract call-function as-transaction $($net.outlayerContract) update_access file-args '$updateArgs' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $Account network-config $($net.nearCliNetwork) sign-with-keychain send`n" +
     "update_access credits the deposit the row already holds and refunds the excess (OutLayer contract/src/secrets.rs:633-696).")
Add-Note $plan "Optional negative check: your own account must NOT be able to use this row" `
    ("near contract call-function as-transaction $($net.outlayerContract) request_execution file-args '$negativeArgs' prepaid-gas '300 Tgas' attached-deposit '0.02 NEAR' sign-as $Account network-config $($net.nearCliNetwork) sign-with-keychain send`n" +
     "Expected return value: null (the keystore refuses: the predecessor is $Account, not $Contract). Costs the 0.001 NEAR base fee.")

$preamble = Write-Preamble $net $Account "# Project: $projectId   profile: $Profile   build: $sha   caller: $Contract"
if ($Execute) {
    $env:OUTLAYER_NETWORK = $Network
    Invoke-Plan $plan $Network
} else {
    $preamble += "`$env:OUTLAYER_NETWORK = '$Network'"
    $preamble += "# Check first that the row does not exist (prints null): near contract call-function as-read-only $($net.outlayerContract) get_secrets file-args '$secretsArgs' network-config $($net.nearCliNetwork) now"
    Show-Plan $plan $preamble
}
