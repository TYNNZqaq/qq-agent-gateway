@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stop-Console.ps1"
if errorlevel 1 pause
