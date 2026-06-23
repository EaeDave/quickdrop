#requires -version 5.1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AppName = "QuickDrop"
$Repository = "EaeDave/quickdrop"
$ReleaseApiUrl = "https://api.github.com/repos/$Repository/releases/latest"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("quickdrop-install-" + [System.Guid]::NewGuid().ToString("N"))
$InstallerPath = Join-Path $TempDir "QuickDropSetup.exe"

function Resolve-InstallerUrl {
  if ($env:QUICKDROP_WINDOWS_INSTALLER_URL) {
    return $env:QUICKDROP_WINDOWS_INSTALLER_URL
  }

  Write-Host "Resolving latest QuickDrop Windows installer..."
  $release = Invoke-RestMethod -Uri $ReleaseApiUrl -Headers @{ "User-Agent" = "quickdrop-installer" }
  $asset = $release.assets |
    Where-Object { $_.name -like "QuickDrop_*_x64-setup.exe" } |
    Select-Object -First 1

  if (-not $asset) {
    throw "No QuickDrop Windows x64 installer asset found in the latest GitHub release."
  }

  return $asset.browser_download_url
}

try {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This installer is only supported on Windows."
  }

  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

  $InstallerUrl = Resolve-InstallerUrl
  Write-Host "Downloading $AppName from $InstallerUrl"
  Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing

  $Installer = Get-Item $InstallerPath
  if ($Installer.Length -lt 1048576) {
    throw "Downloaded installer is unexpectedly small: $($Installer.Length) bytes."
  }

  Write-Host "Installing $AppName for current user..."
  $process = Start-Process -FilePath $InstallerPath -ArgumentList @("/S", "/R", "/ARGS", "--tray-start") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$AppName installer failed with exit code $($process.ExitCode)."
  }

  Write-Host "$AppName installed. It is running in the Windows system tray and will start with Windows."
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
