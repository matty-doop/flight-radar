@echo off
cd /d "%~dp0"

rem Use a copy of node.exe sitting in this folder if there is one (no install needed),
rem otherwise the Node.js installed on this computer.
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"

"%NODE%" --version >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Either install it from https://nodejs.org  ^(the LTS version^),
  echo or copy node.exe into this folder, then run start.bat again.
  pause
  exit /b 1
)

start "" http://localhost:8642
"%NODE%" server.js
pause
