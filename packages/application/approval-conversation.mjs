import {sha256} from './boundaries.mjs';
import {approvalReplyIsFresh,recordApprovalClock} from './approval-clock.mjs';
import {routeRemoteApproval} from './approval-control.mjs';
import {routeNativeApproval} from './desktop-permission-control.mjs';
const key=owner=>'approvalConversation:'+sha256(owner||'');
const enabled=config=>config.remoteApprovals?.enabled===true||config.nativeDesktopApprovals?.enabled===true;
const liveStates=new Set(['pending','queued','sending','submitted']);
function descriptor(store,kind,row){
 if(!row)return null;
 if(kind==='H')return {kind,id:row.id,requestKey:row.request_key,owner:row.owner_key,fingerprint:row.fingerprint,status:row.status,expiresAt:row.expires_at,noticeId:row.notification_id,code:row.code,remoteSupported:row.remote_supported===1};
 let data;try{data=JSON.parse(row.data);}catch{return null;}
 return {kind,id:row.id,requestKey:row.request_key,owner:row.owner_key,fingerprint:row.fingerprint,status:row.status,expiresAt:row.expires_at,noticeId:data.notificationId,code:data.code,remoteSupported:data.canRemoteAccept===true};
}
function lookup(store,slot){return descriptor(store,slot.kind,store.db.prepare(slot.kind==='H'?"SELECT * FROM desktop_approvals WHERE id=? AND method='PermissionRequest'":'SELECT * FROM bridge_approvals WHERE id=?').get(slot.id));}
export function approvalNoticeComplete(store,id){
 const notice=store.db.prepare('SELECT status,provider_id FROM outbox WHERE id=?').get(id);
 return notice?.status==='sent'&&!!notice.provider_id&&!store.db.prepare("SELECT id FROM outbox_parts WHERE notification_id=? AND (status!='sent' OR provider_id IS NULL)").get(id);
}
function pending(store,config,owner,includeUnnotified=false){
 const rows=[];
 if(config.nativeDesktopApprovals?.enabled===true)rows.push(...store.db.prepare("SELECT * FROM desktop_approvals WHERE owner_key=? AND method='PermissionRequest' AND status IN('pending','queued','sending','submitted')").all(owner).map(row=>descriptor(store,'H',row)));
 if(config.remoteApprovals?.enabled===true)rows.push(...store.db.prepare("SELECT * FROM bridge_approvals WHERE owner_key=? AND status IN('pending','queued','sending','submitted')").all(owner).map(row=>descriptor(store,'A',row)));
 return rows.filter(row=>row&&(includeUnnotified||Number.isSafeInteger(row.noticeId)));
}
// Only one approval is presented at a time. Decisions remain owned by the
// original backend and go through its existing identity and CAS checks.
export function approvalConversationForDelivery(store,config,now=Date.now()){
 if(!enabled(config))return {blockedNoticeIds:[]};
 return store.transaction(()=>{
  const owner=store.get('owner');if(!owner)return {blockedNoticeIds:[]};
  let slot=store.get(key(owner)),current=slot&&lookup(store,slot);
  if(slot&&(!current||current.owner!==owner||current.requestKey!==slot.requestKey||current.fingerprint!==slot.fingerprint||current.expiresAt<=now||!['pending','queued','sending','unknown'].includes(current.status))){store.set(key(owner),null);slot=null;current=null;}
  const rows=pending(store,config,owner);
  for(const row of rows.filter(row=>row.expiresAt<=now||!liveStates.has(row.status))){
   store.db.prepare("UPDATE outbox SET status='cancelled',error='APPROVAL_ENDED_BEFORE_DISPLAY' WHERE id=? AND status='pending'").run(row.noticeId);
   store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='APPROVAL_ENDED_BEFORE_DISPLAY' WHERE notification_id=? AND status='pending'").run(row.noticeId);
  }
  if(!slot){
   const first=rows.filter(row=>row.status==='pending'&&row.expiresAt>now).sort((a,b)=>a.noticeId-b.noticeId)[0];
   if(first){slot={schemaVersion:1,kind:first.kind,id:first.id,requestKey:first.requestKey,fingerprint:first.fingerprint,noticeId:first.noticeId,openedAt:now,presentedAt:approvalNoticeComplete(store,first.noticeId)?now:null};store.set(key(owner),slot);current=first;}
  }
  return {active:slot,blockedNoticeIds:rows.filter(row=>row.status==='pending'&&row.expiresAt>now&&row.noticeId!==slot?.noticeId).map(row=>row.noticeId)};
 });
}
export function recordApprovalPromptReceipt(store,config,noticeId,now=Date.now(),receipt){
 if(!enabled(config))return;
 const owner=store.get('owner'),slot=owner&&store.get(key(owner));
 if(slot?.noticeId===noticeId&&approvalNoticeComplete(store,noticeId)){
  if(!slot.presentedAt)store.set(key(owner),{...slot,presentedAt:now});
  recordApprovalClock(store,noticeId,receipt,now);
 }
}
export function routeSimpleApproval(store,config,owner,content,trigger,event,now=Date.now()){
 const match=/^(批准|拒绝)[。！!]?$/u.exec(content.trim());if(!match||!enabled(config))return null;
 const slot=store.get(key(owner));if(!slot)return '当前没有已展示并等待你决定的审批。';
 const row=lookup(store,slot);
 if(!row||row.owner!==owner||owner!==store.get('owner')||row.requestKey!==slot.requestKey||row.fingerprint!==slot.fingerprint||row.expiresAt<=now||!['pending','queued','sending','unknown'].includes(row.status))return '刚才那条审批已结束，没有提交新的决定。';
 if(row.status==='unknown')return '上次决定的返回结果仍待核对，暂不重复提交。';
 if(row.status!=='pending')return '已收到你的决定，正在返回当前请求，请稍候。';
 if(!slot.presentedAt||!approvalNoticeComplete(store,row.noticeId))return '审批内容还未完整发送，请等内容发送完成后再回复。';
 if(!approvalReplyIsFresh(store,owner,trigger,event,{noticeId:row.noticeId,presentedAt:slot.presentedAt,now}))return '这条回复早于当前审批或已失效，请看当前审批内容后重新回复。';
 const command=match[1]+' '+row.kind+row.id+' '+row.code;
 const result=row.kind==='H'?routeNativeApproval(store,config,owner,command,trigger,event,now):routeRemoteApproval(store,config,owner,command,trigger,event,now);
 const after=lookup(store,slot);
 if(after?.status==='queued'){
  store.set('simpleApprovalDecision:'+sha256(trigger),{schemaVersion:1,kind:row.kind,id:row.id,requestKey:row.requestKey,fingerprint:row.fingerprint,noticeId:row.noticeId,presentedAt:slot.presentedAt,decision:match[1]==='批准'?'accept':'decline',eventKey:trigger,eventSentAt:event.sentAt,receivedAt:now,inputMode:'plain-qq-reply'});
  return '已收到“'+match[1]+'”，正在提交当前操作。';
 }
 return result||'这条审批已变化，请查看最新通知。';
}

export function routeApprovalOverview(store,config,owner,content,now=Date.now()){
 if(!enabled(config)||owner!==store.get('owner')||!/^(审批|审批列表|待审批|查看审批|桌面审批|桌面审批列表)$/.test(content.trim()))return null;
 const rows=pending(store,config,owner,true).filter(row=>row.expiresAt>now),slot=store.get(key(owner)),active=slot&&lookup(store,slot);
 const labels={pending:'等待决定',queued:'决定已登记，等待返回',sending:'正在返回决定',submitted:'决定已返回，等待工具回执',unknown:'结果待核对，请勿重复提交'};
 const lines=rows.map(row=>(row.kind==='H'?'桌面审批 H':'任务审批 A')+row.id+' · '+labels[row.status]+(row.id===slot?.id&&row.kind===slot?.kind?'（当前）':''));
 if(!lines.length)lines.push('当前没有待审批请求。');
 if(rows.length)lines.push('请核对原审批通知中的完整操作；列表摘要不能代替完整通知。');
 if(active?.status==='pending'&&active.expiresAt>now)lines.push(approvalNoticeComplete(store,active.noticeId)?'请核对当前 '+active.kind+active.id+' 原通知中的完整操作，再直接回复“批准”或“拒绝”；其余审批按顺序展示。':'当前审批内容正在发送，完整送达后再回复“批准”或“拒绝”。');
 const unknown=[];
 if(config.nativeDesktopApprovals?.enabled===true)unknown.push(...store.db.prepare("SELECT id FROM desktop_approvals WHERE owner_key=? AND method='PermissionRequest' AND status='unknown' ORDER BY id DESC LIMIT 3").all(owner).map(row=>'H'+row.id));
 if(config.remoteApprovals?.enabled===true)unknown.push(...store.db.prepare("SELECT id FROM bridge_approvals WHERE owner_key=? AND status='unknown' ORDER BY id DESC LIMIT 3").all(owner).map(row=>'A'+row.id));
 if(unknown.length)lines.push('历史结果待核对：'+unknown.join('、')+'。这些请求不能再次批准；请核对原会话的工具结果。');
 return lines.join('\n');
}
