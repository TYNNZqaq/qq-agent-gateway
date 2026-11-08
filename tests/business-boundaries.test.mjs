import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {checkSources,BUSINESS_PROCESS_FILES} from '../scripts/check-boundaries.mjs';
import {taskPermissionConfig,runtimeEnvironment} from '../packages/application/app-server-rpc.mjs';
import {applicationCacheEnvironment} from '../packages/host-control/application-cache.mjs';
import {instructionIntake} from '../packages/application/instruction-intake.mjs';
import {localCodexProxy} from '../packages/host-control/codex-network-policy.mjs';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
test('the compatibility business implementation stays unreachable from the management import graph',()=>{
  const file='packages/application/store.mjs';assert.equal(checkSources(new Map([[file,'export const x=1;'],['packages/host-control/local-server.mjs',"import '../application/store.mjs';"]])).passed,false);
});
test('reviewed process files do not authorize neighbouring application executors',()=>{
  assert.ok(BUSINESS_PROCESS_FILES.includes('packages/application/app-server-rpc.mjs'));assert.equal(checkSources(new Map([['packages/application/unreviewed.mjs',"import {spawn} from 'node:child_process';"]])).passed,false);
});
test('business project permissions exclude control directories and inherited credentials',()=>{
  const base=path.resolve(process.env.QQ_TEST_ROOT,'policy-layout'),project=path.join(base,'project'),control=path.join(base,'control'),home=path.join(base,'own-home'),policy=taskPermissionConfig(project,{write:true,shell:true,controlRoots:[control]});assert.equal(policy['permissions.qq-project.filesystem'][control],'deny');assert.equal(policy['permissions.qq-project.network.enabled'],false);assert.throws(()=>taskPermissionConfig(base,{controlRoots:[control]}));assert.deepEqual(runtimeEnvironment(home,{PATH:'system',OPENAI_API_KEY:'private',QQ_SECRET:'private',CODEX_HOME:'other',NODE_OPTIONS:'private'}),{PATH:'system',CODEX_HOME:home,...applicationCacheEnvironment(home)});
});
test('trusted repository instruction intake preserves parent precedence, override files and verifiable content',()=>{
  const base=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'instructions-')),project=path.join(base,'project'),home=path.join(base,'home');mkdirSync(project);mkdirSync(home);writeFileSync(path.join(base,'AGENTS.md'),'PARENT_POLICY');writeFileSync(path.join(project,'AGENTS.override.md'),'PROJECT_OVERRIDE');writeFileSync(path.join(project,'AGENTS.md'),'IGNORED_SIBLING');const result=instructionIntake({project,accountHome:home});assert.ok(result.text.indexOf('PARENT_POLICY')<result.text.indexOf('PROJECT_OVERRIDE'));assert.ok(!result.text.includes('IGNORED_SIBLING'));assert.ok(result.manifest.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));writeFileSync(path.join(project,'AGENTS.override.md'),'CHANGED');assert.notEqual(instructionIntake({project,accountHome:home}).fingerprint,result.fingerprint);
});
test('Codex API proxy forwarding permits only a preconfigured credential-free loopback endpoint',()=>{
  assert.deepEqual(localCodexProxy({HTTPS_PROXY:'http://127.0.0.1:12345'}),{HTTPS_PROXY:'http://127.0.0.1:12345',HTTP_PROXY:'http://127.0.0.1:12345',NO_PROXY:'localhost,127.0.0.1,::1'});
  for(const proxy of ['http://user:secret@127.0.0.1:12345','https://external.invalid:12345','http://127.0.0.1:12345/path','socks5://127.0.0.1:12345'])assert.deepEqual(localCodexProxy({HTTPS_PROXY:proxy}),{});
});
