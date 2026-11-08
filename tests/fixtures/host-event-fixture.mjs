import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { WorkStore } from '../../packages/storage/work-store.mjs';
import { SqliteJournal } from '../../packages/storage/sqlite-journal.mjs';
import { OfflineDispatchHost } from '../../packages/host-control/offline-dispatch-host.mjs';
import { InputCoordinator } from '../../packages/host-control/input-coordinator.mjs';
import { AdapterRegistry } from '../../packages/core/adapter-registry.mjs';
import { SessionScheduler } from '../../packages/core/session-scheduler.mjs';
import { registerCodexOffline } from '../../packages/adapters/codex/offline-adapter.mjs';
import { DESCRIPTOR, PINNED_PROTOCOL } from '../../packages/adapters/codex/protocol.mjs';
import { configuration, testScope } from '../foundation-fixtures.mjs';

export const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export function fixture(t,{cancellations=false,retention=false}={}){
  const root=process.env.QQ_TEST_ROOT??path.resolve('QQ插件运行目录/test-work');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'host-event-')),hosts=[],journals=[];
  const f={directory,now:1000,calls:[],responses:[],ingresses:[],hosts:new Map(),storage:new Map(),adapters:new Map(),servers:new Map(),taskCount:0,inputCount:0,
    prepare:async()=>{},prepareIngress:async()=>{},prepareFactory:async()=>{},request:async()=>{},respond:async()=>{},ingress:()=>{},hostFault:()=>{},storeFault:()=>{},eventJournalFault:()=>{},hostJournalFault:()=>{},adapterJournalFault:()=>{},cancelJournalFault:()=>{},retentionJournalFault:()=>{},sourceRead:rows=>rows,cancelReceipt:result=>result,reconcileReceipt:result=>result,checks:[],authorizers:new Map()};
  f.config=configuration();for(const a of f.config.agents){a.adapterId=DESCRIPTOR.id;a.modelRef='synthetic-model-a';}
  f.store=new WorkStore(path.join(directory,'work.sqlite'),{hostId:'host-test',clock:()=>f.now,fault:p=>f.storeFault(p)});f.store.installConfiguration(f.config);
  for(const name of ['a','b'])f.store.grantPairing(testScope(name),{expiresAt:100000});
  f.scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1,maxQueued:8});
  f.makeHost=(name='a',options={})=>{
    const s=testScope(name),database=path.join(directory,'journal.sqlite');
    const journal=new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'host',snapshotVersions:[1,2],fault:p=>f.hostJournalFault(p,name)});
    const adapterJournal=new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'adapter',fault:p=>f.adapterJournalFault(p,name)});
    const eventJournal=new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'events',fault:p=>f.eventJournalFault(p,name)});
    journals.push(journal,adapterJournal,eventJournal);f.storage.set(name,{journal,adapterJournal,eventJournal});
    const cancelJournal=cancellations?new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'cancellations',fault:p=>f.cancelJournalFault(p,name)}):null;
    if(cancelJournal){journals.push(cancelJournal);f.storage.get(name).cancelJournal=cancelJournal;}
    const retentionJournal=retention?new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'ingress-retention',fault:p=>f.retentionJournalFault(p,name)}):null;
    if(retentionJournal){journals.push(retentionJournal);f.storage.get(name).retentionJournal=retentionJournal;}
    const host=new OfflineDispatchHost({store:f.store,hostId:s.hostId,agent:{id:s.agentId,adapterId:DESCRIPTOR.id,modelRef:'synthetic-model-a'},configuration:f.config,journal,adapterJournal,scheduler:f.scheduler,fault:p=>f.hostFault(p,name),
      cancellations:cancelJournal?{journal:cancelJournal}:null,
      events:options.noEvents?null:{sourceId:'synthetic-source-'+name,journal:eventJournal,...(retentionJournal?{retention:{journal:retentionJournal}}:{}),prepareIngress:async context=>{
        await f.prepareIngress(context,name);
        return envelope=>{f.ingresses.push({name,request:context.request,envelope});f.ingress(context,envelope,name);return context.adapter.ingest(context.sessionRef,context.request,envelope);};
      }},
      prepareAdapter:async({context,journal:storage,authorize})=>{
        f.authorizers.set(name,authorize);
        await f.prepareFactory(context,name);
        if(!f.servers.has(name))f.servers.set(name,{threads:0,turns:[]});const server=f.servers.get(name);
        const transport={mode:'synthetic',protocolVersion:PINNED_PROTOCOL,hostId:context.hostId,agentId:context.agentId,
          prepare:frame=>f.prepare(frame,name),request:async frame=>{
            f.calls.push({...structuredClone(frame),name});
            const overridden=await f.request(frame,name);if(overridden!==undefined)return overridden;
            switch(frame.method){
              case 'initialize':return {userAgent:'synthetic codex/0.163.0-alpha.11.2'};
              case 'model/list':return {data:[{model:'synthetic-model-a',hidden:false}],nextCursor:null};
              case 'thread/start':return {thread:{id:'thread-'+(++server.threads),ephemeral:true},model:frame.params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
              case 'turn/start':{const turn={id:'turn-'+(server.turns.length+1),status:'inProgress',items:[]};server.turns.push(turn);return {turn:structuredClone(turn)};}
              case 'turn/steer':return {turnId:frame.params.expectedTurnId};
              case 'turn/interrupt':return {};
              case 'thread/read':return {thread:{id:frame.params.threadId,turns:structuredClone(server.turns)}};
              default:assert.fail('unexpected synthetic event request');
            }
          },notify:async()=>{},respond:async frame=>{f.responses.push({...structuredClone(frame),name});const result=await f.respond(frame,name);return result??{accepted:true};},close:async()=>{}};
        const registry=new AdapterRegistry();registerCodexOffline(registry,()=>({transport,journal:storage,authorize:request=>{const decision=authorize(request);f.checks.push({request,decision});return decision;}}));
        const adapter=registry.create({id:context.agentId,adapterId:context.adapterId},context),events=adapter.events.bind(adapter);
        // Only a public events projection is replaceable for contract-failure
        // tests. There is no permissive authorization callback or snapshot read.
        adapter.events=(...args)=>f.sourceRead(events(...args),name);
        const cancel=adapter.cancel.bind(adapter),reconcile=adapter.reconcile.bind(adapter);
        adapter.cancel=async(...args)=>f.cancelReceipt(await cancel(...args),name);
        adapter.reconcile=async(...args)=>f.reconcileReceipt(await reconcile(...args),name);
        f.adapters.set(name,adapter);return adapter;
      }});
    hosts.push(host);f.hosts.set(name,host);return host;
  };
  f.makeHost();
  f.coordinator=new InputCoordinator({store:f.store,scheduler:f.scheduler,prepareDispatch:r=>f.host(r.scope.agentId.slice(-1)).prepareInput(r),confirmDispatch:r=>f.host(r.scope.agentId.slice(-1)).confirmInput(r)});
  f.host=(name='a')=>f.hosts.get(name);f.storageFor=(name='a')=>f.storage.get(name);
  f.count=(method,name='a')=>f.calls.filter(c=>c.method===method&&c.name===name).length;
  f.target=r=>{const c=f.store.eventContext(r.scope,r.taskId,r.runId);return {taskId:r.taskId,runId:r.runId,attempt:r.attempt,kind:r.kind,leaseId:c.leaseId,externalRef:r.externalRef};};
  f.start=async(name='a')=>{
    if(!f.hosts.has(name))f.makeHost(name);const scope=testScope(name),task=f.coordinator.accept(scope,{eventId:'new-'+(++f.taskCount),operation:'new',kind:'work',text:'synthetic event goal'});
    const r=await f.host(name).dispatch(scope,task.taskId);assert.equal(r.state,'running');return {...r,scope,kind:'work',name,threadId:'thread-'+f.servers.get(name).threads,turnId:'turn-'+f.servers.get(name).turns.length};
  };
  f.queue=(r,operation='correct',extra={})=>f.coordinator.accept(r.scope,{eventId:'input-'+(++f.inputCount),operation,taskId:r.taskId,runId:r.runId,attempt:r.attempt,kind:r.kind,text:'synthetic ordinary input',...extra});
  f.flush=async(r,batch)=>{f.now+=250;return f.coordinator.flush(r.scope,batch.batchId);};
  f.envelope=(r,type='progress',seq=1,extra={})=>{
    const params={threadId:r.threadId,turnId:r.turnId,itemId:'item-'+seq};
    const message=type==='question'?{method:'item/tool/requestUserInput',id:'rpc-question-'+seq,params:{...params,isBlocking:true,questions:[{id:'question-'+seq,header:'Question',question:'Synthetic ordinary question?'}]}}:
      type==='approval'?{method:'item/fileChange/requestApproval',id:'rpc-approval-'+seq,params:{...params,startedAtMs:1}}:
      type==='progress'?{method:'item/agentMessage/delta',params:{...params,delta:'synthetic delta '+seq}}:
      type==='started'?{method:'turn/started',params:{threadId:r.threadId,turn:{id:r.turnId,status:'inProgress',items:[]}}}:
      {method:'turn/completed',params:{threadId:r.threadId,turn:{id:r.turnId,status:type,items:[]}}};
    return {sourceId:'synthetic-source-'+r.name,deliveryId:'delivery-'+seq,seq,occurredAt:'2026-01-01T00:00:00.000Z',message,...extra};
  };
  f.receive=(r,type='progress',seq=1,extra={})=>f.host(r.name).receiveEvent(r.scope,f.target(r),f.envelope(r,type,seq,extra));
  f.replay=(r,deliveryId)=>f.host(r.name).replayEvent(r.scope,f.target(r),deliveryId);
  f.continue=async r=>{
    const result=await f.flush(r,f.queue(r,'continue')),run=f.store.run(r.scope,result.deliveryRunId);assert.equal(result.state,'consumed');
    return {...r,runId:run.id,attempt:run.attempt,dispatchKey:run.dispatch_key,externalRef:run.external_ref,turnId:'turn-'+f.servers.get(r.name).turns.length};
  };
  t.after(async()=>{for(const h of hosts)await h.close();f.coordinator.close();f.scheduler.close();for(const j of journals)j.close();f.store.close();});return f;
}
