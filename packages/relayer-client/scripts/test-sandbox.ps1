<#
.SYNOPSIS
Runs the relayer client's end-to-end tests against a fresh local sandbox, then removes it.

.DESCRIPTION
Starts the relayer's own sandbox (apps\relayer\scripts\sandbox.ps1: Docker
container near-sandbox-relayer, RPC on 127.0.0.1:3040, validator key copied to
apps\relayer\.sandbox-home), runs test\sandbox.test.ts with
RELAYER_CLIENT_SANDBOX_RPC and RELAYER_CLIENT_SANDBOX_KEY set, and removes the
container whether the tests pass or not. Exits with the tests' exit code.

.PARAMETER SandboxBin
Passed on to sandbox.ps1.

.EXAMPLE
pnpm --filter @fairground/relayer-client test:sandbox
#>
[CmdletBinding()]
param([string]$SandboxBin = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$packageDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $packageDir)
$sandbox = Join-Path $repoRoot 'apps\relayer\scripts\sandbox.ps1'
$port = 3040

$start = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sandbox, '-Port', $port)
# PowerShell 5.1 drops empty arguments to native commands, so pass -SandboxBin only when set.
if ($SandboxBin) { $start += @('-SandboxBin', $SandboxBin) }
& powershell @start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$code = 1
try {
    $env:RELAYER_CLIENT_SANDBOX_RPC = "http://127.0.0.1:$port"
    $env:RELAYER_CLIENT_SANDBOX_KEY = Join-Path $repoRoot 'apps\relayer\.sandbox-home\validator_key.json'
    Push-Location $packageDir
    try {
        & pnpm exec vitest run test/sandbox.test.ts
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $sandbox -Port $port -Stop
}
exit $code
