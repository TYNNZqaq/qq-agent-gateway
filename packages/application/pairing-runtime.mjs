import path from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {serviceLock} from './service.mjs';
import {route} from './router.mjs';
import {deliverOne} from './delivery.mjs';
import {QQTransport,readSecret} from './qq.mjs';
import {atomicJson,freezeQueues} from './boundaries.mjs';
import {readSetupContext} from '../host-control/setup-policy.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function runPairing(config,{operationId,code,transportFactory,expiresMs=600000,expiresAt}={}){
 if(!/^[a-f0-9-]{36}$/i.test(operationId||'')||!/^[a-f0-9]{24}$/.test(code||''))throw Error('PAIRING_INPUT_REQUIRED');
 const deadline=Math.min(expiresAt??Infinity,Date.now()+Math.min(expiresMs,600000));if(!Number.isSafeInteger(deadline)||deadline<=Date.now())throw Error('PAIRING_CODE_EXPIRED');
 const initial=readSetupContext(config.runtimeRoot),scope=JSON.stringify(initial.scope),configHash=hash(readFileSync(config.file)),instance=randomUUID(),file=path.join(config.stateDir,'service.json'),stopFile=path.join(config.stateDir,'stop.request.json'),resultFile=path.join(config.stateDir,'pairing-result.json'),release=serviceLock(config.stateDir),store=new Store(config.stateDir,{numberingConfig:config});
 let transport,timer,expiry,paired=false,stopping=false,ready=false,pending=Promise.resolve(),finish;const ended=new Promise(resolve=>finish=resolve),controller=new AbortController();
 const guard=()=>{const c=readSetupContext(config.runtimeRoot);if(stopping||Date.now()>=deadline||JSON.stringify(c.scope)!==scope||hash(readFileSync(config.file))!==configHash)throw Error('PAIRING_OWNER_CHANGED');};
 const status=state=>atomicJson(file,{schemaVersion:1,instance,pid:process.pid,state,qqConnected:ready&&!stopping,codexVerified:false,executionEnabled:false,updatedAt:Date.now(),pendingApprovals:[],pairing:true});
 const stop=()=>{if(stopping)return;stopping=true;controller.abort();transport?.stop();finish();};
 try{
  const previous=store.get('owner');if(previous){const owner=JSON.parse(previous);if(owner[0]!==config.qq.appId||owner[1]!=='c2c'||!owner[2])throw Error('PAIRING_PRIOR_OWNER_REQUIRES_REVIEW');paired=true;atomicJson(resultFile,{schemaVersion:1,operationId,paired:true,alreadyPaired:true,ownerFingerprint:hash(previous)});return {paired:true,alreadyPaired:true};}
  store.set('pairing',{digest:hash(code),expires:deadline,failures:0});store.set('egressPaused',false);
  transport=transportFactory?await transportFactory(config,store):new QQTransport(config,await readSecret(config),store);transport.bot?.on('ready',()=>{ready=true;status('pairing');});transport.bot?.on('resumed',()=>{ready=true;status('pairing');});
  transport.onMessage(event=>{if(stopping||paired)return;try{guard();const r=route(store,{...config,executor:{...config.executor,enabled:false}},event);transport.recordRoute?.(r);if(!r.paired)return;paired=true;atomicJson(resultFile,{schemaVersion:1,operationId,paired:true,ownerFingerprint:hash(store.get('owner')),confirmationState:'pending'});pending=(async()=>{try{await deliverOne(store,config,transport);const item=store.db.prepare("SELECT status FROM outbox WHERE trigger_event=? ORDER BY id DESC LIMIT 1").get(JSON.stringify([event.appId,event.scope,event.id]));atomicJson(resultFile,{schemaVersion:1,operationId,paired:true,ownerFingerprint:hash(store.get('owner')),confirmationState:item?.status||'unknown'});}finally{stop();}})();}catch{atomicJson(resultFile,{schemaVersion:1,operationId,paired:false,error:'PAIRING_OWNER_OR_SAVE_FAILED'});stop();}});
  timer=setInterval(()=>{if(stopping)return;try{guard();if(existsSync(stopFile)&&JSON.parse(readFileSync(stopFile,'utf8')).instance===instance)stop();else status('pairing');}catch{stop();}},500);expiry=setTimeout(stop,Math.max(1,deadline-Date.now()));process.on('SIGINT',stop);process.on('SIGTERM',stop);status('starting');
  const running=transport.start(controller.signal);await Promise.race([running,ended]);stop();await running;
  if(!paired)atomicJson(resultFile,{schemaVersion:1,operationId,paired:false,state:'ended_without_pairing'});return {paired};
 }finally{stop();clearInterval(timer);clearTimeout(expiry);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await pending;store.set('pairing',null);freezeQueues(store);status('stopped');store.close();release();}
}
