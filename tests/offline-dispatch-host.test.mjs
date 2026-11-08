import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { SqliteJournal } from '../packages/storage/sqlite-journal.mjs';
import { OfflineDispatchHost } from '../packages/host-control/offline-dispatch-host.mjs';
import { InputCoordinator } from '../packages/host-control/input-coordinator.mjs';
import { AdapterRegistry } from '../packages/core/adapter-registry.mjs';
import { SessionScheduler } from '../packages/core/session-scheduler.mjs';
import { registerCodexOffline } from '../packages/adapters/codex/offline-adapter.mjs';
import { DESCRIPTOR, PINNED_PROTOCOL } from '../packages/adapters/codex/protocol.mjs';
import { configuration, testScope, event } from './foundation-fixtures.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{scheduler}={}){
  const root=process.env.QQ_TEST_ROOT??path.resolve('QQ插件运行目录/test-work');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'dispatch-')),hosts=[],journals=[];
  const f={now:1000,calls:[],transports:[],factoryCount:0,prepare:async()=>{},factoryWait:async()=>{},handler:async()=>undefined,hostFault:()=>{},storeFault:()=>{},hostJournalFault:()=>{},adapterJournalFault:()=>{},servers:new Map()};
  f.directory=directory;
  f.config=configuration();for(const agent of f.config.agents){agent.adapterId=DESCRIPTOR.id;agent.modelRef='synthetic-model-a';}
  f.store=new WorkStore(path.join(directory,'work.sqlite'),{hostId:'host-test',clock:()=>f.now,fault:stage=>f.storeFault(stage)});f.store.installConfiguration(f.config);
  for(const name of ['a','b'])f.store.grantPairing(testScope(name),{expiresAt:100000});
  f.coordinator=new InputCoordinator({store:f.store,prepareDispatch:async()=>{throw Error('ordinary input combination is a later step');}});
  f.newTask=(name='a',extra={})=>f.coordinator.accept(testScope(name),{eventId:'new-'+name+'-'+(++f.taskCount),operation:'new',kind:'work',text:'synthetic initial work',...extra});f.taskCount=0;
  f.count=(method,name='a')=>f.calls.filter(x=>x.method===method&&x.agentId==='agent-'+name).length;
  f.makeHost=(name='a',extra={})=>{
    const s=testScope(name),database=path.join(directory,'journal.sqlite');
    const journal=new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'host',snapshotVersions:[1,2],fault:stage=>f.hostJournalFault(stage)});
    const adapterJournal=new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'adapter',fault:stage=>f.adapterJournalFault(stage)});journals.push(journal,adapterJournal);
    f.journal=journal;f.adapterJournal=adapterJournal;
    const host=new OfflineDispatchHost({store:f.store,hostId:s.hostId,agent:{id:s.agentId,adapterId:DESCRIPTOR.id,modelRef:'synthetic-model-a'},configuration:f.config,journal,adapterJournal,scheduler, fault:stage=>f.hostFault(stage),
      prepareAdapter:async({context,journal,authorize})=>{
        f.factoryCount++;await f.factoryWait(context);
        if(!f.servers.has(context.agentId))f.servers.set(context.agentId,{threads:0,turns:[]});
        const server=f.servers.get(context.agentId),transport={mode:'synthetic',protocolVersion:PINNED_PROTOCOL,hostId:context.hostId,agentId:context.agentId,closed:false,
          prepare:frame=>f.prepare(frame,context),
          request:async frame=>{
            f.calls.push({...structuredClone(frame),agentId:context.agentId});
            const response=await f.handler(frame,context);if(response!==undefined)return response;
            switch(frame.method){
              case 'initialize':return {userAgent:'synthetic codex/0.163.0-alpha.11.2'};
              case 'model/list':return {data:[{model:'synthetic-model-a',hidden:false}],nextCursor:null};
              case 'thread/start':return {thread:{id:'thread-'+(++server.threads),ephemeral:true},model:frame.params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
              case 'turn/start':{const turn={id:'turn-'+(server.turns.length+1),status:'inProgress',items:[]};server.turns.push(turn);return {turn:structuredClone(turn)};}
              case 'thread/read':return {thread:{id:frame.params.threadId,turns:structuredClone(server.turns)}};
              default:assert.fail('unexpected synthetic request');
            }
          },notify:async()=>{},respond:async()=>({accepted:true}),close:async()=>{transport.closed=true;}
        };f.transports.push(transport);
        const registry=new AdapterRegistry();registerCodexOffline(registry,()=>({transport,journal,authorize}));
        const adapter=registry.create({id:context.agentId,adapterId:context.adapterId},context);f.adapter=adapter;return adapter;
      },...extra});hosts.push(host);return host;
  };
  f.host=f.makeHost();
  t.after(async()=>{for(const h of hosts)await h.close();f.coordinator.close();for(const j of journals)j.close();f.store.close();});return f;
}
test('offline Host dispatches InputCoordinator queued Task with original lease, persisted Run, journals and Registry',async t=>{
  const f=fixture(t),s=testScope(),task=f.newTask();assert.equal(task.state,'queued');assert.equal(f.factoryCount,0);
  f.handler=async frame=>{if(frame.method==='turn/start'){
    const stored=f.store.task(s,task.taskId),run=f.store.run(s,stored.current_run_id),intent=f.journal.load().dispatches[0],adapter=f.adapterJournal.load().runs[0];
    assert.equal(run.state,'dispatching');assert.equal(intent.runId,run.id);assert.equal(adapter.runId,run.id);assert.equal(adapter.leaseId,f.store.dispatchContext(s,task.taskId,run.id).leaseId);assert.equal(intent.phase,'preparing');
  }};
  const result=await f.host.dispatch(s,task.taskId);assert.equal(result.state,'running');assert.equal(result.executionApproved,false);assert.equal(f.count('turn/start'),1);
  assert.equal(f.store.run(s,result.runId).external_ref,result.externalRef);assert.equal(f.journal.load().dispatches[0].phase,'accepted');
  assert.equal((await f.host.dispatch(s,task.taskId)).runId,result.runId);assert.equal(f.count('turn/start'),1);
});
test('offline Host serializes a Session and leaves its next Task queued while a Run is active',async t=>{
  const f=fixture(t),a=f.newTask(),b=f.newTask();const entered=gate(),release=gate();
  f.prepare=async frame=>{if(frame.method==='turn/start'){entered.resolve();await release.promise;}};
  const first=f.host.dispatch(testScope(),a.taskId);await entered.promise;const second=f.host.dispatch(testScope(),b.taskId);release.resolve();await first;
  await assert.rejects(second,{code:'HOST_SESSION_BUSY'});assert.equal(f.store.task(testScope(),b.taskId).state,'queued');assert.equal(f.count('turn/start'),1);
});
test('offline Host requires full owner scope and does not dispatch another Agent Task',async t=>{
  const f=fixture(t),task=f.newTask('b');assert.throws(()=>f.host.dispatch(testScope('b'),task.taskId),{code:'HOST_SCOPE_MISMATCH'});
  await assert.rejects(f.host.dispatch(testScope(),task.taskId),{code:'SCOPED_NOT_FOUND'});assert.equal(f.factoryCount,0);
});
const mutations={
  revoke:f=>f.store.revokePairing(testScope()),
  expire:f=>{f.now=200000;},
  stop:f=>f.store.stopBot('bot-a'),
  rePair:f=>f.store.grantPairing(testScope(),{expiresAt:100000}),
  rebind:f=>{const c=structuredClone(f.config);c.revision=2;c.bindings[0].version=2;c.agents[0].workspaceRef='project-y';f.store.installConfiguration(c);},
  policy:f=>{const c=structuredClone(f.config);c.revision=2;c.bindings.forEach(x=>x.version=2);c.policies[0].version=2;f.store.installConfiguration(c);}
};
for(const point of ['factory','thread/start','turn/start'])for(const [name,mutate]of Object.entries(mutations))
  test('offline Host denies '+name+' during '+point+' asynchronous preparation',async t=>{
    const f=fixture(t),task=f.newTask(),entered=gate(),release=gate();
    const wait=async()=>{entered.resolve();await release.promise;};
    if(point==='factory')f.factoryWait=wait;else f.prepare=async frame=>{if(frame.method===point)await wait();};
    const pending=f.host.dispatch(testScope(),task.taskId);await entered.promise;mutate(f);release.resolve();
    const result=await pending;assert.equal(result.state,'unknown');assert.equal(f.count('turn/start'),0);
    const duplicate=await f.host.dispatch(testScope(),task.taskId);assert.equal(duplicate.runId,result.runId);assert.equal(f.count('turn/start'),0);
  });
test('offline Host checks permission after a synthetic turn response and does not retry uncertain acceptance',async t=>{
  const f=fixture(t),task=f.newTask();f.handler=async frame=>{if(frame.method==='turn/start'){f.store.revokePairing(testScope());return {turn:{id:'late-turn',status:'inProgress',items:[]}};}};
  const r=await f.host.dispatch(testScope(),task.taskId);assert.equal(r.state,'unknown');assert.equal(r.externalRef,null);assert.equal(f.count('turn/start'),1);
  const host=f.makeHost();host.recover(testScope(),task.taskId);assert.equal((await host.dispatch(testScope(),task.taskId)).state,'unknown');assert.equal(f.count('turn/start'),1);
});
for(const point of ['after-run-intent','after-session-receipt','before-submit','after-adapter-receipt','before-store-confirmation','after-store-confirmation'])
  test('offline Host accounts for '+point+' fault and never creates a replacement Run',async t=>{
    const f=fixture(t),task=f.newTask();let armed=true;f.hostFault=stage=>{if(armed&&stage===point){armed=false;throw Error('synthetic crash boundary');}};
    const r=await f.host.dispatch(testScope(),task.taskId);assert.equal(r.state,'unknown');const count=f.count('turn/start');
    const next=f.makeHost(),recovered=next.recover(testScope(),task.taskId);assert.equal(recovered.runId,r.runId);assert.equal(f.store.run(testScope(),r.runId).state,'unknown');
    try{await next.dispatch(testScope(),task.taskId);}catch(error){assert.equal(error.code,'HOST_INITIAL_QUEUED_TASK_REQUIRED');}
    assert.equal(f.store.task(testScope(),task.taskId).current_run_id,r.runId);assert.equal(f.count('turn/start'),count);
    if(['before-store-confirmation','after-store-confirmation'].includes(point)){assert.equal((await next.reconcile(testScope(),task.taskId)).state,'running');assert.equal(f.count('turn/start'),1);}
  });
test('offline Host recovers a lost external reference only with explicit evidence verified by owned Adapter mapping',async t=>{
  const f=fixture(t),task=f.newTask();let armed=true;f.hostFault=stage=>{if(armed&&stage==='after-adapter-receipt'){armed=false;throw Error('lost host receipt');}};
  const r=await f.host.dispatch(testScope(),task.taskId),reference=f.adapterJournal.load().runs[0].externalRef;assert.equal(r.externalRef,null);assert.ok(reference);
  const next=f.makeHost();next.recover(testScope(),task.taskId);
  assert.equal((await next.reconcile(testScope(),task.taskId)).reason,'TRUSTED_REFERENCE_EVIDENCE_REQUIRED');assert.equal(f.count('thread/read'),0);
  assert.equal((await next.reconcile(testScope(),task.taskId,{externalRef:'foreign-desktop-ref',basisRef:'synthetic-manual-evidence'})).state,'unknown');
  const result=await next.reconcile(testScope(),task.taskId,{externalRef:reference,basisRef:'synthetic-durable-adapter-receipt'});assert.equal(result.state,'running');assert.equal(result.runId,r.runId);assert.equal(f.count('turn/start'),1);
  await assert.rejects(next.reconcile(testScope(),task.taskId,{externalRef:'replacement',basisRef:'synthetic-conflict'}),{code:'HOST_REFERENCE_CONFLICT'});
});
test('offline Host keeps a submission without a correlated turn unknown even if upstream latest turn exists',async t=>{
  const f=fixture(t),task=f.newTask();f.handler=async frame=>{if(frame.method==='turn/start'){f.servers.get('agent-a').turns.push({id:'unassociated',status:'inProgress',items:[]});throw Error('lost response');}};
  const r=await f.host.dispatch(testScope(),task.taskId);assert.equal(r.state,'unknown');
  const next=f.makeHost();next.recover(testScope(),task.taskId);assert.equal((await next.reconcile(testScope(),task.taskId)).state,'unknown');assert.equal(f.count('thread/read'),0);assert.equal(f.count('turn/start'),1);
});
test('offline Host intent journal failure cannot report success and orphan Run recovery never resubmits',async t=>{
  const f=fixture(t),task=f.newTask();f.hostJournalFault=stage=>{if(stage==='before-commit')throw Error('synthetic disk fault');};
  await assert.rejects(f.host.dispatch(testScope(),task.taskId),{code:'HOST_JOURNAL_UNAVAILABLE'});const runId=f.store.task(testScope(),task.taskId).current_run_id;assert.ok(runId);assert.equal(f.count('turn/start'),0);
  f.hostJournalFault=()=>{};const next=f.makeHost();assert.equal(next.recover(testScope(),task.taskId).reason,'HOST_INTENT_ABSENT');assert.equal(f.store.run(testScope(),runId).state,'unknown');
  await assert.rejects(next.dispatch(testScope(),task.taskId),{code:'HOST_INITIAL_QUEUED_TASK_REQUIRED'});assert.equal(f.count('turn/start'),0);
});
test('offline Host recovers an ambiguous durable host receipt commit without redoing a turn',async t=>{
  const f=fixture(t),task=f.newTask();f.hostFault=stage=>{if(stage==='after-adapter-receipt')f.hostJournalFault=where=>{if(where==='after-commit')throw Error('synthetic ack loss');};};
  await assert.rejects(f.host.dispatch(testScope(),task.taskId),{code:'HOST_JOURNAL_UNAVAILABLE'});assert.ok(f.journal.load().dispatches[0].externalRef);
  f.hostJournalFault=()=>{};const next=f.makeHost();next.recover(testScope(),task.taskId);assert.equal((await next.reconcile(testScope(),task.taskId)).state,'running');assert.equal(f.count('turn/start'),1);
});
test('offline Host preserves unknown if Adapter journal failed after synthetic acceptance',async t=>{
  const f=fixture(t),task=f.newTask();f.handler=async frame=>{if(frame.method==='turn/start')f.adapterJournalFault=where=>{if(where==='before-commit')throw Error('synthetic adapter storage fault');};};
  const r=await f.host.dispatch(testScope(),task.taskId);assert.equal(r.state,'unknown');assert.equal(f.count('turn/start'),1);
  f.adapterJournalFault=()=>{};const next=f.makeHost();next.recover(testScope(),task.taskId);assert.equal((await next.reconcile(testScope(),task.taskId)).state,'unknown');assert.equal(f.count('turn/start'),1);
});
test('offline Host handles actual WorkStore reference transaction rollback and explicit reconciliation',async t=>{
  const f=fixture(t),task=f.newTask();f.storeFault=stage=>{if(stage==='before-submission-commit')throw Error('synthetic WorkStore rollback');};
  const r=await f.host.dispatch(testScope(),task.taskId);assert.equal(r.state,'unknown');assert.equal(f.store.run(testScope(),r.runId).external_ref,null);assert.ok(r.externalRef);
  f.storeFault=()=>{};assert.equal((await f.host.reconcile(testScope(),task.taskId)).state,'running');assert.equal(f.count('turn/start'),1);
});
test('offline Host reopening fences a delayed old object before the accepting entry',async t=>{
  const f=fixture(t),task=f.newTask(),entered=gate(),release=gate();
  f.prepare=async frame=>{if(frame.method==='turn/start'){entered.resolve();await release.promise;}};
  const old=f.host.dispatch(testScope(),task.taskId);await entered.promise;const next=f.makeHost();next.recover(testScope(),task.taskId);release.resolve();
  await assert.rejects(old);assert.equal(f.count('turn/start'),0);assert.equal((await next.dispatch(testScope(),task.taskId)).state,'unknown');
});
test('offline Host closing one Agent preserves another transport, journal and shared scheduler',async t=>{
  const scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1}),f=fixture(t,{scheduler});t.after(()=>scheduler.close());
  const b=f.makeHost('b'),aTask=f.newTask(),bTask=f.newTask('b');const [aResult,bResult]=await Promise.all([f.host.dispatch(testScope(),aTask.taskId),b.dispatch(testScope('b'),bTask.taskId)]);
  assert.notEqual(aResult.externalRef,bResult.externalRef);assert.equal(f.count('turn/start'),1);assert.equal(f.count('turn/start','b'),1);
  await f.host.close();assert.equal(f.transports.find(x=>x.agentId==='agent-a').closed,true);assert.equal(f.transports.find(x=>x.agentId==='agent-b').closed,false);
  assert.equal((await b.dispatch(testScope('b'),bTask.taskId)).state,'running');assert.equal(await scheduler.submit(testScope('b'),'another-scheduled-operation',()=>7),7);
});
for(const state of ['waiting_input','waiting_approval','cancelling'])test('offline Host recovery does not clear persisted '+state+' intent',async t=>{
  const f=fixture(t),s=testScope(),task=f.newTask(),r=await f.host.dispatch(s,task.taskId),adapterState=f.adapterJournal.load(),saved=adapterState.runs[0];
  const target={scope:s,taskId:task.taskId,runId:r.runId,attempt:r.attempt,kind:'work',leaseId:saved.leaseId,externalRef:r.externalRef};
  if(state==='cancelling'){
    // Synthetic persisted Adapter intent; generic cancel transport remains out
    // of this initial-dispatch step. Journal is trusted test setup only.
    saved.cancelRequested=true;saved.state='cancelling';adapterState.revision++;assert.equal(f.adapterJournal.commit(adapterState,adapterState.revision-1),true);f.store.requestCancel(s,r.runId);
  }else{
    const message=state==='waiting_input'?{method:'item/tool/requestUserInput',id:'rpc-question',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-question',isBlocking:true,questions:[{id:'question-a',header:'Question',question:'Synthetic?'}]}}:{method:'item/fileChange/requestApproval',id:'rpc-approval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-approval',startedAtMs:1}};
    const record=f.adapter.ingest(f.journal.load().sessions[0].sessionRef,target,{deliveryId:'delivery-2',seq:2,occurredAt:'2026-01-01T00:00:00.000Z',message});f.store.recordEvent(s,r.runId,record.event);
  }
  const next=f.makeHost();next.recover(s,task.taskId);assert.equal(f.store.run(s,r.runId).state,state);
  assert.equal((await next.reconcile(s,task.taskId)).state,'unknown');assert.equal(f.store.run(s,r.runId).state,state);assert.equal(f.count('turn/start'),1);
});
test('offline Host initial API leaves terminal continuation as a separate registered Run',async t=>{
  const f=fixture(t),s=testScope(),task=f.newTask(),r=await f.host.dispatch(s,task.taskId);
  f.store.recordEvent(s,r.runId,event(1,'run.succeeded',{summary:'synthetic terminal'},r.dispatchKey));
  const batch=f.coordinator.accept(s,{eventId:'continue-terminal',operation:'continue',kind:'work',taskId:task.taskId,runId:r.runId,attempt:r.attempt,text:'synthetic continuation'});f.now+=250;
  assert.equal((await f.coordinator.flush(s,batch.batchId)).state,'unknown');const newRunId=f.store.task(s,task.taskId).current_run_id;assert.notEqual(newRunId,r.runId);assert.equal(f.store.run(s,newRunId).attempt,2);
  assert.throws(()=>f.host.recover(s,task.taskId),{code:'HOST_RUN_CHANGED'});await assert.rejects(f.host.dispatch(s,task.taskId),{code:'HOST_RUN_CHANGED'});assert.equal(f.count('turn/start'),1);
});
test('offline Host explicit Adapter and model must match the installed per-Bot configuration identity',async t=>{
  const f=fixture(t),task=f.newTask(),other=structuredClone(f.config);other.agents[0].modelRef='another-explicit-model';
  assert.throws(()=>f.makeHost('a',{configuration:other}),{code:'HOST_AGENT_CONFIGURATION_MISMATCH'});
  const altered=structuredClone(f.config);altered.bots[0].credentialRef='synthetic-other-reference';
  const host=f.makeHost('a',{configuration:altered});await assert.rejects(host.dispatch(testScope(),task.taskId),{code:'HOST_AGENT_CONFIGURATION_MISMATCH'});assert.equal(f.store.task(testScope(),task.taskId).state,'queued');assert.equal(f.count('turn/start'),0);
});
test('offline Host Run reconciliation does not mark an independent unknown input consumed or replay it',async t=>{
  const f=fixture(t),s=testScope(),task=f.newTask(),r=await f.host.dispatch(s,task.taskId);
  const input=f.coordinator.accept(s,{eventId:'ordinary-correction',operation:'correct',kind:'work',taskId:task.taskId,runId:r.runId,attempt:r.attempt,text:'synthetic correction'});f.now+=250;
  assert.equal((await f.coordinator.flush(s,input.batchId)).state,'unknown');
  const next=f.makeHost();next.recover(s,task.taskId);assert.equal((await next.reconcile(s,task.taskId)).state,'running');
  assert.equal(f.store.inputBatch(s,input.batchId).state,'unknown');assert.equal((await f.coordinator.flush(s,input.batchId)).state,'unknown');assert.equal(f.count('turn/start'),1);
});
test('offline Host composes a generic synthetic Adapter through Registry without a concrete Runtime branch',async t=>{
  const f=fixture(t),c=structuredClone(f.config);c.revision=2;c.bindings[0].version=2;c.agents[0].adapterId='synthetic-generic-host';f.store.installConfiguration(c);
  const s=testScope('a',{bindingVersion:2});f.store.grantPairing(s,{expiresAt:100000});
  const journal=new SqliteJournal(path.join(f.directory,'generic.sqlite'),{hostId:s.hostId,agentId:s.agentId,channel:'host',snapshotVersions:[1,2]}),adapterJournal=new SqliteJournal(path.join(f.directory,'generic.sqlite'),{hostId:s.hostId,agentId:s.agentId,channel:'adapter'});
  let submissions=0,closed=false;
  const host=new OfflineDispatchHost({store:f.store,hostId:s.hostId,agent:{id:s.agentId,adapterId:c.agents[0].adapterId,modelRef:c.agents[0].modelRef},configuration:c,journal,adapterJournal,
    prepareAdapter:async({context,journal:storage,authorize})=>{
      const registry=new AdapterRegistry();registry.register({...DESCRIPTOR,id:context.adapterId},()=>{
        const prior=storage.load(),revision=prior?.revision??0;assert.equal(storage.commit({schemaVersion:1,revision:revision+1,owner:{hostId:s.hostId,agentId:s.agentId}},revision),true);
        return {probe:async()=>({synthetic:true}),openSession:async(value,request)=>{assert.equal(authorize({scope:value,sessionId:request.sessionId,executionApproved:false}),true);return {sessionRef:'generic-session',state:'open'};},
          submit:async(ref,request,key)=>{assert.equal(ref,'generic-session');assert.equal(authorize(request),true);assert.equal(authorize({...request,executionApproved:true}),false);submissions++;return {dispatchKey:key,externalRef:'generic-owned-reference',state:'running'};},
          sendInput:async()=>{throw Error('not in this step');},cancel:async()=>{throw Error('not in this step');},reconcile:async()=>{throw Error('not needed');},events:()=>[],close:async()=>{closed=true;}};
      });return registry.create({id:context.agentId,adapterId:context.adapterId},context);
    }});
  t.after(async()=>{await host.close();journal.close();adapterJournal.close();});
  const task=f.coordinator.accept(s,{eventId:'generic-initial',operation:'new',kind:'chat',text:'synthetic generic work'}),result=await host.dispatch(s,task.taskId);
  assert.equal(result.state,'running');assert.equal(result.externalRef,'generic-owned-reference');assert.equal(submissions,1);assert.equal(f.count('turn/start'),0);await host.close();assert.equal(closed,true);
});
