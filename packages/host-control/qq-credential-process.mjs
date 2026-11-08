import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ManagementError } from '../core/management.mjs';

const error=()=>new ManagementError('QQ_CREDENTIAL_PROTECTION_FAILED',503);
// Static OS helper. No secret, filename or user-supplied script appears in argv or diagnostics.
const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; try {
 $inputJson=[Console]::In.ReadToEnd()|ConvertFrom-Json;
 $entropy=[Text.Encoding]::UTF8.GetBytes('qq-gateway:first-bot:v1');
 $bytes=[Convert]::FromBase64String($inputJson.data);
 if($inputJson.mode -eq 'seal'){$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
 elseif($inputJson.mode -eq 'open'){$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{throw 'invalid'};
 [Console]::Out.Write([Convert]::ToBase64String($result));
 } catch { [Environment]::Exit(1) }`;

export function locateCredentialHelper(environment=process.env){
  const systemRoot=environment.SystemRoot||environment.SYSTEMROOT;
  if(process.platform!=='win32'||!systemRoot||!path.isAbsolute(systemRoot))throw error();
  const candidate=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  for(let cursor=candidate;;cursor=path.dirname(cursor)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw error();if(cursor===path.dirname(cursor))break;}
  if(!existsSync(candidate)||!lstatSync(candidate).isFile())throw error();return realpathSync(candidate);
}
export function createQQCredentialProtector({environment=process.env,spawnProcess=spawn,helper}={}){
  const transform=(mode,data)=>new Promise((resolve,reject)=>{
    if(!['seal','open'].includes(mode)||!Buffer.isBuffer(data)||data.length>16384){reject(error());return;}
    let executable;try{executable=helper||locateCredentialHelper(environment);}catch{reject(error());return;}
    const allowed=new Set(['SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','TMPDIR','XDG_CACHE_HOME','PSMODULEANALYSISCACHEPATH','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','OS','PROCESSOR_ARCHITECTURE']);
    const env=Object.fromEntries(Object.entries(environment).filter(([key])=>allowed.has(key.toUpperCase())));
    const child=spawnProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let output='',failed=false;const timer=setTimeout(()=>{failed=true;child.kill();},10000);
    child.on('error',()=>{failed=true;});child.stdin.on('error',()=>{failed=true;});child.stderr.on('data',()=>{});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>32768){failed=true;child.kill();}});
    child.on('close',code=>{clearTimeout(timer);if(failed||code!==0||!output||!/^[-A-Za-z0-9+/=]+$/.test(output)){reject(error());return;}resolve(Buffer.from(output,'base64'));});
    child.stdin.end(JSON.stringify({mode,data:data.toString('base64')}));
  });
  return {seal:async plain=>{const input=Buffer.from(plain,'utf8');try{return (await transform('seal',input)).toString('base64');}finally{input.fill(0);}},
    open:async encrypted=>{if(typeof encrypted!=='string'||encrypted.length>32768||!/^[A-Za-z0-9+/=]+$/.test(encrypted))throw error();const value=await transform('open',Buffer.from(encrypted,'base64'));try{return value.toString('utf8');}finally{value.fill(0);}}};
}
