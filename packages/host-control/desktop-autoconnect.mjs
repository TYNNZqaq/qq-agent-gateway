import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,lstatSync,readFileSync,statSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {resolveApplicationPaths,readApplicationIdentity,writeApplicationJson} from './application-paths.mjs';
import {NativeOwnerConnection} from './native-owner-connection.mjs';

const fail=code=>{throw Error(code);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
function read(file,optional=false){
 if(optional&&!existsSync(file))return null;
 const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536)fail('AUTOCONNECT_STATE_UNSAFE');
 return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
export function clientGeneration(pid,startedAt){
 if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(startedAt)||startedAt<=0)fail('AUTOCONNECT_CLIENT_INVALID');
 return createHash('sha256').update(`${pid}:${startedAt}`).digest('hex');
}
export function connectionDecision(state,{manualStop=false,attempted=false}={}){
 const b=state?.business;
 if(manualStop)return 'manual-stop-preserved';
 if(b?.running&&b.serviceFresh)return b.qqConnected?'connected':'connecting';
 if(b?.pending||b?.processAlive)return 'pending';
 if(!b?.configured||!b.paired||!(b.serviceConfigured===true||b.executionConfigured===true))return 'needs-configuration';
 return attempted?'already-attempted':'start';
}
export async function createManagementClient(metadata,{fetcher=fetch}={}){
 if(metadata?.service!=='qq-agent-management'||metadata.status!=='running'||!uuid(metadata.instance)||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(metadata.url))fail('AUTOCONNECT_MANAGEMENT_INVALID');
 const url=new URL(metadata.url);if(Number(url.port)>65535||url.origin!==metadata.url)fail('AUTOCONNECT_MANAGEMENT_INVALID');
 const request=async(route,options={})=>{
  const r=await fetcher(url.origin+route,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Object.assign(Error('AUTOCONNECT_MANAGEMENT_REQUEST_FAILED'),{definite:true});
  return r;
 };
 const health=await (await request('/health')).json();
 if(health.service!=='qq-agent-management'||health.instanceId!==metadata.instance)fail('AUTOCONNECT_MANAGEMENT_CHANGED');
 const boot=await request('/api/bootstrap'),cookie=boot.headers.get('set-cookie')?.split(';')[0],csrf=(await boot.json()).csrf;
 if(!/^qq_console=[a-f0-9]{64}$/.test(cookie||'')||!/^[a-f0-9]{48}$/.test(csrf||''))fail('AUTOCONNECT_LOCAL_SESSION_INVALID');
 return {
  state:async()=>await (await request('/api/state',{headers:{Cookie:cookie}})).json(),
  start:async(state,operationId)=>await (await request('/api/business/start',{method:'POST',headers:{Cookie:cookie,Origin:url.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:state.revision,operationId})})).json()
 };
}
export async function connectOnDesktopStart({runtimeDirectory,clientPid,clientStartedAt,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),managementClient,ownerReady,waitMs=20000}={}){
 const paths=resolveApplicationPaths({dataDirectory:runtimeDirectory}),identity=readApplicationIdentity(paths);
 const generation=clientGeneration(clientPid,clientStartedAt);
 if(clientStartedAt>now()+1500)fail('AUTOCONNECT_CLIENT_INVALID');
 const preferenceFile=path.join(paths.dataDirectory,'desktop-autoconnect.json');
 const enabled=()=>{const p=read(preferenceFile,true);return p?.schemaVersion===1&&p.enabled===true&&p.instanceId===identity.instanceId&&p.hostId===identity.hostId;};
 const statusFile=path.join(paths.dataDirectory,'desktop-autoconnect-status.json');
 const report=(status,extra={})=>{const result={schemaVersion:1,instanceId:identity.instanceId,generation,clientPid,clientStartedAt,status,updatedAt:new Date(now()).toISOString(),...extra};writeApplicationJson(statusFile,result);return result;};
 if(!enabled())return report('disabled');
 // SQLite releases the exclusive helper transaction even after an unexpected process exit.
 const lock=path.join(paths.dataDirectory,'desktop-autoconnect-lock.sqlite');
 if(existsSync(lock)){const s=lstatSync(lock);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('AUTOCONNECT_LOCK_UNSAFE');}
 const mutex=new DatabaseSync(lock);
 try{mutex.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS mutex(id INTEGER);BEGIN IMMEDIATE');}catch(e){mutex.close();if(e.errcode===5)return {status:'busy',generation};throw e;}
 try{
  const journalFile=path.join(paths.dataDirectory,'desktop-autoconnect-attempt.json');
  const prior=read(journalFile,true);
  const metadata=()=>read(path.join(paths.dataDirectory,'management-service.json'));
  const manualStop=()=>{
   const m=metadata();if(m.status==='stopped'&&statSync(path.join(paths.dataDirectory,'management-service.json')).mtimeMs>=clientStartedAt)return true;
   const active=read(path.join(paths.businessDirectory,'active.json'),true);
   if(!uuid(active?.botId)||active.configRelative!==active.botId+'/config.local.json')return false;
   const directory=path.join(paths.businessDirectory,active.botId),stop=path.join(directory,'stop.request.json');
   if(!existsSync(stop)||statSync(stop).mtimeMs<clientStartedAt)return false;
   const request=read(stop),service=read(path.join(directory,'service.json'),true);
   return !!service&&request.instance===service.instance;
  };
  if(manualStop())return report('manual-stop-preserved');
  const client=managementClient||await createManagementClient(metadata());
  let state=await client.state();
  let decision=connectionDecision(state,{manualStop:manualStop(),attempted:prior?.generation===generation});
  if(decision==='needs-configuration'||decision==='manual-stop-preserved'||decision==='already-attempted')return report(decision);
  if(decision==='connected')return report('connected',{reused:true});
  if(decision==='start'){
   if(ownerReady)await ownerReady();
   else{
    let ready=false;
    for(let i=0;i<12&&enabled();i++){
     const owner=new NativeOwnerConnection({timeoutMs:2000});
     try{await owner.ready();ready=true;break;}catch{await sleep(500);}finally{owner.close();}
    }
    if(!ready)return report(enabled()?'client-not-ready':'disabled');
   }
   if(!enabled())return report('disabled');
   state=await client.state();decision=connectionDecision(state,{manualStop:manualStop()});
   if(decision==='start'){
    const attempt={schemaVersion:1,generation,operationId:randomUUID(),state:'intent',createdAt:new Date(now()).toISOString()};
    writeApplicationJson(journalFile,attempt);
    // The durable intent precedes the only POST. Ambiguous responses are never replayed.
    try{await client.start(state,attempt.operationId);attempt.state='submitted';}
    catch(e){attempt.state=e.definite?'rejected':'unknown';writeApplicationJson(journalFile,attempt);return report(attempt.state);}
    writeApplicationJson(journalFile,attempt);
   }else if(!['pending','connecting','connected'].includes(decision))return report(decision);
  }
  const until=now()+waitMs;
  while(enabled()){
   if(manualStop())return report('manual-stop-preserved');
   state=await client.state();decision=connectionDecision(state,{attempted:true});
   if(decision==='connected')return report('connected',{reused:prior?.generation===generation||!existsSync(journalFile)||read(journalFile)?.generation!==generation});
   if(!['pending','connecting'].includes(decision))return report(decision);
   if(now()>=until)return report(decision);
   await sleep(750);
  }
  return report('disabled');
 }finally{
  try{mutex.exec('ROLLBACK');}finally{mutex.close();}
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
 try{console.log(JSON.stringify(await connectOnDesktopStart({runtimeDirectory:get('--runtime'),clientPid:Number(get('--client-pid')),clientStartedAt:Number(get('--client-started-at'))})));}
 catch{console.error('QQ_DESKTOP_AUTOCONNECT_FAILED');process.exitCode=1;}
}
