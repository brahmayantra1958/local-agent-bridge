@echo off
setlocal
rem agent-bridge Setup. Double-click to run. Agents should call installer\bootstrap.ps1 directly.
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\bootstrap.ps1" %*
set "AB_EXIT=%ERRORLEVEL%"
if not defined AGENT_BRIDGE_NO_PAUSE pause
endlocal & exit /b %AB_EXIT%
