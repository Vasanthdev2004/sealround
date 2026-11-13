<#
.SYNOPSIS
Step 4: create the Fairground contract account and deploy the contract,
pinned to the published job.

.DESCRIPTION
Prints (or runs) the commands that:
  1. create <Contract> as a sub-account of <Account>, funded for its storage,
  2. deploy contracts\res\fairground.wasm with the init call `new`,
  3. read the config back.

-Lock is a separate step, run once the smoke tests worked (README sections 6
and 6b) and BEFORE anyone else bids: it deletes the contract account's
full-access key. Until it is gone, whoever holds that key can read every bid
while bidding is open, with no code change: the contract account is the
predecessor the master secret admits, so its key can make OutLayer run the job
on made-up "clear" requests around a real ciphertext (README section 11). The
job refuses such a request when the contract account signs it directly
(signer_is_contract), but not when the key holder deploys other code there.
With -Lock alone the script prints the steps; -Lock -PublicKey <key from the
list> -Execute deletes that key. It cannot be undone.

`new` takes (contracts/fairground/src/lib.rs, Fairground::new):
  outlayer              outlayer.testnet / outlayer.near
  sealer_source         {"Project":{"project_id":"<Account>/<Project>","version_key":"<sha256>"}}
  sealer_code_hash      <sha256>  (must equal version_key, config.rs validate)
  sealer_secrets        {"profile":"<Profile>","account_id":"<Account>"}
  allowed_quote_tokens  the USDC contracts in templates\new-args.<network>.json
  dex                   the Rhea exchange launch pools are seeded on:
                        ref-finance-101.testnet / v2.ref-finance.near
                        (null turns launch liquidity off)
`new` is #[private]: only the contract account itself can call it, which is
what `contract deploy ... with-init-call` does (deploy and init in one
transaction, signed by the contract account, so nobody can front-run the init).

The contract has no owner, no admin and no upgrade method. Its config can
never change: a new job build means a new contract account (6-upgrade-job.ps1).

Storage: the account must hold 1e19 yoctoNEAR per byte it stores, and the
contract code embeds the per-sale token wasm (contracts/fairground/src/
costs.rs, TOKEN_WASM), so the code alone is about 6.2 NEAR at 616 KB (the
build of 12 Nov 2026). The default balance is computed from the wasm on disk
(its size and sha256 are printed) plus 1 NEAR of headroom.
Sale costs are paid by each sale's creator, not by this balance.

.PARAMETER Account
Parent account (signs the account creation) and owner of the secret row.

.PARAMETER Contract
The contract account. Default fairground.<Account>. Must match the --via
account the master secret admits (3-master-secret.ps1).

.PARAMETER ContractWasm
Default contracts\res\fairground.wasm, built by scripts\build-contracts.ps1.

.PARAMETER Balance
NEAR to fund the new account with. Default: computed from the wasm size.

.PARAMETER Lock
Only the lock steps: list the contract account's keys, delete -PublicKey,
list them again (none must be left).

.PARAMETER PublicKey
With -Lock: the full-access key to delete (ed25519:..., from the list).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Account alice.testnet

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\4-deploy-contract.ps1 -Account alice.testnet -Lock -PublicKey ed25519:<key> -Execute
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
    [string]$ContractWasm,
    [double]$Balance = 0,
    [switch]$Lock,
    [string]$PublicKey,
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')
if (-not $Wasm) { $Wasm = Get-DefaultJobWasm }
if (-not $ContractWasm) { $ContractWasm = Get-DefaultContractWasm }

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if (-not $Contract) { $Contract = "fairground.$Account" }
Assert-AccountId $Contract '-Contract'

if ($Lock) {
    if ($PublicKey -and $PublicKey -cnotmatch '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$') {
        throw "-PublicKey must be an ed25519:... key as list-keys prints it, got '$PublicKey'."
    }
    $plan = New-Plan
    Add-Command $plan "List $Contract's access keys" 'near' `
        @('account', 'list-keys', $Contract, 'network-config', $net.nearCliNetwork, 'now') `
        -Expect 'One full-access key: the one near CLI generated and saved to your keychain when it created the account.'
    if ($PublicKey) {
        Add-Check $plan "Check that $PublicKey is a key of $Contract" {
            $body = [ordered]@{
                jsonrpc = '2.0'; id = 'fairground'; method = 'query'
                params = [ordered]@{ request_type = 'view_access_key_list'; finality = 'final'; account_id = $Contract }
            } | ConvertTo-Json -Depth 5 -Compress
            $response = Invoke-RestMethod -Method Post -Uri $net.rpcUrl -ContentType 'application/json' -Body $body
            if ($response.PSObject.Properties['error'] -and $response.error) { throw "RPC error: $($response.error | ConvertTo-Json -Compress -Depth 10)" }
            $keys = @($response.result.keys)
            if (-not ($keys | Where-Object { $_.public_key -ceq $PublicKey })) {
                throw "$PublicKey is not a key of $Contract (it has: $(($keys | ForEach-Object { $_.public_key }) -join ', '))."
            }
            Write-Host "$Contract has $($keys.Count) key(s); deleting $PublicKey."
            if ($keys.Count -gt 1) { Write-Host 'Delete every other key too (run -Lock again for each); one left is enough to redeploy.' -ForegroundColor Yellow }
        }
        Add-Command $plan "Delete $PublicKey (IRREVERSIBLE: nobody can ever redeploy, fix or sign for $Contract again)" 'near' `
            @('account', 'delete-keys', $Contract, 'public-keys', $PublicKey, 'network-config', $net.nearCliNetwork,
              'sign-with-keychain', 'send') -Signs `
            -Expect 'The access key ... was deleted.'
        Add-Command $plan "List $Contract's access keys again" 'near' `
            @('account', 'list-keys', $Contract, 'network-config', $net.nearCliNetwork, 'now') `
            -Expect 'No keys. From now on only the contract''s own code acts for this account.'
    } else {
        Add-Note $plan 'Then delete it' ("Run this script again with -Lock -PublicKey <the ed25519:... key from the list> (add -Execute to send).`n" +
            'Do it after the smoke tests (README 6 and 6b) and before anyone else bids: until then the key holder can read every bid.')
    }
    $preamble = Write-Preamble $net $Contract "# Lock: delete the full-access key of $Contract"
    if ($Execute) { Invoke-Plan $plan $Network } else { Show-Plan $plan $preamble }
    return
}

if ($Profile -cnotmatch '^[A-Za-z0-9_-]{1,64}$') { throw "-Profile must be 1-64 letters, digits, '-' or '_'." }
$sha = Get-JobSha256 -Wasm $Wasm -Sha256 $Sha256
$projectId = "$Account/$Project"
if (-not (Test-Path -LiteralPath $ContractWasm)) {
    throw "No contract wasm at $ContractWasm. Build it with scripts\build-contracts.ps1."
}
$contractWasmPath = (Resolve-Path -LiteralPath $ContractWasm).Path
$contractBytes = [IO.File]::ReadAllBytes($contractWasmPath)
$contractSha = Get-Sha256Hex -Bytes $contractBytes
if ($Balance -le 0) {
    # Code + about 2 KB of account record, keys and config, at 1e19 yocto/byte, plus 1 NEAR headroom.
    $Balance = [math]::Ceiling((($contractBytes.Length + 2000) / 100000.0 + 1) * 10) / 10
}
$balanceText = $Balance.ToString('0.0##', [Globalization.CultureInfo]::InvariantCulture)
$isSubAccount = $Contract.EndsWith(".$Account")

$newArgs = New-ArgsFile -Template "new-args.$Network.json" -Network $Network -OutName 'new-args.json' -Values @{
    PROJECT_ID = $projectId; SHA256 = $sha; PROFILE = $Profile; OWNER = $Account
}
$emptyArgs = New-JsonFile -Network $Network -OutName 'empty.json' -Object ([ordered]@{})
$secretsArgs = New-JsonFile -Network $Network -OutName "get-secrets-$Profile.json" -Object ([ordered]@{
    accessor = [ordered]@{ Project = [ordered]@{ project_id = $projectId } }; profile = $Profile; owner = $Account
})
$versionArgs = New-JsonFile -Network $Network -OutName 'get-version.json' -Object ([ordered]@{
    project_id = $projectId; version_key = $sha
})

$plan = New-Plan
Add-Check $plan 'Check that the pinned version and the master secret exist' {
    $version = Invoke-NearView -RpcUrl $net.rpcUrl -Account $net.outlayerContract -Method 'get_version' -ArgsJson ([IO.File]::ReadAllText($versionArgs))
    if (-not $version) { throw "Project $projectId has no version $sha. Run 1-publish-job.ps1 first." }
    if ($version.source.WasmUrl.build_target -ne 'wasm32-wasip1') { throw "Version $sha has build_target '$($version.source.WasmUrl.build_target)', not wasm32-wasip1." }
    $row = Invoke-NearView -RpcUrl $net.rpcUrl -Account $net.outlayerContract -Method 'get_secrets' -ArgsJson ([IO.File]::ReadAllText($secretsArgs))
    if (-not $row) { throw "No secret row $projectId / $Profile. Run 3-master-secret.ps1 first." }
    $access = $row.access | ConvertTo-Json -Depth 20 -Compress
    if ($access -notmatch [regex]::Escape($sha) -or $access -notmatch [regex]::Escape("`"$Contract`"")) {
        throw "The secret row's condition does not name build $sha and caller $Contract`: $access"
    }
    Write-Host "Version $sha (wasm32-wasip1) and secret row found; condition: $access"
}
if ($isSubAccount) {
    Add-Command $plan "Create $Contract with $balanceText NEAR (key saved to the near CLI keychain)" 'near' `
        @('account', 'create-account', 'fund-myself', $Contract, "$balanceText NEAR", 'autogenerate-new-keypair', 'save-to-keychain',
          'sign-as', $Account, 'network-config', $net.nearCliNetwork, 'sign-with-keychain', 'send') -Signs `
        -Expect "New account <$Contract> created successfully."
} else {
    Add-Note $plan "Create $Contract yourself" "$Contract is not a sub-account of $Account, so create and fund it ($balanceText NEAR) with its own parent, and import its key into near CLI."
}
Add-Command $plan "Deploy $([IO.Path]::GetFileName($contractWasmPath)) and call new" 'near' `
    @('contract', 'deploy', $Contract, 'use-file', $contractWasmPath, 'with-init-call', 'new', 'file-args', $newArgs,
      'prepaid-gas', '100 Tgas', 'attached-deposit', '0 NEAR', 'network-config', $net.nearCliNetwork,
      'sign-with-keychain', 'send') -Signs `
    -Expect ("Contract code has been successfully deployed. The `"new`" call ... succeeded.`n" +
             "A failure 'invalid config: ...' names the rule (contracts/fairground/src/config.rs); nothing is half-deployed, fix and rerun.")
Add-Command $plan 'Read the config back' 'near' `
    @('contract', 'call-function', 'as-read-only', $Contract, 'get_config', 'file-args', $emptyArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect "The same values as $newArgs"
Add-Command $plan 'Check the code hash and storage' 'near' `
    @('account', 'view-account-summary', $Contract, 'network-config', $net.nearCliNetwork, 'now') `
    -Expect "Contract (SHA-256 checksum hex): $contractSha`nNative account balance above the storage it uses (code: $($contractBytes.Length) bytes)."
Add-Note $plan 'Next: smoke tests, then LOCK before anyone else bids' `
    ("5-smoke-sale.ps1 and 7-smoke-clear.ps1, then: 4-deploy-contract.ps1 -Account $Account -Contract $Contract -Lock`n" +
     "Until the contract account's key is deleted, whoever holds it can read every bid (README sections 5 and 11).")

$preamble = Write-Preamble $net $Account ("# Contract: $Contract   wasm: $contractWasmPath ($($contractBytes.Length) bytes, sha256 $contractSha)`n" +
    "# Pins: $projectId @ $sha, secrets $Account/$Profile")
if ($Execute) {
    Invoke-Plan $plan $Network
} else {
    Show-Plan $plan $preamble
}
