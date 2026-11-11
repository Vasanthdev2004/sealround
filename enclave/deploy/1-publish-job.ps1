<#
.SYNOPSIS
Step 1: publish the enclave job as an OutLayer project version.

.DESCRIPTION
Prints (or, with -Execute, runs) the commands that:
  1. log the OutLayer CLI in as -Account,
  2. upload the job wasm to FastFS (`outlayer upload`),
  3. check that the FastFS URL serves exactly those bytes,
  4. create the project <Account>/<Project>, or add a version to it
     (`outlayer deploy`), as a wasm32-wasip1 module,
  5. read the version back from the OutLayer contract.

Why `--target wasm32-wasip1`: `outlayer deploy` defaults to wasm32-wasip2
(outlayer-cli 0.2.2 src/main.rs:62-64) and stores that in the version. The
worker then runs only the P2 executor and does not fall back
(worker/src/executor/mod.rs:534-561), so a P1 module would fail every run.

Why `--hash`: without it the CLI downloads the URL to hash it
(src/commands/deploy.rs:24-30). Passing the hash of the local file pins
exactly what you built; the worker refuses bytes that do not match.

.PARAMETER Account
Your NEAR account. It owns the OutLayer project and the secret.

.PARAMETER Wasm
The built job. Default: enclave\res\fairground_sealer.wasm (written by
scripts\build-enclave.ps1, with a .sha256 file next to it).

.PARAMETER Sha256
The job's sha256, to print commands before a build exists. If the wasm
exists too, they must match.

.PARAMETER SkipLogin
Leave out `outlayer login` (you are logged in already).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File enclave\deploy\1-publish-job.ps1 -Account alice.testnet
#>
[CmdletBinding()]
param(
    [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
    [Parameter(Mandatory)][string]$Account,
    [string]$Project = 'fairground-sealer',
    [string]$Wasm,
    [string]$Sha256,
    [switch]$SkipLogin,
    [switch]$Execute
)

. (Join-Path $PSScriptRoot '_common.ps1')
if (-not $Wasm) { $Wasm = Get-DefaultJobWasm }

$net = Get-DeployNetwork $Network
Assert-AccountId $Account '-Account'
if ($Project -cnotmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw "-Project '$Project' is not a simple project name." }
$sha = Get-JobSha256 -Wasm $Wasm -Sha256 $Sha256
$projectId = "$Account/$Project"
# The URL `outlayer upload` prints: https://<host>/<sender>/<receiver>/<sha256>.<ext>
# (outlayer-cli 0.2.2 src/commands/upload.rs:148-186; receiver defaults to the OutLayer contract).
$url = "https://$($net.fastfsHost)/$Account/$($net.outlayerContract)/$sha.wasm"
$wasmPath = $Wasm
if (Test-Path -LiteralPath $Wasm) { $wasmPath = (Resolve-Path -LiteralPath $Wasm).Path }

$versionArgs = New-JsonFile -Network $Network -OutName 'get-version.json' -Object ([ordered]@{
    project_id = $projectId; version_key = $sha
})
$deleteArgs = New-JsonFile -Network $Network -OutName 'delete-project.json' -Object ([ordered]@{ project_name = $Project })

$plan = New-Plan
if (-not $SkipLogin) {
    Add-Command $plan 'Log the OutLayer CLI in (once per machine; prompts for the account id and its ed25519 private key)' `
        'outlayer' @('login', $Network) `
        -Expect "Export the key with: near account export-account $Account using-private-key network-config $($net.nearCliNetwork)`nThe CLI stores it in plain text in ~/.outlayer/$Network/credentials.json."
}
Add-Command $plan 'Check who the CLI signs as' 'outlayer' @('whoami') -Expect "Account: $Account, network: $Network"
Add-Command $plan 'Upload the job to FastFS' 'outlayer' @('upload', $wasmPath) -Signs `
    -Expect "SHA256: $sha`nFastFS URL: $url`nThe upload transaction fails with 'Exceeded the prepaid gas' ON PURPOSE (docs/CLI.md:362): FastFS indexes the arguments."
Add-Note $plan 'Wait until FastFS serves the file, then check its bytes' `
    ("Invoke-WebRequest -UseBasicParsing -Uri '$url' -OutFile job.wasm; (Get-FileHash job.wasm -Algorithm SHA256).Hash.ToLower()`n" +
     "must print $sha. A 404 means the indexer has not picked it up yet; retry in a minute.")
Add-Check $plan 'Check the FastFS bytes' {
    $tmp = [IO.Path]::GetTempFileName()
    try {
        for ($i = 1; $i -le 20; $i++) {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
                break
            } catch {
                if ($i -eq 20) { throw "FastFS still does not serve $url : $_" }
                Write-Host "Not served yet ($i/20); waiting 15 s..."
                Start-Sleep -Seconds 15
            }
        }
        $got = Get-Sha256Hex -Bytes ([IO.File]::ReadAllBytes($tmp))
        if ($got -ne $sha) { throw "FastFS serves $got, expected $sha." }
        Write-Host "FastFS serves the expected bytes ($sha)."
    } finally {
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
}
Add-Command $plan "Create the project $projectId (or add this version to it)" 'outlayer' `
    @('deploy', $Project, $url, '--hash', $sha, '--target', 'wasm32-wasip1') -Signs `
    -Expect "First run: create_project. Later runs: add_version, made active (pass --no-activate to keep the old one active;`nthe contract pins version_key, so the active flag does not matter to it). 0.1 NEAR attached, the unused part is refunded."
Add-Command $plan 'Read the version back' 'near' `
    @('contract', 'call-function', 'as-read-only', $net.outlayerContract, 'get_version', 'file-args', $versionArgs,
      'network-config', $net.nearCliNetwork, 'now') `
    -Expect ("{ wasm_hash: `"$sha`", source: { WasmUrl: { url: `"$url`", hash: `"$sha`", build_target: `"wasm32-wasip1`" } }, ... }`n" +
             "build_target MUST be wasm32-wasip1. A version cannot be re-added under the same hash (`"Version ... already exists`"),`n" +
             "so if it says wasm32-wasip2 and nothing pins it yet, delete the project and deploy again (no new upload needed):`n" +
             "  near contract call-function as-transaction $($net.outlayerContract) delete_project file-args '$deleteArgs' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $Account network-config $($net.nearCliNetwork) sign-with-keychain send")

$preamble = Write-Preamble $net $Account "# Job: $wasmPath`n# sha256 (the version_key every later step pins): $sha"
if ($Execute) {
    $env:OUTLAYER_NETWORK = $Network
    Invoke-Plan $plan $Network
} else {
    $preamble += "`$env:OUTLAYER_NETWORK = '$Network'   # outlayer CLI: the network for every command below (docs/CLI.md:88-96)"
    Show-Plan $plan $preamble
}
