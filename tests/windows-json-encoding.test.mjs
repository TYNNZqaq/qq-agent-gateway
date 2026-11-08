import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,copyFileSync,cpSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PROGRAM_SCRIPTS} from '../scripts/release-policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.platform==='win32';
let program;
function fixture(){
 if(!program){
  const directory=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'windows-json-'));
  program=path.join(directory,'程序 空格');mkdirSync(program);mkdirSync(path.join(program,'scripts'));
  cpSync(path.join(root,'packages'),path.join(program,'packages'),{recursive:true});
  if(existsSync(path.join(root,'node_modules')))cpSync(path.join(root,'node_modules'),path.join(program,'node_modules'),{recursive:true});
  copyFileSync(path.join(root,'package.json'),path.join(program,'package.json'));
  for(const file of PROGRAM_SCRIPTS)copyFileSync(path.join(root,file),path.join(program,file));
 }
 const directory=mkdtempSync(path.join(path.dirname(program),'case-')),data=path.join(directory,'中文资料 测试');mkdirSync(data);
 return {program,directory,data};
}
function powershell(script,extra={}){
 return spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH||process.env.Path||''),QQ_JSON_SOURCE:root,...extra},windowsHide:true,encoding:'utf8',timeout:20000});
}
const encodingSetup=`$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -ne 5){throw 'WINDOWS_POWERSHELL_5_REQUIRED'}
$initialConsole=[Console]::OutputEncoding;$initialPipeline=$OutputEncoding
try{
 [Console]::OutputEncoding=[Text.Encoding]::GetEncoding([int]$env:QQ_JSON_CODEPAGE)
 $OutputEncoding=[Text.Encoding]::ASCII
 $expectedConsole=[Console]::OutputEncoding;$expectedPipeline=$OutputEncoding
`;
const encodingCheck=`
 if([Console]::OutputEncoding.CodePage -ne $expectedConsole.CodePage){throw 'CONSOLE_ENCODING_NOT_RESTORED'}
 if($OutputEncoding.CodePage -ne $expectedPipeline.CodePage){throw 'PIPELINE_ENCODING_NOT_RESTORED'}
}finally{[Console]::OutputEncoding=$initialConsole;$OutputEncoding=$initialPipeline}
Write-Output 'WINDOWS_JSON_UTF8_OK'
`;
for(const codePage of [936,65001]){
 test(`Windows PowerShell ${codePage} resolves native UTF-8 JSON with CJK program/data paths and restores caller encodings`,{skip:!windows},()=>{
  const f=fixture(),script=encodingSetup+`
 $expected=[IO.Path]::GetFullPath($env:QQ_JSON_DATA)
 $actual=& (Join-Path $env:QQ_JSON_PROGRAM 'scripts\\Resolve-DataDirectory.ps1') -RuntimeDirectory $expected
 if($actual -isnot [string] -or $actual -cne $expected){throw 'NATIVE_JSON_PATH_ROUNDTRIP_FAILED'}
 `+encodingCheck;
  const result=powershell(script,{QQ_JSON_PROGRAM:f.program,QQ_JSON_DATA:f.data,QQ_JSON_CODEPAGE:String(codePage)});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/WINDOWS_JSON_UTF8_OK/);
 });
 test(`Windows PowerShell ${codePage} restores caller encodings when native path resolution fails`,{skip:!windows},()=>{
  const f=fixture(),script=encodingSetup+`
 $failed=$false
 try{& (Join-Path $env:QQ_JSON_PROGRAM 'scripts\\Resolve-DataDirectory.ps1') -RuntimeDirectory $env:QQ_JSON_PROGRAM|Out-Null}catch{$failed=$true}
 if(!$failed){throw 'OVERLAPPING_PROGRAM_DATA_WAS_ACCEPTED'}
 `+encodingCheck;
  const result=powershell(script,{QQ_JSON_PROGRAM:f.program,QQ_JSON_CODEPAGE:String(codePage)});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/WINDOWS_JSON_UTF8_OK/);
 });
}
test('shipping PowerShell reads UTF-8 JSON independently of the host ANSI code page',{skip:!windows},()=>{
 const f=fixture(),instanceId=randomUUID(),hostId=randomUUID(),botId=randomUUID(),serviceInstance=randomUUID();
 const save=(relative,value)=>{const file=path.join(f.data,relative);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value),'utf8');};
 save('instance.json',{schemaVersion:1,kind:'qq-agent-user-instance',instanceId,hostId,workspaceDirectory:path.join(f.directory,'工作空间 原生会话')});
 save('desktop-autoconnect.json',{schemaVersion:1,enabled:true,instanceId,hostId,description:'桌面连接 用户资料'});
 save('management-service.json',{status:'running',description:'当前用户 管理服务'});
 save('business/active.json',{botId,configRelative:botId+'/config.local.json',label:'本人机器人'});
 save('business/'+botId+'/service.json',{instance:serviceInstance,description:'原生服务 中文路径'});
 save('business/'+botId+'/stop.request.json',{instance:serviceInstance,operationId:randomUUID(),reason:'本人手动停止'});
 const script=encodingSetup+`
 $files=$env:QQ_JSON_SCRIPTS|ConvertFrom-Json
 $reads=0
 foreach($file in $files){
  $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $env:QQ_JSON_SOURCE $file),[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'SHIPPING_SCRIPT_PARSE_FAILED'}
  foreach($command in $ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Get-Content'},$true)){
   $reads++;$encoding=@($command.CommandElements|Where-Object {$_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -eq 'Encoding'})
   if($encoding.Count -ne 1){throw ('JSON_FILE_ENCODING_NOT_EXPLICIT:'+ $file)}
   $parameter=$encoding[0];$value=if($parameter.Argument){$parameter.Argument.Value}else{$command.CommandElements[$command.CommandElements.IndexOf($parameter)+1].Value}
   if($value -ine 'UTF8'){throw ('JSON_FILE_ENCODING_NOT_UTF8:'+ $file)}
  }
 }
 if($reads -eq 0){throw 'SHIPPING_JSON_READS_NOT_CHECKED'}
 Import-Module (Join-Path $env:QQ_JSON_PROGRAM 'scripts\\Desktop-AutoConnect.psm1') -Force
 if(!(Get-QQAutoConnectPreference $env:QQ_JSON_DATA)){throw 'UTF8_IDENTITY_OR_PREFERENCE_NOT_READ'}
 if(!(Test-QQDesktopManualStop $env:QQ_JSON_DATA ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-3600000))){throw 'UTF8_MANUAL_STOP_STATE_NOT_READ'}
 `+encodingCheck;
 const result=powershell(script,{QQ_JSON_PROGRAM:f.program,QQ_JSON_DATA:f.data,QQ_JSON_CODEPAGE:'936',QQ_JSON_SCRIPTS:JSON.stringify(PROGRAM_SCRIPTS.filter(file=>/\.ps(?:1|m1)$/.test(file)))});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/WINDOWS_JSON_UTF8_OK/);
});
