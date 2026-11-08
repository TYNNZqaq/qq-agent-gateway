import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createCodexRpcFactory} from '../packages/host-control/codex-authenticated-runtime.mjs';
import {resolveCodexExecutable} from '../packages/application/executable.mjs';
import {accountIdentityFingerprint} from '../packages/host-control/codex-account-policy.mjs';
function fixture(){
 const temp=realpathSync(mkdtempSync(path.join(os.tmpdir(),'qq-authenticated-runtime-'))),runtime=path.join(temp,'runtime'),project=path.join(temp,'project'),home=path.join(runtime,'codex-account','home'),binary=path.join(temp,'codex.exe');for(const d of [runtime,project,home])mkdirSync(d,{recursive:true});writeFileSync(binary,'synthetic never executed');
 const binding={botId:randomUUID(),agentId:randomUUID(),bindingId:randomUUID(),bindingVersion:3},config={runtimeRoot:runtime,stateDir:path.join(runtime,'business'),accountHome:home,instanceId:randomUUID(),binding,executor:{binary},projects:{demo:{id:randomUUID(),grantId:randomUUID(),path:realpathSync(project),mode:'workspace-write',tools:['read','edit','shell']}}};
 const a={agentId:binding.agentId,connectionId:randomUUID(),selected:{model:'explicit-model',accountEpoch:randomUUID()},actions:[]},f={config,account:a,owner:'paired-owner',allowed:true,proof:true,bound:[],calls:[],rpcConfigs:[]};
 f.factory=()=>createCodexRpcFactory({config,store:{get:()=>f.owner},authorize:()=>f.allowed,readAccount:()=>a,readProof:()=>({verified:f.proof,reason:'PROOF_CHANGED',proof:{nativeAccountFingerprint:accountIdentityFingerprint({type:'chatgpt',email:'synthetic-owner@example.invalid'})}}),bindWork:ctx=>{f.bound.push(ctx);return {accountHome:home,runtimeGuard:()=>{if(!f.allowed)throw Error('REVOKED');}};},makeRpc:c=>{f.rpcConfigs.push(c);return {async start(){f.calls.push('start');},async call(method){f.calls.push(method);return {account:{type:'chatgpt',email:'synthetic-owner@example.invalid'}};},async close(){f.calls.push('close');}};}});
 f.task={id:7,owner_key:f.owner,project:'demo',attempt:1};return f;
}
test('authenticated work factory binds all nine scope fields and exact project before returning a turn-capable client',async()=>{
 const f=fixture(),client=f.factory()(f.config,f.task);assert.equal(Object.keys(f.bound[0].owner).length,9);assert.equal(f.bound[0].owner.bindingVersion,3);assert.equal(f.bound[0].grant.projectPath,f.config.projects.demo.path);assert.deepEqual(f.bound[0].grant.tools,['file-read','file-write','command']);assert.equal(f.rpcConfigs[0].allowTurns,true);assert.equal(f.rpcConfigs[0].startupPolicy.default_permissions,client.permissionProfile);await client.start();assert.deepEqual(f.calls,['start','account/read']);
});
test('proof changes, owner changes and revocation prevent preparation or later wire use',()=>{
 const f=fixture();f.proof=false;assert.throws(()=>f.factory()(f.config,f.task),/PROOF_CHANGED/);assert.equal(f.bound.length,0);f.proof=true;f.task.owner_key='foreign';assert.throws(()=>f.factory()(f.config,f.task));f.task.owner_key=f.owner;const client=f.factory()(f.config,f.task);f.allowed=false;assert.throws(()=>f.rpcConfigs[0].runtimeGuard());
});
test('same local task maps to the same durable process key, while binding or Run attempt changes the key',()=>{
 const f=fixture(),make=f.factory();make(f.config,f.task);make(f.config,f.task);assert.equal(f.bound[0].processKey,f.bound[1].processKey);make(f.config,{...f.task,attempt:2});assert.notEqual(f.bound[0].processKey,f.bound[2].processKey);
});
test('CLI resolution uses explicit verified files or environment discovery and preserves missing explicit choices',()=>{
 const f=fixture();assert.equal(resolveCodexExecutable(f.config.executor.binary),f.config.executor.binary);assert.equal(resolveCodexExecutable('codex',{environment:{CODEX_APP_RUNTIME_CLI_PATH:f.config.executor.binary,PATH:''},platform:'win32'}),f.config.executor.binary);assert.throws(()=>resolveCodexExecutable(path.join(path.dirname(f.config.executor.binary),'missing.exe'),{environment:{CODEX_APP_RUNTIME_CLI_PATH:f.config.executor.binary}}),/NOT_FOUND/);
});
test('native account drift closes the client before a model task can be submitted',async()=>{
 const f=fixture();
 // The observed native account differs from the account fingerprint bound to the local proof.
 const original=accountIdentityFingerprint({type:'chatgpt',email:'synthetic-owner@example.invalid'});assert.notEqual(original,accountIdentityFingerprint({type:'chatgpt',email:'different-owner@example.invalid'}));
 const changed=createCodexRpcFactory({config:f.config,store:{get:()=>f.owner},authorize:()=>true,readAccount:()=>f.account,readProof:()=>({verified:true,proof:{nativeAccountFingerprint:original}}),bindWork:()=>({accountHome:f.config.accountHome,runtimeGuard(){}}),makeRpc:()=>({async start(){},async call(){return {account:{type:'chatgpt',email:'different-owner@example.invalid'}};},async close(){f.calls.push('closed-after-account-drift');}})})(f.config,f.task);await assert.rejects(changed.start(),/RUNTIME_ACCOUNT_IDENTITY_CHANGED/);assert.ok(f.calls.includes('closed-after-account-drift'));
});
