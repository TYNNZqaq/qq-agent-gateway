import test from 'node:test';
import assert from 'node:assert/strict';
import {businessFailure,createBusinessStatusPublisher} from '../packages/application/business-runtime.mjs';

test('business worker diagnostics identify the failing stage without persisting exception contents',()=>{
 const failure=new Error('password=private-canary; paired-person; command body');
 failure.code='ERR_SQLITE_ERROR';failure.errcode=5;
 const diagnostic=businessFailure(failure,'send');
 assert.equal(diagnostic.stage,'send');assert.equal(diagnostic.code,'ERR_SQLITE_ERROR');assert.equal(diagnostic.errcode,5);
 assert.equal(diagnostic.knownMessage,null);assert.match(diagnostic.messageHash,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(diagnostic),/private-canary|paired-person|command body|password=/);
 assert.equal(businessFailure(Error('BUSINESS_BINDING_REVOKED'),'status').knownMessage,'BUSINESS_BINDING_REVOKED');
});

test('brief sharing violations publishing service status recover without retrying any business action',()=>{
 let attempts=0,at=1000;const notices=[],file=process.cwd()+'/service.json';
 const publish=createBusinessStatusPublisher(file,{now:()=>at,onTransient:(_error,state)=>notices.push(state),write:()=>{if(++attempts<=2)throw Object.assign(Error('sharing violation'),{code:'EPERM',syscall:'rename',dest:file});}});
 assert.equal(publish({state:'running'}),false);at+=1000;assert.equal(publish({state:'running'}),false);at+=1000;assert.equal(publish({state:'running'}),true);
 assert.equal(attempts,3);assert.equal(notices.length,2);assert.deepEqual(publish.snapshot(),{consecutiveFailures:0,totalFailures:2,lastSuccessAt:3000});
});

test('persistent service status failure closes after a bounded count or stale heartbeat',()=>{
 for(const stale of [false,true]){let at=1000;const file=process.cwd()+'/service.json',publish=createBusinessStatusPublisher(file,{now:()=>at,write:()=>{throw Object.assign(Error('locked'),{code:'EACCES',syscall:'rename',dest:file});}});
  assert.equal(publish({}),false);if(stale){at+=10000;assert.throws(()=>publish({}),/BUSINESS_STATUS_UNAVAILABLE/);}else{for(let i=0;i<3;i++)assert.equal(publish({}),false);assert.throws(()=>publish({}),/BUSINESS_STATUS_UNAVAILABLE/);}
 }
});

test('status recovery never swallows configuration, database or unrelated filesystem failures',()=>{
 const file=process.cwd()+'/service.json';for(const details of [{code:'ERR_SQLITE_ERROR'},{code:'EPERM',syscall:'open',dest:file},{code:'EPERM',syscall:'rename',dest:file+'.other'},{code:'ENOENT',syscall:'rename',dest:file}]){
  const error=Object.assign(Error('failure'),details),publish=createBusinessStatusPublisher(file,{write:()=>{throw error;}});assert.throws(()=>publish({}),value=>value===error);
 }
});
