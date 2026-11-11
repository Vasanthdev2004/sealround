<#
.SYNOPSIS
Starts, stops or resets the local NEAR sandbox node the integration tests use.

.DESCRIPTION
The sandbox binary only runs on Linux with glibc >= 2.39, so it runs in a
long-lived Docker container (debian:trixie-slim) while the tests run natively
on Windows and connect over RPC.

- The binary (nearcore sandbox, default 2.14.0) is cached in .sandbox-bin and
  mounted read-only into the container. It is downloaded once if missing.
- The chain lives inside the container and lasts as long as the container
  runs. A running container is reused; anything else starts a fresh chain.
  A stopped chain is never restarted: the tests' fast_forward calls leave its
  block time hours ahead of the wall clock, and a restarted node only adds a
  nanosecond per block until its own forwards catch up, which stalls every
  test that waits for a sale window. Every test makes fresh accounts, so
  nothing needs the old chain.
- A running container must match -Port and -Version; if it does not, the
  script says so and stops (use -Reset to replace it).
- The validator key is copied to .sandbox-home\validator_key.json; tests sign
  with it as the root account (ValidatorKey::HomeDir).

Prints the RPC address and the home directory. When called with `&` from
another script, it also sets NEAR_SANDBOX_RPC and NEAR_SANDBOX_HOME in that
process. Exits non-zero on any failure.

.PARAMETER Stop
Removes the container and its chain. The next start begins a fresh chain.

.PARAMETER Reset
Removes the container and its chain, then starts a fresh one.

.PARAMETER Port
Host port for the RPC (bound to 127.0.0.1). Default 3030.

.PARAMETER Version
nearcore sandbox version. Default 2.14.0.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\sandbox.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\sandbox.ps1 -Reset

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\sandbox.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$Reset,
    [int]$Port = 3030,
    [string]$Version = '2.14.0',
    [string]$Image = 'debian:trixie-slim',
    [string]$Name = 'fairground-sandbox'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $repoRoot ".sandbox-bin\$Version"
$bin = Join-Path $binDir 'Linux-x86_64\near-sandbox'
$homeDir = Join-Path $repoRoot '.sandbox-home'
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
    Write-Host "sandbox: $Message" -ForegroundColor Red
    exit 1
}

# "running", "exited", "created", ... or $null when there is no such container.
function Get-ContainerState {
    $r = Invoke-Docker @('inspect', '--format', '{{.State.Status}}', $Name)
    if ($r.ExitCode -ne 0) { return $null }
    return ($r.Lines | Select-Object -First 1).Trim()
}

# The container's RPC host port and the host folder mounted as /opt/sbx (the
# binary, which names the version), as docker reports them. This script makes
# exactly one port binding and one mount, so the template needs no quotes
# (PowerShell 5.1 mangles quotes in native arguments).
function Get-ContainerSetup {
    $format = '{{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}}{{end}}{{end}}|{{range .Mounts}}{{.Source}}{{end}}'
    $r = Invoke-Docker @('inspect', '--format', $format, $Name)
    if ($r.ExitCode -ne 0) { Fail "docker inspect failed: $($r.Lines -join ' ')" }
    $parts = (($r.Lines | Select-Object -First 1).Trim()) -split '\|', 2
    [pscustomobject]@{ Port = $parts[0]; BinDir = $parts[1] }
}

function Remove-Container {
    param([string]$Why)
    $r = Invoke-Docker @('rm', '-f', $Name)
    if ($r.ExitCode -ne 0) { Fail "docker rm failed: $($r.Lines -join ' ')" }
    Write-Host "sandbox: removed $Name and its chain ($Why)"
}

function Test-Rpc {
    $body = '{"jsonrpc":"2.0","id":"0","method":"status","params":[]}'
    try {
        $status = Invoke-RestMethod -Uri $rpc -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 2
        return [bool]$status.result
    } catch {
        return $false
    }
}

if ((Invoke-Docker @('version', '--format', '{{.Server.Version}}')).ExitCode -ne 0) {
    Fail 'Docker is not running (docker version failed). Start Docker Desktop and retry.'
}

$state = Get-ContainerState
if ($Stop) {
    if ($state) {
        Remove-Container 'the next start begins a fresh chain'
    } else {
        Write-Host "sandbox: $Name is not there; nothing to stop"
    }
    exit 0
}

if ($state -and $Reset) {
    Remove-Container '-Reset'
    $state = $null
} elseif ($state -and $state -ne 'running') {
    # Never restart a stopped chain: its clock would freeze (see DESCRIPTION).
    Remove-Container "it was $state; a restarted chain's clock lags its blocks"
    $state = $null
}

$wantBinDir = Split-Path $bin
if ($state -eq 'running') {
    $setup = Get-ContainerSetup
    $samePort = $setup.Port -eq "$Port"
    $sameBin = [string]::Equals($setup.BinDir.TrimEnd('\', '/'), $wantBinDir.TrimEnd('\', '/'),
        [System.StringComparison]::OrdinalIgnoreCase)
    if (-not ($samePort -and $sameBin)) {
        Fail ("$Name is running with RPC port $($setup.Port) and binary $($setup.BinDir), " +
            "not port $Port and $wantBinDir. Use those values, or pass -Reset to replace it " +
            "(its chain is discarded), or -Stop to remove it.")
    }
}

if (-not (Test-Path $bin)) {
    New-Item -ItemType Directory -Force $binDir | Out-Null
    $tgz = Join-Path $binDir 'near-sandbox.tar.gz'
    $url = "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/$Version/near-sandbox.tar.gz"
    Write-Host "sandbox: downloading $url"
    & curl.exe -sSfL -o $tgz $url
    if ($LASTEXITCODE -ne 0) { Fail "download failed: $url" }
    # Windows bsdtar: Git's GNU tar reads "C:" in a path as a remote host.
    & "$env:SystemRoot\System32\tar.exe" -xzf $tgz -C $binDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $bin)) { Fail "could not extract $tgz" }
    Remove-Item $tgz
}

if ($state -eq 'running') {
    Write-Host "sandbox: $Name is already running"
} else {
    $command = '[ -f /data/genesis.json ] || /opt/sbx/near-sandbox --home /data init --fast; ' +
        'exec /opt/sbx/near-sandbox --home /data run --rpc-addr 0.0.0.0:3030 --network-addr 0.0.0.0:3031'
    $r = Invoke-Docker @(
        'run', '-d', '--name', $Name, '-p', "127.0.0.1:${Port}:3030",
        '-v', "${wantBinDir}:/opt/sbx:ro", $Image, 'sh', '-c', $command
    )
    if ($r.ExitCode -ne 0) {
        Invoke-Docker @('rm', '-f', $Name) | Out-Null
        Fail ("docker run failed: $($r.Lines -join ' ')`n" +
            "Is port $Port taken by another container? Pass -Port or stop it (docker ps).")
    }
    Write-Host "sandbox: started $Name (fresh chain)"
}

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    if (Test-Rpc) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    (Invoke-Docker @('logs', '--tail', '30', $Name)).Lines | ForEach-Object { Write-Host $_ }
    Fail "RPC not ready at $rpc after 60 s"
}

New-Item -ItemType Directory -Force $homeDir | Out-Null
$keyFile = Join-Path $homeDir 'validator_key.json'
$r = Invoke-Docker @('cp', "${Name}:/data/validator_key.json", $keyFile)
if ($r.ExitCode -ne 0) { Fail "could not copy validator_key.json: $($r.Lines -join ' ')" }

$env:NEAR_SANDBOX_RPC = $rpc
$env:NEAR_SANDBOX_HOME = $homeDir
Write-Host "sandbox: ready at $rpc (nearcore sandbox $Version); validator key in $keyFile"
exit 0
