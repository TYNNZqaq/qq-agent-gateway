import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {scope,scopeKey,principalId,conversationId,digest} from '../core/contracts.mjs';
import {bindCodexAccountWork} from './codex-account-work-binding.mjs';
import {readCodexLiveProof} from './codex-live-status.mjs';
import {accountIdentityFingerprint} from './codex-account-policy.mjs';
import {AppServerRPC,taskPermissionConfig,commandRuntimeDirectories} from '../application/app-server-rpc.mjs';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,file)=>{const r=path.relative(root,file);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};

export function createCodexRpcFactory({config,store,authorize,readProof=readCodexLiveProof,bindWork=bindCodexAccountWork,makeRpc=c=>new AppServerRPC(c),readAccount}={}){
  if(!config?.binding||typeof authorize!=='function'||!store||typeof store.get!=='function')throw Error('AUTHENTICATED_RUNTIME_CONTEXT_REQUIRED');
  const runtime=realpathSync(config.runtimeRoot),accountFile=path.join(runtime,'codex-account','control.sqlite');
  const metadata=readAccount||(()=>{const db=new DatabaseSync(accountFile,{readOnly:true});try{return JSON.parse(db.prepare('SELECT snapshot FROM account_control WHERE id=1').get().snapshot);}finally{db.close();}});
  const readiness=()=>{const a=metadata();return readProof({runtimeDirectory:runtime,agentId:config.binding.agentId,connectionId:a.connectionId,model:a.selected?.model,selectionEpoch:a.selected?.accountEpoch,accountActionsFingerprint:hash(JSON.stringify(a.actions.filter(x=>['login','logout'].includes(x.kind)))),binding:config.binding,environment:{...process.env,CODEX_APP_RUNTIME_CLI_PATH:config.executor.binary}});};
  const factory=(_unused,task)=>{
    const project=config.projects[task?.project];
    if(!task||task.owner_key!==store.get('owner')||!project||!path.isAbsolute(project.path))throw Error('RUNTIME_OWNER_OR_PROJECT_CHANGED');
    const directory=realpathSync(project.path),st=lstatSync(directory);
    if(directory!==project.path||st.isSymbolicLink()||!st.isDirectory()||inside(sourceRoot,directory)||inside(directory,sourceRoot)||inside(runtime,directory)||inside(directory,runtime))throw Error('RUNTIME_PROJECT_NOT_ISOLATED');
    const a=metadata(),b=config.binding;
    const owner=scope({hostId:config.hostId||config.instanceId,botId:b.botId,agentId:b.agentId,bindingId:b.bindingId,bindingVersion:b.bindingVersion,principalId:principalId(config.hostId||config.instanceId,b.botId,task.owner_key),conversationId:conversationId(b.botId,(config.kind==='chat'?'qq-chat:':'qq-work:')+task.owner_key),projectId:project.id||'project-'+digest(directory),policyVersion:project.policyVersion||1});
    const grant={schemaVersion:1,id:project.grantId||'grant-'+digest(JSON.stringify([scopeKey(owner),directory,project.mode,project.tools])),scope:owner,projectPath:directory,tools:['file-read',...(project.tools.includes('edit')?['file-write']:[]),...(project.tools.includes('shell')?['command']:[])],network:false};
    const decision={scope:owner,grant,operation:'prepare-codex-work'};
    if(authorize(decision)!==true)throw Error('RUNTIME_PROJECT_AUTHORIZATION_REQUIRED');
    const proof=readProof({runtimeDirectory:runtime,agentId:b.agentId,connectionId:a.connectionId,model:a.selected?.model,selectionEpoch:a.selected?.accountEpoch,accountActionsFingerprint:hash(JSON.stringify(a.actions.filter(x=>['login','logout'].includes(x.kind)))),binding:b,environment:{...process.env,CODEX_APP_RUNTIME_CLI_PATH:config.executor.binary}});
    if(!proof.verified)throw Error(proof.reason||'RUNTIME_REAL_CODEX_PROOF_REQUIRED');
    const processKey='work-'+digest(JSON.stringify([scopeKey(owner),task.id,task.attempt||1]));
    const bound=bindWork({runtimeDirectory:runtime,owner,grant,processKey,authorize:context=>authorize({...context,operation:'codex-work'})===true});
    const profile='qq-project-'+crypto.randomUUID(),policy=taskPermissionConfig(directory,{profile,shell:project.tools.includes('shell'),write:project.mode==='workspace-write',controlRoots:[sourceRoot,runtime,bound.accountHome],runtimeReadRoots:project.tools.includes('shell')?commandRuntimeDirectories(config.executor.binary):[]});
    const rpc=makeRpc({...config,...bound,allowTurns:true,executionCwd:directory,startupPolicy:policy,runtimeGuard:()=>{bound.runtimeGuard();if(store.get('owner')!==task.owner_key||authorize({scope:owner,grant,operation:'codex-work-wire'})!==true)throw Error('RUNTIME_WORK_REVOKED');}});
    Object.defineProperty(rpc,'permissionProfile',{value:profile});
    const start=rpc.start.bind(rpc);rpc.start=async()=>{await start();try{const auth=await rpc.call('account/read',{refreshToken:false});if(auth.account?.type!=='chatgpt')throw Error('RUNTIME_CHATGPT_ACCOUNT_REQUIRED');if(accountIdentityFingerprint(auth.account)!==proof.proof?.nativeAccountFingerprint)throw Error('RUNTIME_ACCOUNT_IDENTITY_CHANGED');return true;}catch(error){await rpc.close();throw error;}};
    return rpc;
  };
  Object.defineProperty(factory,'readiness',{value:readiness});return factory;
}
