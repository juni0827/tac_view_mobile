$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$stdoutLogPath = Join-Path $repoRoot 'tac_view-dev.stdout.log'
$stderrLogPath = Join-Path $repoRoot 'tac_view-dev.stderr.log'
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'

foreach ($path in @($stdoutLogPath, $stderrLogPath)) {
  if (Test-Path $path) {
    Remove-Item $path -Force
  }
}

$cmd = "call `"$vsDevCmd`" -arch=x64 && set `"PATH=%PATH%;C:\Windows\Temp\cargo-bin`" && npm run tauri:dev"

$process = Start-Process cmd.exe -ArgumentList '/d', '/v:on', '/c', $cmd -PassThru -WorkingDirectory $repoRoot -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath

try {
  Start-Sleep -Seconds 45
  $stdoutLog = if (Test-Path $stdoutLogPath) { Get-Content $stdoutLogPath -Raw } else { '' }
  $stderrLog = if (Test-Path $stderrLogPath) { Get-Content $stderrLogPath -Raw } else { '' }
  $combinedLog = (@($stdoutLog, $stderrLog) -join [Environment]::NewLine).Trim()

  $hasLogMarker = $combinedLog -match 'READY \{' -or $combinedLog -match 'beforeDevCommand' -or $combinedLog -match 'Watching' -or $combinedLog -match 'Local:\s+http://localhost:5173'
  $viteReady = $false
  try {
    $viteResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:5173' -UseBasicParsing -TimeoutSec 5
    $viteReady = $viteResponse.StatusCode -ge 200 -and $viteResponse.StatusCode -lt 500
  } catch {
    $viteReady = $false
  }

  $desktopRunning = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like '*tac_view.exe' -or $_.ExecutablePath -like '*tac_view-sidecar*'
  }).Count -gt 0

  if (-not ($hasLogMarker -or $viteReady -or $desktopRunning)) {
    throw "tauri dev did not emit expected startup markers.`nSTDOUT:`n$stdoutLog`nSTDERR:`n$stderrLog"
  }

  Write-Output $combinedLog
} finally {
  if ($process -and -not $process.HasExited) {
    taskkill /PID $process.Id /T /F | Out-Null
  }
}
