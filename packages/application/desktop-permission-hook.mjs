import path from 'node:path';import {fileURLToPath} from 'node:url';import {readFileSync,existsSync,lstatSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {Store} from './store.mjs';import {noLinks,sha256} from './boundaries.mjs';
import {registerNativeApproval,claimNativeDecision,recordNativePostTool,nativeApprovalCurrent} from './desktop-permission-control.mjs';

export function hookContext(settingsFile){
 const file=noLinks(settingsFile),settingsBytes=readFileSync(file),settings=JSON.parse(settingsBytes.toString('utf8').replace(/^\uFEFF/,''));if(settings.schemaVersion!==1||settings.kind!=='qq-native-desktop-permission-hook'||lstatSync(file).nlink!==1)throw Error('NATIVE_HOOK_SETTINGS_INVALID');
 const directory=noLinks(settings.businessDirectory),configFile=noLinks(path.join(directory,'config.local.json')),configBytes=readFileSync(configFile),config=JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/,'')),settingsHash=sha256(settingsBytes),configHash=sha256(configBytes);if(lstatSync(configFile).nlink!==1)throw Error('NATIVE_HOOK_CONFIG_LINK');
 if(!existsSync(path.join(directory,'state.sqlite'))||config.instanceId!==settings.instanceId||JSON.stringify(config.binding)!==JSON.stringify(settings.binding)||config.qq.appId!==settings.appId||config.nativeDesktopApprovals?.enabled!==true||noLinks(config.nativeDesktopApprovals.home)!==noLinks(settings.desktopHome)||config.nativeDesktopApprovals.settingsFile!==file)throw Error('NATIVE_HOOK_BINDING_INVALID');
 config.stateDir=directory;const serviceFile=path.join(directory,'service.json'),service=JSON.parse(readFileSync(serviceFile,'utf8')),store=new Store(directory,{numberingConfig:config}),owner=store.get('owner');
 let management;try{management=new DatabaseSync(path.join(config.runtimeRoot,'management.sqlite'),{readOnly:true});}catch(error){store.close();throw error;}
 const guard=()=>{const live=JSON.parse(readFileSync(serviceFile,'utf8')),binding=management.prepare('SELECT * FROM ui_bindings WHERE id=? AND active=1').get(config.binding.bindingId);if(sha256(readFileSync(file))!==settingsHash||sha256(readFileSync(configFile))!==configHash||store.get('owner')!==owner||sha256(owner)!==settings.ownerHash||live.instance!==service.instance||live.botId!==config.binding.botId||live.agentId!==config.binding.agentId||live.state!=='running'||!live.qqConnected||Date.now()-live.updatedAt>15000||!binding||binding.bot_id!==config.binding.botId||binding.agent_id!==config.binding.agentId||binding.version!==config.binding.bindingVersion)throw Error('NATIVE_HOOK_CONTEXT_CHANGED');};
 config.runtimeGuard=guard;config.nativePermissionServiceInstance=service.instance;config.nativePermissionReviewedRuntime=service.codexVerified===true&&service.executionEnabled===true;try{guard();}catch(error){management.close();store.close();throw error;}
 return {config,store,guard,serviceInstance:service.instance,close(){management.close();store.close();}};
}
export async function runNativeHook(settingsFile,payload,{openContext=hookContext,writeOutput=value=>new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve())),pollMs=200}={}){
 let context,row,outputAttempted=false,lastError=null;
 const respond=async value=>{outputAttempted=true;await writeOutput(value);};
 try{
  context=openContext(settingsFile);const {store,config,guard}=context;
  if(payload.hook_event_name==='PostToolUse'){guard();recordNativePostTool(store,config,payload);await respond({});return;}
  if(payload.hook_event_name==='Interrupt'){guard();store.db.prepare("UPDATE desktop_approvals SET status='expired',error='NATIVE_TURN_INTERRUPTED' WHERE method='PermissionRequest' AND thread_id=? AND turn_id=? AND status IN('pending','queued')").run(payload.session_id,payload.turn_id);await respond({});return;}
  row=registerNativeApproval(store,config,payload,{serviceInstance:context.serviceInstance});
  while(Date.now()<row.expires_at){
   guard();const current=store.db.prepare('SELECT * FROM desktop_approvals WHERE id=?').get(row.id);if(!current||['expired','unknown','resolved','submitted'].includes(current.status))break;
   store.db.prepare("UPDATE desktop_approvals SET last_seen=? WHERE id=? AND status IN('pending','queued','revoked')").run(Date.now(),row.id);
   if(current.status!=='revoked'&&!nativeApprovalCurrent(store,config,store.db.prepare('SELECT * FROM desktop_approvals WHERE id=?').get(row.id)))break;
   const decision=claimNativeDecision(store,config,row.id);
   if(decision){guard();await respond({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:decision.behavior,...(decision.behavior==='deny'?{message:'The paired owner declined this request in the original QQ bot.'}:{})}}});
    store.db.prepare("UPDATE desktop_approvals SET status='submitted',last_seen=? WHERE id=? AND status IN('sending','revoked')").run(Date.now(),row.id);return;}
   await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  store.db.prepare("UPDATE desktop_approvals SET status='expired',error='REMOTE_DECISION_EXPIRED_OR_NATIVE_REQUEST_ENDED' WHERE id=? AND status IN('pending','queued')").run(row.id);
 }catch(error){lastError=/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_HOOK_FAILED';if(context){context.store.set('nativePermissionLastError',{code:lastError,at:Date.now()});if(row)context.store.db.prepare("UPDATE desktop_approvals SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'expired' END,error=? WHERE id=? AND status IN('pending','queued','sending')").run(lastError,row.id);}}
 finally{context?.close();}
 if(!outputAttempted)try{await respond(lastError?{systemMessage:'QQ 原生审批桥未处理本次请求（'+lastError+'）；将继续本机审批。'}:{});}catch{} // Preserve native approval without retrying an uncertain write.
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let raw='',payload;try{for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw Error('NATIVE_HOOK_INPUT_TOO_LARGE');}payload=JSON.parse(raw);}catch{process.stdout.write('{}\n');}
 if(payload)await runNativeHook(process.argv[2],payload).catch(()=>{});
}
