@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Console.ps1" -OpenBrowser
if errorlevel 1 pause
