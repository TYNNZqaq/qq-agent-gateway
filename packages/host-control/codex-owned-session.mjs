import { spawn,spawnSync } from 'node:child_process';
import { existsSync,lstatSync,realpathSync,mkdirSync,readdirSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { freeze,identifier,reject,scope,scopeKey } from '../core/contracts.mjs';
import { locateAccountCli } from './codex-account-process.mjs';
import { exact,WORK_CLI_VERSION,WORK_PROTOCOL,workEnvironment } from './codex-work-policy.mjs';
import { sessionPlan,SESSION_INITIALIZE,SESSION_PROFILE_ID,sessionStartParams,checkSessionConfig,checkSessionRpc,checkSessionThread } from './codex-session-policy.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function noLinks(full){for(let p=path.resolve(full);;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())reject('SESSION_PATH_LINK');if(path.dirname(p)===p)break;}}
function regular(file){noLinks(file);const s=lstatSync(file);if(!s.isFile()||s.nlink!==1)reject('SESSION_FILE_INVALID');}
function canonical(plan){for(const p of [plan.home,plan.cwd,...plan.controlRoots]){noLinks(p);if(existsSync(p)&&(!lstatSync(p).isDirectory()||path.resolve(realpathSync(p))!==p))reject('SESSION_PATH_CHANGED');}}
const markerValue=(plan,owner)=>JSON.stringify({schemaVersion:1,kind:'codex-owned-profile-session',scope:scope(owner),identity:plan.identity,grantIdentity:plan.grantIdentity,home:plan.home,cwd:plan.cwd});
export function prepareSessionHome(plan,owner){
  canonical(plan);if(!existsSync(plan.cwd))reject('SESSION_PROJECT_REQUIRED');
  mkdirSync(plan.home,{recursive:true});canonical(plan);
  const marker=path.join(plan.home,'qq-session-owner.json'),value=markerValue(plan,owner);
  if(existsSync(marker)){regular(marker);if(readFileSync(marker,'utf8')!==value)reject('SESSION_HOME_OWNER');}
  else{if(readdirSync(plan.home).length)reject('SESSION_HOME_NOT_FRESH');writeFileSync(marker,value,{flag:'wx',mode:0o600});}
  const config=path.join(plan.home,'config.toml');if(existsSync(config)){regular(config);if(readFileSync(config,'utf8')!==plan.config)reject('SESSION_CONFIG_CHANGED');}
  else writeFileSync(config,plan.config,{flag:'wx',mode:0o600});
}
function checkHome(plan,owner){
  canonical(plan);const marker=path.join(plan.home,'qq-session-owner.json'),config=path.join(plan.home,'config.toml');regular(marker);regular(config);
  if(readFileSync(marker,'utf8')!==markerValue(plan,owner)||readFileSync(config,'utf8')!==plan.config)reject('SESSION_CONFIG_CHANGED');
}

// Independent, no-model Session composition. Never imported by management.
// Only fixed methods are exposed; no request, executor, account or turn writer.
export async function openOwnedSessionProcess({plan,owner,guard,onSpawn,retain=()=>{},environment=process.env,spawnProcess=spawn,versionProcess=spawnSync,timeoutMs=12000}){
  if(typeof guard!=='function'||typeof onSpawn!=='function'||typeof retain!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000)reject('SESSION_DEPENDENCIES');
  guard();const original=sessionPlan({home:plan.home,cwd:plan.cwd,controlRoots:plan.controlRoots},owner,plan.grant);
  if(!same(original,plan))reject('SESSION_PLAN_CHANGED');prepareSessionHome(plan,owner);
  const verify=()=>{guard();checkHome(plan,owner);guard();};
  const executable=locateAccountCli(environment),allowedEnvironment=workEnvironment(environment,plan.home),env={};
  // Native MXC/helper maps may preserve Windows spelling even though Win32
  // lookup is case insensitive. Supply one canonical spelling per allowlist key.
  for(const [key,value] of Object.entries(allowedEnvironment)){const canonical=key.toUpperCase();if(Object.hasOwn(env,canonical))reject('SESSION_ENVIRONMENT_AMBIGUOUS');env[canonical]=value;}
  if(typeof env.SYSTEMROOT!=='string'||path.resolve(env.SYSTEMROOT)!==plan.minimalEnvironment.SYSTEMROOT)reject('SESSION_ENVIRONMENT_CHANGED');
  const options={cwd:plan.cwd,env,windowsHide:true,shell:false};
  const version=versionProcess(executable,['--version'],{...options,encoding:'utf8',timeout:12000,maxBuffer:8192});
  if(version.status!==0||/codex-cli\s+(\S+)/.exec(version.stdout??'')?.[1]!==WORK_CLI_VERSION)reject('SESSION_VERSION_UNVERIFIED');
  verify();const child=spawnProcess(executable,['app-server','--listen','stdio://'],{...options,stdio:['pipe','pipe','pipe']});
  let ending=false,ended=false,buffer='',sequence=0,resolveClosed,starting=false,started=null,notification=null;
  const ownedThreads=new Set(),pending=new Map(),closed=new Promise(r=>resolveClosed=r);
  const error=code=>Object.assign(Error(code),{code});
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error('SESSION_TRANSPORT_UNKNOWN'));}pending.clear();};
  const abort=()=>{fail();if(!ending){ending=true;child.kill();}};
  const preserve=f=>{const r=retain(structuredClone(f));if(r!==undefined&&r!==true)reject('SESSION_RETENTION_NOT_SYNCHRONOUS');verify();};
  const recordStart=t=>{
    const safe=checkSessionThread({thread:t},plan);
    if(!starting&&!started)reject('SESSION_UNOWNED_NOTIFICATION');
    if(started&&(safe.threadId!==started.threadId||safe.sessionId!==started.sessionId)||notification&&notification.threadId!==safe.threadId)reject('SESSION_UNOWNED_NOTIFICATION');
    notification=safe;
  };
  child.on('error',abort);child.stdin.on('error',abort);child.on('close',()=>{ended=true;fail();resolveClosed();});
  child.stderr.on('data',()=>{});child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>256*1024){abort();return;}
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines){if(!line.trim())continue;
      try{
        const f=JSON.parse(line);if(!f||Object.getPrototypeOf(f)!==Object.prototype)reject('SESSION_INVALID_FRAME');verify();preserve(f);
        if(Object.hasOwn(f,'method')){
          if(Object.hasOwn(f,'result')||Object.hasOwn(f,'error')||typeof f.method!=='string')reject('SESSION_INVALID_FRAME');
          if(Object.hasOwn(f,'id')){if(typeof f.id!=='string'&&!Number.isSafeInteger(f.id))reject('SESSION_INVALID_FRAME');verify();child.stdin.write(JSON.stringify({id:f.id,error:{code:-32601,message:'Owned empty Session denies all server requests'}})+'\n');}
          else if(f.method==='thread/started'){if(!exact(f.params,['thread']))reject('SESSION_INVALID_FRAME');recordStart(f.params.thread);}
          else if(f.method==='remoteControl/status/changed'){
            if(!exact(f.params,['status','serverName','installationId','environmentId'])||f.params.status!=='disabled'||f.params.environmentId!==null||typeof f.params.serverName!=='string'||typeof f.params.installationId!=='string')reject('SESSION_REMOTE_CONTROL_REJECTED');
          }else reject('SESSION_UNEXPECTED_NOTIFICATION');
          continue;
        }
        const p=pending.get(f.id);if(!p||Object.hasOwn(f,'result')===Object.hasOwn(f,'error')||!exact(f,['id',Object.hasOwn(f,'result')?'result':'error']))reject('SESSION_INVALID_FRAME');
        // Validate start while still pending, before resolving and before any
        // following notification in the same stdout chunk can be accepted.
        if(p.method==='thread/start'&&Object.hasOwn(f,'result')){
          const safe=checkSessionThread(f.result,plan,{start:true});
          if(notification&&(safe.threadId!==notification.threadId||safe.sessionId!==notification.sessionId))reject('SESSION_UNOWNED_NOTIFICATION');
          started=safe;
        }
        pending.delete(f.id);clearTimeout(p.timer);if(Object.hasOwn(f,'error'))p.reject(error('SESSION_RPC_REJECTED'));else p.resolve(f.result);
      }catch{abort();return;}
    }
  });
  const request=(method,params)=>{
    checkSessionRpc(method,params,plan,ownedThreads);verify();if(ended||ending)reject('SESSION_TRANSPORT_UNKNOWN');
    return new Promise((resolve,rejectPromise)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);rejectPromise(error('SESSION_RPC_TIMEOUT'));abort();},timeoutMs);pending.set(id,{method,resolve,reject:rejectPromise,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  };
  const close=async()=>{if(ended)return;ending=true;child.stdin.end();const timer=setTimeout(()=>child.kill(),1000);await closed;clearTimeout(timer);};
  try{
    verify();onSpawn(child.pid);const hello=await request('initialize',SESSION_INITIALIZE);if(typeof hello?.userAgent!=='string'||!hello.userAgent.includes(WORK_CLI_VERSION))reject('SESSION_HANDSHAKE_REJECTED');
    verify();child.stdin.write(JSON.stringify({method:'initialized'})+'\n');checkSessionConfig(await request('config/read',{includeLayers:false}),plan);
    const mcp=await request('mcpServerStatus/list',{cursor:null,limit:1});if(!Array.isArray(mcp?.data)||mcp.data.length||mcp.nextCursor!=null)reject('SESSION_MCP_NOT_EMPTY');
    const profiles=await request('permissionProfile/list',{cwd:plan.cwd,cursor:null,limit:100});
    if(!Array.isArray(profiles?.data)||profiles.nextCursor!=null||profiles.data.filter(p=>p.id===SESSION_PROFILE_ID).length!==1||profiles.data.find(p=>p.id===SESSION_PROFILE_ID)?.allowed!==true)reject('SESSION_PROFILE_NOT_ALLOWED');
    verify();return Object.freeze({mode:'real-owned-profile-empty-session',protocolVersion:WORK_PROTOCOL,pid:child.pid,identity:plan.identity,grantIdentity:plan.grantIdentity,
      probe(){verify();if(ended||ending)reject('SESSION_TRANSPORT_UNKNOWN');return {mcpServers:0,profileId:SESSION_PROFILE_ID,executionEnabled:false};},
      async startEmpty(){verify();if(starting||started)reject('SESSION_START_ALREADY_ATTEMPTED');starting=true;const result=await request('thread/start',sessionStartParams(plan));verify();if(ending||ended)reject('SESSION_TRANSPORT_UNKNOWN');const safe=checkSessionThread(result,plan,{start:true});ownedThreads.add(safe.threadId);return safe;},
      async readEmpty(threadId,sessionId){if(!started||!ownedThreads.has(threadId)||sessionId!==started.sessionId)reject('SESSION_THREAD_NOT_OWNED');const result=await request('thread/read',{threadId,includeTurns:false});verify();if(ended||ending)reject('SESSION_TRANSPORT_UNKNOWN');return checkSessionThread(result,plan,{id:threadId,sessionId});},
      close});
  }catch(e){await close();throw e;}
}

export class CodexOwnedSession {
  #state;#plan;#journal;#authorize;#factory;#handle=null;#busy=false;#closed=false;#broken=false;
  constructor({owner,layout,grant,journal,authorize,transportFactory=openOwnedSessionProcess}){
    Object.defineProperty(this,'owner',{value:scope(owner),writable:false,configurable:false});
    if(!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||typeof authorize!=='function'||typeof transportFactory!=='function')reject('SESSION_DEPENDENCIES');
    this.#plan=sessionPlan(layout,this.owner,grant);this.#journal=journal;this.#authorize=authorize;this.#factory=transportFactory;
    const old=journal.load();
    if(old&&(old.schemaVersion!==1||old.channelKind!=='codex-owned-profile-session'||old.protocol!==WORK_PROTOCOL||old.planIdentity!==this.#plan.identity||old.grantIdentity!==this.#plan.grantIdentity||scopeKey(old.scope)!==scopeKey(this.owner)||!exact(old.owner,['hostId','agentId'])||old.owner.hostId!==this.owner.hostId||old.owner.agentId!==this.owner.agentId))reject('SESSION_JOURNAL_OWNER_OR_VERSION');
    this.#state=old??{schemaVersion:1,channelKind:'codex-owned-profile-session',revision:0,owner:{hostId:this.owner.hostId,agentId:this.owner.agentId},scope:this.owner,protocol:WORK_PROTOCOL,planIdentity:this.#plan.identity,grantIdentity:this.#plan.grantIdentity,process:null,session:null};
    const p=this.#state.process,s=this.#state.session;
    if(p&&(!exact(p,['state','pid'])||!['starting','ready','unknown','closed'].includes(p.state)||p.pid!==null&&(!Number.isSafeInteger(p.pid)||p.pid<=0)))reject('SESSION_JOURNAL_INVALID');
    if(s){if(!exact(s,['key','state','threadId','sessionId','profileId'])||!['intent','unknown','opened','closed'].includes(s.state)||s.profileId!==SESSION_PROFILE_ID||(s.threadId===null)!==(s.sessionId===null))reject('SESSION_JOURNAL_INVALID');identifier(s.key);if(s.threadId!==null){identifier(s.threadId);identifier(s.sessionId);if(s.threadId!==s.sessionId)reject('SESSION_JOURNAL_INVALID');}if(['opened','closed'].includes(s.state)&&(!s.threadId||!p))reject('SESSION_JOURNAL_INVALID');if(s.state==='intent')s.state='unknown';}
    if(p&&p.state!=='closed')p.state='unknown';this.#save();
  }
  #guard(){if(this.#broken||this.#closed)reject('SESSION_OBJECT_UNAVAILABLE');if((this.#journal.load()?.revision??0)!==this.#state.revision){this.#broken=true;reject('SESSION_STALE_OBJECT');}}
  #save(){const next=structuredClone(this.#state);next.revision++;try{if(this.#journal.commit(next,this.#state.revision)!==true)reject('SESSION_STALE_OBJECT');this.#state=next;}catch(e){this.#broken=true;throw e;}}
  #check(owner,operation){this.#guard();if(scopeKey(owner)!==scopeKey(this.owner))reject('SESSION_OWNER_MISMATCH');if(this.#authorize(freeze({scope:scope(owner),operation,planIdentity:this.#plan.identity,grantIdentity:this.#plan.grantIdentity,grant:this.#plan.grant,executionApproved:false}))!==true)reject('SESSION_AUTHORIZATION_REJECTED');this.#guard();}
  snapshot(owner){this.#check(owner,'status');return structuredClone({...this.#state,executionEnabled:false,turnTransportAccepted:false,eventsReliable:false});}
  async #process(owner){
    this.#check(owner,'prepare');if(this.#handle)return this.#handle;if(this.#state.process)reject('SESSION_PREVIOUS_PROCESS_UNKNOWN');
    this.#state.process={state:'starting',pid:null};this.#save();this.#check(owner,'beforeSpawn');
    const h=await this.#factory({plan:this.#plan,owner:this.owner,guard:()=>this.#check(owner,'transport'),onSpawn:pid=>{this.#check(owner,'spawn');if(!Number.isSafeInteger(pid)||pid<=0)reject('SESSION_PID_INVALID');this.#state.process.pid=pid;this.#save();}});
    try{this.#check(owner,'prepared');if(h?.mode!=='real-owned-profile-empty-session'||h.protocolVersion!==WORK_PROTOCOL||h.identity!==this.#plan.identity||h.grantIdentity!==this.#plan.grantIdentity||h.pid!==this.#state.process.pid||!h.pid)reject('SESSION_TRANSPORT_MODE_REJECTED');this.#state.process.state='ready';this.#save();this.#handle=h;return h;}catch(e){await h?.close();throw e;}
  }
  async #serial(owner,operation,work){this.#check(owner,operation);if(this.#busy)reject('SESSION_BUSY');this.#busy=true;try{return await work();}finally{this.#busy=false;}}
  async probe(owner){return this.#serial(owner,'probe',async()=>{const h=await this.#process(owner);this.#check(owner,'afterProbe');return h.probe();});}
  async openSession(owner,{key,...extra}){
    identifier(key);if(Object.keys(extra).length)reject('SESSION_FIELDS_FORBIDDEN');
    return this.#serial(owner,'openSession',async()=>{
      if(this.#state.session){if(this.#state.session.key!==key)reject('SESSION_PREVIOUS_SESSION');return structuredClone(this.#state.session);}
      this.#state.session={key,state:'intent',threadId:null,sessionId:null,profileId:SESSION_PROFILE_ID};this.#save();
      try{const h=await this.#process(owner);this.#check(owner,'beforeOpen');const r=await h.startEmpty();this.#check(owner,'afterOpen');identifier(r?.threadId);identifier(r.sessionId);
        if(r.threadId!==r.sessionId||r.empty!==true||r.profileId!==SESSION_PROFILE_ID||r.planIdentity!==this.#plan.identity||r.grantIdentity!==this.#plan.grantIdentity)reject('SESSION_THREAD_RESULT_REJECTED');
        this.#state.session={...this.#state.session,state:'opened',threadId:r.threadId,sessionId:r.sessionId};this.#check(owner,'beforeSave');this.#save();return structuredClone(this.#state.session);
      }catch(e){try{this.#check(owner,'unknown');this.#state.session.state='unknown';this.#save();}catch{}throw e;}
    });
  }
  async reconcile(owner,{key,...extra}){identifier(key);if(Object.keys(extra).length)reject('SESSION_FIELDS_FORBIDDEN');return this.#serial(owner,'reconcile',async()=>{
    const s=this.#state.session;if(s?.key!==key)reject('SESSION_NOT_OWNED');if(!s.threadId||s.state!=='opened'||!this.#handle)return {state:'unknown',threadId:s.threadId,reason:'NO_LIVE_OWNED_PROFILE_SESSION'};
    const r=await this.#handle.readEmpty(s.threadId,s.sessionId);this.#check(owner,'afterRead');if(r.threadId!==s.threadId||r.sessionId!==s.sessionId||r.profileId!==SESSION_PROFILE_ID||r.planIdentity!==this.#plan.identity||r.grantIdentity!==this.#plan.grantIdentity||r.empty!==true)reject('SESSION_THREAD_RESULT_REJECTED');return {state:'observed_empty',threadId:s.threadId,sessionId:s.sessionId,profileId:s.profileId,executionEnabled:false};
  });}
  events(owner,{key,...extra}){if(Object.keys(extra).length)reject('SESSION_FIELDS_FORBIDDEN');this.#check(owner,'events');if(this.#state.session?.key!==key)reject('SESSION_NOT_OWNED');return {events:[],reliable:false,reason:'NO_OWNED_TURN_OR_DURABLE_UPSTREAM_EVENT_BRIDGE'};}
  async close(owner){return this.#serial(owner,'close',async()=>{if(this.#handle){const h=this.#handle;this.#handle=null;await h.close();this.#check(owner,'afterClose');this.#state.process.state='closed';if(this.#state.session?.state==='opened')this.#state.session.state='closed';this.#save();}else if(this.#state.process&&this.#state.process.state!=='closed')reject('SESSION_PREVIOUS_PROCESS_UNKNOWN');this.#closed=true;return {localProcessClosed:true,turnCancellationConfirmed:false};});}
  async dispose(){this.#closed=true;const h=this.#handle;this.#handle=null;if(h)await h.close();return {localHandleEnded:true,persistedOutcomeUnchanged:true};}
}
