import path from 'node:path';
import { reject,digest,scope,scopeKey } from '../core/contracts.mjs';
import { accountEnvironment, accountConfig, ACCOUNT_CLI_VERSION } from './codex-account-policy.mjs';

export const WORK_CLI_VERSION=ACCOUNT_CLI_VERSION;
export const WORK_PROTOCOL='codex-app-server/'+WORK_CLI_VERSION;
export const WORK_INITIALIZE=Object.freeze({clientInfo:{name:'qq_gateway_work_lifecycle',version:'1.0.0'},capabilities:{experimentalApi:false}});
export const WORK_CONFIG=accountConfig;
export const WORK_ARGUMENTS=Object.freeze(['app-server','--listen','stdio://']);
export const workEnvironment=accountEnvironment;
export const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
export const workReference=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function emptyThreadParams(cwd){return {cwd,modelProvider:'openai',ephemeral:false,sandbox:'read-only',approvalPolicy:'never'};}
// Every wire write is checked here; this lifecycle has no turn or executor methods.
export function checkWorkRpc(method,params,{cwd,ownedThreads}={}){
  let valid=false;
  if(method==='initialize')valid=equal(params,WORK_INITIALIZE);
  if(method==='config/read')valid=exact(params,['includeLayers'])&&params.includeLayers===false;
  if(method==='thread/start')valid=equal(params,emptyThreadParams(cwd));
  if(method==='thread/read')valid=exact(params,['threadId','includeTurns'])&&params.includeTurns===false&&ownedThreads?.has(params.threadId);
  if(method==='mcpServerStatus/list')valid=exact(params,['cursor','limit'])&&params.cursor===null&&params.limit===1;
  if(!valid)reject('WORK_METHOD_OR_PARAMS_FORBIDDEN');
}
export function checkWorkConfiguration(value){
  const c=value?.config;
  if(c?.forced_login_method!=='chatgpt'||c.cli_auth_credentials_store!=='file'||c.model_provider!=='openai'||c.sandbox_mode!=='read-only'||c.approval_policy!=='never'||c.allow_login_shell!==false||c.web_search!=='disabled'||Object.keys(c.mcp_servers??{}).length)reject('WORK_CONFIG_REJECTED');
  for(const feature of ['apps','plugins','hooks','multi_agent','browser_use','computer_use','image_generation','memories','remote_control'])if(c.features?.[feature]!==false)reject('WORK_CONFIG_REJECTED');
}
export function checkWorkLayout({home,cwd,controlRoots}){
  if(!path.isAbsolute(home)||!path.isAbsolute(cwd)||!Array.isArray(controlRoots)||!controlRoots.length)reject('WORK_LAYOUT_REQUIRED');
  const normalized=[home,cwd,...controlRoots].map(p=>{if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)===path.parse(p).root)reject('WORK_LAYOUT_REQUIRED');return path.resolve(p);});
  const within=(a,b)=>{const r=path.relative(a,b);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
  const [h,w,...controls]=normalized;
  if(within(w,h)||within(h,w)||controls.some(c=>within(w,c)||within(c,w)))reject('WORK_CONTROL_PROJECT_OVERLAP');
  return {home:h,cwd:w,controlRoots:controls};
}
export function workRuntimeIdentity(layout,owner){const p=checkWorkLayout(layout);return digest(JSON.stringify({home:p.home,cwd:p.cwd,scopeKey:scopeKey(scope(owner))}));}
export function checkEmptyThread(result,cwd,{id=null,start=false}={}){
  const t=result?.thread;
  if(!workReference(t?.id)||(id&&t.id!==id)||t.cliVersion!==WORK_CLI_VERSION||t.cwd!==cwd||t.modelProvider!=='openai'||t.ephemeral!==false||t.preview!==''||!Array.isArray(t.turns)||t.turns.length||!['idle','notLoaded'].includes(t.status?.type)||t.parentThreadId||t.forkedFromId)reject('WORK_EMPTY_THREAD_REJECTED');
  if(start&&(result.cwd!==cwd||result.modelProvider!=='openai'||result.approvalPolicy!=='never'||result.sandbox?.type!=='readOnly'||result.sandbox.networkAccess!==false||result.instructionSources?.length))reject('WORK_EMPTY_THREAD_REJECTED');
  return {threadId:t.id,empty:true};
}
// A returned legacy policy is not an OS isolation attestation. No caller can
// enable generation with a boolean or by passing a synthetic test report.
export const WORK_EXECUTION_GATE=Object.freeze({enabled:false,reason:'ACTUAL_WORK_ISOLATION_AND_TURN_TRANSPORT_NOT_ACCEPTED'});
export function assessIsolationCanary(report){
  const required=['projectRead','projectWrite','controlReadDenied','controlWriteDenied','privateReadDenied','privateWriteDenied','homeReadDenied','networkDenied','baselineNetworkReachable','noInheritedMcp','aclUnchanged'];
  const missing=required.filter(k=>report?.[k]!==true);
  return {status:missing.length?'failed_closed':'canary_checks_passed_only',executionEnabled:false,missing};
}
