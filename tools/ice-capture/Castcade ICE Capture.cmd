@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ice-capture.ps1" %*
echo.
pause
