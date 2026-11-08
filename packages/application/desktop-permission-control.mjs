import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {sha256,secretText} from './boundaries.mjs';
import {completionText} from './completion.mjs';
import {approvalReplyIsFresh} from './approval-clock.mjs';
import {nativePermissionSource} from '../host-control/native-permission-source.mjs';
const stateKey=key=>'nativePermission:'+key;
export const nativeApprovalData=(store,row)=>row&&store.get(stateKey(row.request_key));
const bindingScope=(config,owner)=>({instanceId:config.instanceId,hostId:config.hostId,runtimeRoot:config.runtimeRoot,appId:config.qq.appId,binding:config.binding,owner,home:config.nativeDesktopApprovals?.home});
export function nativeApprovalCurrent(store,config,row,{source=nativePermissionSource,now=Date.now()}={}){
 try{
  config.runtimeGuard?.();const data=nativeApprovalData(store,row);
  if(config.nativeDesktopApprovals?.enabled!==true||!data||row.method!=='PermissionRequest'||row.owner_key!==store.get('owner')||row.expires_at<=now||row.last_seen<now-5000||data.scope.serviceInstance!==config.nativePermissionServiceInstance||JSON.stringify(data.scope.binding)!==JSON.stringify(data.binding)||JSON.stringify(data.scope.source)!==JSON.stringify(data.source)||JSON.stringify(data.binding)!==JSON.stringify(bindingScope(config,store.get('owner'))))return false;
  const current=source(config.nativeDesktopApprovals.home,data.payload,{reviewedRuntime:config.nativePermissionReviewedRuntime===true});
  return JSON.stringify(current)===JSON.stringify(data.source)&&sha256(JSON.stringify(data.scope))===row.fingerprint&&data.scope.requestKey===row.request_key&&data.scope.inputHash===current.inputHash;
 }catch{return false;}
}
export function registerNativeApproval(store,config,payload,{source=nativePermissionSource,now=Date.now(),serviceInstance}={}){
 config.runtimeGuard?.();if(config.nativeDesktopApprovals?.enabled!==true||payload.hook_event_name!=='PermissionRequest'||!serviceInstance||serviceInstance!==config.nativePermissionServiceInstance)throw Error('NATIVE_PERMISSION_NOT_ENABLED');
 const owner=store.get('owner'),identity=owner&&JSON.parse(owner);if(!identity||identity[0]!==config.qq.appId||identity[1]!=='c2c')throw Error('NATIVE_PERMISSION_OWNER_REQUIRED');
 const native=source(config.nativeDesktopApprovals.home,payload,{reviewedRuntime:config.nativePermissionReviewedRuntime===true}),requestKey=randomUUID(),code=randomBytes(6).toString('hex'),expiresAt=now+300000,binding=bindingScope(config,owner),scope={schemaVersion:1,requestKey,binding,serviceInstance,source:native,inputHash:native.inputHash,expiresAt};
 const preview=JSON.stringify({tool:native.toolName,input:native.toolInput},null,2),supported=preview.length<=12000&&!secretText(preview),details=supported?preview:'请求包含敏感内容或超出完整预览长度，仅可远程拒绝；请在原桌面对话核对。';
 return store.transaction(()=>{
  if(store.db.prepare("SELECT id FROM desktop_approvals WHERE method='PermissionRequest' AND status IN('pending','queued','sending')").all().length>=8)throw Error('NATIVE_PERMISSION_PENDING_LIMIT');
  const inserted=store.db.prepare("INSERT INTO desktop_approvals(owner_key,request_key,thread_id,turn_id,request_id,method,fingerprint,task_ref,title,details,remote_supported,code,status,created_at,expires_at,last_seen) VALUES(?,?,?,?,?,'PermissionRequest',?,?,?,?,?,?,'pending',?,?,?)").run(owner,requestKey,native.threadId,native.turnId,requestKey,sha256(JSON.stringify(scope)),native.threadId+':'+native.turnId,native.toolName,details,supported?1:0,code,now,expiresAt,now);
  const id=Number(inserted.lastInsertRowid);store.set(stateKey(requestKey),{scope,binding,source:native,payload,pid:process.pid,codeHash:sha256(code),createdAt:now});
  const body='桌面真实审批 H'+id+'\n工具：'+native.toolName+'\n项目：'+native.cwd+'\n会话：'+native.threadId+'\n回合：'+native.turnId+'\n指纹：'+sha256(JSON.stringify(scope))+'\n有效至：'+new Date(expiresAt).toISOString()+'\n\n'+completionText(details)+'\n\n'+(supported?'请直接回复“批准”或“拒绝”。':'请直接回复“拒绝”，或在本机核对完整内容后处理。')+'多条审批会逐条展示，每次回复只处理当前这一条。';
  const notification=store.ownerNotice('native-permission:'+requestKey,body,config.qq.appId,now,'【桌面 Codex 原生审批】','approval_notice');if(!notification)throw Error('NATIVE_PERMISSION_NOTIFICATION_TARGET_MISSING');store.db.prepare('UPDATE desktop_approvals SET notification_id=? WHERE id=?').run(notification,id);
  return store.db.prepare('SELECT * FROM desktop_approvals WHERE id=?').get(id);
 });
}
export function routeNativeApproval(store,config,owner,content,trigger,event,now=Date.now()){
 if(config.nativeDesktopApprovals?.enabled!==true)return null;
 if(/^(桌面审批|桌面审批列表)$/.test(content)){const rows=store.db.prepare("SELECT id,title,expires_at FROM desktop_approvals WHERE owner_key=? AND method='PermissionRequest' AND status='pending' AND expires_at>? ORDER BY id DESC LIMIT 8").all(owner,now);return rows.length?rows.map(r=>'桌面审批 H'+r.id+' · '+r.title+'\n查看当前审批后，直接回复“批准”或“拒绝”即可。').join('\n\n'):'当前没有桌面原生待审批请求。';}
 const match=/^(批准|拒绝|撤销审批)\s+H([1-9]\d{0,11})\s+([a-f0-9]{12})$/i.exec(content);if(!match)return null;
 const row=store.db.prepare("SELECT * FROM desktop_approvals WHERE id=? AND method='PermissionRequest'").get(Number(match[2])),data=nativeApprovalData(store,row);
 if(!row||!data||row.owner_key!==owner||owner!==store.get('owner')||!timingSafeEqual(Buffer.from(data.codeHash,'hex'),Buffer.from(sha256(match[3].toLowerCase()),'hex')))return '桌面审批编号、本人或一次性校验码不匹配，未提交。';
 if(!['pending','queued'].includes(row.status)||row.expires_at<=now)return '此桌面审批已处理或过期，不能重复决定；未知结果请核对原对话。';
 if(!approvalReplyIsFresh(store,owner,trigger,event,{noticeId:row.notification_id,createdAt:row.created_at,now}))return '审批消息已过期，未提交。';
 if(!nativeApprovalCurrent(store,config,row,{now}))return '原生回合、本人、绑定或当前请求已变化，未提交决定。';
 if(match[1]==='批准'&&row.remote_supported!==1)return '当前请求缺少可远程审核的完整预览，只能拒绝。';
 if(match[1]==='批准'&&(store.db.prepare('SELECT status,provider_id FROM outbox WHERE id=?').get(row.notification_id)?.status!=='sent'||store.db.prepare("SELECT 1 FROM outbox_parts WHERE notification_id=? AND (status!='sent' OR provider_id IS NULL)").get(row.notification_id)))return '完整审批通知尚未取得全部发送回执，未提交批准；请核对原通知。';
 if(row.status==='queued'&&match[1]!=='撤销审批')return '本次桌面决定已登记，等待原生钩子返回；不会重复提交。';
 const next=match[1]==='撤销审批'?'revoked':'queued',decision=match[1]==='批准'?'allow':'deny';
 const updated=store.db.prepare("UPDATE desktop_approvals SET status=?,decision=?,decision_event=?,decided_at=? WHERE id=? AND status IN("+(next==='revoked'?"'pending','queued'":"'pending'")+") AND fingerprint=? AND expires_at>?").run(next,decision,trigger,now,row.id,row.fingerprint,now);
 return updated.changes?next==='revoked'?'已撤销桌面审批，本次钩子将拒绝。':'已登记桌面决定，等待同一原生 PermissionRequest 返回；尚未证明操作成功。':'审批状态已变化，未重复提交。';
}
export function claimNativeDecision(store,config,id,{source=nativePermissionSource,now=Date.now()}={}){
 return store.transaction(()=>{const row=store.db.prepare('SELECT * FROM desktop_approvals WHERE id=?').get(id);if(row?.status==='revoked')return {behavior:'deny',id,revoked:true};if(!row||row.status!=='queued')return null;if(!nativeApprovalCurrent(store,config,row,{source,now})||row.decision==='allow'&&row.remote_supported!==1)throw Error('NATIVE_PERMISSION_DECISION_STALE');
  if(store.db.prepare("UPDATE desktop_approvals SET status='sending',last_seen=? WHERE id=? AND status='queued' AND fingerprint=?").run(now,id,row.fingerprint).changes!==1)throw Error('NATIVE_PERMISSION_ALREADY_CLAIMED');return {behavior:row.decision,id,fingerprint:row.fingerprint};});
}
function executionInputHash(native){
 const input=native.toolInput;
 // Codex adds a human-readable description to PermissionRequest. Bash and
 // apply_patch PostToolUse carry command alone. Only these documented tools
 // may omit that explanation; MCP arguments and unknown fields remain exact.
 if(['Bash','apply_patch'].includes(native.toolName)&&typeof input?.command==='string'&&Object.keys(input).every(key=>['command','description'].includes(key))&&(input.description==null||typeof input.description==='string'))return sha256(JSON.stringify({command:input.command}));
 return native.inputHash;
}
function matchesSubmittedExecution(store,config,row,data,native){
 if(!data||row.owner_key!==store.get('owner')||data.scope.serviceInstance!==config.nativePermissionServiceInstance||JSON.stringify(data.binding)!==JSON.stringify(bindingScope(config,store.get('owner')))||JSON.stringify(data.scope.source)!==JSON.stringify(data.source)||sha256(JSON.stringify(data.scope))!==row.fingerprint)return false;
 if(!['threadId','turnId','cwd','transcriptPath','metadataHash','cliVersion','toolName'].every(key=>data.source[key]===native[key]))return false;
 return executionInputHash(data.source)===executionInputHash(native)&&(!data.source.toolUseId||data.source.toolUseId===native.toolUseId);
}
export function recordNativePostTool(store,config,payload,{source=nativePermissionSource,now=Date.now()}={}){
 config.runtimeGuard?.();
 const native=source(config.nativeDesktopApprovals.home,payload),submitted=store.db.prepare("SELECT * FROM desktop_approvals WHERE method='PermissionRequest' AND thread_id=? AND turn_id=? AND status='submitted'").all(native.threadId,native.turnId),rows=submitted.filter(row=>matchesSubmittedExecution(store,config,row,nativeApprovalData(store,row),native));
 store.set('nativePermissionPostObservation',{at:now,threadId:native.threadId,turnId:native.turnId,toolName:native.toolName,toolUseId:native.toolUseId,inputKeys:Object.keys(native.toolInput||{}).sort().slice(0,32),inputHash:native.inputHash,submitted:submitted.length,matches:rows.length});
 if(rows.length!==1)return {confirmed:false,reason:rows.length?'ambiguous-identical-requests':'no-submitted-request'};
 const row=rows[0];return store.transaction(()=>{
  if(store.db.prepare("UPDATE desktop_approvals SET status='resolved',last_seen=? WHERE id=? AND status='submitted' AND fingerprint=?").run(now,row.id,row.fingerprint).changes!==1)return {confirmed:false,reason:'request-already-reconciled'};
  store.set('nativePermissionResult:'+row.request_key,{observedAt:now,event:'PostToolUse',toolUseId:native.toolUseId,responseHash:sha256(JSON.stringify(payload.tool_response??null)),effectSuccessNotInferred:true,correlation:'same-source-and-exact-execution-input'});
  store.set('nativePermissionVerification',{verified:true,status:'same-native-tool-request-and-return-verified',observedAt:now,requestId:row.id,toolName:native.toolName,cliVersion:native.cliVersion,scope:'native-tool-return-only',browserApplicationPermissionVerified:false});
  store.ownerNotice('native-permission-result:'+row.request_key,'桌面审批 H'+row.id+'：原生工具已返回结果。\n工具：'+native.toolName+'\n会话：'+native.threadId+'\n回合：'+native.turnId+'\n执行是否成功请以原对话中的实际工具结果为准。',config.qq.appId,now,'【桌面原生审批回执】','approval_reply');return {confirmed:true,id:row.id};
 });
}
export function nativeApprovalSnapshot(store,config){return {enabled:config.nativeDesktopApprovals?.enabled===true,source:'PermissionRequest',activation:store.get('nativePermissionVerification',{verified:false,status:'requires-native-hook-trust-and-real-verification'}),lastError:store.get('nativePermissionLastError'),counts:store.db.prepare("SELECT status,COUNT(*) count FROM desktop_approvals WHERE method='PermissionRequest' GROUP BY status").all(),recent:store.db.prepare("SELECT id,title,status,decision,last_seen updatedAt,error FROM desktop_approvals WHERE method='PermissionRequest' ORDER BY id DESC LIMIT 5").all()};}
