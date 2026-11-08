@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install.ps1" -OpenBrowser
if errorlevel 1 pause
