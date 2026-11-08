import {readNativeCatalog} from '../host-control/native-desktop-catalog.mjs';
import {NativeDesktopReader} from '../host-control/native-desktop-reader.mjs';
import {sha256} from './boundaries.mjs';
import {ensureReference,referenceLabel} from './numbering.mjs';
import {completionText} from './completion.mjs';
import {nativeGlobalScope} from './native-desktop-scope.mjs';
export {nativeGlobalEnabled,nativeGlobalScope,nativeCatalogSnapshot,nativeGlobalNoticeValid} from './native-desktop-scope.mjs';
const OPEN_TURN_LIMIT=64;
const verificationKey=(scopeKey,threadId)=>'nativeThreadVerification:'+scopeKey+':'+threadId;
export class NativeGlobalNotifications{
 constructor(store,config,{reader,now=()=>Date.now(),catalog=readNativeCatalog}={}){Object.assign(this,{store,config,now,catalog});this.owner=store.get('owner');this.reader=reader||new NativeDesktopReader(config.desktopNotifications.home);this.rotation=0;}
 refresh(){
  const errors=[];let snapshot;
  try{
   this.config.runtimeGuard?.();if(this.owner!==this.store.get('owner'))throw Error('DESKTOP_NOTIFICATION_OWNER_CHANGED');
   const scope=nativeGlobalScope(this.config,this.owner),scopeKey=sha256(JSON.stringify(scope)),data=this.catalog(this.config.desktopNotifications.home,{reader:this.reader});
   const rows=data.rows.filter(row=>!this.store.get('bridgeThread:'+row.id)&&!this.store.db.prepare('SELECT id FROM tasks WHERE thread_id=?').get(row.id));
   errors.push(...data.errors);
   const selected=new Map(rows.slice(0,2).map(row=>[row.id,row]));
   for(let i=0;i<Math.min(4,rows.length);i++){const row=rows[(this.rotation+i)%rows.length];selected.set(row.id,row);}if(rows.length)this.rotation=(this.rotation+4)%rows.length;
   for(const row of selected.values())try{this.observe(row,scope,scopeKey);}catch(error){
    const code=/^[A-Z_]+$/.test(error.message)?error.message:'DESKTOP_OBSERVATION_FAILED',key=verificationKey(scopeKey,row.id),prior=this.store.get(key);
    this.store.set(key,{checkedAt:this.now(),lastVerifiedAt:prior?.lastVerifiedAt??null,error:code});errors.push({threadId:row.id,error:code});
   }
   snapshot={scopeKey,projects:data.projects,checkedAt:this.now(),source:data.source,executionGranted:false,threads:rows.map(row=>{
    const recorded=this.store.get('nativeThreadState:'+scopeKey+':'+row.id),state=recorded?.cwd===row.cwd?recorded:null,verification=this.store.get(verificationKey(scopeKey,row.id)),error=verification?.error||null,cursor=this.store.get('nativeGlobalCursor:'+scopeKey+':'+row.id),droppedPendingStarts=cursor?.droppedPendingStarts||0;
    if(error&&!errors.some(item=>item.threadId===row.id&&item.error===error))errors.push({threadId:row.id,error});
    const verified=!error&&state?.caughtUp,status=verified?state.status:'unknown';
    const stage=error?'来源读取失败，当前状态待核对':status==='unknown'&&droppedPendingStarts?'回合缺少完整关联证据，当前状态待核对；历史有 '+droppedPendingStarts+' 条未配对开始记录':verified?(droppedPendingStarts?'当前回合已核对；历史有 '+droppedPendingStarts+' 条未配对开始记录':'已核对原回合事件'):'正在核对原回合事件';
    return {id:row.id,project:row.project,cwd:row.cwd,historyCwd:row.historyCwd,cwdChanged:row.cwdChanged,title:completionText(row.title).slice(0,160),parentThreadId:row.parentThreadId,sourceKind:row.sourceKind,hostId:'local',archived:row.archived===1,
     status,turnId:state?.turnId||null,rootTurnId:state?.rootTurnId||null,updatedAt:state?.eventAt||null,summary:error?null:state?.summary||null,stage,reference:state?.reference||null,
     verificationError:error,verificationCheckedAt:verification?.checkedAt??null,lastVerifiedAt:verification?.lastVerifiedAt??null,historyIncomplete:droppedPendingStarts>0,droppedPendingStarts,
     ...(error?{lastKnownStatus:state?.status||null,lastKnownSummary:state?.summary||null}:{} )};
   })};
   this.store.set('nativeCatalog',snapshot);
  }catch(error){errors.push({error:/^[A-Z_]+$/.test(error.message)?error.message:'DESKTOP_OBSERVER_UNAVAILABLE'});}
  this.store.set('desktopObserverStatus',{enabled:true,scope:'all-local',checkedAt:this.now(),error:errors[0]?.error||null,errors:errors.slice(0,12),discovered:snapshot?.threads.length||0,checked:snapshot?.threads.filter(r=>r.status!=='unknown').length||0,historyIncomplete:snapshot?.threads.filter(r=>r.historyIncomplete).length||0,droppedPendingStarts:snapshot?.threads.reduce((sum,row)=>sum+row.droppedPendingStarts,0)||0,source:'verified-local-native-events',controlConnected:false});
 }
 observe(row,scope,scopeKey){
  const key='nativeGlobalCursor:'+scopeKey+':'+row.id,stateKey='nativeThreadState:'+scopeKey+':'+row.id,prior=this.store.get(key),batch=this.reader.read(row,prior,{readOnlyCatalog:true}),pending={...batch.cursor.pending};
  const discoverySince=Math.max(scope.since,this.config.desktopNotifications.discoverySince||0);
  let droppedPendingStarts=prior?.droppedPendingStarts||0;
  let state=this.store.get(stateKey);
  this.store.transaction(()=>{
   for(const event of batch.events){
    if(event.type==='task_started'){
     pending[event.turnId]={timestamp:event.timestamp,rootTurnId:event.rootTurnId};
     const reference=event.timestamp>=discoverySince?ensureReference(this.store,this.config,'D',row.id+':'+event.turnId,{owner:this.owner,scope:row.projectScope,at:event.timestamp}):null;
     state={cwd:row.cwd,status:'active_recorded',turnId:event.turnId,rootTurnId:event.rootTurnId,eventAt:event.timestamp,summary:null,reference};continue;
    }
    const started=pending[event.turnId];if(!started||event.timestamp<started.timestamp||event.rootTurnId!==started.rootTurnId)continue;
    delete pending[event.turnId];
    const status=event.type==='turn_aborted'?'interrupted':event.failed?'failed':'completed';
    const body=completionText(event.body||(status==='failed'?'桌面回合失败，请在原对话查看错误。':status==='interrupted'?'桌面回合已中断。':'桌面回合已结束，没有可用的最终答复，请在原对话核对结果。'));
    if(state?.turnId===event.turnId)state={...state,status,eventAt:event.timestamp,summary:body};
    if(event.timestamp<discoverySince)continue;
    const legacy=this.store.db.prepare('SELECT owner_key FROM desktop_completions WHERE thread_id=? AND turn_id=?').get(row.id,event.turnId);
    if(legacy&&legacy.owner_key!==this.owner)throw Error('DESKTOP_COMPLETION_OWNER_CHANGED');
    if(this.store.db.prepare('SELECT id FROM desktop_observations WHERE thread_id=? AND turn_id=?').get(row.id,event.turnId))continue;
    const observationId=sha256(scopeKey+':'+row.id+':'+event.turnId);
    this.store.db.prepare('INSERT INTO desktop_observations(id,scope_key,scope_json,thread_id,turn_id,project_root,status,completed_at,summary,evidence,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(observationId,scopeKey,JSON.stringify(scope),row.id,event.turnId,row.cwd,status,event.timestamp,body,JSON.stringify(event.evidence),this.now());
    this.store.db.prepare('INSERT OR IGNORE INTO desktop_completions(thread_id,turn_id,completed_at,title,status,owner_key,rollout_path,project_root) VALUES(?,?,?,?,?,?,?,?)').run(row.id,event.turnId,event.timestamp,completionText(row.title||row.projectScope.project_name),status,this.owner,event.evidence.file,row.cwd);
    this.store.desktopNoticeNumber(row.id,event.turnId);
    const reference=ensureReference(this.store,this.config,'D',row.id+':'+event.turnId,{owner:this.owner,scope:row.projectScope,at:event.timestamp});
    if(state?.turnId===event.turnId)state.reference=reference;
    const label={completed:'回合已完成',failed:'回合失败',interrupted:'回合已中断'}[status];
    const outbox=this.store.ownerNotice('desktop:'+row.id+':'+event.turnId,body,this.config.qq.appId,this.now(),'【桌面 Codex】'+referenceLabel(reference)+' · '+label);
    if(!outbox)throw Error('DESKTOP_NOTIFICATION_RECIPIENT_MISSING');
    this.store.db.prepare('UPDATE desktop_observations SET outbox_id=? WHERE id=?').run(outbox,observationId);
   }
   const open=Object.entries(pending);
   if(open.length>OPEN_TURN_LIMIT){
    open.sort(([a,left],[b,right])=>right.timestamp-left.timestamp||(a<b?-1:a>b?1:0));
    for(const [turnId]of open.slice(OPEN_TURN_LIMIT)){delete pending[turnId];droppedPendingStarts++;}
    // Discarding old unmatched starts is a bounded-history degradation, never
    // evidence that those turns completed or were cancelled.
    if(state?.status==='active_recorded'&&!pending[state.turnId])state={...state,status:'unknown'};
   }
   if(state)this.store.set(stateKey,{...state,cwd:row.cwd,caughtUp:!batch.more&&!batch.cursor.skipping,skippedLargeRecords:batch.cursor.skippedLargeRecords||0});
   this.store.set(key,{...batch.cursor,pending,droppedPendingStarts});
   const checkedAt=this.now();this.store.set(verificationKey(scopeKey,row.id),{checkedAt,lastVerifiedAt:checkedAt,error:null});
  });
 }
}
