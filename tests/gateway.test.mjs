import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalGateway } from '../packages/gateway-qq/local-gateway.mjs';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { configuration } from './foundation-fixtures.mjs';

function fixture(t,options={}){
  const store=new WorkStore(':memory:',{hostId:'host-test',clock:options.clock});t.after(()=>store.close());
  const gateway=new LocalGateway(configuration(),store,options);
  const a=gateway.attach('bot-a',{authenticatedAppId:'10000001'}),b=gateway.attach('bot-b',{authenticatedAppId:'10000002'});
  for(const botId of ['bot-a','bot-b'])gateway.pair({botId,senderRef:'same-user',conversationRef:'same-conversation',expiresAt:(options.clock?.()??Date.now())+3600000});
  return {store,gateway,a,b};
}
const message=(appId='10000001',overrides={})=>({eventId:'same-event',senderRef:'same-user',conversationRef:'same-conversation',senderIsBot:false,targetAppId:appId,kind:'work',text:'synthetic request',...overrides});

test('trusted connections isolate identical sender, conversation and event IDs across bots',t=>{
  const f=fixture(t),a=f.a.receive(message()),b=f.b.receive(message('10000002'));
  assert.equal(a.scope.botId,'bot-a');assert.equal(b.scope.botId,'bot-b');assert.notEqual(a.scope.principalId,b.scope.principalId);assert.notEqual(a.scope.conversationId,b.scope.conversationId);assert.notEqual(a.taskId,b.taskId);
  assert.throws(()=>f.store.task(b.scope,a.taskId),{code:'SCOPED_NOT_FOUND'});
});
test('message body cannot override bot identity, principal, binding or project',t=>{
  const f=fixture(t),text=JSON.stringify({botId:'bot-b',agentId:'agent-b',bindingVersion:99,projectId:'project-y'}),r=f.a.receive(message(undefined,{text}));
  assert.equal(r.scope.botId,'bot-a');assert.equal(r.scope.projectId,'project-x');assert.equal(f.store.task(r.scope,r.taskId).goal,text);
  assert.throws(()=>f.a.receive({...message(),botId:'bot-b'}),{code:'INVALID_FIELDS'});
});
test('wrong targets, untrusted authors, mismatched credentials and duplicate connections fail',t=>{
  const f=fixture(t);
  assert.throws(()=>f.a.receive(message('10000002')),{code:'WRONG_BOT_TARGET'});
  assert.throws(()=>f.a.receive(message(undefined,{senderIsBot:undefined})),{code:'INVALID_TRANSPORT_AUTHOR'});
  assert.throws(()=>f.gateway.attach('bot-a',{authenticatedAppId:'10000002'}),{code:'BOT_AUTHENTICATION_FAILED'});
  assert.throws(()=>f.gateway.attach('bot-a',{authenticatedAppId:'10000001'}),{code:'BOT_CONNECTION_EXISTS'});
});
test('bot echoes do not create tasks or cross-agent loops',t=>{
  const f=fixture(t);assert.deepEqual(f.a.receive(message(undefined,{senderIsBot:true})),{ignored:true,reason:'bot_echo'});
  assert.equal(f.a.receive(message()).duplicate,false);
});
test('expired and revoked pairings cannot route new events',t=>{
  let now=1000;const f=fixture(t,{clock:()=>now});
  f.gateway.pair({botId:'bot-a',senderRef:'same-user',conversationRef:'same-conversation',expiresAt:2000});now=2000;
  assert.throws(()=>f.a.receive(message()),{code:'PAIRING_REQUIRED'});
  assert.equal(f.b.receive(message('10000002')).duplicate,false);
  f.gateway.unpair({botId:'bot-b',senderRef:'same-user',conversationRef:'same-conversation'});
  assert.throws(()=>f.b.receive(message('10000002',{eventId:'next'})),{code:'PAIRING_REQUIRED'});
});
test('rate windows and transport faults are isolated by BotIdentity',t=>{
  let now=1000;const f=fixture(t,{clock:()=>now,messagesPerMinute:1});f.a.receive(message());
  assert.throws(()=>f.a.receive(message(undefined,{eventId:'event-2'})),{code:'BOT_RATE_LIMITED'});
  assert.equal(f.b.receive(message('10000002')).duplicate,false);now+=60000;
  assert.equal(f.a.receive(message(undefined,{eventId:'event-2'})).duplicate,false);f.a.close();
  assert.throws(()=>f.a.receive(message()),{code:'CONNECTION_REVOKED'});
  assert.equal(f.b.receive(message('10000002',{eventId:'event-3'})).duplicate,false);
});
test('rebinding revokes old handles and pairings while leaving the other bot connected',t=>{
  const f=fixture(t),old=f.a.receive(message()),next=configuration();next.revision=2;next.bindings[0].version=2;
  f.gateway.replaceConfiguration(next);assert.throws(()=>f.a.receive(message()),{code:'CONNECTION_REVOKED'});
  const replacement=f.gateway.attach('bot-a',{authenticatedAppId:'10000001'});
  assert.throws(()=>replacement.receive(message(undefined,{eventId:'new'})),{code:'PAIRING_REQUIRED'});
  f.gateway.pair({botId:'bot-a',senderRef:'same-user',conversationRef:'same-conversation',expiresAt:Date.now()+3600000});
  const duplicate=replacement.receive(message());assert.equal(duplicate.stale,true);assert.equal(duplicate.taskId,null);
  assert.equal(replacement.receive(message(undefined,{eventId:'new'})).scope.bindingVersion,2);
  assert.equal(f.store.task(old.scope,old.taskId).state,'held');assert.equal(f.b.receive(message('10000002')).duplicate,false);
});
test('failed configuration reload is atomic and keeps valid connections available',t=>{
  const f=fixture(t),bad=configuration();bad.revision=2;bad.agents[0].workspaceRef='project-y';
  assert.throws(()=>f.gateway.replaceConfiguration(bad),{code:'BINDING_VERSION_REQUIRED'});
  assert.equal(f.a.receive(message()).scope.projectId,'project-x');assert.equal(f.b.receive(message('10000002')).scope.projectId,'project-y');
});
