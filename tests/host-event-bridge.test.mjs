import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { normalizeEventEnvelope, eventEnvelopeDigest } from '../packages/core/event-contracts.mjs';
import { testScope } from './foundation-fixtures.mjs';
import { fixture, gate } from './fixtures/host-event-fixture.mjs';

test('Host events use trusted ingress and public durable events without authorization bypass or private snapshot access',async t=>{
  const f=fixture(t),r=await f.start(),result=await f.receive(r,'question');
  assert.equal(result.state,'confirmed');assert.equal(result.applied,true);assert.equal(result.adapterApplied,true);assert.equal(result.executionApproved,false);
  const rows=f.store.events(r.scope,r.runId);assert.equal(rows.length,1);assert.equal(rows[0].data.questionId,'question-1');assert.equal(rows[0].applied,true);
  assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');assert.equal(f.ingresses.length,1);assert.equal(f.responses.length,0);
  const saved=f.storageFor().eventJournal.load();assert.equal(saved.schemaVersion,1);assert.equal(saved.records[0].phase,'confirmed');assert.equal(saved.records[0].record.source.deliveryId,'delivery-1');
  assert.equal(f.storageFor().journal.load().schemaVersion,2);assert.equal(f.storageFor().adapterJournal.load().schemaVersion,1);
});

test('Host events associate initial and multiple continued Runs with original Session, lease and distinct exact references',async t=>{
  const f=fixture(t);let r=await f.start();const first={...r},session=f.store.session(r.scope).id,lease=f.target(r).leaseId;
  for(let attempt=1;attempt<=3;attempt++){
    assert.equal((await f.receive(r,'completed')).applied,true);assert.equal(f.store.run(r.scope,r.runId).state,'succeeded');
    if(attempt<3){r=await f.continue(r);assert.equal(r.attempt,attempt+1);assert.equal(f.store.session(r.scope).id,session);assert.equal(f.target(r).leaseId,lease);}
  }
  assert.equal(f.storageFor().eventJournal.load().records.length,3);assert.equal(f.count('thread/start'),1);assert.equal(f.count('turn/start'),3);
  const taskBefore=f.store.task(r.scope,r.taskId);const late=await f.receive(first,'started',2);
  assert.equal(late.applied,false);assert.equal(late.adapterApplied,false);assert.deepEqual(f.store.task(r.scope,r.taskId),taskBefore);
});

test('Host event duplicate delivery returns original durable receipt and does not invoke ingress twice',async t=>{
  const f=fixture(t),r=await f.start(),a=await f.receive(r),b=await f.receive(r),c=await f.replay(r,'delivery-1');
  assert.equal(a.applied,true);assert.equal(b.duplicate,true);assert.equal(b.applied,true);assert.equal(c.duplicate,true);assert.equal(c.eventId,a.eventId);assert.equal(f.ingresses.length,1);assert.equal(f.store.events(r.scope,r.runId).length,1);
});

test('Host event same delivery or sequence conflicts preserve original receipt and Run',async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r);const before=f.store.run(r.scope,r.runId);
  await assert.rejects(f.receive(r,'question'),{code:'HOST_EVENT_DELIVERY_CONFLICT'});
  await assert.rejects(f.receive(r,'progress',1,{deliveryId:'other-delivery'}),{code:'HOST_EVENT_SEQUENCE_CONFLICT'});
  await assert.rejects(f.receive(r,'progress',2,{deliveryId:'delivery-1'}),{code:'HOST_EVENT_DELIVERY_CONFLICT'});
  assert.deepEqual(f.store.run(r.scope,r.runId),before);assert.equal(f.ingresses.length,1);
});

test('Host event out-of-order, terminal and late observations cannot regress or resurrect a Run',async t=>{
  const f=fixture(t),r=await f.start();assert.equal((await f.receive(r,'question',4)).applied,true);
  const late=await f.receive(r,'started',2);assert.equal(late.late,true);assert.equal(late.applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');
  assert.equal((await f.receive(r,'completed',5)).applied,true);
  for(const [seq,type] of [[6,'started'],[7,'question'],[8,'failed'],[9,'interrupted']])assert.equal((await f.receive(r,type,seq)).applied,false);
  assert.equal(f.store.run(r.scope,r.runId).state,'succeeded');assert.equal(f.store.events(r.scope,r.runId).length,7);
});

test('Host event question versions invalidate stale answers while ordinary text cannot approve tools',async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r,'question');const batch=f.queue(r,'answer',{questionId:'question-1',questionSeq:1});
  await f.receive(r,'question',2);assert.equal(f.store.inputBatch(r.scope,batch.batchId).state,'invalidated');
  assert.throws(()=>f.queue(r,'answer',{questionId:'question-1',questionSeq:1}),{code:'STALE_INPUT_QUESTION'});
  assert.equal((await f.flush(r,f.queue(r,'answer',{questionId:'question-2',questionSeq:2,text:'同意只是普通文本'}))).state,'consumed');
  assert.equal(f.responses.length,1);assert.equal(f.responses[0].id,'rpc-question-2');
  await f.receive(r,'approval',3);await f.receive(r,'started',4);await f.receive(r,'question',5);
  assert.equal(f.store.run(r.scope,r.runId).state,'waiting_approval');assert.equal(f.responses.length,1);
  assert.throws(()=>f.queue(r,'correct'));assert.equal((await f.receive(r,'interrupted',6)).applied,true);assert.equal(f.store.run(r.scope,r.runId).state,'cancelled');
});

test('Host event observation during input preparation changes question without a shared scheduler deadlock', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r,'question');const entered=gate(),release=gate(),batch=f.queue(r,'answer',{questionId:'question-1',questionSeq:1});
  f.prepare=async frame=>{if(frame.result){entered.resolve();await release.promise;}};f.now+=250;
  const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;assert.equal((await f.receive(r,'question',2)).applied,true);release.resolve();
  assert.equal((await pending).state,'unknown');assert.equal(f.responses.length,0);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');
});

test('Host event approval during response preparation cannot be cleared by stale input receipt', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate(),batch=f.queue(r);
  f.prepare=async frame=>{if(frame.method==='turn/steer'){entered.resolve();await release.promise;}};f.now+=250;
  const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;await f.receive(r,'approval');release.resolve();
  assert.equal((await pending).state,'unknown');assert.equal(f.store.run(r.scope,r.runId).state,'waiting_approval');assert.equal(f.count('turn/steer'),0);
});

test('Host event cancellation intent blocks ordinary events and input; terminal event is separate confirmation',async t=>{
  const f=fixture(t),r=await f.start();f.store.requestCancel(r.scope,r.runId);
  for(const [type,seq] of [['started',1],['question',2],['progress',3]])assert.equal((await f.receive(r,type,seq)).applied,false);
  assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');assert.throws(()=>f.queue(r));assert.equal(f.count('turn/interrupt'),0);
  assert.equal((await f.receive(r,'interrupted',4)).applied,true);assert.equal(f.store.run(r.scope,r.runId).state,'cancelled');
});

for(const [key,value] of Object.entries({taskId:'foreign-task',runId:'foreign-run',attempt:99,kind:'chat',leaseId:'replacement-lease',externalRef:'foreign-ref'}))
  test('Host event rejects mismatched exact target '+key,async t=>{
    const f=fixture(t),r=await f.start();await assert.rejects(f.host().receiveEvent(r.scope,{...f.target(r),[key]:value},f.envelope(r)));
    assert.equal(f.ingresses.length,0);assert.equal(f.storageFor().eventJournal.load().records.length,0);
  });

test('Host event rejects foreign scope, missing source and unowned WorkStore Run',async t=>{
  const f=fixture(t),r=await f.start();assert.throws(()=>f.host().receiveEvent(testScope('b'),f.target(r),f.envelope(r)),{code:'HOST_EVENT_SCOPE_MISMATCH'});
  assert.throws(()=>f.host().receiveEvent(r.scope,f.target(r),f.envelope(r,'progress',1,{sourceId:'foreign-source'})),{code:'HOST_EVENT_SOURCE_MISMATCH'});
  const task=f.coordinator.accept(r.scope,{eventId:'unowned-task',operation:'new',kind:'work',text:'synthetic unowned'}),run=f.store.beginRun(r.scope,task.taskId,{dispatchKey:'unowned-dispatch'});f.store.recordSubmission(r.scope,run.id,'unowned-ref');
  await assert.rejects(f.host().receiveEvent(r.scope,{...f.target(r),taskId:task.taskId,runId:run.id,externalRef:'unowned-ref'},f.envelope(r)),{code:'HOST_EVENT_OWNED_RUN_REQUIRED'});assert.equal(f.ingresses.length,0);
});

for(const point of ['after-event-intent','after-event-adapter','after-event-host-receipt','before-event-store','after-event-store','before-event-confirmation'])
  test('Host event fault boundary '+point+' retains explicit replay without re-ingestion or model submission',async t=>{
    const f=fixture(t),r=await f.start();let armed=true;f.hostFault=p=>{if(armed&&p===point){armed=false;throw Error('synthetic boundary fault');}};
    const result=await f.receive(r,'question');assert.equal(result.state,'unknown');const ingresses=f.ingresses.length,calls=f.calls.length;
    assert.equal((await f.receive(r,'question')).state,'unknown');assert.equal(f.ingresses.length,ingresses);
    const replay=await f.replay(r,'delivery-1');assert.equal(replay.state,point==='after-event-intent'?'unknown':'confirmed');
    assert.equal(f.ingresses.length,ingresses);assert.equal(f.calls.length,calls);assert.equal(f.count('turn/start'),1);
    assert.equal(f.store.events(r.scope,r.runId).length,point==='after-event-intent'?0:1);
  });

test('Host event WorkStore transaction rollback leaves no question; explicit replay uses exact durable source',async t=>{
  const f=fixture(t),r=await f.start();f.storeFault=p=>{if(p==='before-event-commit')throw Error('synthetic event transaction rollback');};
  assert.equal((await f.receive(r,'question')).state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);assert.equal(f.store.run(r.scope,r.runId).state,'running');
  f.storeFault=()=>{};assert.equal((await f.replay(r,'delivery-1')).applied,true);assert.equal(f.ingresses.length,1);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');
});

test('Host event started/progress and input-only consumption cannot clear a question left by ordinary-answer completion rollback',async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r,'question');const batch=f.queue(r,'answer',{questionId:'question-1',questionSeq:1});
  f.storeFault=p=>{if(p==='before-input-completion-commit')throw Error('synthetic answer commit rollback');};
  assert.equal((await f.flush(r,batch)).state,'unknown');assert.equal(f.responses.length,1);f.storeFault=()=>{};
  assert.equal((await f.receive(r,'started',2)).applied,false);await f.receive(r,'progress',3);assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');
  assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'consumed');assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');
  assert.equal((await f.receive(r,'started',4)).applied,false);await f.receive(r,'question',5);
  assert.equal((await f.flush(r,f.queue(r,'answer',{questionId:'question-5',questionSeq:5}))).state,'consumed');assert.equal(f.store.run(r.scope,r.runId).state,'running');assert.equal(f.responses.length,2);
});

test('Host event actual legacy Adapter snapshot without optional provenance remains readable but cannot resolve a missing Host receipt',async t=>{
  const f=fixture(t),r=await f.start();f.hostFault=p=>{if(p==='after-event-adapter')throw Error('synthetic Host receipt gap');};await f.receive(r);
  const journal=f.storageFor().adapterJournal,saved=journal.load();for(const run of saved.runs)for(const record of run.events)delete record.source;
  const revision=saved.revision;saved.revision++;assert.equal(journal.commit(saved,revision),true);f.hostFault=()=>{};f.makeHost();
  assert.equal((await f.replay(r,'delivery-1')).state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);assert.equal(f.ingresses.length,1);
});

test('Host event permission is checked after asynchronous public-source reading and cannot undo a newly persisted cancellation', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();f.sourceRead=async rows=>{entered.resolve();await release.promise;return rows;};
  const pending=f.receive(r,'question');await entered.promise;f.store.requestCancel(r.scope,r.runId);release.resolve();
  const result=await pending;assert.equal(result.state,'confirmed');assert.equal(result.adapterApplied,true);assert.equal(result.applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
});

test('Host event replay after a newer question does not reapply an older Adapter receipt or question version',async t=>{
  const f=fixture(t),r=await f.start();f.storeFault=p=>{if(p==='before-event-commit')throw Error('synthetic first question rollback');};await f.receive(r,'question');f.storeFault=()=>{};
  await f.receive(r,'question',2);const result=await f.replay(r,'delivery-1');assert.equal(result.state,'confirmed');assert.equal(result.applied,false);
  assert.throws(()=>f.queue(r,'answer',{questionId:'question-1',questionSeq:1}),{code:'STALE_INPUT_QUESTION'});assert.equal(f.store.run(r.scope,r.runId).last_seq,2);
});

test('Host event replay after Run recovery cannot independently restore unknown state or input consumption',async t=>{
  const f=fixture(t),r=await f.start();f.hostFault=p=>{if(p==='after-event-adapter')throw Error('synthetic source receipt gap');};await f.receive(r,'question');f.hostFault=()=>{};
  f.host().recover(r.scope,r.taskId);assert.equal(f.store.run(r.scope,r.runId).state,'unknown');
  const result=await f.replay(r,'delivery-1');assert.equal(result.state,'confirmed');assert.equal(result.applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'unknown');assert.equal(f.responses.length,0);
});

test('Host event direct source authorization does not authorize submission/input work while an event is being received',async t=>{
  const f=fixture(t),r=await f.start();let denied;
  f.ingress=context=>{denied=context.adapter.sendInput(context.sessionRef,{...context.request,operation:'correct',text:'forbidden event callback input',questionId:null,questionSeq:0,executionApproved:false},'foreign-input-key');};
  // The unregistered input can be prepared by a trusted dependency, but the
  // actual transport entry has no captured WorkStore input attempt.
  await f.receive(r);assert.equal((await denied).state,'unknown');assert.equal(f.count('turn/steer'),0);assert.equal(f.store.events(r.scope,r.runId).length,1);
});

test('Host event current receipt remains immutable when the durable source changes after Host receipt',async t=>{
  const f=fixture(t),r=await f.start();f.hostFault=p=>{if(p==='after-event-host-receipt')throw Error('synthetic Host receipt ack gap');};await f.receive(r);f.hostFault=()=>{};
  f.sourceRead=rows=>{const changed=structuredClone(rows);changed[0].applied=false;return changed;};
  const result=await f.replay(r,'delivery-1');assert.equal(result.state,'unknown');assert.equal(result.reason,'HOST_EVENT_RECEIPT_CONFLICT');assert.equal(f.store.events(r.scope,r.runId).length,0);
});

for(const stage of ['before-commit','after-commit'])test('Host event journal '+stage+' failure fences old receiver and recovers actual durable revision',async t=>{
  const f=fixture(t),r=await f.start();let saves=0;
  f.eventJournalFault=p=>{if(p===stage&&++saves===3)throw Error('synthetic event journal ack fault');};
  await assert.rejects(f.receive(r,'question'),{code:'HOST_EVENT_JOURNAL_UNAVAILABLE'});assert.throws(()=>f.host().eventStatus(r.scope,f.target(r),'delivery-1'),{code:'HOST_EVENT_UNAVAILABLE'});
  const ingresses=f.ingresses.length;f.eventJournalFault=()=>{};f.makeHost();const calls=f.calls.length;assert.equal(f.calls.length,calls);
  const replay=await f.replay(r,'delivery-1');assert.equal(replay.state,'confirmed');assert.equal(f.ingresses.length,ingresses);assert.equal(f.count('turn/start'),1);
});

test('Host event Adapter save failure never becomes Host or WorkStore confirmed receipt',async t=>{
  const f=fixture(t),r=await f.start();f.adapterJournalFault=p=>{if(p==='before-commit')throw Error('synthetic adapter save failure');};
  const result=await f.receive(r,'question');assert.equal(result.state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);
  f.adapterJournalFault=()=>{};f.makeHost();const replay=await f.replay(r,'delivery-1');assert.equal(replay.state,'unknown');assert.equal(f.ingresses.length,1);assert.equal(f.store.run(r.scope,r.runId).state,'running');
});

test('Host event restart is read-only until explicit replay; old Host cannot accept late events',async t=>{
  const f=fixture(t),r=await f.start(),old=f.host();f.hostFault=p=>{if(p==='after-event-adapter')throw Error('synthetic receipt gap');};await f.receive(r,'question');
  f.hostFault=()=>{};const calls=f.calls.length,ingresses=f.ingresses.length;f.makeHost();assert.equal(f.calls.length,calls);assert.equal(f.ingresses.length,ingresses);
  assert.throws(()=>old.receiveEvent(r.scope,f.target(r),f.envelope(r,'question',2)),{code:'HOST_EVENT_JOURNAL_FENCED'});
  assert.equal((await f.replay(r,'delivery-1')).state,'confirmed');assert.equal(f.calls.length,calls);assert.equal(f.ingresses.length,ingresses);
});

for(const mutation of ['missing','legacy','digest','duplicate','correlation','seq','time','applied'])test('Host event public source '+mutation+' is not accepted by inference',async t=>{
  const f=fixture(t),r=await f.start();f.hostFault=p=>{if(p==='after-event-adapter')throw Error('synthetic receipt gap');};await f.receive(r);f.hostFault=()=>{};
  f.sourceRead=rows=>{
    const a=structuredClone(rows);if(mutation==='missing')return [];if(mutation==='legacy'){delete a[0].source;return a;}
    if(mutation==='digest')a[0].source.envelopeDigest='0'.repeat(64);if(mutation==='duplicate')a.push(structuredClone(a[0]));
    if(mutation==='correlation')a[0].event.correlationId='foreign-dispatch';if(mutation==='seq')a[0].event.seq=9;if(mutation==='time')a[0].event.occurredAt='2026-01-02T00:00:00.000Z';if(mutation==='applied')a[0].applied='yes';return a;
  };
  assert.equal((await f.replay(r,'delivery-1')).state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);assert.equal(f.ingresses.length,1);
});

test('Host event unsupported protocol observation stays unknown with no fabricated normalized receipt',async t=>{
  const f=fixture(t),r=await f.start(),e=f.envelope(r);e.message={method:'model/rerouted',params:{threadId:r.threadId,turnId:r.turnId}};
  assert.equal((await f.host().receiveEvent(r.scope,f.target(r),e)).state,'unknown');assert.equal((await f.replay(r,'delivery-1')).state,'unknown');assert.equal(f.store.events(r.scope,r.runId).length,0);assert.equal(f.ingresses.length,1);
});

for(const mutation of ['revoke','expire','stop','globalStop','rePair','rebind','policy'])test('Host event '+mutation+' during ingress preparation is audit only and never restores permission',async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();f.prepareIngress=async()=>{entered.resolve();await release.promise;};
  const pending=f.receive(r,'question');await entered.promise;
  if(mutation==='revoke')f.store.revokePairing(r.scope);if(mutation==='expire')f.now=200000;if(mutation==='stop')f.store.stopBot(r.scope.botId);if(mutation==='globalStop')f.store.stop(r.scope.hostId);if(mutation==='rePair')f.store.grantPairing(r.scope,{expiresAt:100000});
  if(['rebind','policy'].includes(mutation)){const config=structuredClone(f.config);config.revision=2;config.bindings.forEach(b=>b.version=2);if(mutation==='rebind')config.agents[0].workspaceRef='project-y';else config.policies[0].version=2;f.store.installConfiguration(config);}
  release.resolve();const result=await pending;assert.equal(result.state,'confirmed');assert.equal(result.applied,false);assert.equal(result.adapterApplied,false);assert.equal(f.store.run(r.scope,r.runId).state,'unknown');assert.equal(f.store.events(r.scope,r.runId)[0].applied,false);assert.equal(f.responses.length,0);assert.equal(f.count('turn/start'),1);
});

test('Host event authorization cannot be reused by direct Adapter ingress outside the exact receive entry',async t=>{
  const f=fixture(t),r=await f.start();await f.receive(r);const receipt=f.ingresses[0],e=f.envelope(r,'question',2);delete e.sourceId;
  const record=f.adapters.get('a').ingest(f.storageFor().journal.load().sessions[0].sessionRef,receipt.request,e);
  assert.equal(record.applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'running');assert.equal(f.store.events(r.scope,r.runId).length,1);
});

test('Host event per-Run capacity retains all history and rejects before calling ingress',async t=>{
  const f=fixture(t),r=await f.start();for(let seq=1;seq<=256;seq++)assert.equal((await f.receive(r,'progress',seq)).state,'confirmed');
  await assert.rejects(f.receive(r,'progress',257),{code:'HOST_EVENT_CAPACITY'});assert.equal(f.ingresses.length,256);assert.equal(f.store.events(r.scope,r.runId).length,256);assert.equal((await f.receive(r)).duplicate,true);
});

test('Host event queue is bounded and serial while independent Agent event sources remain live', {timeout:5000},async t=>{
  const f=fixture(t),a=await f.start(),b=await f.start('b'),entered=gate(),release=gate();f.prepareIngress=async(_,name)=>{if(name==='a'){entered.resolve();await release.promise;}};
  const first=f.receive(a);await entered.promise;const queued=[];for(let seq=2;seq<=33;seq++)queued.push(f.receive(a,'progress',seq));
  assert.throws(()=>f.receive(a,'progress',34),{code:'SCHEDULER_QUEUE_FULL'});assert.equal((await f.receive(b,'question')).applied,true);assert.equal(f.ingresses.filter(x=>x.name==='a').length,0);
  release.resolve();assert.equal((await first).applied,true);await Promise.all(queued);assert.equal(f.store.events(a.scope,a.runId).length,33);
});

test('Host event instance journal failure and closing one Host do not affect another Agent or shared input scheduler',async t=>{
  const f=fixture(t),a=await f.start(),b=await f.start('b');f.eventJournalFault=(p,name)=>{if(name==='a'&&p==='before-commit')throw Error('synthetic instance fault');};
  await assert.rejects(f.receive(a));assert.equal((await f.receive(b,'question')).applied,true);await f.host().close();
  assert.equal(await f.scheduler.submit(b.scope,'scheduler-owner-still-live',()=>42),42);assert.equal(f.store.run(b.scope,b.runId).state,'waiting_input');
});

test('Host event WorkStore schema is unchanged and recording adapter-unapplied events only restricts application',async t=>{
  const f=fixture(t),r=await f.start();f.ingress=()=>f.store.requestCancel(r.scope,r.runId);
  assert.equal((await f.receive(r,'started')).applied,false);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
  const db=new DatabaseSync(path.join(f.directory,'work.sqlite'));assert.equal(db.prepare("SELECT value FROM work_meta WHERE key='schema'").get().value,'3');db.close();
});

test('Host event envelope digest is stable across object key order and rejects unknown fields, invalid times, JSON or oversized input',()=>{
  const a={deliveryId:'d',seq:1,occurredAt:'2026-01-01T00:00:00.000Z',message:{params:{b:2,a:1},method:'synthetic'}};
  const b={message:{method:'synthetic',params:{a:1,b:2}},occurredAt:a.occurredAt,seq:1,deliveryId:'d'};assert.equal(eventEnvelopeDigest(a),eventEnvelopeDigest(b));
  for(const input of [{...a,extra:true},{...a,seq:0},{...a,occurredAt:'not-a-time'},{...a,message:{value:undefined}},{...a,message:{value:'x'.repeat(65536)}}])assert.throws(()=>normalizeEventEnvelope(input));
});
