@echo off
rem Runs Foreman in development mode: UI edits hot-reload, main/preload
rem edits restart the app. Close the app window or press Ctrl+C here to stop.
setlocal
cd /d "%~dp0"

if exist ".tools\node\node.exe" set "PATH=%~dp0.tools\node;%PATH%"
rem Inherited from VS Code / Claude Code; makes Electron run as plain Node.
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Put a portable Node in .tools\node or install Node.js.
  pause
  exit /b 1
)

if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm run dev
if errorlevel 1 pause
