param([string]$RuntimeDirectory,[int]$Port=17391,[switch]$OpenBrowser)
$ErrorActionPreference='Stop'
. ([IO.Path]::Combine($PSScriptRoot,'Initialize-Cache.ps1'))
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeDirectory=& (Join-Path $PSScriptRoot 'Resolve-DataDirectory.ps1') -RuntimeDirectory $RuntimeDirectory
. ([IO.Path]::Combine($PSScriptRoot,'Initialize-Cache.ps1')) -CacheDataDirectory $RuntimeDirectory
if($RuntimeDirectory -eq [IO.Path]::GetPathRoot($RuntimeDirectory) -or $RuntimeDirectory -eq $projectRoot){throw 'INVALID_RUNTIME_DIRECTORY'}
$stateFile=Join-Path $RuntimeDirectory 'management-service.json'
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$version=& $nodePath --version
if($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24){throw 'NODE_24_REQUIRED'}
if(Test-Path -LiteralPath $stateFile){
  $previous=Get-Content -Encoding UTF8 -LiteralPath $stateFile -Raw|ConvertFrom-Json
  if($previous.status -eq 'running'){
    $confirmed=$false
    if($previous.url -match '^http://127\.0\.0\.1:[0-9]+$'){
      try{$health=Invoke-RestMethod -Uri ($previous.url+'/health') -TimeoutSec 2;$confirmed=$health.service -eq 'qq-agent-management' -and $health.instanceId -eq $previous.instance}catch{}
    }
    if($confirmed){if($OpenBrowser){Start-Process $previous.url};[pscustomobject]@{status='running';url=$previous.url;reused=$true;executionEnabled=$false}|ConvertTo-Json -Compress;exit 0}
    if(Get-Process -Id $previous.pid -ErrorAction SilentlyContinue){throw 'MANAGEMENT_STATE_UNCONFIRMED'}
  }
}
[IO.Directory]::CreateDirectory($RuntimeDirectory)|Out-Null
$entry=Join-Path $projectRoot 'packages\host-control\cli.mjs'
if($entry.Contains('"') -or $RuntimeDirectory.Contains('"')){throw 'INVALID_PATH'}
$child=Start-Process -FilePath $nodePath -ArgumentList @(('"'+$entry+'"'),'serve','--runtime',('"'+$RuntimeDirectory+'"'),'--port',[string]$Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
for($attempt=0;$attempt -lt 40;$attempt++){
  Start-Sleep -Milliseconds 250
  if($child.HasExited){throw 'MANAGEMENT_START_FAILED'}
  if(Test-Path -LiteralPath $stateFile){
    try{
      $current=Get-Content -Encoding UTF8 -LiteralPath $stateFile -Raw|ConvertFrom-Json
      if($current.pid -eq $child.Id -and $current.url -match '^http://127\.0\.0\.1:[0-9]+$'){
        $health=Invoke-RestMethod -Uri ($current.url+'/health') -TimeoutSec 2
        if($health.service -eq 'qq-agent-management' -and $health.instanceId -eq $current.instance){if($OpenBrowser){Start-Process $current.url};[pscustomobject]@{status='running';url=$current.url;reused=$false;executionEnabled=$false}|ConvertTo-Json -Compress;exit 0}
      }
    }catch{}
  }
}
throw 'MANAGEMENT_START_UNCONFIRMED'
