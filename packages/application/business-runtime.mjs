import path from 'node:path';
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from './store.mjs';
import {Service,serviceLock} from './service.mjs';
import {AppServerWorkRunner} from './app-server-work.mjs';
import {CodexRunner} from './runner.mjs';
import {ChatRunner} from './chat-runner.mjs';
import {createChatExecution} from './chat-execution.mjs';
import {QQTransport,readSecret} from './qq.mjs';
import {FileReceiver} from './file-receive.mjs';
import {FileObserver} from './files.mjs';
import {TaskGuidanceWorker} from './project-tasks.mjs';
import {freezeQueues,atomicJson,noLinks} from './boundaries.mjs';
import {queueSummary,resumeQueues} from './queue-control.mjs';
import {createCodexRpcFactory} from '../host-control/codex-authenticated-runtime.mjs';
import {readSetupContext,desktopFeatureConsentValid} from '../host-control/setup-policy.mjs';
import {DesktopNotifications} from './desktop-notifications.mjs';
import {DesktopQuestions} from './desktop-questions.mjs';
// Included in the clean program closure for the independently invoked notifier.
import './desktop-notify.mjs';
import {enqueueApprovalCheck} from './approval-control.mjs';
import './desktop-permission-hook.mjs';
import {nativeApprovalSnapshot} from './desktop-permission-control.mjs';
import {NativeOwnerBridge} from './native-owner-bridge.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const programRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Persist code locations rather than raw exceptions, which can contain messages,
// credentials, target identities, commands or file contents.
export function businessFailure(error,stage){
  const frames=String(error?.stack||'').split('\n').slice(1,12).flatMap(line=>{
    const match=line.match(/(?:file:\/\/\/)?([A-Za-z]:[\\/][^\r\n]*?\.mjs):(\d+):(\d+)/);if(!match)return [];
    let file;try{file=decodeURIComponent(match[1]);}catch{return [];}
    const relative=path.relative(programRoot,file).replaceAll('\\','/');
    return /^(?:packages|scripts)\/[A-Za-z0-9_./-]+\.mjs$/.test(relative)&&!relative.split('/').includes('..')?[{file:relative,line:Number(match[2]),column:Number(match[3])}]:[];
  });
  return {stage:/^[a-z_-]{1,40}$/.test(stage)?stage:'unknown',name:/^[A-Za-z_]{1,80}$/.test(error?.name||'')?error.name:null,
    code:/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||'')?error.code:null,errno:Number.isInteger(error?.errno)?error.errno:null,
    errcode:Number.isInteger(error?.errcode)?error.errcode:null,knownMessage:/^[A-Z_]{1,100}$/.test(error?.message||'')?error.message:null,messageHash:hash(String(error?.message||'')),frames};
}
export function createBusinessStatusPublisher(file,{write=atomicJson,now=()=>Date.now(),onTransient=()=>{},maxFailures=5,maxStaleMs=10000}={}){
  let failures=0,totalFailures=0,lastSuccessAt=now();
  const publish=value=>{
    try{write(file,value);failures=0;lastSuccessAt=now();return true;}
    catch(error){
      const statusRename=['EPERM','EACCES','EBUSY'].includes(error.code)&&error.syscall==='rename'&&typeof error.dest==='string'&&path.resolve(error.dest)===path.resolve(file);
      if(!statusRename)throw error;
      failures++;totalFailures++;try{onTransient(error,{failures,totalFailures,lastSuccessAt});}catch{}
      if(failures>=maxFailures||now()-lastSuccessAt>=maxStaleMs||now()<lastSuccessAt)throw Error('BUSINESS_STATUS_UNAVAILABLE',{cause:error});
      return false;
    }
  };
  publish.snapshot=()=>({consecutiveFailures:failures,totalFailures,lastSuccessAt});return publish;
}
export async function runBusiness(config,{transportFactory,workFactory=createCodexRpcFactory,now=()=>Date.now()}={}){
  const nativeOnly=config.serviceMode==='native-only'&&config.executor.enabled===false&&config.automaticSetup?.schemaVersion===1;
  if(nativeOnly&&!desktopFeatureConsentValid(config.externalUseConsent))throw Error('SETUP_DESKTOP_CONSENT_REQUIRED');
  if(config.externalUseConsent?.confirmed!==true||config.executor.enabled!==true&&!nativeOnly)throw Error('BUSINESS_EXECUTION_NOT_ENABLED');
  const token=randomUUID(),statusFile=path.join(config.stateDir,'service.json'),stopFile=path.join(config.stateDir,'stop.request.json'),actionFile=path.join(config.stateDir,'action.request.json');
  config.nativePermissionServiceInstance=token;
  const fingerprint=hash(readFileSync(config.file));
  let consentHash=null;
  if(config.externalUseConsent?.policyHash){const context=readSetupContext(config.runtimeRoot);if(context.consent.id!==config.externalUseConsent.id)throw Error('BUSINESS_CONSENT_CHANGED');const raw=readFileSync(path.join(config.runtimeRoot,'consent.json'));if(JSON.stringify(JSON.parse(raw))!==JSON.stringify(context.consent))throw Error('BUSINESS_CONSENT_CHANGED');consentHash=hash(raw);}
  const management=new DatabaseSync(path.join(config.runtimeRoot,'management.sqlite'),{readOnly:true}),account=new DatabaseSync(path.join(config.runtimeRoot,'codex-account','control.sqlite'),{readOnly:true});
  const accountIdentity=()=>{const a=JSON.parse(account.prepare('SELECT snapshot FROM account_control WHERE id=1').get().snapshot);return hash(JSON.stringify([a.agentId,a.connectionId,a.selected,(a.actions||[]).filter(x=>['login','logout'].includes(x.kind))]));};
  const initialAccount=accountIdentity();
  let store,release,transport,runner,service,receiver,files,guidance,notifications,questions,nativeOwner,stopping=false,phase='starting',lastError=null,platformReady=false;
  let executionReady=!nativeOnly,executionBlockedReason=nativeOnly?'CODEX_WORK_NOT_VERIFIED':null;
  const timers=[],pending=new Set(),shutdown=new AbortController();
  const guard=()=>{
    if(stopping)throw Error('BUSINESS_STOPPING');
    if(hash(readFileSync(config.file))!==fingerprint||accountIdentity()!==initialAccount)throw Error('BUSINESS_CONFIGURATION_CHANGED');
    if(config.dataIdentityHash&&hash(readFileSync(path.join(config.runtimeRoot,'instance.json')))!==config.dataIdentityHash)throw Error('BUSINESS_INSTANCE_CHANGED');
    if(consentHash&&hash(readFileSync(path.join(config.runtimeRoot,'consent.json')))!==consentHash)throw Error('BUSINESS_CONSENT_CHANGED');
    const b=management.prepare('SELECT * FROM ui_bindings WHERE id=? AND active=1').get(config.binding.bindingId),bot=management.prepare('SELECT * FROM ui_bots WHERE id=?').get(config.binding.botId),agent=management.prepare('SELECT * FROM ui_agents WHERE id=?').get(config.binding.agentId);
    if(!b||b.bot_id!==config.binding.botId||b.agent_id!==config.binding.agentId||b.version!==config.binding.bindingVersion||bot?.status!=='registered'||bot.archived||bot.app_id!==config.qq.appId||agent?.status!=='registered'||agent.archived||agent.tool_id!=='codex')throw Error('BUSINESS_BINDING_REVOKED');
    noLinks(config.stateDir);noLinks(config.accountHome);
  };
  const status=()=>{
    if(!store)return;
    publishStatus({schemaVersion:1,instance:token,pid:process.pid,state:phase,qqConnected:platformReady&&!stopping,codexVerified:executionReady,observationOnly:!executionReady,executionBlockedReason,botId:config.binding.botId,agentId:config.binding.agentId,startedAt:began,updatedAt:now(),error:lastError,queues:queueSummary(store),pendingApprovals:runner?.pending?.()||[],remoteApprovals:runner?.approvalState?.()||{enabled:false},nativeDesktopApprovals:nativeApprovalSnapshot(store,config),desktopNotifications:notifications?.snapshot()||{enabled:false},nativeDesktopQuestions:questions?.snapshot()||{enabled:false},nativeDesktopControl:nativeOwner?.snapshot()||{enabled:false},executionEnabled:executionReady&&!stopping&&phase==='running',statusPublication:publishStatus.snapshot()});
  };
  const stop=()=>{if(stopping)return;stopping=true;phase='stopping';config.runtimeStopping=true;service&&(service.stopped=true);service?.active?.controller.abort();service?.chatActive?.controller.abort();runner?.stop();guidance?.stop();nativeOwner?.stop();receiver?.stop();files?.stop();shutdown.abort();transport?.stop();};
  const began=now();
  const publishStatus=createBusinessStatusPublisher(statusFile,{now,onTransient:(error,state)=>atomicJson(path.join(config.stateDir,'business-status-publication-error.json'),{schemaVersion:1,at:now(),instance:token,...businessFailure(error,'status-publication'),...state})});
  const failure=(error,stage)=>{lastError=/^[A-Z_]+$/.test(error.message)?error.message:'BUSINESS_OPERATION_FAILED';try{atomicJson(path.join(config.stateDir,'business-failure.json'),{schemaVersion:1,at:now(),instance:token,...businessFailure(error,stage)});}catch{}stop();};
  const tick=(stage,fn,ms)=>timers.push(setInterval(()=>{if(stopping)return;const p=Promise.resolve().then(()=>{guard();return fn();}).catch(error=>failure(error,stage)).finally(()=>pending.delete(p));pending.add(p);},ms));
  try{
    guard();release=serviceLock(config.stateDir);store=new Store(config.stateDir,{numberingConfig:config});
    const owner=store.get('owner');let parsed;try{parsed=JSON.parse(owner);}catch{}
    if(!Array.isArray(parsed)||parsed[0]!==config.qq.appId||parsed[1]!=='c2c'||!parsed[2])throw Error('ORIGINAL_PAIRED_OWNER_REQUIRED');
    store.recover();store.set('egressPaused',false);store.set('paused',false);
    config.runtimeGuard=guard;
    nativeOwner=new NativeOwnerBridge(store,config,{now});
    notifications=new DesktopNotifications(store,config);
    questions=new DesktopQuestions(store,config);
    const authorize=()=>{guard();return store.get('owner')===owner;};
    const disabledFactory=Object.assign(()=>{throw Error('CODEX_WORK_NOT_VERIFIED');},{readiness:()=>({verified:false,reason:'CODEX_WORK_NOT_VERIFIED'})});
    const rpcFactory=nativeOnly?disabledFactory:workFactory({config,store,authorize});
    const readiness=rpcFactory.readiness?.();
    if(!nativeOnly&&readiness&&readiness.verified!==true){
      const reason=readiness.reason||'CODEX_WORK_NOT_VERIFIED';
      if(config.desktopNotifications?.enabled!==true||config.desktopNotifications.scope!=='all-local'||config.desktopNotifications.observationOnlyFallback!==true||!/^CODEX_(?:PROOF_[A-Z_]+|WORK_NOT_VERIFIED)$/.test(reason))throw Error(reason);
      executionReady=false;executionBlockedReason=reason;config.executor={...config.executor,enabled:false};config.executionBlockedReason=reason;
    }
    config.nativePermissionReviewedRuntime=executionReady;
    runner=new AppServerWorkRunner(config,store,new CodexRunner(config),{rpcFactory});
    const chatConfig={...config,kind:'chat',projects:{__chat__:{id:config.chatProjectId,grantId:config.chatGrantId,path:config.chatWorkspace,mode:'read-only',tools:['read'],policyVersion:1}}};
    const chatFactory=nativeOnly?disabledFactory:workFactory({config:chatConfig,store,authorize});
    config.chatExecute=createChatExecution(config,store,{rpcFactory:(_c,turn)=>chatFactory(chatConfig,{id:'chat-'+turn.id+'-'+(turn.recompute_count||0),owner_key:turn.owner_key,project:'__chat__',attempt:1})});
    if(executionReady&&!config.modelCatalog?.length){
      const project=Object.keys(config.projects)[0],client=rpcFactory(config,{id:'catalog-'+randomUUID(),owner_key:owner,project});
      try{await client.start();let cursor=null;const catalog=[];for(let page=0;page<4;page++){
        const result=await client.call('model/list',{includeHidden:false,limit:100,cursor});guard();if(!Array.isArray(result.data))throw Error('BUSINESS_MODEL_CATALOG_INVALID');
        for(const m of result.data)if(!m.hidden)catalog.push({id:m.model||m.id,name:m.displayName||m.model||m.id,efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort).filter(e=>['low','medium','high','xhigh','max'].includes(e)),defaultEffort:m.defaultReasoningEffort||'medium'});
        if(!result.nextCursor){config.modelCatalog=catalog;break;}if(result.nextCursor===cursor||page===3)throw Error('BUSINESS_MODEL_CATALOG_INCOMPLETE');cursor=result.nextCursor;
      }}finally{await client.close();}
    }
    if(executionReady&&!config.modelCatalog.some(m=>m.id===config.chat.model&&m.efforts.includes(config.chat.reasoning)))throw Error('PRESERVED_CHAT_MODEL_UNAVAILABLE');
    transport=transportFactory?await transportFactory(config,store):new QQTransport(config,await readSecret(config),store,()=>{});
    const send=transport.send.bind(transport);transport.send=async message=>{guard();return send(message);};
    if(transport.uploadFile){const upload=transport.uploadFile.bind(transport);transport.uploadFile=async(...args)=>{guard();return upload(...args);};}
    transport.bot?.on('ready',()=>{if(stopping)return;platformReady=true;phase='running';status();});transport.bot?.on('resumed',()=>{if(stopping)return;platformReady=true;phase='running';status();});transport.bot?.on('disconnected',()=>{if(stopping)return;platformReady=false;status();});
    service=new Service(store,config,runner,transport,new ChatRunner(config));receiver=new FileReceiver(store,config);files=new FileObserver(store,config);guidance=new TaskGuidanceWorker(store,config,runner);
    transport.onMessage(event=>{if(stopping)return;try{guard();const routed=service.receive(event);transport.recordRoute?.(routed);status();}catch(error){failure(error,'ingress');lastError='BUSINESS_INGRESS_SAVE_FAILED';}});
    tick('work',()=>executionReady?service.runOnce():false,500);tick('chat',()=>executionReady?service.runChatOnce():false,250);tick('send',()=>service.sendOnce(),250);tick('file-receive',()=>receiver.runOnce(),500);tick('guidance',()=>executionReady?guidance.runOnce():false,500);tick('file-observe',()=>files.refresh(),1000);
    tick('native-owner',()=>nativeOwner.runOnce(),1000);
    tick('status',()=>{
      if(existsSync(stopFile)){const r=JSON.parse(readFileSync(stopFile,'utf8'));if(r.instance===token)stop();}
      if(existsSync(actionFile)){const action=JSON.parse(readFileSync(actionFile,'utf8'));if(action.instance===token&&!store.get('localAction:'+action.operationId)){
        let result;try{if(action.kind==='approve')result=runner.answerLocal(action.id,action.fingerprint,action.accept===true);else if(action.kind==='resume-held')result=resumeQueues(store);else if(action.kind==='approval-check')result=enqueueApprovalCheck(store,config,action.projectKey);else throw Error('LOCAL_ACTION_UNSUPPORTED');}catch(error){result={error:/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_ACTION_FAILED'};}
        store.set('localAction:'+action.operationId,result);
      }}notifications.refresh();questions.refresh();status();
    },1000);
    process.on('SIGINT',stop);process.on('SIGTERM',stop);status();await transport.start(shutdown.signal);
  }catch(error){lastError=/^[A-Z_]+$/.test(error.message)?error.message:'BUSINESS_CONNECTION_FAILED';throw error;}finally{
    stop();for(const timer of timers)clearInterval(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    await Promise.allSettled([...pending]);
    while(service?.working||service?.chatWorking||service?.sending||receiver?.working||guidance?.working||nativeOwner?.working||files?.working)await new Promise(resolve=>setTimeout(resolve,50));
    try{if(store){try{freezeQueues(store);phase='stopped';platformReady=false;try{status();}catch(error){lastError||='BUSINESS_STATUS_UNAVAILABLE';}}finally{store.close();}}}
    finally{release?.();management.close();account.close();}
  }
}
