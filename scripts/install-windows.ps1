#requires -version 5.1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AppName = "QuickDrop"
$DefaultInstallerUrl = "https://quickdrop.eaedave.xyz/windows/latest.exe"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("quickdrop-install-" + [System.Guid]::NewGuid().ToString("N"))
$InstallerPath = Join-Path $TempDir "QuickDropSetup.exe"

function Resolve-InstallerUrl {
  if ($env:QUICKDROP_WINDOWS_INSTALLER_URL) {
    return $env:QUICKDROP_WINDOWS_INSTALLER_URL
  }

  return $DefaultInstallerUrl
}

function Resolve-ExecutablePath {
  param([string]$Path)

  $Candidate = $Path.Trim()
  if (-not $Candidate) {
    return $null
  }

  if ($Candidate.StartsWith('"')) {
    $ClosingQuote = $Candidate.IndexOf('"', 1)
    if ($ClosingQuote -gt 0) {
      return $Candidate.Substring(1, $ClosingQuote - 1)
    }
  }

  return ($Candidate -split ",", 2)[0].Trim().Trim('"')
}

function Get-InstalledQuickDropPath {
  $RegistryRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )

  foreach ($RegistryRoot in $RegistryRoots) {
    $InstalledApps = Get-ItemProperty -Path (Join-Path $RegistryRoot "*") -ErrorAction SilentlyContinue
    foreach ($InstalledApp in $InstalledApps) {
      $DisplayNameProperty = $InstalledApp.PSObject.Properties["DisplayName"]
      if ($null -eq $DisplayNameProperty -or $DisplayNameProperty.Value -ne $AppName) {
        continue
      }

      $InstallLocationProperty = $InstalledApp.PSObject.Properties["InstallLocation"]
      if ($null -ne $InstallLocationProperty -and $InstallLocationProperty.Value) {
        $Candidate = Join-Path $InstallLocationProperty.Value "$AppName.exe"
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
          return $Candidate
        }
      }

      $DisplayIconProperty = $InstalledApp.PSObject.Properties["DisplayIcon"]
      if ($null -ne $DisplayIconProperty -and $DisplayIconProperty.Value) {
        $Candidate = Resolve-ExecutablePath $DisplayIconProperty.Value
        if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
          return $Candidate
        }
      }
    }
  }

  $FallbackDirectories = @()
  if ($env:LOCALAPPDATA) {
    $FallbackDirectories += Join-Path $env:LOCALAPPDATA "Programs\$AppName"
    $FallbackDirectories += Join-Path $env:LOCALAPPDATA $AppName
  }
  if ($env:ProgramFiles) {
    $FallbackDirectories += Join-Path $env:ProgramFiles $AppName
  }

  $ProgramFilesX86 = [System.Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($ProgramFilesX86) {
    $FallbackDirectories += Join-Path $ProgramFilesX86 $AppName
  }

  foreach ($Directory in $FallbackDirectories) {
    $Candidate = Join-Path $Directory "$AppName.exe"
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
      return $Candidate
    }
  }

  return $null
}

function Start-InstalledQuickDrop {
  $ExePath = Get-InstalledQuickDropPath
  if (-not $ExePath) {
    throw "$AppName installed, but $AppName.exe was not found."
  }

  Write-Host "Opening $AppName..."
  Start-Process -FilePath $ExePath
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
  $process = Start-Process -FilePath $InstallerPath -ArgumentList @("/S") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$AppName installer failed with exit code $($process.ExitCode)."
  }

  Start-InstalledQuickDrop
  Write-Host "$AppName installed and opened. It will start with Windows."
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
