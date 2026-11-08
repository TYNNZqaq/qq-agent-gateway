import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { InputCoordinator } from '../packages/host-control/input-coordinator.mjs';
import { SessionScheduler } from '../packages/core/session-scheduler.mjs';
import { inputLimits, normalizeInput, textBytes } from '../packages/core/input-contracts.mjs';
import { configuration, testScope, inbound, event } from './foundation-fixtures.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const database=()=>path.join(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'inputs-')),'business.sqlite');
function fixture(t,options={}){
  let now=1000;const clock=()=>now;
  const store=new WorkStore(options.database??':memory:',{hostId:'host-test',clock,fault:options.fault});
  store.installConfiguration(configuration());
  for(const name of ['a','b'])store.grantPairing(testScope(name),{expiresAt:100000});
  const received=[];
  const coordinator=new InputCoordinator({store,limits:options.limits,scheduler:options.scheduler,prepareDispatch:options.prepareDispatch??(async()=>request=>{
    received.push(request);return {receiptRef:'receipt-'+request.batchId,externalRef:request.mode==='submit'?'continued-'+request.batchId:request.externalRef};
  })});
  t.after(()=>{coordinator.close();store.close();});
  return {store,coordinator,received,clock,setTime:value=>{now=value;},advance:(amount=250)=>{now+=amount;}};
}
function running(f,id='one',s=testScope(),kind='work'){
  const task=f.store.acceptInbound(s,{...inbound('task-'+id),kind});
  const run=f.store.beginRun(s,task.taskId,{dispatchKey:'dispatch-'+id});
  f.store.recordSubmission(s,run.id,'external-'+id);
  return {taskId:task.taskId,runId:run.id,attempt:run.attempt,kind,scope:s,dispatchKey:run.dispatch_key};
}
const command=(target,eventId='fragment-1',operation='continue',text='synthetic fragment')=>({eventId,operation,kind:target.kind,taskId:target.taskId,runId:target.runId,attempt:target.attempt,...(operation==='cancel'?{}:{text})});
const post=(f,target,eventId,operation,text)=>f.coordinator.accept(target.scope,command(target,eventId,operation,text));
const emit=(f,target,seq,type,data={})=>f.store.recordEvent(target.scope,target.runId,event(seq,type,data,target.dispatchKey));
const answer=(target,eventId,questionId='question-1',questionSeq=1)=>({...command(target,eventId,'answer','yes'),questionId,questionSeq});

test('input intent rejects routing/approval fields and uses UTF8 fragment and configuration limits',()=>{
  const input={eventId:'new-1',operation:'new',kind:'work',text:'synthetic'};
  for(const key of ['scope','projectId','bindingVersion','pairingId','approved'])assert.throws(()=>normalizeInput({...input,[key]:'from body'}),{code:'INVALID_FIELDS'});
  assert.throws(()=>normalizeInput({...input,text:'光'.repeat(3000)}),{code:'INPUT_FRAGMENT_TOO_LARGE'});
  assert.throws(()=>inputLimits({windowMs:10001}),{code:'INPUT_LIMIT_TOO_LARGE'});
  assert.throws(()=>inputLimits({maxPending:Infinity}));
});

test('new input creates one persistent Task, conflicts cannot rewrite it, and identical Bot event IDs are isolated',t=>{
  const f=fixture(t),input={eventId:'new',operation:'new',kind:'work',text:'projectId in body is ordinary text'};
  const a=f.coordinator.accept(testScope(),input),again=f.coordinator.accept(testScope(),input),b=f.coordinator.accept(testScope('b'),input);
  assert.equal(a.state,'queued');assert.equal(again.duplicate,true);assert.equal(again.taskId,a.taskId);assert.notEqual(a.taskId,b.taskId);
  assert.throws(()=>f.coordinator.accept(testScope(),{...input,text:'rewritten'}),{code:'INPUT_EVENT_CONFLICT'});
  assert.equal(f.store.task(testScope(),a.taskId).goal,input.text);assert.equal(f.received.length,0);
});

test('fixed merge window preserves ordered fragments and dispatches exactly once after its deadline',async t=>{
  const f=fixture(t),target=running(f),first=post(f,target,'part-1','continue','first');f.advance(200);
  const second=post(f,target,'part-2','continue','second');assert.equal(second.batchId,first.batchId);assert.equal(second.closesAt,first.closesAt);
  assert.equal((await f.coordinator.flush(target.scope,first.batchId)).state,'collecting');assert.equal(f.received.length,0);
  f.advance(50);const result=await f.coordinator.flush(target.scope,first.batchId);
  assert.equal(result.state,'consumed');assert.equal(result.fragmentCount,2);assert.equal(result.byteCount,textBytes('first\nsecond'));
  assert.equal(f.received[0].text,'first\nsecond');assert.deepEqual(f.received[0].fragments.map(x=>x.eventId),['part-1','part-2']);
  assert.ok(Object.isFrozen(f.received[0].fragments));await f.coordinator.flush(target.scope,first.batchId);assert.equal(f.received.length,1);
  assert.equal(post(f,target,'part-1','continue','first').state,'consumed');
});

test('merge boundaries include Task, Bot, Principal, conversation, kind and input category',t=>{
  const f=fixture(t),a=running(f),otherTask=running(f,'two'),b=running(f,'b',testScope('b'));
  const member=testScope('a',{principalId:'member-two'}),conversation=testScope('a',{conversationId:'other-conversation'});
  for(const s of [member,conversation])f.store.grantPairing(s,{expiresAt:100000});
  const otherMember=running(f,'member',member),otherConversation=running(f,'conversation',conversation),chat=running(f,'chat',testScope(),'chat');
  const batches=[post(f,a,'same'),post(f,otherTask,'two'),post(f,b,'same'),post(f,otherMember,'member'),post(f,otherConversation,'conversation'),post(f,chat,'chat'),post(f,a,'correct','correct')];
  assert.equal(new Set(batches.map(x=>x.batchId)).size,batches.length);
  assert.equal(batches.at(-1).operation,'correct');assert.equal(f.store.inputRecord(a.scope,'correct').text,'synthetic fragment');
});

test('every scope dimension and Task/Run/attempt/kind must match, even with valid IDs',t=>{
  const f=fixture(t),target=running(f),batch=post(f,target,'owned');
  for(const key of Object.keys(target.scope)){
    const wrong={...target.scope,[key]:key.endsWith('Version')?2:'wrong'};
    assert.throws(()=>f.store.inputBatch(wrong,batch.batchId));assert.throws(()=>f.coordinator.accept(wrong,command(target,'wrong-'+key)));
  }
  assert.throws(()=>f.coordinator.accept(target.scope,{...command(target,'attempt'),attempt:2}),{code:'STALE_INPUT_RUN'});
  assert.throws(()=>f.coordinator.accept(target.scope,{...command(target,'kind'),kind:'chat'}),{code:'INPUT_KIND_MISMATCH'});
});

for(const state of ['succeeded','failed','cancelled'])test('continuing a '+state+' Task creates a separate Run and keeps its history',async t=>{
  const f=fixture(t),target=running(f);
  emit(f,target,1,'run.'+state,state==='succeeded'?{summary:'done'}:state==='failed'?{code:'FAILED'}:{});
  const batch=post(f,target,'continue-terminal');f.advance();const result=await f.coordinator.flush(target.scope,batch.batchId);
  assert.equal(result.state,'consumed');assert.equal(f.received[0].mode,'submit');assert.equal(f.received[0].attempt,2);
  assert.notEqual(result.deliveryRunId,target.runId);assert.equal(f.store.task(target.scope,target.taskId).current_run_id,result.deliveryRunId);
  assert.equal(f.store.run(target.scope,target.runId).state,state);assert.equal(f.store.run(target.scope,result.deliveryRunId).state,'running');
  assert.throws(()=>post(f,target,'late-old-run'),{code:'STALE_INPUT_RUN'});
});

test('a terminal event invalidates queued steering and a retry cannot inherit its fragments',async t=>{
  const f=fixture(t),target=running(f),batch=post(f,target,'steer');
  emit(f,target,1,'run.failed',{code:'FAILED'});assert.equal(f.store.inputBatch(target.scope,batch.batchId).state,'invalidated');
  f.store.beginRun(target.scope,target.taskId,{dispatchKey:'retry',retry:true});f.advance();
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'invalidated');assert.equal(f.received.length,0);
});

test('fragment counts and UTF8 bytes are bounded without consuming a rejected event ID',t=>{
  const f=fixture(t,{limits:{maxFragments:2,maxBytes:7}}),target=running(f),first=post(f,target,'one','continue','光');
  post(f,target,'two','continue','光');assert.equal(f.store.inputBatch(target.scope,first.batchId).byteCount,7);
  assert.throws(()=>post(f,target,'three','continue','x'),{code:'INPUT_BATCH_FULL'});
  assert.throws(()=>f.store.inputRecord(target.scope,'three'),{code:'SCOPED_NOT_FOUND'});
  f.advance();assert.notEqual(post(f,target,'three','continue','x').batchId,first.batchId);
});

test('per-scope and per-Bot queues reject growth while another Bot remains usable',t=>{
  const f=fixture(t,{limits:{maxPendingPerScope:1,maxPendingPerBot:1}}),a=running(f),b=running(f,'b',testScope('b'));
  post(f,a,'first');assert.throws(()=>post(f,a,'another','correct'),{code:'INPUT_QUEUE_FULL'});
  const member=testScope('a',{principalId:'second-member'});f.store.grantPairing(member,{expiresAt:100000});const other=running(f,'other',member);
  assert.throws(()=>post(f,other,'member'),{code:'INPUT_QUEUE_FULL'});assert.equal(post(f,b,'first').state,'collecting');
});

test('the host-wide pending limit includes new queued Tasks and unknown batches',async t=>{
  const f=fixture(t,{limits:{maxPending:1},prepareDispatch:async()=>()=>{throw Error('unconfirmed');}}),a=running(f),b=running(f,'b',testScope('b'));
  const batch=post(f,a,'one');f.advance();assert.equal((await f.coordinator.flush(a.scope,batch.batchId)).state,'unknown');
  assert.throws(()=>post(f,b,'two'),{code:'INPUT_QUEUE_FULL'});
  const g=fixture(t,{limits:{maxPending:1}}),input={eventId:'one',operation:'new',kind:'chat',text:'new task'};
  g.coordinator.accept(testScope(),input);assert.throws(()=>g.coordinator.accept(testScope('b'),{...input,eventId:'two'}),{code:'INPUT_QUEUE_FULL'});
});

test('SessionScheduler bounds its waiting queue and releases reservations after completion',async()=>{
  const scheduler=new SessionScheduler({maxConcurrent:1,maxQueued:1}),blocked=gate();
  const active=scheduler.submit(testScope(),'active',()=>blocked.promise),queued=scheduler.submit(testScope(),'queued',()=>42);
  assert.throws(()=>scheduler.submit(testScope('b'),'overflow',()=>0),{code:'SCHEDULER_QUEUE_FULL'});
  blocked.resolve();await active;assert.equal(await queued,42);scheduler.close();
});

test('expired windows create separate ordered batches; later batches cannot overtake an earlier one',async t=>{
  const f=fixture(t),target=running(f),first=post(f,target,'one');f.advance();const second=post(f,target,'two');f.advance();
  assert.notEqual(first.batchId,second.batchId);
  await assert.rejects(f.coordinator.flush(target.scope,second.batchId),{code:'INPUT_ORDER_BLOCKED'});
  await f.coordinator.flush(target.scope,first.batchId);await f.coordinator.flush(target.scope,second.batchId);
  assert.deepEqual(f.received.map(x=>x.fragments[0].eventId),['one','two']);
});

test('input, merged batch counters and shared inbox roll back atomically after an injected failure',t=>{
  let fail=false;const f=fixture(t,{fault:point=>{if(fail&&point==='after-input-before-inbox')throw Error('synthetic crash');}}),target=running(f),first=post(f,target,'one');
  fail=true;assert.throws(()=>post(f,target,'two'),/synthetic crash/);assert.equal(f.store.inputBatch(target.scope,first.batchId).fragmentCount,1);
  fail=false;assert.equal(post(f,target,'two').fragmentCount,2);assert.equal(post(f,target,'two').duplicate,true);
});

test('revocation and re-pairing persist across reopen and never revive old batches or Task authorization',async t=>{
  const db=database(),f=fixture(t,{database:db}),target=running(f),batch=post(f,target,'one');f.store.revokePairing(target.scope);
  const reopened=new WorkStore(db,{hostId:'host-test',clock:f.clock});t.after(()=>reopened.close());
  reopened.grantPairing(target.scope,{expiresAt:100000});f.advance();
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'invalidated');assert.equal(f.received.length,0);
  assert.throws(()=>post(f,target,'new-pair'),{code:'TASK_AUTHORIZATION_REVOKED'});
});

test('observed expiry invalidates fragments permanently through a backward clock jump',async t=>{
  const f=fixture(t),target=running(f),batch=post(f,target,'one');f.setTime(100000);
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'invalidated');f.setTime(1000);
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'invalidated');assert.equal(f.received.length,0);
});

test('a callback waiting in the Session queue checks authorization when it actually starts',async t=>{
  const scheduler=new SessionScheduler(),blocked=gate(),f=fixture(t,{scheduler}),target=running(f),batch=post(f,target,'one');f.advance();
  const blocker=scheduler.submit(target.scope,'blocker',()=>blocked.promise),pending=f.coordinator.flush(target.scope,batch.batchId);
  f.store.revokePairing(target.scope);blocked.resolve();await blocker;assert.equal((await pending).state,'invalidated');assert.equal(f.received.length,0);
});

for(const change of ['revoke','expire','stopBot','stopHost','binding','project','policy'])test(change+' during asynchronous preparation prevents receiver acceptance',async t=>{
  const entered=gate(),release=gate();let accepted=0;
  const f=fixture(t,{prepareDispatch:async()=>{entered.resolve();await release.promise;return ()=>{accepted++;return {receiptRef:'receipt'};};}}),target=running(f),batch=post(f,target,'one');f.advance();
  const pending=f.coordinator.flush(target.scope,batch.batchId);await entered.promise;
  if(change==='revoke')f.store.revokePairing(target.scope);
  if(change==='expire')f.setTime(100000);
  if(change==='stopBot')f.store.stopBot('bot-a');
  if(change==='stopHost')f.store.stop('host-test');
  if(['binding','project','policy'].includes(change)){
    const next=configuration();next.revision=2;next.bindings[0].version=2;
    if(change==='project')next.agents[0].workspaceRef='project-y';
    if(change==='policy'){next.policies[0].version=2;next.bindings[1].version=2;}
    f.store.installConfiguration(next);
  }
  release.resolve();assert.equal((await pending).state,'unknown');assert.equal(accepted,0);
  if(change==='stopBot'){f.store.resumeBot('bot-a');f.store.grantPairing(target.scope,{expiresAt:100000});assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'unknown');}
});

test('cancel is an idempotent request, invalidates prepared input, and does not report confirmed cancellation',async t=>{
  const entered=gate(),release=gate();let accepted=0;
  const f=fixture(t,{prepareDispatch:async()=>{entered.resolve();await release.promise;return ()=>{accepted++;return {receiptRef:'receipt'};};}}),target=running(f),batch=post(f,target,'one');f.advance();
  const pending=f.coordinator.flush(target.scope,batch.batchId);await entered.promise;
  const cancel=post(f,target,'cancel','cancel');assert.equal(cancel.state,'cancelling');assert.equal(cancel.requested,true);assert.equal(post(f,target,'cancel','cancel').duplicate,true);
  assert.throws(()=>post(f,target,'cancel','continue','changed intent'),{code:'INPUT_EVENT_CONFLICT'});
  release.resolve();assert.equal((await pending).state,'unknown');assert.equal(accepted,0);assert.equal(f.store.run(target.scope,target.runId).state,'cancelling');
});

test('ordinary answers match the current question ID and sequence, consume once, and never approve execution',async t=>{
  const f=fixture(t),target=running(f);emit(f,target,1,'run.waiting_input',{questionId:'question-1',prompt:'ordinary question'});
  for(const override of [{questionId:'wrong'},{questionSeq:2}])assert.throws(()=>f.coordinator.accept(target.scope,{...answer(target,'wrong'),...override}),{code:'STALE_INPUT_QUESTION'});
  const batch=f.coordinator.accept(target.scope,answer(target,'answer'));f.advance();assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'consumed');
  assert.equal(f.received[0].executionApproved,false);assert.equal(f.received[0].questionId,'question-1');assert.equal(f.store.run(target.scope,target.runId).state,'running');
  assert.throws(()=>f.coordinator.accept(target.scope,answer(target,'second')),{code:'NOT_WAITING_FOR_ORDINARY_INPUT'});
});

test('a newer question with the same ID invalidates an older answer batch',async t=>{
  const f=fixture(t),target=running(f);emit(f,target,1,'run.waiting_input',{questionId:'question-1',prompt:'first'});
  const batch=f.coordinator.accept(target.scope,answer(target,'old'));emit(f,target,2,'run.waiting_input',{questionId:'question-1',prompt:'new question'});f.advance();
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'invalidated');assert.equal(f.received.length,0);
  assert.throws(()=>f.store.answerInput(target.scope,target.runId,'stale',{questionId:'question-1',questionSeq:1}),{code:'STALE_INPUT_QUESTION'});
  assert.equal(f.coordinator.accept(target.scope,answer(target,'new','question-1',2)).state,'collecting');
});

test('waiting_approval rejects answers, guidance and correction text without clearing approval',async t=>{
  const f=fixture(t),target=running(f),batch=post(f,target,'correction','correct','yes');
  emit(f,target,1,'run.waiting_approval',{requestId:'approval',actionFingerprint:'fingerprint'});f.advance();
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'invalidated');
  for(const operation of ['continue','correct'])assert.throws(()=>post(f,target,operation,operation,'yes'),{code:'INPUT_RUN_NOT_RUNNING'});
  assert.throws(()=>f.coordinator.accept(target.scope,answer(target,'answer')),{code:'NOT_WAITING_FOR_ORDINARY_INPUT'});
  assert.equal(f.store.run(target.scope,target.runId).state,'waiting_approval');assert.equal(f.received.length,0);
});

test('a late receipt after stop is retained for reconciliation and cannot revive the input or Run',async t=>{
  const accepted=gate(),receipt=gate();const f=fixture(t,{prepareDispatch:async()=>async()=>{accepted.resolve();return receipt.promise;}}),target=running(f),batch=post(f,target,'one');f.advance();
  const pending=f.coordinator.flush(target.scope,batch.batchId);await accepted.promise;f.store.stopBot('bot-a');receipt.resolve({receiptRef:'late-receipt'});
  const result=await pending;assert.equal(result.state,'unknown');assert.equal(result.receipt.receiptRef,'late-receipt');assert.equal(f.store.run(target.scope,target.runId).state,'unknown');
});

test('restart after a durable dispatch claim never resubmits unknown input and requires explicit reconciliation',async t=>{
  const db=database(),f=fixture(t,{database:db}),target=running(f),batch=post(f,target,'one');f.advance();const claimed=f.store.claimInput(target.scope,batch.batchId);assert.ok(claimed.request);
  const store=new WorkStore(db,{hostId:'host-test',clock:f.clock});t.after(()=>store.close());store.recover(target.scope);
  assert.equal(store.inputBatch(target.scope,batch.batchId).state,'unknown');assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'unknown');assert.equal(f.received.length,0);
  assert.throws(()=>store.reconcileInput(target.scope,batch.batchId,{state:'consumed',inputKey:'wrong',receiptRef:'known'}),{code:'INPUT_RECONCILIATION_MISMATCH'});
  assert.throws(()=>store.reconcileInput(target.scope,batch.batchId,{state:'consumed',inputKey:claimed.request.inputKey,receiptRef:null}),{code:'RECEIPT_REQUIRED'});
  store.reconcileInput(target.scope,batch.batchId,{state:'consumed',inputKey:claimed.request.inputKey,receiptRef:'host-verified'});
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'consumed');assert.equal(f.store.run(target.scope,target.runId).state,'reconciling');
});

test('one Bot unconfirmed acceptance does not block another Bot; unknown input is never automatically retried',async t=>{
  const calls=[];const f=fixture(t,{prepareDispatch:async()=>request=>{calls.push(request.scope.botId);if(request.scope.botId==='bot-a')throw Error('unconfirmed');return {receiptRef:'receipt'};}}),a=running(f),b=running(f,'b',testScope('b'));
  const first=post(f,a,'one'),second=post(f,b,'one');f.advance();assert.equal((await f.coordinator.flush(a.scope,first.batchId)).state,'unknown');assert.equal((await f.coordinator.flush(b.scope,second.batchId)).state,'consumed');
  await f.coordinator.flush(a.scope,first.batchId);assert.deepEqual(calls,['bot-a','bot-b']);
  const later=post(f,a,'two');f.advance();await assert.rejects(f.coordinator.flush(a.scope,later.batchId),{code:'INPUT_ORDER_BLOCKED'});
  f.store.reconcileInput(a.scope,first.batchId,{state:'invalidated',inputKey:'input-'+first.batchId,receiptRef:null});
  assert.equal(f.store.inputBatch(a.scope,first.batchId).state,'invalidated');
});

test('invalid receipts and attempt tokens cannot claim consumption or replace external ownership',async t=>{
  const f=fixture(t,{prepareDispatch:async()=>()=>({receiptRef:'receipt',externalRef:'different-external'})}),target=running(f),batch=post(f,target,'one');f.advance();
  assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'unknown');assert.equal(f.store.run(target.scope,target.runId).external_ref,'external-one');
  assert.throws(()=>f.store.completeInput(target.scope,batch.batchId,{attemptToken:'wrong',receiptRef:'receipt'}),{code:'INPUT_ATTEMPT_MISMATCH'});
});

test('legacy inbox IDs cannot be reinterpreted as another Task input',t=>{
  const f=fixture(t),a=running(f,'a'),b=running(f,'b');const result=post(f,b,'task-a','correct');
  assert.equal(result.duplicate,true);assert.equal(result.taskId,a.taskId);assert.equal(f.received.length,0);
});

test('a failed claim transaction leaves a collecting batch and no independent continuation Run',async t=>{
  let fail=true;const f=fixture(t,{fault:point=>{if(point==='after-input-claim'&&fail)throw Error('claim crash');}}),target=running(f);emit(f,target,1,'run.succeeded',{summary:'done'});
  const batch=post(f,target,'continue');f.advance();await assert.rejects(f.coordinator.flush(target.scope,batch.batchId),/claim crash/);
  assert.equal(f.store.task(target.scope,target.taskId).current_run_id,target.runId);assert.equal(f.store.inputBatch(target.scope,batch.batchId).state,'collecting');
  fail=false;assert.equal((await f.coordinator.flush(target.scope,batch.batchId)).state,'consumed');assert.equal(f.received[0].attempt,2);
});

test('two independent coordinators cannot accept the same durable claim twice',async t=>{
  const entered=gate(),release=gate(),db=database();let accepted=0;
  const f=fixture(t,{database:db,prepareDispatch:async()=>{entered.resolve();await release.promise;return ()=>{accepted++;return {receiptRef:'receipt'};};}}),target=running(f),batch=post(f,target,'one');f.advance();
  const store=new WorkStore(db,{hostId:'host-test',clock:f.clock}),other=new InputCoordinator({store,prepareDispatch:async()=>()=>{accepted++;return {receiptRef:'duplicate'};}});
  t.after(()=>{other.close();store.close();});const first=f.coordinator.flush(target.scope,batch.batchId);await entered.promise;
  assert.equal((await other.flush(target.scope,batch.batchId)).state,'dispatching');release.resolve();assert.equal((await first).state,'consumed');assert.equal(accepted,1);
});

test('an approval request arriving during answer preparation prevents ordinary input acceptance',async t=>{
  const entered=gate(),release=gate();let accepted=0;
  const f=fixture(t,{prepareDispatch:async()=>{entered.resolve();await release.promise;return ()=>{accepted++;return {receiptRef:'receipt'};};}}),target=running(f);
  emit(f,target,1,'run.waiting_input',{questionId:'question-1',prompt:'question'});const batch=f.coordinator.accept(target.scope,answer(target,'answer'));f.advance();
  const pending=f.coordinator.flush(target.scope,batch.batchId);await entered.promise;emit(f,target,2,'run.waiting_approval',{requestId:'approval',actionFingerprint:'fingerprint'});
  release.resolve();assert.equal((await pending).state,'unknown');assert.equal(accepted,0);assert.equal(f.store.run(target.scope,target.runId).state,'waiting_approval');
});

test('an unconfirmed continuation submission immediately marks its new Run unknown',async t=>{
  const f=fixture(t,{prepareDispatch:async()=>()=>{throw Error('accepted then lost receipt');}}),target=running(f);emit(f,target,1,'run.succeeded',{summary:'done'});
  const batch=post(f,target,'next');f.advance();const result=await f.coordinator.flush(target.scope,batch.batchId);
  assert.equal(result.state,'unknown');assert.equal(f.store.run(target.scope,result.deliveryRunId).state,'unknown');assert.equal(f.store.task(target.scope,target.taskId).state,'unknown');
  assert.throws(()=>f.store.beginRun(target.scope,target.taskId,{dispatchKey:'must-not-retry',retry:true}),{code:'RUN_REQUIRES_RECONCILIATION'});
});

function previousV2(){
  const db=database(),raw=new DatabaseSync(db);raw.exec(readFileSync(new URL('./fixtures/work-store-v2.sql',import.meta.url),'utf8'));
  for(const [key,value] of [['schema','2'],['host','host-test'],['configuration_revision','0'],['stopped','0']])raw.prepare('INSERT INTO work_meta VALUES(?,?)').run(key,value);
  raw.close();return db;
}
test('V2 upgrade requires a new consistent snapshot and preserves its version for complete rollback',t=>{
  const db=previousV2(),before=readFileSync(db);assert.throws(()=>new WorkStore(db,{hostId:'host-test'}),{code:'WORK_SCHEMA_UPGRADE_BACKUP_REQUIRED'});assert.deepEqual(readFileSync(db),before);
  const backup=db+'.v2',store=new WorkStore(db,{hostId:'host-test',upgradeBackup:backup});t.after(()=>store.close());
  const raw=new DatabaseSync(backup);assert.equal(raw.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'2');assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='work_input_batches'").get(),undefined);raw.close();
  const current=new DatabaseSync(db);assert.equal(current.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'3');current.close();
  const restored=db+'.restored';copyFileSync(backup,restored);assert.throws(()=>new WorkStore(restored,{hostId:'host-test',upgradeBackup:backup}),{code:'EEXIST'});
});
test('failed V2 schema migration rolls back its new tables and retains the original snapshot',()=>{
  const db=previousV2(),backup=db+'.v2';assert.throws(()=>new WorkStore(db,{hostId:'host-test',upgradeBackup:backup,fault:point=>{if(point==='after-input-schema-migration')throw Error('migration crash');}}),/migration crash/);
  const raw=new DatabaseSync(db);assert.equal(raw.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'2');assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='work_inputs'").get(),undefined);raw.close();
});
