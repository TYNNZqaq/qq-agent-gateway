import path from 'node:path';
import os from 'node:os';
import {existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {checkedApplicationPath,resolveApplicationPaths,writeApplicationJson,PROGRAM_DIRECTORY,applicationWorkspaceDirectory} from './application-paths.mjs';
import {accountConfig} from './codex-account-policy.mjs';
import {SETUP_PRIVACY_HASH,SETUP_PRIVACY_VERSION,setupScope} from './setup-policy.mjs';
import {SetupStore} from '../storage/setup-store.mjs';
import {databaseManifest,relocateMetadata} from './business-migration.mjs';
import {relocateNativeSessionPaths} from './native-session-paths.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(base,file)=>{const r=path.relative(base,file);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=code=>{throw Error(code);};
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
function regular(file){checkedApplicationPath(file);const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('TRANSFER_FILE_UNSAFE');return s;}
function json(file){if(regular(file).size>1048576)fail('TRANSFER_JSON_TOO_LARGE');return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function snapshot(file,table){regular(file);const db=new DatabaseSync(file,{readOnly:true});try{return JSON.parse(db.prepare('SELECT snapshot FROM '+table+' WHERE id=1').get().snapshot);}finally{db.close();}}
function mutex(file){if(existsSync(file))regular(file);const db=new DatabaseSync(file);try{db.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS mutex(id INTEGER);BEGIN IMMEDIATE');}catch{db.close();fail('TRANSFER_SOURCE_STILL_RUNNING');}return ()=>{try{db.exec('ROLLBACK');}finally{db.close();}};}

// Local, explicit import of this application's own instance. Nothing is sent to a provider.
// Authentication files are copied as opaque bytes; their contents are never parsed or returned.
export function inspectUserDataSource(sourceDirectory){
 const source=checkedApplicationPath(sourceDirectory),active=json(path.join(source,'business','active.json'));
 if(active.schemaVersion!==1||!/^[a-f0-9-]{36}$/i.test(active.botId||'')||active.configRelative!==active.botId+'/config.local.json')fail('TRANSFER_SOURCE_NOT_RECOGNIZED');
 const business=path.join(source,'business',active.botId),config=json(path.join(business,'config.local.json')),home=path.join(source,'codex-account','home');
 if(checkedApplicationPath(config.accountHome)!==checkedApplicationPath(home)||config.runtimeRoot&&checkedApplicationPath(config.runtimeRoot)!==source||config.integration?.backend!=='app-server'||config.binding?.botId!==active.botId||config.binding?.agentId!==active.agentId||!config.externalUseConsent?.confirmed||!/^[a-f0-9-]{36}$/i.test(config.hostId||''))fail('TRANSFER_OWN_APPLICATION_REQUIRED');
 if(readFileSync(path.join(home,'config.toml'),'utf8')!==accountConfig)fail('TRANSFER_OWN_ACCOUNT_POLICY_REQUIRED');
 const account=snapshot(path.join(source,'codex-account','control.sqlite'),'account_control');
 if(account.agentId!==config.binding.agentId||account.connectionId!==config.accountConnectionId||!account.selected?.model||account.actions.some(a=>['login','logout'].includes(a.kind)&&['intent','awaiting','unknown'].includes(a.state)))fail('TRANSFER_ACCOUNT_RECONCILIATION_REQUIRED');
 const db=new DatabaseSync(path.join(source,'management.sqlite'),{readOnly:true});try{
  const b=db.prepare('SELECT * FROM ui_bindings WHERE id=? AND active=1').get(config.binding.bindingId),bot=db.prepare('SELECT * FROM ui_bots WHERE id=? AND archived=0').get(active.botId),agent=db.prepare('SELECT * FROM ui_agents WHERE id=? AND archived=0').get(active.agentId);
  if(!b||b.bot_id!==active.botId||b.agent_id!==active.agentId||b.version!==config.binding.bindingVersion||!bot||bot.app_id!==config.qq?.appId||bot.status!=='registered'||agent?.tool_id!=='codex'||agent.status!=='registered')fail('TRANSFER_BINDING_MISMATCH');
 }finally{db.close();}
 let identity=null;if(existsSync(path.join(source,'instance.json'))){identity=json(path.join(source,'instance.json'));if(identity.kind!=='qq-agent-user-instance'||identity.hostId!==config.hostId)fail('TRANSFER_IDENTITY_MISMATCH');}
 else if(json(path.join(source,'management-installation.json')).product!=='qq-agent-management')fail('TRANSFER_SOURCE_NOT_RECOGNIZED');
 return {source,business,home,active,config,account,identity};
}

function stopped(source){
 for(const file of [path.join(source.source,'management-service.json'),path.join(source.business,'service.json')])if(existsSync(file)){const s=json(file);if(['running','starting','stopping','pairing'].includes(s.status||s.state)&&alive(s.pid))fail('TRANSFER_SOURCE_STILL_RUNNING');}
 if(source.account.lease&&alive(source.account.lease.pid)||source.account.process?.state!=='closed'&&source.account.process?.pid&&alive(source.account.process.pid)||source.account.process?.state&&!['closed'].includes(source.account.process.state)&&!source.account.process.pid)fail('TRANSFER_ACCOUNT_STILL_RUNNING');
 const db=new DatabaseSync(path.join(source.business,'state.sqlite'),{readOnly:true});try{
  for(const table of ['tasks','chat_turns','outbox','outbox_parts','received_files']){const statuses=table==='received_files'?['pending','downloading']:['queued','running','pending','sending'];if(db.prepare('SELECT count(*) n FROM '+table+' WHERE status IN ('+statuses.map(()=>'?').join(',')+')').get(...statuses).n)fail('TRANSFER_USER_WORK_NOT_IDLE');}
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_control_operations'").get()&&db.prepare("SELECT 1 FROM native_control_operations WHERE status IN('queued','checking','sending') LIMIT 1").get())fail('TRANSFER_USER_WORK_NOT_IDLE');
 }finally{db.close();}
}

export async function transferUserData({sourceDirectory,dataDirectory,confirmOwnInstance=false,confirmExistingConsent=false,knownFolders={},environment=process.env,home=os.homedir(),fault=()=>{}}={}){
 if(confirmOwnInstance!==true||confirmExistingConsent!==true)fail('TRANSFER_EXPLICIT_OWN_DATA_CONFIRMATION_REQUIRED');
 const src=inspectUserDataSource(sourceDirectory);let paths=resolveApplicationPaths({dataDirectory,knownFolders,environment,home});
 if(inside(src.source,paths.dataDirectory)||inside(paths.dataDirectory,src.source))fail('TRANSFER_SOURCE_DESTINATION_OVERLAP');
 if(existsSync(paths.dataDirectory)&&readdirSync(paths.dataDirectory).length)fail('TRANSFER_DESTINATION_NOT_EMPTY');
 stopped(src);const releases=[];let report,reportFile;
 try{
  releases.push(mutex(path.join(src.source,'management-lock.sqlite')));releases.push(mutex(path.join(src.business,'service-lock.sqlite')));stopped(src);
  const physicalData=checkedApplicationPath(paths.dataDirectory,{create:true});paths=resolveApplicationPaths({dataDirectory:physicalData,knownFolders,environment,home});
  const transferId=randomUUID(),instanceId=src.identity?.instanceId||randomUUID(),identity={schemaVersion:1,kind:'qq-agent-user-instance',hostId:src.config.hostId,instanceId,workspaceDirectory:applicationWorkspaceDirectory(paths,instanceId),createdAt:src.identity?.createdAt||new Date().toISOString()};
  report={schemaVersion:1,kind:'qq-agent-own-user-data-transfer',transferId,state:'copying',source:src.source,destination:paths.dataDirectory,programDirectory:PROGRAM_DIRECTORY,startedAt:new Date().toISOString(),copied:[],databases:[],changes:[],proofRevalidationRequired:true,executionEnabled:false};reportFile=path.join(paths.dataDirectory,'transfer.json');writeApplicationJson(reportFile,report);writeApplicationJson(paths.identityFile,identity);
  let files=0,bytes=0;
  const copy=relative=>{const from=path.join(src.source,relative),to=path.join(paths.dataDirectory,relative),s=regular(from);if(++files>20000||(bytes+=s.size)>2147483648)fail('TRANSFER_COPY_LIMIT');mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);const sha256=hash(readFileSync(from));if(hash(readFileSync(to))!==sha256)fail('TRANSFER_COPY_HASH_MISMATCH');report.copied.push({file:relative,bytes:s.size,sha256});};
  const walk=(relative,skip=()=>false)=>{const directory=checkedApplicationPath(path.join(src.source,relative));mkdirSync(path.join(paths.dataDirectory,relative),{recursive:true});for(const e of readdirSync(directory,{withFileTypes:true})){const next=path.join(relative,e.name);if(skip(next,e.name))continue;if(e.isSymbolicLink())fail('TRANSFER_LINK_FORBIDDEN');if(e.isDirectory())walk(next,skip);else if(e.isFile())copy(next);else fail('TRANSFER_FILE_UNSAFE');}};
  const copyDb=async relative=>{const from=path.join(src.source,relative),to=path.join(paths.dataDirectory,relative);regular(from);mkdirSync(path.dirname(to),{recursive:true});const db=new DatabaseSync(from,{readOnly:true});try{const before=databaseManifest(db);await backup(db,to);const target=new DatabaseSync(to,{readOnly:true});try{if(!same(before,databaseManifest(target))||!same(before,databaseManifest(db)))fail('TRANSFER_DATABASE_MISMATCH');}finally{target.close();}report.databases.push({file:relative,before,after:before});}finally{db.close();}};
  await copyDb('management.sqlite');await copyDb(path.join('codex-account','control.sqlite'));
  if(existsSync(path.join(src.source,'qq-connection','control.sqlite')))await copyDb(path.join('qq-connection','control.sqlite'));
  if(existsSync(path.join(src.source,'codex-account-work','bindings.sqlite')))await copyDb(path.join('codex-account-work','bindings.sqlite'));
  walk(path.join('codex-account','home'),(_rel,name)=>['.sandbox','tmp','thread-writer-locks','.sqlite-maintenance.lock'].includes(name));
  report.nativeSessions=relocateNativeSessionPaths(paths.accountHome);
  const botRel=path.join('business',src.active.botId);await copyDb(path.join(botRel,'state.sqlite'));copy(path.join(botRel,'qq.secret'));
  for(const sub of ['artifact-spool','received','runs','chat-runs'])if(existsSync(path.join(src.business,sub)))walk(path.join(botRel,sub));
  if(existsSync(path.join(src.business,'migration.json')))copy(path.join(botRel,'migration.json'));
  const previousProof=path.join(src.source,'codex-account-work','accepted.json');if(existsSync(previousProof)){regular(previousProof);const target=path.join(paths.diagnosticDirectory,'previous-path-proof.json');mkdirSync(path.dirname(target),{recursive:true});copyFileSync(previousProof,target);}
  fault('after-copy');stopped(src);
  const targetBusiness=path.join(paths.businessDirectory,src.active.botId),config=structuredClone(src.config),scope=setupScope({identity,account:src.account,binding:config.binding});
  const consent={schemaVersion:1,id:randomUUID(),confirmed:true,policyVersion:SETUP_PRIVACY_VERSION,policyHash:SETUP_PRIVACY_HASH,scope,confirmedAt:new Date().toISOString(),migratedWithinSameOwner:true,previousConsentSha256:hash(JSON.stringify(src.config.externalUseConsent))};
  config.runtimeRoot=paths.dataDirectory;config.stateDir=targetBusiness;config.accountHome=paths.accountHome;config.externalUseConsent=consent;config.executor.enabled=false;config.fileReceive={...config.fileReceive,directory:path.join(targetBusiness,'received')};
  for(const project of Object.values(config.projects||{})){const p=checkedApplicationPath(project.path);if(inside(paths.dataDirectory,p)||inside(p,paths.dataDirectory)||inside(PROGRAM_DIRECTORY,p)||inside(p,PROGRAM_DIRECTORY))fail('TRANSFER_PROJECT_REAUTHORIZATION_REQUIRED');}
  writeApplicationJson(path.join(targetBusiness,'config.local.json'),config);writeApplicationJson(paths.consentFile,consent);writeApplicationJson(path.join(paths.businessDirectory,'active.json'),src.active);
  const setup=new SetupStore(path.join(paths.dataDirectory,'setup.sqlite'),identity);try{const state=setup.load();state.consent=consent;state.projects=Object.entries(config.projects||{}).map(([key,p])=>({key,...p,owner:scope}));setup.commit(state,state.revision);}finally{setup.close();}
  writeFileSync(path.join(paths.accountDirectory,'work-owner.json'),JSON.stringify({schemaVersion:1,kind:'qq-plugin-account-work-owner',agentId:src.account.agentId,connectionId:src.account.connectionId,home:paths.accountHome}),{flag:'wx',mode:0o600});
  const db=new DatabaseSync(path.join(targetBusiness,'state.sqlite'));try{
   const original=report.databases.find(d=>d.file===path.join(botRel,'state.sqlite'));report.changes=relocateMetadata(db,src.business,targetBusiness);original.after=databaseManifest(db);const changed=new Set(report.changes.map(c=>c.table));
   if(original.before.some((t,i)=>t.name!==original.after[i].name||t.count!==original.after[i].count||t.schemaHash!==original.after[i].schemaHash||!changed.has(t.name)&&t.contentHash!==original.after[i].contentHash))fail('TRANSFER_BUSINESS_CONTENT_MISMATCH');
   let owner,paired;try{owner=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='owner'").get()?.value);paired=JSON.parse(owner);}catch{}if(!Array.isArray(paired)||paired[0]!==config.qq.appId||paired[1]!=='c2c'||!paired[2])fail('TRANSFER_EXISTING_PAIRED_OWNER_REQUIRED');writeApplicationJson(path.join(targetBusiness,'pairing-result.json'),{schemaVersion:1,paired:true,migratedExistingOwner:true,ownerFingerprint:hash(owner)});
  }finally{db.close();}
  fault('before-commit');stopped(src);
  for(const entry of report.databases){const check=new DatabaseSync(path.join(src.source,entry.file),{readOnly:true});try{if(!same(databaseManifest(check),entry.before))fail('TRANSFER_SOURCE_CHANGED_DURING_COPY');}finally{check.close();}}
  for(const entry of report.copied)if(hash(readFileSync(path.join(src.source,entry.file)))!==entry.sha256)fail('TRANSFER_SOURCE_CHANGED_DURING_COPY');
  report.sourceConfigSha256=hash(readFileSync(path.join(src.business,'config.local.json')));report.configSha256=hash(readFileSync(path.join(targetBusiness,'config.local.json')));report.state='committed-revalidation-required';report.finishedAt=new Date().toISOString();writeApplicationJson(reportFile,report);
  return {transferId,state:report.state,dataDirectory:paths.dataDirectory,files:report.copied.length,databases:report.databases.length,businessTables:report.databases.find(d=>d.file===path.join(botRel,'state.sqlite')).after.map(({name,count})=>({name,count})),proofRevalidationRequired:true,executionEnabled:false};
 }catch(error){if(report&&reportFile){report.state='incomplete';report.error=/^[A-Z_]+$/.test(error.message)?error.message:'TRANSFER_FAILED';writeApplicationJson(reportFile,report);}throw error;}
 finally{for(const release of releases.reverse())release();}
}

export function rollbackUserDataTransfer(dataDirectory){
 const paths=resolveApplicationPaths({dataDirectory}),report=json(path.join(paths.dataDirectory,'transfer.json'));if(report.kind!=='qq-agent-own-user-data-transfer'||report.destination!==paths.dataDirectory||!['committed-revalidation-required','incomplete'].includes(report.state))fail('TRANSFER_ROLLBACK_UNAVAILABLE');
 const src=inspectUserDataSource(report.source);stopped(src);const releases=[];
 try{
  releases.push(mutex(path.join(paths.dataDirectory,'management-lock.sqlite')));releases.push(mutex(path.join(paths.businessDirectory,src.active.botId,'service-lock.sqlite')));
  if(hash(readFileSync(path.join(src.business,'config.local.json')))!==report.sourceConfigSha256&&report.state!=='incomplete')fail('TRANSFER_SOURCE_CHANGED');
  const business=report.databases.find(d=>d.file===path.join('business',src.active.botId,'state.sqlite'));
  if(report.state!=='incomplete'){const db=new DatabaseSync(path.join(paths.dataDirectory,business.file),{readOnly:true});try{if(!same(databaseManifest(db),business.after))fail('TRANSFER_NEW_USER_DATA_REQUIRES_REVERSE_MIGRATION');}finally{db.close();}}
  report.state='rolled-back';report.rolledBackAt=new Date().toISOString();writeApplicationJson(path.join(paths.dataDirectory,'transfer.json'),report);return {rolledBack:true,sourceDirectory:report.source,retainedDestination:paths.dataDirectory};
 }finally{for(const release of releases.reverse())release();}
}
