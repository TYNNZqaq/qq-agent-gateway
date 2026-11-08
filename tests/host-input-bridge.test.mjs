import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { SqliteJournal } from '../packages/storage/sqlite-journal.mjs';
import { OfflineDispatchHost } from '../packages/host-control/offline-dispatch-host.mjs';
import { InputCoordinator } from '../packages/host-control/input-coordinator.mjs';
import { AdapterRegistry } from '../packages/core/adapter-registry.mjs';
import { SessionScheduler } from '../packages/core/session-scheduler.mjs';
import { registerCodexOffline } from '../packages/adapters/codex/offline-adapter.mjs';
import { DESCRIPTOR, PINNED_PROTOCOL } from '../packages/adapters/codex/protocol.mjs';
import { OfflineDispatchHost as HostV1 } from './fixtures/offline-host-v1.mjs';
import { SqliteJournal as JournalV1 } from './fixtures/sqlite-journal-v1.mjs';
import { configuration, testScope } from './foundation-fixtures.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{old=false}={}){
  const root=process.env.QQ_TEST_ROOT??path.resolve('QQ插件运行目录/test-work');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'host-input-')),allHosts=[],journals=[];
  const f={directory,now:1000,calls:[],responses:[],hosts:new Map(),storage:new Map(),adapters:new Map(),servers:new Map(),taskCount:0,inputCount:0,
    prepare:async()=>{},inputWait:async()=>{},handler:async()=>undefined,answerHandler:async()=>{},hostFault:()=>{},storeFault:()=>{},hostJournalFault:()=>{},adapterJournalFault:()=>{},syntheticEventSetup:false};
  f.config=configuration();for(const a of f.config.agents){a.adapterId=DESCRIPTOR.id;a.modelRef='synthetic-model-a';}
  f.store=new WorkStore(path.join(directory,'work.sqlite'),{hostId:'host-test',clock:()=>f.now,fault:p=>f.storeFault(p)});f.store.installConfiguration(f.config);
  for(const name of ['a','b'])f.store.grantPairing(testScope(name),{expiresAt:100000});
  f.scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1,maxQueued:8});
  f.makeHost=(name='a',{Host=OfflineDispatchHost,Journal=SqliteJournal,database=path.join(directory,'journal.sqlite')}={})=>{
    const s=testScope(name),journal=new Journal(database,{hostId:s.hostId,agentId:s.agentId,channel:'host',snapshotVersions:[1,2],fault:p=>f.hostJournalFault(p,name)}),adapterJournal=new Journal(database,{hostId:s.hostId,agentId:s.agentId,channel:'adapter',fault:p=>f.adapterJournalFault(p,name)});
    journals.push(journal,adapterJournal);f.storage.set(name,{journal,adapterJournal});
    const host=new Host({store:f.store,hostId:s.hostId,agent:{id:s.agentId,adapterId:DESCRIPTOR.id,modelRef:'synthetic-model-a'},configuration:f.config,journal,adapterJournal,scheduler:f.scheduler,fault:p=>f.hostFault(p,name),
      prepareAdapter:async({context,journal:storage,authorize})=>{
        if(!f.servers.has(name))f.servers.set(name,{threads:0,turns:[]});
        const server=f.servers.get(name),transport={mode:'synthetic',protocolVersion:PINNED_PROTOCOL,hostId:context.hostId,agentId:context.agentId,closed:false,
          prepare:frame=>f.prepare(frame,name),request:async frame=>{
            f.calls.push({...structuredClone(frame),name});const answer=await f.handler(frame,name);if(answer!==undefined)return answer;
            switch(frame.method){
              case 'initialize':return {userAgent:'synthetic codex/0.163.0-alpha.11.2'};
              case 'model/list':return {data:[{model:'synthetic-model-a',hidden:false}],nextCursor:null};
              case 'thread/start':return {thread:{id:'thread-'+(++server.threads),ephemeral:true},model:frame.params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
              case 'turn/start':{const turn={id:'turn-'+(server.turns.length+1),status:'inProgress',items:[]};server.turns.push(turn);return {turn:structuredClone(turn)};}
              case 'turn/steer':return {turnId:frame.params.expectedTurnId};
              case 'thread/read':return {thread:{id:frame.params.threadId,turns:structuredClone(server.turns)}};
              default:assert.fail('unexpected synthetic bridge request');
            }
          },notify:async()=>{},respond:async frame=>{f.responses.push({...structuredClone(frame),name});await f.answerHandler(frame,name);return {accepted:true};},close:async()=>{transport.closed=true;}};
        const registry=new AdapterRegistry();registerCodexOffline(registry,()=>({transport,journal:storage,
          // Only the explicit event SETUP helper below bypasses Host event
          // authorization. This is a synthetic precondition, not event wiring.
          authorize:r=>f.syntheticEventSetup&&r.operation==='event'?true:authorize(r)}));
        const adapter=registry.create({id:context.agentId,adapterId:context.adapterId},context);f.adapters.set(name,adapter);return adapter;
      }});
    allHosts.push(host);f.hosts.set(name,host);return host;
  };
  f.makeHost('a',old?{Host:HostV1,Journal:JournalV1}:{});
  f.coordinator=new InputCoordinator({store:f.store,scheduler:f.scheduler,prepareDispatch:async r=>{await f.inputWait(r);return f.hosts.get(r.scope.agentId.slice(-1)).prepareInput(r);},confirmDispatch:r=>f.hosts.get(r.scope.agentId.slice(-1)).confirmInput(r)});
  f.host=(name='a')=>f.hosts.get(name);f.journal=(name='a')=>f.storage.get(name).journal;f.adapterJournal=(name='a')=>f.storage.get(name).adapterJournal;
  f.count=(method,name='a')=>f.calls.filter(c=>c.method===method&&c.name===name).length;
  f.newTask=(name='a')=>f.coordinator.accept(testScope(name),{eventId:'new-'+(++f.taskCount),operation:'new',kind:'work',text:'synthetic initial goal'});
  f.start=async(name='a')=>{if(!f.hosts.has(name))f.makeHost(name);const task=f.newTask(name),r=await f.host(name).dispatch(testScope(name),task.taskId);assert.equal(r.state,'running');return {...r,scope:testScope(name),kind:'work',name};};
  f.queue=(r,operation='correct',extra={})=>f.coordinator.accept(r.scope,{eventId:'input-'+(++f.inputCount),operation,taskId:r.taskId,runId:r.runId,attempt:r.attempt,kind:r.kind,text:'synthetic ordinary input',...extra});
  f.flush=async(r,batch)=>{f.now+=250;return f.coordinator.flush(r.scope,batch.batchId);};
  f.emit=(r,type,seq=1,questionId='question-a')=>{
    const stored=f.adapterJournal(r.name).load(),run=stored.runs.find(x=>x.runId===r.runId),session=stored.sessions.find(x=>x.ref===run.sessionRef);
    const message=type==='question'?{method:'item/tool/requestUserInput',id:'rpc-question-'+seq,params:{threadId:session.threadId,turnId:run.turnId,itemId:'item-'+seq,isBlocking:true,questions:[{id:questionId,header:'Question',question:'Synthetic ordinary question?'}]}}:
      type==='approval'?{method:'item/fileChange/requestApproval',id:'rpc-approval-'+seq,params:{threadId:session.threadId,turnId:run.turnId,itemId:'approval-'+seq,startedAtMs:1}}:
      {method:'turn/completed',params:{threadId:session.threadId,turn:{id:run.turnId,status:type,items:[]}}};
    let record;f.syntheticEventSetup=true;
    try{record=f.adapters.get(r.name).ingest(session.ref,{scope:r.scope,taskId:r.taskId,runId:r.runId,attempt:r.attempt,kind:r.kind,leaseId:run.leaseId,externalRef:r.externalRef},{deliveryId:'setup-'+seq,seq,occurredAt:'2026-01-01T00:00:00.000Z',message});}finally{f.syntheticEventSetup=false;}
    assert.equal(record.applied,true);assert.equal(f.store.recordEvent(r.scope,r.runId,record.event).applied,true);
    if(['completed','failed','interrupted'].includes(type))f.servers.get(r.name).turns.find(t=>t.id===run.turnId).status=type;
  };
  f.inputTarget=async mode=>{const r=await f.start();if(mode==='submit')f.emit(r,'completed');return {r,batch:f.queue(r,mode==='submit'?'continue':'correct')};};
  t.after(async()=>{for(const h of allHosts)await h.close();f.coordinator.close();f.scheduler.close();for(const j of journals)j.close();f.store.close();});
  return f;
}

test('Host bridge continues a terminal Task using its claimed new Run and original Session, preserving initial mapping',async t=>{
  const f=fixture(t),{r,batch}=await f.inputTarget('submit'),initial=structuredClone(f.journal().load().dispatches[0]);
  const result=await f.flush(r,batch),state=f.journal().load(),run=f.store.run(r.scope,result.deliveryRunId);
  assert.equal(result.state,'consumed');assert.equal(run.attempt,2);assert.notEqual(run.id,r.runId);assert.equal(run.task_id,r.taskId);assert.equal(run.dispatch_key,result.inputKey);
  assert.equal(run.state,'running');assert.equal(state.schemaVersion,2);assert.deepEqual(state.dispatches[0],initial);assert.equal(state.continuations[0].baseRunId,r.runId);
  assert.equal(state.continuations[0].phase,'accepted');assert.equal(state.inputs[0].phase,'accepted');assert.ok(result.receipt.receiptRef);assert.equal(result.receipt.externalRef,run.external_ref);
  assert.equal(f.count('thread/start'),1);assert.equal(f.count('turn/start'),2);assert.equal(f.store.run(r.scope,r.runId).state,'succeeded');
  assert.equal(f.store.task(r.scope,r.taskId).session_id,initial.sessionId);assert.equal(f.store.inputAttempt(r.scope,batch.batchId,result.attemptToken).request.externalRef,null);
  assert.equal((await f.coordinator.flush(r.scope,batch.batchId)).state,'consumed');assert.equal(f.count('turn/start'),2);
  await assert.rejects(f.host().dispatch(r.scope,r.taskId),{code:'HOST_RUN_CHANGED'});
  const target={...r,runId:run.id,attempt:2,externalRef:run.external_ref,dispatchKey:run.dispatch_key};
  const correction=await f.flush(target,f.queue(target));assert.equal(correction.state,'consumed');assert.equal(f.count('turn/start'),2);assert.equal(f.count('turn/steer'),1);
});

test('Host bridge retains multiple continuation Runs and distinct immutable receipts for one Task',async t=>{
  const f=fixture(t);let r=await f.start();
  for(let attempt=2;attempt<=4;attempt++){
    f.emit(r,'completed');const batch=f.queue(r,'continue'),result=await f.flush(r,batch),run=f.store.run(r.scope,result.deliveryRunId);
    assert.equal(result.state,'consumed');assert.equal(run.attempt,attempt);r={...r,runId:run.id,attempt,dispatchKey:run.dispatch_key,externalRef:run.external_ref};
  }
  const saved=f.journal().load();assert.equal(saved.dispatches.length,1);assert.equal(saved.continuations.length,3);assert.equal(new Set(saved.inputs.map(i=>i.receiptRef)).size,3);assert.equal(f.count('thread/start'),1);assert.equal(f.count('turn/start'),4);
});

test('Host bridge merges ordinary continuation fragments and corrects the original turn without a new Run',async t=>{
  const f=fixture(t),r=await f.start(),first=f.queue(r,'continue',{text:'first'}),second=f.queue(r,'continue',{text:'second'});assert.equal(first.batchId,second.batchId);
  const a=await f.flush(r,first),b=await f.flush(r,f.queue(r,'correct',{text:'correction'}));
  assert.equal(a.state,'consumed');assert.equal(b.state,'consumed');assert.equal(a.deliveryRunId,r.runId);assert.notEqual(a.receipt.receiptRef,b.receipt.receiptRef);
  const frames=f.calls.filter(c=>c.method==='turn/steer');assert.equal(frames.length,2);assert.equal(frames[0].params.input[0].text,'first\nsecond');assert.ok(frames.every(x=>x.params.expectedTurnId==='turn-1'));
  assert.equal(f.count('turn/start'),1);assert.equal(f.store.task(r.scope,r.taskId).current_run_id,r.runId);
});

test('Host bridge ordinary answer is tied to exact RPC/question version and cannot approve tools',async t=>{
  const f=fixture(t),r=await f.start();f.emit(r,'question',1);
  assert.throws(()=>f.queue(r,'answer',{questionId:'question-a',questionSeq:2}),{code:'STALE_INPUT_QUESTION'});
  const result=await f.flush(r,f.queue(r,'answer',{questionId:'question-a',questionSeq:1,text:'同意只是普通文本'}));
  assert.equal(result.state,'consumed');assert.equal(f.store.run(r.scope,r.runId).state,'running');assert.equal(f.responses.length,1);assert.equal(f.responses[0].id,'rpc-question-1');
  assert.deepEqual(f.responses[0].result,{answers:{'question-a':{answers:['同意只是普通文本']}}});assert.equal(f.count('turn/start'),1);
  f.emit(r,'approval',2);
  for(const operation of ['continue','correct','answer'])assert.throws(()=>f.queue(r,operation,operation==='answer'?{questionId:'question-a',questionSeq:1}:{}));
  assert.equal(f.store.run(r.scope,r.runId).state,'waiting_approval');assert.equal(f.responses.length,1);
});

test('Host bridge validates the complete durable claim including text/fragments/token and returns only the same receipt on duplicate inputKey',async t=>{
  const f=fixture(t),r=await f.start(),batch=f.queue(r);f.now+=250;const {request}=f.store.claimInput(r.scope,batch.batchId);
  for(const [key,value] of Object.entries({inputKey:'wrong-key',attemptToken:'wrong-token',runId:'wrong-run',baseRunId:'wrong-base',taskId:'wrong-task',attempt:9,kind:'chat',mode:'submit',operation:'continue',externalRef:'foreign-ref',text:'rewritten',questionId:'foreign-question',questionSeq:8,executionApproved:true,schemaVersion:2,fragments:[{eventId:'foreign-event',text:request.text}]}))assert.throws(()=>f.host().prepareInput({...request,[key]:value}));
  assert.throws(()=>f.host().prepareInput({...request,scope:testScope('b')}),{code:'HOST_SCOPE_MISMATCH'});
  const receive=f.host().prepareInput(request);assert.throws(()=>receive({...request,text:'receiver mutation'}),{code:'HOST_INPUT_REQUEST_MISMATCH'});
  const receipt=await receive(request);assert.deepEqual(await receive(request),receipt);assert.equal(f.count('turn/steer'),1);
  const done=f.store.completeInput(r.scope,batch.batchId,{...receipt,attemptToken:request.attemptToken});assert.equal(done.state,'consumed');f.host().confirmInput(request);
  assert.throws(()=>f.host().prepareInput(request),{code:'INPUT_REQUIRES_RECONCILIATION'});assert.equal(f.count('turn/steer'),1);
});

test('Host bridge rejects a queued Task or foreign unowned Run as ordinary input',async t=>{
  const f=fixture(t),r=await f.start(),task=f.newTask(),run=f.store.beginRun(r.scope,task.taskId,{dispatchKey:'foreign-unowned-run'});f.store.recordSubmission(r.scope,run.id,'foreign-external');
  const target={...r,taskId:task.taskId,runId:run.id,attempt:run.attempt,externalRef:'foreign-external'},result=await f.flush(target,f.queue(target));
  assert.equal(result.state,'unknown');assert.equal(f.count('turn/steer'),0);assert.equal(f.count('turn/start'),1);
});

test('Host bridge and InputCoordinator share a bounded scheduler without nested Session deadlock', {timeout:5000},async t=>{
  const f=fixture(t),r=await f.start(),entered=gate(),release=gate();let waits=0;
  f.prepare=async frame=>{if(frame.method==='turn/steer'&&waits++===0){entered.resolve();await release.promise;}};
  const first=f.queue(r,'continue'),second=f.queue(r,'correct');f.now+=250;
  const a=f.coordinator.flush(r.scope,first.batchId);await entered.promise;const b=f.coordinator.flush(r.scope,second.batchId);assert.equal(f.count('turn/steer'),0);release.resolve();
  assert.equal((await a).state,'consumed');assert.equal((await b).state,'consumed');assert.equal(f.count('turn/steer'),2);
  f.coordinator.close();assert.equal(await f.scheduler.submit(r.scope,'shared-scheduler-still-owned',()=>17),17);
});

const mutations={
  revoke:(f,r)=>f.store.revokePairing(r.scope),expire:f=>{f.now=200000;},stop:(f,r)=>f.store.stopBot(r.scope.botId),
  rePair:(f,r)=>f.store.grantPairing(r.scope,{expiresAt:100000}),
  rebind:f=>{const c=structuredClone(f.config);c.revision=2;c.bindings[0].version=2;c.agents[0].workspaceRef='project-y';f.store.installConfiguration(c);},
  policy:f=>{const c=structuredClone(f.config);c.revision=2;c.bindings.forEach(b=>b.version=2);c.policies[0].version=2;f.store.installConfiguration(c);},
  cancel:(f,r)=>f.store.requestCancel(r.scope,f.store.task(r.scope,r.taskId).current_run_id)
};
for(const mode of ['input','submit'])for(const point of ['receiver','adapter'])for(const [name,mutate] of Object.entries(mutations))
  test('Host bridge denies '+mode+' '+name+' during '+point+' preparation',async t=>{
    const f=fixture(t),{r,batch}=await f.inputTarget(mode),entered=gate(),release=gate();
    const wait=async()=>{entered.resolve();await release.promise;};if(point==='receiver')f.inputWait=wait;else f.prepare=async frame=>{if(frame.method===(mode==='input'?'turn/steer':'turn/start'))await wait();};
    f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;mutate(f,r);release.resolve();
    assert.equal((await pending).state,'unknown');assert.equal(f.count('turn/start'),1);assert.equal(f.count('turn/steer'),0);
    assert.equal((await f.coordinator.flush(r.scope,batch.batchId)).state,'unknown');
  });

for(const change of ['question','approval'])test('Host bridge rejects a stale ordinary answer after '+change+' changes in Adapter preparation',async t=>{
  const f=fixture(t),r=await f.start();f.emit(r,'question',1);const batch=f.queue(r,'answer',{questionId:'question-a',questionSeq:1}),entered=gate(),release=gate();
  f.prepare=async frame=>{if(frame.result){entered.resolve();await release.promise;}};
  f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;f.emit(r,change,2,'question-b');release.resolve();
  assert.equal((await pending).state,'unknown');assert.equal(f.responses.length,0);assert.equal(f.store.run(r.scope,r.runId).state,change==='approval'?'waiting_approval':'waiting_input');
});

for(const mode of ['input','submit'])test('Host bridge checks permission after '+mode+' response and never retries uncertain acceptance',async t=>{
  const f=fixture(t),{r,batch}=await f.inputTarget(mode),method=mode==='input'?'turn/steer':'turn/start';
  f.handler=async frame=>{if(frame.method===method)f.store.revokePairing(r.scope);};
  const result=await f.flush(r,batch);assert.equal(result.state,'unknown');assert.equal(f.count(method),mode==='input'?1:2);
  await f.coordinator.flush(r.scope,batch.batchId);assert.equal(f.count(method),mode==='input'?1:2);
});

for(const mode of ['input','submit'])for(const point of ['before-input-intent','before-input-send','after-input-adapter-receipt','after-input-host-receipt','before-input-host-confirmation'])
  test('Host bridge accounts for '+mode+' '+point+' fault without replay',async t=>{
    const f=fixture(t),{r,batch}=await f.inputTarget(mode);let armed=true;
    f.hostFault=p=>{if(armed&&p===point){armed=false;throw Error('synthetic durable gap');}};
    f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);
    if(point==='before-input-host-confirmation')await assert.rejects(pending);else assert.equal((await pending).state,'unknown');
    const turns=f.count('turn/start'),inputs=f.count('turn/steer'),runId=f.store.task(r.scope,r.taskId).current_run_id;f.hostFault=()=>{};
    f.makeHost();const recovered=f.host().recoverInput(r.scope,batch.batchId);
    if(point==='before-input-host-confirmation')assert.equal(recovered.state,'consumed');
    else if(point==='after-input-host-receipt'){
      const before=f.store.run(r.scope,runId).state;assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'consumed');assert.equal(f.store.run(r.scope,runId).state,before);
      assert.equal(f.host().recoverInput(r.scope,batch.batchId).state,'consumed');
    }else assert.equal(f.host().reconcileInput(r.scope,batch.batchId).reason,'DURABLE_INPUT_RECEIPT_REQUIRED');
    await f.coordinator.flush(r.scope,batch.batchId);assert.equal(f.count('turn/start'),turns);assert.equal(f.count('turn/steer'),inputs);assert.equal(f.store.task(r.scope,r.taskId).current_run_id,runId);
    if(mode==='submit')assert.equal(f.store.run(r.scope,runId).attempt,2);
  });

for(const mode of ['input','submit'])test('Host bridge recovers actual '+mode+' WorkStore completion rollback with input and Run reconciled separately',async t=>{
  const f=fixture(t),{r,batch}=await f.inputTarget(mode);f.storeFault=p=>{if(p==='before-input-completion-commit')throw Error('synthetic transaction rollback');};
  const result=await f.flush(r,batch),runId=result.deliveryRunId;assert.equal(result.state,'unknown');assert.equal(result.receipt,null);assert.ok(f.journal().load().inputs[0].receiptRef);
  f.storeFault=()=>{};f.makeHost();f.host().recoverInput(r.scope,batch.batchId);const before=f.store.run(r.scope,runId);
  assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'consumed');assert.deepEqual(f.store.run(r.scope,runId),before);
  if(mode==='submit'){assert.equal(before.state,'unknown');assert.equal(before.external_ref,null);}
  f.host().recover(r.scope,r.taskId);assert.equal((await f.host().reconcile(r.scope,r.taskId)).state,'running');
  assert.equal(f.store.inputBatch(r.scope,batch.batchId).state,'consumed');assert.equal(f.count('turn/start'),mode==='submit'?2:1);assert.equal(f.count('turn/steer'),mode==='input'?1:0);
});

test('Host bridge Run reconciliation cannot substitute for a missing ordinary input receipt',async t=>{
  const f=fixture(t),r=await f.start(),batch=f.queue(r);f.hostFault=p=>{if(p==='after-input-adapter-receipt')throw Error('lost Host input receipt');};
  assert.equal((await f.flush(r,batch)).state,'unknown');f.hostFault=()=>{};f.makeHost();f.host().recover(r.scope,r.taskId);
  assert.equal((await f.host().reconcile(r.scope,r.taskId)).state,'running');assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'unknown');assert.equal(f.count('turn/steer'),1);
});

test('Host bridge preserves question state when an accepted answer completion rolls back',async t=>{
  const f=fixture(t),r=await f.start();f.emit(r,'question',1);const batch=f.queue(r,'answer',{questionId:'question-a',questionSeq:1});
  f.storeFault=p=>{if(p==='before-input-completion-commit')throw Error('answer rollback');};assert.equal((await f.flush(r,batch)).state,'unknown');f.storeFault=()=>{};
  assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'consumed');assert.equal(f.store.run(r.scope,r.runId).state,'waiting_input');assert.equal(f.responses.length,1);
});

for(const mode of ['input','submit'])for(const boundary of ['intent','receipt','confirmation'])test('Host bridge '+mode+' journal '+boundary+' failure retains durable state and cannot report success',async t=>{
  const f=fixture(t),{r,batch}=await f.inputTarget(mode);
  if(boundary==='intent')f.hostJournalFault=p=>{if(p==='before-commit')throw Error('intent storage unavailable');};
  else f.hostFault=p=>{if(p===(boundary==='receipt'?'after-input-adapter-receipt':'before-input-host-confirmation'))f.hostJournalFault=where=>{if(where===(boundary==='receipt'?'after-commit':'before-commit'))throw Error('journal fault');};};
  f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);if(boundary==='confirmation')await assert.rejects(pending,{code:'HOST_JOURNAL_UNAVAILABLE'});else assert.equal((await pending).state,'unknown');
  const turns=f.count('turn/start'),inputs=f.count('turn/steer');f.hostJournalFault=()=>{};f.hostFault=()=>{};f.makeHost();
  const recovered=f.host().recoverInput(r.scope,batch.batchId);if(boundary==='confirmation')assert.equal(recovered.state,'consumed');
  else if(boundary==='receipt')assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'consumed');
  else assert.equal(recovered.reason,'HOST_INPUT_INTENT_ABSENT');
  await f.coordinator.flush(r.scope,batch.batchId);assert.equal(f.count('turn/start'),turns);assert.equal(f.count('turn/steer'),inputs);
});

for(const mode of ['input','submit'])test('Host bridge '+mode+' Adapter journal failure after acceptance stays unknown without guessing latest turn',async t=>{
  const f=fixture(t),{r,batch}=await f.inputTarget(mode),method=mode==='submit'?'turn/start':'turn/steer';
  f.handler=async frame=>{if(frame.method===method)f.adapterJournalFault=p=>{if(p==='before-commit')throw Error('Adapter receipt storage unavailable');};};
  assert.equal((await f.flush(r,batch)).state,'unknown');f.adapterJournalFault=()=>{};f.handler=async()=>undefined;f.makeHost();f.host().recoverInput(r.scope,batch.batchId);
  assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'unknown');assert.equal(f.count('turn/start'),mode==='submit'?2:1);assert.equal(f.count('turn/steer'),mode==='input'?1:0);
});

test('Host bridge fences a delayed old input receiver after lifecycle reopen',async t=>{
  const f=fixture(t),r=await f.start(),batch=f.queue(r),entered=gate(),release=gate();
  f.prepare=async frame=>{if(frame.method==='turn/steer'){entered.resolve();await release.promise;}};
  f.now+=250;const pending=f.coordinator.flush(r.scope,batch.batchId);await entered.promise;f.makeHost();f.host().recoverInput(r.scope,batch.batchId);release.resolve();
  assert.equal((await pending).state,'unknown');assert.equal(f.count('turn/steer'),0);assert.equal((await f.coordinator.flush(r.scope,batch.batchId)).state,'unknown');
});

test('Host bridge keeps input failure and lifecycle independent between Agent instances',async t=>{
  const f=fixture(t),a=await f.start(),b=await f.start('b');
  f.prepare=async(frame,name)=>{if(name==='a'&&frame.method==='turn/steer')throw Error('synthetic single instance failure');};
  const [bad,good]=await Promise.all([f.flush(a,f.queue(a)),f.flush(b,f.queue(b))]);assert.equal(bad.state,'unknown');assert.equal(good.state,'consumed');
  await f.host().close();assert.equal((await f.flush(b,f.queue(b))).state,'consumed');assert.equal(f.count('turn/steer','b'),2);assert.equal(f.count('turn/start','b'),1);
});

test('Host bridge enforces bounded per Run input history without deleting accepted operations',async t=>{
  const f=fixture(t),r=await f.start();
  for(let i=0;i<64;i++)assert.equal((await f.flush(r,f.queue(r))).state,'consumed');
  assert.equal((await f.flush(r,f.queue(r))).state,'unknown');assert.equal(f.journal().load().inputs.length,64);assert.equal(f.count('turn/steer'),64);assert.equal(f.adapterJournal().load().runs[0].operations.length,64);
});

test('Host v2 recovers an actual v1 snapshot, fences old objects, rejects old readers and restores actual old code plus full snapshot',async t=>{
  const f=fixture(t,{old:true}),r=await f.start(),before=f.journal().load();assert.equal(before.schemaVersion,1);
  const original=f.host(),originalJournal=f.journal(),backup=path.join(f.directory,'journal-v1-backup.sqlite');
  const db=new DatabaseSync(path.join(f.directory,'journal.sqlite'));try{db.exec('VACUUM INTO '+"'"+backup.replaceAll("'","''")+"'");}finally{db.close();}
  f.makeHost();const migrated=f.journal().load();assert.equal(migrated.schemaVersion,2);assert.equal(migrated.revision,before.revision+1);assert.deepEqual(migrated.dispatches[0],{...before.dispatches[0],phase:'unknown'});
  assert.deepEqual(migrated.continuations,[]);assert.deepEqual(migrated.inputs,[]);assert.equal(migrated.sessions[0].sessionRef,before.sessions[0].sessionRef);
  assert.throws(()=>originalJournal.load(),{code:'JOURNAL_SNAPSHOT_VERSION_UNSUPPORTED'});assert.throws(()=>original.dispatch(r.scope,r.taskId),{code:'HOST_JOURNAL_FENCED'});
  assert.throws(()=>new HostV1({store:f.store,hostId:'host-test',agent:migrated.agent,configuration:f.config,journal:f.journal(),adapterJournal:f.adapterJournal(),prepareAdapter:async()=>{throw Error('must not prepare');}}),{code:'HOST_JOURNAL_MISMATCH'});
  f.host().recover(r.scope,r.taskId);assert.equal((await f.host().reconcile(r.scope,r.taskId)).state,'running');assert.equal(f.count('turn/start'),1);
  const rollback=f.makeHost('a',{Host:HostV1,Journal:JournalV1,database:backup});assert.equal(f.journal().load().schemaVersion,1);rollback.recover(r.scope,r.taskId);
  assert.equal((await rollback.reconcile(r.scope,r.taskId)).state,'running');assert.equal(f.count('turn/start'),1);assert.equal(f.store.run(r.scope,r.runId).external_ref,r.externalRef);
  const provenance=JSON.parse(readFileSync(new URL('./fixtures/offline-host-v1-source.json',import.meta.url)));assert.match(provenance.host,/^[a-f0-9]{64}$/);assert.match(provenance.journal,/^[a-f0-9]{64}$/);
});

test('Host v2 rejects future snapshots without modifying their revision',async t=>{
  const f=fixture(t),saved=f.journal().load();saved.schemaVersion=3;saved.revision++;
  const writer=new SqliteJournal(path.join(f.directory,'journal.sqlite'),{hostId:'host-test',agentId:'agent-a',channel:'host',snapshotVersions:[2,3]});t.after(()=>writer.close());assert.equal(writer.commit(saved,saved.revision-1),true);
  assert.throws(()=>f.makeHost(),{code:'JOURNAL_SNAPSHOT_VERSION_UNSUPPORTED'});assert.equal(writer.load().revision,saved.revision);
});

test('Host bridge does not replace a conflicting late persisted input receipt during explicit reconciliation',async t=>{
  const f=fixture(t),r=await f.start(),batch=f.queue(r);f.storeFault=p=>{if(p==='before-input-completion-commit')throw Error('rollback for late receipt');};
  assert.equal((await f.flush(r,batch)).state,'unknown');f.storeFault=()=>{};const saved=f.store.inputBatch(r.scope,batch.batchId),input=f.journal().load().inputs[0];
  f.store.completeInput(r.scope,batch.batchId,{attemptToken:saved.attemptToken,receiptRef:'conflicting-receipt',externalRef:r.externalRef});
  assert.throws(()=>f.host().reconcileInput(r.scope,batch.batchId),{code:'HOST_INPUT_RECEIPT_CONFLICT'});
  assert.equal(f.store.inputBatch(r.scope,batch.batchId).receipt.receiptRef,'conflicting-receipt');assert.equal(f.journal().load().inputs[0].receiptRef,input.receiptRef);assert.equal(f.count('turn/steer'),1);
});

test('Host bridge recovers a continuation Run reference only through its owned Adapter and leaves a missing input receipt unknown',async t=>{
  const f=fixture(t),{r,batch}=await f.inputTarget('submit');f.hostFault=p=>{if(p==='after-input-adapter-receipt')throw Error('lost continuation receipt');};
  const result=await f.flush(r,batch),reference=f.adapterJournal().load().runs.find(x=>x.runId===result.deliveryRunId).externalRef;assert.equal(result.state,'unknown');assert.ok(reference);
  f.hostFault=()=>{};f.makeHost();f.host().recover(r.scope,r.taskId);
  assert.equal((await f.host().reconcile(r.scope,r.taskId)).reason,'TRUSTED_REFERENCE_EVIDENCE_REQUIRED');
  assert.equal((await f.host().reconcile(r.scope,r.taskId,{externalRef:r.externalRef,basisRef:'synthetic-wrong-Run'})).state,'unknown');
  assert.equal((await f.host().reconcile(r.scope,r.taskId,{externalRef:reference,basisRef:'synthetic-owned-receipt'})).state,'running');
  assert.equal(f.host().reconcileInput(r.scope,batch.batchId).state,'unknown');assert.equal(f.count('turn/start'),2);assert.equal(f.journal().load().dispatches[0].externalRef,r.externalRef);
});

test('Host bridge preserves cancellation when it races a synthetic ordinary answer receipt',async t=>{
  const f=fixture(t),r=await f.start();f.emit(r,'question',1);const batch=f.queue(r,'answer',{questionId:'question-a',questionSeq:1});
  f.answerHandler=async()=>f.store.requestCancel(r.scope,r.runId);
  assert.equal((await f.flush(r,batch)).state,'unknown');assert.equal(f.responses.length,1);assert.equal(f.store.run(r.scope,r.runId).state,'cancelling');
  assert.equal((await f.coordinator.flush(r.scope,batch.batchId)).state,'unknown');assert.equal(f.responses.length,1);
});
