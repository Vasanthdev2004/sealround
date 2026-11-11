<#
.SYNOPSIS
Builds the Fairground contracts to wasm and copies them to contracts/res.

.DESCRIPTION
Builds token, mock-ft, then fairground, always in that order: fairground embeds
contracts/res/fairground_token.wasm with include_bytes!, so the token must be
copied first.

Each crate is built in its own directory with
`cargo near build non-reproducible-wasm --no-abi` (the ABI step fails on Windows
MSVC, cargo-near#188). cargo-near writes <target dir>/near/<crate>/<crate>.wasm
and reports that path as "Binary:". The script copies it to
contracts/res/<crate>.wasm, checks it is a wasm module that exports methods and
has no multi-value function types (nearcore rejects those), and prints the size
and sha256 of each file.

Exits non-zero on any failure.

.PARAMETER Only
Contracts to build: token, mock-ft, fairground (crate names such as
fairground-token also work). Comma-separated or an array. Default: all three.

.PARAMETER SkipMissing
If fairground fails to build, warn and skip it instead of failing (useful when
only the token or mock-ft is needed). Never skips token or mock-ft.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\build-contracts.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\build-contracts.ps1 -Only token,mock-ft
#>
[CmdletBinding()]
param(
    [string[]]$Only = @(),
    [switch]$SkipMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$resDir = Join-Path $repoRoot 'contracts\res'

# Build order matters: see the description.
$contracts = @(
    [pscustomobject]@{ Name = 'token'; Crate = 'fairground-token'; Dir = 'contracts\token'; Skippable = $false }
    [pscustomobject]@{ Name = 'mock-ft'; Crate = 'mock-ft'; Dir = 'contracts\mock-ft'; Skippable = $false }
    [pscustomobject]@{ Name = 'fairground'; Crate = 'fairground'; Dir = 'contracts\fairground'; Skippable = $true }
)

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

function Read-Leb128 {
    param([byte[]]$Bytes, [ref]$Pos)
    $result = [long]0
    $shift = 0
    while ($true) {
        if ($Pos.Value -ge $Bytes.Length) { throw 'truncated LEB128 value' }
        $byte = $Bytes[$Pos.Value]
        $Pos.Value++
        $result = $result -bor ([long]($byte -band 0x7f) -shl $shift)
        if (($byte -band 0x80) -eq 0) { return $result }
        $shift += 7
        if ($shift -gt 35) { throw 'LEB128 value too long for u32' }
    }
}

# Reads the type and export sections. nearcore's VM has the multi-value
# proposal disabled, so a function type with more than one result would make the
# deploy fail. A module without exported functions is not a contract (for
# example an empty scaffold crate).
function Test-WasmContract {
    param([string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 8 -or $bytes[0] -ne 0 -or $bytes[1] -ne 0x61 -or $bytes[2] -ne 0x73 -or $bytes[3] -ne 0x6d) {
        throw "$Path is not a wasm module"
    }
    $pos = 8
    $types = 0
    $multiValueTypes = 0
    $exports = New-Object System.Collections.Generic.List[string]
    while ($pos -lt $bytes.Length) {
        $id = $bytes[$pos]
        $pos++
        $size = Read-Leb128 $bytes ([ref]$pos)
        $end = $pos + $size
        if ($end -gt $bytes.Length) { throw "section $id runs past the end of $Path" }
        if ($id -eq 1) {
            $p = $pos
            $types = Read-Leb128 $bytes ([ref]$p)
            for ($i = 0; $i -lt $types; $i++) {
                if ($bytes[$p] -ne 0x60) { throw "type $i is not a function type" }
                $p++
                # Read counts into a variable first: `$p += Read-Leb128 ... ([ref]$p)`
                # would add to the value of $p from before the read.
                $params = Read-Leb128 $bytes ([ref]$p)
                $p += $params                       # value types are one byte each
                $results = Read-Leb128 $bytes ([ref]$p)
                $p += $results
                if ($results -gt 1) { $multiValueTypes++ }
            }
        } elseif ($id -eq 7) {
            $p = $pos
            $count = Read-Leb128 $bytes ([ref]$p)
            for ($i = 0; $i -lt $count; $i++) {
                $nameLength = Read-Leb128 $bytes ([ref]$p)
                $name = [Text.Encoding]::UTF8.GetString($bytes, $p, $nameLength)
                $p += $nameLength
                $kind = $bytes[$p]
                $p++
                $null = Read-Leb128 $bytes ([ref]$p)
                if ($kind -eq 0) { $exports.Add($name) }
            }
        }
        $pos = $end
    }
    if ($multiValueTypes -gt 0) {
        throw "$Path has $multiValueTypes multi-value function type(s); nearcore rejects multi-value"
    }
    if ($exports.Count -eq 0) {
        throw "$Path exports no functions"
    }
    [pscustomobject]@{ Types = $types; Exports = $exports }
}

# Builds one contract and copies its wasm to contracts/res. Throws on failure.
function Build-Contract {
    param($Contract, [string]$TargetDir)
    $crateFile = $Contract.Crate -replace '-', '_'
    Write-Host ''
    Write-Host "==> $($Contract.Name) ($($Contract.Crate))" -ForegroundColor Cyan

    Push-Location (Join-Path $repoRoot $Contract.Dir)
    try {
        $build = Invoke-Native 'cargo' @('near', 'build', 'non-reproducible-wasm', '--no-abi', '--env', "RUSTFLAGS=$script:wasmRustflags")
    } finally {
        Pop-Location
    }
    if ($build.ExitCode -ne 0) {
        throw "cargo near build failed for $($Contract.Crate) (exit $($build.ExitCode))"
    }

    # cargo-near reports where it put the wasm; fall back to its known layout.
    $wasm = Join-Path $TargetDir "near\$crateFile\$crateFile.wasm"
    $reportedHash = $null
    foreach ($line in $build.Lines) {
        if ($line -match 'Binary:\s*(\S.*\.wasm)\s*$') { $wasm = $Matches[1] }
        if ($line -match 'SHA-256 checksum hex\s*:\s*([0-9a-f]{64})') { $reportedHash = $Matches[1] }
    }
    if (-not (Test-Path -LiteralPath $wasm)) {
        throw "built wasm not found at $wasm"
    }

    $check = Test-WasmContract $wasm
    # Refuse a binary that still names this machine's home or checkout directory.
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($wasm))
    foreach ($local in @($env:USERPROFILE, $repoRoot) | Where-Object { $_ }) {
        if ($text.IndexOf($local, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "$wasm still contains the local path $local; check the --remap-path-prefix flags"
        }
    }
    $dest = Join-Path $resDir "$crateFile.wasm"
    Copy-Item -LiteralPath $wasm -Destination $dest -Force
    $hash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($reportedHash -and $reportedHash -ne $hash) {
        throw "sha256 of $dest ($hash) differs from the one cargo-near reported ($reportedHash)"
    }
    Write-Verbose ("exports: " + ($check.Exports -join ', '))
    [pscustomobject]@{
        Contract = $Contract.Name
        File     = "contracts\res\$crateFile.wasm"
        Bytes    = (Get-Item -LiteralPath $dest).Length
        Exports  = $check.Exports.Count
        Sha256   = $hash
    }
}

try {
    $requested = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($name in $requested) {
        if (-not ($contracts | Where-Object { $_.Name -eq $name -or $_.Crate -eq $name })) {
            throw "unknown contract '$name'; expected one of: $(($contracts | ForEach-Object { $_.Name }) -join ', ')"
        }
    }
    $selected = @($contracts | Where-Object {
            $requested.Count -eq 0 -or $requested -contains $_.Name -or $requested -contains $_.Crate
        })

    $metadata = Invoke-Native -Quiet 'cargo' @('metadata', '--format-version', '1', '--no-deps', '--quiet',
        '--manifest-path', (Join-Path $repoRoot 'Cargo.toml'))
    if ($metadata.ExitCode -ne 0) { throw "cargo metadata failed (exit $($metadata.ExitCode))" }
    $json = ($metadata.Lines | Where-Object { $_.StartsWith('{') }) -join ''
    $targetDir = ($json | ConvertFrom-Json).target_directory

    # Keep this machine's paths out of the wasm. Panic-location strings hold the
    # source path of every registry dependency, which would put the builder's home
    # directory into a committed binary. Workspace sources are already relative.
    # cargo-near replaces RUSTFLAGS from the environment, so the flags go through
    # its --env option, starting from its default (-C link-arg=-s). RUSTFLAGS is
    # space-separated: a prefix containing a space is skipped here and caught by
    # the check in Build-Contract instead.
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $remaps = @(
        @{ From = $cargoHome; To = '/cargo' }
        @{ From = $targetDir; To = '/target' }
    ) | Where-Object { $_.From -and -not $_.From.Contains(' ') } | ForEach-Object { "--remap-path-prefix=$($_.From)=$($_.To)" }
    $script:wasmRustflags = (@('-C link-arg=-s') + $remaps) -join ' '

    New-Item -ItemType Directory -Force -Path $resDir | Out-Null
    $built = New-Object System.Collections.Generic.List[object]
    $skipped = New-Object System.Collections.Generic.List[string]
    foreach ($contract in $selected) {
        try {
            $built.Add((Build-Contract $contract $targetDir))
        } catch {
            if ($SkipMissing -and $contract.Skippable) {
                Write-Warning "$($contract.Name) skipped (-SkipMissing): $($_.Exception.Message)"
                $skipped.Add($contract.Name)
            } else {
                throw
            }
        }
    }

    Write-Host ''
    foreach ($item in $built) {
        Write-Host ('{0,-11} {1}  {2:N0} bytes ({3:N1} KiB), {4} exported methods' -f
            $item.Contract, $item.File, $item.Bytes, ($item.Bytes / 1024), $item.Exports) -ForegroundColor Green
        Write-Host ('{0,-11} sha256 {1}' -f '', $item.Sha256)
    }
    if ($skipped.Count -gt 0) { Write-Host "skipped: $($skipped -join ', ')" -ForegroundColor Yellow }
    exit 0
} catch {
    Write-Host "build-contracts: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
