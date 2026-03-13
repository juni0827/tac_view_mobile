$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
$cargoTempBin = 'C:\Windows\Temp\cargo-bin'
$userCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

function Get-ScopedCargoTargetDir {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RootDir
  )

  $resolvedRootDir = (Resolve-Path $RootDir).Path

  # Mirror ops/scripts/tauri-runner.mjs without depending on Node stdout decoding.
  $hashInput = "win32`0$($resolvedRootDir.ToLowerInvariant())"
  $hashBytes = [System.Text.Encoding]::UTF8.GetBytes($hashInput)
  $sha1 = [System.Security.Cryptography.SHA1]::Create()

  try {
    $repoKey = -join ($sha1.ComputeHash($hashBytes) | ForEach-Object { $_.ToString('x2') })
    return Join-Path (Join-Path (Join-Path $resolvedRootDir '.build-cache') 'tauri') $repoKey.Substring(0, 12)
  }
  finally {
    $sha1.Dispose()
  }
}

$cargoPathParts = @($cargoTempBin, $userCargoBin) | Where-Object { Test-Path $_ }
$cargoPathPrefix = ($cargoPathParts -join ';')

$commands = @(
  "call `"$vsDevCmd`" -arch=x64",
  "set `"PATH=$cargoPathPrefix;%PATH%`"",
  'npm run build:sidecar',
  'node ops/scripts/tauri-runner.mjs build --target x86_64-pc-windows-msvc'
)

$cmd = $commands -join ' && '

$process = Start-Process cmd.exe `
  -ArgumentList '/d', '/v:on', '/c', $cmd `
  -Wait `
  -PassThru `
  -WorkingDirectory $repoRoot

if ($process.ExitCode -ne 0) {
  throw "Windows Tauri build failed with exit code $($process.ExitCode)."
}

$cargoTargetRoot = Get-ScopedCargoTargetDir -RootDir $repoRoot

if (-not $cargoTargetRoot) {
  throw 'Unable to determine scoped Tauri cargo target directory.'
}

$releaseRoot = Join-Path $cargoTargetRoot 'x86_64-pc-windows-msvc\release'
$bundleRoot = Join-Path $releaseRoot 'bundle'
$runRoot = Join-Path $repoRoot 'RUN'
$runResources = Join-Path $runRoot 'resources'

$appExe = Join-Path $releaseRoot 'tac_view.exe'
$sidecarExe = Join-Path $releaseRoot 'tac_view-sidecar.exe'
$resourcesDir = Join-Path $releaseRoot 'resources'
$nsisInstaller = Get-ChildItem (Join-Path $bundleRoot 'nsis') -Filter '*setup.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$msiInstaller = Get-ChildItem (Join-Path $bundleRoot 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$installer = if ($nsisInstaller) { $nsisInstaller } else { $msiInstaller }

foreach ($requiredPath in @($appExe, $sidecarExe, $resourcesDir)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Expected build artifact not found: $requiredPath"
  }
}

if (-not $installer) {
  throw "Expected Windows installer not found under $bundleRoot"
}

if (-not (Test-Path $runRoot)) {
  New-Item -ItemType Directory -Path $runRoot | Out-Null
}

if (Test-Path $runResources) {
  Remove-Item $runResources -Recurse -Force
}

Copy-Item $appExe (Join-Path $runRoot 'tac_view.exe') -Force
Copy-Item $sidecarExe (Join-Path $runRoot 'tac_view-sidecar.exe') -Force
Copy-Item $resourcesDir $runResources -Recurse -Force

$installerExtension = $installer.Extension
$rootInstallerPath = Join-Path $runRoot "TAC_VIEW_setup$installerExtension"
Copy-Item $installer.FullName $rootInstallerPath -Force

Write-Host "[desktop-build] Desktop app copied to $runRoot"
Write-Host "[desktop-build] Installer copied to $rootInstallerPath"
