import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeOwnerConnection,nativeUuid} from '../host-control/native-owner-connection.mjs';
import {nativeOwnerEnabled,nativeOwnerScope,nativeControlTarget,nativeTurns,nativeActiveTurn,nativeQuestionGroups,nativeAnswerRecorded} from './native-owner-state.mjs';
import {nativeCatalogSnapshot} from './native-desktop-scope.mjs';
import {nativeQuestionCurrent,nativeQuestionData,nativeQuestionText} from './desktop-questions.mjs';
import {completionText} from './completion.mjs';
const errorCode=error=>/^[A-Z_]+$/.test(error?.code||error?.message||'')?error.code||error.message:'NATIVE_OWNER_OPERATION_FAILED';
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export class NativeOwnerBridge{
 constructor(store,config,{connection,now=()=>Date.now()}={}){
  Object.assign(this,{store,config,now});this.owner=store.get('owner');this.enabled=nativeOwnerEnabled(config);this.connection=connection||new NativeOwnerConnection({guard:()=>this.guard(),now});this.working=false;this.stopped=false;
  if(this.enabled){store.db.prepare("UPDATE native_control_operations SET status='unknown',error='NATIVE_OWNER_RETURN_REQUIRES_RECONCILIATION' WHERE status='sending'").run();store.db.prepare("UPDATE native_control_operations SET status='queued' WHERE status='checking'").run();
   for(const row of store.db.prepare("SELECT id FROM desktop_questions WHERE kind='native-client-question'").all()){const live=store.get('nativeQuestionLive:'+row.id);if(live&&['queued','sending','submitted','ready'].includes(live.phase))store.set('nativeQuestionLive:'+row.id,{...live,phase:['sending','submitted'].includes(live.phase)?'unknown':'expired',error:'NATIVE_OWNER_SERVICE_RESTARTED'});}
  }
 }
 guard(){this.config.runtimeGuard?.();if(this.stopped||!this.enabled||!nativeOwnerEnabled(this.config)||this.owner!==this.store.get('owner'))throw Error('NATIVE_OWNER_SCOPE_CHANGED');}
 target(threadId){this.guard();const row=nativeControlTarget(this.store,this.config,threadId);if(!row)throw Error('NATIVE_OWNER_SOURCE_UNAVAILABLE');return row;}
 async checkedSnapshot(threadId){
  const target=this.target(threadId),scope=nativeOwnerScope(this.store,this.config),snapshot=await this.connection.snapshot(threadId);this.guard();const latest=this.target(threadId);
  if(scope!==nativeOwnerScope(this.store,this.config)||target.project!==latest.project||!samePath(target.cwd,latest.cwd)||!samePath(snapshot.state.cwd,latest.cwd)||snapshot.state.id!==threadId||snapshot.state.hostId!=='local'||snapshot.state.ephemeral||snapshot.state.source!=='vscode'||snapshot.state.originator!=='Codex Desktop'||/subagent|guardian/i.test(String(snapshot.state.threadSource||''))||!nativeUuid(snapshot.owner)||snapshot.streamVersion!==11)throw Error('NATIVE_OWNER_SOURCE_MISMATCH');
  const activeTurnId=nativeActiveTurn(snapshot.state);if(snapshot.state.threadRuntimeStatus?.type==='active'&&!activeTurnId)throw Error('NATIVE_OWNER_ACTIVE_TURN_UNKNOWN');
  this.store.set('nativeOwnerThread:'+threadId,{scope,available:true,owner:snapshot.owner,streamVersion:11,checkedAt:this.now(),cwd:latest.cwd,activeTurnId,turnId:latest.turnId||null});return snapshot;
 }
 async refreshThread(threadId){
  try{const snapshot=await this.checkedSnapshot(threadId);await this.refreshQuestions(threadId,snapshot);this.store.set('nativeOwnerStatus',{enabled:true,connected:true,checkedAt:this.now(),transport:'codex-ipc',streamVersion:11,error:null,capabilities:{guidance:true,continueOriginalThread:true,cancelExactTurn:true,questionWriteback:true,browserHostApproval:false},mutatingAcceptance:'not-real-tested'});return snapshot;}
  catch(error){this.store.set('nativeOwnerThread:'+threadId,{scope:nativeOwnerScope(this.store,this.config),available:false,checkedAt:this.now(),error:errorCode(error)});for(const row of this.store.db.prepare("SELECT id FROM desktop_questions WHERE thread_id=? AND kind='native-client-question' AND status='pending'").all(threadId))this.store.db.prepare('UPDATE desktop_questions SET remote_supported=0 WHERE id=?').run(row.id);this.store.set('nativeOwnerStatus',{enabled:true,connected:false,checkedAt:this.now(),transport:'codex-ipc',error:errorCode(error),browserHostApproval:false});return null;}
 }
 questionEntry(row,snapshot){
  const data=nativeQuestionData(this.store,row);if(!nativeQuestionCurrent(this.store,this.config,row)||data?.warning)return null;
  const original=JSON.parse(row.questions),entry=nativeQuestionGroups(snapshot.state).find(e=>e.callId===row.request_id&&e.turnId===row.turn_id&&e.kind===(data.toolName==='request_user_input'?'sync':'async'));
  if(!entry||!entry.questions.length||entry.questions.length>3||new Set(entry.questions.map(q=>q.id)).size!==entry.questions.length||entry.questions.some(q=>q.secret||typeof q.id!=='string'||typeof q.text!=='string'||!q.text.trim()||!original[q.index]||completionText(q.text)!==original[q.index].text||JSON.stringify((q.options||[]).map(o=>typeof o==='string'?o:o?.label))!==JSON.stringify(original[q.index].options.map(o=>o.label))))return null;
  if(entry.kind==='sync'&&(entry.questions.length!==original.length||entry.questions.some(q=>q.id!==original[q.index].id)))return null;return entry;
 }
 async refreshQuestions(threadId,snapshot){
  for(const row of this.store.db.prepare("SELECT * FROM desktop_questions WHERE thread_id=? AND kind='native-client-question' AND owner_key=? AND (status='pending' OR response_event IS NOT NULL) ORDER BY id DESC LIMIT 8").all(threadId,this.owner)){
   const live=this.store.get('nativeQuestionLive:'+row.id);
   if(live&&['submitted','unknown'].includes(live.phase)&&live.entry&&live.answers&&nativeAnswerRecorded(snapshot.state,live.entry,live.answers)){
    this.store.db.prepare("UPDATE desktop_questions SET status='answered',remote_supported=0,responded_at=?,last_seen=? WHERE id=?").run(this.now(),this.now(),row.id);this.store.set('nativeQuestionLive:'+row.id,{...live,phase:'confirmed',confirmedAt:this.now()});if(live.trigger)this.store.reply(live.trigger,'Q'+row.id+'：原客户端已记录这条 QQ 答案。','question_reply');continue;
   }
   if(row.status!=='pending')continue;
   const entry=this.questionEntry(row,snapshot);if(!entry){this.store.db.prepare('UPDATE desktop_questions SET remote_supported=0 WHERE id=?').run(row.id);if(live?.phase==='submitted'&&this.now()-live.submittedAt>30000){this.store.set('nativeQuestionLive:'+row.id,{...live,phase:'unknown'});if(live.trigger)this.store.reply(live.trigger,'Q'+row.id+' 答案已返回，但尚未核对到实际答案记录，请在原卡片确认；未自动重发。','question_reply');}continue;}
   if(live&&['queued','sending','submitted','unknown'].includes(live.phase)){if(live.fingerprint!==entry.fingerprint||live.owner!==snapshot.owner){this.store.db.prepare('UPDATE desktop_questions SET remote_supported=0 WHERE id=?').run(row.id);}continue;}
   this.store.set('nativeQuestionLive:'+row.id,{scope:nativeOwnerScope(this.store,this.config),owner:snapshot.owner,phase:'ready',fingerprint:entry.fingerprint,entry,checkedAt:this.now()});this.store.db.prepare('UPDATE desktop_questions SET remote_supported=1 WHERE id=? AND status=\'pending\'').run(row.id);
   if(row.remote_supported!==1){const noticeKey='native-question-owner-ready:'+row.request_key,old=this.store.db.prepare('SELECT id FROM outbox WHERE notification_key=?').get(noticeKey),notice=old?.id||this.store.ownerNotice(noticeKey,nativeQuestionText({...row,remote_supported:1},nativeQuestionData(this.store,row)),this.config.qq.appId,this.now(),'【原问题可在 QQ 回答】','question_notice');if(notice){this.store.db.prepare('UPDATE desktop_questions SET notification_id=? WHERE id=?').run(notice,row.id);this.store.set('nativeQuestionNotice:'+notice,{id:row.id});}}
  }
 }
 finishOperation(row,status,text,error=null){this.store.transaction(()=>{this.store.db.prepare('UPDATE native_control_operations SET status=?,finished_at=?,error=? WHERE id=?').run(status,this.now(),error,row.id);this.store.reply(row.trigger_event,'原会话操作 #'+row.id+'：'+text,'guidance_result');});}
 async operation(){
  const row=this.store.transaction(()=>{const row=this.store.db.prepare("SELECT * FROM native_control_operations WHERE status='queued' AND (?=0 OR action='cancel') ORDER BY id LIMIT 1").get(this.store.get('paused',false)?1:0);if(row)this.store.db.prepare("UPDATE native_control_operations SET status='checking' WHERE id=? AND status='queued'").run(row.id);return row;});if(!row)return false;
  let sending=false;try{
   this.guard();const data=JSON.parse(row.data),target=this.target(row.thread_id);if(row.owner_key!==this.owner||data.scope!==nativeOwnerScope(this.store,this.config)||target.project!==data.project||!samePath(row.cwd,target.cwd)||this.now()-row.created_at>600000)throw Error('NATIVE_OWNER_OPERATION_STALE');
   const snapshot=await this.checkedSnapshot(row.thread_id),active=nativeActiveTurn(snapshot.state);if(active!==data.expectedActiveTurnId||snapshot.owner!==data.expectedOwnerId)throw Error('NATIVE_OWNER_TURN_CHANGED');
   this.guard();const messageId=randomUUID();this.store.db.prepare("UPDATE native_control_operations SET status='sending',dispatched_at=?,message_id=? WHERE id=? AND status='checking'").run(this.now(),messageId,row.id);sending=true;
   const result=row.action==='cancel'?await this.connection.interrupt(snapshot,active):await this.connection.guide(snapshot,'【QQ 原会话指导 #'+row.id+'】\n'+row.prompt,{activeTurnId:active,messageId});
   this.store.db.prepare('UPDATE native_control_operations SET result_turn_id=? WHERE id=?').run(result.turnId,row.id);this.finishOperation(row,'accepted',row.action==='cancel'?'原客户端已接收对该回合的取消；终态继续按原回合事件核对。':'原对话已接收，模型及权限沿用原客户端；完成结果继续由原通知返回。');
  }catch(error){this.finishOperation(row,sending?'unknown':'failed',sending?'提交结果待核对，请先核对原对话；本条未自动重发。':'原会话、回合或控制连接当前不可用，本条未发送。',errorCode(error));}return true;
 }
 async answer(){
  const rows=this.store.db.prepare("SELECT * FROM desktop_questions WHERE kind='native-client-question' AND owner_key=? AND status='pending' ORDER BY id LIMIT 16").all(this.owner),row=rows.find(row=>this.store.get('nativeQuestionLive:'+row.id)?.phase==='queued');if(!row)return false;const saved=this.store.get('nativeQuestionLive:'+row.id);let sending=false;
  try{
   this.guard();if(saved.scope!==nativeOwnerScope(this.store,this.config)||this.now()-saved.queuedAt>120000)throw Error('NATIVE_OWNER_ANSWER_STALE');const snapshot=await this.checkedSnapshot(row.thread_id),entry=this.questionEntry(row,snapshot);if(!entry||snapshot.owner!==saved.owner||entry.fingerprint!==saved.fingerprint)throw Error('NATIVE_OWNER_QUESTION_CHANGED');
   this.guard();this.store.set('nativeQuestionLive:'+row.id,{...saved,phase:'sending'});sending=true;await this.connection.answer(snapshot,entry,saved.answers,{messageId:saved.messageId});this.store.set('nativeQuestionLive:'+row.id,{...saved,phase:'submitted',entry,submittedAt:this.now()});this.store.db.prepare('UPDATE desktop_questions SET remote_supported=0 WHERE id=?').run(row.id);const after=await this.checkedSnapshot(row.thread_id);await this.refreshQuestions(row.thread_id,after);
  }catch(error){this.store.set('nativeQuestionLive:'+row.id,{...saved,phase:sending?'unknown':'expired',error:errorCode(error)});this.store.db.prepare('UPDATE desktop_questions SET remote_supported=0 WHERE id=?').run(row.id);this.store.reply(saved.trigger,'Q'+row.id+(sending?' 答案提交结果待核对，请在原卡片确认；未自动重发。':' 原问题或连接已变化，本条答案未提交，请在原卡片处理。'),'question_reply');}return true;
 }
 async runOnce(){
  if(!this.enabled||this.stopped||this.working)return false;this.working=true;try{
   this.guard();if(await this.operation())return true;if(await this.answer())return true;
   const selected=this.store.get('selectedWorkTask:'+this.owner),pending=this.store.db.prepare("SELECT DISTINCT thread_id FROM desktop_questions WHERE kind='native-client-question' AND owner_key=? AND status='pending' ORDER BY id DESC LIMIT 4").all(this.owner).map(row=>row.thread_id),fallback=nativeCatalogSnapshot(this.store,this.config)?.threads.find(row=>!row.archived&&!row.verificationError)?.id;
   for(const thread of [...new Set([selected?.threadId,...pending,fallback].filter(Boolean))].slice(0,5)){if(this.stopped)break;await this.refreshThread(thread);}return true;
  }catch(error){if(!this.stopped)this.store.set('nativeOwnerStatus',{enabled:true,connected:false,checkedAt:this.now(),transport:'codex-ipc',error:errorCode(error)});return false;}finally{this.working=false;}
 }
 snapshot(){const status=this.store.get('nativeOwnerStatus');return this.enabled?{enabled:true,...(status||{connected:false}),fresh:!!status&&this.now()>=status.checkedAt&&this.now()-status.checkedAt<=15000,transport:'codex-ipc',browserHostApproval:false}:{enabled:false};}
 stop(){this.stopped=true;this.connection.close();}
}
