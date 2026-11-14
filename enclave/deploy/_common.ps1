<#
Shared helpers for the deploy scripts in this folder. Dot-sourced; it only
defines functions and paths.

Why the scripts work the way they do:

- They PRINT commands by default. A step that signs a transaction runs only
  with -Execute, after you type the network name to confirm.
- JSON arguments are always written to files under deploy\out\<network>\ and
  passed with near CLI's `file-args`. Windows PowerShell 5.1 strips the double
  quotes from JSON passed inline to a native program, and near-sdk then refuses
  the arguments. The files are UTF-8 without a byte order mark: a BOM in front
  of the JSON also makes near-sdk refuse it.
- Every value that ends up in a command or a file is checked first (account
  ids, sha256 hex), so nothing in a template needs escaping.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DeployDir = $PSScriptRoot
$script:EnclaveDir = Split-Path -Parent $PSScriptRoot
$script:RepoRoot = Split-Path -Parent $script:EnclaveDir
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Windows PowerShell 5.1 may default to TLS 1.0, which NEAR RPC and OutLayer refuse.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# NEAR's account id rule (nearcore `AccountId` validation): 2-64 characters,
# dot-separated parts of [a-z0-9] joined by single '-' or '_'.
$script:AccountIdPattern = '^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$'

function Get-DeployNetwork {
    param([Parameter(Mandatory)][ValidateSet('testnet', 'mainnet')][string]$Network)
    $all = [IO.File]::ReadAllText((Join-Path $script:DeployDir 'networks.json')) | ConvertFrom-Json
    $config = $all.$Network
    $config | Add-Member -NotePropertyName Name -NotePropertyValue $Network
    $config
}

function Assert-AccountId {
    param([string]$Value, [string]$Name)
    if ($Value -cnotmatch $script:AccountIdPattern) {
        throw "$Name '$Value' is not a valid NEAR account id (lowercase, 2-64 characters)."
    }
}

function Assert-Sha256 {
    param([string]$Value, [string]$Name)
    if ($Value -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Name must be 64 lowercase hex characters, got '$Value'."
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }
}

<#
The job's wasm sha256: the value OutLayer names the project version by, that
the keystore's WasmHash condition admits, and that the contract pins.
scripts\build-enclave.ps1 writes the wasm and a .sha256 file next to it. Both
are read and must agree. -Sha256 alone (no wasm on disk) is accepted for
printing commands before a build exists.
#>
function Get-JobSha256 {
    param([string]$Wasm, [string]$Sha256)
    $fromFile = $null
    if ($Wasm -and (Test-Path -LiteralPath $Wasm)) {
        $fromFile = Get-Sha256Hex -Bytes ([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Wasm).Path))
        $sidecar = "$Wasm.sha256"
        if (Test-Path -LiteralPath $sidecar) {
            $text = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $sidecar).Path)
            $match = [regex]::Match($text, '[0-9a-fA-F]{64}')
            if (-not $match.Success) { throw "$sidecar holds no sha256." }
            if ($match.Value.ToLowerInvariant() -ne $fromFile) {
                throw "$sidecar says $($match.Value) but $Wasm hashes to $fromFile. Rebuild with scripts\build-enclave.ps1."
            }
        }
    }
    if ($Sha256) {
        $given = $Sha256.Trim().ToLowerInvariant()
        Assert-Sha256 $given '-Sha256'
        if ($fromFile -and $fromFile -ne $given) {
            throw "-Sha256 $given does not match $Wasm ($fromFile)."
        }
        return $given
    }
    if (-not $fromFile) {
        throw "No job wasm at '$Wasm'. Build it with scripts\build-enclave.ps1, or pass -Sha256 to print commands for a known hash."
    }
    $fromFile
}

# Windows PowerShell 5.1 leaves $PSScriptRoot empty while it evaluates a
# script's parameter defaults, so path defaults are filled in here instead.
function Get-DefaultJobWasm { Join-Path $script:EnclaveDir 'res\fairground_sealer.wasm' }
function Get-DefaultContractWasm { Join-Path $script:RepoRoot 'contracts\res\fairground.wasm' }

function Get-OutDir {
    param([Parameter(Mandatory)][string]$Network)
    $dir = Join-Path (Join-Path $script:DeployDir 'out') $Network
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    (Resolve-Path -LiteralPath $dir).Path
}

<#
Renders templates\<Template> by replacing every {{KEY}} with $Values.KEY,
checks that no placeholder is left and that the result parses as JSON, and
writes it to deploy\out\<network>\<OutName> as UTF-8 without a BOM.
#>
function New-ArgsFile {
    param(
        [Parameter(Mandatory)][string]$Template,
        [Parameter(Mandatory)][hashtable]$Values,
        [Parameter(Mandatory)][string]$Network,
        [Parameter(Mandatory)][string]$OutName
    )
    $text = [IO.File]::ReadAllText((Join-Path (Join-Path $script:DeployDir 'templates') $Template))
    foreach ($key in $Values.Keys) {
        $text = $text.Replace("{{$key}}", [string]$Values[$key])
    }
    $left = [regex]::Match($text, '\{\{[A-Z0-9_]+\}\}')
    if ($left.Success) { throw "Template $Template still has $($left.Value) after rendering." }
    $null = $text | ConvertFrom-Json
    $path = Join-Path (Get-OutDir $Network) $OutName
    [IO.File]::WriteAllText($path, $text, $script:Utf8NoBom)
    $path
}

<#
Writes a small JSON object (view-call arguments) built from an ordered
hashtable. Only for flat values the scripts have already checked.
#>
function New-JsonFile {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Object,
        [Parameter(Mandatory)][string]$Network,
        [Parameter(Mandatory)][string]$OutName
    )
    $text = ConvertTo-Json -InputObject $Object -Depth 10 -Compress
    $path = Join-Path (Get-OutDir $Network) $OutName
    [IO.File]::WriteAllText($path, $text, $script:Utf8NoBom)
    $path
}

# --- Plans: an ordered list of steps that is printed, or run with -Execute ---

function New-Plan { New-Object System.Collections.Generic.List[object] }

function Add-Command {
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$Expect = '',
        [switch]$Signs
    )
    $Plan.Add([pscustomobject]@{
        Kind = 'command'; Title = $Title; Exe = $Exe; Arguments = $Arguments
        Expect = $Expect; Signs = [bool]$Signs; Check = $null
    })
}

function Add-Note {
    param([Parameter(Mandatory)]$Plan, [Parameter(Mandatory)][string]$Title, [string]$Text = '')
    $Plan.Add([pscustomobject]@{
        Kind = 'note'; Title = $Title; Exe = ''; Arguments = @(); Expect = $Text; Signs = $false; Check = $null
    })
}

<# A step that only runs in -Execute mode: a script block that throws on failure. #>
function Add-Check {
    param([Parameter(Mandatory)]$Plan, [Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][scriptblock]$Check, [string]$Text = '')
    $Plan.Add([pscustomobject]@{
        Kind = 'check'; Title = $Title; Exe = ''; Arguments = @(); Expect = $Text; Signs = $false; Check = $Check
    })
}

<# One argument as PowerShell (and bash) will read it back: bare when safe, else single-quoted. #>
function Format-Argument {
    param([string]$Value)
    if ($Value -match '^[A-Za-z0-9_./:@=,+-]+$') { return $Value }
    "'" + $Value.Replace("'", "''") + "'"
}

function Format-CommandLine {
    param($Step)
    (@($Step.Exe) + @($Step.Arguments | ForEach-Object { Format-Argument $_ })) -join ' '
}

function Show-Plan {
    param([Parameter(Mandatory)]$Plan, [string[]]$Preamble = @())
    foreach ($line in $Preamble) { Write-Host $line }
    $n = 0
    foreach ($step in $Plan) {
        $n++
        Write-Host ''
        $tag = ''
        if ($step.Signs) { $tag = '  [signs a transaction]' }
        if ($step.Kind -eq 'check') { $tag = '  [runs only with -Execute]' }
        Write-Host ("# {0}. {1}{2}" -f $n, $step.Title, $tag) -ForegroundColor Cyan
        if ($step.Kind -eq 'command') { Write-Host (Format-CommandLine $step) }
        if ($step.Expect) {
            foreach ($line in ($step.Expect -split "`n")) { Write-Host ("#    " + $line) -ForegroundColor DarkGray }
        }
    }
    Write-Host ''
}

<#
Runs the plan. Asks once, by having you type the network name, before
anything is sent; stops at the first command that exits non-zero.
#>
function Invoke-Plan {
    param([Parameter(Mandatory)]$Plan, [Parameter(Mandatory)][string]$Network)
    $signing = @($Plan | Where-Object { $_.Signs }).Count
    Write-Host "About to run $($Plan.Count) steps on $Network ($signing sign a transaction)." -ForegroundColor Yellow
    $answer = Read-Host "Type '$Network' to continue"
    if ($answer -ne $Network) { throw 'Not confirmed; nothing was run.' }
    $n = 0
    foreach ($step in $Plan) {
        $n++
        Write-Host ''
        Write-Host ("# {0}. {1}" -f $n, $step.Title) -ForegroundColor Cyan
        switch ($step.Kind) {
            'note' { if ($step.Expect) { Write-Host $step.Expect -ForegroundColor DarkGray } }
            'check' { & $step.Check }
            'command' {
                Write-Host (Format-CommandLine $step) -ForegroundColor DarkGray
                $exe = Get-Command $step.Exe -ErrorAction SilentlyContinue
                if (-not $exe) { throw "'$($step.Exe)' is not on PATH. See enclave\README.md, Prerequisites." }
                # Splat, so each argument arrives separately. Passing the array
                # itself works for a real .exe but not for npm's near.ps1 shim,
                # which then hands near CLI the whole command as one string.
                $stepArgs = @($step.Arguments)
                & $step.Exe @stepArgs
                if ($LASTEXITCODE -ne 0) { throw "Step $n failed (exit code $LASTEXITCODE). Fix it and run the script again." }
                if ($step.Expect) { Write-Host ("Expected: " + $step.Expect) -ForegroundColor DarkGray }
            }
        }
    }
}

# --- Read-only chain access (used by -Execute guards and Verify-Attestation.ps1) ---

<# A view call over NEAR JSON-RPC. Returns the parsed JSON result. Never signs. #>
function Invoke-NearView {
    param(
        [Parameter(Mandatory)][string]$RpcUrl,
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$ArgsJson
    )
    $body = [ordered]@{
        jsonrpc = '2.0'; id = 'fairground'; method = 'query'
        params = [ordered]@{
            request_type = 'call_function'; finality = 'final'
            account_id = $Account; method_name = $Method
            args_base64 = [Convert]::ToBase64String($script:Utf8NoBom.GetBytes($ArgsJson))
        }
    } | ConvertTo-Json -Depth 5 -Compress
    $response = Invoke-RestMethod -Method Post -Uri $RpcUrl -ContentType 'application/json' -Body $body
    if ($response.PSObject.Properties['error'] -and $response.error) {
        throw "RPC error from $Account.$Method`: $($response.error | ConvertTo-Json -Compress -Depth 10)"
    }
    if ($response.result.PSObject.Properties['error'] -and $response.result.error) {
        throw "$Account.$Method failed: $($response.result.error)"
    }
    $bytes = [byte[]]@($response.result.result)
    $script:Utf8NoBom.GetString($bytes) | ConvertFrom-Json
}

function Write-Preamble {
    param($Net, [string]$Account, [string]$Extra = '')
    $lines = @(
        "# Network: $($Net.Name)   OutLayer: $($Net.outlayerContract)   signer: $Account",
        '# Commands are printed, not run. Re-run with -Execute to run them (you confirm first).'
    )
    if ($Extra) { $lines += $Extra }
    $lines
}

# --- Read-only RPC with retries, and captured near CLI output (8-evidence-sale.ps1) ---

<#
One JSON-RPC request. Public testnet RPC nodes answer HTTP 429 (rate limit),
fail on their side (5xx) or time out under load, so this waits and tries the
next URL in -RpcUrl (or the same one again), up to -Tries times. A JSON-RPC
error inside an HTTP 200 answer is returned as is, not retried. Never signs.
#>
function Invoke-NearRpc {
    param(
        [Parameter(Mandatory)][string[]]$RpcUrl,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)]$Params,
        [ValidateRange(1, 30)][int]$Tries = 8
    )
    $body = [ordered]@{ jsonrpc = '2.0'; id = 'fairground'; method = $Method; params = $Params } | ConvertTo-Json -Depth 10 -Compress
    $urls = @($RpcUrl)
    for ($try = 0; ; $try++) {
        $url = $urls[$try % $urls.Count]
        try {
            return Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body $body -TimeoutSec 30
        } catch {
            $status = 0
            $ex = $_.Exception
            if ($ex.PSObject.Properties['Response'] -and $ex.Response) {
                try { $status = [int]$ex.Response.StatusCode } catch { $status = 0 }
            }
            # 4xx other than 429 will not change on a retry.
            if ($status -ge 400 -and $status -lt 500 -and $status -ne 429) { throw }
            if ($try + 1 -ge $Tries) { throw }
            $wait = [Math]::Min(20, 2 * ($try + 1))
            Write-Host ("RPC {0} did not answer {1} ({2}); trying again in {3} s" -f $url, $Method, $(if ($status) { "HTTP $status" } else { $ex.Message }), $wait) -ForegroundColor DarkGray
            Start-Sleep -Seconds $wait
        }
    }
}

<# Invoke-NearView over Invoke-NearRpc: the same result, with retries and several URLs. #>
function Invoke-NearViewRetry {
    param(
        [Parameter(Mandatory)][string[]]$RpcUrl,
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$ArgsJson
    )
    $params = [ordered]@{
        request_type = 'call_function'; finality = 'final'
        account_id = $Account; method_name = $Method
        args_base64 = [Convert]::ToBase64String($script:Utf8NoBom.GetBytes($ArgsJson))
    }
    $response = Invoke-NearRpc -RpcUrl $RpcUrl -Method 'query' -Params $params
    if ($response.PSObject.Properties['error'] -and $response.error) {
        throw "RPC error from $Account.$Method`: $($response.error | ConvertTo-Json -Compress -Depth 10)"
    }
    if ($response.result.PSObject.Properties['error'] -and $response.result.error) {
        throw "$Account.$Method failed: $($response.result.error)"
    }
    $bytes = [byte[]]@($response.result.result)
    $script:Utf8NoBom.GetString($bytes) | ConvertFrom-Json
}

<# An account's state (amount, locked, storage_usage), or $null when the account does not exist. #>
function Get-NearAccount {
    param([Parameter(Mandatory)][string[]]$RpcUrl, [Parameter(Mandatory)][string]$Account)
    $response = Invoke-NearRpc -RpcUrl $RpcUrl -Method 'query' -Params ([ordered]@{ request_type = 'view_account'; finality = 'final'; account_id = $Account })
    if ($response.PSObject.Properties['error'] -and $response.error) {
        $text = $response.error | ConvertTo-Json -Compress -Depth 10
        if ($text -match 'UNKNOWN_ACCOUNT|does not exist') { return $null }
        throw "view_account $Account`: $text"
    }
    $response.result
}

<#
The account's access keys and the block they were read at: Keys is an array
(empty for a locked contract), Block the block height. Read at final.
#>
function Get-AccessKeyList {
    param([Parameter(Mandatory)][string[]]$RpcUrl, [Parameter(Mandatory)][string]$Account)
    $response = Invoke-NearRpc -RpcUrl $RpcUrl -Method 'query' -Params ([ordered]@{ request_type = 'view_access_key_list'; finality = 'final'; account_id = $Account })
    if ($response.PSObject.Properties['error'] -and $response.error) {
        throw "view_access_key_list $Account`: $($response.error | ConvertTo-Json -Compress -Depth 10)"
    }
    $keys = @()
    foreach ($k in @($response.result.keys)) {
        if ($null -eq $k) { continue }
        $permission = $k.access_key.permission
        $keys += [pscustomobject]@{
            public_key = [string]$k.public_key
            permission = $(if ($permission -is [string]) { $permission } else { 'FunctionCall' })
        }
    }
    [pscustomobject]@{ Keys = $keys; Block = [long]$response.result.block_height }
}

<#
Runs a native command (near CLI) the way Invoke-Plan does, echoes each output
line as it arrives, and returns the lines and the exit code, so the caller
can read the transaction hash near CLI prints. Native stderr lines arrive as
error records when merged; with $ErrorActionPreference = 'Stop' Windows
PowerShell 5.1 would stop at the first one, so it is 'Continue' in here.
#>
function Invoke-NativeCaptured {
    param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string[]]$Arguments)
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { throw "'$Exe' is not on PATH. See enclave\README.md, Prerequisites." }
    $ErrorActionPreference = 'Continue'
    $lines = New-Object System.Collections.Generic.List[string]
    $stepArgs = @($Arguments)
    & $Exe @stepArgs 2>&1 | ForEach-Object {
        $text = [string]$_
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $text = $_.Exception.Message }
        Write-Host $text
        $lines.Add($text)
    }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines.ToArray() }
}

<# The transaction hash in near CLI's output ("Transaction ID: <hash>"), or $null. #>
function Get-NearTxHash {
    param([string[]]$Lines)
    $text = (@($Lines) -join "`n") -replace '\x1b\[[0-9;]*m', ''
    $m = [regex]::Match($text, 'Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})')
    if ($m.Success) { return $m.Groups[1].Value }
    $m = [regex]::Match($text, '/(?:txns|transactions)/([1-9A-HJ-NP-Za-km-z]{43,44})')
    if ($m.Success) { return $m.Groups[1].Value }
    $null
}
