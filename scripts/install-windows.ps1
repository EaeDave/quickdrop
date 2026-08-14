#requires -version 5.1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AppName = "QuickDrop"
$DefaultBaseUrl = if ($env:QUICKDROP_API_BASE_URL) {
  $env:QUICKDROP_API_BASE_URL.TrimEnd("/")
} elseif ($env:QUICKDROP_PUBLIC_BASE_URL) {
  $env:QUICKDROP_PUBLIC_BASE_URL.TrimEnd("/")
} else {
  "__QUICKDROP_PUBLIC_BASE_URL__"
}
$DefaultInstallerUrl = "$DefaultBaseUrl/windows/latest.exe"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("quickdrop-install-" + [System.Guid]::NewGuid().ToString("N"))
$DefaultQdUrl = "$DefaultBaseUrl/windows/qd/latest.exe"
$DefaultQdChecksumUrl = "$DefaultBaseUrl/windows/qd/latest.sha256"
$MinimumBinaryBytes = 1048576
$InstallerPath = Join-Path $TempDir "QuickDropSetup.exe"
$QdDownloadPath = Join-Path $TempDir "qd.exe"
$QdChecksumPath = Join-Path $TempDir "qd.exe.sha256"

function Resolve-InstallerUrl {
  if ($env:QUICKDROP_WINDOWS_INSTALLER_URL) {
    return $env:QUICKDROP_WINDOWS_INSTALLER_URL
  }

  return $DefaultInstallerUrl
}

function Resolve-QdUrl {
  if ($env:QUICKDROP_WINDOWS_QD_URL) {
    return $env:QUICKDROP_WINDOWS_QD_URL
  }

  return $DefaultQdUrl
}

function Resolve-QdChecksumUrl {
  if ($env:QUICKDROP_WINDOWS_QD_CHECKSUM_URL) {
    return $env:QUICKDROP_WINDOWS_QD_CHECKSUM_URL
  }

  return $DefaultQdChecksumUrl
}

function Install-Qd {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is required to install qd."
  }

  $QdBinDirectory = if ($env:QUICKDROP_WINDOWS_QD_BIN_DIR) {
    [System.Environment]::ExpandEnvironmentVariables($env:QUICKDROP_WINDOWS_QD_BIN_DIR)
  } else {
    Join-Path $env:LOCALAPPDATA "QuickDrop\\bin"
  }
  New-Item -ItemType Directory -Path $QdBinDirectory -Force | Out-Null
  Copy-Item -LiteralPath $QdDownloadPath -Destination (Join-Path $QdBinDirectory "qd.exe") -Force

  $UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $PathEntries = @($UserPath -split ";" | Where-Object { $_ })
  if (-not ($PathEntries | Where-Object { $_.TrimEnd("\\") -ieq $QdBinDirectory.TrimEnd("\\") })) {
    $UpdatedPath = (@($QdBinDirectory) + $PathEntries) -join ";"
    [System.Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")
  }
  if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\\") -ieq $QdBinDirectory.TrimEnd("\\") })) {
    $env:Path = "$QdBinDirectory;$env:Path"
  }

  Write-Host "Installed qd CLI/TUI to $QdBinDirectory\\qd.exe"
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
  $QdUrl = Resolve-QdUrl
  $QdChecksumUrl = Resolve-QdChecksumUrl
  Write-Host "Downloading qd CLI/TUI from $QdUrl"
  Invoke-WebRequest -Uri $QdUrl -OutFile $QdDownloadPath -UseBasicParsing
  Invoke-WebRequest -Uri $QdChecksumUrl -OutFile $QdChecksumPath -UseBasicParsing

  $QdBinary = Get-Item $QdDownloadPath
  if ($QdBinary.Length -lt $MinimumBinaryBytes) {
    throw "Downloaded qd binary is unexpectedly small: $($QdBinary.Length) bytes."
  }
  $ExpectedChecksum = ((Get-Content -LiteralPath $QdChecksumPath -Raw).Trim() -split "\s+")[0]
  if ($ExpectedChecksum -notmatch "^[a-fA-F0-9]{64}$") {
    throw "Downloaded qd checksum is invalid."
  }
  $ActualChecksum = (Get-FileHash -LiteralPath $QdDownloadPath -Algorithm SHA256).Hash
  if ($ActualChecksum -ine $ExpectedChecksum) {
    throw "Downloaded qd binary failed checksum verification."
  }
  Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing

  $Installer = Get-Item $InstallerPath
  if ($Installer.Length -lt $MinimumBinaryBytes) {
    throw "Downloaded installer is unexpectedly small: $($Installer.Length) bytes."
  }

  Write-Host "Installing $AppName for current user..."
  $process = Start-Process -FilePath $InstallerPath -ArgumentList @("/S") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$AppName installer failed with exit code $($process.ExitCode)."
  }

  Install-Qd

  Start-InstalledQuickDrop
  Write-Host "$AppName and qd are installed. QuickDrop will start with Windows."
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
