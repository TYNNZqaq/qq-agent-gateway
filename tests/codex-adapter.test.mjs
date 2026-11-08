import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { AdapterRegistry } from '../packages/core/adapter-registry.mjs';
import { CodexOfflineAdapter, registerCodexOffline } from '../packages/adapters/codex/offline-adapter.mjs';
import { DESCRIPTOR, PINNED_PROTOCOL } from '../packages/adapters/codex/protocol.mjs';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { InputCoordinator } from '../packages/host-control/input-coordinator.mjs';
import { testScope, configuration, inbound } from './foundation-fixtures.mjs';

const pinned=JSON.parse(readFileSync(new URL('./fixtures/codex/pinned-protocol.json',import.meta.url),'utf8'));
// Validate emitted parameters against the independently retained upstream
// schemas. This small draft-07 subset is a test helper, not a Runtime validator.
function matches(schema,value,root=schema){
  if(schema===true)return true;if(schema===false)return false;
  if(schema.$ref)return matches(schema.$ref.split('/').slice(1).reduce((s,k)=>s[k],root),value,root);
  if(schema.allOf&&!schema.allOf.every(s=>matches(s,value,root)))return false;
  if(schema.anyOf&&!schema.anyOf.some(s=>matches(s,value,root)))return false;
  if(schema.oneOf&&schema.oneOf.filter(s=>matches(s,value,root)).length!==1)return false;
  if(schema.enum&&!schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))return false;
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  if(schema.type&&!types.some(t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='integer'?Number.isInteger(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeof value===t))return false;
  if(typeof value==='number'&&schema.minimum!==undefined&&value<schema.minimum)return false;
  if(typeof value==='string'&&schema.minLength!==undefined&&value.length<schema.minLength)return false;
  if(Array.isArray(value)&&schema.items&&!value.every(x=>matches(schema.items,x,root)))return false;
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
    if(schema.required&&!schema.required.every(k=>Object.hasOwn(value,k)))return false;
    for(const [k,v]of Object.entries(value)){
      if(schema.properties?.[k]){if(!matches(schema.properties[k],v,root))return false;}
      else if(schema.additionalProperties===false)return false;
      else if(schema.additionalProperties&&typeof schema.additionalProperties==='object'&&!matches(schema.additionalProperties,v,root))return false;
    }
  }
  return true;
}
const schemaMethods={'initialize':'initialize','model/list':'models','thread/start':'open','turn/start':'submit','turn/steer':'input','turn/interrupt':'cancel','thread/read':'read'};
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function memoryJournal(){let saved=null;return {load:()=>structuredClone(saved),commit:(value,expected)=>{if((saved?.revision??0)!==expected)return false;saved=structuredClone(value);return true;}};}
function fixture(t,options={}){
  const s=options.scope??testScope(),calls=[],responses=[],notifications=[],checks=[],journal=options.journal??memoryJournal();
  const f={scope:s,journal,calls,responses,notifications,checks,authorized:true,prepare:async()=>{},turns:[],threadCounter:0,turnCounter:0};
  const transport={mode:'synthetic',protocolVersion:PINNED_PROTOCOL,hostId:s.hostId,agentId:s.agentId,
    prepare:frame=>f.prepare(frame),
    async request(frame){
      assert.ok(matches(pinned.schemas[schemaMethods[frame.method]],frame.params),'upstream schema for '+frame.method);
      calls.push(structuredClone(frame));
      if(options.handler){const result=await options.handler(frame,f);if(result!==undefined)return result;}
      switch(frame.method){
        case 'initialize':return {userAgent:'synthetic codex/0.163.0-alpha.11.2',platformFamily:'synthetic',platformOs:'synthetic',codexHome:'synthetic-home'};
        case 'model/list':return {data:structuredClone(pinned.examples.models),nextCursor:null};
        case 'thread/start':return {thread:{id:'synthetic-thread-'+(++f.threadCounter),ephemeral:true},model:frame.params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
        case 'turn/start':{const turn={id:'synthetic-turn-'+(++f.turnCounter),status:'inProgress',items:[]};f.turns.push(turn);return {turn:structuredClone(turn)};}
        case 'turn/steer':return {turnId:frame.params.expectedTurnId};
        case 'turn/interrupt':return {};
        case 'thread/read':return {thread:{id:frame.params.threadId,turns:structuredClone(f.turns)}};
        default:assert.fail('unexpected protocol method');
      }
    },
    async notify(frame){notifications.push(frame);},
    async respond(frame){assert.ok(matches(pinned.schemas.answer,frame.result));responses.push(frame);return {accepted:true};},
    async close(){f.closed=true;}
  };
  f.transport=transport;
  f.dependencies={hostId:s.hostId,agentId:s.agentId,transport,journal,authorize:value=>{checks.push(value);return options.authorize?options.authorize(value,f):f.authorized;}};
  f.adapter=new CodexOfflineAdapter(f.dependencies);t.after(()=>f.adapter.close());return f;
}
async function running(f,overrides={}){
  const opened=await f.adapter.openSession(f.scope,{sessionId:overrides.sessionId??'session-a',modelRef:'synthetic-model-a'});assert.equal(opened.state,'open');
  const request={scope:f.scope,taskId:'task-a',runId:'run-a',attempt:1,kind:'work',leaseId:'lease-a',dispatchKey:'dispatch-a',text:'synthetic work only',executionApproved:false,...overrides};delete request.sessionId;
  const report=await f.adapter.submit(opened.sessionRef,request,request.dispatchKey);
  return {sessionRef:opened.sessionRef,request,report,target:{scope:request.scope,taskId:request.taskId,runId:request.runId,attempt:request.attempt,kind:request.kind,leaseId:request.leaseId,externalRef:report.externalRef}};
}
const input=(r,operation='continue',extra={})=>({...r.target,operation,text:'ordinary synthetic guidance',executionApproved:false,...extra});
const envelope=(seq,method,params,extra={})=>({deliveryId:'delivery-'+seq,seq,occurredAt:'2026-01-01T00:00:00.000Z',message:{method,params,...extra}});
const upstream=(f,extra={})=>({threadId:'synthetic-thread-1',turnId:'synthetic-turn-1',...extra});
const ingest=(f,r,seq,method,params,extra)=>f.adapter.ingest(r.sessionRef,r.target,envelope(seq,method,params,extra));
const complete=(f,r,seq=10,status='completed')=>ingest(f,r,seq,'turn/completed',{threadId:'synthetic-thread-1',turn:{id:'synthetic-turn-1',status,items:[]}});
const question=(f,r,seq=2,id='question-a',extra={})=>ingest(f,r,seq,'item/tool/requestUserInput',upstream(f,{itemId:'item-question',isBlocking:true,questions:[{id,header:'Question',question:'Synthetic clarification',...extra}]}),{id:'question-rpc-'+seq});
const approval=(f,r,seq=3)=>ingest(f,r,seq,'item/fileChange/requestApproval',upstream(f,{itemId:'item-approval',startedAtMs:1}),{id:'approval-rpc'});
const count=(f,method)=>f.calls.filter(x=>x.method===method).length;

test('Codex reference registers lazily with honest capabilities and complete shared methods',async t=>{
  const f=fixture(t),registry=new AdapterRegistry();let factories=0;
  registerCodexOffline(registry,()=>{factories++;return f.dependencies;});assert.equal(factories,0);
  const a=registry.create({id:f.scope.agentId,adapterId:DESCRIPTOR.id},{hostId:f.scope.hostId,agentId:f.scope.agentId});t.after(()=>a.close());
  assert.equal(factories,1);assert.equal(registry.describe(DESCRIPTOR.id).capabilities.input.status,'unsupported');assert.equal(registry.describe(DESCRIPTOR.id).capabilities.fileIsolation.status,'unsupported');
  const probe=await a.probe();assert.equal(probe.realRuntime,false);assert.equal(probe.protocolVersion,pinned.protocolVersion);assert.deepEqual(probe.models,['synthetic-model-a']);
  await a.probe();assert.equal(count(f,'initialize'),1);assert.equal(f.notifications.length,1);
});

test('Codex refuses real transport, version drift, missing host dependencies and foreign transport owners',t=>{
  const f=fixture(t);
  for(const change of [{mode:'stdio'},{protocolVersion:'other'},{agentId:'agent-other'}])assert.throws(()=>new CodexOfflineAdapter({...f.dependencies,transport:{...f.transport,...change}}),{code:'CODEX_SYNTHETIC_TRANSPORT_REQUIRED'});
  assert.throws(()=>new CodexOfflineAdapter({...f.dependencies,authorize:null}),{code:'CODEX_HOST_DEPENDENCIES_REQUIRED'});
});

test('Codex handshake or incomplete synthetic model list fails without session or turn',async t=>{
  for(const response of [{data:[],nextCursor:'more'},{data:'bad'},{data:[],nextCursor:null}]){
    const f=fixture(t,{handler:frame=>frame.method==='model/list'?response:undefined});
    if(Array.isArray(response.data)&&!response.nextCursor)await assert.rejects(f.adapter.openSession(f.scope,{sessionId:'s',modelRef:'missing'}),{code:'CODEX_MODEL_UNAVAILABLE'});
    else await assert.rejects(f.adapter.probe(),{code:'CODEX_HANDSHAKE_FAILED'});
    assert.equal(count(f,'thread/start'),0);assert.equal(count(f,'turn/start'),0);
  }
});

test('Codex explicitly unavailable model does not substitute a listed or default model',async t=>{
  const f=fixture(t);await assert.rejects(f.adapter.openSession(f.scope,{sessionId:'s',modelRef:'unavailable-model'}),{code:'CODEX_MODEL_UNAVAILABLE'});assert.equal(count(f,'thread/start'),0);
});

test('Codex own session is idempotent, full scope is required, and raw desktop thread references are rejected',async t=>{
  const f=fixture(t),r=await running(f);
  assert.equal((await f.adapter.openSession(f.scope,{sessionId:'session-a',modelRef:'synthetic-model-a'})).sessionRef,r.sessionRef);assert.equal(count(f,'thread/start'),1);
  await assert.rejects(f.adapter.submit('external-desktop-thread',r.request,r.request.dispatchKey),{code:'CODEX_OWNED_SESSION_REQUIRED'});
  await assert.rejects(f.adapter.openSession(f.scope,{sessionId:'s',modelRef:'synthetic-model-a',threadId:'external'}),{code:'INVALID_FIELDS'});
  for(const key of Object.keys(f.scope)){
    const wrong={...f.scope,[key]:key.endsWith('Version')?2:'foreign'};
    await assert.rejects(f.adapter.sendInput(r.sessionRef,{...input(r),scope:wrong},'foreign-'+key));
  }
});

test('Codex model, ephemeral and effective read-only policy mismatch leaves session unknown',async t=>{
  for(const change of [{model:'substituted'},{sandbox:{type:'workspaceWrite',networkAccess:false}},{thread:{id:'foreign',ephemeral:false}},{sandbox:{type:'readOnly',networkAccess:true}}]){
    const f=fixture(t,{handler:frame=>frame.method==='thread/start'?{thread:{id:'synthetic-thread-1',ephemeral:true},model:frame.params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',...change}:undefined});
    const session=await f.adapter.openSession(f.scope,{sessionId:'s',modelRef:'synthetic-model-a'});assert.equal(session.state,'unknown');await f.adapter.openSession(f.scope,{sessionId:'s',modelRef:'synthetic-model-a'});assert.equal(count(f,'thread/start'),1);
  }
});

test('Codex submission stores intent before dispatch and cannot rewrite Run, text or dispatch identity',async t=>{
  const f=fixture(t);f.prepare=async frame=>{if(frame.method==='turn/start'){const saved=f.journal.load();assert.equal(saved.runs[0].state,'dispatching');assert.equal(saved.runs[0].externalRef,null);}};
  const r=await running(f);assert.equal(r.report.state,'running');assert.match(r.report.externalRef,/^cx_/);
  assert.deepEqual(await f.adapter.submit(r.sessionRef,r.request,r.request.dispatchKey),r.report);assert.equal(count(f,'turn/start'),1);
  await assert.rejects(f.adapter.submit(r.sessionRef,{...r.request,text:'changed'},r.request.dispatchKey),{code:'CODEX_SUBMISSION_CONFLICT'});
  await assert.rejects(f.adapter.submit(r.sessionRef,{...r.request,runId:'other-run'},r.request.dispatchKey),{code:'CODEX_DISPATCH_KEY_REUSED'});
  for(const key of ['taskId','runId','attempt','kind','leaseId','externalRef'])await assert.rejects(f.adapter.sendInput(r.sessionRef,{...input(r),[key]:key==='attempt'?2:'wrong'},'wrong-'+key),{code:'CODEX_RUN_OWNERSHIP_MISMATCH'});
});

test('Codex synthetic steering stays on the same turn and sends no routing, policy or approval fields',async t=>{
  const f=fixture(t),r=await running(f),request=input(r,'correct');
  const report=await f.adapter.sendInput(r.sessionRef,request,'input-a');assert.equal(report.state,'accepted');assert.equal(report.executionApproved,false);
  const frame=f.calls.find(x=>x.method==='turn/steer');assert.deepEqual(Object.keys(frame.params).sort(),['clientUserMessageId','expectedTurnId','input','threadId']);
  assert.equal(frame.params.expectedTurnId,'synthetic-turn-1');assert.equal(count(f,'turn/start'),1);
  assert.deepEqual(await f.adapter.sendInput(r.sessionRef,request,'input-a'),report);assert.equal(count(f,'turn/steer'),1);
  await assert.rejects(f.adapter.sendInput(r.sessionRef,{...request,text:'changed'},'input-a'),{code:'CODEX_INPUT_CONFLICT'});
  await assert.rejects(f.adapter.sendInput(r.sessionRef,{...request,executionApproved:true},'approve'),{code:'CODEX_ORDINARY_INPUT_REQUIRED'});
});

test('Codex ordinary question uses matching request id and question version; answer confirms no execution approval',async t=>{
  const f=fixture(t),r=await running(f);const q=question(f,r);assert.equal(q.event.type,'run.waiting_input');
  const request=input(r,'answer',{questionId:'question-a',questionSeq:2,text:'yes'});
  await assert.rejects(f.adapter.sendInput(r.sessionRef,{...request,questionSeq:1},'old-answer'),{code:'CODEX_STALE_QUESTION'});
  const result=await f.adapter.sendInput(r.sessionRef,request,'answer-a');assert.equal(result.state,'accepted');assert.equal(result.executionApproved,false);
  assert.deepEqual(f.responses,[{id:'question-rpc-2',result:{answers:{'question-a':{answers:['yes']}}}}]);assert.equal(count(f,'turn/steer'),0);
  question(f,r,4);await assert.rejects(f.adapter.sendInput(r.sessionRef,request,'stale-reused-id'),{code:'CODEX_STALE_QUESTION'});
});

test('Codex ordinary answers, continue and correction cannot clear waiting_approval',async t=>{
  const f=fixture(t),r=await running(f);question(f,r);approval(f,r);
  for(const operation of ['answer','continue','correct'])await assert.rejects(f.adapter.sendInput(r.sessionRef,input(r,operation,{questionId:'question-a',questionSeq:2,text:'approve all'}),'blocked-'+operation));
  assert.equal(f.responses.length,0);assert.equal(count(f,'turn/steer'),0);
  assert.equal(ingest(f,r,4,'turn/started',{threadId:'synthetic-thread-1',turn:{id:'synthetic-turn-1',status:'inProgress',items:[]}}).applied,false);
  assert.equal(f.journal.load().runs[0].state,'waiting_approval');
});

test('Codex unsupported multi-question, secret and choice input are explicit unknown without invented answer',async t=>{
  for(const extra of [{isSecret:true},{options:[{label:'One',description:'Synthetic'}]}]){
    const f=fixture(t),r=await running(f),result=question(f,r,2,'question-a',extra);assert.equal(result.accepted,false);assert.equal(result.reason,'CODEX_QUESTION_UNSUPPORTED');assert.equal(f.responses.length,0);
  }
  const f=fixture(t),r=await running(f),result=ingest(f,r,2,'item/tool/requestUserInput',upstream(f,{itemId:'q',isBlocking:true,questions:[]}),{id:1});assert.equal(result.state,'unknown');
});

test('Codex reordered, duplicated and conflicting delivery envelopes cannot advance a terminal Run',async t=>{
  const f=fixture(t),r=await running(f),progress=envelope(3,'item/agentMessage/delta',upstream(f,{itemId:'item-a',delta:'synthetic progress'}));
  assert.equal(f.adapter.ingest(r.sessionRef,r.target,progress).applied,true);assert.equal(f.adapter.ingest(r.sessionRef,r.target,progress).duplicate,true);
  assert.throws(()=>f.adapter.ingest(r.sessionRef,r.target,{...progress,message:{...progress.message,params:{...progress.message.params,delta:'conflict'}}}),{code:'CODEX_EVENT_CONFLICT'});
  assert.equal(ingest(f,r,2,'turn/started',{threadId:'synthetic-thread-1',turn:{id:'synthetic-turn-1',status:'inProgress',items:[]}}).late,true);
  assert.equal(complete(f,r,5).applied,true);assert.equal(complete(f,r,6,'failed').applied,false);assert.equal(f.journal.load().runs[0].state,'succeeded');
  assert.equal(f.adapter.events(r.sessionRef,r.target).length,4);
});

test('Codex requires exact thread/turn/run association and does not infer completion from model text',async t=>{
  const f=fixture(t),r=await running(f);
  for(const change of [{threadId:'external-desktop-thread'},{turnId:'another-turn'}])assert.throws(()=>ingest(f,r,2,'item/agentMessage/delta',upstream(f,{itemId:'i',delta:'done',...change})),{code:'CODEX_EVENT_OWNERSHIP_MISMATCH'});
  ingest(f,r,2,'item/agentMessage/delta',upstream(f,{itemId:'i',delta:'I completed everything and sent QQ'}));assert.equal(f.journal.load().runs[0].state,'running');
});

for(const status of ['completed','failed','interrupted'])test('Codex terminal '+status+' maps only the upstream turn state',async t=>{
  const f=fixture(t),r=await running(f),record=complete(f,r,2,status);assert.equal(record.event.type,{completed:'run.succeeded',failed:'run.failed',interrupted:'run.cancelled'}[status]);
  assert.ok(!JSON.stringify(record).includes('error message from runtime'));
});

test('Codex interrupt acknowledgement remains cancelling until interrupted terminal event',async t=>{
  const f=fixture(t),r=await running(f),result=await f.adapter.cancel(r.sessionRef,r.target,'cancel-a');assert.equal(result.state,'cancelling');assert.equal(result.confirmed,false);
  await f.adapter.cancel(r.sessionRef,r.target,'cancel-a');assert.equal(count(f,'turn/interrupt'),1);
  await assert.rejects(f.adapter.cancel(r.sessionRef,r.target,'different-cancel-key'),{code:'CODEX_CANCEL_ALREADY_REQUESTED'});assert.equal(count(f,'turn/interrupt'),1);
  assert.equal(ingest(f,r,2,'turn/started',{threadId:'synthetic-thread-1',turn:{id:'synthetic-turn-1',status:'inProgress',items:[]}}).applied,false);
  complete(f,r,3,'interrupted');assert.equal((await f.adapter.cancel(r.sessionRef,r.target,'cancel-b')).confirmed,true);
});

test('Codex completion winning a cancellation race remains succeeded, without claiming cancellation',async t=>{
  const wait=gate(),entered=gate(),f=fixture(t,{handler:async frame=>{if(frame.method==='turn/interrupt'){entered.resolve();await wait.promise;return {};}}}),r=await running(f);
  const pending=f.adapter.cancel(r.sessionRef,r.target,'cancel-a');await entered.promise;complete(f,r,2);wait.resolve();const report=await pending;
  assert.equal(report.state,'succeeded');assert.equal(report.confirmed,false);
});

test('Codex failed, disconnected or unconfirmed submission is unknown and is never automatically retried',async t=>{
  const f=fixture(t,{handler:frame=>{if(frame.method==='turn/start')throw Error('sensitive diagnostic must not escape');}}),r=await running(f);
  assert.equal(r.report.state,'unknown');assert.equal(r.report.externalRef,null);assert.ok(!JSON.stringify(r.report).includes('sensitive'));
  await f.adapter.submit(r.sessionRef,r.request,r.request.dispatchKey);assert.equal(count(f,'turn/start'),1);
  const report=await f.adapter.reconcile(r.sessionRef,r.target);assert.equal(report.reason,'CODEX_NO_CORRELATED_TURN');assert.equal(count(f,'thread/read'),0);
  await assert.rejects(f.adapter.submit(r.sessionRef,{...r.request,runId:'new-run',dispatchKey:'new-key'},'new-key'),{code:'CODEX_SESSION_BUSY'});
});

test('Codex event arriving before a submission response cannot be guessed into that Run',async t=>{
  const f=fixture(t,{handler:(frame,f)=>{if(frame.method==='turn/start'){
    assert.throws(()=>f.adapter.ingest('cs-invalid',{},{}));
    const saved=f.journal.load(),session=saved.sessions[0],run=saved.runs[0];
    const target={scope:run.scope,taskId:run.taskId,runId:run.runId,attempt:run.attempt,kind:run.kind,leaseId:run.leaseId,externalRef:null};
    assert.throws(()=>f.adapter.ingest(session.ref,target,envelope(1,'turn/started',{threadId:session.threadId,turn:{id:'synthetic-turn-early',status:'inProgress',items:[]}})),{code:'CODEX_EVENT_OWNERSHIP_MISMATCH'});
  }}});await running(f);
});

test('Codex unknown steering blocks later inputs and run observation cannot prove input consumption',async t=>{
  const f=fixture(t,{handler:frame=>{if(frame.method==='turn/steer')throw Error('lost receipt');}}),r=await running(f),request=input(r);
  const report=await f.adapter.sendInput(r.sessionRef,request,'input-a');assert.equal(report.state,'unknown');assert.equal(report.receiptRef,null);
  await f.adapter.sendInput(r.sessionRef,request,'input-a');assert.equal(count(f,'turn/steer'),1);
  assert.equal((await f.adapter.reconcile(r.sessionRef,r.target)).state,'unknown');
  await assert.rejects(f.adapter.sendInput(r.sessionRef,request,'input-b'),{code:'CODEX_INPUT_STATE_REJECTED'});
});

test('Codex lost interrupt response stays unknown and does not repeat cancellation',async t=>{
  const f=fixture(t,{handler:frame=>{if(frame.method==='turn/interrupt')throw Error('lost cancellation');}}),r=await running(f);
  assert.equal((await f.adapter.cancel(r.sessionRef,r.target,'cancel-a')).state,'unknown');await f.adapter.cancel(r.sessionRef,r.target,'cancel-a');assert.equal(count(f,'turn/interrupt'),1);
});

test('Codex local journal reload preserves mappings, unknown state and no automatic transmission',async t=>{
  const f=fixture(t),r=await running(f),before=f.calls.length;
  const resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());assert.equal(f.calls.length,before);assert.equal(f.journal.load().runs[0].state,'unknown');
  assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'running');assert.equal(count(f,'turn/start'),1);assert.equal(count(f,'thread/read'),1);
});

test('Codex pending approval survives reload and cannot be cleared by an inProgress read',async t=>{
  const f=fixture(t),r=await running(f);approval(f,r);const resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());
  assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'unknown');await assert.rejects(resumed.sendInput(r.sessionRef,input(r),'after-reload'),{code:'CODEX_INPUT_STATE_REJECTED'});assert.equal(f.responses.length,0);
});

test('Codex pending cancellation survives reload until explicit terminal reconciliation',async t=>{
  const f=fixture(t),r=await running(f);await f.adapter.cancel(r.sessionRef,r.target,'cancel-a');const resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());
  assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'unknown');assert.equal(count(f,'initialize'),2);
  f.turns[0].status='interrupted';assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'cancelled');assert.equal(count(f,'turn/interrupt'),1);
});

test('Codex a Promise from the synchronous authorization hook cannot authorize dispatch',async t=>{
  const f=fixture(t),r=await running(f);f.dependencies.authorize=()=>Promise.resolve(true);const resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());
  assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'unknown');assert.equal(count(f,'thread/read'),0);
});

test('Codex journal failure before dispatch sends nothing and acceptance persistence failure never reports success',async t=>{
  const f=fixture(t),r=await running(f),commit=f.journal.commit;let fail=true;f.journal.commit=(value,expected)=>{if(fail)throw Error('disk');return commit(value,expected);};
  await assert.rejects(f.adapter.sendInput(r.sessionRef,input(r),'persist-before'),{code:'CODEX_JOURNAL_UNAVAILABLE'});assert.equal(count(f,'turn/steer'),0);fail=false;
  const g=fixture(t,{handler:frame=>{if(frame.method==='turn/steer'){g.journal.commit=()=>{throw Error('disk after acceptance');};return {turnId:'synthetic-turn-1'};}}}),rg=await running(g),commitG=g.journal.commit;
  await assert.rejects(g.adapter.sendInput(rg.sessionRef,input(rg),'persist-after'),{code:'CODEX_JOURNAL_UNAVAILABLE'});assert.equal(count(g,'turn/steer'),1);g.journal.commit=commitG;
});

test('Codex explicit reconciliation reads only its own exact turn and missing or duplicate turn stays unknown',async t=>{
  for(const turns of [[],[{id:'unrelated-turn',status:'completed',items:[]}],[{id:'synthetic-turn-1',status:'completed',items:[]},{id:'synthetic-turn-1',status:'completed',items:[]}]]){
    const f=fixture(t),r=await running(f);f.turns=turns;const resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'unknown');assert.equal(count(f,'turn/start'),1);
  }
});

test('Codex persisted synthetic file journal can reopen without a WorkStore migration',async t=>{
  const dir=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'codex-journal-')),file=path.join(dir,'mapping.json');let exists=false;
  const journal={load:()=>exists?JSON.parse(readFileSync(file,'utf8')):null,commit:(value,expected)=>{if((exists?JSON.parse(readFileSync(file,'utf8')).revision:0)!==expected)return false;writeFileSync(file,JSON.stringify(value));exists=true;return true;}};
  const f=fixture(t,{journal}),r=await running(f);const resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());f.turns[0].status='completed';assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'succeeded');
});

test('Codex foreign or future journal fails before handshake',t=>{
  const f=fixture(t),base=f.journal.load();for(const change of [{schemaVersion:2},{owner:{hostId:'foreign',agentId:'foreign'}}])assert.throws(()=>new CodexOfflineAdapter({...f.dependencies,journal:{load:()=>({...base,...change}),commit:()=>{}}}),{code:'CODEX_JOURNAL_MISMATCH'});assert.equal(f.calls.length,0);
});

test('Codex journal reopening fences the older instance before dispatch or stale checkpoint',async t=>{
  const f=fixture(t),r=await running(f),resumed=new CodexOfflineAdapter(f.dependencies);t.after(()=>resumed.close());const revision=f.journal.load().revision;
  await assert.rejects(f.adapter.sendInput(r.sessionRef,input(r),'stale-instance'),{code:'CODEX_JOURNAL_FENCED'});assert.equal(count(f,'turn/steer'),0);
  const closed=await f.adapter.close();assert.equal(closed.journalSaved,false);assert.equal(f.journal.load().revision,revision);assert.equal((await resumed.reconcile(r.sessionRef,r.target)).state,'running');
});

for(const stage of ['before','after'])test('Codex authorization '+stage+' an internal async wait rejects revoked work without success',async t=>{
  const entered=gate(),wait=gate(),f=fixture(t,stage==='after'?{handler:async(frame)=>{if(frame.method==='turn/steer'){entered.resolve();await wait.promise;return {turnId:'synthetic-turn-1'};}}}:{}),r=await running(f);
  if(stage==='before')f.prepare=async frame=>{if(frame.method==='turn/steer'){entered.resolve();await wait.promise;}};
  const pending=f.adapter.sendInput(r.sessionRef,input(r),'racing-input');await entered.promise;f.authorized=false;wait.resolve();const report=await pending;
  assert.equal(report.state,'unknown');assert.equal(report.receiptRef,null);assert.equal(count(f,'turn/steer'),stage==='before'?0:1);
});

test('Codex close during preparation does not submit and cannot reopen the old object',async t=>{
  const entered=gate(),wait=gate(),f=fixture(t),r=await running(f);f.prepare=async frame=>{if(frame.method==='turn/steer'){entered.resolve();await wait.promise;}};
  const pending=f.adapter.sendInput(r.sessionRef,input(r),'racing-close');await entered.promise;await f.adapter.close();wait.resolve();assert.equal((await pending).state,'unknown');assert.equal(count(f,'turn/steer'),0);assert.throws(()=>f.adapter.events(r.sessionRef,r.target),{code:'CODEX_ADAPTER_UNAVAILABLE'});
});

test('Codex question changed to approval during response wait retains unknown input and pending approval',async t=>{
  const entered=gate(),wait=gate(),f=fixture(t),r=await running(f);question(f,r);
  const original=f.transport.respond;f.transport.respond=async frame=>{await original(frame);entered.resolve();await wait.promise;return {accepted:true};};
  const pending=f.adapter.sendInput(r.sessionRef,input(r,'answer',{questionId:'question-a',questionSeq:2}),'racing-answer');await entered.promise;approval(f,r,3);wait.resolve();assert.equal((await pending).state,'unknown');assert.equal(f.journal.load().runs[0].state,'waiting_approval');
});

test('Codex runtime errors and model reroutes expose stable unknown reasons without fallback',async t=>{
  for(const method of ['error','model/rerouted']){
    const f=fixture(t),r=await running(f),record=ingest(f,r,2,method,upstream(f,{willRetry:true,error:{message:'private diagnostic'},fromModel:'synthetic-model-a',toModel:'substitute',reason:'synthetic'}));
    assert.equal(record.state,'unknown');assert.ok(!JSON.stringify(record).includes('private diagnostic'));assert.equal(count(f,'turn/start'),1);assert.equal(f.adapter.ingest(r.sessionRef,r.target,envelope(2,method,upstream(f,{willRetry:true,error:{message:'private diagnostic'},fromModel:'synthetic-model-a',toModel:'substitute',reason:'synthetic'}))).duplicate,true);
  }
});

test('Codex one agent failure does not close or mutate another instance using identical synthetic upstream IDs',async t=>{
  const a=fixture(t,{handler:frame=>{if(frame.method==='turn/steer')throw Error('instance a failed');}}),b=fixture(t,{scope:testScope('b')}),ra=await running(a),rb=await running(b);
  assert.notEqual(ra.report.externalRef,rb.report.externalRef);await a.adapter.sendInput(ra.sessionRef,input(ra),'same-input');assert.equal((await b.adapter.sendInput(rb.sessionRef,input(rb),'same-input')).state,'accepted');
  assert.throws(()=>b.adapter.events(ra.sessionRef,ra.target));await a.adapter.close();assert.equal(b.closed,undefined);assert.equal(complete(b,rb).applied,true);
});

test('Codex Session serializes runs and a new attempt keeps the old terminal association',async t=>{
  const f=fixture(t),r=await running(f);await assert.rejects(f.adapter.submit(r.sessionRef,{...r.request,runId:'run-b',dispatchKey:'dispatch-b'},'dispatch-b'),{code:'CODEX_SESSION_BUSY'});
  complete(f,r);const next=await f.adapter.submit(r.sessionRef,{...r.request,runId:'run-b',attempt:2,dispatchKey:'dispatch-b'},'dispatch-b');assert.notEqual(next.externalRef,r.report.externalRef);assert.equal(count(f,'thread/start'),1);
  assert.equal(complete(f,r,20,'failed').applied,false);assert.equal(f.journal.load().runs[1].state,'running');
});

test('Codex input and event histories have finite caps and capacity refusal never sends',async t=>{
  const f=fixture(t),r=await running(f);for(let i=0;i<64;i++)await f.adapter.sendInput(r.sessionRef,input(r),'input-'+i);await assert.rejects(f.adapter.sendInput(r.sessionRef,input(r),'overflow'),{code:'CODEX_INPUT_CAPACITY'});assert.equal(count(f,'turn/steer'),64);
  for(let seq=1;seq<=256;seq++)ingest(f,r,seq,'item/agentMessage/delta',upstream(f,{itemId:'item-a',delta:'synthetic'}));assert.throws(()=>ingest(f,r,257,'item/agentMessage/delta',upstream(f,{itemId:'item-a',delta:'synthetic'})),{code:'CODEX_EVENT_CAPACITY'});assert.equal(f.journal.load().runs[0].state,'unknown');
});

test('Codex malformed status cannot use inherited object keys, and UTF8 limits reject before input dispatch',async t=>{
  const f=fixture(t),r=await running(f);await assert.rejects(f.adapter.sendInput(r.sessionRef,input(r,'continue',{text:'光'.repeat(11000)}),'oversize'),{code:'CODEX_TEXT_TOO_LARGE'});assert.equal(count(f,'turn/steer'),0);
  assert.throws(()=>complete(f,r,2,'__proto__'),{code:'CODEX_UNKNOWN_TURN_STATUS'});assert.equal(f.journal.load().runs[0].state,'running');
});

test('Codex synthetic host composition records real Core events and InputCoordinator receipts without changing schema',async t=>{
  let now=1000;const database=path.join(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'codex-host-')),'business.sqlite'),store=new WorkStore(database,{hostId:'host-test',clock:()=>now});t.after(()=>store.close());store.installConfiguration(configuration());const s=testScope(),lease=store.grantPairing(s,{expiresAt:10000});
  const task=store.acceptInbound(s,inbound('host-task')),run=store.beginRun(s,task.taskId,{dispatchKey:'host-dispatch'});
  const f=fixture(t,{authorize:check=>{try{const p=store.requirePairing(check.scope);if(check.runId){const current=store.run(check.scope,check.runId),owner=store.task(check.scope,check.taskId);return current.task_id===owner.id&&owner.current_run_id===current.id&&p.id===check.leaseId&&current.attempt===check.attempt;}return true;}catch{return false;}}});
  const r=await running(f,{taskId:task.taskId,runId:run.id,dispatchKey:run.dispatch_key,leaseId:lease.id});store.recordSubmission(s,run.id,r.report.externalRef);
  const coordinator=new InputCoordinator({store,prepareDispatch:async()=>async request=>{const result=await f.adapter.sendInput(r.sessionRef,{...r.target,operation:request.operation,text:request.text,questionId:request.questionId??undefined,questionSeq:request.questionSeq??undefined,executionApproved:false},request.inputKey);if(result.state!=='accepted')throw Error('unknown synthetic acceptance');return {receiptRef:result.receiptRef,externalRef:result.externalRef};}});t.after(()=>coordinator.close());
  // Omit question keys for ordinary steering to keep the envelope unambiguous.
  const batch=coordinator.accept(s,{eventId:'host-guidance',operation:'correct',kind:'work',taskId:task.taskId,runId:run.id,attempt:run.attempt,text:'synthetic correction'});now+=250;assert.equal((await coordinator.flush(s,batch.batchId)).state,'consumed');
  const q=question(f,r,1);store.recordEvent(s,run.id,q.event);assert.equal(store.run(s,run.id).state,'waiting_input');const ap=approval(f,r,2);store.recordEvent(s,run.id,ap.event);assert.equal(store.run(s,run.id).state,'waiting_approval');assert.equal(f.responses.length,0);
  const done=complete(f,r,3);store.recordEvent(s,run.id,done.event);assert.equal(store.run(s,run.id).state,'succeeded');assert.equal(f.journal.load().schemaVersion,1);
});

for(const race of ['revoke','expire','stop','rebind'])test('Codex internal preparation repeats WorkStore authorization after '+race,async t=>{
  let now=1000;const store=new WorkStore(path.join(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'codex-race-')),'business.sqlite'),{hostId:'host-test',clock:()=>now});t.after(()=>store.close());const config=configuration();store.installConfiguration(config);const s=testScope(),lease=store.grantPairing(s,{expiresAt:10000}),task=store.acceptInbound(s,inbound('race-task')),run=store.beginRun(s,task.taskId,{dispatchKey:'race-dispatch'});
  const f=fixture(t,{authorize:check=>{try{return store.requirePairing(check.scope).id===(check.leaseId??lease.id);}catch{return false;}}}),r=await running(f,{taskId:task.taskId,runId:run.id,dispatchKey:run.dispatch_key,leaseId:lease.id});store.recordSubmission(s,run.id,r.report.externalRef);
  const entered=gate(),wait=gate();f.prepare=async frame=>{if(frame.method==='turn/steer'){entered.resolve();await wait.promise;}};
  const pending=f.adapter.sendInput(r.sessionRef,input(r),'racing-input');await entered.promise;
  if(race==='revoke')store.revokePairing(s);if(race==='expire')now=10000;if(race==='stop')store.stopBot(s.botId);if(race==='rebind'){config.revision++;config.bindings[0].version++;store.installConfiguration(config);}
  wait.resolve();assert.equal((await pending).state,'unknown');assert.equal(count(f,'turn/steer'),0);
});
