param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Desktop-AutoConnect.psm1') -Force
. (Join-Path $PSScriptRoot 'Initialize-Cache.ps1') -CacheDataDirectory $RuntimeDirectory
$RuntimeDirectory=& (Join-Path $PSScriptRoot 'Resolve-DataDirectory.ps1') -RuntimeDirectory $RuntimeDirectory
$identity=Get-Content -LiteralPath (Join-Path $RuntimeDirectory 'instance.json') -Raw|ConvertFrom-Json
if($identity.instanceId -notmatch '^[a-f0-9-]{36}$'){throw 'APPLICATION_IDENTITY_INVALID'}
$mutex=[Threading.Mutex]::new($false,('Local\QQAgent.CodexStart.'+$identity.instanceId+'.'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$owned=$false;$events=$null
try{
  try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(!$owned){return}
  if(!(Get-QQAutoConnectPreference $RuntimeDirectory)){return}
  Add-Type -Path (Join-Path $PSScriptRoot 'Desktop-StartEvents.cs')
  $events=[QQAgent.DesktopStartEvents]::new($RuntimeDirectory)
  $seen=[Collections.Generic.HashSet[string]]::new()
  $statusFile=Join-Path $RuntimeDirectory 'desktop-autoconnect-watcher.json'
  Set-QQAutoConnectJson $statusFile @{schemaVersion=1;status='listening';pid=$PID;instanceId=$identity.instanceId;mechanism='windows-window-events';startedAt=[DateTime]::UtcNow.ToString('o')}
  # Subscribe before the initial scan, covering a client already running at logon/installation.
  $clients=@(Get-QQDesktopClient)
  while(Get-QQAutoConnectPreference $RuntimeDirectory){
    foreach($client in $clients){
      if(!$seen.Add($client.Key)){continue}
      try{& (Join-Path $PSScriptRoot 'Connect-QQOnDesktopStart.ps1') -RuntimeDirectory $RuntimeDirectory -ClientPid $client.Pid -ClientStartedAt $client.StartedAt | Out-Null}
      catch{Set-QQAutoConnectJson (Join-Path $RuntimeDirectory 'desktop-autoconnect-status.json') @{schemaVersion=1;status='attention-required';clientPid=$client.Pid;clientStartedAt=$client.StartedAt;updatedAt=[DateTime]::UtcNow.ToString('o')}}
    }
    $events.Available.WaitOne()|Out-Null
    $clients=@(foreach($candidatePid in $events.Drain()){if($candidatePid -gt 0){Get-QQDesktopClient -ClientPid $candidatePid}})
  }
}catch{
  if($owned){Set-QQAutoConnectJson (Join-Path $RuntimeDirectory 'desktop-autoconnect-watcher.json') @{schemaVersion=1;status='failed';pid=$PID;updatedAt=[DateTime]::UtcNow.ToString('o')}}
  throw
}finally{
  if($events){$events.Dispose()}
  if($owned){
    if(!(Get-QQAutoConnectPreference $RuntimeDirectory)){Set-QQAutoConnectJson (Join-Path $RuntimeDirectory 'desktop-autoconnect-watcher.json') @{schemaVersion=1;status='disabled';pid=$PID;updatedAt=[DateTime]::UtcNow.ToString('o')}}
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
