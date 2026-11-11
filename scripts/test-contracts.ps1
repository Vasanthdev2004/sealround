<#
.SYNOPSIS
Builds every contract, runs the Rust unit tests, and runs the sandbox
integration tests. Exits non-zero if anything fails.

.DESCRIPTION
1. scripts\build-contracts.ps1: token, mock-ft, fairground into contracts\res.
2. cargo test --workspace --no-fail-fast: the unit tests of every crate and
   contract (all of them run even if one fails).
3. scripts\sandbox.ps1: makes sure the sandbox node is up (Docker). A running
   node is reused; a stopped one is replaced by a fresh chain (a restarted
   chain's clock would stall the tests).
4. The integration tests in contracts\tests (their own Cargo workspace), run
   natively against the node, one test at a time.
5. With -Gas, the gas calibration too (100, 300 and 500 worst-case TEE bids,
   and 500 commit-reveal bids twice: a usual book and the longest price
   search; about 12 minutes). Its numbers are what
   contracts\GAS.md records.

Prints a summary with the pass and fail counts of each stage.

.PARAMETER SkipBuild
Use the wasm already in contracts\res.

.PARAMETER SkipUnit
Skip the workspace unit tests.

.PARAMETER Filter
Only integration tests whose name contains this text.

.PARAMETER Gas
Also run the gas calibration.

.PARAMETER StopSandbox
Remove the sandbox container at the end (the next run starts a fresh chain).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\test-contracts.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\test-contracts.ps1 -SkipBuild -SkipUnit -Filter refund

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\test-contracts.ps1 -Gas
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipUnit,
    [string]$Filter = '',
    [switch]$Gas,
    [switch]$StopSandbox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$testsManifest = Join-Path $repoRoot 'contracts\tests\Cargo.toml'
$port = 3030

# Runs a native command with stderr merged into its output (PowerShell 5.1
# would turn native stderr into errors), echoing each line. Returns the exit
# code and the lines, without colour codes.
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments)
    $lines = New-Object System.Collections.Generic.List[string]
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
            $line = $line -replace "\x1b\[[0-9;]*m", ''
            $lines.Add($line)
            Write-Host $line
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}

# Sums the "test result:" lines of a cargo test run.
function Get-TestCounts {
    param($Lines)
    $counts = [ordered]@{ Passed = 0; Failed = 0; Ignored = 0 }
    foreach ($line in $Lines) {
        if ($line -match 'test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored') {
            $counts.Passed += [int]$Matches[1]
            $counts.Failed += [int]$Matches[2]
            $counts.Ignored += [int]$Matches[3]
        }
    }
    [pscustomobject]$counts
}

function Write-Stage {
    param([string]$Name)
    Write-Host ''
    Write-Host "==> $Name" -ForegroundColor Cyan
}

$summary = New-Object System.Collections.Generic.List[string]
$failed = $false

Push-Location $repoRoot
try {
    if (-not $SkipBuild) {
        Write-Stage 'build contracts'
        $r = Invoke-Native 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-contracts.ps1'))
        if ($r.ExitCode -ne 0) {
            $summary.Add('build: FAILED')
            throw 'contract build failed; nothing else was run'
        }
        $summary.Add('build: ok')
    }

    $env:AWS_LC_SYS_PREBUILT_NASM = '1'
    if (-not $SkipUnit) {
        Write-Stage 'unit tests (cargo test --workspace --no-fail-fast)'
        $r = Invoke-Native 'cargo' @('test', '--workspace', '--no-fail-fast')
        $c = Get-TestCounts $r.Lines
        $summary.Add("unit tests: $($c.Passed) passed, $($c.Failed) failed, $($c.Ignored) ignored (exit $($r.ExitCode))")
        if ($r.ExitCode -ne 0 -or $c.Failed -gt 0) { $failed = $true }
    }

    Write-Stage 'sandbox'
    $r = Invoke-Native 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'sandbox.ps1'), '-Port', "$port")
    if ($r.ExitCode -ne 0) {
        $summary.Add('sandbox: FAILED')
        throw 'the sandbox did not start'
    }

    # near-workspaces: never download a sandbox binary (the node runs in Docker).
    $env:NEAR_SANDBOX_BIN_PATH = 'C:\nonexistent\near-sandbox'
    $env:NEAR_SANDBOX_RPC = "http://127.0.0.1:$port"
    $env:NEAR_SANDBOX_HOME = Join-Path $repoRoot '.sandbox-home'

    Write-Stage 'integration tests (contracts\tests, sandbox)'
    $cargoArgs = @('test', '--manifest-path', $testsManifest, '--test', 'sandbox', '--', '--test-threads=1')
    if ($Filter) { $cargoArgs += $Filter }
    $r = Invoke-Native 'cargo' $cargoArgs
    $c = Get-TestCounts $r.Lines
    $summary.Add("integration tests: $($c.Passed) passed, $($c.Failed) failed, $($c.Ignored) ignored (exit $($r.ExitCode))")
    if ($r.ExitCode -ne 0 -or $c.Failed -gt 0 -or $c.Passed -eq 0) { $failed = $true }

    if ($Gas) {
        Write-Stage 'gas calibration (100 / 300 / 500 worst-case TEE bids, 500 commit-reveal bids twice)'
        $cargoArgs = @('test', '--manifest-path', $testsManifest, '--test', 'sandbox', '--',
            '--ignored', '--test-threads=1', '--nocapture', 'gas::')
        $r = Invoke-Native 'cargo' $cargoArgs
        $c = Get-TestCounts $r.Lines
        $summary.Add("gas calibration: $($c.Passed) passed, $($c.Failed) failed (exit $($r.ExitCode))")
        if ($r.ExitCode -ne 0 -or $c.Failed -gt 0 -or $c.Passed -eq 0) { $failed = $true }
    }
} catch {
    Write-Host "test-contracts: $($_.Exception.Message)" -ForegroundColor Red
    $failed = $true
} finally {
    Pop-Location
    if ($StopSandbox) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'sandbox.ps1') -Stop | Out-Host
    }
}

Write-Host ''
Write-Host '==> summary' -ForegroundColor Cyan
foreach ($line in $summary) { Write-Host "  $line" }
if ($failed) {
    Write-Host 'test-contracts: FAILED' -ForegroundColor Red
    exit 1
}
Write-Host 'test-contracts: all passed' -ForegroundColor Green
exit 0
