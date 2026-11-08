param([string]$RuntimeDirectory,[switch]$Disable)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Desktop-AutoConnect.psm1') -Force
. (Join-Path $PSScriptRoot 'Initialize-Cache.ps1') -CacheDataDirectory $RuntimeDirectory
$node=Get-QQPublicNode
$env:PATH=(Split-Path -Parent $node)+[IO.Path]::PathSeparator+$env:PATH
$RuntimeDirectory=& (Join-Path $PSScriptRoot 'Resolve-DataDirectory.ps1') -RuntimeDirectory $RuntimeDirectory
$identity=Get-Content -Encoding UTF8 -LiteralPath (Join-Path $RuntimeDirectory 'instance.json') -Raw|ConvertFrom-Json
if($identity.kind -ne 'qq-agent-user-instance' -or $identity.instanceId -notmatch '^[a-f0-9-]{36}$' -or $identity.hostId -notmatch '^[a-f0-9-]{36}$'){throw 'APPLICATION_IDENTITY_INVALID'}
$startup=[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
if(!$startup -or !(Test-Path -LiteralPath $startup -PathType Container)){throw 'USER_STARTUP_DIRECTORY_UNAVAILABLE'}
$watcher=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Watch-CodexStart.ps1'))
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments=Get-QQPowerShellArguments $watcher $RuntimeDirectory
$linkFile=Join-Path $startup ('QQAgent-Codex-'+$identity.instanceId+'.lnk')
$preferenceFile=Join-Path $RuntimeDirectory 'desktop-autoconnect.json'
$backup=Join-Path $RuntimeDirectory ('backups\desktop-autoconnect\'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')+'-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
foreach($file in @($linkFile,$preferenceFile)){if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path $backup ([IO.Path]::GetFileName($file)))}}
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $linkFile){
  $old=$shell.CreateShortcut($linkFile)
  if($old.TargetPath -ne $powershell -or $old.Arguments -ne $arguments){throw 'AUTOCONNECT_STARTUP_SHORTCUT_CONFLICT'}
}
Set-QQAutoConnectJson $preferenceFile @{schemaVersion=1;enabled=(!$Disable);instanceId=$identity.instanceId;hostId=$identity.hostId;trigger='codex-desktop-start';updatedAt=[DateTime]::UtcNow.ToString('o')}
if($Disable){
  if(Test-Path -LiteralPath $linkFile){Remove-Item -LiteralPath $linkFile}
  [pscustomobject]@{enabled=$false;trigger='codex-desktop-start';backupDirectory=$backup}|ConvertTo-Json -Compress
}else{
  $link=$shell.CreateShortcut($linkFile);$link.TargetPath=$powershell;$link.Arguments=$arguments;$link.WorkingDirectory=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$link.WindowStyle=7;$link.Description='QQAgent: connect the paired QQ bot when Codex desktop starts';$link.Save()
  Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden
  [pscustomobject]@{enabled=$true;trigger='codex-desktop-start';startupShortcut=$linkFile;backupDirectory=$backup}|ConvertTo-Json -Compress
}
