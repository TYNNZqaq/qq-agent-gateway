import path from 'node:path';
import { digest,freeze,identifier,reject,scope,scopeKey } from '../core/contracts.mjs';
import { checkWorkLayout,exact,WORK_CLI_VERSION,WORK_CONFIG,workReference } from './codex-work-policy.mjs';

export const SESSION_PROFILE_ID='qq-owned-project';
export const SESSION_INITIALIZE=freeze({clientInfo:{name:'qq_gateway_owned_session',version:'1.0.0'},capabilities:{experimentalApi:true}});
export const SESSION_TOOLS=Object.freeze(['file-read','file-write','command']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const within=(a,b)=>{const r=path.relative(a,b);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
const sorted=v=>Object.fromEntries(Object.entries(v).sort());

// Trusted local ProjectGrant only. This metadata never authorizes a model turn.
// No canary port, canary paths, executable or user-chosen RPC is part of a grant.
export function sessionPlan(layout,owner,grant){
  if(!exact(layout,['home','cwd','controlRoots']))reject('SESSION_LAYOUT_FIELDS');
  const base=checkWorkLayout(layout),s=scope(owner);
  if(base.controlRoots.some(r=>within(r,base.home)||within(base.home,r))||new Set(base.controlRoots).size!==base.controlRoots.length)reject('SESSION_CONTROL_HOME_OVERLAP');
  if(!exact(grant,['schemaVersion','id','scope','projectPath','tools','network'])||grant.schemaVersion!==1||scopeKey(grant.scope)!==scopeKey(s)||grant.projectPath!==base.cwd||!same(grant.tools,SESSION_TOOLS)||grant.network!==false)reject('SESSION_PROJECT_GRANT_REJECTED');
  identifier(grant.id);
  const systemRoot=Object.entries(process.env).find(([k])=>k.toUpperCase()==='SYSTEMROOT')?.[1];
  if(process.platform!=='win32'||typeof systemRoot!=='string'||!path.isAbsolute(systemRoot))reject('SESSION_SYSTEMROOT_REQUIRED');
  const filesystem={':root':'deny',':minimal':'read',[base.cwd]:'write',...Object.fromEntries([...base.controlRoots,base.home].map(p=>[p,'deny']))};
  const minimalEnvironment={SYSTEMROOT:path.resolve(systemRoot)};
  const config='default_permissions = "'+SESSION_PROFILE_ID+'"\n'+WORK_CONFIG.replace('sandbox_mode = "read-only"\n','')+'\n[windows]\nsandbox = "mxc"\n[shell_environment_policy]\ninherit = "none"\nset = { SYSTEMROOT = '+JSON.stringify(minimalEnvironment.SYSTEMROOT)+' }\n[permissions.'+SESSION_PROFILE_ID+'.filesystem]\n'+Object.entries(filesystem).map(([p,v])=>JSON.stringify(p)+' = '+JSON.stringify(v)).join('\n')+'\n[permissions.'+SESSION_PROFILE_ID+'.network]\nenabled = false\n';
  const g=structuredClone(grant),grantIdentity=digest(JSON.stringify(g));
  const identity=digest(JSON.stringify({scope:scopeKey(s),...base,grantIdentity,minimalEnvironment,config}));
  return freeze({...base,grant:g,grantIdentity,filesystem,minimalEnvironment,config,identity});
}
export const sessionStartParams=plan=>({cwd:plan.cwd,modelProvider:'openai',ephemeral:false,permissions:SESSION_PROFILE_ID,approvalPolicy:'never'});
export function checkSessionRpc(method,params,plan,ownedThreads){
  const fixed={initialize:SESSION_INITIALIZE,'config/read':{includeLayers:false},'mcpServerStatus/list':{cursor:null,limit:1},'permissionProfile/list':{cwd:plan.cwd,cursor:null,limit:100},'thread/start':sessionStartParams(plan)};
  const valid=Object.hasOwn(fixed,method)?same(params,fixed[method]):method==='thread/read'&&exact(params,['threadId','includeTurns'])&&params.includeTurns===false&&ownedThreads?.has(params.threadId);
  if(!valid)reject('SESSION_RPC_FORBIDDEN');
}
export function checkSessionConfig(value,plan){
  const c=value?.config,p=c?.permissions?.[SESSION_PROFILE_ID],fs={...p?.filesystem};
  if(fs.glob_scan_max_depth===null)delete fs.glob_scan_max_depth;
  const onlyNullExtras=(v,required,optional)=>v&&required.every(k=>Object.hasOwn(v,k))&&Object.entries(v).every(([k,x])=>required.includes(k)||optional.includes(k)&&x===null);
  if(c?.forced_login_method!=='chatgpt'||c.cli_auth_credentials_store!=='file'||c.model_provider!=='openai'||c.approval_policy!=='never'||c.default_permissions!==SESSION_PROFILE_ID||c.sandbox_mode!=null||c.windows?.sandbox!=='mxc'||!onlyNullExtras(c.windows,['sandbox'],['allow_mxc'])||c.allow_login_shell!==false||c.web_search!=='disabled'||c.shell_environment_policy?.inherit!=='none'||!same(c.shell_environment_policy?.set,plan.minimalEnvironment)||!onlyNullExtras(c.shell_environment_policy,['inherit','set'],['ignore_default_excludes','exclude','include_only','filters','experimental_use_profile'])||!c.mcp_servers||Object.keys(c.mcp_servers).length||Object.keys(c.permissions??{}).length!==1||!onlyNullExtras(p,['filesystem','network'],['description','extends','workspace_roots'])||!same(sorted(fs),sorted(plan.filesystem))||p.network?.enabled!==false||!onlyNullExtras(p.network,['enabled'],['proxy_url','enable_socks5','socks_url','enable_socks5_udp','allow_upstream_proxy','dangerously_allow_non_loopback_proxy','dangerously_allow_all_unix_sockets','mode','domains','unix_sockets','allow_local_binding','mitm']))reject('SESSION_CONFIG_REJECTED');
  for(const f of ['apps','plugins','hooks','multi_agent','browser_use','computer_use','image_generation','memories','remote_control'])if(c.features?.[f]!==false)reject('SESSION_CONFIG_REJECTED');
}
export function checkSessionThread(result,plan,{id=null,sessionId=null,start=false}={}){
  const t=result?.thread;
  if(!workReference(t?.id)||!workReference(t.sessionId)||(id&&t.id!==id)||(sessionId&&t.sessionId!==sessionId)||t.sessionId!==t.id||t.cliVersion!==WORK_CLI_VERSION||t.cwd!==plan.cwd||t.modelProvider!=='openai'||t.ephemeral!==false||t.preview!==''||!Array.isArray(t.turns)||t.turns.length||!['idle','notLoaded'].includes(t.status?.type)||t.parentThreadId||t.forkedFromId)reject('SESSION_EMPTY_THREAD_REJECTED');
  if(start){
    const a=result.activePermissionProfile,b=result.sandbox,roots=result.runtimeWorkspaceRoots;
    if(!a||!Object.keys(a).every(k=>['id','extends'].includes(k))||a.id!==SESSION_PROFILE_ID||a.extends!=null||result.cwd!==plan.cwd||result.modelProvider!=='openai'||result.approvalPolicy!=='never'||!Array.isArray(result.instructionSources)||result.instructionSources.length||!Array.isArray(roots)||roots.length>1||roots.some(p=>p!==plan.cwd))reject('SESSION_ACTIVE_PROFILE_REJECTED');
    // This legacy projection cannot attest the custom filesystem restrictions.
    if(!b||!['readOnly','workspaceWrite'].includes(b.type)||b.networkAccess!==false||(b.type==='workspaceWrite'&&(!Array.isArray(b.writableRoots)||b.writableRoots.some(p=>p!==plan.cwd))))reject('SESSION_SANDBOX_PROJECTION_REJECTED');
  }
  return {threadId:t.id,sessionId:t.sessionId,empty:true,profileId:SESSION_PROFILE_ID,planIdentity:plan.identity,grantIdentity:plan.grantIdentity};
}
