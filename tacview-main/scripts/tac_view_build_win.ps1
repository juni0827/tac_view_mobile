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
  'npx tauri build --target x86_64-pc-windows-msvc'
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
