import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { configuration, testScope, inbound, event } from './foundation-fixtures.mjs';
import { digest, scopeKey } from '../packages/core/contracts.mjs';
import { activeBinding } from '../packages/core/configuration.mjs';

const open=(db=':memory:',options={})=>{const store=new WorkStore(db,{hostId:'host-test',...options});store.installConfiguration(configuration());
  // Only a new fixture receives initial host grants. Reopening must preserve
  // the original lease identity (or its revocation), never silently re-pair.
  if(db===':memory:'||options.initialPairing)for(const b of ['a','b'])store.grantPairing(testScope(b),{expiresAt:(options.clock?.()??Date.now())+3600000});return store;};
const start=(store,s=testScope(),id='event-1')=>{const t=store.acceptInbound(s,inbound(id));const run=store.beginRun(s,t.taskId,{dispatchKey:'dispatch-'+id});return {task:t,run};};
const running=(store,s=testScope(),id='event-1')=>{const result=start(store,s,id);store.recordSubmission(s,result.run.id,'upstream-'+id);return result;};
const file=()=>path.join(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'work-')),'business.sqlite');

test('transactional inbox de-duplicates within a bot and isolates identical platform IDs across bots',t=>{
  const store=open();t.after(()=>store.close());const a=store.acceptInbound(testScope(),inbound()),b=store.acceptInbound(testScope('b'),inbound());
  assert.notEqual(a.taskId,b.taskId);assert.notEqual(a.sessionId,b.sessionId);
  assert.deepEqual(store.acceptInbound(testScope(),inbound('event-1','replacement body')),{duplicate:true,taskId:a.taskId});
  assert.equal(store.task(testScope(),a.taskId).goal,'synthetic work');
});
test('inbox and task roll back together after an injected failure',t=>{
  let fail=true;const store=open(':memory:',{fault:point=>{if(point==='after-task-before-inbox'&&fail)throw Error('synthetic crash');}});t.after(()=>store.close());
  assert.throws(()=>store.acceptInbound(testScope(),inbound()));fail=false;
  const accepted=store.acceptInbound(testScope(),inbound());assert.equal(accepted.duplicate,false);assert.equal(accepted.number,1);
});
test('every ownership dimension is required for task reads and run updates',t=>{
  const store=open();t.after(()=>store.close());const s=testScope(),{task,run}=running(store);
  for(const key of Object.keys(s)){
    const wrong={...s,[key]:key.endsWith('Version')?2:'different'};
    assert.throws(()=>store.task(wrong,task.taskId));assert.throws(()=>store.recordEvent(wrong,run.id,event(1,'run.progress',{text:'wrong scope'})));
  }
  assert.equal(store.events(s,run.id).length,0);
});
test('work and chat keep distinct kinds within the same scoped session',t=>{
  const store=open();t.after(()=>store.close());const a=store.acceptInbound(testScope(),inbound()),b=store.acceptInbound(testScope(),{...inbound('chat-1'),kind:'chat'});
  assert.equal(a.sessionId,b.sessionId);assert.equal(store.task(testScope(),a.taskId).kind,'work');assert.equal(store.task(testScope(),b.taskId).kind,'chat');
});
test('submission is durable before an upstream call and external references cannot be changed',t=>{
  const store=open();t.after(()=>store.close());const {run}=start(store);
  assert.equal(store.run(testScope(),run.id).state,'dispatching');assert.equal(run.external_ref,null);
  const receipt=store.recordSubmission(testScope(),run.id,'upstream-a');assert.equal(receipt.state,'running');
  assert.equal(store.recordSubmission(testScope(),run.id,'upstream-a').state,'running');
  assert.throws(()=>store.recordSubmission(testScope(),run.id,'upstream-b'),{code:'SUBMISSION_REQUIRES_RECONCILIATION'});
});
for(const afterReceipt of [false,true])test('restart after submission '+(afterReceipt?'with':'without')+' persisted receipt requires reconciliation',t=>{
  const db=file();let store=open(db,{initialPairing:true});const {run,task}=start(store);
  if(afterReceipt)store.recordSubmission(testScope(),run.id,'upstream-a');store.close();store=open(db);t.after(()=>store.close());
  const recovery=store.recover(testScope());assert.equal(recovery.runs.length,1);assert.equal(recovery.automaticSubmissions,0);assert.equal(recovery.automaticSends,0);
  assert.equal(store.run(testScope(),run.id).state,'reconciling');
  store.reconcileRun(testScope(),run.id,{state:'unknown',dispatchKey:run.dispatch_key,externalRef:afterReceipt?'upstream-a':null});
  assert.equal(store.task(testScope(),task.taskId).state,'unknown');
  assert.throws(()=>store.beginRun(testScope(),task.taskId,{dispatchKey:'retry-unknown',retry:true}),{code:'RUN_REQUIRES_RECONCILIATION'});
});
test('reconciliation checks the dispatch key and registered external reference',t=>{
  const store=open();t.after(()=>store.close());const {run}=running(store);store.recover(testScope());
  assert.throws(()=>store.reconcileRun(testScope(),run.id,{state:'succeeded',dispatchKey:'wrong',externalRef:'upstream-event-1'}),{code:'RECONCILIATION_MISMATCH'});
  assert.throws(()=>store.reconcileRun(testScope(),run.id,{state:'succeeded',dispatchKey:run.dispatch_key,externalRef:'foreign-ref'}),{code:'EXTERNAL_REFERENCE_MISMATCH'});
  assert.equal(store.reconcileRun(testScope(),run.id,{state:'running',dispatchKey:run.dispatch_key,externalRef:'upstream-event-1'}).state,'running');
});
test('persistent events reject conflicting replays and retain late events without changing a terminal',t=>{
  const store=open();t.after(()=>store.close());const {run}=running(store),s=testScope(),done=event(3,'run.succeeded',{summary:'synthetic result'});
  assert.throws(()=>store.recordEvent(s,run.id,{...done,schemaVersion:2}),{code:'EVENT_SCHEMA_UNSUPPORTED'});
  assert.throws(()=>store.recordEvent(s,run.id,{...done,correlationId:'foreign-dispatch'}),{code:'EVENT_CORRELATION_MISMATCH'});
  assert.equal(store.recordEvent(s,run.id,done).applied,true);assert.equal(store.recordEvent(s,run.id,done).duplicate,true);
  assert.throws(()=>store.recordEvent(s,run.id,{...done,data:{summary:'different'}}),{code:'EVENT_CONFLICT'});
  assert.equal(store.recordEvent(s,run.id,event(2,'run.progress',{text:'late'})).applied,false);
  assert.equal(store.recordEvent(s,run.id,event(4,'run.failed',{code:'LATE_FAILURE'})).conflictingTerminal,true);
  assert.equal(store.run(s,run.id).state,'succeeded');const stored=store.events(s,run.id);assert.equal(stored.length,3);
  assert.deepEqual(stored[0].scope,s);assert.equal(stored[0].taskId,run.task_id);assert.equal(stored[0].schemaVersion,1);assert.ok(Date.parse(stored[0].receivedAt));
});
test('a retry keeps the Task ID, creates a new Run, and ignores the older Run terminal',t=>{
  const store=open();t.after(()=>store.close());const {task,run}=running(store),s=testScope();
  store.recordEvent(s,run.id,event(1,'run.failed',{code:'SYNTHETIC_FAILURE'}));
  const second=store.beginRun(s,task.taskId,{dispatchKey:'second-attempt',retry:true});assert.notEqual(second.id,run.id);assert.equal(second.attempt,2);
  store.recordSubmission(s,second.id,'second-upstream');
  assert.equal(store.recordEvent(s,run.id,event(2,'run.succeeded',{summary:'late old result'})).applied,false);
  assert.equal(store.task(s,task.taskId).current_run_id,second.id);assert.equal(store.task(s,task.taskId).state,'running');
});
test('cancel request remains cancelling until an actual terminal event arrives',t=>{
  const store=open();t.after(()=>store.close());const {run}=running(store),s=testScope();
  assert.deepEqual(store.requestCancel(s,run.id),{state:'cancelling',requested:true});
  assert.equal(store.recordEvent(s,run.id,event(1,'run.started')).applied,false);assert.equal(store.run(s,run.id).state,'cancelling');
  store.recordEvent(s,run.id,event(2,'run.cancelled'));assert.equal(store.run(s,run.id).state,'cancelled');
});
test('ordinary answers never approve a tool request or clear waiting_approval',t=>{
  const store=open();t.after(()=>store.close());const {run}=running(store),s=testScope();
  store.recordEvent(s,run.id,event(1,'run.waiting_input',{questionId:'q-1',prompt:'synthetic question'}));
  assert.equal(store.answerInput(s,run.id,'ordinary reply',{questionId:'q-1',questionSeq:1}).executionApproved,false);
  store.recordEvent(s,run.id,event(2,'run.waiting_approval',{requestId:'approval-1',actionFingerprint:'synthetic-fingerprint'}));
  assert.throws(()=>store.answerInput(s,run.id,'yes',{questionId:'q-1',questionSeq:1}),{code:'NOT_WAITING_FOR_ORDINARY_INPUT'});
  assert.equal(store.recordEvent(s,run.id,event(3,'run.started')).applied,false);assert.equal(store.run(s,run.id).state,'waiting_approval');
  assert.equal(store.recordEvent(s,run.id,event(4,'run.waiting_input',{questionId:'q-2',prompt:'bypass attempt'})).applied,false);
  assert.throws(()=>store.answerInput(s,run.id,'yes',{questionId:'q-1',questionSeq:1}),{code:'NOT_WAITING_FOR_ORDINARY_INPUT'});
});
test('a binding change invalidates old work, preserves history and cannot replay an old inbound ID',t=>{
  const store=open();t.after(()=>store.close());const {run,task}=running(store),s=testScope(),next=configuration();next.revision=2;next.bindings[0].version=2;
  store.installConfiguration(next);assert.equal(store.run(s,run.id).state,'unknown');
  assert.throws(()=>store.beginRun(s,task.taskId,{dispatchKey:'stale-new-run'}),{code:'STALE_BINDING_SCOPE'});
  const replacement={...s,bindingVersion:2};store.grantPairing(replacement,{expiresAt:Date.now()+3600000});assert.deepEqual(store.acceptInbound(replacement,inbound()),{duplicate:true,stale:true,taskId:null});
  assert.equal(store.recordEvent(s,run.id,event(1,'run.succeeded',{summary:'old binding'})).applied,false);
  assert.equal(store.acceptInbound(replacement,inbound('new-event')).duplicate,false);
});
test('project, policy and reconnect changes require a new binding version',t=>{
  const store=open();t.after(()=>store.close());const changed=configuration();changed.revision=2;changed.agents[0].workspaceRef='project-y';
  assert.throws(()=>store.installConfiguration(changed),{code:'BINDING_VERSION_REQUIRED'});
  const off=configuration();off.revision=2;off.bindings[0].enabled=false;off.bots[0].enabled=false;store.installConfiguration(off);
  const on=configuration();on.revision=3;assert.throws(()=>store.installConfiguration(on),{code:'BINDING_VERSION_REQUIRED'});
  on.bindings[0].version=2;assert.equal(store.installConfiguration(on).revision,3);
});
test('outbox distinguishes execution success, sending, receipt and unknown delivery',t=>{
  const store=open();t.after(()=>store.close());const {run}=running(store),s=testScope();
  assert.throws(()=>store.enqueueResult(s,run.id,'premature'),{code:'RUN_NOT_TERMINAL'});
  store.recordEvent(s,run.id,event(1,'run.succeeded',{summary:'result'}));
  const out=store.enqueueResult(s,run.id,'delivery body');assert.equal(store.outbox(s,out.id).state,'queued');assert.equal(store.enqueueResult(s,run.id,'delivery body').reused,true);
  assert.throws(()=>store.claimDelivery(testScope('b'),out.id));
  const attempt=store.claimDelivery(s,out.id);assert.equal(store.outbox(s,out.id).state,'sending');
  assert.throws(()=>store.recordDelivery(s,out.id,{state:'sent',attemptToken:attempt.attemptToken}),{code:'RECEIPT_REQUIRED'});
  store.recordDelivery(s,out.id,{state:'unknown',attemptToken:attempt.attemptToken});assert.equal(store.outbox(s,out.id).state,'unknown');
  assert.throws(()=>store.claimDelivery(s,out.id),{code:'OUTBOX_NOT_QUEUED'});
});
test('a sending crash becomes unknown after restart and a late acknowledgement cannot silently send again',t=>{
  const db=file();let store=open(db,{initialPairing:true});const {run}=running(store),s=testScope();store.recordEvent(s,run.id,event(1,'run.succeeded',{summary:'result'}));
  const out=store.enqueueResult(s,run.id,'body'),attempt=store.claimDelivery(s,out.id);store.close();store=open(db);t.after(()=>store.close());
  store.recover(s);assert.equal(store.outbox(s,out.id).state,'unknown');
  assert.throws(()=>store.recordDelivery(s,out.id,{state:'sent',attemptToken:attempt.attemptToken,receiptRef:'late-receipt'}),{code:'DELIVERY_REQUIRES_RECONCILIATION'});
  assert.throws(()=>store.claimDelivery(s,out.id),{code:'OUTBOX_NOT_QUEUED'});
});
test('a delivery receipt is required to mark sent',t=>{
  const store=open();t.after(()=>store.close());const {run}=running(store),s=testScope();store.recordEvent(s,run.id,event(1,'run.failed',{code:'SYNTHETIC'}));
  const out=store.enqueueResult(s,run.id,'failure summary'),attempt=store.claimDelivery(s,out.id);
  store.recordDelivery(s,out.id,{state:'sent',attemptToken:attempt.attemptToken,receiptRef:'synthetic-receipt'});
  assert.equal(store.outbox(s,out.id).receipt_ref,'synthetic-receipt');assert.equal(store.outbox(s,out.id).state,'sent');
});
test('persistent stop freezes pending output across reopen',t=>{
  const db=file();let store=open(db,{initialPairing:true});const {run}=running(store),s=testScope();store.recordEvent(s,run.id,event(1,'run.succeeded',{summary:'result'}));
  const out=store.enqueueResult(s,run.id,'body');store.stop('host-test');store.close();store=open(db);t.after(()=>store.close());
  assert.equal(store.outbox(s,out.id).state,'frozen');assert.throws(()=>store.claimDelivery(s,out.id),{code:'HOST_STOPPED'});
  assert.throws(()=>store.acceptInbound(s,inbound('after-stop')),{code:'HOST_STOPPED'});
});
test('foreign databases, host IDs and future schema versions fail without importing or altering their tables',()=>{
  const db=file();let foreign=new DatabaseSync(db);foreign.exec('CREATE TABLE foreign_table(value TEXT)');foreign.close();
  assert.throws(()=>new WorkStore(db,{hostId:'host-test'}),{code:'DATABASE_NOT_OWNED'});
  foreign=new DatabaseSync(db);assert.deepEqual(foreign.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['foreign_table']);foreign.close();
  const owned=file(),store=open(owned);store.close();
  assert.throws(()=>new WorkStore(owned,{hostId:'other-host'}),{code:'HOST_MISMATCH'});
  foreign=new DatabaseSync(owned);foreign.prepare("UPDATE work_meta SET value='999' WHERE key='schema'").run();foreign.close();
  assert.throws(()=>new WorkStore(owned,{hostId:'host-test'}),{code:'WORK_SCHEMA_UNSUPPORTED'});
});

function legacyV1(){
  const db=file(),raw=new DatabaseSync(db),config=configuration(),s=testScope(),key=scopeKey(s);
  raw.exec(readFileSync(new URL('./fixtures/work-store-v1.sql',import.meta.url),'utf8'));
  for(const [name,value] of [['schema','1'],['host','host-test'],['configuration_revision','1'],['configuration_digest',digest(JSON.stringify(config))],['stopped','0']])raw.prepare('INSERT INTO work_meta VALUES(?,?)').run(name,value);
  const {bot,agent,binding,policy}=activeBinding(config,'bot-a');
  const identity=digest(JSON.stringify({bot,agent,binding,policy,project:config.projects.find(p=>p.id===agent.workspaceRef)}));
  raw.prepare('INSERT INTO binding_heads VALUES(?,?,?,?,?,?,?,1)').run(bot.id,agent.id,binding.id,binding.version,agent.workspaceRef,policy.version,identity);
  raw.prepare('INSERT INTO work_sessions VALUES(?,?,?)').run('legacy-session',key,JSON.stringify(s));
  for(const [id,number] of [['legacy-queued',1],['legacy-running',2],['legacy-done',3]]){
    raw.prepare("INSERT INTO work_tasks VALUES(?,?,?,?,?,?,?,'queued',NULL,?)").run(id,'legacy-session',key,bot.id,number,'work','synthetic V1 goal','2026-01-01T00:00:00.000Z');
    raw.prepare('INSERT INTO work_inbox VALUES(?,?,?,?)').run(bot.id,id,key,id);
  }
  for(const [id,taskId,state] of [['legacy-run','legacy-running','running'],['legacy-terminal','legacy-done','succeeded']]){
    raw.prepare('INSERT INTO work_runs VALUES(?,?,?,?,?,?,?,0,1)').run(id,taskId,key,1,state,'dispatch-'+id,'ref-'+id);
    raw.prepare('UPDATE work_tasks SET state=?,current_run_id=? WHERE id=?').run(state,id,taskId);
  }
  raw.prepare("INSERT INTO work_outbox VALUES(?,?,?,?,'sending',?,NULL)").run('legacy-out',key,'legacy-terminal','synthetic V1 output','legacy-attempt');
  raw.close();return db;
}
test('V1 upgrade requires an exclusive snapshot, preserves history, and holds work with no pairing provenance',t=>{
  const db=legacyV1(),before=readFileSync(db);assert.throws(()=>new WorkStore(db,{hostId:'host-test'}),{code:'WORK_SCHEMA_UPGRADE_BACKUP_REQUIRED'});assert.deepEqual(readFileSync(db),before);
  const backup=db+'.v1-backup',store=new WorkStore(db,{hostId:'host-test',upgradeBackup:backup});t.after(()=>store.close());
  const old=new DatabaseSync(backup);assert.equal(old.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'1');assert.equal(old.prepare("SELECT state FROM work_tasks WHERE id='legacy-queued'").get().state,'queued');old.close();
  assert.equal(store.task(testScope(),'legacy-queued').state,'held');assert.equal(store.run(testScope(),'legacy-run').state,'unknown');assert.equal(store.outbox(testScope(),'legacy-out').state,'unknown');
  assert.equal(store.task(testScope(),'legacy-done').goal,'synthetic V1 goal');store.grantPairing(testScope(),{expiresAt:Date.now()+3600000});
  assert.throws(()=>store.beginRun(testScope(),'legacy-queued',{dispatchKey:'not-authorized'}),{code:'TASK_AUTHORIZATION_REVOKED'});
  // Rollback is a complete database copy; the original V1 snapshot stays intact.
  const restored=db+'.restored';copyFileSync(backup,restored);const raw=new DatabaseSync(restored);assert.equal(raw.prepare('SELECT COUNT(*) n FROM work_inbox').get().n,3);raw.close();
});
test('a failed V1 migration rolls back schema/data and retains the consistent backup',()=>{
  const db=legacyV1(),backup=db+'.backup';
  assert.throws(()=>new WorkStore(db,{hostId:'host-test',upgradeBackup:backup,fault:point=>{if(point==='after-v1-authorization-migration')throw Error('synthetic migration failure');}}),/synthetic migration failure/);
  const raw=new DatabaseSync(db);assert.equal(raw.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'1');assert.equal(raw.prepare("SELECT state FROM work_tasks WHERE id='legacy-queued'").get().state,'queued');
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='work_pairings'").get(),undefined);raw.close();
  assert.throws(()=>new WorkStore(db,{hostId:'host-test',upgradeBackup:backup}),{code:'EEXIST'});
});
test('revoked pairing state persists and cannot be bypassed through direct storage calls after reopen',t=>{
  const db=file();let store=open(db,{initialPairing:true});const s=testScope(),queued=store.acceptInbound(s,inbound());store.revokePairing(s);store.close();
  store=open(db);t.after(()=>store.close());assert.throws(()=>store.acceptInbound(s,inbound('unpaired')),{code:'PAIRING_REQUIRED'});
  assert.throws(()=>store.beginRun(s,queued.taskId,{dispatchKey:'revoked-reopen'}),{code:'PAIRING_REQUIRED'});
  store.grantPairing(s,{expiresAt:Date.now()+3600000});assert.throws(()=>store.beginRun(s,queued.taskId,{dispatchKey:'new-permission'}),{code:'TASK_AUTHORIZATION_REVOKED'});
});
test('an observed pairing expiry is permanent even if the clock later moves backwards',t=>{
  let now=1000;const store=open(':memory:',{clock:()=>now});t.after(()=>store.close());const s=testScope();
  store.grantPairing(s,{expiresAt:2000});const task=store.acceptInbound(s,inbound());now=2000;
  assert.throws(()=>store.beginRun(s,task.taskId,{dispatchKey:'at-expiry'}),{code:'PAIRING_REQUIRED'});now=1000;
  assert.throws(()=>store.beginRun(s,task.taskId,{dispatchKey:'clock-backwards'}),{code:'PAIRING_REQUIRED'});assert.equal(store.task(s,task.taskId).state,'held');
  assert.equal(store.acceptInbound(testScope('b'),inbound()).duplicate,false);
});
