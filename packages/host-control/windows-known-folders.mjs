import path from 'node:path';
import {existsSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const script='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.Write((@{profile=[Environment]::GetFolderPath("UserProfile");localAppData=[Environment]::GetFolderPath("LocalApplicationData");documents=[Environment]::GetFolderPath("MyDocuments")}|ConvertTo-Json -Compress))';
export function readWindowsKnownFolders({environment=process.env,platform=process.platform,run=spawnSync}={}){
 if(platform!=='win32')return {};
 const root=environment.SystemRoot||environment.SYSTEMROOT;if(!root||!path.isAbsolute(root))throw Error('WINDOWS_KNOWN_FOLDERS_UNAVAILABLE');
 const helper=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');for(let p=helper;;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('WINDOWS_HELPER_PATH_UNSAFE');if(p===path.dirname(p))break;}
 const allowed=new Set(['SYSTEMROOT','WINDIR','SYSTEMDRIVE','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CACHE_HOME','PSMODULEANALYSISCACHEPATH','OS','PROCESSOR_ARCHITECTURE']);
 const result=run(helper,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,timeout:5000,maxBuffer:8192,encoding:'utf8',env:Object.fromEntries(Object.entries(environment).filter(([k])=>allowed.has(k.toUpperCase())))});
 let value;try{if(result.status!==0)throw Error();value=JSON.parse(result.stdout);}catch{throw Error('WINDOWS_KNOWN_FOLDERS_UNAVAILABLE');}
 if(!value||!['profile','localAppData','documents'].every(k=>typeof value[k]==='string'&&path.isAbsolute(value[k])&&!/^[/\\]{2}/.test(value[k])&&!/[\x00-\x1f]/.test(value[k])))throw Error('WINDOWS_KNOWN_FOLDERS_UNAVAILABLE');
 return Object.freeze({profile:value.profile,localAppData:value.localAppData,documents:value.documents});
}
