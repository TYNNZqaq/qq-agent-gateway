import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {firstRunFixture} from './first-run-fixture.mjs';
import {SetupController} from '../packages/host-control/setup-controller.mjs';
import {createManagementServer} from '../packages/host-control/local-server.mjs';
import {BusinessController} from '../packages/host-control/business-controller.mjs';

function automaticFixture(t,{consent=true,configured=false,automaticEnabled=true,paired=false}={}){
 const f=firstRunFixture({consent}),calls=[],listeners=new Set();
 const state={available:true,configured,running:false,pending:false,processAlive:false,paired,executionConfigured:false,serviceConfigured:configured,serviceMode:configured?'native-only':undefined,automaticFeatures:configured?{enabled:automaticEnabled,state:'configured'}:null};
 const business={snapshot:()=>({...state}),workflow(kind,input,privateInput){calls.push({kind,input,privateInput});Object.assign(state,{pending:true,operation:{id:input.operationId,kind,state:'spawned'}});return this.snapshot();},onWorkflowComplete(listener){listeners.add(listener);return ()=>listeners.delete(listener);}};
 const account={data:f.account,snapshot:()=>({associationValid:true,account:{status:'authenticated'}})},qq={snapshot:()=>({credentialConfigured:true})};
 let desktopReady=false;
 const controller=new SetupController({paths:f.paths,identity:f.identity,managementStore:f.management,accountControl:account,businessControl:business,qqConnection:qq,executionStatus:()=>({verified:false}),desktopReady:()=>desktopReady});
 t.after(async()=>{await controller.close();f.close();});
 const complete=(kind,result,updates={})=>{
  const call=calls.findLast(c=>c.kind===kind);assert.ok(call,'missing synthetic operation');
  if(result!==undefined)writeFileSync(path.join(f.paths.dataDirectory,'setup-result-'+call.input.operationId+'.json'),JSON.stringify({schemaVersion:1,kind,operationId:call.input.operationId,...result}));
  Object.assign(state,{pending:false,operation:{id:call.input.operationId,kind,state:'ended'}},updates);
  for(const listener of listeners)listener({kind,operationId:call.input.operationId,code:0});
 };
 return {...f,controller,account,qq,business,state,calls,complete,setDesktopReady(value){desktopReady=value;},begin(window='window-one'){return controller.consent({operationId:randomUUID(),botId:f.bot.id,accepted:true,expectedSetupRevision:controller.data.revision},window);}};
}
async function managementApi(t,f){
 const app=await createManagementServer({runtimeDirectory:f.paths.dataDirectory,port:0,accountControlFactory:()=>({...f.account,close:async()=>{}}),qqConnectionFactory:()=>({...f.qq,close:async()=>{}}),businessControlFactory:()=>f.business,setupControlFactory:()=>f.controller});t.after(()=>app.close());
 return {async session(){
  const bootstrap=await fetch(app.origin+'/api/bootstrap'),cookie=bootstrap.headers.get('set-cookie').split(';')[0],csrf=(await bootstrap.json()).csrf;
  const get=async()=>{const response=await fetch(app.origin+'/api/state',{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();};
  return {get,async post(action,body){const state=await get(),response=await fetch(app.origin+'/api/setup/'+action,{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operationId:randomUUID(),botId:f.bot.id,expectedRevision:state.revision,expectedSetupRevision:state.setup.revision,...body})});return {status:response.status,body:await response.json()};}};
 }};
}

test('first-run orchestration automatically initializes, pairs and starts native-only without invoking a model self-test',t=>{
 const f=automaticFixture(t);f.begin();assert.deepEqual(f.calls.map(c=>c.kind),['initialize']);
 f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,serviceMode:'native-only',automaticFeatures:{enabled:true,state:'configured'}});
 assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair']);const pair=f.calls[1];assert.match(pair.privateInput.code,/^[a-f0-9]{24}$/);
 const code=f.controller.pairCode({operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:f.controller.data.revision},'window-one');assert.equal(code.code,pair.privateInput.code);
 f.complete('pair',{result:{paired:true}},{paired:true});assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair','native-start']);
 Object.assign(f.state,{running:true,pending:false,processAlive:true,serviceFresh:true,qqConnected:true});f.controller.snapshot('window-one');assert.equal(f.controller.data.actions.at(-1).state,'completed');assert.equal(f.state.executionConfigured,false);assert.equal(f.calls.some(c=>c.kind==='self-test'),false);
});
test('background state readers never own a future pairing handoff even when a consent record already exists',t=>{
 const f=automaticFixture(t);const state=f.controller.snapshot('background-auto-connect');assert.equal(f.calls.length,0);assert.equal(f.controller.automaticSessionId,null);assert.equal(state.automatic.error,'SETUP_AUTOMATIC_SESSION_RESUME_REQUIRED');
 f.begin('window-one');f.controller.snapshot('background-auto-connect');f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,automaticFeatures:{enabled:true,state:'configured'}});const pair=f.calls[1];assert.equal(f.controller.pairCode({operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:f.controller.data.revision},'window-one').code,pair.privateInput.code);assert.equal(f.controller.snapshot('background-auto-connect').pairCodeAvailable,false);
});
test('repeated state refresh and completion callbacks do not create a second initialization or pair request',t=>{
 const f=automaticFixture(t);f.begin();for(let i=0;i<5;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,1);f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,automaticFeatures:{enabled:true,state:'configured'}});for(let i=0;i<5;i++)f.controller.snapshot('window-one');assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair']);
});
test('a manual stop after the first native-only launch is preserved instead of competing with explicit model setup',t=>{
 const f=automaticFixture(t,{configured:true,paired:true});f.begin();assert.equal(f.calls[0].kind,'native-start');Object.assign(f.state,{running:true,pending:false,processAlive:true});f.controller.snapshot('window-one');Object.assign(f.state,{running:false,pending:false,processAlive:false});for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,1);assert.equal(f.controller.data.actions[0].state,'completed');
});
test('missing desktop setup remains deferred after pairing and does not issue a native-only launch loop',t=>{
 const f=automaticFixture(t,{configured:true,paired:true});f.state.automaticFeatures.state='waiting-for-desktop';f.begin();f.complete('native-start',{result:{nativeOnly:true,configured:false,waitingForDesktop:true}});for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,1);assert.equal(f.controller.data.actions[0].state,'completed');assert.equal(f.state.running,false);
});
test('revoked consent, missing QQ credentials or disabled automatic settings never spawn a setup process',t=>{
 const f=automaticFixture(t,{consent:false});f.controller.snapshot('window-one');assert.equal(f.calls.length,0);
 const missing=automaticFixture(t);missing.qq.snapshot=()=>({credentialConfigured:false});missing.begin();assert.equal(missing.calls.length,0);
 const disabled=automaticFixture(t,{configured:true,paired:true,automaticEnabled:false});disabled.begin();assert.equal(disabled.calls.length,0);
});
test('failed and unknown automatic operations remain recorded and cannot be bypassed by refresh',t=>{
 for(const unknown of [false,true]){const f=automaticFixture(t);f.begin();f.complete('initialize',unknown?undefined:{error:'SYNTHETIC_PREPARATION_FAILED'});for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,1);assert.equal(f.controller.data.actions[0].state,unknown?'unknown':'failed');}
});
test('pair-code handoff stays with the original management session even if another window refreshes',t=>{
 const f=automaticFixture(t,{configured:true});f.begin();assert.equal(f.controller.snapshot('window-one').pairCodeAvailable,true);assert.equal(f.controller.snapshot('window-two').pairCodeAvailable,false);const pair=f.calls[0];const input={operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:f.controller.data.revision};assert.throws(()=>f.controller.pairCode(input,'window-two'),e=>e.code==='PAIRING_CODE_HANDOFF_UNAVAILABLE');assert.equal(f.controller.pairCode(input,'window-one').code,pair.privateInput.code);
});
test('another window cannot take the automatic pairing handoff while initialization is still pending',t=>{
 const f=automaticFixture(t);f.begin();for(let i=0;i<3;i++)f.controller.snapshot('window-two');
 f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,automaticFeatures:{enabled:true,state:'configured'}});
 assert.equal(f.controller.automaticSessionId,'window-one');assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair']);
 const pair=f.calls[1],input={operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:f.controller.data.revision};assert.throws(()=>f.controller.pairCode(input,'window-two'),e=>e.code==='PAIRING_CODE_HANDOFF_UNAVAILABLE');assert.equal(f.controller.pairCode(input,'window-one').code,pair.privateInput.code);
});
test('rejected scoped decisions and workflow requests cannot change the initiating management session',t=>{
 for(const kind of ['consent','initialize']){
  const f=automaticFixture(t);f.begin();const input={operationId:randomUUID(),botId:f.bot.id,expectedSetupRevision:f.controller.data.revision-1,...(kind==='consent'?{accepted:true}:{})};
  assert.throws(()=>f.controller[kind](input,'window-two'),e=>e.code==='SETUP_STALE_REVISION');assert.equal(f.controller.automaticSessionId,'window-one');
  f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,automaticFeatures:{enabled:true,state:'configured'}});const pair=f.calls[1];assert.equal(f.controller.pairCode({operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:f.controller.data.revision},'window-one').code,pair.privateInput.code);
 }
});
test('a restarted manager requires an explicit scoped decision instead of letting a GET adopt the previous initialization',async t=>{
 const f=automaticFixture(t);f.begin();await f.controller.close();
 const restored=new SetupController({paths:f.paths,identity:f.identity,managementStore:f.management,accountControl:f.account,businessControl:f.business,qqConnection:f.qq,executionStatus:()=>({verified:false}),desktopReady:()=>false});t.after(()=>restored.close());
 f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,automaticFeatures:{enabled:true,state:'configured'}});
 const state=restored.snapshot('window-two');assert.equal(restored.automaticSessionId,null);assert.equal(state.automatic.error,'SETUP_AUTOMATIC_SESSION_RESUME_REQUIRED');assert.equal(f.calls.length,1);assert.equal(state.pairCodeAvailable,false);
 restored.consent({operationId:randomUUID(),botId:f.bot.id,accepted:true,expectedSetupRevision:state.revision},'window-two');assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair']);const pair=f.calls[1];assert.equal(restored.pairCode({operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:restored.data.revision},'window-two').code,pair.privateInput.code);
});
test('a restarted manager neither reveals nor resubmits a pairing that belongs to its previous process',async t=>{
 const f=automaticFixture(t,{configured:true});f.begin();const pair=f.calls[0];await f.controller.close();
 const restored=new SetupController({paths:f.paths,identity:f.identity,managementStore:f.management,accountControl:f.account,businessControl:f.business,qqConnection:f.qq,desktopReady:()=>false});t.after(()=>restored.close());
 for(const window of ['window-one','window-two']){const state=restored.snapshot(window);assert.equal(state.pairCodeAvailable,false);assert.throws(()=>restored.pairCode({operationId:pair.input.operationId,botId:f.bot.id,expectedSetupRevision:state.revision},window),e=>e.code==='PAIRING_CODE_HANDOFF_UNAVAILABLE');}
 assert.equal(f.calls.length,1);assert.equal(restored.automaticSessionId,null);
});
test('a definite deferred desktop launch resumes once after desktop readiness in the same management session',t=>{
 const f=automaticFixture(t,{configured:true,paired:true});f.state.automaticFeatures.state='waiting-for-desktop';f.begin();const initial=f.calls[0];
 f.complete('native-start',{result:{nativeOnly:true,configured:false,waitingForDesktop:true}});for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,1);
 f.setDesktopReady(true);f.controller.snapshot('window-one');assert.equal(f.calls.length,2);const resumed=f.calls[1];assert.notEqual(resumed.input.operationId,initial.input.operationId);assert.equal(f.controller.data.actions.at(-1).resumedFrom,initial.input.operationId);
 for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,2);
 f.complete('native-start',{result:{nativeOnly:true,configured:true,waitingForDesktop:false}},{automaticFeatures:{enabled:true,state:'configured'}});for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,2);
});
test('resumed desktop startup with an unknown result is never replayed after further readiness notifications',t=>{
 const f=automaticFixture(t,{configured:true,paired:true});f.state.automaticFeatures.state='waiting-for-desktop';f.begin();f.complete('native-start',{result:{nativeOnly:true,configured:false,waitingForDesktop:true}});f.setDesktopReady(true);f.controller.snapshot('window-one');assert.equal(f.calls.length,2);
 f.complete('native-start',undefined);for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,2);assert.equal(f.controller.data.actions.at(-1).state,'unknown');
});
test('a successful resumed desktop launch stays stopped after the user manually stops its service',t=>{
 const f=automaticFixture(t,{configured:true,paired:true});f.state.automaticFeatures.state='waiting-for-desktop';f.begin();f.complete('native-start',{result:{nativeOnly:true,configured:false,waitingForDesktop:true}});f.setDesktopReady(true);f.controller.snapshot('window-one');
 Object.assign(f.state,{running:true,pending:false,processAlive:true,automaticFeatures:{enabled:true,state:'configured'}});f.controller.snapshot('window-one');Object.assign(f.state,{running:false,pending:false,processAlive:false});for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,2);assert.equal(f.controller.data.actions.at(-1).state,'completed');
});
test('deferred recovery requires the exact known waiting result and never adopts failed or mismatched results',t=>{
 for(const result of [{error:'SYNTHETIC_START_FAILED'},{result:{nativeOnly:true,configured:false,waitingForDesktop:false}},{result:{nativeOnly:true,configured:true,waitingForDesktop:true}}]){
  const f=automaticFixture(t,{configured:true,paired:true});f.state.automaticFeatures.state='waiting-for-desktop';f.begin();f.complete('native-start',result);f.setDesktopReady(true);for(let i=0;i<3;i++)f.controller.snapshot('window-one');assert.equal(f.calls.length,1);
 }
});
test('the real management HTTP API advances automatic setup after scoped consent without a granted work project',async t=>{
 const f=automaticFixture(t,{consent:false});
 const app=await createManagementServer({runtimeDirectory:f.paths.dataDirectory,port:0,accountControlFactory:()=>({...f.account,close:async()=>{}}),qqConnectionFactory:()=>({...f.qq,close:async()=>{}}),businessControlFactory:()=>f.business,setupControlFactory:()=>f.controller});
 t.after(()=>app.close());
 let response=await fetch(app.origin+'/api/state');assert.equal(response.status,401);assert.equal(f.calls.length,0);
 response=await fetch(app.origin+'/api/bootstrap');const cookie=response.headers.get('set-cookie').split(';')[0],csrf=(await response.json()).csrf;
 const get=async()=>{const r=await fetch(app.origin+'/api/state',{headers:{Cookie:cookie}});assert.equal(r.status,200);return r.json();};
 let state=await get();response=await fetch(app.origin+'/api/setup/consent',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operationId:randomUUID(),botId:f.bot.id,accepted:true,expectedRevision:state.revision,expectedSetupRevision:state.setup.revision})});assert.equal(response.status,200);await response.json();assert.deepEqual(f.calls.map(c=>c.kind),['initialize']);
 f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,serviceMode:'native-only',automaticFeatures:{enabled:true,state:'configured'}});state=await get();assert.equal(state.setup.projects.length,0);assert.equal(state.setup.actions.findLast(a=>a.kind==='pair').state,'running');
 f.complete('pair',{result:{paired:true}},{paired:true});await get();assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair','native-start']);assert.equal(f.calls.some(c=>c.kind==='self-test'||c.kind==='activate'),false);
});
test('real HTTP state reads from another window cannot acquire initialization or reveal its later pairing code',async t=>{
 const f=automaticFixture(t,{consent:false}),api=await managementApi(t,f),original=await api.session(),other=await api.session();
 const consent=await original.post('consent',{accepted:true});assert.equal(consent.status,200);assert.deepEqual(f.calls.map(c=>c.kind),['initialize']);
 for(let i=0;i<3;i++)await other.get();f.complete('initialize',{result:{prepared:true}},{configured:true,serviceConfigured:true,automaticFeatures:{enabled:true,state:'configured'}});
 assert.deepEqual(f.calls.map(c=>c.kind),['initialize','pair']);const pair=f.calls[1];assert.equal((await original.get()).setup.pairCodeAvailable,true);assert.equal((await other.get()).setup.pairCodeAvailable,false);
 const denied=await other.post('pair-code',{operationId:pair.input.operationId});assert.equal(denied.status,409);assert.equal(denied.body.error,'PAIRING_CODE_HANDOFF_UNAVAILABLE');assert.equal(Object.hasOwn(denied.body,'code'),false);
 const revealed=await original.post('pair-code',{operationId:pair.input.operationId});assert.equal(revealed.status,200);assert.equal(revealed.body.code,pair.privateInput.code);assert.equal(f.calls.length,2);
});
test('real HTTP refresh resumes a known waiting desktop result once without a client or manager restart',async t=>{
 const f=automaticFixture(t,{configured:true,paired:true}),api=await managementApi(t,f),window=await api.session();f.state.automaticFeatures.state='waiting-for-desktop';
 assert.equal((await window.post('consent',{accepted:true})).status,200);const initial=f.calls[0];assert.equal(initial.kind,'native-start');f.complete('native-start',{result:{nativeOnly:true,configured:false,waitingForDesktop:true}});
 await window.get();await window.get();assert.equal(f.calls.length,1);f.setDesktopReady(true);await window.get();assert.equal(f.calls.length,2);assert.equal(f.controller.data.actions.at(-1).resumedFrom,initial.input.operationId);
 await window.get();await window.get();assert.equal(f.calls.length,2);assert.equal(f.calls.some(call=>['self-test','activate'].includes(call.kind)),false);
});
test('business child completion callbacks identify exactly their own original workflow and can be unsubscribed',async t=>{
 const f=firstRunFixture();t.after(()=>f.close());let child;const controller=new BusinessController({runtimeDirectory:f.paths.dataDirectory,managementStore:f.management,accountControl:{data:f.account},pidAlive:()=>false,spawnProcess:()=>{child=new EventEmitter();child.pid=97531;child.unref=()=>{};return child;}}),observed=[],unsubscribe=controller.onWorkflowComplete(event=>observed.push(event)),operationId=randomUUID();controller.workflow('initialize',{operationId});child.emit('exit',0);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(observed,[{kind:'initialize',operationId,code:0}]);unsubscribe();
});
