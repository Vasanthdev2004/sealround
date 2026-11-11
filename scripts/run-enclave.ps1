<#
.SYNOPSIS
Runs the Fairground enclave job (the OutLayer job) locally, the way OutLayer's
worker runs it, and prints its output, instructions and time.

.DESCRIPTION
Runs a job module with enclave/tools/runner (fairground-runner), building the
runner first. The runner copies the worker's WASI P1 path: wasmtime 28.0.1
with fuel metering, stdin = the input, the worker's environment for an
on-chain run (OUTLAYER_EXECUTION_TYPE=NEAR, NEAR_PREDECESSOR_ID=-Predecessor,
NEAR_SENDER_ID=alice.testnet, ...) plus PROTECTED_FAIRGROUND_MASTER=-Master,
and the request's resource limits.

Which module: -Wasm if given; else enclave\res\fairground_sealer.wasm, the
Docker build (scripts\build-enclave.ps1) whose sha256 OutLayer and the
contract pin; -Native (or no res build yet) builds the job natively and runs
enclave\target\wasm32-wasip1\release\fairground-sealer.wasm instead. Both
answer alike, but only the Docker build is the module that gets deployed.

The output is saved byte for byte (-OutFile, default
enclave\target\run-enclave\output.json) and printed. The script then prints the
instructions against OutLayer's default limit of 1e9, and the time against the
60 s default and the ~117 s yield window. Exits 0 if the run succeeded as the
worker would count it, 1 otherwise. The job's own refusals fail the run (exit
status 1) with "fairground-sealer: refused: <code>" on stderr, shown as
"job stderr".

-WasiTest runs the module with OutLayer's own wasi-test-runner instead (build
it from wasi-examples/wasi-test-runner in fastnear/near-outlayer). It prints the
same instruction count; the time it shows is the whole process, measured here.

-Fixtures writes sample inputs to enclave\target\fixtures (sealed with a TEST
master). -Test builds everything natively and runs the enclave's tests, then
runs the wasm tests again on enclave\res\fairground_sealer.wasm when it
exists, so the artifact that is deployed is tested too.

Never pass a real master secret: it ends up on a command line. The fixtures'
TEST master is 6661697267726f756e642054455354206d61737465722c206e6f74207265616c.

.PARAMETER Input
The request's input_data: a file holding the JSON the contract sends.

.PARAMETER Master
PROTECTED_FAIRGROUND_MASTER, 64 hex digits. A TEST value only. An empty string
leaves the variable unset (the job refuses the run: missing_master).

.PARAMETER Predecessor
NEAR_PREDECESSOR_ID: the contract that called OutLayer. The signer
(NEAR_SENDER_ID) is alice.testnet; pass -Predecessor alice.testnet to see the
job refuse a clear the contract account signed itself (signer_is_contract).

.PARAMETER Wasm
The module to run. Default: enclave\res\fairground_sealer.wasm (see -Native).

.PARAMETER Native
Build the job natively and run that build instead of the Docker one.

.PARAMETER MaxInstructions
resource_limits.max_instructions. Default 1e9, OutLayer's default. OutLayer
allows up to 500e9; see enclave\PERF.md for what a clear needs.

.PARAMETER MaxExecutionSeconds
resource_limits.max_execution_seconds. Default 60, OutLayer's default.

.PARAMETER Expected
A file the output must equal byte for byte (fixtures come with
<name>.expected.json, the native fairground_sealer::run answer).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Fixtures

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Input enclave\target\fixtures\clear-500.json -Master 6661697267726f756e642054455354206d61737465722c206e6f74207265616c -Predecessor fairground.testnet -MaxInstructions 10000000000 -Expected enclave\target\fixtures\clear-500.expected.json

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\run-enclave.ps1 -Test
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    # Named InputFile because $input is a PowerShell automatic variable; -Input works.
    [Parameter(ParameterSetName = 'Run', Mandatory = $true)]
    [Alias('Input')]
    [string]$InputFile,
    [Parameter(ParameterSetName = 'Run', Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Master,
    [Parameter(ParameterSetName = 'Run', Mandatory = $true)]
    [string]$Predecessor,
    [Parameter(ParameterSetName = 'Run')]
    [string]$Wasm,
    [Parameter(ParameterSetName = 'Run')]
    [switch]$Native,
    [Parameter(ParameterSetName = 'Run')]
    [uint64]$MaxInstructions = 1000000000,
    [Parameter(ParameterSetName = 'Run')]
    [uint64]$MaxExecutionSeconds = 60,
    [Parameter(ParameterSetName = 'Run')]
    [string]$OutFile,
    [Parameter(ParameterSetName = 'Run')]
    [string]$Expected,
    [Parameter(ParameterSetName = 'Run')]
    [string]$WasiTest,

    [Parameter(ParameterSetName = 'Fixtures', Mandatory = $true)]
    [switch]$Fixtures,
    [Parameter(ParameterSetName = 'Fixtures')]
    [int[]]$Sizes = @(1, 50, 500, 1000),

    [Parameter(ParameterSetName = 'Test', Mandatory = $true)]
    [switch]$Test
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$enclave = Join-Path $repoRoot 'enclave'
$nativeWasm = Join-Path $enclave 'target\wasm32-wasip1\release\fairground-sealer.wasm'
# The Docker build (scripts\build-enclave.ps1): the module OutLayer runs.
$deployedWasm = Join-Path $enclave 'res\fairground_sealer.wasm'
$runnerExe = Join-Path $enclave 'target\tools\fairground-runner.exe'
$fixturesExe = Join-Path $enclave 'target\tools\fairground-fixtures.exe'
# OutLayer's limits (contract lib.rs, live get_max_limits) and the yield window
# (200 blocks at ~0.585 s).
$defaultMaxInstructions = 1000000000
$yieldWindowSeconds = 117

# Runs a native command with stderr merged into its output. Native tools write
# progress to stderr, which PowerShell 5.1 would otherwise turn into terminating
# errors. Returns the exit code and every output line, without colour codes.
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments, [switch]$Quiet)
    $lines = New-Object System.Collections.Generic.List[string]
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
            $line = $line -replace "\x1b\[[0-9;]*m", ''
            $lines.Add($line)
            if (-not $Quiet) { Write-Host $line }
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}

# cargo in enclave/: rust-toolchain.toml there pins the compiler, and rustup
# finds it from the current directory, not from the manifest.
function Invoke-Cargo {
    param([string[]]$Arguments, [string]$What)
    Write-Host "==> $What" -ForegroundColor Cyan
    Push-Location $enclave
    try {
        $result = Invoke-Native 'cargo' $Arguments
    } finally {
        Pop-Location
    }
    if ($result.ExitCode -ne 0) { throw "$What failed (cargo exit $($result.ExitCode))" }
}

function Build-Job {
    Invoke-Cargo @('build', '--release', '--target', 'wasm32-wasip1', '-p', 'fairground-sealer-job') 'build the job (wasm32-wasip1, release)'
}

function Build-Tools {
    Invoke-Cargo @('build', '--profile', 'tools', '-p', 'fairground-runner', '-p', 'fairground-harness') 'build the runner and fixtures tools'
}

function Format-Count([uint64]$n) { $n.ToString('N0', [Globalization.CultureInfo]::InvariantCulture) }

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-Existing([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$What not found: $Path" }
    (Resolve-Path -LiteralPath $Path).Path
}

try {
    if ($PSCmdlet.ParameterSetName -eq 'Test') {
        Build-Job
        Build-Tools
        $env:FAIRGROUND_JOB_WASM = $null
        Invoke-Cargo @('test', '--locked', '--workspace', '--', '--nocapture') "test the enclave workspace (wasm tests on the native build, sha256 $(Get-Sha256 $nativeWasm))"
        if (Test-Path -LiteralPath $deployedWasm -PathType Leaf) {
            # The wasm tests again, on the module that is deployed. A failure
            # here and not above means enclave\res is older than the sources:
            # rebuild it with scripts\build-enclave.ps1.
            $env:FAIRGROUND_JOB_WASM = $deployedWasm
            try {
                Invoke-Cargo @('test', '--locked', '-p', 'fairground-harness', '--test', 'wasm', '--', '--nocapture') "test the deployed module enclave\res\fairground_sealer.wasm (sha256 $(Get-Sha256 $deployedWasm))"
            } finally {
                $env:FAIRGROUND_JOB_WASM = $null
            }
        } else {
            Write-Host "No $deployedWasm yet: build it with scripts\build-enclave.ps1, then run -Test again to test it too." -ForegroundColor Yellow
        }
        Write-Host 'All enclave tests passed.' -ForegroundColor Green
        exit 0
    }

    if ($PSCmdlet.ParameterSetName -eq 'Fixtures') {
        Build-Tools
        $out = Join-Path $enclave 'target\fixtures'
        $arguments = @('--out', $out) + @($Sizes | ForEach-Object { "$_" })
        $result = Invoke-Native $fixturesExe $arguments
        if ($result.ExitCode -ne 0) { throw "fairground-fixtures failed (exit $($result.ExitCode))" }
        exit 0
    }

    # Run.
    $inputPath = Resolve-Existing $InputFile 'input file'
    if ($Wasm) {
        if ($Native) { throw '-Wasm and -Native exclude each other' }
        $wasmPath = Resolve-Existing $Wasm 'wasm module'
    } elseif (-not $Native -and (Test-Path -LiteralPath $deployedWasm -PathType Leaf)) {
        $wasmPath = (Resolve-Path -LiteralPath $deployedWasm).Path
        Write-Host 'Running the Docker build in enclave\res (what OutLayer runs); -Native runs a native build of the current sources.' -ForegroundColor DarkGray
    } else {
        if (-not $Native) { Write-Host "No $deployedWasm (scripts\build-enclave.ps1 makes it): running a native build" -ForegroundColor Yellow }
        Build-Job
        $wasmPath = $nativeWasm
    }
    if (-not $WasiTest) {
        # A no-op when nothing changed. Always both tools together: building one
        # alone resolves shared dependencies' features differently and rebuilds them.
        Build-Tools
    }
    if (-not $OutFile) {
        $outDir = Join-Path $enclave 'target\run-enclave'
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        $OutFile = Join-Path $outDir 'output.json'
    }
    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

    $wasmItem = Get-Item -LiteralPath $wasmPath
    $wasmHash = (Get-FileHash -LiteralPath $wasmPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $inputBytes = (Get-Item -LiteralPath $inputPath).Length
    Write-Host ''
    Write-Host "module:       $($wasmItem.FullName)"
    Write-Host "              $(Format-Count $wasmItem.Length) bytes, sha256 $wasmHash"
    Write-Host "input:        $inputPath ($(Format-Count $inputBytes) bytes)"
    $masterNote = if ($Master) { "$($Master.Length) characters, not shown" } else { 'unset' }
    Write-Host "environment:  on-chain run from $Predecessor; PROTECTED_FAIRGROUND_MASTER $masterNote"
    Write-Host "limits:       $(Format-Count $MaxInstructions) instructions, $MaxExecutionSeconds s"

    $report = @{}
    if ($WasiTest) {
        # OutLayer's runner: no --near, so pass the variables the job reads.
        $wasiTestPath = Resolve-Existing $WasiTest 'wasi-test runner'
        $arguments = @('--wasm', $wasmPath, '--input-file', $inputPath, '--max-instructions', "$MaxInstructions",
            '--env', 'OUTLAYER_EXECUTION_TYPE=NEAR', '--env', "NEAR_PREDECESSOR_ID=$Predecessor")
        if ($Master) { $arguments += @('--env', "PROTECTED_FAIRGROUND_MASTER=$Master") }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $result = Invoke-Native $wasiTestPath $arguments -Quiet
        $clock.Stop()
        # wasi-test prints the output after a line "Output:", plus a newline of its own.
        $at = $result.Lines.IndexOf('Output:')
        if ($at -ge 0 -and $at + 1 -lt $result.Lines.Count) {
            [IO.File]::WriteAllText($OutFile, $result.Lines[$at + 1], (New-Object Text.UTF8Encoding($false)))
        }
        $fuel = $result.Lines | Where-Object { $_ -match 'Fuel consumed: (\d+)' } | Select-Object -First 1
        $report['result'] = if ($result.ExitCode -eq 0) { 'succeeded' } else { "failed: " + (($result.Lines | Where-Object { $_ -like 'Error:*' }) -join ' ') }
        if ($fuel -and $fuel -match 'Fuel consumed: (\d+)') { $report['instructions'] = $Matches[1] }
        $report['process_ms'] = '{0:N1}' -f $clock.Elapsed.TotalMilliseconds
    } else {
        $arguments = @('--wasm', $wasmPath, '--input', $inputPath, '--out', $OutFile, '--near', $Predecessor,
            '--max-instructions', "$MaxInstructions", '--max-execution-seconds', "$MaxExecutionSeconds")
        if ($Master) { $arguments += @('--env', "PROTECTED_FAIRGROUND_MASTER=$Master") }
        $result = Invoke-Native $runnerExe $arguments -Quiet
        foreach ($line in $result.Lines) {
            if ($line -match '^([a-z_]+): (.*)$') { $report[$Matches[1]] = $Matches[2] }
        }
        if ($result.ExitCode -eq 2 -or -not $report.ContainsKey('result')) {
            throw "the runner could not run the module: $($result.Lines -join ' | ')"
        }
    }

    Write-Host ''
    if (Test-Path -LiteralPath $OutFile) {
        $output = [IO.File]::ReadAllText($OutFile)
        $shown = if ($output.Length -gt 1500) { $output.Substring(0, 1500) + ' ...' } else { $output }
        Write-Host "output ($(Format-Count ([IO.File]::ReadAllBytes($OutFile).Length)) bytes, saved to $OutFile):" -ForegroundColor Cyan
        Write-Host $shown
    } else {
        Write-Host 'output: none' -ForegroundColor Yellow
    }
    Write-Host ''

    $succeeded = $report['result'] -eq 'succeeded'
    $colour = if ($succeeded) { 'Green' } else { 'Red' }
    # The run's result (would the worker deliver the output?), then the answer's.
    Write-Host "result:       $($report['result'])" -ForegroundColor $colour
    if ($succeeded -and (Test-Path -LiteralPath $OutFile)) {
        try {
            $answer = [IO.File]::ReadAllText($OutFile) | ConvertFrom-Json
            if ($answer.ok) {
                Write-Host "answer:       ok, op $($answer.op)" -ForegroundColor Green
            } else {
                Write-Host "answer:       ok:false, error $($answer.error)" -ForegroundColor Yellow
            }
        } catch {
            Write-Host 'answer:       not JSON' -ForegroundColor Red
        }
    }
    if ($report.ContainsKey('stderr')) { Write-Host "job stderr:   $($report['stderr'])" -ForegroundColor Yellow }
    if ($report.ContainsKey('instructions')) {
        $used = [uint64]$report['instructions']
        $ratio = $used / $defaultMaxInstructions
        Write-Host ("instructions: {0} ({1:N2} x OutLayer's default limit of {2}; this run's limit {3})" -f (Format-Count $used), $ratio, (Format-Count $defaultMaxInstructions), (Format-Count $MaxInstructions))
    }
    if ($report.ContainsKey('run_ms')) {
        $total = [double]$report['compile_ms'] + [double]$report['run_ms']
        Write-Host ("time:         compile {0} ms + run {1} ms = {2:N1} ms (limit {3} s; yield window ~{4} s)" -f $report['compile_ms'], $report['run_ms'], $total, $MaxExecutionSeconds, $yieldWindowSeconds)
        Write-Host ("memory:       {0:N1} MiB" -f ([double]$report['memory_bytes'] / 1MB))
    } elseif ($report.ContainsKey('process_ms')) {
        Write-Host "time:         $($report['process_ms']) ms for the whole wasi-test process (compile and run)"
    }
    if ($report['result'] -eq 'failed: out of fuel') {
        Write-Host 'hint:         raise -MaxInstructions (OutLayer allows up to 500e9; see enclave\PERF.md)' -ForegroundColor Yellow
    }

    if ($Expected) {
        $expectedPath = Resolve-Existing $Expected 'expected output'
        $same = (Test-Path -LiteralPath $OutFile) -and
            ([Convert]::ToBase64String([IO.File]::ReadAllBytes($OutFile)) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($expectedPath)))
        if ($same) {
            Write-Host "expected:     output equals $expectedPath byte for byte" -ForegroundColor Green
        } else {
            Write-Host "expected:     output DIFFERS from $expectedPath" -ForegroundColor Red
            $succeeded = $false
        }
    }
    if ($succeeded) { exit 0 } else { exit 1 }
} catch {
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
