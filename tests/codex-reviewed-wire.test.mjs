import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {reviewedCodexRequest} from '../packages/host-control/codex-reviewed-wire.mjs';
import path from 'node:path';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/codex/reviewed-alpha6-protocol.json',import.meta.url))),version=fixture.cliVersion,profile='qq-project-'+randomUUID();
const context={defaultProfile:profile,threadProfile:profile};
test('reviewed alpha.6 wire is backed by generated exact schemas without claiming live isolation',()=>{
 assert.equal(fixture.isolationAccepted,false);assert.equal(version,'0.166.0-alpha.6');
 for(const item of Object.values(fixture.schemas)){assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.ok(item.schema.$schema);}
 for(const key of ['ThreadStartParams','ThreadResumeParams','TurnStartParams'])assert.equal(Object.hasOwn(fixture.schemas['v2/'+key+'.json'].schema.properties,'permissions'),true);
 assert.equal(Object.hasOwn(fixture.schemas['v2/CommandExecParams.json'].schema.properties,'permissionProfile'),true);
});
for(const [method,file,params] of [
 ['thread/start','ThreadStartParams',{cwd:path.join(process.env.QQ_TEST_ROOT,'synthetic'),config:{default_permissions:profile},permissions:profile,approvalPolicy:'on-request',approvalsReviewer:'user'}],
 ['thread/resume','ThreadResumeParams',{threadId:randomUUID(),cwd:path.join(process.env.QQ_TEST_ROOT,'synthetic'),config:{default_permissions:profile},permissions:profile,approvalPolicy:'on-request',approvalsReviewer:'user'}],
 ['turn/start','TurnStartParams',{threadId:randomUUID(),permissions:profile,input:[{type:'text',text:'synthetic only',text_elements:[]}]}],
 ['command/exec','CommandExecParams',{command:['synthetic'],permissionProfile:profile}]
])test('alpha.6 '+method+' retains the selected policy using only exact current fields',()=>{
 const copy=JSON.stringify(params),wire=reviewedCodexRequest(version,method,params,context),schema=fixture.schemas['v2/'+file+'.json'].schema;
 for(const required of schema.required||[])assert.ok(Object.hasOwn(wire,required));for(const key of Object.keys(wire))assert.ok(Object.hasOwn(schema.properties,key),'unknown current field '+key);
 assert.equal(JSON.stringify(params),copy);assert.equal(wire,params);assert.equal(wire.permissions||wire.permissionProfile,profile);
});
test('profile mismatch, missing thread acknowledgement or thread configuration fails before transport write',()=>{
 for(const ctx of [{},{...context,defaultProfile:'qq-project'},{defaultProfile:profile}])assert.throws(()=>reviewedCodexRequest(version,'turn/start',{permissions:profile},ctx),/CLI_PERMISSION_PROFILE_MISMATCH/);
 assert.throws(()=>reviewedCodexRequest(version,'thread/start',{permissions:profile,config:{}},context),/CLI_PERMISSION_PROFILE_MISMATCH/);
});
test('legacy wire and unrelated alpha.6 requests remain byte-equivalent',()=>{
 const params={permissions:profile,threadId:randomUUID()};assert.equal(reviewedCodexRequest('0.166.0-alpha.5.1','turn/start',params,context),params);const read={threadId:randomUUID(),includeTurns:false};assert.equal(reviewedCodexRequest(version,'thread/read',read,context),read);
});
