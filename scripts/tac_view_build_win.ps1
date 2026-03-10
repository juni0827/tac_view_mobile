$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
$cargoTempBin = 'C:\Windows\Temp\cargo-bin'
$userCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

$cargoPathParts = @($cargoTempBin, $userCargoBin) | Where-Object { Test-Path $_ }
$cargoPathPrefix = ($cargoPathParts -join ';')

$commands = @(
  "call `"$vsDevCmd`" -arch=x64",
  "set `"PATH=$cargoPathPrefix;%PATH%`"",
  'npm run build:sidecar',
  'node scripts/tauri-runner.mjs build --target x86_64-pc-windows-msvc'
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

Push-Location $repoRoot
$cargoTargetRoot = (& node -e "import('./scripts/tauri-runner.mjs').then((m) => console.log(m.getScopedCargoTargetDir()))" |
  Select-Object -Last 1).Trim()
Pop-Location

if (-not $cargoTargetRoot) {
  throw 'Unable to determine scoped Tauri cargo target directory.'
}

$releaseRoot = Join-Path $cargoTargetRoot 'x86_64-pc-windows-msvc\release'
$bundleRoot = Join-Path $releaseRoot 'bundle'
$portableRoot = Join-Path $repoRoot 'TAC_VIEW'
$portableResources = Join-Path $portableRoot 'resources'

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

if (Test-Path $portableRoot) {
  Remove-Item $portableRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $portableRoot | Out-Null
Copy-Item $appExe (Join-Path $portableRoot 'tac_view.exe') -Force
Copy-Item $sidecarExe (Join-Path $portableRoot 'tac_view-sidecar.exe') -Force
Copy-Item $resourcesDir $portableResources -Recurse -Force

$installerExtension = $installer.Extension
$rootInstallerPath = Join-Path $repoRoot "TAC_VIEW_setup$installerExtension"
Copy-Item $installer.FullName $rootInstallerPath -Force

Write-Host "[desktop-build] Portable app copied to $portableRoot"
Write-Host "[desktop-build] Installer copied to $rootInstallerPath"
