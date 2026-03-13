@echo off
setlocal
pushd "%~dp0RUN"
if not exist "tac_view.exe" (
  echo RUN\tac_view.exe not found. Build the desktop app first with npm run tauri:build:win.
  exit /b 1
)
start "" ".\\tac_view.exe"
popd
