$ErrorActionPreference='Stop'
function Get-QQPublicNode {
  foreach($command in @(Get-Command node.exe -All -ErrorAction SilentlyContinue)){
    $candidate=$command.Source
    if(!$candidate -or $candidate -match '(?i)[\\/]\.codex[\\/]|[\\/]\.cache[\\/]codex-runtimes[\\/]|[\\/]OpenAI[\\/]Codex[\\/]'){continue}
    $version=& $candidate --version
    if($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24){return $candidate}
  }
  throw 'PUBLIC_NODE_24_REQUIRED'
}
function Set-QQAutoConnectJson([string]$File,$Value) {
  if(Test-Path -LiteralPath $File){if((Get-Item -LiteralPath $File).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'AUTOCONNECT_STATE_UNSAFE'}}
  $temp=$File+'.'+[guid]::NewGuid().ToString()+'.tmp'
  try{
    [IO.File]::WriteAllText($temp,($Value|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $File){[IO.File]::Replace($temp,$File,[NullString]::Value)}else{[IO.File]::Move($temp,$File)}
  }finally{if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp}}
}
function Get-QQAutoConnectPreference([string]$RuntimeDirectory) {
  $identity=Get-Content -Encoding UTF8 -LiteralPath (Join-Path $RuntimeDirectory 'instance.json') -Raw|ConvertFrom-Json
  $file=Join-Path $RuntimeDirectory 'desktop-autoconnect.json'
  if(!(Test-Path -LiteralPath $file)){return $false}
  $preference=Get-Content -Encoding UTF8 -LiteralPath $file -Raw|ConvertFrom-Json
  return ($preference.schemaVersion -eq 1 -and $preference.enabled -eq $true -and $preference.instanceId -eq $identity.instanceId -and $preference.hostId -eq $identity.hostId)
}
function Test-QQDesktopFacts($Facts,[int]$SessionId,[string]$OwnerSid) {
  return ($Facts.Name -in @('ChatGPT','Codex') -and $Facts.Product -eq 'Codex' -and $Facts.SessionId -eq $SessionId -and $Facts.OwnerSid -eq $OwnerSid -and $Facts.MainWindow -ne 0 -and $Facts.HasDesktopResources -eq $true -and $Facts.StartedAt -gt 0)
}
function Get-QQDesktopClient([int]$ClientPid=0) {
  $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $candidates=if($ClientPid){@(Get-Process -Id $ClientPid -ErrorAction SilentlyContinue)}else{@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue)}
  foreach($process in $candidates){
    try{
      $process.Refresh()
      if($process.ProcessName -notin @('ChatGPT','Codex') -or $process.SessionId -ne $session -or $process.MainWindowHandle -eq [IntPtr]::Zero){continue}
      $binary=$process.MainModule.FileName
      $facts=[pscustomobject]@{Name=$process.ProcessName;Product=$process.MainModule.FileVersionInfo.ProductName;SessionId=$process.SessionId;OwnerSid=[QQAgent.DesktopStartEvents]::OwnerSid($process.Id);MainWindow=$process.MainWindowHandle.ToInt64();HasDesktopResources=(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $binary) 'resources\app.asar') -PathType Leaf);StartedAt=([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()}
      if(Test-QQDesktopFacts $facts $session $sid){[pscustomobject]@{Pid=$process.Id;StartedAt=$facts.StartedAt;Key=([string]$process.Id+':'+[string]$facts.StartedAt)}}
    }catch{continue}
  }
}
function Test-QQDesktopManualStop([string]$RuntimeDirectory,[long]$ClientStartedAt) {
  $metadataFile=Join-Path $RuntimeDirectory 'management-service.json'
  if(Test-Path -LiteralPath $metadataFile){
    $metadata=Get-Content -Encoding UTF8 -LiteralPath $metadataFile -Raw|ConvertFrom-Json
    if($metadata.status -eq 'stopped' -and ([DateTimeOffset](Get-Item -LiteralPath $metadataFile).LastWriteTimeUtc).ToUnixTimeMilliseconds() -ge $ClientStartedAt){return $true}
  }
  $activeFile=Join-Path $RuntimeDirectory 'business\active.json'
  if(!(Test-Path -LiteralPath $activeFile)){return $false}
  $active=Get-Content -Encoding UTF8 -LiteralPath $activeFile -Raw|ConvertFrom-Json
  if($active.botId -notmatch '^[a-f0-9-]{36}$' -or $active.configRelative -ne ($active.botId+'/config.local.json')){throw 'BUSINESS_ACTIVE_REFERENCE_INVALID'}
  $directory=Join-Path (Join-Path $RuntimeDirectory 'business') $active.botId
  $requestFile=Join-Path $directory 'stop.request.json'
  if(!(Test-Path -LiteralPath $requestFile)){return $false}
  if(([DateTimeOffset](Get-Item -LiteralPath $requestFile).LastWriteTimeUtc).ToUnixTimeMilliseconds() -lt $ClientStartedAt){return $false}
  $serviceFile=Join-Path $directory 'service.json'
  if(!(Test-Path -LiteralPath $serviceFile)){return $false}
  $request=Get-Content -Encoding UTF8 -LiteralPath $requestFile -Raw|ConvertFrom-Json
  $service=Get-Content -Encoding UTF8 -LiteralPath $serviceFile -Raw|ConvertFrom-Json
  return ($request.instance -eq $service.instance)
}
function Get-QQPowerShellArguments([string]$Script,[string]$RuntimeDirectory) {
  if($Script -match '["\r\n\x00]' -or $RuntimeDirectory -match '["\r\n\x00]'){throw 'AUTOCONNECT_ARGUMENT_INVALID'}
  return '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$Script+'" -RuntimeDirectory "'+$RuntimeDirectory+'"'
}
Export-ModuleMember -Function Get-QQPublicNode,Set-QQAutoConnectJson,Get-QQAutoConnectPreference,Test-QQDesktopFacts,Get-QQDesktopClient,Test-QQDesktopManualStop,Get-QQPowerShellArguments
