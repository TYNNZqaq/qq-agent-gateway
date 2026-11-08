import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks,syncBuiltinESMExports} from 'node:module';

// Allows this owned overlay to be verified before the root agent applies it.
// In the repository every relative module already exists, so no hook is used.
if(process.env.QQ_TEAM_BASELINE_ROOT){
 const overlay=path.resolve(fileURLToPath(new URL('..',import.meta.url))),baseline=path.resolve(process.env.QQ_TEAM_BASELINE_ROOT);
 registerHooks({resolve(specifier,context,nextResolve){
  try{return nextResolve(specifier,context);}catch(error){
   if(error.code!=='ERR_MODULE_NOT_FOUND'||!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;
   const target=fileURLToPath(new URL(specifier,context.parentURL)),relative=path.relative(overlay,target);
   if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.startsWith('packages'+path.sep))throw error;
   return nextResolve(pathToFileURL(path.join(baseline,relative)).href,context);
  }
 }});
}
const {Store}=await import('../packages/application/store.mjs');
const {ensureReference}=await import('../packages/application/numbering.mjs');
const {FileObserver,FILE_LIMITS,planFiles,fileBytes}=await import('../packages/application/files.mjs');
const {recordNativeArtifacts,nativeVisualizationRoot,readStableArtifact}=await import('../packages/application/native-desktop-files.mjs');

function fixture(policyVersion=3){
 const base=process.env.QQ_TEST_ROOT||os.tmpdir();fs.mkdirSync(base,{recursive:true});
 const root=fs.realpathSync(fs.mkdtempSync(path.join(base,'team-native-files-'))),home=path.join(root,'native'),cwd=path.join(root,'project'),directory=path.join(root,'business');
 for(const folder of [path.join(home,'sessions'),cwd,directory])fs.mkdirSync(folder,{recursive:true});
 const owner=JSON.stringify(['12345','c2c','paired-person']),now=Date.now(),config={instanceId:randomUUID(),stateDir:directory,policyVersion,projects:{},qq:{appId:'12345',allowProactive:true},desktopNotifications:{enabled:false,home},fileDelivery:{enabled:true}};
 let store=new Store(directory,{numberingConfig:config});store.set('owner',owner);store.set('fileDeliveryStartedAt',now-1000);
 store.ingest({appId:'12345',scope:'c2c',sender:'paired-person',target:'paired-person',id:randomUUID(),sentAt:now},()=>({}));
 const makeFile=(file,contents='synthetic report',at=now)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contents);fs.utimesSync(file,new Date(at),new Date(at));return file;};
 return {root,home,cwd,directory,owner,now,config,makeFile,get store(){return store;},reopen(){store.close();store=new Store(directory,{numberingConfig:config});},close(){store.close();}};
}

for(const scenario of [
 {name:'local date before UTC midnight',date:['2026','11','06'],completedAt:'2026-11-06T00:15:00+08:00',archived:false},
 {name:'retained thread date after later turns',date:['2026','11','04'],completedAt:'2026-11-06T12:15:00+08:00',archived:false},
 {name:'archived native transcript',date:['2026','11','04'],completedAt:'2026-11-06T12:15:00+08:00',archived:true}
])test('same-thread native visual file survives '+scenario.name,()=>{
 const f=fixture();try{
  const threadId=randomUUID(),turnId=randomUUID(),completedAt=Date.parse(scenario.completedAt),candidate=f.makeFile(path.join(f.home,'visualizations',...scenario.date,threadId,'report.txt'),'synthetic report',completedAt);
  const context={threadId,cwd:f.cwd,startedAt:completedAt-1000,completedAt,evidence:{file:path.join(f.home,scenario.archived?'archived_sessions':'sessions','rollout-synthetic.jsonl')}};
  const key='D:'+threadId+':'+turnId,records=recordNativeArtifacts(f.store,f.config,key,context,[candidate],FILE_LIMITS);
  assert.equal(records.length,1);assert.equal(records[0].threadId,threadId);assert.equal(records[0].path,candidate);
  const noticeId=f.store.ownerNotice('desktop:'+threadId+':'+turnId,'synthetic result','12345',completedAt);
  planFiles(f.store,f.config,{key,noticeId,label:'合成项目 D1',prompt:'请把本轮报告文件通过 QQ 交付给我。',final:'[报告](<'+candidate.replaceAll('\\','/')+'>)',cwd:f.cwd,startedAt:context.startedAt,completedAt,owner:f.owner},completedAt);
  const transfers=f.store.db.prepare('SELECT * FROM file_transfers').all();assert.equal(transfers.length,1);assert.equal(transfers[0].sha256,records[0].sha256);assert.equal(fileBytes(f.store,transfers[0]).toString(),'synthetic report');
  assert.equal(f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(transfers[0].outbox_id).status,'pending');
 }finally{f.close();}
});

test('native visualization root refuses other threads, other homes and invalid calendar dates',()=>{
 const f=fixture();try{
  const threadId=randomUUID(),wrongThread=randomUUID(),otherHome=path.join(f.root,'other-native'),valid=f.makeFile(path.join(f.home,'visualizations','2026','11','06',threadId,'report.txt'));
  const wrongs=[f.makeFile(path.join(f.home,'visualizations','2026','11','06',wrongThread,'report.txt')),f.makeFile(path.join(otherHome,'visualizations','2026','11','06',threadId,'report.txt')),f.makeFile(path.join(f.home,'visualizations','2026','02','30',threadId,'report.txt')),f.makeFile(path.join(f.home,'report.txt'))];
  assert.ok(nativeVisualizationRoot(f.config,threadId,valid));
  for(const file of wrongs)assert.equal(nativeVisualizationRoot(f.config,threadId,file),null);
  const context={threadId,cwd:f.cwd,startedAt:f.now-1000,completedAt:f.now,evidence:{file:path.join(f.home,'sessions','synthetic.jsonl')}};
  assert.equal(recordNativeArtifacts(f.store,f.config,'D:wrong',context,wrongs,FILE_LIMITS).length,0);
 }finally{f.close();}
});

test('old or private native output files remain ineligible after visual directory fixes',()=>{
 const f=fixture();try{
  const threadId=randomUUID(),folder=path.join(f.home,'visualizations','2026','11','06',threadId),old=f.makeFile(path.join(folder,'old.txt'),'old result',f.now-10000),secret=f.makeFile(path.join(folder,'auth.json'),'synthetic private'),nested=f.makeFile(path.join(folder,'.git','report.txt'),'synthetic private');
  const context={threadId,cwd:f.cwd,startedAt:f.now-1000,completedAt:f.now,evidence:{file:path.join(f.home,'archived_sessions','synthetic.jsonl')}};
  assert.equal(recordNativeArtifacts(f.store,f.config,'D:blocked',context,[old,secret,nested],FILE_LIMITS).length,0);
 }finally{f.close();}
});

for(const time of [
 {name:'missing',startedAt:undefined,completedAt:undefined},
 {name:'NaN start',startedAt:NaN,completedAt:Date.now()},
 {name:'NaN completion',startedAt:Date.now(),completedAt:NaN},
 {name:'reversed',startedAt:Date.now()+1000,completedAt:Date.now()}
])test('production artifact paths reject '+time.name+' turn window',()=>{
 const f=fixture(1);try{
  const file=f.makeFile(path.join(f.cwd,'outputs','report.txt')),threadId=randomUUID(),key='D:'+threadId+':'+randomUUID(),context={threadId,cwd:f.cwd,startedAt:time.startedAt,completedAt:time.completedAt,evidence:{file:path.join(f.home,'sessions','synthetic.jsonl')}};
  assert.equal(recordNativeArtifacts(f.store,f.config,key,context,[file],FILE_LIMITS).length,0);
  const noticeId=f.store.ownerNotice('synthetic:'+randomUUID(),'synthetic result','12345',f.now);
  planFiles(f.store,f.config,{key,noticeId,label:'合成项目 D1',prompt:'请把本轮报告文件通过 QQ 交付给我。',final:'[报告](<'+file.replaceAll('\\','/')+'>)',cwd:f.cwd,startedAt:time.startedAt,completedAt:time.completedAt,owner:f.owner},f.now);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM file_transfers').get().n,0);
  assert.match(f.store.db.prepare('SELECT warnings FROM file_batches WHERE source_key=?').get(key).warnings,/NOT_FROM_THIS_TURN/);
 }finally{f.close();}
});

function patchFs(changes,run){
 const originals=Object.fromEntries(Object.keys(changes).map(key=>[key,fs[key]]));Object.assign(fs,changes);syncBuiltinESMExports();
 try{return run();}finally{Object.assign(fs,originals);syncBuiltinESMExports();}
}

test('stable artifact reader accepts unchanged regular and empty files with exact byte limits',()=>{
 const f=fixture();try{const file=f.makeFile(path.join(f.cwd,'outputs','report.txt'),'1234567890123456');assert.equal(readStableArtifact(file,{maxBytes:16}).bytes.toString(),'1234567890123456');assert.throws(()=>readStableArtifact(file,{maxBytes:15}),/TOO_LARGE/);const empty=f.makeFile(path.join(f.cwd,'outputs','empty.txt'),'');assert.equal(readStableArtifact(empty,{maxBytes:0}).bytes.length,0);}finally{f.close();}
});

test('a swapped path is rejected from the opened descriptor identity before reading any bytes',()=>{
 const f=fixture();try{
  const file=f.makeFile(path.join(f.cwd,'outputs','report.txt'),'1111111111111111'),other=f.makeFile(path.join(f.cwd,'other.txt'),'2222222222222222'),realOpen=fs.openSync,realRead=fs.readSync,realFstat=fs.fstatSync;let opened,reads=0;
  patchFs({openSync:(target,...args)=>{opened=realOpen(target===file?other:target,...args);return opened;},readSync:(...args)=>{reads++;return realRead(...args);}},()=>assert.throws(()=>readStableArtifact(file,{maxBytes:16}),/FILE_CHANGED/));
  assert.equal(reads,0);assert.throws(()=>realFstat(opened),e=>e.code==='EBADF');
 }finally{f.close();}
});

test('a file that grows after stat is rejected after at most its checked size plus one byte',()=>{
 const f=fixture();try{
  const file=f.makeFile(path.join(f.cwd,'outputs','report.txt'),'1234567890123456'),realRead=fs.readSync;let readBytes=0,requested=0,changed=false;
  patchFs({readSync:(fd,buffer,offset,length,position)=>{requested+=length;if(!changed){changed=true;fs.appendFileSync(file,Buffer.alloc(1024*1024,120));}const n=realRead(fd,buffer,offset,length,position);readBytes+=n;return n;}},()=>assert.throws(()=>readStableArtifact(file,{maxBytes:16}),/TOO_LARGE|FILE_CHANGED/));
  assert.ok(readBytes<=17);assert.ok(requested<=17);assert.equal(fs.statSync(file).size,16+1024*1024);
 }finally{f.close();}
});

test('same-size modifications during a read are rejected before becoming a manifest',()=>{
 const f=fixture();try{
  const file=f.makeFile(path.join(f.cwd,'outputs','report.txt'),'1111111111111111'),realRead=fs.readSync;let changed=false;
  patchFs({readSync:(...args)=>{const n=realRead(...args);if(!changed){changed=true;fs.writeFileSync(file,'2222222222222222');fs.utimesSync(file,new Date(f.now+60000),new Date(f.now+60000));}return n;}},()=>assert.throws(()=>readStableArtifact(file,{maxBytes:16}),/FILE_CHANGED/));
 }finally{f.close();}
});

function queueRows(f,count=21){
 const rows=[];
 for(let i=1;i<=count;i++){
  const thread='00000000-0000-4000-8000-'+String(i).padStart(12,'0'),turn='10000000-0000-4000-8000-'+String(i).padStart(12,'0'),notice=f.store.ownerNotice('desktop:'+thread+':'+turn,'synthetic result','12345',f.now);
  f.store.db.prepare('INSERT INTO desktop_completions(thread_id,turn_id,completed_at,title,status,owner_key,rollout_path,project_root) VALUES(?,?,?,?,?,?,?,?)').run(thread,turn,f.now,'synthetic '+i,'completed',f.owner,path.join(f.root,'synthetic-history-'+i+'.jsonl'),f.cwd);
  ensureReference(f.store,f.config,'D',thread+':'+turn,{owner:f.owner,scope:{project_key:'synthetic-project',project_name:'合成项目'},at:f.now});rows.push({thread,turn,notice});
 }
 return rows;
}

test('twenty failed contexts cannot starve the next valid completion, including restart and equal-time ordering',async()=>{
 const f=fixture(1);try{
  f.config.desktopNotifications={...f.config.desktopNotifications,enabled:true,scope:'all-local',since:f.now-1000,discoverySince:f.now-100};
  const rows=queueRows(f),attempts=new Map(),oldThread='00000000-0000-4000-8000-000000000000',oldTurn='10000000-0000-4000-8000-000000000000';
  f.store.ownerNotice('desktop:'+oldThread+':'+oldTurn,'older synthetic result','12345',f.now-500);
  f.store.db.prepare('INSERT INTO desktop_completions(thread_id,turn_id,completed_at,title,status,owner_key,rollout_path,project_root) VALUES(?,?,?,?,?,?,?,?)').run(oldThread,oldTurn,f.now-500,'older synthetic','completed',f.owner,path.join(f.root,'older-synthetic.jsonl'),f.cwd);
  ensureReference(f.store,f.config,'D',oldThread+':'+oldTurn,{owner:f.owner,scope:{project_key:'synthetic-project',project_name:'合成项目'},at:f.now-500});
  const before=f.store.db.prepare('SELECT * FROM desktop_completions ORDER BY thread_id').all(),outboxBefore=f.store.db.prepare('SELECT id,status FROM outbox ORDER BY id').all(),referencesBefore=f.store.db.prepare('SELECT * FROM number_references ORDER BY entity_key').all();
  const readTurn=(_home,_file,turn)=>{attempts.set(turn,(attempts.get(turn)||0)+1);if(turn!==rows[20].turn)throw Error('SYNTHETIC_CONTEXT_UNAVAILABLE');return {prompt:'生成本轮报告。',final:'synthetic result',cwd:f.cwd,startedAt:f.now-100,completedAt:f.now};};
  const makeObserver=()=>{const observer=new FileObserver(f.store,f.config,{readTurn});observer.native={read:row=>readTurn(null,null,row.turn_id)};return observer;};
  await makeObserver().refresh(f.now);
  assert.equal([...attempts.values()].reduce((sum,n)=>sum+n,0),20);assert.equal(attempts.has(rows[20].turn),false);
  assert.equal(attempts.has(oldTurn),false);assert.equal(f.config.desktopNotifications.since,f.now-1000);
  f.reopen();const observer=makeObserver();await observer.refresh(f.now+1);
  assert.equal(attempts.get(rows[20].turn),1);assert.ok(f.store.db.prepare('SELECT * FROM file_batches WHERE source_key=?').get('D:'+rows[20].thread+':'+rows[20].turn));
  await observer.refresh(f.now+2);assert.equal([...attempts.values()].reduce((sum,n)=>sum+n,0),21);assert.equal(f.store.get('fileDeliveryHealth').retryDeferred,20);
  await observer.refresh(f.now+1001);assert.equal(attempts.get(rows[0].turn),2);assert.equal(attempts.get(rows[20].turn),1);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM desktop_completions ORDER BY thread_id').all(),before);assert.deepEqual(f.store.db.prepare('SELECT id,status FROM outbox ORDER BY id').all(),outboxBefore);assert.deepEqual(f.store.db.prepare('SELECT * FROM number_references ORDER BY entity_key').all(),referencesBefore);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM file_transfers').get().n,0);assert.equal(attempts.has(oldTurn),false);assert.equal(f.store.db.prepare('SELECT * FROM file_batches WHERE source_key=?').get('D:'+oldThread+':'+oldTurn),undefined);
 }finally{f.close();}
});

test('file-context retries stay bounded and are isolated by owner scope without storing raw errors',()=>{
 const f=fixture(1);try{
  const observer=new FileObserver(f.store,f.config,{readTurn:async()=>{throw Error('unused');}}),scope=observer.scanScope(f.owner,f.now-1000),key='D:synthetic';
  for(let i=0;i<20;i++)observer.fail(scope,key,Error('raw command must not be persisted'),f.now);
  const retry=f.store.get(observer.retryKey(scope,key));assert.equal(retry.attempts,10);assert.equal(retry.nextAt-f.now,300000);assert.equal(retry.error,'FILE_CONTEXT_UNAVAILABLE');assert.equal(observer.deferred(scope,key,f.now+1),true);
  assert.notEqual(scope,observer.scanScope('another-owner',f.now-1000));assert.equal(observer.deferred(observer.scanScope('another-owner',f.now-1000),key,f.now+1),false);assert.equal(observer.deferred(scope,key,f.now-1),false);
 }finally{f.close();}
});
