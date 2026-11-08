param([Parameter(Mandatory=$true)][string]$Settings,[Parameter(Mandatory=$true)][string]$Notification)
$ErrorActionPreference = 'Stop'
$relay = Get-Content -Encoding UTF8 -LiteralPath $Settings -Raw | ConvertFrom-Json
# Windows PowerShell 5 removes embedded quotes when forwarding native arguments.
# Pass the event losslessly; Node then invokes the existing notifier directly.
$encodedNotification = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Notification))
try {
    & $relay.node (Join-Path $relay.programDirectory 'packages/application/desktop-notify.mjs') $Settings '--base64' $encodedNotification | Out-Null
} catch { }
