import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {initializeApplicationData} from '../packages/host-control/application-paths.mjs';
import {CODEX_ISOLATION_CHECKS} from '../packages/host-control/codex-live-status.mjs';
import {runCodexSelfTest} from '../packages/application/self-test.mjs';
function fixture(mode='completed'){
 const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'self-test-')),initialized=initializeApplicationData({dataDirectory:path.join(root,'data'),home:root}),paths=initialized.paths;mkdirSync(paths.accountHome,{recursive:true});const binding={botId:randomUUID(),agentId:randomUUID(),bindingId:randomUUID(),bindingVersion:1},consent={id:randomUUID(),confirmed:true};writeFileSync(paths.consentFile,JSON.stringify(consent));
 const context={...initialized,binding,consent,scope:{instanceId:initialized.identity.instanceId,model:'synthetic-model'},account:{connectionId:randomUUID(),selected:{model:'synthetic-model',accountEpoch:randomUUID()},actions:[]}},config={runtimeRoot:paths.dataDirectory,executor:{binary:process.execPath}},calls=[];
 class Rpc extends EventEmitter{constructor(c){super();this.config=c;}async start(){calls.push('start');}async close(){this.emit('closed');}respond(){}reject(){}async call(method,p){calls.push(method);if(method==='account/read')return {account:{type:'chatgpt',email:'synthetic@example.invalid'}};if(method==='thread/start'&&mode==='session-unknown')throw Object.assign(Error('APP_SERVER_TIMEOUT'),{uncertain:true});if(method==='thread/start')return {thread:{id:'thread-own',sessionId:'session-own'},cwd:this.config.executionCwd,activePermissionProfile:{id:p.permissions,extends:null},sandbox:{type:'workspaceWrite',networkAccess:false}};
  if(method==='command/exec')return {exitCode:0,stdout:JSON.stringify(Object.fromEntries(CODEX_ISOLATION_CHECKS.map(k=>[k,mode==='isolation-failed'&&k==='networkDenied'?false:true])))};if(method==='model/list')return {data:[{id:'synthetic-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};if(method==='turn/start'){
   if(mode==='unknown'){this.emit('closed');return {turn:{id:'turn-own'}};}writeFileSync(path.join(this.config.executionCwd,'model-verified.txt'),'CODEX_QQ_LINK_OK');this.emit('notification',{method:'item/completed',params:{threadId:'thread-own',turnId:'turn-foreign',item:{type:'agentMessage',text:'wrong'}}});this.emit('notification',{method:'item/completed',params:{threadId:'thread-own',turnId:'turn-own',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({outcome:'completed',summary:'CODEX_QQ_LINK_OK'})}}});this.emit('notification',{method:'turn/completed',params:{threadId:'thread-own',turn:{id:'turn-own',status:'completed'}}});return {turn:{id:'turn-own'}};
  }throw Error('UNEXPECTED_SYNTHETIC_METHOD');}}
 const run=(operationId=randomUUID())=>runCodexSelfTest(config,{operationId,readContext:()=>context,bindWork:({authorize})=>{assert.equal(authorize(),true);return {onProcessClosed(){}};},makeRpc:c=>new Rpc(c),openServer:()=>{const server=new EventEmitter();server.listening=false;server.listen=(_port,_host,ready)=>{server.listening=true;ready();};server.address=()=>({port:12345});server.close=done=>{server.listening=false;done();};return server;},connect:()=>{const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit('connect'));return socket;},timeoutMs:1000});return {paths,calls,run};
}
test('synthetic self-test binds early events to the exact turn but can never write a real machine acceptance',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.accepted,true);assert.equal(r.runtimeEvidence,'synthetic-only');assert.equal(r.turn.turnId,'turn-own');assert.equal(r.modelFileVerified,true);assert.equal(f.calls.filter(m=>m==='turn/start').length,1);assert.equal(existsSync(path.join(f.paths.dataDirectory,'codex-account-work','accepted.json')),false);
});
test('failed isolation blocks model dispatch even when the synthetic process claims authentication',async()=>{
 const f=fixture('isolation-failed'),r=await f.run();assert.equal(r.accepted,false);assert.equal(r.state,'failed');assert.equal(r.error,'SELF_TEST_ISOLATION_FAILED');assert.equal(f.calls.includes('turn/start'),false);
});
test('an unconfirmed self-test turn remains unknown and the same operation cannot be repeated',async()=>{
 const f=fixture('unknown'),id=randomUUID(),r=await f.run(id);assert.equal(r.state,'unknown');assert.equal(r.accepted,false);assert.equal(r.turn.turnId,'turn-own');await assert.rejects(f.run(id),/PRIOR_RESULT_REQUIRES_RECONCILIATION/);assert.equal(f.calls.filter(m=>m==='turn/start').length,1);
});
test('unknown native session creation is retained as unknown even before model dispatch and cannot be retried',async()=>{
 const f=fixture('session-unknown'),id=randomUUID(),result=await f.run(id);assert.equal(result.state,'unknown');assert.equal(result.session.state,'intent');assert.equal(f.calls.includes('turn/start'),false);await assert.rejects(f.run(id),/PRIOR_RESULT_REQUIRES_RECONCILIATION/);
});
