import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry, ADAPTER_METHODS, CAPABILITIES } from '../packages/core/adapter-registry.mjs';
import { migrateSyntheticV0, rollbackSyntheticV0, validateConfiguration } from '../packages/core/configuration.mjs';
import { scope, scopeKey } from '../packages/core/contracts.mjs';
import { SessionScheduler } from '../packages/core/session-scheduler.mjs';
import { parseTaskReference, taskReference } from '../packages/core/task-reference.mjs';
import { configuration, testScope } from './foundation-fixtures.mjs';

test('single and multiple bots share one immutable configuration contract',()=>{
  const multiple=validateConfiguration(configuration());assert.equal(multiple.agents.length,2);assert.ok(Object.isFrozen(multiple.bindings[0]));
  const single=configuration();single.bots.pop();single.agents.pop();single.bindings.pop();
  assert.equal(validateConfiguration(single).bots.length,1);
});
const invalid=[
  ['duplicate IDs',c=>c.bots.push({...c.bots[0]})],
  ['AppID conflict',c=>c.bots[1].appId=c.bots[0].appId],
  ['dangling binding',c=>c.bindings[0].agentId='missing'],
  ['dangling project',c=>c.agents[0].workspaceRef='missing'],
  ['duplicate active agent binding',c=>c.bindings[1].agentId=c.agents[0].id],
  ['incompatible contract',c=>c.contractVersion=2],
  ['raw credentials',c=>c.bots[0].secret='synthetic-do-not-echo'],
  ['unverified permissions',c=>c.policies[0].shell=true],
  ['execution gate',c=>c.executionEnabled=true],
  ['disabled target',c=>c.agents[0].enabled=false]
  ,['enabled bot missing a binding',c=>c.bindings.pop()]
];
for(const [name,mutate] of invalid)test('configuration rejects '+name,()=>{
  const c=configuration();mutate(c);assert.throws(()=>validateConfiguration(c),e=>!!e.code&&!e.message.includes('synthetic-do-not-echo'));
});
test('scope requires every ownership field and ignores object key order',()=>{
  const original=testScope(),reordered=Object.fromEntries(Object.entries(original).reverse());
  assert.equal(scopeKey(original),scopeKey(reordered));
  for(const key of Object.keys(original)){const bad={...original};delete bad[key];assert.throws(()=>scope(bad));}
  assert.notEqual(scopeKey(original),scopeKey(testScope('b')));
  assert.notEqual(scopeKey(original),scopeKey({...original,bindingVersion:2}));
});
test('synthetic V0 migration preserves settings and exact rollback without mutating the source',()=>{
  const legacy={schemaVersion:0,qq:{appId:'10000001',credentialRef:null},executor:{adapterId:'synthetic-one',workspaceRef:'project-x',policyRef:'offline',modelRef:null},settings:{displayName:'Synthetic owner',numberingBase:37}};
  const original=structuredClone(legacy),plan=migrateSyntheticV0(legacy);
  assert.deepEqual(rollbackSyntheticV0(plan),original);assert.deepEqual(legacy,original);
  const tampered=structuredClone(plan);tampered.original.settings.numberingBase=0;assert.throws(()=>rollbackSyntheticV0(tampered),{code:'ROLLBACK_BACKUP_MISMATCH'});
  assert.throws(()=>migrateSyntheticV0({...legacy,qq:{...legacy.qq,secret:'fake'}}));
});
const descriptor=id=>({id,version:'1.0.0',contractVersion:1,protocolRange:'synthetic-v1',capabilities:Object.fromEntries(CAPABILITIES.map(k=>[k,{status:'unsupported',reason:'Synthetic contract only; no real runtime.'}]))});
test('registry validates descriptors, lazy factories and a fourth independent adapter',()=>{
  const registry=new AdapterRegistry();let started=0;
  for(const id of ['sample-one','sample-two','sample-three','sample-four'])registry.register(descriptor(id),()=>{started++;return Object.fromEntries(ADAPTER_METHODS.map(k=>[k,async()=>({synthetic:true})]));});
  assert.equal(started,0);assert.equal(registry.list().length,4);
  const adapter=registry.create({id:'agent-x',adapterId:'sample-four'},{agentId:'agent-x'});
  assert.equal(typeof adapter.reconcile,'function');assert.equal(started,1);
  assert.throws(()=>registry.register(descriptor('sample-four'),()=>{}),{code:'DUPLICATE_ADAPTER'});
  assert.throws(()=>registry.create({id:'agent-x',adapterId:'sample-four'},{agentId:'other'}),{code:'ADAPTER_SCOPE_MISMATCH'});
  assert.throws(()=>registry.describe('missing'),{code:'UNKNOWN_ADAPTER'});
  assert.throws(()=>registry.register({...descriptor('v2'),contractVersion:2},()=>{}),{code:'ADAPTER_CONTRACT_INCOMPATIBLE'});
  registry.register(descriptor('broken'),()=>({}));assert.throws(()=>registry.create({id:'a',adapterId:'broken'},{agentId:'a'}),{code:'ADAPTER_METHOD_MISSING'});
});
test('session scheduling serializes a session and bounds parallel agents',async()=>{
  const scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1}),releases=[];let active=0,peak=0;const starts=[];
  const work=name=>()=>new Promise(resolve=>{active++;peak=Math.max(peak,active);starts.push(name);releases.push(()=>{active--;resolve(name);});});
  const a=scheduler.submit(testScope(),'task-1',work('a1'));
  const a2=scheduler.submit(testScope(),'task-2',work('a2'));
  const b=scheduler.submit(testScope('b'),'task-3',work('b1'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(starts,['a1','b1']);assert.equal(peak,2);
  assert.throws(()=>scheduler.submit(testScope(),'task-2',()=>{}),{code:'TASK_ALREADY_SCHEDULED'});
  releases.shift()();await a;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(starts,['a1','b1','a2']);
  for(const release of releases)release();await Promise.all([a2,b]);scheduler.close();
  assert.throws(()=>scheduler.submit(testScope(),'task-4',()=>{}),{code:'SCHEDULER_CLOSED'});
});
test('a failed task releases the scheduler slot; closing rejects queued tasks',async()=>{
  const scheduler=new SessionScheduler({maxConcurrent:1});let release;
  const first=scheduler.submit(testScope(),'task-1',()=>new Promise(resolve=>release=resolve));
  const queued=scheduler.submit(testScope(),'task-2',()=>assert.fail('must stay queued'));
  const rejected=assert.rejects(queued,{code:'SCHEDULER_CLOSED'});scheduler.close();await rejected;
  await new Promise(resolve=>setImmediate(resolve));release();await first;
  const next=new SessionScheduler({maxConcurrent:1});
  const failing=next.submit(testScope(),'task-fail',()=>{throw Error('synthetic failure');});
  const succeeding=next.submit(testScope('b'),'task-ok',()=>42);
  await assert.rejects(failing);assert.equal(await succeeding,42);next.close();
});
test('task reference format preserves the project and T-number convention',()=>{
  assert.equal(taskReference({projectName:'Project X',number:37}),'Project X T37');
  assert.deepEqual(parseTaskReference('Project X T37'),{projectName:'Project X',number:37});
  assert.equal(parseTaskReference('Project X A37'),null);assert.equal(parseTaskReference('T37'),null);
});
