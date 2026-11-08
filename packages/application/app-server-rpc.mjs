import {EventEmitter} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {noLinks,inside,sha256} from './boundaries.mjs';
import {resolveCodexExecutable} from './executable.mjs';
import {localCodexProxy} from '../host-control/codex-network-policy.mjs';
import {withApplicationCache,prepareApplicationCache} from '../host-control/application-cache.mjs';
import {parseReviewedCodexVersion} from '../host-control/codex-version-policy.mjs';
import {reviewedCodexRequest} from '../host-control/codex-reviewed-wire.mjs';

export const CLI_VERSION='0.164.0-alpha.11.1';
const disabled=['apps','plugins','hooks','multi_agent','browser_use','computer_use','image_generation','js_repl','memories','remote_control'];
const osKeys=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','SYSTEMDRIVE','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','LANG','TZ']);
const toml=value=>typeof value==='object'&&!Array.isArray(value)?'{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+toml(v)).join(',')+'}':JSON.stringify(value);
export function runtimeEnvironment(home,source=process.env){
  const environment=Object.fromEntries(Object.entries(source).filter(([k])=>osKeys.has(k.toUpperCase())));
  // The desktop prepends its private dependency runtimes to PATH. Keep public
  // machine tools, but never select a shell or library from that private tree.
  for(const key of Object.keys(environment))if(key.toUpperCase()==='PATH')environment[key]=environment[key].split(path.delimiter).filter(entry=>entry&&!/[\\/](?:\.cache[\\/]codex-runtimes|\.codex[\\/]tmp|OpenAI[\\/]Codex[\\/]runtimes)(?:[\\/]|$)/i.test(entry)).join(path.delimiter);
  return withApplicationCache({...environment,...localCodexProxy(source),CODEX_HOME:home},home);
}
export function projectShellEnvironment(project){return {SYSTEMROOT:process.env.SystemRoot||process.env.SYSTEMROOT||'',TEMP:project,TMP:project,TMPDIR:project,PSModuleAnalysisCachePath:path.join(project,'.qq-agent-module-analysis-cache')};}
export function commandRuntimeDirectories(binary){return [...new Set([path.dirname(noLinks(binary)),path.dirname(process.execPath)])];}
export function taskPermissionConfig(project,{shell=false,write=false,profile='qq-project',runtimeReadRoots=[],controlRoots=[]}={}){
  if(!/^qq-project(?:-[a-f0-9-]{36})?$/.test(profile)||!path.isAbsolute(project))throw Error('PROFILE_INVALID');
  if(controlRoots.some(root=>inside(root,project)||inside(project,root)))throw Error('PROJECT_CONTROL_OVERLAP');
  return {approval_policy:'on-request',approvals_reviewer:'user',default_permissions:profile,
    ['permissions.'+profile+'.filesystem']:{':root':'deny',':minimal':'read',...Object.fromEntries(runtimeReadRoots.map(p=>[p,'read'])),[project]:write?'write':'read',...Object.fromEntries(controlRoots.map(p=>[p,'deny']))},
    ['permissions.'+profile+'.network.enabled']:false,
    'features.shell_tool':shell,'allow_login_shell':false,'shell_environment_policy.inherit':'none','shell_environment_policy.set':projectShellEnvironment(project),'web_search':'disabled','project_doc_max_bytes':0,
    ...Object.fromEntries(disabled.map(k=>['features.'+k,false])),...(process.platform==='win32'?{'windows.sandbox':'mxc'}:{})};
}
const permitted=new Set(['initialize','config/read','account/read','model/list','mcpServerStatus/list','permissionProfile/list','thread/start','thread/resume','thread/read','turn/start','turn/steer','turn/interrupt','command/exec']);
export class AppServerRPC extends EventEmitter {
  constructor(config,{spawnImpl=spawn,versionProcess=spawnSync}={}){
    if(typeof config?.runtimeGuard!=='function')throw Error('OWN_RUNTIME_GUARD_REQUIRED');
    super();Object.assign(this,{config,spawn:spawnImpl,versionProcess});this.sequence=0;this.pending=new Map();this.owned=new Set();this.ownedProfiles=new Map();this.closed=false;this.buffer='';this.frames=0;
  }
  guard(){if(this.closed)throw Error('APP_SERVER_CLOSED');if(typeof this.config.runtimeGuard==='function')this.config.runtimeGuard();}
  async start(){
    if(this.child)return;this.guard();
    const home=noLinks(this.config.accountHome);if(!existsSync(path.join(home,'config.toml')))throw Error('OWN_ACCOUNT_CONFIG_REQUIRED');
    const ownRoot=noLinks(path.join(this.config.runtimeRoot,'codex-account'));
    if(!inside(ownRoot,home))throw Error('EXTERNAL_ACCOUNT_HOME_FORBIDDEN');
    const configFile=path.join(home,'config.toml');if(lstatSync(configFile).nlink!==1)throw Error('ACCOUNT_CONFIG_LINK');
    this.homeConfigHash=sha256(readFileSync(configFile));
    prepareApplicationCache(home);
    const binary=resolveCodexExecutable(this.config.executor.binary),env=runtimeEnvironment(home),cwd=this.config.executionCwd||home;
    const version=this.versionProcess(binary,['--version'],{cwd,env,encoding:'utf8',timeout:10000,windowsHide:true,shell:false,maxBuffer:4096});
    this.cliVersion=parseReviewedCodexVersion(version.stdout);
    if(version.status!==0||!this.cliVersion)throw Error('CLI_VERSION_UNVERIFIED');
    const args=['app-server','--listen','stdio://',...['forced_login_method="chatgpt"','cli_auth_credentials_store="file"','model_provider="openai"','mcp_servers={}','analytics.enabled=false','web_search="disabled"','allow_login_shell=false','project_doc_max_bytes=0','shell_environment_policy.inherit="none"',...(process.platform==='win32'?['windows.sandbox="mxc"']:[])].flatMap(v=>['-c',v]),...Object.entries(this.config.startupPolicy||{}).flatMap(([k,v])=>['-c',k+'='+toml(v)]),...disabled.flatMap(f=>['--disable',f])];
    this.child=this.spawn(binary,args,{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    this.processExited=new Promise(resolve=>this.resolveExit=resolve);
    this.child.stdout.setEncoding('utf8');this.child.stderr.on('data',()=>{});
    this.child.stdout.on('data',chunk=>{try{this.read(chunk);}catch{this.close('APP_SERVER_INVALID_FRAME');}});
    this.child.on('error',()=>this.close('APP_SERVER_START_FAILED'));this.child.stdin.on('error',()=>this.close('APP_SERVER_WRITE_UNKNOWN'));
    let exited=false;const onExit=()=>{if(exited)return;exited=true;this.resolveExit();try{this.config.onProcessClosed?.();}finally{this.child.stdout.destroy();this.child.stderr.destroy();this.close('APP_SERVER_CLOSED');}};
    this.child.on('exit',onExit);this.child.on('close',onExit);
    try{this.config.onSpawn?.(this.child.pid);}catch(error){await this.close('WORK_PROCESS_SAVE_FAILED');throw error;}
    const hello=await this.call('initialize',{clientInfo:{name:'qq_agent_business',title:'QQ Agent',version:'1.0.0'},capabilities:{experimentalApi:true}});
    if(!hello?.userAgent?.includes(this.cliVersion))throw Error('CLI_HANDSHAKE_REJECTED');
    this.notify('initialized',{});
    const effective=await this.call('config/read',{includeLayers:false});
    this.config.onConfiguration?.(effective);
    if(effective.config?.forced_login_method!=='chatgpt'||effective.config.cli_auth_credentials_store!=='file'||effective.config.model_provider!=='openai'||Object.keys(effective.config.mcp_servers||{}).length||disabled.some(f=>effective.config.features?.[f]!==false)||effective.config.allow_login_shell!==false)throw Error('CLI_CONFIG_REJECTED');
    const mcp=await this.call('mcpServerStatus/list',{cursor:null,limit:1});if(!Array.isArray(mcp.data)||mcp.data.length||mcp.nextCursor)throw Error('INHERITED_MCP_REJECTED');
    return hello;
  }
  read(chunk){
    this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>2*1024*1024||++this.frames>100000)throw Error('FRAME_LIMIT');
    const lines=this.buffer.split('\n');this.buffer=lines.pop();
    for(const line of lines){
      if(!line.trim())continue;this.guard();
      const frame=JSON.parse(line);if(!frame||Object.getPrototypeOf(frame)!==Object.prototype)throw Error('FRAME_INVALID');
      if(frame.method){
        if(typeof frame.method!=='string')throw Error('FRAME_INVALID');
        if(frame.id!==undefined){if(!['string','number'].includes(typeof frame.id))throw Error('FRAME_INVALID');this.emit('request',frame);}
        else this.emit('notification',frame);continue;
      }
      const pending=this.pending.get(frame.id);if(!pending)continue;clearTimeout(pending.timer);this.pending.delete(frame.id);
      if(frame.error){this.config.onDiagnostic?.({method:pending.method,code:frame.error.code,message:String(frame.error.message||'').slice(0,8192)});pending.reject(Object.assign(Error('APP_SERVER_RPC_REJECTED'),{uncertain:pending.mutation}));continue;}
      if(!Object.hasOwn(frame,'result')){pending.reject(Error('APP_SERVER_FRAME_INVALID'));throw Error('FRAME_INVALID');}
      const result=frame.result;
      if(['thread/start','thread/resume'].includes(pending.method)&&result?.thread?.id){
        if(this.cliVersion==='0.166.0-alpha.6'&&pending.params.permissions&&(result.activePermissionProfile?.id!==pending.params.permissions||result.activePermissionProfile.extends!=null)){
          pending.reject(Object.assign(Error('CLI_PERMISSION_PROFILE_MISMATCH'),{uncertain:pending.mutation}));this.close('CLI_PERMISSION_PROFILE_MISMATCH');continue;
        }
        try{this.config.onSessionOpened?.({threadId:result.thread.id,sessionId:result.thread.sessionId,cwd:result.cwd,profileId:pending.params.permissions});}catch(error){pending.reject(Object.assign(error,{uncertain:pending.mutation}));this.close('SESSION_SAVE_FAILED');continue;}
        this.owned.add(result.thread.id);
        this.ownedProfiles.set(result.thread.id,result.activePermissionProfile?.id);
      }
      pending.resolve(result);
    }
  }
  validate(method,params){
    if(!permitted.has(method)||!params||Object.getPrototypeOf(params)!==Object.prototype||Buffer.byteLength(JSON.stringify(params))>512*1024)throw Error('APP_SERVER_METHOD_FORBIDDEN');
    if(method.startsWith('turn/')&&this.config.allowTurns!==true)throw Error('WORK_GENERATION_NOT_ACCEPTED');
    if(params.threadId&&!this.owned.has(params.threadId)){
      if(method!=='thread/resume'||this.config.ownsThread?.(params.threadId)!==true)throw Error('FOREIGN_THREAD');
    }
    if(['thread/start','thread/resume'].includes(method)){
      if(!Object.values(this.config.projects||{}).some(p=>p.path===params.cwd)&&params.cwd!==this.config.chatWorkspace)throw Error('PROJECT_NOT_GRANTED');
      if(params.sandbox||params.approvalPolicy!=='on-request'||params.approvalsReviewer!=='user')throw Error('THREAD_POLICY_FORBIDDEN');
    }
    if(method==='command/exec'&&this.config.isolationCommand?.(params)!==true)throw Error('COMMAND_NOT_FIXED_CANARY');
    if(method==='turn/steer'&&(!params.expectedTurnId||params.input?.some(x=>x.type!=='text')))throw Error('STEERING_INVALID');
    if(method==='turn/interrupt'&&!params.turnId)throw Error('CANCEL_REFERENCE_REQUIRED');
  }
  call(method,params,{timeoutMs=20000,mutation=false}={}){
    let wireParams;
    try{this.guard();this.validate(method,params);if(!this.child)throw Error('APP_SERVER_NOT_STARTED');
      if(sha256(readFileSync(path.join(this.config.accountHome,'config.toml')))!==this.homeConfigHash)throw Error('ACCOUNT_CONFIG_CHANGED');
      wireParams=reviewedCodexRequest(this.cliVersion,method,params,{defaultProfile:this.config.startupPolicy?.default_permissions,threadProfile:this.ownedProfiles.get(params.threadId)});
    }catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(Error('APP_SERVER_TIMEOUT'),{uncertain:mutation}));this.close('APP_SERVER_TIMEOUT');},timeoutMs);
      this.pending.set(id,{resolve,reject,timer,mutation,method,params});
      this.child.stdin.write(JSON.stringify({id,method,params:wireParams})+'\n',error=>{if(error)this.close('APP_SERVER_WRITE_UNKNOWN');});
    });
  }
  notify(method,params){this.guard();if(method!=='initialized')throw Error('NOTIFICATION_FORBIDDEN');this.child.stdin.write(JSON.stringify({method,params})+'\n');}
  respond(id,result){this.guard();this.child.stdin.write(JSON.stringify({id,result})+'\n');}
  reject(id){if(!this.closed)this.child.stdin.write(JSON.stringify({id,error:{code:-32601,message:'Unsupported request'}})+'\n');}
  close(code='APP_SERVER_STOPPED'){
    if(this.closed)return this.processExited;this.closed=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(Error(code),{uncertain:p.mutation}));}this.pending.clear();
    if(this.child&&this.child.exitCode==null){this.child.stdin.end();const child=this.child,timer=setTimeout(()=>{if(child.exitCode==null)child.kill();},1500);timer.unref();}
    if(!this.child)this.config.onProcessClosed?.();
    this.emit('closed',code);return this.processExited;
  }
}
