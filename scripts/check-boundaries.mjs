import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// These two reviewed files contain protocol data and synthetic transport logic.
// This is not a directory wildcard or permission to load a process/network SDK.
export const OFFLINE_PROTOCOL_FILES=Object.freeze(['packages/adapters/codex/protocol.mjs','packages/adapters/codex/offline-adapter.mjs']);
export const ACCOUNT_PROCESS_FILE='packages/host-control/codex-account-process.mjs';
export const WORK_PROCESS_FILE='packages/host-control/codex-work-process.mjs';
export const WORK_LIFECYCLE_FILE='packages/adapters/codex/work-lifecycle.mjs';
export const WORK_PROFILE_FILE='packages/host-control/codex-work-profile.mjs';
export const OWNED_SESSION_FILE='packages/host-control/codex-owned-session.mjs';
export const SESSION_POLICY_FILE='packages/host-control/codex-session-policy.mjs';
export const WORK_ONLY_FILES=Object.freeze([WORK_PROCESS_FILE,WORK_LIFECYCLE_FILE,WORK_PROFILE_FILE,OWNED_SESSION_FILE,SESSION_POLICY_FILE,'packages/host-control/codex-work-policy.mjs']);
export const QQ_CREDENTIAL_PROCESS_FILE='packages/host-control/qq-credential-process.mjs';
export const OS_PATH_PROCESS_FILE='packages/host-control/windows-known-folders.mjs';
export const LOCAL_HISTORY_PROCESS_FILE='packages/host-control/native-archive-slice.mjs';
export const QQ_CONTROL_FILES=Object.freeze(['packages/host-control/qq-credential-process.mjs','packages/host-control/qq-platform-client.mjs','packages/host-control/qq-connection-controller.mjs','packages/storage/qq-control-store.mjs']);
export const BUSINESS_PROCESS_FILES=Object.freeze(['packages/application/app-server-rpc.mjs','packages/application/qq.mjs','packages/host-control/business-controller.mjs','packages/application/desktop-notify.mjs']);
export const BUSINESS_TURN_FILES=Object.freeze(['packages/application/app-server-rpc.mjs','packages/application/app-server-work.mjs','packages/application/chat-execution.mjs','packages/application/self-test.mjs','packages/host-control/codex-reviewed-wire.mjs']);
const managementRoots=['packages/host-control/cli.mjs','packages/host-control/local-server.mjs','packages/host-control/tool-catalog.mjs','packages/core/management.mjs','packages/storage/management-store.mjs','packages/management-ui/app.js'];
// Read import syntax, skipping comments and string contents used as test data.
// This bounded source check is not a JavaScript sandbox or OS isolation proof.
export function importsOf(text){
  const tokens=[];let i=0,expression=true;
  while(i<text.length){
    const c=text[i];if(/\s/.test(c)){i++;continue;}
    if(c==='/'&&text[i+1]==='/'){i=text.indexOf('\n',i+2);if(i<0)break;continue;}
    if(c==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);i=end<0?text.length:end+2;continue;}
    if(c==='"'||c==="'"||c==='`'){
      const quote=c,start=++i;let escaped=false;
      while(i<text.length&&text[i]!==quote){if(text[i]==='\\'){escaped=true;i+=2;}else i++;}
      tokens.push({kind:quote==='`'?'template':'string',value:text.slice(start,i),escaped});i++;expression=false;continue;
    }
    if(c==='/'&&expression){
      i++;let bracket=false;
      while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i]==='[')bracket=true;if(text[i]===']')bracket=false;if(text[i++]==='/'&&!bracket)break;}
      while(/[a-z]/i.test(text[i]??'')&&i<text.length)i++;expression=false;continue;
    }
    if(/[A-Za-z_$]/.test(c)){
      const start=i++;while(i<text.length&&/[A-Za-z0-9_$]/.test(text[i]))i++;
      const value=text.slice(start,i);tokens.push({kind:'word',value});expression=['return','throw','case','delete','void','typeof','yield','await','new'].includes(value);continue;
    }
    tokens.push({kind:'punct',value:c});i++;expression='({[,;:=!?&|+-*%~^'.includes(c);
  }
  const imports=[];let opaque=false,escaped=false;
  for(let at=0;at<tokens.length;at++){
    const token=tokens[at],next=tokens[at+1];
    if(token.kind==='template'&&/\b(?:import|require|eval)\s*\(/.test(token.value))opaque=true;
    if(token.kind!=='word')continue;
    if(['require','eval','Function'].includes(token.value)&&next?.value==='(')opaque=true;
    let spec;
    if(token.value==='from'&&next?.kind==='string')spec=next;
    if(token.value==='import'){
      if(next?.kind==='string')spec=next;
      else if(next?.value==='('){if(tokens[at+2]?.kind==='string')spec=tokens[at+2];else opaque=true;}
    }
    if(spec){imports.push(spec.value);if(spec.escaped)escaped=true;}
  }
  return {imports,opaque,escaped};
}
export function checkSources(sources){
  const errors=[],graph=new Map();
  for(const [file,text] of sources){
    if(!/\.(?:mjs|js)$/.test(file))continue;
    const {imports,opaque,escaped}=importsOf(text);
    const edges=[];graph.set(file,edges);
    if(escaped)errors.push(file+': escaped import specifier');
    if(file.startsWith('packages/')&&(opaque||/node:module/.test(text)))errors.push(file+': opaque execution/import');
    for(const spec of imports){
      if(!spec.startsWith('.')){
        if(/^packages\/(?:core|gateway-qq)\//.test(file)&&spec!=='node:crypto')errors.push(file+': forbidden core/gateway dependency');
        if(file.startsWith('packages/adapters/'))errors.push(file+': forbidden offline adapter dependency');
        continue;
      }
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));edges.push(target);
      if(target.startsWith('../')||!sources.has(target))errors.push(file+': invalid import');
      if(file.startsWith('packages/core/')&&!target.startsWith('packages/core/'))errors.push(file+': core direction');
      if(file.startsWith('packages/storage/')&&!target.startsWith('packages/storage/')&&!target.startsWith('packages/core/'))errors.push(file+': storage direction');
      if(file.startsWith('packages/gateway-qq/')&&!target.startsWith('packages/gateway-qq/')&&!target.startsWith('packages/core/'))errors.push(file+': gateway direction');
      if(file.startsWith('packages/adapters/')&&!target.startsWith('packages/core/')&&!OFFLINE_PROTOCOL_FILES.includes(target))errors.push(file+': offline adapter direction');
      if(file.startsWith('packages/')&&target==='scripts/probe-runtimes.mjs')errors.push(file+': runtime probe imported');
    }
    if(file.startsWith('packages/')){
      if((/node:child_process/.test(text)&&![ACCOUNT_PROCESS_FILE,QQ_CREDENTIAL_PROCESS_FILE,OS_PATH_PROCESS_FILE,LOCAL_HISTORY_PROCESS_FILE,WORK_PROCESS_FILE,WORK_PROFILE_FILE,OWNED_SESSION_FILE,...BUSINESS_PROCESS_FILES].includes(file))||/session\/prompt|ctx\.agents/.test(text))errors.push(file+': forbidden model execution');
      if(file===LOCAL_HISTORY_PROCESS_FILE&&/\bfetch\s*\(|node:(?:https?|net|tls)|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|app-server|turn\/start|command\/exec|\beval\s*\(|\bFunction\s*\(/.test(text))errors.push(file+': history helper must remain local decompression only');
      if(file===OS_PATH_PROCESS_FILE&&/\bfetch\s*\(|node:https|node:http|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|process\s*\.\s*getBuiltinModule/.test(text))errors.push(file+': known folders helper must remain local-only');
      if([WORK_PROCESS_FILE,WORK_PROFILE_FILE,OWNED_SESSION_FILE].includes(file)&&/\bfetch\s*\(|node:https|node:http|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|process\s*\.\s*getBuiltinModule/.test(text))errors.push(file+': work process permits only reviewed stdio transport');
      if(/^packages\/(?:host-control|storage)\/qq-/.test(file)&&!QQ_CONTROL_FILES.includes(file))errors.push(file+': unreviewed QQ control module');
      if(file===QQ_CREDENTIAL_PROCESS_FILE&&/\bfetch\s*\(|node:https|node:http|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|process\s*\.\s*getBuiltinModule/.test(text))errors.push(file+': credential helper must remain local-only');
      if(file===ACCOUNT_PROCESS_FILE&&/\bfetch\s*\(|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|process\s*\.\s*getBuiltinModule/.test(text))errors.push(file+': account process permits only reviewed stdio transport');
      if(/turn\/start/.test(text)&&file!=='packages/adapters/codex/protocol.mjs'&&!BUSINESS_TURN_FILES.includes(file))errors.push(file+': protocol constant outside exact allowlist');
      if(file.startsWith('packages/adapters/')&&!OFFLINE_PROTOCOL_FILES.includes(file)&&file!==WORK_LIFECYCLE_FILE)errors.push(file+': unreviewed adapter module');
      if(file.startsWith('packages/adapters/')&&/\bfetch\s*\(|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|process\s*\.\s*getBuiltinModule/.test(text))errors.push(file+': real transport in offline adapter');
    }
    if(/(?<![A-Za-z])[A-Za-z]:[\\/]/.test(text))errors.push(file+': fixed absolute path');
  }
  const visited=new Set(),pending=managementRoots.filter(x=>sources.has(x));
  while(pending.length){const file=pending.pop();if(visited.has(file))continue;visited.add(file);
    if(file.startsWith('packages/application/'))errors.push(file+': business execution reachable from management service');
    if(WORK_ONLY_FILES.includes(file))errors.push(file+': work lifecycle reachable from management service');
    if(['packages/host-control/offline-dispatch-host.mjs','packages/host-control/offline-event-receiver.mjs','packages/host-control/offline-cancellation.mjs','packages/host-control/offline-ingress-retention.mjs','packages/host-control/input-coordinator.mjs','packages/storage/work-store.mjs','packages/storage/sqlite-journal.mjs'].includes(file))errors.push(file+': offline business composition reachable from management service');
    if(file.startsWith('packages/adapters/'))errors.push(file+': adapter reachable from management service');
    if(file==='scripts/probe-runtimes.mjs')errors.push(file+': probe reachable from management service');
    pending.push(...(graph.get(file)??[]));
  }
  return {passed:!errors.length,sourceFiles:sources.size,errors,privateTreeTraversed:false,managementClosureFiles:visited.size,managementAdapterImports:[...visited].filter(f=>f.startsWith('packages/adapters/')).length};
}
export function checkWorkspace(){
  // Closed roots only; never enumerate runtime, hidden folders or legacy trees.
  const sources=new Map();
  function walk(relative){for(const item of readdirSync(path.join(root,relative),{withFileTypes:true})){const rel=path.posix.join(relative,item.name);if(lstatSync(path.join(root,rel)).isSymbolicLink())throw Error('SOURCE_LINK_FORBIDDEN');if(item.isDirectory())walk(rel);else sources.set(rel,/\.(?:mjs|js)$/.test(rel)?readFileSync(path.join(root,rel),'utf8'):'');}}
  for(const dir of ['packages','scripts','tests','docs/g1'])walk(dir);
  return checkSources(sources);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=checkWorkspace();console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;}
