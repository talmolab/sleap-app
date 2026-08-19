# SLEAP desktop installer (Windows).
#
#   irm https://app.sleap.ai/install.ps1 | iex
#
# Windows has no Gatekeeper equivalent, so unlike macOS this is a convenience
# rather than a workaround -- it just resolves the right release asset and runs
# the NSIS installer silently. SmartScreen may still warn on first launch because
# the .exe is not signed with an EV certificate; that warning has a "Run anyway".
#
# Usage:
#   install.ps1                 Install the latest release
#   install.ps1 -Tag v0.2.0     Install a specific release tag
#   install.ps1 -Path setup.exe Install from a local .exe / .msi, or a .zip
#                               containing one (e.g. a GitHub Actions artifact)

[CmdletBinding()]
param(
    [string]$Tag,
    [string]$Path
)

$ErrorActionPreference = "Stop"

$repo = "talmolab/sleap-app"
$api = "https://api.github.com/repos/$repo"
$appName = "SLEAP"

function Get-Release {
    param([string]$WantTag)

    if ($WantTag) {
        try {
            return Invoke-RestMethod -Uri "$api/releases/tags/$WantTag"
        } catch {
            throw "No release tagged $WantTag in $repo"
        }
    }

    $stable = $null
    try { $stable = Invoke-RestMethod -Uri "$api/releases/latest" } catch { }
    if ($stable -and (Get-InstallerAsset $stable)) {
        return $stable
    }

    if ($stable) {
        Write-Host "Note: latest release $($stable.tag_name) has no Windows build."
    }
    Write-Host "Looking for the newest release that does..."

    # /releases/latest skips pre-releases and drafts, so walk the full list.
    $all = Invoke-RestMethod -Uri "$api/releases?per_page=30"
    foreach ($candidate in $all) {
        if (Get-InstallerAsset $candidate) {
            return $candidate
        }
    }

    throw ("No release in $repo has a Windows build yet. Browse " +
        "https://github.com/$repo/releases and pass one with -Tag <tag>.")
}

function Get-InstallerAsset {
    param($Release)

    # NSIS first -- it is Tauri's default and supports silent install/update.
    foreach ($pattern in @("*-setup.exe", "*.msi")) {
        $asset = $Release.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
        if ($asset) { return $asset }
    }
    return $null
}

function Install-FromFile {
    param([string]$File)

    if (-not (Test-Path -LiteralPath $File)) {
        throw "No such file: $File"
    }
    $item = Get-Item -LiteralPath $File

    if ($item.Extension -eq ".zip") {
        # GitHub Actions hands you a .zip of the build artifacts; look inside.
        Write-Host "Extracting $($item.Name)..."
        $unzipped = Join-Path ([System.IO.Path]::GetTempPath()) "sleap-install-$([System.Guid]::NewGuid())"
        Expand-Archive -LiteralPath $item.FullName -DestinationPath $unzipped -Force
        $inner = Get-ChildItem -Path $unzipped -Recurse -Include "*-setup.exe", "*.msi" |
            Select-Object -First 1
        if (-not $inner) {
            throw "No -setup.exe or .msi inside $($item.Name)"
        }
        Write-Host "Found $($inner.Name)"
        Install-FromFile $inner.FullName
        Remove-Item -Recurse -Force $unzipped -ErrorAction SilentlyContinue
        return
    }

    if (Get-Process -Name "sleap-app" -ErrorAction SilentlyContinue) {
        throw "$appName is currently running. Close it and re-run this installer."
    }

    Write-Host "Running installer (silent mode)..."
    if ($item.Extension -eq ".msi") {
        Start-Process -FilePath "msiexec.exe" `
            -ArgumentList "/i", "`"$($item.FullName)`"", "/passive" -Wait
    } else {
        # NSIS: /S is silent. Download from the Releases page and run it by hand
        # if you want the interactive installer instead.
        Start-Process -FilePath $item.FullName -ArgumentList "/S" -Wait
    }
}

function Main {
    if ($Path) {
        Install-FromFile $Path
    } else {
        Write-Host "Fetching release info..."
        $release = Get-Release $Tag
        Write-Host "Release: $($release.tag_name)"

        $asset = Get-InstallerAsset $release
        if (-not $asset) { throw "No Windows installer in that release" }

        $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "sleap-install-$([System.Guid]::NewGuid())"
        New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
        try {
            $installer = Join-Path $tempDir $asset.name
            Write-Host "Downloading $($asset.name)..."
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
            Install-FromFile $installer
        } finally {
            Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
        }
    }

    $installDir = Join-Path $env:LOCALAPPDATA $appName
    Write-Host ""
    if (Test-Path (Join-Path $installDir "sleap-app.exe")) {
        Write-Host "Installed $appName to $installDir"
    } else {
        Write-Host "Installed $appName."
    }
    Write-Host "Launch it from the Start menu."
}

Main
