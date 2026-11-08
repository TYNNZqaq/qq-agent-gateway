import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../packages/application/store.mjs';
import {DesktopQuestions} from '../packages/application/desktop-questions.mjs';

function fixture({global=true}={}){
 assert.ok(process.env.QQ_TEST_ROOT,'QQ_TEST_ROOT must identify the independent test directory');
 const root=fs.mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'team-native-question-sources-')),home=path.join(root,'native'),priorCwd=path.join(root,'prior-workspace'),cwd=path.join(root,'current-workspace'),stateDir=path.join(root,'business');
 for(const directory of [path.join(home,'sessions'),cwd,stateDir])fs.mkdirSync(directory,{recursive:true});
 const now=Date.now(),threadId=randomUUID(),turnId=randomUUID(),file=path.join(home,'sessions','rollout-synthetic-'+threadId+'.jsonl'),meta={type:'session_meta',payload:{id:threadId,source:'vscode',originator:'Codex Desktop',cwd:priorCwd,cli_version:'0.166.0-alpha.6'}};
 const config={instanceId:randomUUID(),hostId:randomUUID(),runtimeRoot:root,stateDir,policyVersion:3,projects:{},binding:{botId:randomUUID(),agentId:randomUUID(),bindingId:randomUUID(),bindingVersion:1},qq:{appId:'12345',minimumSendIntervalMs:0,passiveWindowSeconds:300,maxPassiveReplies:4,allowProactive:true},desktopNotifications:{enabled:global,scope:'all-local',home,since:now-5000},nativeDesktopQuestions:{enabled:true,home,since:now-5000}};
 const frames=[meta,{timestamp:new Date(now-1000).toISOString(),type:'event_msg',payload:{type:'task_started',turn_id:turnId,root_turn_id:turnId}},{timestamp:new Date(now).toISOString(),type:'response_item',payload:{type:'function_call',name:'request_user_input_async',call_id:'synthetic-migrated-question',arguments:JSON.stringify({questions:[{id:'choice',title:'synthetic migrated question',options:['one','two']}]})}}];
 fs.writeFileSync(file,frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n');
 const index=new DatabaseSync(path.join(home,'state_5.sqlite'));
 index.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,source TEXT,originator TEXT,cwd TEXT,cli_version TEXT,title TEXT,updated_at INTEGER)');
 index.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(threadId,file,'vscode','Codex Desktop',cwd,meta.payload.cli_version,'synthetic migrated native thread',Math.floor(now/1000));
 const owner=JSON.stringify(['12345','c2c','synthetic-person']),store=new Store(stateDir,{numberingConfig:config});store.set('owner',owner);store.ingest({appId:'12345',scope:'c2c',sender:'synthetic-person',target:'synthetic-person',id:randomUUID(),sentAt:now},()=>({}));
 return {root,home,cwd,priorCwd,threadId,turnId,file,frames,index,config,store,observer:()=>new DesktopQuestions(store,config,{now:()=>now}),rewriteMeta(change){frames[0]={...meta,payload:{...meta.payload,...change}};fs.writeFileSync(file,frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n');},rows:()=>store.db.prepare('SELECT * FROM desktop_questions').all(),close(){store.close();index.close();}};
}

test('all-local Q observation uses the verified read-only migration context while keeping native-card writeback disabled',()=>{
 const f=fixture();try{
  const observer=f.observer();observer.refresh();observer.refresh();const rows=f.rows();
  assert.equal(rows.length,1);assert.equal(rows[0].thread_id,f.threadId);assert.equal(rows[0].turn_id,f.turnId);assert.equal(rows[0].remote_supported,0);assert.equal(f.store.outbox().length,1);assert.match(f.store.outbox()[0].content,/synthetic migrated question/);
  const data=f.store.get('nativeClientQuestion:'+rows[0].id);assert.equal(data.identity.source.cwd,f.cwd);assert.equal(observer.snapshot().error,null);assert.equal(observer.snapshot().qqAnswerSubmission,false);assert.equal(fs.existsSync(f.priorCwd),false);
 }finally{f.close();}
});

test('legacy Q observation still rejects a transcript whose original cwd differs from the current index',()=>{
 const f=fixture({global:false});try{
  const observer=f.observer();observer.refresh();assert.equal(f.rows().length,0);assert.equal(f.store.outbox().length,0);assert.equal(observer.snapshot().error,'DESKTOP_SOURCE_MISMATCH');assert.deepEqual(observer.snapshot().errors,[{threadId:f.threadId,error:'DESKTOP_SOURCE_MISMATCH'}]);
 }finally{f.close();}
});

for(const [field,value]of [['id',()=>randomUUID()],['source',()=> 'cli'],['originator',()=> 'foreign-originator']])test('all-local native question metadata '+field+' mismatch creates no Q and remains explicit in catalog diagnostics',()=>{
 const f=fixture();try{
  f.rewriteMeta({[field]:value()});const observer=f.observer();observer.refresh();assert.equal(f.rows().length,0);assert.equal(f.store.outbox().length,0);assert.equal(observer.snapshot().error,'DESKTOP_SOURCE_MISMATCH');assert.ok(observer.snapshot().errors.some(error=>error.threadId===f.threadId&&error.error==='DESKTOP_SOURCE_MISMATCH'));
 }finally{f.close();}
});

test('all-local question migration support does not accept an unreviewed source protocol version',()=>{
 const f=fixture();try{
  const cli_version='future-unreviewed';f.rewriteMeta({cli_version});f.index.prepare('UPDATE threads SET cli_version=? WHERE id=?').run(cli_version,f.threadId);const observer=f.observer();observer.refresh();assert.equal(f.rows().length,0);assert.equal(f.store.outbox().length,0);assert.equal(observer.snapshot().error,'DESKTOP_PROTOCOL_UNVERIFIED');assert.ok(observer.snapshot().errors.some(error=>error.threadId===f.threadId&&error.error==='DESKTOP_PROTOCOL_UNVERIFIED'));
 }finally{f.close();}
});

test('all-local question migration support keeps transcript paths outside the native history tree rejected',()=>{
 const f=fixture();try{
  const outside=path.join(f.root,path.basename(f.file));fs.copyFileSync(f.file,outside);f.index.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(outside,f.threadId);const observer=f.observer();observer.refresh();assert.equal(f.rows().length,0);assert.equal(f.store.outbox().length,0);assert.equal(observer.snapshot().error,'DESKTOP_TRANSCRIPT_REFERENCE_INVALID');assert.ok(observer.snapshot().errors.some(error=>error.threadId===f.threadId&&error.error==='DESKTOP_TRANSCRIPT_REFERENCE_INVALID'));
 }finally{f.close();}
});
