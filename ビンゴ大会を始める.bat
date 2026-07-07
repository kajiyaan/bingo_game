@echo off
cd /d "%~dp0"
title BINGO Server

echo.
echo   Starting BINGO server...
echo.

if not exist "node_modules" (
  echo   First-time setup, please wait...
  call npm install --no-audit --no-fund
  echo.
)

start "" http://localhost:3000
node server.js

echo.
echo   Server stopped. You can close this window.
pause >nul
