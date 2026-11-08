param([Parameter(Mandatory=$true)][string]$RuntimeDirectory,[Parameter(Mandatory=$true)][int]$ClientPid,[Parameter(Mandatory=$true)][long]$ClientStartedAt)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Desktop-AutoConnect.psm1') -Force
if(-not ('QQAgent.DesktopStartEvents' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'Desktop-StartEvents.cs')}
$node=Get-QQPublicNode
$env:PATH=(Split-Path -Parent $node)+[IO.Path]::PathSeparator+$env:PATH
$RuntimeDirectory=& (Join-Path $PSScriptRoot 'Resolve-DataDirectory.ps1') -RuntimeDirectory $RuntimeDirectory
if(!(Get-QQAutoConnectPreference $RuntimeDirectory)){return}
$client=@(Get-QQDesktopClient -ClientPid $ClientPid)|Where-Object {$_.StartedAt -eq $ClientStartedAt}|Select-Object -First 1
if(!$client){throw 'AUTOCONNECT_CLIENT_CHANGED'}
if(Test-QQDesktopManualStop $RuntimeDirectory $ClientStartedAt){
  Set-QQAutoConnectJson (Join-Path $RuntimeDirectory 'desktop-autoconnect-status.json') @{schemaVersion=1;status='manual-stop-preserved';clientPid=$ClientPid;clientStartedAt=$ClientStartedAt;updatedAt=[DateTime]::UtcNow.ToString('o')}
  return
}
& (Join-Path $PSScriptRoot 'Start-Console.ps1') -RuntimeDirectory $RuntimeDirectory | Out-Null
if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw 'AUTOCONNECT_MANAGEMENT_START_FAILED'}
$entry=Join-Path $PSScriptRoot '..\packages\host-control\desktop-autoconnect.mjs'
& $node $entry --runtime $RuntimeDirectory --client-pid $ClientPid --client-started-at $ClientStartedAt
if($LASTEXITCODE -ne 0){throw 'QQ_DESKTOP_AUTOCONNECT_FAILED'}
