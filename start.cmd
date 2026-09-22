@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Codex Background Studio] Node.js 22 or newer is required.
  pause
  exit /b 1
)
node src\server.js
if errorlevel 1 pause

