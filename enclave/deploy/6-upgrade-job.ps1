<#
.SYNOPSIS
Step 6 (later): move to a new build of the enclave job without losing the
master secret.

.DESCRIPTION
A Fairground contract pins one job build forever (config has no admin method),
and the master secret's condition admits one build (the WasmHash leaf) called
from one contract (the Predecessor leaf). A new build therefore means:

  1. publish the new build as a new project version (1-publish-job.ps1),
  2. move the secret's condition to the new build and the new contract,
     keeping its value (this script),
  3. deploy a NEW Fairground contract account pinned to the new build
     (4-deploy-contract.ps1 -Contract <new> -Sha256 <new>).

The value stays, so the master stays. A sale's key is derived from
(master, contract account, sale id) (crates/sealer/src/keys.rs), so every
existing sale of the old contract keeps its key; sales of the new contract
get new keys because the contract account differs.

Two ways to move the condition:

- Cutover (default): `outlayer secrets access --build <new> --via <new contract>`.
  The CLI swaps the WasmHash leaf (lock_to_build, outlayer-cli 0.2.2
  src/commands/secrets.rs:220-235) and replaces the caller list with the new
  contract (with_callers, :405-413); access() keeps the value (:1235-1379).
  From then on the OLD contract can no longer clear its sales (its pinned old
  build is refused the master); those sales end through the settle timeout,
  with full refunds. Use it when the old contract has no open sale.

- -Transition: update_access with
    And[ Or[WasmHash{old}, WasmHash{new}], Predecessor{Whitelist[old, new]} ]
  Each contract pins its own build, so both keep working. The CLI cannot
  write an Or of builds (it keeps a single lock), so this goes through
  update_access directly; the live contract accepts this condition
  (estimate_storage_cost on outlayer.testnet, 9 Nov 2026). Run the script
  again without -Transition once the old contract's sales are all final.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\6-upgrade-job.ps1 -Account alice.testnet -OldSha256 <old> -NewContract fairground-v2.alice.testnet -Transition
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [Parameter(Mandatory)][string]$OldSha256,
    [Parameter(Mandatory)][string]$NewContract,
    [string]$OldContract,
    [string]$Project = 'fairground-sealer',
    [string]$Wasm,
    [string]$Sha256,
    [string]$Profile = 'default',
    [switch]$Transition,
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')
if (-not $Wasm) { $Wasm = Get-DefaultJobWasm }

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $OldContract) { $OldContract = "sealround.$Account" }
Assert-AccountId $OldContract '-OldContract'
Assert-AccountId $NewContract '-NewContract'
if ($NewContract -eq $OldContract) { throw 'The new build needs a new contract account: a deployed contract cannot change its pinned build.' }
$old = $OldSha256.Trim().ToLowerInvariant()
Assert-Sha256 $old '-OldSha256'
$new = Get-JobSha256 -Wasm $Wasm -Sha256 $Sha256
if ($new -eq $old) { throw 'The new build has the same sha256 as the old one.' }
if ($Profile -cnotmatch '^[A-Za-z0-9_-]{1,64}$') { throw "-Profile must be 1-64 letters, digits, '-' or '_'." }
$projectId = "$Account/$Project"

$secretsArgs = New-JsonFile -Network $Network -OutName "get-secrets-$Profile.json" -Object ([ordered]@{
    accessor = [ordered]@{ Project = [ordered]@{ project_id = $projectId } }; profile = $Profile; owner = $Account
})
$versionArgs = New-JsonFile -Network $Network -OutName 'get-version.json' -Object ([ordered]@{
    project_id = $projectId; version_key = $new
})

$plan = New-Plan
Add-Check $plan 'Check that the new version is published and the row exists' {
    $version = Invoke-NearView -RpcUrl $net.rpcUrl -Account $net.outlayerContract -Method 'get_version' -ArgsJson ([IO.File]::ReadAllText($versionArgs))
    if (-not $version) { throw "Project $projectId has no version $new. Run 1-publish-job.ps1 for the new build first." }
    if ($version.source.WasmUrl.build_target -ne 'wasm32-wasip1') { throw "Version $new has build_target '$($version.source.WasmUrl.build_target)'." }
    $row = Invoke-NearView -RpcUrl $net.rpcUrl -Account $net.outlayerContract -Method 'get_secrets' -ArgsJson ([IO.File]::ReadAllText($secretsArgs))
    if (-not $row) { throw "No secret row $projectId / $Profile to move." }
    Write-Host "Current condition: $($row.access | ConvertTo-Json -Depth 20 -Compress)"
}
if ($Transition) {
    $updateArgs = New-ArgsFile -Template 'update-access-transition.json' -Network $Network -OutName "update-access-$Profile-transition.json" -Values @{
        PROJECT_ID = $projectId; PROFILE = $Profile; OLD_SHA256 = $old; SHA256 = $new; OLD_CALLER = $OldContract; CALLER = $NewContract
    }
    Add-Command $plan "Admit both builds, each from its own contract ($OldContract, $NewContract)" 'near' `
        @('contract', 'call-function', 'as-transaction', $net.outlayerContract, 'update_access', 'file-args', $updateArgs,
          'prepaid-gas', '30 Tgas', 'attached-deposit', '0.01 NEAR', 'sign-as', $Account,
          'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
        -Expect "Logs 'Access control updated: ...'. The deposit the row holds is credited; the excess of the 0.01 NEAR comes back."
} else {
    Add-Command $plan "Move the lock to build $($new.Substring(0, 12))... called from $NewContract (cutover)" 'outlayer' `
        @('secrets', 'access', '--project', $projectId, '--profile', $Profile, '--build', $new, '--via', $NewContract) -Signs `
        -Expect ("'Calls admitted only from: $NewContract', then 'Access updated (profile: $Profile): ...'.`n" +
                 "From now on $OldContract cannot clear its sales (they refund after their settle timeout).")
}
Add-Command $plan 'Read the condition back' 'near' `
    @('contract', 'call-function', 'as-read-only', $net.outlayerContract, 'get_secrets', 'file-args', $secretsArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect $(if ($Transition) { "access: And[ Or[WasmHash $old, WasmHash $new], Predecessor{Whitelist[$OldContract, $NewContract]} ]" }
              else { "access: And[ WasmHash $new, Predecessor{Whitelist[$NewContract]} ]" })
Add-Note $plan "Deploy the new contract pinned to $($new.Substring(0, 12))..." `
    "powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Network $Network -Account $Account -Contract $NewContract -Sha256 $new"
Add-Note $plan 'Point the web app at the new contract' 'Bidders and creators of new sales use the new contract account; the old one only finishes its own sales.'

$preamble = Write-Preamble $net $Account "# $projectId / ${Profile}: build $old -> $new, caller $OldContract -> $NewContract$(if ($Transition) { ' (transition: both)' })"
if ($Execute) {
    $env:OUTLAYER_NETWORK = $Network
    Invoke-Plan $plan $Network
} else {
    $preamble += "`$env:OUTLAYER_NETWORK = '$Network'"
    Show-Plan $plan $preamble
}
