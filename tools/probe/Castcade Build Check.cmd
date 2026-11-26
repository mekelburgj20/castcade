@echo off
rem Start a table from PinUP Popper first and leave it running, then double-click this file.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0castcade-build-check.ps1"
echo.
pause
