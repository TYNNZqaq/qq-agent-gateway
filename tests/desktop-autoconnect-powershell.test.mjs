import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('Windows startup scripts parse and desktop classification excludes CLI, renderers and other users',{skip:process.platform!=='win32'},()=>{
 const script=`$ErrorActionPreference='Stop'
 $root=$env:QQ_AUTOCONNECT_TEST_SOURCE
 foreach($name in @('Desktop-AutoConnect.psm1','Connect-QQOnDesktopStart.ps1','Watch-CodexStart.ps1','Enable-CodexAutoConnect.ps1','Install.ps1')){
  $tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path $root ('scripts\\'+$name)),[ref]$tokens,[ref]$errors)|Out-Null
  if($errors.Count){throw ('PARSE_FAILED:'+ $name)}
 }
 Import-Module (Join-Path $root 'scripts\\Desktop-AutoConnect.psm1') -Force
 Add-Type -Path (Join-Path $root 'scripts\\Desktop-StartEvents.cs')
 $facts=@{Name='ChatGPT';Product='Codex';SessionId=1;OwnerSid='user1';MainWindow=12;HasDesktopResources=$true;StartedAt=123}
 if(!(Test-QQDesktopFacts ([pscustomobject]$facts) 1 'user1')){throw 'MAIN_NOT_RECOGNIZED'}
 foreach($change in @(@{Product='ChatGPT'},@{Name='node'},@{MainWindow=0},@{SessionId=2},@{OwnerSid='user2'},@{HasDesktopResources=$false},@{StartedAt=0})){
  $copy=$facts.Clone();foreach($key in $change.Keys){$copy[$key]=$change[$key]};if(Test-QQDesktopFacts ([pscustomobject]$copy) 1 'user1'){throw 'SUBPROCESS_OR_OTHER_APP_MATCHED'}
 }
 $directory=Join-Path $env:QQ_TEST_ROOT ([guid]::NewGuid().ToString());New-Item -ItemType Directory -Path $directory|Out-Null
 $scriptPath=Join-Path $directory '含空格 app\\启动.ps1';$dataPath=Join-Path $directory '用户资料\\data space'
 $args=Get-QQPowerShellArguments $scriptPath $dataPath
 if(!$args.Contains('-File "'+$scriptPath+'"') -or !$args.Contains('-RuntimeDirectory "'+$dataPath+'"')){throw 'ARGUMENT_QUOTING_FAILED'}
 if([QQAgent.DesktopStartEvents]::OwnerSid($PID) -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'OWNER_IDENTITY_FAILED'}
 $events=[QQAgent.DesktopStartEvents]::new($directory)
 try{
  $preferenceFile=Join-Path $directory 'desktop-autoconnect.json'
  Set-QQAutoConnectJson $preferenceFile @{schemaVersion=1;enabled=$true}
  Set-QQAutoConnectJson $preferenceFile @{schemaVersion=1;enabled=$false}
  if((Get-Content -LiteralPath $preferenceFile -Raw|ConvertFrom-Json).enabled -ne $false){throw 'EXISTING_PREFERENCE_REPLACE_FAILED'}
  if(!$events.Available.WaitOne(5000)){throw 'PREFERENCE_CHANGE_DID_NOT_WAKE_LISTENER'}
  if($events.Drain() -notcontains 0){throw 'PREFERENCE_SIGNAL_INVALID'}
 }finally{$events.Dispose()}
 Write-Output 'WINDOWS_STARTUP_CONTRACT_OK'
 `;
 const result=spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QQ_AUTOCONNECT_TEST_SOURCE:root},windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/WINDOWS_STARTUP_CONTRACT_OK/);
});
