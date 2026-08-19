<#
.SYNOPSIS
  Install the SLEAP desktop app on Windows.

.DESCRIPTION
  Resolves the newest SLEAP release, downloads the NSIS installer and runs it --
  or installs a file you already have, including the .zip straight off a GitHub
  Actions artifact page.

  Windows has no Gatekeeper equivalent, so unlike the macOS path this is a
  convenience rather than a workaround. SmartScreen may still warn on first run
  because the installer is not signed with an EV certificate; that warning has a
  "More info" > "Run anyway".

.EXAMPLE
  irm https://app.sleap.ai/install.ps1 | iex

.EXAMPLE
  # `| iex` cannot forward parameters, so build a script block first.
  & ([scriptblock]::Create((irm https://app.sleap.ai/install.ps1))) -Tag v0.1.2

.EXAMPLE
  .\install.ps1 -Path $HOME\Downloads\sleap-app-windows.zip
#>
[CmdletBinding()]
param(
    # Install from a local .exe / .msi / .zip instead of downloading.
    [string] $Path,

    # Install this exact release tag, e.g. -Tag v0.1.2 (pre-releases included).
    [string] $Tag,

    # When resolving the newest release, consider pre-releases.
    [switch] $Pre,

    # Show the installer wizard instead of installing silently. Use this when
    # SLEAP is already running: the wizard asks before closing it.
    [switch] $Interactive,

    # Install even though SLEAP is running. Read Assert-NotRunning first.
    [switch] $Force
)

# Deliberately no Set-StrictMode: this walks heterogeneous GitHub API and
# registry data, where a merely-absent property would become a hard failure.
# Presence is checked explicitly below instead.
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still defaults to TLS 1.0, which github.com refuses --
# without this the first request dies with a bare "Could not create SSL/TLS
# secure channel".
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Write-Verbose "Could not raise the TLS floor: $($_.Exception.Message)"
}

# Invoke-WebRequest redraws a progress bar per chunk on 5.1, which makes a large
# download roughly an order of magnitude slower.
$ProgressPreference = 'SilentlyContinue'

$Repo        = 'talmolab/sleap-app'
$Api         = "https://api.github.com/repos/$Repo"
$ReleasesUrl = "https://github.com/$Repo/releases"

# tauri.conf.json productName -> SLEAP_<ver>_x64-setup.exe, and the NSIS
# uninstall key Software\Microsoft\Windows\CurrentVersion\Uninstall\SLEAP.
$AppName = 'SLEAP'
# Cargo package name -> the installed executable and the running process name.
$BinName = 'sleap-app'

function Write-Step { param([string] $Message) Write-Host "==> $Message" }
function Write-Note { param([string] $Message) Write-Host "    $Message" }
function Write-Fail { param([string] $Message) throw $Message }

function Test-Administrator {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return ([Security.Principal.WindowsPrincipal] $id).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-ApiHeaders {
    $headers = @{
        'Accept'     = 'application/vnd.github+json'
        'User-Agent' = 'sleap-app-installer'
    }
    $token = $null
    if ($env:GITHUB_TOKEN) {
        $token = $env:GITHUB_TOKEN
    } elseif ($env:GH_TOKEN) {
        $token = $env:GH_TOKEN
    }
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    return $headers
}

function Invoke-GitHubApi {
    param([string] $Uri)
    try {
        return Invoke-RestMethod -Uri $Uri -Headers (Get-ApiHeaders) -UseBasicParsing
    } catch {
        $code = 0
        try { $code = [int] $_.Exception.Response.StatusCode } catch { $code = 0 }
        if ($code -eq 403 -or $code -eq 429) {
            # Single-quoted here-string: the $env: reference below is literal
            # advice for the reader, not something to expand now.
            Write-Fail @'
GitHub API rate limit reached for this IP (60 requests/hour when
unauthenticated, which a shared campus or VPN address burns through fast).
Options:
  - wait an hour, or
  - set a token and re-run:  $env:GITHUB_TOKEN = '<any token, no scopes needed>'
  - or download a build by hand and install it directly:
      .\install.ps1 -Path <the file you downloaded>
'@
        }
        return $null
    }
}

# Preference-ordered filename patterns for this machine. NSIS first: it is
# Tauri's default, installs per-user without elevation, and is what the in-app
# updater uses.
function Get-AssetPatterns {
    $arch = "$env:PROCESSOR_ARCHITECTURE"
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = "$env:PROCESSOR_ARCHITEW6432" }
    if ($arch -eq 'ARM64') {
        # x64 runs under emulation on ARM, so take it only as a fallback.
        return @(
            "$AppName`_*_arm64-setup.exe",
            "$AppName`_*_x64-setup.exe",
            "$AppName`_*_arm64_*.msi",
            "$AppName`_*_x64_*.msi"
        )
    }
    return @("$AppName`_*_x64-setup.exe", "$AppName`_*_x64_*.msi")
}

# Pick one asset out of a release. Among several matches, an asset whose filename
# carries the release's own version wins, so a stale artifact accidentally
# attached to a newer tag is never preferred just because it uploaded first.
function Select-Asset {
    param($Release)
    if (-not $Release) { return $null }
    if (-not $Release.assets) { return $null }
    $version = "$($Release.tag_name)" -replace '^v', ''

    foreach ($pattern in (Get-AssetPatterns)) {
        $hits = @($Release.assets | Where-Object { $_.name -like $pattern })
        if ($hits.Count -eq 0) { continue }
        if ($version) {
            $exact = $hits | Where-Object { $_.name -like "*$version*" } | Select-Object -First 1
            if ($exact) { return $exact }
        }
        return $hits[0]
    }
    return $null
}

# At most two API calls, because unauthenticated api.github.com allows 60 per
# hour per IP. Assets come out of the list response itself rather than being
# re-fetched per candidate tag.
function Resolve-Asset {
    Write-Step 'Resolving the SLEAP release'

    if ($Tag) {
        # An explicit tag is explicit consent: no draft/pre-release filtering,
        # and never silently fall back to a different tag.
        $rel = Invoke-GitHubApi "$Api/releases/tags/$Tag"
        if (-not $rel) {
            Write-Fail "No release tagged '$Tag' in $Repo. Tags that exist: $ReleasesUrl"
        }
        $asset = Select-Asset $rel
        if (-not $asset) {
            Write-Fail "Release $Tag has no Windows installer. Assets: $ReleasesUrl/tag/$Tag"
        }
        return $asset
    }

    if (-not $Pre) {
        $rel = Invoke-GitHubApi "$Api/releases/latest"
        $asset = Select-Asset $rel
        if ($asset) { return $asset }
        if ($rel) {
            Write-Note "The latest release has no Windows build yet."
        }
    }

    Write-Note 'Looking for the newest release that does...'
    $all = Invoke-GitHubApi "$Api/releases?per_page=30"
    if (-not $all) {
        Write-Fail "Could not reach the GitHub API. See $ReleasesUrl and retry, or use -Path."
    }
    foreach ($r in $all) {
        # Drafts ARE visible to an authenticated request, and this repo carries a
        # stale draft whose assets use an older product name.
        if ($r.draft) { continue }
        if ($r.prerelease -and -not $Pre) { continue }
        $asset = Select-Asset $r
        if ($asset) { return $asset }
    }

    Write-Fail @"
No SLEAP release in $Repo has a Windows installer.

The usual cause is a release whose build never finished, so nothing was ever
attached to it. Check $ReleasesUrl
Pre-releases are skipped unless you pass -Pre.

If you already have a build -- including a .zip straight off the GitHub Actions
artifact page -- install it directly:
  .\install.ps1 -Path <the file you downloaded>
"@
}

# Clear the Mark-of-the-Web: the Windows analogue of macOS quarantine. Anything a
# browser downloaded carries it, Expand-Archive propagates it to every extracted
# file, and it is what makes SmartScreen block an unsigned installer.
function Clear-MarkOfTheWeb {
    param([Parameter(Mandatory)] [string] $LiteralPath)
    if (-not (Get-Command Unblock-File -ErrorAction SilentlyContinue)) { return }
    try {
        if (Test-Path -LiteralPath $LiteralPath -PathType Container) {
            Get-ChildItem -LiteralPath $LiteralPath -Recurse -File -ErrorAction SilentlyContinue |
                Unblock-File -ErrorAction SilentlyContinue
        } else {
            Unblock-File -LiteralPath $LiteralPath -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Verbose "Unblock-File failed: $($_.Exception.Message)"
    }
}

function Save-Asset {
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [string] $Destination,
        [long] $ExpectedBytes = 0
    )
    Write-Step "Downloading $(Split-Path -Leaf $Destination)"
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -Headers (Get-ApiHeaders) -UseBasicParsing

    if (-not (Test-Path -LiteralPath $Destination)) {
        Write-Fail "Download produced no file: $Destination"
    }
    $actual = (Get-Item -LiteralPath $Destination).Length
    if ($actual -eq 0) { Write-Fail "Downloaded file is empty: $Destination" }

    # A truncated download is the most common way a large asset fails, and a
    # half-written installer fails much later with a useless message. GitHub
    # publishes the exact size, so check it here where we can say why.
    if ($ExpectedBytes -gt 0 -and $actual -ne $ExpectedBytes) {
        Write-Fail ("Download is incomplete: got $actual bytes, expected $ExpectedBytes. " +
            'Check your network (or a proxy that rewrites downloads) and re-run.')
    }
    Clear-MarkOfTheWeb $Destination
}

# Tauri's NSIS installer contains `IfSilent kill_<id>`: in SILENT mode it
# TERMINATES a running instance without asking. For a labeling app that means
# unsaved work vanishes, so refuse rather than let /S do it quietly.
function Assert-NotRunning {
    $running = @(Get-Process -Name $BinName -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }

    if ($Interactive) {
        Write-Note "$AppName is running; the wizard will ask before closing it."
        return
    }
    if ($Force) {
        Write-Warning ("$AppName is running and -Force was given: the silent installer " +
            'will close it immediately and unsaved labels will be lost.')
        return
    }
    Write-Fail @"
$AppName is currently running (PID $($running[0].Id)).

The silent installer would close it without asking, losing unsaved labels.
Pick one:
  - quit $AppName and re-run this script, or
  - re-run with -Interactive to get the wizard, which asks first, or
  - re-run with -Force to accept losing unsaved work.
"@
}

# Read where the app actually landed. NSIS records this, which beats assuming the
# default: a previous per-machine install lives under Program Files, and NSIS
# restores that location on upgrade.
function Get-InstalledInfo {
    foreach ($root in @('HKCU:', 'HKLM:')) {
        $key = "$root\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
        if (-not (Test-Path -LiteralPath $key)) { continue }

        $props = $null
        try { $props = Get-ItemProperty -LiteralPath $key } catch { continue }
        if (-not $props) { continue }
        $names = @($props.PSObject.Properties.Name)

        $dir = $null
        if ($names -contains 'InstallLocation' -and $props.InstallLocation) {
            # NSIS writes this value WITH literal surrounding quote characters
            # (WriteRegStr ... "InstallLocation" "$\"$INSTDIR$\"").
            $dir = "$($props.InstallLocation)".Trim('"')
        }
        if (-not $dir) { continue }

        $exeName = "$BinName.exe"
        if ($names -contains 'MainBinaryName' -and $props.MainBinaryName) {
            $exeName = "$($props.MainBinaryName)".Trim('"')
        }
        $version = $null
        if ($names -contains 'DisplayVersion') { $version = $props.DisplayVersion }

        $scope = 'user'
        if ($root -eq 'HKLM:') { $scope = 'machine' }

        return [pscustomobject]@{
            Dir     = $dir
            Exe     = (Join-Path $dir $exeName)
            Version = $version
            Scope   = $scope
        }
    }
    return $null
}

function Invoke-Installer {
    param([Parameter(Mandatory)] [string] $InstallerPath)

    $existing = Get-InstalledInfo
    if ($existing -and $existing.Scope -eq 'machine' -and -not (Test-Administrator)) {
        Write-Warning ("$AppName is currently installed for all users, so the installer " +
            'must elevate. If it fails, re-run this from an Administrator PowerShell.')
    }

    $proc = $null
    if ($InstallerPath -like '*.msi') {
        $msiArgs = @('/i', "`"$InstallerPath`"")
        if ($Interactive) { $msiArgs += '/qb' } else { $msiArgs += '/qn' }
        Write-Step 'Running the MSI installer'
        $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
    } elseif ($Interactive) {
        Write-Step 'Launching the installer wizard'
        $proc = Start-Process -FilePath $InstallerPath -Wait -PassThru
    } else {
        # NSIS: /S is silent. No /NCRC -- the CRC check is a free integrity check.
        Write-Step 'Running the installer (silent)'
        Write-Note 'Re-run with -Interactive to click through it instead.'
        $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
    }

    # -Wait plus -PassThru is a known-flaky pairing for ExitCode; wait explicitly.
    try { $proc.WaitForExit() } catch { }
    $code = 0
    try { $code = [int] $proc.ExitCode } catch { $code = 0 }

    if ($code -ne 0) {
        if ($code -eq 1602 -or $code -eq 1) {
            Write-Fail "The installer was cancelled (exit code $code)."
        }
        Write-Fail @"
The installer failed with exit code $code.

SLEAP is not code-signed, so if Windows blocked it, run the installer by hand and
choose "More info" then "Run anyway":
  $InstallerPath
"@
    }
}

function Complete-Install {
    $info = Get-InstalledInfo
    if (-not $info) {
        Write-Fail @"
The installer reported success but recorded nothing under
Uninstall\$AppName. Look for "$AppName" in Settings > Apps, or run the
installer by hand from $ReleasesUrl/latest
"@
    }
    if (-not (Test-Path -LiteralPath $info.Exe)) {
        Write-Fail "The installer reported success but $($info.Exe) is missing."
    }

    $versionText = ''
    if ($info.Version) { $versionText = " v$($info.Version)" }

    Write-Host ''
    Write-Host "Installed $AppName$versionText to $($info.Dir)"
    Write-Host ''
    Write-Host "Open it from the Start Menu (search for $AppName), or run:"
    Write-Host "  & '$($info.Exe)'"
    Write-Host ''
    Write-Host "Uninstall: Settings > Apps > $AppName"
}

function Install-FromZip {
    param(
        [Parameter(Mandatory)] [string] $ZipPath,
        [Parameter(Mandatory)] [string] $WorkDir
    )
    $dest = Join-Path $WorkDir 'unzip'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Write-Step "Extracting $(Split-Path -Leaf $ZipPath)"
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $dest -Force
    # Expand-Archive stamps the Mark-of-the-Web onto everything it writes.
    Clear-MarkOfTheWeb $dest

    # Prefer the NSIS setup .exe.
    $found = Get-ChildItem -LiteralPath $dest -Recurse -File |
        Where-Object { $_.Name -like '*-setup.exe' } | Select-Object -First 1
    if (-not $found) {
        $found = Get-ChildItem -LiteralPath $dest -Recurse -File |
            Where-Object { $_.Extension -ieq '.msi' } | Select-Object -First 1
    }
    if (-not $found) { Write-Fail "No *-setup.exe or *.msi inside $ZipPath" }
    return $found.FullName
}

function Invoke-Main {
    $workDir = Join-Path ([IO.Path]::GetTempPath()) ('sleap-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $workDir | Out-Null
    try {
        $installer = $null

        if ($Path) {
            $resolved = $null
            try {
                $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
            } catch {
                Write-Fail "No such file: $Path"
            }
            Clear-MarkOfTheWeb $resolved

            if ($resolved -like '*.zip') {
                $installer = Install-FromZip -ZipPath $resolved -WorkDir $workDir
            } elseif ($resolved -like '*.exe' -or $resolved -like '*.msi') {
                $installer = $resolved
            } else {
                Write-Fail "Don't know how to install '$Path'. Supported: .exe, .msi, .zip"
            }
        } else {
            $asset = Resolve-Asset
            $installer = Join-Path $workDir $asset.name
            $size = 0
            if ($asset.PSObject.Properties.Name -contains 'size') { $size = [long] $asset.size }
            Save-Asset -Uri $asset.browser_download_url -Destination $installer -ExpectedBytes $size
        }

        Assert-NotRunning
        Invoke-Installer -InstallerPath $installer
        Complete-Install
    } finally {
        if (Test-Path -LiteralPath $workDir) {
            Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Invoke-Main
