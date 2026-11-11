<#
.SYNOPSIS
Runs the relayer's integration tests against a fresh local sandbox, then removes it.

.DESCRIPTION
Starts near-sandbox-relayer (scripts\sandbox.ps1), runs test\sandbox.test.ts with
RELAYER_SANDBOX_RPC and RELAYER_SANDBOX_KEY set, and removes the container
whether the tests pass or not. Exits with the tests' exit code.

.PARAMETER SandboxBin
Passed on to sandbox.ps1.

.EXAMPLE
pnpm --filter @fairground/relayer test:sandbox
#>
[CmdletBinding()]
param([string]$SandboxBin = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path $PSScriptRoot 'sandbox.ps1'
$port = 3040

$start = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sandbox, '-Port', $port)
# PowerShell 5.1 drops empty arguments to native commands, so pass -SandboxBin only when set.
if ($SandboxBin) { $start += @('-SandboxBin', $SandboxBin) }
& powershell @start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$code = 1
try {
    $env:RELAYER_SANDBOX_RPC = "http://127.0.0.1:$port"
    $env:RELAYER_SANDBOX_KEY = Join-Path $appDir '.sandbox-home\validator_key.json'
    Push-Location $appDir
    try {
        & pnpm exec vitest run test/sandbox.test.ts
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $sandbox -Stop
}
exit $code
