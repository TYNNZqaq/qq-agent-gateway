import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fixture as eventFixture, gate } from './fixtures/host-event-fixture.mjs';
import { testScope } from './foundation-fixtures.mjs';
import { OfflineCancellation } from '../packages/host-control/offline-cancellation.mjs';
import { OfflineDispatchHost } from '../packages/host-control/offline-dispatch-host.mjs';
import { cancellationTarget, cancellationReceipt } from '../packages/core/cancel-contracts.mjs';

const fixture=t=>eventFixture(t,{cancellations:true});
const cancel=(f,r,key='cancel-1')=>f.host(r.name).cancel(r.scope,f.target(r),key);
const recover=(f,r,key='cancel-1')=>f.host(r.name).recoverCancel(r.scope,f.target(r),key);
const reconcile=(f,r,key='cancel-1')=>f.host(r.name).reconcileCancel(r.scope,f.target(r),key);
const status=(f,r,key='cancel-1')=>f.host(r.name).cancelStatus(r.scope,f.target(r),key);
const serverTerminal=(f,r,value='interrupted')=>{f.servers.get(r.name).turns.find(turn=>turn.id===r.turnId).status=value;};
function mutate(f,r,mutation){
  if(mutation==='revoke')f.store.revokePairing(r.scope);
  if(mutation==='expire')f.now=200000;
  if(mutation==='stop')f.store.stopBot(r.scope.botId);
  if(mutation==='globalStop')f.store.stop(r.scope.hostId);
  if(mutation==='rePair')f.store.grantPairing(r.scope,{expiresAt:100000});
  if(['unbind','rebind','policy'].includes(mutation)){
    const config=structuredClone(f.config);config.revision++;
    if(mutation==='unbind'){config.bindings[0].enabled=false;config.bots[0].enabled=false;}
    if(mutation==='rebind')config.bindings[0].version++;
    if(mutation==='policy'){config.policies[0].version++;for(const b of config.bindings)b.version++;}
    f.store.installConfiguration(config);
  }
}

test('Host cancellation persists original intent before interrupt; empty response is requested until applied terminal confirmation',async t=>{
  const f=fixture(t),r=await f.start(),target=f.target(r),session=f.store.session(r.scope),lease=f.store.requirePairing(r.scope);
  f.request=async frame=>{if(frame.method==='turn/interrupt'){
    const context=f.store.cancellationContext(r.scope,target,'cancel-1');assert.ok(context.intent);assert.equal(context.run.state,'cancelling');
    assert.equal(f.storageFor().cancelJournal.load().records[0].phase,'requesting');
    assert.deepEqual(frame.params,{threadId:r.threadId,turnId:r.turnId});
  }};
  const result=await cancel(f,r);assert.equal(result.state,'requested');assert.equal(result.requestAccepted,true);assert.equal(result.confirmed,false);assert.equal(result.terminal,null);
  assert.equal(f.count('turn/interrupt'),1);assert.equal(f.count('turn/start'),1);assert.equal(f.count('thread/start'),1);
  assert.equal((await cancel(f,r)).duplicate,true);assert.equal(f.count('turn/interrupt'),1);
  assert.equal((await f.receive(r,'interrupted')).applied,true);assert.equal(status(f,r).confirmed,false);
  assert.equal(recover(f,r).state,'confirmed');assert.equal(status(f,r).terminal,'cancelled');assert.equal((await cancel(f,r)).confirmed,true);
  assert.deepEqual(f.store.session(r.scope),session);assert.deepEqual(f.store.requirePairing(r.scope),lease);
  assert.equal(f.storageFor().journal.load().schemaVersion,2);assert.equal(f.storageFor().cancelJournal.load().schemaVersion,1);
  assert.equal(f.storageFor().adapterJournal.load().schemaVersion,1);
});

test('Host cancellation targets initial and multiple continued Runs without replacing Task, Session, original lease or prior history',async t=>{
  const f=fixture(t);let r=await f.start();const original={...r},session=f.store.session(r.scope).id,lease=f.target(r).leaseId;
  for(let attempt=1;attempt<=3;attempt++){
    assert.equal((await cancel(f,r,'cancel-'+attempt)).state,'requested');await f.receive(r,'interrupted');assert.equal(recover(f,r,'cancel-'+attempt).confirmed,true);
    if(attempt<3){r=await f.continue(r);assert.equal(r.taskId,original.taskId);assert.equal(r.attempt,attempt+1);assert.equal(f.target(r).leaseId,lease);assert.equal(f.store.session(r.scope).id,session);}
  }
  assert.equal(f.count('turn/interrupt'),3);assert.equal(f.count('turn/start'),3);assert.equal(f.count('thread/start'),1);
  const current=f.store.task(r.scope,r.taskId).current_run_id;assert.equal(status(f,original).confirmed,true);assert.equal(f.store.task(r.scope,r.taskId).current_run_id,current);
  assert.equal(f.storageFor().cancelJournal.load().records.length,3);
});

test('Host cancellation duplicate intent and conflicting keys never issue a second interrupt',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);
  assert.throws(()=>cancel(f,r,'different-key'),{code:'HOST_CANCEL_INTENT_CONFLICT'});
  await f.receive(r,'interrupted');recover(f,r);const next=await f.continue(r);
  assert.throws(()=>cancel(f,next),{code:'HOST_CANCEL_INTENT_CONFLICT'});assert.equal(f.store.run(next.scope,next.runId).state,'running');
  assert.equal(f.count('turn/interrupt'),1);
});

for(const [key,value] of Object.entries({taskId:'foreign-task',runId:'foreign-run',attempt:99,kind:'chat',leaseId:'replacement-lease',externalRef:'foreign-ref'}))
  test('Host cancellation rejects mismatched original target '+key,async t=>{
    const f=fixture(t),r=await f.start();assert.throws(()=>f.host().cancel(r.scope,{...f.target(r),[key]:value},'bad-key'));
    assert.equal(f.storageFor().cancelJournal.load().records.length,0);assert.equal(f.count('turn/interrupt'),0);assert.equal(f.store.run(r.scope,r.runId).state,'running');
  });

test('Host cancellation rejects foreign scope, unowned correlated Run and absent optional configuration',async t=>{
  const f=fixture(t),r=await f.start();assert.throws(()=>f.host().cancel(testScope('b'),f.target(r),'foreign-key'),{code:'HOST_CANCEL_SCOPE_MISMATCH'});
  const task=f.coordinator.accept(r.scope,{eventId:'unowned',operation:'new',kind:'work',text:'synthetic'}),run=f.store.beginRun(r.scope,task.taskId,{dispatchKey:'unowned-dispatch'});f.store.recordSubmission(r.scope,run.id,'unowned-ref');
  assert.throws(()=>f.host().cancel(r.scope,{...f.target(r),taskId:task.taskId,runId:run.id,externalRef:'unowned-ref'},'unowned-key'),{code:'HOST_CANCEL_OWNED_RUN_REQUIRED'});
  const plain=eventFixture(t),other=await plain.start();assert.throws(()=>plain.host().cancel(other.scope,plain.target(other),'not-enabled'),{code:'HOST_CANCEL_NOT_CONFIGURED'});assert.equal(f.count('turn/interrupt'),0);
});

test('Host bridges an existing InputCoordinator cancel intention and persistent ordinary cancel survives Run recovery',async t=>{
  const f=fixture(t),r=await f.start();const input={eventId:'local-cancel',operation:'cancel',taskId:r.taskId,runId:r.runId,attempt:r.attempt,kind:r.kind};
  assert.equal(f.coordinator.accept(r.scope,input).state,'cancelling');assert.equal(f.coordinator.accept(r.scope,input).duplicate,true);assert.equal(f.count('turn/interrupt'),0);
  assert.equal((await cancel(f,r)).state,'requested');f.store.recover(r.scope);
  assert.throws(()=>f.store.reconcileRun(r.scope,r.runId,{state:'running',dispatchKey:r.dispatchKey,externalRef:r.externalRef}),{code:'CANCELLATION_RECONCILIATION_REQUIRED'});
  assert.equal((await reconcile(f,r)).state,'unknown');assert.equal(f.store.run(r.scope,r.runId).state,'reconciling');assert.equal(f.count('turn/interrupt'),1);
});

test('Host cancellation unknown acknowledgement never resends and exact running reconciliation cannot confirm acceptance or revive Run',async t=>{
  const f=fixture(t),r=await f.start();f.request=async frame=>{if(frame.method==='turn/interrupt')throw Error('synthetic lost acknowledgement');};
  assert.equal((await cancel(f,r)).state,'unknown');assert.equal((await cancel(f,r)).requestAccepted,null);assert.equal(f.count('turn/interrupt'),1);
  assert.equal((await reconcile(f,r)).confirmed,false);assert.equal(status(f,r).requestAccepted,null);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
  serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(status(f,r).requestAccepted,null);assert.equal(f.count('turn/interrupt'),1);
});

for(const response of [null,{unexpected:true}])test('Host cancellation malformed empty-response contract stays unknown '+JSON.stringify(response),async t=>{
  const f=fixture(t),r=await f.start();f.request=async frame=>frame.method==='turn/interrupt'?response:undefined;
  assert.equal((await cancel(f,r)).state,'unknown');await cancel(f,r);assert.equal(f.count('turn/interrupt'),1);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
});

for(const state of ['completed','failed','interrupted'])test('Host cancellation explicit exact reconciliation reports real terminal '+state,async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);serverTerminal(f,r,state);const result=await reconcile(f,r);
  assert.equal(result.state,state==='interrupted'?'confirmed':state==='completed'?'succeeded':'failed');assert.equal(result.confirmed,state==='interrupted');
  assert.equal(f.store.run(r.scope,r.runId).state,result.terminal);assert.equal(f.count('turn/start'),1);assert.equal(f.count('turn/interrupt'),1);
});

for(const state of ['completed','failed','interrupted'])test('Host cancellation terminal winning before request sends no interrupt '+state,async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r,state);const result=await cancel(f,r);
  assert.equal(result.confirmed,state==='interrupted');assert.equal(result.terminal,state==='completed'?'succeeded':state==='failed'?'failed':'cancelled');assert.equal(f.count('turn/interrupt'),0);
});

for(const phase of ['prepare','response'])test('Host cancellation terminal event wins '+phase+' race without false cancellation',async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();
  const pause=async frame=>{if(frame.method==='turn/interrupt'){entered.resolve();await release.promise;}};
  if(phase==='prepare')f.prepare=pause;else f.request=pause;
  const pending=cancel(f,r);await entered.promise;assert.equal((await f.receive(r,'completed')).applied,true);release.resolve();
  const result=await pending;assert.equal(result.state,'succeeded');assert.equal(result.confirmed,false);assert.equal(f.count('turn/interrupt'),phase==='prepare'?0:1);
});

for(const operation of ['correct','answer'])test('Host cancellation invalidates '+operation+' during Adapter prepare without waiting on its input scheduler', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();
  if(operation==='answer')await f.receive(r,'question');
  const batch=f.queue(r,operation,operation==='answer'?{questionId:'question-1',questionSeq:1}:{});
  f.prepare=async frame=>{if(frame.method==='turn/steer'||frame.result){entered.resolve();await release.promise;}};
  f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;
  assert.equal((await cancel(f,r)).state,'requested');release.resolve();assert.equal((await pending).state,'unknown');
  assert.equal(f.count('turn/steer'),0);assert.equal(f.responses.length,0);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
});

test('Host cancellation racing an already accepted ordinary answer cannot consume input or clear cancellation',async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();await f.receive(r,'question');
  f.respond=async()=>{entered.resolve();await release.promise;};const batch=f.queue(r,'answer',{questionId:'question-1',questionSeq:1});f.now+=250;
  const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;await cancel(f,r);release.resolve();assert.equal((await pending).state,'unknown');
  assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'unknown');assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');assert.equal(f.responses.length,1);
});

test('Host cancelling cannot be revived by normal question, progress, approval, started or input-only recovery',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);
  for(const [seq,type] of [[1,'progress'],[2,'question'],[3,'started'],[4,'approval']]){const e=await f.receive(r,type,seq);assert.equal(e.state,'confirmed');assert.equal(e.applied,false);assert.equal(status(f,r).confirmed,false);}
  assert.throws(()=>f.queue(r));assert.equal(f.responses.length,0);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
});

test('Host cancellation while waiting approval sends only interrupt and never provides a tool response',async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r,'approval');assert.throws(()=>f.queue(r,'correct',{text:'同意'}));
  assert.equal((await cancel(f,r)).state,'requested');assert.equal(f.responses.length,0);assert.equal(f.count('turn/steer'),0);
  assert.equal((await f.receive(r,'interrupted',2)).applied,true);assert.equal(recover(f,r).confirmed,true);
});

for(const mutation of ['revoke','expire','stop','globalStop','rePair','unbind','rebind','policy'])test('Host original-Run revocation capability after '+mutation+' cancels without restoring permission',async t=>{
  const f=fixture(t),r=await f.start(),target=f.target(r);mutate(f,r,mutation);
  const result=await cancel(f,r);assert.equal(result.state,'requested');assert.equal(result.runState,'unknown');assert.equal(f.count('turn/interrupt'),1);
  assert.throws(()=>f.queue(r));const e=await f.receive(r,'interrupted');assert.equal(e.applied,false);assert.equal(recover(f,r).confirmed,false);
  serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.target(r).leaseId,target.leaseId);assert.throws(()=>f.queue(r));
  assert.equal(f.count('turn/start'),1);assert.equal(f.responses.length,0);
});

for(const phase of ['prepare','response'])test('Host stop during cancel '+phase+' keeps only the original-Run cancellation channel',async t=>{
  const f=fixture(t),r=await f.start();let once=true;
  const stop=async frame=>{if(once&&frame.method==='turn/interrupt'){once=false;f.store.stopBot(r.scope.botId);}};
  if(phase==='prepare')f.prepare=stop;else f.request=stop;
  const report=await cancel(f,r);assert.equal(report.requestAccepted,true);assert.equal(report.runState,'unknown');
  assert.equal(f.checks.filter(c=>c.request.controlOperation==='cancel'&&c.decision).length,2);assert.throws(()=>f.queue(r));
});

test('Host cancellation authority cannot authorize direct ordinary input, event application, submit or a changed target',async t=>{
  const f=fixture(t),r=await f.start();let denied;
  f.prepare=async frame=>{if(frame.method==='turn/interrupt'){
    const adapter=f.adapters.get('a'),sessionRef=f.storageFor().journal.load().sessions[0].sessionRef;
    denied=adapter.sendInput(sessionRef,{scope:r.scope,...f.target(r),operation:'correct',text:'synthetic forbidden',questionId:null,questionSeq:0,executionApproved:false},'not-a-claim');
  }};
  await cancel(f,r);await assert.rejects(denied);assert.equal(f.count('turn/steer'),0);assert.equal(f.responses.length,0);
  const request=f.checks.find(c=>c.request.controlOperation==='cancel').request;
  assert.equal(request.executionApproved,false);assert.equal((await f.receive(r,'started')).applied,false);
});

for(const point of ['after-cancel-intent','before-cancel-send','after-cancel-adapter','after-cancel-host-receipt'])test('Host cancellation fault '+point+' never resends or infers missing request acceptance',async t=>{
  const f=fixture(t),r=await f.start();let once=true;f.hostFault=p=>{if(once&&p===point){once=false;throw Error('synthetic cancel gap');}};
  assert.equal((await cancel(f,r)).state,'unknown');const sent=f.count('turn/interrupt');await cancel(f,r);recover(f,r);assert.equal(f.count('turn/interrupt'),sent);
  assert.equal(sent,['after-cancel-adapter','after-cancel-host-receipt'].includes(point)?1:0);
  if(point==='after-cancel-adapter')assert.equal(status(f,r).requestAccepted,null);
  assert.equal((await reconcile(f,r)).confirmed,false);serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.count('turn/interrupt'),sent);
});

test('Host cancellation Store-intent to Host-intent gap reconstructs unknown without dispatch',async t=>{
  const f=fixture(t),r=await f.start();f.hostFault=p=>{if(p==='after-cancel-store-intent')throw Error('synthetic pre-Host gap');};
  assert.throws(()=>cancel(f,r));assert.equal(f.storageFor().cancelJournal.load().records.length,0);assert.ok(f.store.cancellationContext(r.scope,f.target(r),'cancel-1').intent);
  f.hostFault=()=>{};assert.equal((await cancel(f,r)).state,'unknown');assert.equal(f.count('turn/interrupt'),0);serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);
});

test('Host cancellation intent transaction rollback is a known local rejection and sends nothing',async t=>{
  const f=fixture(t),r=await f.start();f.storeFault=p=>{if(p==='before-cancel-intent-commit')throw Error('synthetic rollback');};
  assert.throws(()=>cancel(f,r));assert.equal(f.store.run(r.scope,r.runId).state,'running');assert.equal(f.store.cancellationContext(r.scope,f.target(r),'cancel-1').intent,null);assert.equal(f.count('turn/interrupt'),0);
  f.storeFault=()=>{};assert.equal((await cancel(f,r)).state,'requested');assert.equal(f.count('turn/interrupt'),1);
});

for(const point of ['after-cancel-reconciliation','after-cancel-terminal-receipt','before-cancel-store-terminal','after-cancel-store-terminal','before-cancel-confirmation'])test('Host cancellation terminal fault '+point+' closes only verified durable boundaries',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);serverTerminal(f,r);let once=true;
  f.hostFault=p=>{if(once&&p===point){once=false;throw Error('synthetic terminal gap');}};
  assert.equal((await reconcile(f,r)).state,'unknown');f.hostFault=()=>{};
  const count=f.calls.length,result=recover(f,r);assert.equal(f.calls.length,count);
  if(point==='after-cancel-reconciliation')assert.equal(result.state,'unknown');else assert.equal(result.confirmed,true);
  assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.count('turn/interrupt'),1);
});

test('Host cancellation terminal Store rollback retains exact Host terminal receipt for local recovery',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);serverTerminal(f,r);
  f.storeFault=p=>{if(p==='before-cancel-terminal-commit')throw Error('synthetic terminal rollback');};assert.equal((await reconcile(f,r)).state,'unknown');assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
  f.storeFault=()=>{};const calls=f.calls.length;assert.equal(recover(f,r).confirmed,true);assert.equal(f.calls.length,calls);
});

for(const stage of ['before-commit','after-commit'])test('Host cancellation journal '+stage+' failure fences object and reopens actual revision without sending',async t=>{
  const f=fixture(t),r=await f.start();f.cancelJournalFault=p=>{if(p===stage)throw Error('synthetic cancel journal fault');};
  assert.throws(()=>cancel(f,r),{code:'HOST_CANCEL_JOURNAL_UNAVAILABLE'});assert.throws(()=>status(f,r),{code:'HOST_CANCEL_UNAVAILABLE'});assert.equal(f.count('turn/interrupt'),0);
  f.cancelJournalFault=()=>{};const calls=f.calls.length;f.makeHost();assert.equal(f.calls.length,calls);await cancel(f,r);assert.equal(f.count('turn/interrupt'),0);
  serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.count('turn/start'),1);
});

test('Host cancellation restart preserves request receipt, never sends implicitly and fences old Host',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);const old=f.host(),calls=f.calls.length;f.store.recover(r.scope);f.makeHost();
  assert.equal(f.calls.length,calls);assert.equal(recover(f,r).requestAccepted,true);assert.equal(f.calls.length,calls);assert.throws(()=>old.cancelStatus(r.scope,f.target(r),'cancel-1'),{code:'HOST_CANCEL_JOURNAL_FENCED'});
  await cancel(f,r);assert.equal(f.count('turn/interrupt'),1);assert.equal((await reconcile(f,r)).confirmed,false);assert.equal(f.store.run(r.scope,r.runId).state,'reconciling');
  serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.count('turn/interrupt'),1);
});

test('Host cancellation Adapter persistence failure cannot become accepted receipt or cancellation confirmation',async t=>{
  const f=fixture(t),r=await f.start();f.request=async frame=>{if(frame.method==='turn/interrupt')f.adapterJournalFault=p=>{if(p==='before-commit')throw Error('synthetic adapter persistence fault');};};
  assert.equal((await cancel(f,r)).state,'unknown');assert.equal(status(f,r).requestAccepted,null);assert.equal(f.count('turn/interrupt'),1);
  f.adapterJournalFault=()=>{};f.request=async()=>{};f.makeHost();await cancel(f,r);serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.count('turn/interrupt'),1);
});

for(const key of ['externalRef','dispatchKey','requestAccepted'])test('Host cancellation rejects malformed or mismatched public receipt '+key,async t=>{
  const f=fixture(t),r=await f.start();f.cancelReceipt=result=>({...result,[key]:key==='requestAccepted'?'yes':'foreign-value'});
  assert.equal((await cancel(f,r)).state,'unknown');assert.equal(status(f,r).requestAccepted,null);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
});

test('Host cancellation public cancel receipt claiming terminal is not a substitute for normalized event or exact reconciliation',async t=>{
  const f=fixture(t),r=await f.start();f.cancelReceipt=result=>({...result,state:'cancelled',confirmed:true});
  assert.equal((await cancel(f,r)).confirmed,false);assert.equal(recover(f,r).confirmed,false);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
});

test('Host cancellation instance journal failure and close leave another instance and shared input scheduler live',async t=>{
  const f=fixture(t),a=await f.start(),b=await f.start('b');f.cancelJournalFault=(p,name)=>{if(name==='a'&&p==='before-commit')throw Error('synthetic instance failure');};
  assert.throws(()=>cancel(f,a));assert.equal((await cancel(f,b)).state,'requested');await f.host().close();assert.equal(await f.scheduler.submit(b.scope,'still-owned',()=>42),42);
  serverTerminal(f,b);assert.equal((await reconcile(f,b)).confirmed,true);assert.equal(f.count('turn/interrupt','a'),0);assert.equal(f.count('turn/interrupt','b'),1);
});

test('Host cancellation schema stays WorkStore v3 and no running reconciliation overwrites durable cancellation marker',async t=>{
  const f=fixture(t),r=await f.start();f.store.requestCancel(r.scope,r.runId);f.store.recover(r.scope);
  assert.throws(()=>f.store.reconcileRun(r.scope,r.runId,{state:'running',dispatchKey:r.dispatchKey,externalRef:r.externalRef}),{code:'CANCELLATION_RECONCILIATION_REQUIRED'});
  const db=new DatabaseSync(path.join(f.directory,'work.sqlite'));assert.equal(db.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'3');assert.equal(db.prepare("SELECT COUNT(*) n FROM work_actions WHERE type='cancel_requested'").get().n,1);db.close();
});

function controller(t){
  let saved=null;const rows=new Map(),s=testScope(),agent={id:s.agentId,adapterId:'synthetic',modelRef:'synthetic-model'};
  const journal={load:()=>structuredClone(saved),commit:(value,expected)=>{if((saved?.revision??0)!==expected)return false;saved=structuredClone(value);return true;}};
  const f={s,agent,journal,sends:0,prepare:async()=>{},target:i=>({taskId:'task-'+i,runId:'run-'+i,attempt:1,kind:'work',leaseId:'original-lease',externalRef:'ref-'+i})};
  const store={requestHostCancellation:(_,target,key)=>{const intent={id:'intent-'+target.runId,key,target,sessionId:'owned-session',dispatchKey:'dispatch-'+target.runId};rows.set(target.runId,{intent,run:{state:'cancelling'}});return {...intent,created:true};},cancellationContext:(_,target)=>rows.get(target.runId)};
  const options={hostId:s.hostId,agent,store,journal,resolveTarget:(_,target)=>({sessionId:'owned-session',sessionRef:'owned-ref',dispatchKey:'dispatch-'+target.runId}),prepareSource:async(_,target)=>{await f.prepare();return {cancel:async()=>{f.sends++;return {state:'cancelling',externalRef:target.externalRef,dispatchKey:'dispatch-'+target.runId,requested:true,confirmed:false,requestAccepted:true};}};}};
  f.instance=new OfflineCancellation(options);f.options=options;t.after(()=>f.instance.close());return f;
}

test('Host cancellation capacity retains all 128 original records and rejects new work before Store intent',async t=>{
  const f=controller(t);for(let i=1;i<=128;i++)assert.equal((await f.instance.request(f.s,f.target(i),'key-'+i)).state,'requested');
  assert.throws(()=>f.instance.request(f.s,f.target(129),'key-129'),{code:'HOST_CANCEL_CAPACITY'});assert.equal(f.sends,128);assert.equal(f.journal.load().records.length,128);assert.equal((await f.instance.request(f.s,f.target(1),'key-1')).duplicate,true);
});

test('Host cancellation queue is serial and bounded at 32 waiting without reusing the input scheduler', {timeout:5000},async t=>{
  const f=controller(t),entered=gate(),release=gate();f.prepare=async()=>{entered.resolve();await release.promise;};
  const first=f.instance.request(f.s,f.target(1),'key-1');await entered.promise;const queued=[];
  for(let i=2;i<=33;i++)queued.push(f.instance.request(f.s,f.target(i),'key-'+i));
  assert.throws(()=>f.instance.request(f.s,f.target(34),'key-34'),{code:'SCHEDULER_QUEUE_FULL'});assert.equal(f.sends,0);release.resolve();await first;await Promise.all(queued);assert.equal(f.sends,33);
  assert.equal((await f.instance.request(f.s,f.target(34),'key-34')).state,'unknown');assert.equal(f.sends,33);
});

test('Host cancellation snapshots reject future formats, Agent/model drift and duplicate Run history',()=>{
  const fake={load:()=>null,commit:()=>true};
  for(const saved of [{schemaVersion:9},{schemaVersion:1,revision:1,owner:{hostId:'host-test',agentId:'agent-a'},agent:{id:'agent-a',adapterId:'synthetic',modelRef:'changed'},records:[]}]){
    const journal={...fake,load:()=>saved};assert.throws(()=>new OfflineCancellation({hostId:'host-test',agent:{id:'agent-a',adapterId:'synthetic',modelRef:'model'},store:{},journal,resolveTarget:()=>{},prepareSource:()=>{}}));
  }
});

test('Host cancellation common target and receipt contracts reject unknown fields, approval and incomplete correlation',()=>{
  const t={taskId:'task',runId:'run',attempt:1,kind:'work',leaseId:'lease',externalRef:'ref'};assert.deepEqual(cancellationTarget(t),t);
  for(const value of [{...t,executionApproved:true},{...t,externalRef:null},{...t,attempt:0}])assert.throws(()=>cancellationTarget(value));
  const receipt={state:'cancelling',externalRef:'ref',dispatchKey:'dispatch',requested:true,confirmed:false,requestAccepted:true};assert.deepEqual(cancellationReceipt(receipt),receipt);
  for(const value of [{...receipt,externalRef:null},{...receipt,confirmed:true},{...receipt,requestAccepted:'yes'},{...receipt,requested:false}])assert.throws(()=>cancellationReceipt(value));
});

test('Host cancellation supports a full-length key without expanding scheduler identifiers',async t=>{
  const f=fixture(t),r=await f.start(),key='k'.repeat(128);assert.equal((await cancel(f,r,key)).state,'requested');serverTerminal(f,r);assert.equal((await reconcile(f,r,key)).confirmed,true);
});

for(const stage of ['before','after'])test('Host cancellation journal fencing '+stage+' Adapter acceptance prevents a late request or Store confirmation', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();const pause=async frame=>{if(frame.method==='turn/interrupt'){entered.resolve();await release.promise;}};
  if(stage==='before')f.prepare=pause;else f.request=pause;
  const pending=cancel(f,r);await entered.promise;const journal=f.storageFor().cancelJournal,saved=journal.load(),previous=saved.revision;saved.revision++;assert.equal(journal.commit(saved,previous),true);
  release.resolve();await assert.rejects(pending,{code:'HOST_CANCEL_UNAVAILABLE'});assert.equal(f.count('turn/interrupt'),stage==='before'?0:1);
  f.makeHost();assert.equal(status(f,r).requestAccepted,null);serverTerminal(f,r);assert.equal((await reconcile(f,r)).confirmed,true);assert.equal(f.count('turn/interrupt'),stage==='before'?0:1);
});

test('Host cancellation local recovery while a request is preparing revokes that request rather than replaying it', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();f.prepare=async frame=>{if(frame.method==='turn/interrupt'){entered.resolve();await release.promise;}};
  const pending=cancel(f,r);await entered.promise;assert.equal(recover(f,r).state,'unknown');release.resolve();assert.equal((await pending).state,'unknown');assert.equal(f.count('turn/interrupt'),0);
  await cancel(f,r);assert.equal(f.count('turn/interrupt'),0);
});

test('Host cancellation permission is exact, transient and cannot confer ordinary input or approval authority',async t=>{
  const f=fixture(t),r=await f.start();let inspected=false;
  f.prepare=async frame=>{if(frame.method==='turn/interrupt'){
    const authorize=f.authorizers.get('a'),request={scope:r.scope,...f.target(r),executionApproved:false,phase:'before',controlOperation:'cancel',operation:'cancel'};
    assert.equal(authorize(request),true);
    for(const changed of [{executionApproved:true},{externalRef:'foreign'},{leaseId:'replacement'},{runId:'foreign-run'},{controlOperation:'submit'},{text:'approve'},{event:{}}])assert.equal(authorize({...request,...changed}),false);
    const ordinary={...request};delete ordinary.controlOperation;ordinary.operation='ordinary-answer';assert.equal(authorize(ordinary),false);inspected=true;
  }};
  await cancel(f,r);assert.equal(inspected,true);assert.equal(f.authorizers.get('a')({scope:r.scope,...f.target(r),executionApproved:false,phase:'before',controlOperation:'cancel'}),false);
});

for(const mutation of ['missing','duplicate','foreign'])test('Host cancellation explicit reconciliation with '+mutation+' correlated turn remains unknown',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);
  const turns=f.servers.get('a').turns;if(mutation==='missing')turns.length=0;if(mutation==='duplicate')turns.push(structuredClone(turns[0]));if(mutation==='foreign')turns[0].id='foreign-turn';
  assert.equal((await reconcile(f,r)).state,'unknown');assert.equal(status(f,r).requestAccepted,true);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');assert.equal(f.count('turn/interrupt'),1);
});

test('Host cancellation cannot repair a missing Store reference; original Run reconciliation is separate',async t=>{
  const f=fixture(t),s=testScope();f.storeFault=p=>{if(p==='before-submission-commit')throw Error('synthetic missing Store reference');};
  const task=f.coordinator.accept(s,{eventId:'missing-reference',operation:'new',kind:'work',text:'synthetic'}),report=await f.host().dispatch(s,task.taskId),r={...report,scope:s,name:'a',kind:'work',threadId:'thread-1',turnId:'turn-1'};
  assert.equal(report.state,'unknown');assert.equal(f.store.run(s,r.runId).external_ref,null);assert.throws(()=>cancel(f,r),{code:'HOST_CANCEL_RECONCILIATION_REQUIRED'});
  f.storeFault=()=>{};assert.equal((await f.host().reconcile(s,r.taskId)).state,'running');assert.equal((await cancel(f,r)).state,'requested');assert.equal(f.count('turn/start'),1);
});

test('Host cancellation Store terminal winning a conflicting read remains the true terminal and is never relabelled cancelled',async t=>{
  const f=fixture(t),r=await f.start();await cancel(f,r);serverTerminal(f,r);
  f.request=async frame=>{if(frame.method==='thread/read')assert.equal((await f.receive(r,'completed')).applied,true);};
  f.reconcileReceipt=report=>({...report,state:'cancelled'});
  const result=await reconcile(f,r);assert.equal(result.state,'succeeded');assert.equal(result.confirmed,false);assert.equal(result.reason,'STORE_TERMINAL_PRESERVED');assert.equal(recover(f,r).terminal,'succeeded');
});

test('Host cancellation duplicate Run snapshot fails closed on actual persisted history',async t=>{
  const f=controller(t);await f.instance.request(f.s,f.target(1),'key-1');const saved=f.journal.load();saved.records.push(structuredClone(saved.records[0]));
  assert.throws(()=>new OfflineCancellation({...f.options,journal:{load:()=>saved,commit:()=>true}}),{code:'HOST_CANCEL_JOURNAL_MISMATCH'});
});

test('Host cancellation an older uncorrelated Adapter receipt stays unknown without reading private operations',async t=>{
  const f=fixture(t),r=await f.start();f.cancelReceipt=report=>({state:report.state,requested:true,confirmed:false,operationState:'accepted'});
  assert.equal((await cancel(f,r)).state,'unknown');assert.equal(status(f,r).requestAccepted,null);assert.equal((await cancel(f,r)).state,'unknown');assert.equal(f.count('turn/interrupt'),1);
});

test('Host cancellation uses common eight-method Adapter with generic control tags and no Runtime protocol branch',async t=>{
  const f=fixture(t),s=testScope(),journals=f.storageFor(),agent=f.config.agents[0],calls=[];
  const host=new OfflineDispatchHost({store:f.store,hostId:s.hostId,agent:{id:agent.id,adapterId:agent.adapterId,modelRef:agent.modelRef},configuration:f.config,journal:journals.journal,adapterJournal:journals.adapterJournal,cancellations:{journal:journals.cancelJournal},
    prepareAdapter:async({authorize})=>({probe:async()=>({synthetic:true}),openSession:async(_,request)=>({sessionRef:'generic-session',state:'open'}),
      submit:async(_,request,key)=>{assert.equal(authorize(request),true);return {state:'running',externalRef:'generic-original-ref',dispatchKey:key};},
      sendInput:async()=>assert.fail('unexpected generic input'),events:()=>[],close:async()=>{},
      cancel:async(ref,request,key)=>{assert.equal(ref,'generic-session');assert.equal(authorize({...request,phase:'before',operation:'generic-interrupt',controlOperation:'cancel',executionApproved:false}),true);calls.push(key);return {state:'cancelling',requested:true,confirmed:false,requestAccepted:true,externalRef:request.externalRef,dispatchKey:'initial-'+request.taskId};},
      reconcile:async(ref,request)=>{assert.equal(authorize({...request,phase:'before',operation:'generic-query',controlOperation:'reconcile',executionApproved:false}),true);return {state:'cancelled',externalRef:request.externalRef,dispatchKey:'initial-'+request.taskId};}})});
  t.after(()=>host.close());const task=f.store.acceptInbound(s,{eventId:'generic-task',kind:'work',text:'synthetic generic work'}),report=await host.dispatch(s,task.taskId);
  const target={taskId:task.taskId,runId:report.runId,attempt:report.attempt,kind:'work',leaseId:f.store.requirePairing(s).id,externalRef:report.externalRef};
  assert.equal((await host.cancel(s,target,'generic-cancel')).state,'requested');assert.equal((await host.reconcileCancel(s,target,'generic-cancel')).confirmed,true);assert.deepEqual(calls,['generic-cancel']);
});
