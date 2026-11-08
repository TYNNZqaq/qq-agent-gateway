param([Parameter(Mandatory=$true)][string]$RuntimeDirectory,[string]$CodexHome,[Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
function Get-ProgramSha256([string]$File){$hashAlgorithm=[Security.Cryptography.SHA256]::Create();$hashStream=[IO.File]::OpenRead($File);try{return [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-','').ToLowerInvariant()}finally{$hashStream.Dispose();$hashAlgorithm.Dispose()}}
$programRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot=(Resolve-Path -LiteralPath $RuntimeDirectory).Path
$evidenceRoot=(Resolve-Path -LiteralPath $EvidenceDirectory).Path
if(-not $CodexHome){$CodexHome=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'}}
$desktopHomePath=(Resolve-Path -LiteralPath $CodexHome).Path
if(-not (Test-Path -LiteralPath (Join-Path $desktopHomePath 'state_5.sqlite')) -or -not (Test-Path -LiteralPath (Join-Path $desktopHomePath 'sessions'))){throw 'DESKTOP_NATIVE_HOME_REQUIRED'}
$manifest=Get-Content -Raw -LiteralPath (Join-Path $programRoot 'MANIFEST.json')|ConvertFrom-Json
if($manifest.kind -ne 'qq-agent-clean-program-release'){throw 'SEALED_PROGRAM_REQUIRED'}
foreach($entry in $manifest.files){$actual=Get-ProgramSha256 (Join-Path $programRoot $entry.file);if($actual -ne $entry.sha256){throw 'SEALED_PROGRAM_CHANGED'}}
$active=Get-Content -Raw -LiteralPath (Join-Path $dataRoot 'business\active.json')|ConvertFrom-Json
$business=Join-Path $dataRoot ('business\'+$active.botId)
$configFile=Join-Path $business 'config.local.json'
$config=Get-Content -Raw -LiteralPath $configFile|ConvertFrom-Json
$service=Get-Content -Raw -LiteralPath (Join-Path $business 'service.json')|ConvertFrom-Json
if($service.state -ne 'stopped'){throw 'STOP_ORIGINAL_BUSINESS_BEFORE_CONFIGURING'}
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
if($nodePath -match '[\\/](?:\.cache[\\/]codex-runtimes|OpenAI[\\/]Codex[\\/]runtimes)(?:[\\/]|$)'){throw 'PUBLIC_NODE_REQUIRED'}
foreach($value in @($nodePath,$programRoot,$business,$desktopHomePath)){if($value -match '["\x00-\x1f]'){throw 'UNSAFE_HOOK_PATH'}}
$settingsFile=Join-Path $business 'native-permission-settings.json'
$scriptFile=Join-Path $programRoot 'packages\application\desktop-permission-hook.mjs'
function Quote-PowerShellLiteral([string]$Value){return "'"+$Value.Replace("'","''")+"'"}
$launcherPath=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
if(-not (Test-Path -LiteralPath $launcherPath) -or $launcherPath -match '[\s"\x00-\x1f]'){throw 'SYSTEM_POWERSHELL_SINGLE_TOKEN_PATH_REQUIRED'}
$decodedCommand='& '+((@($nodePath,$scriptFile,$settingsFile)|ForEach-Object {Quote-PowerShellLiteral $_}) -join ' ')
$encodedCommand=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($decodedCommand))
$command=$launcherPath+' -NoProfile -NonInteractive -EncodedCommand '+$encodedCommand
function Test-OwnHookCommand([string]$Candidate){
 if($Candidate -ceq $command){return $true}
 if($Candidate.Contains('desktop-permission-hook.mjs') -and $Candidate.EndsWith(' "'+$settingsFile+'"')){return $true}
 if($Candidate -cmatch ' -EncodedCommand ([A-Za-z0-9+/]+={0,2})$'){
  try{$decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]));return $decoded.StartsWith('& ') -and $decoded.Contains('desktop-permission-hook.mjs') -and $decoded.EndsWith(' '+(Quote-PowerShellLiteral $settingsFile))}catch{return $false}
 }
 return $false
}
$hookFile=Join-Path $desktopHomePath 'hooks.json'
$backupRoot=Join-Path $evidenceRoot 'before-native-hook-configuration'
if(Test-Path -LiteralPath $backupRoot){throw 'HOOK_CONFIGURATION_INTENT_EXISTS_RECONCILE_FIRST'}
New-Item -ItemType Directory -Path $backupRoot|Out-Null
Copy-Item -LiteralPath $configFile -Destination (Join-Path $backupRoot 'config.local.json')
if(Test-Path -LiteralPath $settingsFile){Copy-Item -LiteralPath $settingsFile -Destination (Join-Path $backupRoot 'native-permission-settings.json')}
$hadHooks=Test-Path -LiteralPath $hookFile
if($hadHooks){Copy-Item -LiteralPath $hookFile -Destination (Join-Path $backupRoot 'hooks.json');$hooks=Get-Content -Raw -LiteralPath $hookFile|ConvertFrom-Json}else{$hooks=[pscustomobject]@{hooks=[pscustomobject]@{}}}
if(-not $hooks.PSObject.Properties['hooks']){$hooks|Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})}
if($hooks.hooks -isnot [pscustomobject]){throw 'EXISTING_HOOKS_SHAPE_INVALID'}
$events=@(@{name='PermissionRequest';timeout=330;status='QQ native approval: PermissionRequest'},@{name='PostToolUse';timeout=20;status='QQ native approval: tool result'},@{name='Interrupt';timeout=3;status='QQ native approval: interrupted request'})
foreach($event in $events){
 $entries=@();if($hooks.hooks.PSObject.Properties[$event.name]){$entries=@($hooks.hooks.PSObject.Properties[$event.name].Value)}
 $found=$false
 foreach($group in $entries){foreach($handler in @($group.hooks)){
  if($handler.type -eq 'command' -and ($handler.command -ceq $command -or ($handler.statusMessage -ceq $event.status -and (Test-OwnHookCommand ([string]$handler.command))))){
   $handler|Add-Member -NotePropertyName command -NotePropertyValue $command -Force
   $handler|Add-Member -NotePropertyName timeout -NotePropertyValue $event.timeout -Force
   $handler|Add-Member -NotePropertyName statusMessage -NotePropertyValue $event.status -Force
   $found=$true
  }
 }}
 if(-not $found){$group=@{hooks=@(@{type='command';command=$command;timeout=$event.timeout;statusMessage=$event.status})};if($event.name -ne 'Interrupt'){$group.matcher='*'};$entries+=,$group}
 $hooks.hooks|Add-Member -NotePropertyName $event.name -NotePropertyValue $entries -Force
}
$ownerHash=& $nodePath (Join-Path $PSScriptRoot 'Read-NativeApprovalOwner.mjs') $business
if($LASTEXITCODE -ne 0 -or $ownerHash -notmatch '^[a-f0-9]{64}$'){throw 'PAIRED_OWNER_REQUIRED'}
$settings=[ordered]@{schemaVersion=1;kind='qq-native-desktop-permission-hook';businessDirectory=$business;instanceId=$config.instanceId;binding=$config.binding;appId=$config.qq.appId;desktopHome=$desktopHomePath;ownerHash=$ownerHash}
$feature=[ordered]@{enabled=$true;home=$desktopHomePath;settingsFile=$settingsFile}
$config|Add-Member -NotePropertyName nativeDesktopApprovals -NotePropertyValue $feature -Force
$utf8=[Text.UTF8Encoding]::new($false)
function Write-AtomicJson([string]$Target,$Value){$temporary=$Target+'.'+[guid]::NewGuid().ToString()+'.tmp';[IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $Target -Force}
Write-AtomicJson $settingsFile $settings
Write-AtomicJson $configFile $config
Write-AtomicJson $hookFile $hooks
$review=[ordered]@{schemaVersion=1;configured=$true;trusted=$false;nativeVerificationPassed=$false;programDirectory=$programRoot;dataDirectory=$dataRoot;hookFile=$hookFile;settingsFile=$settingsFile;command=$command;decodedCommand=$decodedCommand;launcherPath=$launcherPath;events=$events;existingHooksPreserved=$hadHooks;existingNotifyModified=$false;appAllowListsModified=$false;hookTrustBypassed=$false;scriptSha256=(Get-ProgramSha256 $scriptFile);requires='Review and trust these exact hooks with the native /hooks interface; then verify a real desktop permission request'}
Write-AtomicJson (Join-Path $evidenceRoot 'hook-install-review.json') $review
$review|ConvertTo-Json -Depth 8
