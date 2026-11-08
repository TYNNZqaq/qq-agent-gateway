import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {BusinessController} from '../packages/host-control/business-controller.mjs';

function fixture(){
 const runtime=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'business-control-')),botId=randomUUID(),agentId=randomUUID(),directory=path.join(runtime,'business',botId),home=path.join(runtime,'codex-account','home'),binding={botId,agentId,bindingId:randomUUID(),bindingVersion:1};
 mkdirSync(directory,{recursive:true});mkdirSync(home,{recursive:true});
 const config={binding,accountHome:home,chat:{model:'old-chat-model'},work:{model:'selected-work-model'},projects:{}};
 writeFileSync(path.join(directory,'config.local.json'),JSON.stringify(config));writeFileSync(path.join(runtime,'business','active.json'),JSON.stringify({botId,agentId,configRelative:botId+'/config.local.json'}));
 const children=[],alive=new Set(),controller=new BusinessController({runtimeDirectory:runtime,managementStore:{snapshot:()=>({bindings:[{id:binding.bindingId,botId,agentId,version:1}]})},pidAlive:pid=>alive.has(pid),spawnProcess:(binary,args,options)=>{const child=new EventEmitter();child.pid=73123;child.unref=()=>{};child.stdin=new EventEmitter();child.stdin.end=value=>{child.privateInput=value;};alive.add(child.pid);children.push({binary,args,options,child});return child;}});
 const service=changes=>{const value={instance:randomUUID(),pid:73123,state:'running',updatedAt:Date.now(),qqConnected:true,pendingApprovals:[],...changes};alive.add(value.pid);writeFileSync(path.join(directory,'service.json'),JSON.stringify(value));return value;};
 return {runtime,directory,config,controller,children,alive,service};
}
test('business controller launches only its fixed application entry and reconciles duplicate or live startup intents',()=>{
 const f=fixture(),operationId=randomUUID();f.controller.start({operationId});assert.equal(f.children.length,1);const c=f.children[0];assert.equal(c.binary,process.execPath);assert.deepEqual(c.args.slice(1),['serve','--runtime',f.runtime]);assert.match(c.args[0],/packages[\\/]application[\\/]cli\.mjs$/);assert.equal(c.options.shell,false);assert.equal(c.options.windowsHide,true);assert.equal(c.options.detached,true);assert.deepEqual(c.options.stdio,['ignore','ignore','ignore']);assert.equal(f.controller.snapshot().pending,true);f.controller.start({operationId});assert.equal(f.children.length,1);assert.throws(()=>f.controller.start({operationId:randomUUID()}),e=>e.code==='BUSINESS_OPERATION_PENDING');
 f.alive.clear();writeFileSync(path.join(f.runtime,'business-last-error.json'),JSON.stringify({error:'PRESERVED_CHAT_MODEL_UNAVAILABLE',time:new Date().toISOString()}));c.child.emit('exit',1);assert.equal(f.controller.snapshot().error,'PRESERVED_CHAT_MODEL_UNAVAILABLE');
});
test('business local stop and approval require the exact live instance, request fingerprint and original project grant',()=>{
 const f=fixture(),id=randomUUID(),fingerprint='a'.repeat(64),s=f.service({pendingApprovals:[{id,fingerprint,kind:'approval',canAccept:false}]});
 assert.throws(()=>f.controller.stop({operationId:randomUUID(),instance:randomUUID()}),e=>e.code==='BUSINESS_INSTANCE_CHANGED');
 assert.throws(()=>f.controller.approve({operationId:randomUUID(),instance:s.instance,id,fingerprint,accept:true}),e=>e.code==='BUSINESS_APPROVAL_OUTSIDE_GRANT');
 assert.throws(()=>f.controller.approve({operationId:randomUUID(),instance:s.instance,id,fingerprint:'b'.repeat(64),accept:false}),e=>e.code==='BUSINESS_APPROVAL_STALE');
 f.controller.approve({operationId:randomUUID(),instance:s.instance,id,fingerprint,accept:false});assert.equal(JSON.parse(readFileSync(path.join(f.directory,'action.request.json'))).accept,false);f.controller.stop({operationId:randomUUID(),instance:s.instance});assert.equal(JSON.parse(readFileSync(path.join(f.directory,'stop.request.json'))).instance,s.instance);
});
test('project grants require a stopped service and current revision and cannot contain the gateway or account data',()=>{
 const f=fixture(),project=mkdtempSync(path.join(os.tmpdir(),'qq-controller-project-')),input={operationId:randomUUID(),expectedBusinessRevision:f.controller.snapshot().revision,name:'New project',path:project,mode:'read-only',tools:['read']};
 f.service({});assert.throws(()=>f.controller.project(input),e=>e.code==='BUSINESS_STOP_FIRST');f.alive.clear();assert.throws(()=>f.controller.project({...input,expectedBusinessRevision:'stale'}),e=>e.code==='BUSINESS_STALE_REVISION');assert.throws(()=>f.controller.project({...input,path:f.config.accountHome}),e=>e.code==='BUSINESS_PROJECT_CONTROL_OVERLAP');const changed=f.controller.project(input);assert.equal(changed.projects.length,1);assert.equal(changed.projects[0].mode,'read-only');assert.notEqual(changed.revision,input.expectedBusinessRevision);
});
test('pairing secrets never enter command arguments, environment or the launch journal and invalid input never spawns',()=>{
 const f=fixture(),operationId=randomUUID(),code='c'.repeat(24);assert.throws(()=>f.controller.workflow('pair',{operationId}),e=>e.code==='BUSINESS_PAIRING_INPUT_REQUIRED');assert.equal(f.children.length,0);f.controller.workflow('pair',{operationId},{operationId,code});const c=f.children[0];assert.equal(c.args[1],'pair');assert.equal(c.options.stdio[0],'pipe');assert.equal(c.options.detached,false);assert.ok(!JSON.stringify(c.args).includes(code));assert.ok(!JSON.stringify(c.options.env).includes(code));assert.ok(!readFileSync(path.join(f.runtime,'business-launch.json'),'utf8').includes(code));assert.equal(JSON.parse(c.child.privateInput).code,code);
});
test('late process callbacks cannot overwrite the next operation and unknown launches cannot be repeated',()=>{
 const f=fixture(),first=randomUUID(),second=randomUUID();f.controller.start({operationId:first});f.alive.clear();f.controller.start({operationId:second});f.children[0].child.emit('exit',0);assert.equal(f.controller.snapshot().operation.id,second);assert.equal(f.controller.snapshot().operation.state,'spawned');f.children[1].child.emit('error',Error('synthetic'));assert.throws(()=>f.controller.start({operationId:randomUUID()}),e=>e.code==='BUSINESS_OPERATION_PENDING');assert.equal(f.children.length,2);
});
