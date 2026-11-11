<#
.SYNOPSIS
Builds Fairground's enclave job (the OutLayer job) reproducibly in Docker and
writes enclave\res\fairground_sealer.wasm, its .sha256 file and build-info.json.

.DESCRIPTION
The job's wasm sha256 is its identity on chain: OutLayer names the project
version by it, the keystore releases the master secret only to a module with
that hash, and the sale contract pins it. So every build of the same sources
must give the same bytes, on any machine. This script:

1. builds the image enclave\build\Dockerfile as fairground-enclave-build:1.97.1
   (the official rust:1.97.1-trixie image pinned by digest, plus the
   wasm32-wasip1 target);
2. runs enclave\build\build.sh in a new container with the repository mounted
   read-only at /src. It runs
   `cargo build --locked --release --target wasm32-wasip1 -p fairground-sealer-job`
   from enclave/ under a fixed environment with --remap-path-prefix, into a
   target directory inside the container, so every build starts from nothing;
3. build.sh checks the module (only WASI P1 imports that the worker's
   wasmtime 28 provides, `_start` and `memory` exported, no build path left in
   it) and writes build-info.json: base image, toolchain, command and
   environment, Cargo.lock hash, the sha256 of every repository file the build
   read, and the git commit when those files are committed and unmodified;
4. copies the three files to enclave\res and prints the sha256 last.

Docker is the canonical build. A native `cargo build` gives a different hash:
the wasm's panic-location strings hold the source paths of the machine that
built it (C:\Users\<you>\.cargo\registry\..., D:\...\crates\...), so the bytes
depend on the user name, the drive and the checkout location. The container
fixes those paths and build.sh rewrites them with --remap-path-prefix.

-Verify rebuilds the same way and compares the result with the committed
enclave\res\fairground_sealer.wasm.sha256 (or with -Expected, for example the
hash the contract on chain pins), without touching enclave\res. It exits 0
when they are equal and 1 when they are not.

Needs Docker with linux/amd64 containers (Docker Desktop on Windows and macOS,
where Apple silicon runs them emulated) and network access for the base image,
the target and the crates (cargo checks each crate against Cargo.lock). Runs in
Windows PowerShell 5.1 and in PowerShell 7 on Linux and macOS. Without
PowerShell, run the two docker commands at the top of enclave\build\build.sh.

Exits non-zero on any failure.

.PARAMETER Verify
Rebuild and compare with the committed sha256 instead of writing enclave\res.
The fresh build stays in enclave\target\build-enclave for inspection.

.PARAMETER Expected
With -Verify: the sha256 to compare with (64 hex digits) instead of
enclave\res\fairground_sealer.wasm.sha256.

.PARAMETER NoCache
Rebuild the image without Docker's layer cache. The base image is still the
pinned digest.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\build-enclave.ps1 -Verify

.EXAMPLE
pwsh scripts/build-enclave.ps1 -Verify -Expected 0123...(the sha256 the contract pins)
#>
[CmdletBinding()]
param(
    [switch]$Verify,
    [string]$Expected,
    [switch]$NoCache
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildDir = [IO.Path]::Combine($repoRoot, 'enclave', 'build')
$resDir = [IO.Path]::Combine($repoRoot, 'enclave', 'res')
# Git ignores target directories. Emptied before every build.
$outDir = [IO.Path]::Combine($repoRoot, 'enclave', 'target', 'build-enclave')
$image = 'fairground-enclave-build:1.97.1'
$platform = 'linux/amd64'
$wasmName = 'fairground_sealer.wasm'
$shaName = "$wasmName.sha256"
$outputs = @($wasmName, $shaName, 'build-info.json')
# What the build reads from the repository (build_info.py lists the exact
# files). build-info.json names the commit only when git shows none of these
# paths modified or untracked.
$gitInputs = @('Cargo.toml', '.cargo', 'crates/clearing', 'crates/sealer', 'enclave/Cargo.toml',
    'enclave/Cargo.lock', 'enclave/rust-toolchain.toml', 'enclave/job', 'enclave/tools', 'enclave/build')
# $IsLinux only exists in PowerShell 6+, and strict mode rejects unknown variables.
$onLinux = [bool](Get-Variable -Name IsLinux -ValueOnly -ErrorAction SilentlyContinue)

# Runs a native command with stderr merged into its output. Docker and cargo
# write progress to stderr, which Windows PowerShell 5.1 would otherwise turn
# into terminating errors. Returns the exit code and every output line.
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

function Invoke-Step {
    param([string]$What, [string]$FilePath, [string[]]$Arguments)
    Write-Host "==> $What" -ForegroundColor Cyan
    $result = Invoke-Native $FilePath $Arguments
    if ($result.ExitCode -ne 0) { throw "$What failed ($FilePath exit $($result.ExitCode))" }
}

# git's stdout only: a warning on stderr must not read as a changed file.
function Invoke-Git {
    param([string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& git -C $repoRoot @Arguments 2>$null)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}

# HEAD, and whether every build input is committed and unmodified. Empty
# strings when there is no git or no repository; build-info.json then says null.
function Get-GitFacts {
    $unknown = @{ Head = ''; Clean = '' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $unknown }
    $head = Invoke-Git @('rev-parse', '--verify', '--quiet', 'HEAD')
    if ($head.ExitCode -ne 0 -or $head.Lines.Count -eq 0) { return $unknown }
    $status = Invoke-Git (@('status', '--porcelain', '--untracked-files=all', '--') + $gitInputs)
    if ($status.ExitCode -ne 0) { return $unknown }
    @{ Head = "$($head.Lines[0])".Trim(); Clean = $(if ($status.Lines.Count -eq 0) { 'true' } else { 'false' }) }
}

function Get-Sha256 {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# The hash in a .sha256 file (sha256sum format or a bare hash).
function Read-Sha256File {
    param([string]$Path)
    $match = [regex]::Match([IO.File]::ReadAllText($Path), '\b[0-9a-fA-F]{64}\b')
    if (-not $match.Success) { throw "$Path holds no sha256" }
    $match.Value.ToLowerInvariant()
}

try {
    if ($Expected -and -not $Verify) { throw '-Expected only goes with -Verify' }
    if ($Expected -and $Expected.Trim() -notmatch '^[0-9a-fA-F]{64}$') { throw "-Expected must be 64 hex digits, got '$Expected'" }
    # --mount separates its fields with commas.
    if ($repoRoot.Contains(',')) { throw "docker --mount cannot take a path with a comma: $repoRoot" }

    $server = Invoke-Native 'docker' @('version', '--format', '{{.Server.Os}}/{{.Server.Arch}}') -Quiet
    if ($server.ExitCode -ne 0) { throw "Docker is not available: $($server.Lines -join ' ')" }

    $buildArgs = @('build', '--progress', 'plain', '--platform', $platform, '--tag', $image)
    if ($NoCache) { $buildArgs += '--no-cache' }
    Invoke-Step 'build the image (enclave/build/Dockerfile)' 'docker' ($buildArgs + $buildDir)

    if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
    New-Item -ItemType Directory -Path $outDir | Out-Null

    $git = Get-GitFacts
    $runArgs = @('run', '--rm', '--pull', 'never', '--platform', $platform,
        '--mount', "type=bind,source=$repoRoot,target=/src,readonly",
        '--mount', "type=bind,source=$outDir,target=/out",
        '--env', "FAIRGROUND_GIT_HEAD=$($git.Head)",
        '--env', "FAIRGROUND_GIT_INPUTS_CLEAN=$($git.Clean)")
    # Native Linux Docker would otherwise leave root-owned files in the checkout.
    if ($onLinux) { $runArgs += @('--user', "$(& id -u):$(& id -g)") }
    $runArgs += @($image, 'sh', '/src/enclave/build/build.sh')
    Invoke-Step 'build the job in a new container (enclave/build/build.sh)' 'docker' $runArgs

    foreach ($name in $outputs) {
        if (-not (Test-Path -LiteralPath (Join-Path $outDir $name) -PathType Leaf)) { throw "the build wrote no $name" }
    }
    $builtWasm = Join-Path $outDir $wasmName
    $sha = Get-Sha256 $builtWasm
    $containerSha = Read-Sha256File (Join-Path $outDir $shaName)
    if ($containerSha -ne $sha) { throw "the container's $shaName says $containerSha, but the file hashes to $sha here" }
    $info = [IO.File]::ReadAllText((Join-Path $outDir 'build-info.json')) | ConvertFrom-Json

    Write-Host ''
    Write-Host ('module:     {0} bytes, imports {1}' -f $info.artifact.bytes, (@($info.module.imports) -join ', '))
    Write-Host "toolchain:  rustc $($info.toolchain.rustc) ($($info.toolchain.rustc_commit_hash)) in $($info.build.image)"
    if ($git.Clean -eq 'true') {
        Write-Host "sources:    git commit $($git.Head)"
    } else {
        Write-Host 'sources:    not a clean git commit; build-info.json lists the sha256 of every input file' -ForegroundColor Yellow
    }

    $committedSha = Join-Path $resDir $shaName
    $committedWasm = Join-Path $resDir $wasmName
    if ($Verify) {
        if ($Expected) {
            $want = $Expected.Trim().ToLowerInvariant()
            $wantFrom = '-Expected'
        } else {
            if (-not (Test-Path -LiteralPath $committedSha)) { throw "no $committedSha to compare with: pass -Expected, or build without -Verify first" }
            $want = Read-Sha256File $committedSha
            $wantFrom = $committedSha
        }
        $same = $sha -eq $want
        Write-Host ''
        Write-Host "rebuilt:    $sha ($builtWasm)"
        Write-Host "expected:   $want ($wantFrom)"
        # Without -Expected the committed wasm must be those bytes too.
        if (-not $Expected -and (Test-Path -LiteralPath $committedWasm)) {
            $committed = Get-Sha256 $committedWasm
            Write-Host "committed:  $committed ($committedWasm)"
            $same = $same -and ($committed -eq $sha)
        }
        if ($same) {
            Write-Host 'verify:     MATCH, the sources rebuild to the expected bytes' -ForegroundColor Green
        } else {
            Write-Host 'verify:     MISMATCH' -ForegroundColor Red
        }
        Write-Output $sha
        if ($same) { exit 0 } else { exit 1 }
    }

    $previous = if (Test-Path -LiteralPath $committedSha) { Read-Sha256File $committedSha } else { $null }
    if (-not (Test-Path -LiteralPath $resDir)) { New-Item -ItemType Directory -Path $resDir | Out-Null }
    foreach ($name in $outputs) {
        Copy-Item -LiteralPath (Join-Path $outDir $name) -Destination (Join-Path $resDir $name) -Force
    }
    Write-Host ''
    Write-Host "wrote:      $resDir ($($outputs -join ', '))"
    if ($previous -and $previous -ne $sha) {
        Write-Host "changed:    was $previous. Everything that pins the job (the OutLayer project version, the secret's WasmHash condition, the contract's sealer source) must move to the new hash: enclave\README.md, section 8." -ForegroundColor Yellow
    }
    Write-Host 'sha256:' -ForegroundColor Green
    Write-Output $sha
    exit 0
} catch {
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
