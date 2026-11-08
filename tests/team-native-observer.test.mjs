import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../packages/application/store.mjs';
import {NativeDesktopReader} from '../packages/host-control/native-desktop-reader.mjs';
import {NativeGlobalNotifications} from '../packages/application/native-global-notifications.mjs';
import {nativeGlobalScope} from '../packages/application/native-desktop-scope.mjs';
import {sha256} from '../packages/application/boundaries.mjs';

function fixture(){
 assert.ok(process.env.QQ_TEST_ROOT,'QQ_TEST_ROOT must identify the independent test directory');
 const root=fs.mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'team-native-observer-')),home=path.join(root,'native'),cwd=path.join(root,'workspace'),stateDir=path.join(root,'business');
 for(const directory of [path.join(home,'sessions'),cwd,stateDir])fs.mkdirSync(directory,{recursive:true});
 let time=Date.now(),store;
 const owner=JSON.stringify(['12345','c2c','synthetic-person']);
 const config={instanceId:randomUUID(),hostId:randomUUID(),stateDir,runtimeRoot:root,policyVersion:3,binding:{botId:randomUUID(),agentId:randomUUID(),bindingId:randomUUID(),bindingVersion:1},qq:{appId:'12345',minimumSendIntervalMs:0,passiveWindowSeconds:300,maxPassiveReplies:4,allowProactive:true},desktopNotifications:{enabled:true,scope:'all-local',home,since:time-5000}};
 const open=()=>new Store(stateDir,{numberingConfig:config});store=open();store.set('owner',owner);
 store.ingest({appId:'12345',scope:'c2c',sender:'synthetic-person',target:'synthetic-person',id:randomUUID(),sentAt:time},()=>({}));
 const rows=[];
 const thread=()=>{
  const id=randomUUID(),file=path.join(home,'sessions','rollout-synthetic-'+id+'.jsonl'),row={id,rollout_path:file,source:'vscode',originator:'Codex Desktop',cwd,cli_version:'0.166.0-alpha.6',title:'synthetic original thread',project:'misc',projectScope:{project_key:'misc',project_name:'杂项'},hostId:'local'};
  fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,source:row.source,originator:row.originator,cwd,cli_version:row.cli_version}})+'\n');rows.push(row);return row;
 };
 const append=(row,type,turnId,at,extra={})=>fs.appendFileSync(row.rollout_path,JSON.stringify({type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type,turn_id:turnId,root_turn_id:turnId,...extra}})+'\n');
 const complete=(row)=>{const turn=randomUUID();append(row,'task_started',turn,time-1000);append(row,'task_complete',turn,time,{last_agent_message:'old verified final'});return turn;};
 const catalog=()=>({rows,projects:[{key:'misc',name:'杂项',project_key:'misc',project_name:'杂项',executable:false}],errors:[],source:'synthetic verified catalog'});
 const scopeKey=()=>sha256(JSON.stringify(nativeGlobalScope(config,owner)));
 return {root,home,cwd,stateDir,config,owner,thread,append,complete,rows,scopeKey,get store(){return store;},get now(){return time;},advance(ms=1000){time+=ms;},observer(){return new NativeGlobalNotifications(store,config,{reader:new NativeDesktopReader(home),catalog,now:()=>time});},snapshot(){return store.get('nativeCatalog');},cursor(row){return store.get('nativeGlobalCursor:'+scopeKey()+':'+row.id);},reopen(){store.close();store=open();},close(){store.close();}};
}

for(const priorStatus of ['completed','active_recorded'])test('failed native read marks '+priorStatus+' unknown without discarding historical evidence or its last verified time',()=>{
 const f=fixture();try{
  const row=f.thread(),turn=priorStatus==='completed'?f.complete(row):randomUUID();
  if(priorStatus==='active_recorded')f.append(row,'task_started',turn,f.now-1000);
  const original=fs.readFileSync(row.rollout_path,'utf8'),observer=f.observer();observer.refresh();
  const before=f.snapshot().threads[0],cursorBefore=f.cursor(row),outboxBefore=f.store.outbox().length;
  assert.equal(before.status,priorStatus);assert.equal(before.lastVerifiedAt,f.now);
  f.advance();fs.writeFileSync(row.rollout_path,original.replace(priorStatus==='completed'?'old verified final':'task_started',priorStatus==='completed'?'new altered final!':'task_startEd'));observer.refresh();
  const failed=f.snapshot().threads[0];
  assert.equal(failed.status,'unknown');assert.equal(failed.verificationError,'DESKTOP_TRANSCRIPT_CHANGED');assert.match(failed.stage,/读取失败/);assert.equal(failed.summary,null);
  assert.equal(failed.lastKnownStatus,priorStatus);assert.equal(failed.lastKnownSummary,before.summary);assert.equal(failed.lastVerifiedAt,before.lastVerifiedAt);assert.equal(failed.verificationCheckedAt,f.now);
  assert.equal(failed.turnId,before.turnId);assert.deepEqual(failed.reference,before.reference);assert.deepEqual(f.cursor(row),cursorBefore);assert.equal(f.store.outbox().length,outboxBefore);
  f.advance();fs.writeFileSync(row.rollout_path,original);observer.refresh();
  const recovered=f.snapshot().threads[0];assert.equal(recovered.status,priorStatus);assert.equal(recovered.verificationError,null);assert.equal(recovered.lastVerifiedAt,f.now);assert.equal(f.store.outbox().length,outboxBefore);
 }finally{f.close();}
});

test('native read failure remains explicit while the round-robin scheduler selects other threads',()=>{
 const f=fixture();try{
  for(let n=0;n<8;n++)f.thread();const target=f.rows[7];f.complete(target);
  const observer=f.observer(),scope=nativeGlobalScope(f.config,f.owner);observer.observe(target,scope,f.scopeKey());
  const original=fs.readFileSync(target.rollout_path,'utf8'),successfulAt=f.now;fs.writeFileSync(target.rollout_path,original.replace('old verified final','new altered final!'));
  observer.refresh();f.advance();observer.refresh();const failedAt=f.now;
  assert.equal(f.snapshot().threads[7].verificationError,'DESKTOP_TRANSCRIPT_CHANGED');
  f.advance();observer.refresh();const pending=f.snapshot().threads[7];
  assert.equal(pending.status,'unknown');assert.equal(pending.lastVerifiedAt,successfulAt);assert.equal(pending.verificationCheckedAt,failedAt);assert.equal(f.store.get('desktopObserverStatus').error,'DESKTOP_TRANSCRIPT_CHANGED');
  fs.writeFileSync(target.rollout_path,original);f.advance();observer.refresh();assert.equal(f.snapshot().threads[7].status,'completed');assert.equal(f.snapshot().threads[7].verificationError,null);
 }finally{f.close();}
});

test('64 unmatched historical starts retain the existing bound without claiming a completion',()=>{
 const f=fixture();try{
  const row=f.thread();for(let n=0;n<64;n++)f.append(row,'task_started',randomUUID(),f.config.desktopNotifications.since-10000+n);
  f.observer().refresh();assert.equal(Object.keys(f.cursor(row).pending).length,64);assert.equal(f.cursor(row).droppedPendingStarts,0);assert.equal(f.snapshot().threads[0].historyIncomplete,false);assert.notEqual(f.snapshot().threads[0].status,'completed');assert.equal(f.store.outbox().length,0);
 }finally{f.close();}
});

test('65 unmatched historical starts advance the cursor, persist degradation and still notify one exact later turn',()=>{
 const f=fixture();try{
  const row=f.thread(),oldTurns=[];for(let n=0;n<65;n++){const turn=randomUUID();oldTurns.push(turn);f.append(row,'task_started',turn,f.config.desktopNotifications.since-10000+n);}
  let observer=f.observer();observer.refresh();const cursor=f.cursor(row),offset=cursor.offset;
  assert.equal(offset,fs.statSync(row.rollout_path).size);assert.equal(Object.keys(cursor.pending).length,64);assert.equal(cursor.pending[oldTurns[0]],undefined);assert.ok(cursor.pending[oldTurns[64]]);assert.equal(cursor.droppedPendingStarts,1);
  assert.equal(f.snapshot().threads[0].historyIncomplete,true);assert.equal(f.snapshot().threads[0].droppedPendingStarts,1);assert.equal(f.store.outbox().length,0);
  observer.refresh();assert.equal(f.cursor(row).offset,offset);assert.equal(f.cursor(row).droppedPendingStarts,1);
  f.reopen();observer=f.observer();f.advance();f.append(row,'task_complete',oldTurns[0],f.now,{last_agent_message:'unmatched old end must not notify'});observer.refresh();assert.equal(f.store.outbox().length,0);assert.ok(f.cursor(row).offset>offset);
  const fresh=randomUUID();f.advance();f.append(row,'task_started',fresh,f.now-100);f.append(row,'task_complete',fresh,f.now,{last_agent_message:'exact new verified final'});observer.refresh();observer.refresh();
  assert.equal(f.store.outbox().length,1);assert.match(f.store.outbox()[0].content,/exact new verified final/);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM desktop_observations').get().n,1);
  const current=f.snapshot().threads[0];assert.equal(current.status,'completed');assert.equal(current.historyIncomplete,true);assert.equal(current.droppedPendingStarts,1);assert.match(current.stage,/1 条未配对/);assert.equal(f.cursor(row).droppedPendingStarts,1);
 }finally{f.close();}
});

test('pending retention follows event timestamps and degrades an evicted current start to unknown',()=>{
 const f=fixture();try{
  const row=f.thread(),turns=[];for(let n=0;n<65;n++){const turn=randomUUID();turns.push(turn);f.append(row,'task_started',turn,f.config.desktopNotifications.since-10000-n);}
  f.observer().refresh();const cursor=f.cursor(row);assert.ok(cursor.pending[turns[0]]);assert.equal(cursor.pending[turns[64]],undefined);assert.equal(cursor.droppedPendingStarts,1);assert.equal(f.snapshot().threads[0].status,'unknown');assert.equal(f.snapshot().threads[0].historyIncomplete,true);assert.match(f.snapshot().threads[0].stage,/缺少完整关联证据.*待核对.*1 条未配对/);assert.doesNotMatch(f.snapshot().threads[0].stage,/当前回合已核对/);assert.equal(f.store.outbox().length,0);
 }finally{f.close();}
});

test('discovery cutoff reads historical state without new references or notices and preserves the original scope and cursor',()=>{
 const f=fixture();try{
  const row=f.thread(),scopeBefore=nativeGlobalScope(f.config,f.owner),originalSince=f.config.desktopNotifications.since,originalScopeKey=f.scopeKey();
  f.config.desktopNotifications.discoverySince=f.now+1000;f.complete(row);let observer=f.observer();observer.refresh();
  assert.equal(f.snapshot().threads[0].status,'completed');assert.equal(f.snapshot().threads[0].summary,'old verified final');assert.equal(f.store.outbox().length,0);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM number_references WHERE kind='D'").get().n,0);
  const oldCursor=f.cursor(row);assert.equal(oldCursor.offset,fs.statSync(row.rollout_path).size);assert.deepEqual(nativeGlobalScope(f.config,f.owner),scopeBefore);assert.equal(f.scopeKey(),originalScopeKey);assert.equal(f.config.desktopNotifications.since,originalSince);
  f.advance(2000);const fresh=randomUUID();f.append(row,'task_started',fresh,f.now-100);f.append(row,'task_complete',fresh,f.now,{last_agent_message:'exact result after discovery cutoff'});observer.refresh();observer.refresh();
  assert.equal(f.store.outbox().length,1);assert.match(f.store.outbox()[0].content,/exact result after discovery cutoff/);assert.ok(f.cursor(row).offset>oldCursor.offset);assert.equal(f.cursor(row).identity,oldCursor.identity);assert.equal(f.cursor(row).file,oldCursor.file);
  const reference=f.store.db.prepare("SELECT * FROM number_references WHERE kind='D'").get();assert.equal(reference.local_number,1);assert.equal(reference.entity_key,row.id+':'+fresh);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM desktop_observations').get().n,1);
  f.reopen();observer=f.observer();observer.refresh();assert.equal(f.store.outbox().length,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM number_references WHERE kind='D'").get().n,1);assert.deepEqual(nativeGlobalScope(f.config,f.owner),scopeBefore);assert.equal(f.config.desktopNotifications.since,originalSince);
 }finally{f.close();}
});
