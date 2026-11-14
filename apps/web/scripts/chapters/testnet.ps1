param(
    [string]$Publisher = 'itzbeast.testnet',
    [string]$Factory = 'chapters.itzbeast.testnet',
    [string]$SaleContract = 'sealround.itzbeast.testnet',
    [switch]$Build,
    [switch]$PublishEscrow,
    [switch]$DeployFactory
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
$accountPattern = '^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$'
foreach ($account in @($Publisher, $Factory, $SaleContract)) {
    if ($account -cnotmatch $accountPattern) { throw "Expected a named testnet account. Received $account." }
}
if ($Factory.Length -gt 32) { throw 'The Chapters factory account can be at most 32 bytes.' }
if ($Factory -eq $SaleContract) { throw 'Use a separate Chapters factory account.' }
if ($PublishEscrow -and $DeployFactory) { throw 'Publish the escrow and deploy the factory in separate runs so you can verify the first transaction.' }

$escrow = Join-Path $repo 'target/near/sealround_chapters/sealround_chapters.wasm'
$factoryWasm = Join-Path $repo 'target/near/sealround_chapters_factory/sealround_chapters_factory.wasm'

function Read-WasmHash([string]$File) {
    if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing WASM file $File. Run with -Build first." }
    $stream = [System.IO.File]::OpenRead($File)
    try {
        $header = [byte[]]::new(8)
        if ($stream.Read($header, 0, 8) -ne 8 -or [BitConverter]::ToString($header) -ne '00-61-73-6D-01-00-00-00') {
            throw "Invalid WASM header in $File."
        }
    } finally { $stream.Dispose() }
    (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

Push-Location -LiteralPath $repo
try {
    if ($Build) {
        foreach ($manifest in @('contracts/chapters/Cargo.toml', 'contracts/chapters/factory/Cargo.toml')) {
            cargo near build non-reproducible-wasm --locked --no-abi --manifest-path $manifest
            if ($LASTEXITCODE -ne 0) { throw "Build failed for $manifest." }
        }
    }
    $escrowHash = Read-WasmHash $escrow
    $factoryHash = Read-WasmHash $factoryWasm
    $init = [ordered]@{
        sale_contract = $SaleContract
        chapters_code_hash = $escrowHash
    } | ConvertTo-Json -Compress

    Write-Output "Escrow SHA-256 $escrowHash"
    Write-Output "Factory SHA-256 $factoryHash"
    Write-Output "Factory init $init"
    Write-Output "NEXT_PUBLIC_CHAPTERS_FACTORY=$Factory"

    if ($PublishEscrow) {
        near contract deploy-as-global use-file $escrow as-global-hash $Publisher network-config testnet sign-with-keychain send
        if ($LASTEXITCODE -ne 0) { throw 'Global escrow publication failed.' }
    }
    if ($DeployFactory) {
        $initFile = New-TemporaryFile
        try {
            Set-Content -LiteralPath $initFile.FullName -Value $init -Encoding ascii
            near contract deploy $Factory use-file $factoryWasm with-init-call new file-args $initFile.FullName prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
            if ($LASTEXITCODE -ne 0) { throw 'Factory deployment failed.' }
        } finally { Remove-Item -LiteralPath $initFile.FullName }
        near contract call-function as-read-only $Factory enable_cost json-args '{}' network-config testnet now
        if ($LASTEXITCODE -ne 0) { throw 'Factory deployment was sent. Check its receipt and view status before rerunning.' }
    }
} finally { Pop-Location }
