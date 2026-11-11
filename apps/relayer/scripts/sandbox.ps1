<#
.SYNOPSIS
Starts or removes the relayer's own local NEAR sandbox node.

.DESCRIPTION
Runs the nearcore sandbox (Linux binary, glibc >= 2.39) in a Docker container
named near-sandbox-relayer, with its RPC on 127.0.0.1:3040. It is separate from
the contracts sandbox (scripts\sandbox.ps1, port 3030), so both can run at once.

Every start begins a fresh chain: any old container of this name is removed
first. The validator key (the sandbox root account, test.near) is copied to
apps\relayer\.sandbox-home\validator_key.json for the integration tests.

.PARAMETER Stop
Removes the container and its chain.

.PARAMETER SandboxBin
Path to the Linux near-sandbox binary. Default: the repo's cached
.sandbox-bin\2.14.0\Linux-x86_64\near-sandbox (scripts\sandbox.ps1 downloads it).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File apps\relayer\scripts\sandbox.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File apps\relayer\scripts\sandbox.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [int]$Port = 3040,
    [string]$Name = 'near-sandbox-relayer',
    [string]$Image = 'debian:trixie-slim',
    [string]$SandboxBin = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $appDir)
$homeDir = Join-Path $appDir '.sandbox-home'
$rpc = "http://127.0.0.1:$Port"

# Runs docker with stderr merged, so PowerShell 5.1 does not turn its progress
# output into errors. Returns the exit code and the output lines.
function Invoke-Docker {
    param([string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}

function Fail {
    param([string]$Message)
    Write-Host "relayer sandbox: $Message" -ForegroundColor Red
    exit 1
}

# Removing a container that does not exist is fine; any other failure is not.
$removed = Invoke-Docker @('rm', '-f', $Name)
if ($removed.ExitCode -ne 0 -and ($removed.Lines -join ' ') -notmatch 'No such container') {
    Fail "could not remove ${Name}: $($removed.Lines -join ' ')"
}
if ($Stop) {
    Write-Host "relayer sandbox: removed $Name"
    exit 0
}

if (-not $SandboxBin) { $SandboxBin = Join-Path $repoRoot '.sandbox-bin\2.14.0\Linux-x86_64\near-sandbox' }
if (-not (Test-Path $SandboxBin)) {
    Fail "no sandbox binary at $SandboxBin (run scripts\sandbox.ps1 once to download it, or pass -SandboxBin)"
}
$binDir = Split-Path -Parent (Resolve-Path $SandboxBin)
$binName = Split-Path -Leaf $SandboxBin

$run = Invoke-Docker @(
    'run', '-d', '--name', $Name, '-p', "127.0.0.1:${Port}:3030",
    '-v', "${binDir}:/opt/sbx:ro", $Image,
    'sh', '-c', "/opt/sbx/$binName --home /data init --fast && exec /opt/sbx/$binName --home /data run --rpc-addr 0.0.0.0:3030 --network-addr 0.0.0.0:3031"
)
if ($run.ExitCode -ne 0) { Fail "docker run failed: $($run.Lines -join ' ')" }

$status = '{"jsonrpc":"2.0","id":"0","method":"status","params":[]}'
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    try {
        $answer = Invoke-RestMethod -Uri $rpc -Method Post -ContentType 'application/json' -Body $status -TimeoutSec 2
        if ($answer.result.sync_info.latest_block_height -gt 1) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    $logs = Invoke-Docker @('logs', '--tail', '30', $Name)
    Fail "RPC not ready at $rpc`n$($logs.Lines -join "`n")"
}

New-Item -ItemType Directory -Force $homeDir | Out-Null
$keyFile = Join-Path $homeDir 'validator_key.json'
$copy = Invoke-Docker @('cp', "${Name}:/data/validator_key.json", $keyFile)
if ($copy.ExitCode -ne 0) { Fail "could not copy validator_key.json: $($copy.Lines -join ' ')" }

Write-Host "relayer sandbox: $Name ready at $rpc; validator key in $keyFile"
