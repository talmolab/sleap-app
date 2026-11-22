<#
.SYNOPSIS
  Authenticode-sign the Windows desktop build with Azure Artifact Signing.

.DESCRIPTION
  Used by .github/workflows/build.yml and build-dev.yml. Three subcommands:

    configure        Run once, before `tauri build`. If signing is configured
                     (see below), downloads signtool and the Artifact Signing
                     dlib, writes the dlib's metadata.json and a Tauri config
                     overlay whose bundle.windows.signCommand points back at
                     this script, then proves the setup works by signing a
                     throwaway file -- so a misconfiguration fails in seconds,
                     not after a 15-minute Rust build.
                     With signing NOT configured it only records that, and the
                     build ships unsigned exactly as before.

    sign <file>      Invoked by Tauri (via signCommand) once per file: the app
                     exe, the ffmpeg/ffprobe sidecars, the NSIS installer (and
                     its uninstaller) and the MSI. Signing happens INSIDE the
                     bundler, so the updater's minisign signature is computed
                     over the already-Authenticode-signed installer. Signing
                     afterwards would invalidate every updater .sig.

    verify <bundle>  Run after `tauri build`. With signing configured, asserts
                     every shipped binary carries a valid, timestamped
                     signature. An Artifact Signing certificate lives only
                     three days, so an untimestamped signature would expire
                     almost immediately.

  Authentication is GitHub OIDC -> Entra workload identity federation: no
  client secret exists anywhere. The dlib authenticates with
  DefaultAzureCredential, restricted here to WorkloadIdentityCredential, which
  reads a GitHub-issued token from AZURE_FEDERATED_TOKEN_FILE. Those tokens are
  short-lived, so `sign` fetches a fresh one before every signature instead of
  trusting one minted before the build started.

  Configuration comes from GitHub Actions *variables* (none of it is secret) on
  the `code-signing` environment. Signing is enabled only when
  ARTIFACT_SIGNING_PROFILE is set; see docs/.internal/windows-code-signing.md
  and scripts/setup-windows-signing.sh.
#>
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet('configure', 'sign', 'verify')]
  [string] $Command,

  [Parameter(Position = 1)]
  [string] $Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Pinned so a bad upstream release cannot silently change what signs our
# binaries. The dlib needs signtool from Windows SDK 10.0.26100 or newer.
$SdkBuildToolsVersion = '10.0.28000.2957'
$ArtifactSigningClientVersion = '1.0.151'
$TimestampUrl = 'http://timestamp.acs.microsoft.com'

function Add-GitHubEnv([string] $Name, [string] $Value) {
  Add-Content -Path $env:GITHUB_ENV -Value "$Name=$Value" -Encoding utf8
  Set-Item -Path "env:$Name" -Value $Value
}

function Get-EnvOrEmpty([string] $Name) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $v) { return '' }
  return $v.Trim()
}

function Install-NuGetPackage([string] $Id, [string] $Version, [string] $Dest) {
  $lower = $Id.ToLowerInvariant()
  $url = "https://api.nuget.org/v3-flatcontainer/$lower/$Version/$lower.$Version.nupkg"
  $zip = Join-Path $env:RUNNER_TEMP "$lower.$Version.zip"
  Write-Host "Downloading $Id $Version"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $Dest -Force
}

function Find-X64File([string] $Root, [string] $Name) {
  $hit = Get-ChildItem -Path $Root -Recurse -Filter $Name -File |
    Where-Object { $_.FullName -match '[\\/]x64[\\/]' } |
    Select-Object -First 1
  if (-not $hit) { throw "no x64 $Name found under $Root" }
  return $hit.FullName
}

# GitHub hands a job an OIDC token only via this request endpoint, and only
# when the job has `permissions: id-token: write`.
function Update-FederatedToken {
  if (-not $env:ACTIONS_ID_TOKEN_REQUEST_URL -or -not $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw 'GitHub OIDC is unavailable: the job needs `permissions: id-token: write`.'
  }
  $uri = "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=api://AzureADTokenExchange"
  $resp = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)" }
  Set-Content -Path $env:AZURE_FEDERATED_TOKEN_FILE -Value $resp.value -NoNewline -Encoding ascii
}

function Invoke-Sign([string] $File) {
  foreach ($name in 'SLEAP_SIGNTOOL', 'SLEAP_SIGN_DLIB', 'SLEAP_SIGN_METADATA', 'AZURE_FEDERATED_TOKEN_FILE') {
    if (-not (Get-EnvOrEmpty $name)) { throw "$name is not set -- run 'windows-signing.ps1 configure' first" }
  }
  if (-not (Test-Path -LiteralPath $File)) { throw "file to sign does not exist: $File" }

  # The signing service is a network call; ride out a transient failure
  # rather than discarding a finished build over one dropped request.
  $attempts = 3
  for ($i = 1; $i -le $attempts; $i++) {
    Update-FederatedToken
    & $env:SLEAP_SIGNTOOL sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 `
      /dlib $env:SLEAP_SIGN_DLIB /dmdf $env:SLEAP_SIGN_METADATA $File
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Signed $File"
      return
    }
    Write-Warning "signtool exited $LASTEXITCODE signing $File (attempt $i of $attempts)"
    if ($i -lt $attempts) { Start-Sleep -Seconds (10 * $i) }
  }
  throw "failed to sign $File after $attempts attempts"
}

function Assert-Signed([string] $File) {
  $sig = Get-AuthenticodeSignature -LiteralPath $File
  $name = Split-Path -Leaf $File
  if ($sig.Status -ne 'Valid') {
    throw "$name is not validly signed (status: $($sig.Status); $($sig.StatusMessage))"
  }
  if (-not $sig.TimeStamperCertificate) {
    throw "$name is signed but NOT timestamped -- it stops validating when the 3-day certificate expires"
  }
  Write-Host ("ok: {0} -- {1} (timestamped by {2})" -f $name, $sig.SignerCertificate.Subject, $sig.TimeStamperCertificate.Subject)
  # Subject, not thumbprint: Artifact Signing rotates its short-lived
  # certificate daily, so one build crossing midnight UTC can carry two.
  return $sig.SignerCertificate.Subject
}

switch ($Command) {
  'configure' {
    $profileName = Get-EnvOrEmpty 'ARTIFACT_SIGNING_PROFILE'
    if (-not $profileName) {
      Add-GitHubEnv 'SLEAP_WINDOWS_SIGNING' 'unsigned'
      Add-GitHubEnv 'SLEAP_TAURI_SIGN_ARGS' ''
      Write-Host ('::notice::Windows code signing is not configured (no ARTIFACT_SIGNING_PROFILE ' +
        'variable) -- building UNSIGNED; SmartScreen will warn on download. ' +
        'See docs/.internal/windows-code-signing.md.')
      exit 0
    }

    $required = 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT'
    $missing = @($required | Where-Object { -not (Get-EnvOrEmpty $_) })
    if ($missing.Count -gt 0) {
      # A half-configured setup is a mistake, not a choice: shipping unsigned
      # here would hide it, so fail instead.
      throw "ARTIFACT_SIGNING_PROFILE is set but these variables are missing: $($missing -join ', ')"
    }

    $root = Join-Path $env:RUNNER_TEMP 'artifact-signing'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Install-NuGetPackage 'Microsoft.Windows.SDK.BuildTools' $SdkBuildToolsVersion (Join-Path $root 'sdk')
    Install-NuGetPackage 'Microsoft.ArtifactSigning.Client' $ArtifactSigningClientVersion (Join-Path $root 'dlib')
    $signtool = Find-X64File (Join-Path $root 'sdk') 'signtool.exe'
    $dlib = Find-X64File (Join-Path $root 'dlib') 'Azure.CodeSigning.Dlib.dll'

    # Everything but WorkloadIdentityCredential is excluded, so a stray
    # credential on the runner can never be what ends up signing a release.
    $metadataPath = Join-Path $root 'metadata.json'
    [ordered]@{
      Endpoint               = (Get-EnvOrEmpty 'ARTIFACT_SIGNING_ENDPOINT')
      CodeSigningAccountName = (Get-EnvOrEmpty 'ARTIFACT_SIGNING_ACCOUNT')
      CertificateProfileName = $profileName
      CorrelationId          = "$($env:GITHUB_REPOSITORY)@$($env:GITHUB_SHA) run $($env:GITHUB_RUN_ID)"
      ExcludeCredentials     = @(
        'EnvironmentCredential', 'ManagedIdentityCredential', 'SharedTokenCacheCredential',
        'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzureCliCredential',
        'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
      )
    } | ConvertTo-Json | Set-Content -Path $metadataPath -Encoding utf8

    # Object form of signCommand: the string form is split on spaces, which a
    # path under "C:\Program Files" (or anywhere else) would break.
    $overlayPath = Join-Path $root 'tauri.signing.conf.json'
    @{
      bundle = @{
        windows = @{
          signCommand = @{
            cmd  = 'pwsh'
            args = @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'windows-signing.ps1'), 'sign', '%1')
          }
        }
      }
    } | ConvertTo-Json -Depth 6 | Set-Content -Path $overlayPath -Encoding utf8

    Add-GitHubEnv 'SLEAP_WINDOWS_SIGNING' 'artifact-signing'
    Add-GitHubEnv 'SLEAP_SIGNTOOL' $signtool
    Add-GitHubEnv 'SLEAP_SIGN_DLIB' $dlib
    Add-GitHubEnv 'SLEAP_SIGN_METADATA' $metadataPath
    Add-GitHubEnv 'AZURE_CLIENT_ID' (Get-EnvOrEmpty 'AZURE_CLIENT_ID')
    Add-GitHubEnv 'AZURE_TENANT_ID' (Get-EnvOrEmpty 'AZURE_TENANT_ID')
    Add-GitHubEnv 'AZURE_FEDERATED_TOKEN_FILE' (Join-Path $root 'github-oidc.jwt')
    # Forward slashes: tauri-action splits `args` like a shell would, and a
    # backslash path is the kind of thing that splitting mangles.
    Add-GitHubEnv 'SLEAP_TAURI_SIGN_ARGS' "--config $($overlayPath -replace '\\', '/')"

    # Preflight: sign a throwaway copy of a small system exe end to end
    # (OIDC token -> Entra -> signing service -> timestamp), then verify it.
    $probe = Join-Path $root 'preflight.exe'
    Copy-Item -Path (Join-Path $env:SystemRoot 'System32\where.exe') -Destination $probe -Force
    Invoke-Sign $probe
    Assert-Signed $probe | Out-Null
    Write-Host "Windows code signing enabled (account $(Get-EnvOrEmpty 'ARTIFACT_SIGNING_ACCOUNT'), profile $profileName)."
  }

  'sign' {
    if (-not $Path) { throw 'usage: windows-signing.ps1 sign <file>' }
    try {
      Invoke-Sign $Path
    } catch {
      # Tauri only sees the exit code; make the reason visible in the log.
      Write-Host "::error::$($_.Exception.Message)"
      exit 1
    }
  }

  'verify' {
    if (-not $Path) { throw 'usage: windows-signing.ps1 verify <bundle-dir>' }
    $bundle = (Resolve-Path -LiteralPath $Path).Path
    $releaseDir = Split-Path -Parent $bundle

    $installers = @(
      Get-ChildItem -Path (Join-Path $bundle 'nsis'), (Join-Path $bundle 'msi') -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.exe', '.msi' }
    )
    if ($installers.Count -eq 0) { throw "no installers found under $bundle\nsis or $bundle\msi" }

    if ((Get-EnvOrEmpty 'SLEAP_WINDOWS_SIGNING') -ne 'artifact-signing') {
      Write-Host "Windows signing not configured; these installers are UNSIGNED:"
      $installers | ForEach-Object { Write-Host "  $($_.Name)" }
      exit 0
    }

    # The app exe and sidecars are packed inside the installers; their signed
    # copies in target/release are what went in.
    $files = @($installers | ForEach-Object { $_.FullName })
    $mainExe = Join-Path $releaseDir 'sleap-app.exe'
    if (-not (Test-Path -LiteralPath $mainExe)) { throw "app binary not found: $mainExe" }
    $files += $mainExe
    foreach ($sidecar in 'ffmpeg.exe', 'ffprobe.exe') {
      $p = Join-Path $releaseDir $sidecar
      if (Test-Path -LiteralPath $p) {
        $files += $p
      } else {
        Write-Host "::warning::sidecar copy not found at $p -- not verified here (Tauri still signs it while bundling)"
      }
    }

    $subjects = @($files | ForEach-Object { Assert-Signed $_ } | Sort-Object -Unique)
    if ($subjects.Count -ne 1) {
      throw "binaries were signed by $($subjects.Count) different identities: $($subjects -join ' | ')"
    }
    Write-Host "All $($files.Count) Windows binaries carry a valid, timestamped signature."
  }
}
