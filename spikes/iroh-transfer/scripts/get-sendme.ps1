# Download the pinned sendme.exe for Windows into ..\bin\sendme.exe
# One-time setup on the desktop -- NO Rust toolchain needed.
# Pinned to v0.36.0 to match the sender.
$ErrorActionPreference = "Stop"

$ver = "v0.36.0"
$url = "https://github.com/n0-computer/sendme/releases/download/$ver/sendme-$ver-windows-x86_64.zip"
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$zip = Join-Path $env:TEMP "sendme-$ver.zip"
Write-Host "downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $bin -Force
Remove-Item $zip

# The zip may nest the binary; normalise to bin\sendme.exe.
$exe = Join-Path $bin "sendme.exe"
if (-not (Test-Path $exe)) {
    $found = Get-ChildItem -Path $bin -Recurse -Filter "sendme.exe" | Select-Object -First 1
    if ($found) { Move-Item $found.FullName $exe -Force }
}
& $exe --version
Write-Host "OK -> .\bin\sendme.exe"
