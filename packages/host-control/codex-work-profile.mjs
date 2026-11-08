import { spawn,spawnSync } from 'node:child_process';
import { existsSync,lstatSync,realpathSync,mkdirSync,readdirSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest,scope,scopeKey,freeze,identifier,reject } from '../core/contracts.mjs';
import { locateAccountCli } from './codex-account-process.mjs';
import { WORK_CLI_VERSION,WORK_PROTOCOL,WORK_CONFIG,workEnvironment,checkWorkLayout,exact } from './codex-work-policy.mjs';

// Trusted, no-model composition. This is not a task/turn executor or a generic RPC.
export const PROFILE_ID='qq-fixed-canary';
export const PROFILE_INITIALIZE=freeze({clientInfo:{name:'qq_gateway_profile_canary',version:'1.0.0'},capabilities:{experimentalApi:true}});
export const CANARY_VALUE='NONSECRET_QQ_PROFILE_CANARY';
export const PROFILE_CHECKS=Object.freeze(['projectRead','projectWrite','controlReadDenied','controlWriteDenied','privateReadDenied','privateWriteDenied','homeReadDenied','networkDenied','environmentClean']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const within=(a,b)=>{const r=path.relative(a,b);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
function noLinks(full){for(let p=path.resolve(full);;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())reject('PROFILE_PATH_LINK');if(path.dirname(p)===p)break;}}
function regular(file){noLinks(file);const s=lstatSync(file);if(!s.isFile()||s.nlink!==1)reject('PROFILE_FILE_INVALID');}
function canary(file){regular(file);if(readFileSync(file,'utf8')!==CANARY_VALUE)reject('PROFILE_CANARY_CHANGED');}

export function profilePlan(layout,owner){
  if(!exact(layout,['home','cwd','controlRoots','controlCanary','privateCanary','port']))reject('PROFILE_LAYOUT_FIELDS');
  const base=checkWorkLayout(layout);scope(owner);
  if(!Number.isSafeInteger(layout.port)||layout.port<1||layout.port>65535)reject('PROFILE_BASELINE_PORT_REQUIRED');
  const targets=['controlCanary','privateCanary'].map(k=>{const f=layout[k];if(typeof f!=='string'||!path.isAbsolute(f)||path.basename(f)!=='.qq-profile-canary')reject('PROFILE_CANARY_PATH');return path.resolve(f);});
  if(base.controlRoots.length<2||targets[0]===targets[1]||!within(base.controlRoots[0],targets[0])||!base.controlRoots.slice(1).some(r=>within(r,targets[1]))||base.controlRoots.some(r=>within(r,base.home)||within(base.home,r)))reject('PROFILE_CONTROL_LAYOUT');
  const systemRoot=Object.entries(process.env).find(([k])=>k.toUpperCase()==='SYSTEMROOT')?.[1];
  if(process.platform!=='win32'||typeof systemRoot!=='string'||!path.isAbsolute(systemRoot))reject('PROFILE_WINDOWS_SYSTEMROOT_REQUIRED');
  const p={...base,controlCanary:targets[0],privateCanary:targets[1],port:layout.port,nodeExecutable:process.execPath,systemRoot:path.resolve(systemRoot),homeCanary:path.join(base.home,'.qq-profile-canary'),input:path.join(base.cwd,'canary-input.txt'),output:path.join(base.cwd,'canary-output.txt')};
  const config='default_permissions = "'+PROFILE_ID+'"\n'+WORK_CONFIG.replace('sandbox_mode = "read-only"\n','')+'\n[windows]\nsandbox = "mxc"\n[shell_environment_policy]\ninherit = "none"\n[permissions.'+PROFILE_ID+'.filesystem]\n":root" = "deny"\n":minimal" = "read"\n'+[...new Set([base.cwd,path.dirname(process.execPath),...base.controlRoots,base.home])].map(f=>JSON.stringify(f)+' = "'+(f===base.cwd?'write':f===path.dirname(process.execPath)?'read':'deny')+'"').join('\n')+'\n[permissions.'+PROFILE_ID+'.network]\nenabled = false\n';
  const identity=digest(JSON.stringify({scope:scopeKey(owner),...p,config}));
  return freeze({...p,config,identity});
}

// Only these compiled operations can be sent. JSON encoding keeps fixture paths
// as data, never as interpolated shell source. No shell or command is caller input.
export function profileCommand(plan){
  const data={input:plan.input,output:plan.output,control:plan.controlCanary,private:plan.privateCanary,home:plan.homeCanary,port:plan.port,value:CANARY_VALUE};
  const code='const fs=require("node:fs"),net=require("node:net"),p='+JSON.stringify(data)+';const r={};const deniedRead=f=>{try{fs.readFileSync(f);return false}catch(e){return ["EACCES","EPERM"].includes(e.code)}};const deniedWrite=f=>{try{fs.writeFileSync(f,"UNEXPECTED_CANARY_WRITE");return false}catch(e){return ["EACCES","EPERM"].includes(e.code)}};try{r.projectRead=fs.readFileSync(p.input,"utf8")===p.value}catch{r.projectRead=false}try{fs.writeFileSync(p.output,"OK",{flag:"wx"});r.projectWrite=true}catch{r.projectWrite=false}r.controlReadDenied=deniedRead(p.control);r.controlWriteDenied=deniedWrite(p.control);r.privateReadDenied=deniedRead(p.private);r.privateWriteDenied=deniedWrite(p.private);r.homeReadDenied=deniedRead(p.home);r.environmentClean=!Object.keys(process.env).some(k=>/API_KEY|TOKEN|SECRET|PROXY|NODE_OPTIONS|MCP|CODEX_THREAD|CODEX_SESSION/i.test(k));let done=false;const finish=v=>{if(done)return;done=true;r.networkDenied=v;console.log(JSON.stringify(r));process.exitCode=Object.values(r).every(v=>v===true)?0:7};const s=net.createConnection({host:"127.0.0.1",port:p.port});s.setTimeout(1200);s.once("connect",()=>{s.destroy();finish(false)});s.once("error",e=>finish(["EACCES","EPERM","ENETUNREACH"].includes(e.code)));s.once("timeout",()=>{s.destroy();finish(false)});';
  return freeze({command:[plan.nodeExecutable,'-e',code],cwd:plan.cwd,permissionProfile:PROFILE_ID,env:{SYSTEMROOT:plan.systemRoot},timeoutMs:5000,outputBytesCap:16384});
}
export function checkProfileRpc(method,params,plan){
  const expected={initialize:PROFILE_INITIALIZE,'config/read':{includeLayers:false},'mcpServerStatus/list':{cursor:null,limit:1},'permissionProfile/list':{cwd:plan.cwd,cursor:null,limit:100},'command/exec':profileCommand(plan)};
  if(!Object.hasOwn(expected,method)||!same(params,expected[method]))reject('PROFILE_RPC_FORBIDDEN');
}
export function checkProfileConfig(value,plan){
  const c=value?.config,expected={':root':'deny',':minimal':'read',[plan.cwd]:'write',[path.dirname(plan.nodeExecutable)]:'read',...Object.fromEntries([...plan.controlRoots,plan.home].map(p=>[p,'deny']))},selected=c?.permissions?.[PROFILE_ID];
  const onlyNullExtras=(v,primary,known)=>v&&Object.entries(v).every(([k,x])=>primary.includes(k)||known.includes(k)&&x===null);
  const filesystem={...selected?.filesystem};if(filesystem.glob_scan_max_depth===null)delete filesystem.glob_scan_max_depth;
  const sorted=v=>Object.fromEntries(Object.entries(v).sort());
  if(c?.forced_login_method!=='chatgpt'||c.cli_auth_credentials_store!=='file'||c.model_provider!=='openai'||c.approval_policy!=='never'||c.default_permissions!==PROFILE_ID||c.windows?.sandbox!=='mxc'||!onlyNullExtras(c.windows,['sandbox'],['allow_mxc'])||c.web_search!=='disabled'||c.allow_login_shell!==false||c.shell_environment_policy?.inherit!=='none'||!onlyNullExtras(c.shell_environment_policy,['inherit'],['ignore_default_excludes','exclude','set','include_only','filters','experimental_use_profile'])||!c.mcp_servers||Object.keys(c.mcp_servers).length||Object.keys(c.permissions??{}).length!==1||!onlyNullExtras(selected,['filesystem','network'],['description','extends','workspace_roots'])||!same(sorted(filesystem),sorted(expected))||selected?.network?.enabled!==false||!onlyNullExtras(selected.network,['enabled'],['proxy_url','enable_socks5','socks_url','enable_socks5_udp','allow_upstream_proxy','dangerously_allow_non_loopback_proxy','dangerously_allow_all_unix_sockets','mode','domains','unix_sockets','allow_local_binding','mitm']))reject('PROFILE_CONFIG_REJECTED');
  for(const f of ['apps','plugins','hooks','multi_agent','browser_use','computer_use','image_generation','memories','remote_control'])if(c.features?.[f]!==false)reject('PROFILE_CONFIG_REJECTED');
}
export function prepareProfileHome(plan,owner){
  for(const p of [plan.home,plan.cwd,...plan.controlRoots])noLinks(p);
  if(!lstatSync(plan.cwd).isDirectory()||existsSync(plan.output))reject('PROFILE_PROJECT_NOT_FRESH');
  canary(plan.input);canary(plan.controlCanary);canary(plan.privateCanary);
  mkdirSync(plan.home,{recursive:true});
  const marker=path.join(plan.home,'qq-profile-owner.json'),manifest=JSON.stringify({schemaVersion:1,kind:'qq-fixed-profile-canary',scope:scope(owner),identity:plan.identity,home:realpathSync(plan.home),cwd:realpathSync(plan.cwd)});
  if(existsSync(marker)){regular(marker);if(readFileSync(marker,'utf8')!==manifest)reject('PROFILE_HOME_OWNER');}
  else{if(readdirSync(plan.home).length)reject('PROFILE_HOME_NOT_FRESH');writeFileSync(marker,manifest,{flag:'wx',mode:0o600});}
  for(const [file,value] of [[path.join(plan.home,'config.toml'),plan.config],[plan.homeCanary,CANARY_VALUE]]){if(existsSync(file)){regular(file);if(readFileSync(file,'utf8')!==value)reject('PROFILE_CONFIG_CHANGED');}else writeFileSync(file,value,{flag:'wx',mode:0o600});}
}
function checkProfileHome(plan,owner){
  for(const p of [plan.home,plan.cwd,...plan.controlRoots])noLinks(p);
  const marker=path.join(plan.home,'qq-profile-owner.json'),config=path.join(plan.home,'config.toml');regular(marker);regular(config);
  const expected=JSON.stringify({schemaVersion:1,kind:'qq-fixed-profile-canary',scope:scope(owner),identity:plan.identity,home:realpathSync(plan.home),cwd:realpathSync(plan.cwd)});
  if(readFileSync(marker,'utf8')!==expected||readFileSync(config,'utf8')!==plan.config)reject('PROFILE_CONFIG_CHANGED');
}

export async function openProfileProcess({plan,owner,guard,onSpawn,retain=()=>{},environment=process.env,spawnProcess=spawn,versionProcess=spawnSync,timeoutMs=12000}){
  if(typeof guard!=='function'||typeof onSpawn!=='function'||typeof retain!=='function')reject('PROFILE_DEPENDENCIES');guard();
  const original=profilePlan(Object.fromEntries(['home','cwd','controlRoots','controlCanary','privateCanary','port'].map(k=>[k,plan[k]])),owner);
  if(!same(plan,original))reject('PROFILE_PLAN_CHANGED');
  prepareProfileHome(plan,owner);
  const verify=()=>{guard();checkProfileHome(plan,owner);guard();};
  const cli=locateAccountCli(environment),options={cwd:plan.cwd,env:workEnvironment(environment,plan.home),windowsHide:true,shell:false};
  const version=versionProcess(cli,['--version'],{...options,encoding:'utf8',timeout:12000,maxBuffer:8192});
  if(version.status!==0||/codex-cli\s+(\S+)/.exec(version.stdout??'')?.[1]!==WORK_CLI_VERSION)reject('PROFILE_VERSION_UNVERIFIED');
  verify();const child=spawnProcess(cli,['app-server','--listen','stdio://'],{...options,stdio:['pipe','pipe','pipe']});
  let ending=false,ended=false,buffer='',sequence=0,executed=false,resolveClosed;const pending=new Map(),closed=new Promise(r=>resolveClosed=r);
  const error=code=>Object.assign(Error(code),{code});
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error('PROFILE_TRANSPORT_UNKNOWN'));}pending.clear();};
  const abort=()=>{fail();if(!ending){ending=true;child.kill();}};
  child.on('error',abort);child.stdin.on('error',abort);child.on('close',()=>{ended=true;fail();resolveClosed();});
  child.stderr.on('data',()=>{});child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>256*1024){abort();return;}
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines){if(!line.trim())continue;let f;try{f=JSON.parse(line);verify();}catch{abort();return;}
      if(!f||Object.getPrototypeOf(f)!==Object.prototype){abort();return;}
      if(Object.hasOwn(f,'method')){
        if(Object.hasOwn(f,'id')){if(typeof f.id!=='string'&&!Number.isSafeInteger(f.id)){abort();return;}child.stdin.write(JSON.stringify({id:f.id,error:{code:-32601,message:'Fixed canary denies all server requests'}})+'\n');}
        else if(f.method==='remoteControl/status/changed'){
          if(!exact(f.params,['status','serverName','installationId','environmentId'])||f.params.status!=='disabled'||f.params.environmentId!==null||typeof f.params.serverName!=='string'||typeof f.params.installationId!=='string'){abort();return;}
        }else if(f.method!=='warning'){abort();return;}
        continue;
      }
      const p=pending.get(f.id);if(!p){abort();return;}pending.delete(f.id);clearTimeout(p.timer);
      try{if(retain(structuredClone(f))?.then)reject('PROFILE_ASYNC_EVIDENCE_FORBIDDEN');verify();}catch{p.reject(error('PROFILE_EVIDENCE_OR_OWNER_UNKNOWN'));abort();return;}
      if(Object.hasOwn(f,'error'))p.reject(error('PROFILE_RPC_REJECTED'));
      else if(Object.hasOwn(f,'result'))p.resolve(f.result);
      else{p.reject(error('PROFILE_TRANSPORT_UNKNOWN'));abort();return;}
    }
  });
  const request=(method,params)=>{
    checkProfileRpc(method,params,plan);verify();if(ending||ended)reject('PROFILE_TRANSPORT_UNKNOWN');
    return new Promise((resolve,rejectPromise)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);rejectPromise(error('PROFILE_RPC_TIMEOUT'));abort();},timeoutMs);pending.set(id,{resolve,reject:rejectPromise,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  };
  const close=async()=>{if(ended)return;ending=true;child.stdin.end();const timer=setTimeout(()=>child.kill(),1000);await closed;clearTimeout(timer);};
  try{
    verify();onSpawn(child.pid);const hello=await request('initialize',PROFILE_INITIALIZE);if(typeof hello?.userAgent!=='string'||!hello.userAgent.includes(WORK_CLI_VERSION))reject('PROFILE_HANDSHAKE_REJECTED');
    verify();child.stdin.write(JSON.stringify({method:'initialized'})+'\n');checkProfileConfig(await request('config/read',{includeLayers:false}),plan);
    const mcp=await request('mcpServerStatus/list',{cursor:null,limit:1});if(!Array.isArray(mcp?.data)||mcp.data.length||mcp.nextCursor)reject('PROFILE_MCP_NOT_EMPTY');
    const profiles=await request('permissionProfile/list',{cwd:plan.cwd,cursor:null,limit:100});
    if(!Array.isArray(profiles?.data)||profiles.nextCursor||profiles.data.filter(p=>p.id===PROFILE_ID).length!==1||profiles.data.find(p=>p.id===PROFILE_ID)?.allowed!==true)reject('PROFILE_NOT_ALLOWED');
    verify();return Object.freeze({mode:'real-fixed-profile-canary',protocolVersion:WORK_PROTOCOL,pid:child.pid,identity:plan.identity,
      async runFixedCanary(){verify();if(executed)reject('PROFILE_COMMAND_ALREADY_ATTEMPTED');executed=true;const result=await request('command/exec',profileCommand(plan));verify();
        if(!exact(result,['exitCode','stdout','stderr'])||!Number.isInteger(result.exitCode)||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>16384||typeof result.stderr!=='string'||Buffer.byteLength(result.stderr)>16384)reject('PROFILE_RESULT_INVALID');
        let checks;try{checks=JSON.parse(result.stdout);}catch{reject('PROFILE_CANARY_NO_REPORT');}
        if(!exact(checks,PROFILE_CHECKS)||!PROFILE_CHECKS.every(k=>typeof checks[k]==='boolean'))reject('PROFILE_CANARY_REPORT_INVALID');
        canary(plan.controlCanary);canary(plan.privateCanary);canary(plan.homeCanary);
        return {status:result.exitCode===0&&PROFILE_CHECKS.every(k=>checks[k])?'canary_checks_passed_only':'failed_closed',exitCode:result.exitCode,checks,canaryIntegrity:true,mcpServers:0,executionEnabled:false};
      },close});
  }catch(e){await close();throw e;}
}

// One fixed attempt per immutable plan/channel. Construction fences older objects;
// reopening never starts a process or replays an unknown command.
export class CodexWorkProfileCanary {
  #journal;#state;#plan;#authorize;#factory;#handle=null;#busy=false;#broken=false;#closed=false;
  constructor({owner,layout,journal,authorize,transportFactory=openProfileProcess}){
    Object.defineProperty(this,'owner',{value:scope(owner),writable:false,configurable:false});
    if(!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||typeof authorize!=='function'||typeof transportFactory!=='function')reject('PROFILE_DEPENDENCIES');
    this.#plan=profilePlan(layout,this.owner);this.#journal=journal;this.#authorize=authorize;this.#factory=transportFactory;
    const old=journal.load();
    if(old&&(old.schemaVersion!==1||old.channelKind!=='codex-work-profile-canary'||old.protocol!==WORK_PROTOCOL||old.planIdentity!==this.#plan.identity||scopeKey(old.scope)!==scopeKey(this.owner)))reject('PROFILE_JOURNAL_OWNER_OR_VERSION');
    this.#state=old??{schemaVersion:1,channelKind:'codex-work-profile-canary',revision:0,owner:{hostId:this.owner.hostId,agentId:this.owner.agentId},scope:this.owner,protocol:WORK_PROTOCOL,planIdentity:this.#plan.identity,process:null,attempt:null};
    if(this.#state.attempt&&!['intent','unknown','observed'].includes(this.#state.attempt.state))reject('PROFILE_JOURNAL_INVALID');
    if(this.#state.attempt?.state==='intent')this.#state.attempt.state='unknown';this.#save();
  }
  #save(){const next=structuredClone(this.#state);next.revision++;try{if(this.#journal.commit(next,this.#state.revision)!==true)reject('PROFILE_STALE_OBJECT');this.#state=next;}catch(e){this.#broken=true;throw e;}}
  #check(owner,operation){if(this.#broken||this.#closed)reject('PROFILE_OBJECT_UNAVAILABLE');if((this.#journal.load()?.revision??0)!==this.#state.revision){this.#broken=true;reject('PROFILE_STALE_OBJECT');}if(scopeKey(owner)!==scopeKey(this.owner))reject('PROFILE_OWNER_MISMATCH');if(this.#authorize(freeze({scope:scope(owner),operation,planIdentity:this.#plan.identity,executionApproved:false}))!==true)reject('PROFILE_AUTHORIZATION_REJECTED');if((this.#journal.load()?.revision??0)!==this.#state.revision){this.#broken=true;reject('PROFILE_STALE_OBJECT');}}
  snapshot(owner){this.#check(owner,'status');return structuredClone({...this.#state,executionEnabled:false,turnTransportAccepted:false});}
  async run(owner,{key,...extra}){
    identifier(key);if(Object.keys(extra).length)reject('PROFILE_FIELDS_FORBIDDEN');this.#check(owner,'run');if(this.#busy)reject('PROFILE_BUSY');
    if(this.#state.attempt){if(this.#state.attempt.key!==key)reject('PROFILE_PREVIOUS_ATTEMPT');return structuredClone(this.#state.attempt);}
    this.#busy=true;let fault=null;
    try{
      this.#state.attempt={key,state:'intent',result:null};this.#state.process={state:'starting',pid:null};this.#save();this.#check(owner,'prepare');
      const h=await this.#factory({plan:this.#plan,owner:this.owner,guard:()=>this.#check(owner,'transport'),onSpawn:pid=>{this.#check(owner,'spawn');if(!Number.isSafeInteger(pid)||pid<=0)reject('PROFILE_PID_INVALID');this.#state.process.pid=pid;this.#save();}});
      this.#handle=h;this.#check(owner,'prepared');if(h?.mode!=='real-fixed-profile-canary'||h.protocolVersion!==WORK_PROTOCOL||h.pid!==this.#state.process.pid||h.identity!==this.#plan.identity)reject('PROFILE_TRANSPORT_MODE_REJECTED');
      this.#state.process.state='ready';this.#state.attempt.commandState='intent';this.#save();this.#check(owner,'beforeCommand');
      const result=await h.runFixedCanary();this.#check(owner,'afterCommand');
      if(!result||result.executionEnabled!==false||!['failed_closed','canary_checks_passed_only'].includes(result.status))reject('PROFILE_TRANSPORT_RESULT_REJECTED');
      this.#state.attempt.result=structuredClone(result);this.#state.attempt.state='observed';this.#state.attempt.commandState='observed';this.#save();return structuredClone(this.#state.attempt);
    }catch(e){fault=e;try{this.#check(owner,'unknown');this.#state.attempt.state='unknown';this.#save();}catch{}throw e;}
    finally{try{if(this.#handle){const h=this.#handle;this.#handle=null;await h.close();this.#check(owner,'afterClose');this.#state.process.state='closed';this.#save();}}catch(e){if(!fault)throw e;}finally{this.#busy=false;}}
  }
  async dispose(){this.#closed=true;const h=this.#handle;this.#handle=null;if(h)await h.close();return {localHandleEnded:true,persistedOutcomeUnchanged:true};}
}
