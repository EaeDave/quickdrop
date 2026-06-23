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

function Resolve-PathValue {
  param([object]$Path)

  if ($null -eq $Path) {
    return $null
  }

  $Candidate = ([string]$Path).Trim()
  if (-not $Candidate) {
    return $null
  }

  $Candidate = [System.Environment]::ExpandEnvironmentVariables($Candidate)
  if ($Candidate.StartsWith('"')) {
    $ClosingQuote = $Candidate.IndexOf('"', 1)
    if ($ClosingQuote -gt 0) {
      return $Candidate.Substring(1, $ClosingQuote - 1).Trim()
    }
  }

  return ($Candidate -split ",", 2)[0].Trim().Trim('"').Trim("'")
}

function Resolve-DirectoryPath {
  param([object]$Path)

  $Candidate = Resolve-PathValue $Path
  if (-not $Candidate) {
    return $null
  }

  if ([System.IO.Path]::GetExtension($Candidate) -ieq ".exe") {
    return [System.IO.Path]::GetDirectoryName($Candidate)
  }

  return $Candidate
}

function Resolve-ExecutablePath {
  param([object]$Path)

  return Resolve-PathValue $Path
}

function Join-OptionalPath {
  param(
    [object]$Directory,
    [string]$ChildPath
  )

  $ResolvedDirectory = Resolve-DirectoryPath $Directory
  if (-not $ResolvedDirectory) {
    return $null
  }

  try {
    return Join-Path -Path $ResolvedDirectory -ChildPath $ChildPath
  } catch {
    return $null
  }
}

function Test-ExistingFile {
  param([object]$Path)

  if (-not $Path) {
    return $false
  }

  try {
    return Test-Path -LiteralPath ([string]$Path) -PathType Leaf
  } catch {
    return $false
  }
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
        $Candidate = Join-OptionalPath $InstallLocationProperty.Value "$AppName.exe"
        if ($Candidate -and (Test-ExistingFile $Candidate)) {
          return $Candidate
        }
      }

      $DisplayIconProperty = $InstalledApp.PSObject.Properties["DisplayIcon"]
      if ($null -ne $DisplayIconProperty -and $DisplayIconProperty.Value) {
        $Candidate = Resolve-ExecutablePath $DisplayIconProperty.Value
        if ($Candidate -and (Test-ExistingFile $Candidate)) {
          return $Candidate
        }
      }
    }
  }

  $FallbackDirectories = @()
  if ($env:LOCALAPPDATA) {
    $LocalAppDataPrograms = Join-OptionalPath $env:LOCALAPPDATA "Programs"
    if ($LocalAppDataPrograms) {
      $FallbackDirectories += Join-OptionalPath $LocalAppDataPrograms $AppName
    }

    $FallbackDirectories += Join-OptionalPath $env:LOCALAPPDATA $AppName
  }
  if ($env:ProgramFiles) {
    $FallbackDirectories += Join-OptionalPath $env:ProgramFiles $AppName
  }

  $ProgramFilesX86 = [System.Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($ProgramFilesX86) {
    $FallbackDirectories += Join-OptionalPath $ProgramFilesX86 $AppName
  }

  foreach ($Directory in $FallbackDirectories) {
    $Candidate = Join-OptionalPath $Directory "$AppName.exe"
    if ($Candidate -and (Test-ExistingFile $Candidate)) {
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
