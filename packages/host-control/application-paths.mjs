import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {existsSync,lstatSync,realpathSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const PROGRAM_DIRECTORY=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const inside=(root,target)=>{const r=path.relative(root,target);return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const fail=code=>{throw Error(code);};
export function requireStorageVolume(directory,{environment=process.env,platform=process.platform}={}){
 if(platform==='win32'){
  const system=environment.SystemDrive||environment.SYSTEMDRIVE||environment.SystemRoot||environment.SYSTEMROOT||process.env.SystemRoot||process.env.SYSTEMROOT;
  if(system&&path.parse(path.resolve(system+(/^[A-Za-z]:$/.test(system)?path.sep:''))).root.toLowerCase()===path.parse(path.resolve(directory)).root.toLowerCase())fail('SYSTEM_DRIVE_STORAGE_FORBIDDEN');
 }
 return directory;
}
export function applicationWorkspaceDirectory(paths,instanceId){return path.join(path.dirname(paths.dataDirectory),'workspaces',instanceId);}
export function checkedApplicationPath(value,{create=false}={}){
 if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f]/.test(value)||/^[/\\]{2}/.test(value))fail('APPLICATION_PATH_INVALID');
 const absolute=path.resolve(value),parsed=path.parse(absolute);let cursor=parsed.root;
 for(const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
  if(process.platform==='win32'&&(/[:*?"<>|]|[. ]$/.test(component)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)))fail('APPLICATION_PATH_INVALID');
  cursor=path.join(cursor,component);
  if(existsSync(cursor)){if(lstatSync(cursor).isSymbolicLink())fail('APPLICATION_PATH_LINK');}
  else if(create)mkdirSync(cursor);
 }
 return existsSync(absolute)?realpathSync.native(absolute).replace(/^\\\\\?\\(?=[A-Za-z]:)/,''):absolute;
}
export function resolveApplicationPaths({dataDirectory,environment=process.env,platform=process.platform,home=os.homedir(),programDirectory=PROGRAM_DIRECTORY,knownFolders={}}={}){
 const program=checkedApplicationPath(path.resolve(programDirectory));
 const profile=knownFolders.profile||home;
 let base=platform==='win32'?knownFolders.localAppData||environment.LOCALAPPDATA||environment.LocalAppData:environment.XDG_DATA_HOME;
 if(!base){if(!home||!path.isAbsolute(home))fail('USER_DATA_LOCATION_UNAVAILABLE');base=platform==='win32'?path.join(home,'AppData','Local'):path.join(home,'.local','share');}
 // Keep program upgrades stable, user instances separate, and all writable state on the installation volume.
 const parent=path.dirname(program),storageBase=path.basename(parent).toLowerCase()==='programs'?path.dirname(parent):parent;
 const userKey=createHash('sha256').update(path.resolve(profile).toLowerCase()).digest('hex').slice(0,20);
 const defaultData=platform==='win32'?path.join(storageBase,'QQAgentData','users',userKey,'instances','default'):path.join(base,'QQAgent','instances','default');
 const chosen=dataDirectory||environment.QQ_AGENT_DATA_ROOT||environment.QQ_GATEWAY_RUNTIME||defaultData;
 const data=checkedApplicationPath(chosen);
 if(platform==='win32'&&inside(path.join(profile,'AppData','Local','Packages'),data))fail('FOREIGN_PACKAGED_APPLICATION_DATA');
 requireStorageVolume(data,{environment,platform});
 if(existsSync(data)&&!lstatSync(data).isDirectory())fail('USER_DATA_DIRECTORY_REQUIRED');
 if(data===path.parse(data).root||inside(program,data)||inside(data,program))fail('PROGRAM_DATA_OVERLAP');
 const externalHome=environment.CODEX_HOME||path.join(home,'.codex');
 if(path.isAbsolute(externalHome)&&(inside(externalHome,data)||inside(data,externalHome)))fail('FOREIGN_ACCOUNT_DATA_OVERLAP');
 return Object.freeze({schemaVersion:1,programDirectory:program,dataDirectory:data,identityFile:path.join(data,'instance.json'),managementDatabase:path.join(data,'management.sqlite'),businessDirectory:path.join(data,'business'),accountDirectory:path.join(data,'codex-account'),accountHome:path.join(data,'codex-account','home'),qqDirectory:path.join(data,'qq-connection'),backupDirectory:path.join(data,'backups'),logDirectory:path.join(data,'logs'),diagnosticDirectory:path.join(data,'diagnostics'),consentFile:path.join(data,'consent.json')});
}
export function writeApplicationJson(file,value){
 checkedApplicationPath(path.dirname(file),{create:true});
 if(existsSync(file)){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('APPLICATION_STATE_FILE_UNSAFE');}
 const temp=file+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});renameSync(temp,file);}finally{rmSync(temp,{force:true});}
}
export function readApplicationIdentity(paths){
  const transfer=path.join(paths.dataDirectory,'transfer.json');if(existsSync(transfer)){
   const st=lstatSync(transfer);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>8388608)fail('TRANSFER_STATE_UNSAFE');const state=JSON.parse(readFileSync(transfer,'utf8'));if(state.kind!=='qq-agent-own-user-data-transfer'||state.destination!==paths.dataDirectory||!['committed-revalidation-required','accepted'].includes(state.state))fail('TRANSFER_NOT_COMMITTED');
  }
  const st=lstatSync(paths.identityFile);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096)fail('APPLICATION_IDENTITY_UNSAFE');
  let identity;
  try{identity=JSON.parse(readFileSync(paths.identityFile,'utf8'));}catch{fail('APPLICATION_IDENTITY_INVALID');}
  if(identity.schemaVersion!==1||identity.kind!=='qq-agent-user-instance'||!['hostId','instanceId'].every(k=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(identity[k]||'')))fail('APPLICATION_IDENTITY_INVALID');
  return Object.freeze(identity);
}
export function initializeApplicationData(options={}){
 let paths=resolveApplicationPaths(options);
 const directory=checkedApplicationPath(paths.dataDirectory,{create:true});paths=resolveApplicationPaths({...options,dataDirectory:directory});
 let identity;
 if(existsSync(paths.identityFile)){
  identity=readApplicationIdentity(paths);
 }else{
  if(readdirSync(directory).length)fail('NONEMPTY_USER_DATA_REQUIRES_IMPORT');
  const instanceId=randomUUID();
  identity={schemaVersion:1,kind:'qq-agent-user-instance',hostId:randomUUID(),instanceId,workspaceDirectory:applicationWorkspaceDirectory(paths,instanceId),createdAt:new Date().toISOString()};
  writeFileSync(paths.identityFile,JSON.stringify(identity,null,2),{flag:'wx',mode:0o600});
 }
 for(const d of [paths.businessDirectory,paths.backupDirectory,paths.logDirectory,paths.diagnosticDirectory])checkedApplicationPath(d,{create:true});
 return Object.freeze({paths,identity:Object.freeze(identity),fresh:!existsSync(paths.managementDatabase)});
}
export function acquireManagementDataLock(paths){
 readApplicationIdentity(paths);const file=path.join(paths.dataDirectory,'management-lock.sqlite');
 if(existsSync(file)){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('MANAGEMENT_LOCK_UNSAFE');}
 const db=new DatabaseSync(file);let released=false;
 try{db.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS mutex(id INTEGER);BEGIN IMMEDIATE');}
 catch{db.close();fail('MANAGEMENT_ALREADY_RUNNING');}
 return ()=>{if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}};
}
