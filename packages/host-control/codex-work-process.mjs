import { spawn, spawnSync } from 'node:child_process';
import { existsSync,lstatSync,realpathSync,mkdirSync,readFileSync,writeFileSync,readdirSync } from 'node:fs';
import path from 'node:path';
import {prepareApplicationCache} from './application-cache.mjs';
import { reject,scope } from '../core/contracts.mjs';
import { locateAccountCli } from './codex-account-process.mjs';
import { WORK_CLI_VERSION,WORK_PROTOCOL,WORK_INITIALIZE,WORK_CONFIG,WORK_ARGUMENTS,workEnvironment,checkWorkRpc,checkWorkConfiguration,checkWorkLayout,checkEmptyThread,emptyThreadParams,workRuntimeIdentity } from './codex-work-policy.mjs';

function noLinks(full){for(let p=path.resolve(full);;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())reject('WORK_PATH_LINK_FORBIDDEN');if(path.dirname(p)===p)break;}}
export function prepareWorkDirectories(layout,{owner,runtimeIdentity}={}){
  const plan=checkWorkLayout(layout);for(const p of [plan.home,plan.cwd,...plan.controlRoots])noLinks(p);
  scope(owner);if(runtimeIdentity!==workRuntimeIdentity(plan,owner))reject('WORK_RUNTIME_IDENTITY_MISMATCH');
  // The trusted caller creates a fresh synthetic project, not a user checkout.
  if(!existsSync(plan.cwd)||!lstatSync(plan.cwd).isDirectory())reject('WORK_PROJECT_REQUIRED');
  mkdirSync(plan.home,{recursive:true});
  const marker=path.join(plan.home,'qq-work-owner.json');
  const manifest=JSON.stringify({schemaVersion:1,kind:'qq-work-no-generation',scope:scope(owner),runtimeIdentity,home:realpathSync(plan.home),cwd:realpathSync(plan.cwd)});
  if(existsSync(marker)){const st=lstatSync(marker);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||readFileSync(marker,'utf8')!==manifest)reject('WORK_HOME_OWNER_MISMATCH');}
  else{if(readdirSync(plan.home).length)reject('WORK_HOME_NOT_FRESH');writeFileSync(marker,manifest,{flag:'wx',mode:0o600});}
  const config=path.join(plan.home,'config.toml');
  if(existsSync(config)){const st=lstatSync(config);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||readFileSync(config,'utf8')!==WORK_CONFIG)reject('WORK_CONFIG_CHANGED');}
  else writeFileSync(config,WORK_CONFIG,{flag:'wx',mode:0o600});
  prepareApplicationCache(plan.home);
  return {...plan,home:realpathSync(plan.home),cwd:realpathSync(plan.cwd)};
}
// This factory is trusted host composition only. It is never imported by the
// management HTTP graph and deliberately returns no general request/exec API.
export async function openWorkProcess({layout,owner,runtimeIdentity,guard,onSpawn=()=>{},onClose=()=>{},environment=process.env,spawnProcess=spawn,versionProcess=spawnSync,timeoutMs=12000}={}){
  if(typeof guard!=='function')reject('WORK_GUARD_REQUIRED');guard();
  const dirs=prepareWorkDirectories(layout,{owner,runtimeIdentity}),executable=locateAccountCli(environment),env=workEnvironment(environment,dirs.home),options={cwd:dirs.cwd,env,windowsHide:true,shell:false};
  const version=versionProcess(executable,['--version'],{...options,encoding:'utf8',timeout:12000,maxBuffer:4096});
  if(version.status!==0||/codex-cli\s+(\S+)/.exec(version.stdout??'')?.[1]!==WORK_CLI_VERSION)reject('WORK_VERSION_UNVERIFIED');
  guard();const child=spawnProcess(executable,[...WORK_ARGUMENTS],{...options,stdio:['pipe','pipe','pipe']});
  let ended=false,ending=false,buffer='',sequence=0,resolveClosed;
  const ownedThreads=new Set(),pending=new Map(),closed=new Promise(r=>resolveClosed=r);
  const failure=code=>Object.assign(Error(code),{code});
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(failure('WORK_TRANSPORT_UNKNOWN'));}pending.clear();};
  const abort=()=>{fail();if(!ending){ending=true;child.kill();}};
  child.on('error',abort);child.stdin.on('error',abort);child.on('close',()=>{ended=true;fail();resolveClosed();try{onClose();}catch{}});
  child.stderr.on('data',()=>{});child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024*1024){abort();return;}
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines){
      if(!line.trim())continue;let f;try{f=JSON.parse(line);}catch{abort();return;}
      if(!f||Object.getPrototypeOf(f)!==Object.prototype||(f.id!==undefined&&typeof f.id!=='string'&&!Number.isSafeInteger(f.id))){abort();return;}
      try{guard();}catch{abort();return;}
      if(f.method&&f.id!==undefined){child.stdin.write(JSON.stringify({id:f.id,error:{code:-32601,message:'Work lifecycle denies all server requests'}})+'\n');continue;}
      if(f.id!==undefined){const p=pending.get(f.id);if(!p)continue;pending.delete(f.id);clearTimeout(p.timer);if(f.error)p.reject(failure('WORK_RPC_REJECTED'));else if(!Object.hasOwn(f,'result')){p.reject(failure('WORK_TRANSPORT_UNKNOWN'));abort();}else p.resolve(f.result);continue;}
      // Empty-session lifecycle does not project raw upstream events. A real
      // turn/item is unexpected; uncorrelated/early notifications cannot become
      // reliable local Run events or be assigned to the latest thread.
      if(/^turn\/|^item\//.test(f.method??'')){abort();return;}
    }
  });
  const request=(method,params)=>{
    checkWorkRpc(method,params,{cwd:dirs.cwd,ownedThreads});guard();if(ended||ending)reject('WORK_TRANSPORT_UNKNOWN');
    return new Promise((resolve,rejectPromise)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);rejectPromise(failure('WORK_RPC_TIMEOUT'));abort();},timeoutMs);
      pending.set(id,{resolve,reject:rejectPromise,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  };
  const close=async()=>{if(ended)return;ending=true;child.stdin.end();const timer=setTimeout(()=>child.kill(),2000);await closed;clearTimeout(timer);};
  try{
    guard();onSpawn(child.pid);
    const hello=await request('initialize',WORK_INITIALIZE);if(typeof hello?.userAgent!=='string'||!hello.userAgent.includes(WORK_CLI_VERSION))reject('WORK_HANDSHAKE_REJECTED');
    guard();child.stdin.write(JSON.stringify({method:'initialized'})+'\n');checkWorkConfiguration(await request('config/read',{includeLayers:false}));
    const mcp=await request('mcpServerStatus/list',{cursor:null,limit:1});if(!Array.isArray(mcp?.data)||mcp.data.length||mcp.nextCursor)reject('WORK_MCP_NOT_EMPTY');
    return Object.freeze({mode:'real-no-generation',protocolVersion:WORK_PROTOCOL,pid:child.pid,
      probe:()=>{guard();if(ended||ending)reject('WORK_TRANSPORT_UNKNOWN');return {protocolVersion:WORK_PROTOCOL,mcpServers:0,executionEnabled:false};},
      async startEmpty(){const result=await request('thread/start',emptyThreadParams(dirs.cwd));guard();const safe=checkEmptyThread(result,dirs.cwd,{start:true});if(ownedThreads.has(safe.threadId))reject('WORK_DUPLICATE_THREAD');ownedThreads.add(safe.threadId);return safe;},
      async readEmpty(threadId){const result=await request('thread/read',{threadId,includeTurns:false});guard();return checkEmptyThread(result,dirs.cwd,{id:threadId});},
      close});
  }catch(error){await close();throw error;}
}
