import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { OfflineIngressRetention } from '../packages/host-control/offline-ingress-retention.mjs';
import { eventEnvelopeDigest } from '../packages/core/event-contracts.mjs';
import { testScope } from './foundation-fixtures.mjs';
import { fixture, gate } from './fixtures/host-event-fixture.mjs';

const setup=t=>fixture(t,{retention:true,cancellations:true});
const retain=(f,r,type='progress',seq=1,extra={})=>f.host(r.name).retainEvent(r.scope,f.target(r),f.envelope(r,type,seq,extra));
const deliver=(f,r,id='delivery-1')=>f.host(r.name).deliverRetainedEvent(r.scope,id);
const replay=(f,r,id='delivery-1')=>f.host(r.name).replayRetainedEvent(r.scope,id);
const snapshot=f=>f.storageFor().retentionJournal.load();
const fence=journal=>{const state=journal.load(),revision=state.revision;state.revision++;assert.equal(journal.commit(state,revision),true);};

test('Ingress retention persists the exact bounded raw envelope before any Host intent or Adapter ingress',async t=>{
  const f=setup(t),r=await f.start(),calls=f.calls.length,e=f.envelope(r,'question'),target=f.target(r),before=f.storageFor().eventJournal.load();
  const result=f.host().retainEvent(r.scope,target,e);assert.equal(result.state,'retained');assert.equal(result.retained,true);assert.equal(result.handoffStarted,false);assert.equal(result.applied,null);
  const saved=snapshot(f);assert.deepEqual(saved.records[0].envelope,e);assert.deepEqual(saved.records[0].target,target);assert.equal(saved.records[0].context.sessionId,f.store.session(r.scope).id);
  assert.deepEqual(f.storageFor().eventJournal.load(),before);assert.equal(f.ingresses.length,0);assert.equal(f.calls.length,calls);assert.equal(f.store.events(r.scope,r.runId).length,0);
  e.message.params.questions[0].question='caller mutated';target.externalRef='caller-replaced-ref';
  assert.notEqual(f.host().recoverIngress(r.scope)[0].envelope.message.params.questions[0].question,'caller mutated');
  assert.equal((await deliver(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);assert.equal(f.calls.length,calls);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');assert.equal(f.responses.length,0);
});

test('Ingress retention and Host bookkeeping expose independent facts and duplicate delivery never reingests',async t=>{
  const f=setup(t),r=await f.start();retain(f,r);assert.equal(retain(f,r).duplicate,true);
  const first=await deliver(f,r);assert.equal(first.state,'recorded');assert.equal(first.hostState,'confirmed');assert.equal(first.applied,true);
  assert.equal((await deliver(f,r)).duplicate,true);assert.equal((await replay(f,r)).eventId,first.eventId);assert.equal(retain(f,r).state,'recorded');
  assert.equal(f.ingresses.length,1);assert.equal(f.store.events(r.scope,r.runId).length,1);assert.deepEqual(f.host().recoverIngress(r.scope),[]);
  assert.equal(f.count('turn/start'),1);assert.equal(f.count('turn/interrupt'),0);assert.equal(f.count('turn/steer'),0);
});

test('Ingress can account for the same envelope already confirmed by the existing direct Host entry',async t=>{
  const f=setup(t),r=await f.start();const existing=await f.receive(r,'question');retain(f,r,'question');
  const result=await deliver(f,r);assert.equal(result.state,'recorded');assert.equal(result.eventId,existing.eventId);assert.equal(f.ingresses.length,1);assert.equal(f.store.events(r.scope,r.runId).length,1);
});

test('Ingress cannot use an existing Host receipt for a different raw envelope with the same delivery identity',async t=>{
  const f=setup(t),r=await f.start();await f.receive(r,'question');retain(f,r,'progress');
  assert.equal((await deliver(f,r)).state,'unknown');const result=await replay(f,r);assert.equal(result.state,'unknown');assert.equal(result.reason,'HOST_INGRESS_RECEIPT_MISMATCH');
  assert.equal(snapshot(f).records[0].receipt,null);assert.equal(f.ingresses.length,1);assert.equal(f.store.events(r.scope,r.runId).length,1);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');
});

test('Ingress unknown before Host intent may only be closed by a separately persisted receipt for the exact raw envelope',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');let armed=true;f.hostFault=p=>{if(armed&&p==='after-ingress-intent'){armed=false;throw Error('synthetic lost handoff');}};
  assert.equal((await deliver(f,r)).state,'unknown');assert.equal((await replay(f,r)).state,'unknown');assert.equal(f.ingresses.length,0);
  assert.equal((await f.receive(r,'question')).state,'confirmed');const calls=f.calls.length;assert.equal((await replay(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);assert.equal(f.calls.length,calls);assert.equal((await deliver(f,r)).duplicate,true);
});

test('Ingress recover and replay of a never-delivered envelope do not silently cross the Adapter boundary',async t=>{
  const f=setup(t),r=await f.start();retain(f,r);const before=snapshot(f),calls=f.calls.length;
  const pending=f.host().recoverIngress(r.scope);assert.equal(pending.length,1);assert.equal(Object.isFrozen(pending[0].envelope.message),true);
  assert.equal((await replay(f,r)).reason,'EXPLICIT_INGRESS_DELIVERY_REQUIRED');assert.deepEqual(snapshot(f),before);assert.equal(f.calls.length,calls);assert.equal(f.ingresses.length,0);
});

test('Ingress unassociated envelopes remain raw audit records and cannot acquire a target through redelivery',async t=>{
  const f=setup(t),r=await f.start(),e=f.envelope(r);const result=f.host().retainEvent(r.scope,null,e);
  assert.equal(result.state,'unassociated');assert.equal(result.taskId,null);assert.equal(result.handoffStarted,false);
  assert.equal((await deliver(f,r)).state,'unassociated');assert.equal((await replay(f,r)).state,'unassociated');
  assert.throws(()=>retain(f,r),{code:'HOST_INGRESS_DELIVERY_CONFLICT'});assert.equal(f.host().retainEvent(r.scope,null,e).duplicate,true);
  assert.deepEqual(f.host().recoverIngress(r.scope)[0].envelope,e);assert.equal(f.ingresses.length,0);assert.equal(snapshot(f).records[0].target,null);
});

for(const [key,value] of Object.entries({taskId:'foreign-task',runId:'foreign-run',attempt:99,kind:'chat',leaseId:'foreign-lease',externalRef:'replacement-ref'}))
  test('Ingress preserves unresolved exact '+key+' without retargeting or guessing the latest Run',async t=>{
    const f=setup(t),r=await f.start(),target={...f.target(r),[key]:value},e=f.envelope(r);
    assert.equal(f.host().retainEvent(r.scope,target,e).state,'retained');const result=await deliver(f,r);
    assert.equal(result.state,'retained');assert.equal(result.handoffStarted,false);assert.ok(result.reason);assert.equal(snapshot(f).records[0].context,null);
    assert.throws(()=>retain(f,r),{code:'HOST_INGRESS_DELIVERY_CONFLICT'});assert.equal(f.ingresses.length,0);assert.deepEqual(snapshot(f).records[0].target,target);
  });

test('Ingress early envelope with a known original reference waits for independent exact Run reconciliation',async t=>{
  const f=setup(t),scope=testScope();f.hostFault=p=>{if(p==='before-store-confirmation')throw Error('synthetic submission gap');};
  const task=f.coordinator.accept(scope,{eventId:'early-task',operation:'new',kind:'work',text:'synthetic early event'}),report=await f.host().dispatch(scope,task.taskId);
  assert.equal(report.state,'unknown');assert.ok(report.externalRef);assert.equal(f.store.run(scope,report.runId).external_ref,null);f.hostFault=()=>{};
  const r={...report,scope,kind:'work',name:'a',threadId:'thread-1',turnId:'turn-1'};
  assert.equal(retain(f,r,'question').reason,'HOST_EVENT_RECONCILIATION_REQUIRED');assert.equal((await deliver(f,r)).state,'retained');assert.equal(f.ingresses.length,0);
  assert.equal((await f.host().reconcile(scope,r.taskId)).state,'running');assert.equal((await deliver(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);assert.equal(f.count('turn/start'),1);assert.equal(f.store.run(scope,r.runId).state,'waiting_input');
});

test('Ingress source identity and complete scope stay private to their owner and original principal',async t=>{
  const f=setup(t),a=await f.start(),b=await f.start('b');retain(f,a);retain(f,b);
  assert.throws(()=>f.host().retainEvent(b.scope,f.target(b),f.envelope(b)),{code:'HOST_INGRESS_SCOPE_MISMATCH'});
  assert.throws(()=>retain(f,a,'progress',2,{sourceId:'foreign-source'}),{code:'HOST_INGRESS_SOURCE_MISMATCH'});
  assert.deepEqual(f.host().recoverIngress({...a.scope,principalId:'other-principal'}),[]);
  assert.throws(()=>f.host().ingressStatus({...a.scope,principalId:'other-principal'},'delivery-1'),{code:'HOST_INGRESS_RECORD_ABSENT'});
  assert.equal((await deliver(f,b)).state,'recorded');assert.equal(f.host().ingressStatus(a.scope,'delivery-1').state,'retained');assert.equal(f.ingresses.length,1);
});

test('Ingress caller-supplied delivery identity is mandatory and semantic key order does not invent a new event',async t=>{
  const f=setup(t),r=await f.start(),e=f.envelope(r);delete e.deliveryId;
  assert.throws(()=>f.host().retainEvent(r.scope,f.target(r),e));assert.equal(snapshot(f).records.length,0);
  const original=f.envelope(r),reordered={message:{params:{delta:original.message.params.delta,itemId:'item-1',turnId:r.turnId,threadId:r.threadId},method:original.message.method},seq:1,deliveryId:'delivery-1',sourceId:original.sourceId,occurredAt:original.occurredAt};
  retain(f,r);assert.equal(f.host().retainEvent(r.scope,f.target(r),reordered).duplicate,true);assert.equal(snapshot(f).records.length,1);assert.equal(f.ingresses.length,0);
});

for(const kind of ['body','seq','time','target','delivery-sequence'])test('Ingress conflicting '+kind+' preserves the original raw record',async t=>{
  const f=setup(t),r=await f.start();retain(f,r);const before=snapshot(f),e=f.envelope(r),target=f.target(r);
  if(kind==='body')e.message.params.delta='changed';if(kind==='seq')e.seq=2;if(kind==='time')e.occurredAt='2026-01-02T00:00:00.000Z';if(kind==='target')target.runId='another-run';if(kind==='delivery-sequence')e.deliveryId='new-delivery';
  assert.throws(()=>f.host().retainEvent(r.scope,target,e),{code:kind==='delivery-sequence'?'HOST_INGRESS_SEQUENCE_CONFLICT':'HOST_INGRESS_DELIVERY_CONFLICT'});
  assert.deepEqual(snapshot(f),before);assert.equal(f.ingresses.length,0);
});

for(const kind of ['fields','time','json','size','depth','target-fields'])test('Ingress rejects invalid '+kind+' before acknowledging retention or invoking Host',async t=>{
  const f=setup(t),r=await f.start(),e=f.envelope(r),target=f.target(r);
  if(kind==='fields')e.extra=true;if(kind==='time')e.occurredAt='yesterday';if(kind==='json')e.message.value=undefined;if(kind==='size')e.message.value='x'.repeat(65536);
  if(kind==='depth'){e.message.value={};let a=e.message.value;for(let i=0;i<33;i++)a=a.next={};}if(kind==='target-fields')target.sessionId='injected';
  assert.throws(()=>f.host().retainEvent(r.scope,target,e));assert.equal(snapshot(f).records.length,0);assert.equal(f.ingresses.length,0);
});

for(const point of ['before-ingress-retain','after-ingress-retain'])test('Ingress fault '+point+' distinguishes absence from a durable raw envelope',async t=>{
  const f=setup(t),r=await f.start();f.hostFault=p=>{if(p===point)throw Error('synthetic caller lost before acknowledgement');};
  assert.throws(()=>retain(f,r));assert.equal(snapshot(f).records.length,point==='before-ingress-retain'?0:1);assert.equal(f.ingresses.length,0);f.hostFault=()=>{};
  assert.equal(retain(f,r).duplicate,point==='after-ingress-retain');assert.equal((await deliver(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);
});

for(const stage of ['before-commit','after-commit'])test('Ingress actual SQLite raw '+stage+' failure requires reopening the real durable record',async t=>{
  const f=setup(t),r=await f.start();f.retentionJournalFault=p=>{if(p===stage)throw Error('synthetic retention commit fault');};
  assert.throws(()=>retain(f,r),{code:'HOST_INGRESS_JOURNAL_UNAVAILABLE'});assert.throws(()=>f.host().recoverIngress(r.scope),{code:'HOST_INGRESS_UNAVAILABLE'});assert.equal(f.ingresses.length,0);
  f.retentionJournalFault=()=>{};const calls=f.calls.length;f.makeHost();assert.equal(f.calls.length,calls);assert.equal(snapshot(f).records.length,stage==='before-commit'?0:1);
  assert.equal(retain(f,r).duplicate,stage==='after-commit');assert.equal(f.ingresses.length,0);assert.equal(f.count('turn/start'),1);
});

for(const point of ['after-ingress-intent','after-ingress-host','before-ingress-confirmation'])test('Ingress '+point+' unknown only replays existing Host receipts and never retries ingress',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');let armed=true;f.hostFault=p=>{if(armed&&p===point){armed=false;throw Error('synthetic retention boundary');}};
  assert.equal((await deliver(f,r)).state,'unknown');const count=f.ingresses.length,calls=f.calls.length;
  assert.equal((await deliver(f,r)).state,'unknown');assert.equal(retain(f,r,'question').state,'unknown');
  const result=await replay(f,r);assert.equal(result.state,point==='after-ingress-intent'?'unknown':'recorded');assert.equal(f.ingresses.length,count);assert.equal(f.calls.length,calls);
  if(point==='after-ingress-intent'){assert.equal(result.reason,'HOST_EVENT_INTENT_ABSENT');assert.equal(f.host().recoverIngress(r.scope)[0].envelope.deliveryId,'delivery-1');}
});

for(const point of ['after-event-intent','after-event-adapter','after-event-host-receipt','before-event-store','after-event-store','before-event-confirmation'])
  test('Ingress retains the original envelope across existing Host boundary '+point,async t=>{
    const f=setup(t),r=await f.start();retain(f,r,'question');let armed=true;f.hostFault=p=>{if(armed&&p===point){armed=false;throw Error('synthetic Host boundary');}};
    assert.equal((await deliver(f,r)).state,'unknown');const count=f.ingresses.length,calls=f.calls.length;
    assert.equal((await deliver(f,r)).state,'unknown');const result=await replay(f,r);assert.equal(result.state,point==='after-event-intent'?'unknown':'recorded');
    assert.equal(f.ingresses.length,count);assert.equal(f.calls.length,calls);assert.deepEqual(snapshot(f).records[0].envelope,f.envelope(r,'question'));
  });

for(const ordinal of [1,2])for(const stage of ['before-commit','after-commit'])test('Ingress SQLite delivery save '+ordinal+' '+stage+' never redelivers an unknown Host attempt',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');let saves=0;f.retentionJournalFault=p=>{if(p===stage&&++saves===ordinal)throw Error('synthetic delivery commit fault');};
  await assert.rejects(deliver(f,r),{code:'HOST_INGRESS_JOURNAL_UNAVAILABLE'});const count=f.ingresses.length;f.retentionJournalFault=()=>{};const calls=f.calls.length;f.makeHost();assert.equal(f.calls.length,calls);assert.equal(f.ingresses.length,count);
  const saved=snapshot(f).records[0];
  if(ordinal===1&&stage==='before-commit'){assert.equal(saved.phase,'retained');assert.equal((await replay(f,r)).reason,'EXPLICIT_INGRESS_DELIVERY_REQUIRED');}
  else {const result=await replay(f,r);assert.equal(result.state,ordinal===1?'unknown':'recorded');assert.equal((await deliver(f,r)).state,result.state);}
  assert.equal(f.ingresses.length,count);assert.equal(f.count('turn/start'),1);
});

test('Ingress Store rollback is filled from durable public source without consuming input or confirming cancellation',async t=>{
  const f=setup(t),r=await f.start(),batch=f.queue(r);retain(f,r,'question');f.storeFault=p=>{if(p==='before-event-commit')throw Error('synthetic Store rollback');};
  assert.equal((await deliver(f,r)).state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);f.storeFault=()=>{};
  assert.equal((await replay(f,r)).applied,true);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');assert.notEqual(f.store.inputBatch(r.scope,batch.batchId).state,'consumed');assert.equal(f.ingresses.length,1);assert.equal(f.count('turn/interrupt'),0);
});

test('Ingress cannot substitute its raw copy for missing durable Adapter provenance',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');f.adapterJournalFault=p=>{if(p==='before-commit')throw Error('synthetic Adapter save fault');};
  assert.equal((await deliver(f,r)).state,'unknown');f.adapterJournalFault=()=>{};f.makeHost();
  assert.equal((await replay(f,r)).state,'unknown');assert.equal((await deliver(f,r)).state,'unknown');assert.equal(f.ingresses.length,1);assert.equal(f.store.events(r.scope,r.runId).length,0);assert.equal(snapshot(f).records.length,1);
});

for(const mutation of ['missing','digest','legacy'])test('Ingress unknown public source '+mutation+' stays unknown despite retained raw content',async t=>{
  const f=setup(t),r=await f.start();retain(f,r);f.hostFault=p=>{if(p==='after-event-adapter')throw Error('synthetic Host source gap');};assert.equal((await deliver(f,r)).state,'unknown');f.hostFault=()=>{};
  f.sourceRead=rows=>{const a=structuredClone(rows);if(mutation==='missing')return [];if(mutation==='legacy')delete a[0].source;else a[0].source.envelopeDigest='0'.repeat(64);return a;};
  assert.equal((await replay(f,r)).state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);assert.equal(f.ingresses.length,1);
});

test('Ingress restart and read-only local recovery preserve unresolved records and fence the previous object',async t=>{
  const f=setup(t),r=await f.start(),old=f.host();retain(f,r,'question');const calls=f.calls.length;f.makeHost();const before=snapshot(f);
  assert.equal(f.calls.length,calls);assert.equal(f.ingresses.length,0);assert.equal(f.host().recoverIngress(r.scope).length,1);assert.deepEqual(snapshot(f),before);
  assert.throws(()=>old.ingressStatus(r.scope,'delivery-1'),{code:'HOST_INGRESS_JOURNAL_FENCED'});assert.equal((await replay(f,r)).state,'retained');assert.equal(f.calls.length,calls);
  await f.host().reconcile(r.scope,r.taskId);assert.equal((await deliver(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);assert.equal(f.count('turn/start'),1);
});

test('Ingress independent journal fencing during preparation prevents late Adapter ingestion', {timeout:5000},async t=>{
  const f=setup(t),r=await f.start(),entered=gate(),release=gate();retain(f,r,'question');f.prepareIngress=async()=>{entered.resolve();await release.promise;};
  const pending=deliver(f,r);await entered.promise;fence(f.storageFor().retentionJournal);release.resolve();
  await assert.rejects(pending,{code:'HOST_INGRESS_UNAVAILABLE'});assert.equal(f.ingresses.length,0);assert.equal(f.store.events(r.scope,r.runId).length,0);
  f.makeHost();assert.equal((await replay(f,r)).state,'unknown');assert.equal(f.ingresses.length,0);assert.equal(f.count('turn/start'),1);
});

test('Ingress fencing after Adapter acceptance never acknowledges a stale source object or repeats the ingress',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');f.ingress=()=>fence(f.storageFor().retentionJournal);
  await assert.rejects(deliver(f,r),{code:'HOST_INGRESS_UNAVAILABLE'});assert.equal(f.ingresses.length,1);f.ingress=()=>{};f.makeHost();
  assert.equal((await replay(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);assert.equal(f.count('turn/start'),1);
});

test('Ingress cannot replace an already captured Session mapping',async t=>{
  const f=setup(t),r=await f.start();retain(f,r);const journal=f.storageFor().retentionJournal,saved=journal.load(),revision=saved.revision;saved.records[0].context.sessionRef='replacement-session-ref';saved.revision++;journal.commit(saved,revision);f.makeHost();
  const result=await deliver(f,r);assert.equal(result.state,'retained');assert.equal(result.reason,'HOST_INGRESS_TARGET_CHANGED');assert.equal(f.ingresses.length,0);
});

for(const mutation of ['revoke','expire','stop','globalStop','rePair','rebind','policy'])test('Ingress retained event after '+mutation+' only audits and never restores execution permission',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');
  if(mutation==='revoke')f.store.revokePairing(r.scope);if(mutation==='expire')f.now=200000;if(mutation==='stop')f.store.stopBot(r.scope.botId);if(mutation==='globalStop')f.store.stop(r.scope.hostId);if(mutation==='rePair')f.store.grantPairing(r.scope,{expiresAt:100000});
  if(['rebind','policy'].includes(mutation)){const config=structuredClone(f.config);config.revision=2;config.bindings.forEach(b=>b.version=2);if(mutation==='rebind')config.agents[0].workspaceRef='project-y';else config.policies[0].version=2;f.store.installConfiguration(config);}
  const result=await deliver(f,r);assert.equal(result.state,'recorded');assert.equal(result.applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'unknown');assert.equal(f.count('turn/start'),1);assert.equal(f.responses.length,0);
});

test('Ingress retained ordinary observations cannot clear cancellation or count as cancellation confirmation',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question');assert.equal((await f.host().cancel(r.scope,f.target(r),'retained-cancel')).state,'requested');
  const result=await deliver(f,r);assert.equal(result.state,'recorded');assert.equal(result.applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');assert.equal(f.host().cancelStatus(r.scope,f.target(r),'retained-cancel').confirmed,false);
  retain(f,r,'interrupted',2);assert.equal((await deliver(f,r,'delivery-2')).applied,true);assert.equal(f.host().cancelStatus(r.scope,f.target(r),'retained-cancel').confirmed,false);
  assert.equal(f.host().recoverCancel(r.scope,f.target(r),'retained-cancel').confirmed,true);assert.equal(f.count('turn/interrupt'),1);
});

test('Ingress retained questions progress and old terminal events preserve approval and terminal monotonicity',async t=>{
  const f=setup(t),r=await f.start();retain(f,r,'question',2);retain(f,r,'started',3);await f.receive(r,'approval');
  assert.equal((await deliver(f,r,'delivery-2')).applied,false);assert.equal((await deliver(f,r,'delivery-3')).applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_approval');assert.equal(f.responses.length,0);
  retain(f,r,'completed',4);assert.equal((await deliver(f,r,'delivery-4')).applied,true);retain(f,r,'failed',5);assert.equal((await deliver(f,r,'delivery-5')).applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'succeeded');
});

test('Ingress keeps multiple continuation Runs and late original events attached to the original Session',async t=>{
  const f=setup(t);let r=await f.start();const original={...r};retain(f,r,'progress',9,{deliveryId:'retained-attempt-1'});
  for(let i=0;i<2;i++){await f.receive(r,'completed',10);r=await f.continue(r);const id='retained-attempt-'+r.attempt;retain(f,r,'progress',9,{deliveryId:id});assert.equal((await deliver(f,r,id)).state,'recorded');}
  const current=f.store.task(r.scope,r.taskId);assert.equal((await deliver(f,original,'retained-attempt-1')).applied,false);assert.deepEqual(f.store.task(r.scope,r.taskId),current);
  assert.equal(f.count('thread/start'),1);assert.equal(f.count('turn/start'),3);assert.equal(new Set(snapshot(f).records.map(x=>x.context.sessionId)).size,1);
});

test('Ingress fencing during public-source reading leaves Store unchanged until explicit replay by the new owner', {timeout:5000},async t=>{
  const f=setup(t),r=await f.start(),entered=gate(),release=gate();retain(f,r,'question');f.sourceRead=async rows=>{entered.resolve();await release.promise;return rows;};
  const pending=deliver(f,r);await entered.promise;fence(f.storageFor().retentionJournal);release.resolve();await assert.rejects(pending,{code:'HOST_INGRESS_UNAVAILABLE'});
  assert.equal(f.ingresses.length,1);assert.equal(f.store.events(r.scope,r.runId).length,0);f.sourceRead=rows=>rows;f.makeHost();assert.equal((await replay(f,r)).state,'recorded');assert.equal(f.ingresses.length,1);
});

test('Ingress close during preparation blocks late ingress while queued envelopes stay locally retained', {timeout:5000},async t=>{
  const f=setup(t),r=await f.start(),entered=gate(),release=gate();retain(f,r);retain(f,r,'question',2);f.prepareIngress=async()=>{entered.resolve();await release.promise;};
  const active=deliver(f,r);await entered.promise;const queued=deliver(f,r,'delivery-2'),queuedResult=assert.rejects(queued,{code:'SCHEDULER_CLOSED'});await f.host().close();release.resolve();
  await queuedResult;await assert.rejects(active);assert.equal(f.ingresses.length,0);f.makeHost();assert.equal(f.host().ingressStatus(r.scope,'delivery-1').state,'unknown');assert.equal(f.host().ingressStatus(r.scope,'delivery-2').state,'retained');assert.equal(f.count('turn/start'),1);
});

test('Ingress raw retention can proceed during input preparation and does not falsely consume the input', {timeout:5000},async t=>{
  const f=setup(t),r=await f.start(),entered=gate(),release=gate(),batch=f.queue(r);f.prepare=async frame=>{if(frame.method==='turn/steer'){entered.resolve();await release.promise;}};
  f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;retain(f,r,'approval');assert.equal((await deliver(f,r)).applied,true);release.resolve();
  assert.equal((await pending).state,'unknown');assert.equal(f.store.run(r.scope,r.runId).state,'waiting_approval');assert.equal(f.count('turn/steer'),0);assert.equal(f.ingresses.length,1);
});

test('Ingress bounded queue retains rejected queued work for later explicit first delivery and isolates another Agent', {timeout:8000},async t=>{
  const f=setup(t),a=await f.start(),b=await f.start('b'),entered=gate(),release=gate();for(let seq=1;seq<=34;seq++)retain(f,a,'progress',seq);retain(f,b,'question');
  f.prepareIngress=async(_,name)=>{if(name==='a'){entered.resolve();await release.promise;}};
  const first=deliver(f,a);await entered.promise;const queued=[];for(let seq=2;seq<=33;seq++)queued.push(deliver(f,a,'delivery-'+seq));
  assert.throws(()=>deliver(f,a,'delivery-34'),{code:'SCHEDULER_QUEUE_FULL'});assert.equal(f.host().ingressStatus(a.scope,'delivery-34').handoffStarted,false);assert.equal((await deliver(f,b)).applied,true);
  release.resolve();await first;await Promise.all(queued);assert.equal((await deliver(f,a,'delivery-34')).state,'recorded');assert.equal(f.store.events(a.scope,a.runId).length,34);
});

test('Ingress instance save failure and closing one Host do not stop another source or shared input scheduler',async t=>{
  const f=setup(t),a=await f.start(),b=await f.start('b');retain(f,b,'question');f.retentionJournalFault=(p,name)=>{if(name==='a'&&p==='before-commit')throw Error('synthetic source instance failure');};
  assert.throws(()=>retain(f,a));await f.host().close();assert.equal((await deliver(f,b)).applied,true);assert.equal(await f.scheduler.submit(b.scope,'retention-other-agent',()=>42),42);assert.equal(f.store.run(b.scope,b.runId).state,'waiting_input');
});

test('Ingress per-Run raw capacity rejects before Host work and keeps all previous raw envelopes',async t=>{
  const f=setup(t),r=await f.start();for(let seq=1;seq<=256;seq++)retain(f,r,'progress',seq);
  assert.throws(()=>retain(f,r,'progress',257),{code:'HOST_INGRESS_CAPACITY'});assert.equal(snapshot(f).records.length,256);assert.equal(retain(f,r).duplicate,true);assert.equal(f.ingresses.length,0);
});

function memorySource(t){
  let saved=null;const s=testScope(),agent={id:s.agentId,adapterId:'generic-offline',modelRef:'explicit-synthetic-model'},journal={load:()=>structuredClone(saved),commit:(value,revision)=>{if((saved?.revision??0)!==revision)return false;saved=structuredClone(value);return true;}};
  const config={hostId:s.hostId,agent,sourceId:'synthetic-source',journal,resolveTarget:()=>({sessionId:'session-a',sessionRef:'session-ref',dispatchKey:'dispatch-a'}),receiveEvent:()=>assert.fail('no transport allowed'),eventStatus:()=>assert.fail('no Host lookup allowed'),replayEvent:()=>assert.fail('no replay allowed')};
  const open=()=>{const source=new OfflineIngressRetention(config);t.after(()=>source.close());return source;},source=open();
  const envelope=(deliveryId='delivery-a',seq=1)=>({sourceId:'synthetic-source',deliveryId,seq,occurredAt:'2026-01-01T00:00:00.000Z',message:{method:'synthetic',params:{value:'raw'}}});
  return {s,agent,journal,config,open,source,envelope,set:value=>{saved=structuredClone(value);}};
}

test('Ingress total raw history reaches its actual 4096-record limit without deleting unassociated records',t=>{
  const f=memorySource(t);f.source.retain(f.s,null,f.envelope());const saved=f.journal.load(),base=saved.records[0];
  saved.records=Array.from({length:4096},(_,i)=>{const envelope=f.envelope('delivery-'+i);const {sourceId,...body}=envelope;return {...structuredClone(base),envelope,envelopeDigest:eventEnvelopeDigest(body)};});f.set(saved);const source=f.open();
  assert.equal(source.recover(f.s).length,4096);assert.throws(()=>source.retain(f.s,null,f.envelope('overflow')),{code:'HOST_INGRESS_CAPACITY'});assert.equal(f.journal.load().records.length,4096);assert.equal(source.retain(f.s,null,f.envelope('delivery-0')).duplicate,true);
});

test('Ingress snapshot 16 MiB limit rejects atomically and never acknowledges an unpersisted raw record',t=>{
  const f=memorySource(t),e=f.envelope();e.message.params.value='x'.repeat(60000);f.source.retain(f.s,null,e);const saved=f.journal.load(),base=saved.records[0];
  saved.records=Array.from({length:270},(_,i)=>{const envelope={...e,deliveryId:'delivery-'+i};const {sourceId,...body}=envelope;return {...structuredClone(base),envelope,envelopeDigest:eventEnvelopeDigest(body)};});f.set(saved);const source=f.open();
  let rejected=false;for(let i=270;i<285;i++){try{source.retain(f.s,null,{...e,deliveryId:'delivery-'+i});}catch(error){assert.equal(error.code,'HOST_INGRESS_JOURNAL_UNAVAILABLE');rejected=true;break;}}
  assert.equal(rejected,true);assert.ok(Buffer.byteLength(JSON.stringify(f.journal.load()))<=16*1024*1024);assert.throws(()=>source.recover(f.s),{code:'HOST_INGRESS_UNAVAILABLE'});
});

for(const kind of ['owner','agent','source','version','kind','raw-digest'])test('Ingress rejects incompatible or corrupted '+kind+' snapshot without relabelling or replacing its channel',t=>{
  const f=memorySource(t);f.source.retain(f.s,null,f.envelope());const saved=f.journal.load();
  if(kind==='owner')saved.owner.agentId='other-agent';if(kind==='agent')saved.agent.modelRef='another-model';if(kind==='source')saved.sourceId='another-source';if(kind==='version')saved.schemaVersion=2;if(kind==='kind')saved.channelKind='event-receipts';if(kind==='raw-digest')saved.records[0].envelope.message.params.value='tampered';
  f.set(saved);assert.throws(()=>f.open(),{code:'HOST_INGRESS_JOURNAL_MISMATCH'});assert.deepEqual(f.journal.load(),saved);
});

test('Ingress is optional and its independent channel leaves all existing version domains and business tables unchanged',async t=>{
  const old=fixture(t),oldRun=await old.start();assert.throws(()=>old.host().retainEvent(oldRun.scope,old.target(oldRun),old.envelope(oldRun)),{code:'HOST_INGRESS_NOT_CONFIGURED'});assert.equal((await old.receive(oldRun)).state,'confirmed');
  const f=setup(t),r=await f.start();retain(f,r);assert.equal((await deliver(f,r)).state,'recorded');assert.equal(snapshot(f).schemaVersion,1);assert.equal(f.storageFor().journal.load().schemaVersion,2);assert.equal(f.storageFor().adapterJournal.load().schemaVersion,1);assert.equal(f.storageFor().eventJournal.load().schemaVersion,1);assert.equal(f.storageFor().cancelJournal.load().schemaVersion,1);
  const db=new DatabaseSync(path.join(f.directory,'work.sqlite'));assert.equal(db.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'3');db.close();
});
