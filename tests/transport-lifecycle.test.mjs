import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { BotTransportLifecycle } from '../packages/gateway-qq/bot-transport-lifecycle.mjs';
import { LocalGateway } from '../packages/gateway-qq/local-gateway.mjs';
import { WorkStore } from '../packages/storage/work-store.mjs';
import { configuration, event } from './foundation-fixtures.mjs';
import { SessionScheduler } from '../packages/core/session-scheduler.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const message=(bot='a',eventId='same-event')=>({eventId,senderRef:'same-user',conversationRef:'same-conversation',senderIsBot:false,targetAppId:bot==='a'?'10000001':'10000002',kind:'work',text:'synthetic request'});
function fixture(t,options={}){
  let now=1000;
  const clock=()=>now,config=configuration();config.bots.forEach(b=>{b.credentialRef='synthetic-'+b.id;});
  const store=new WorkStore(options.database??':memory:',{hostId:config.hostId,clock});t.after(()=>store.close());
  const gateway=new LocalGateway(config,store,{clock,messagesPerMinute:options.messagesPerMinute??60});
  const calls=[],transports=[],lifecycles=[];
  const credentialProvider=async request=>{
    calls.push(request);const base={botId:request.botId,credentialRef:request.credentialRef,appId:config.bots.find(b=>b.id===request.botId).appId,token:'synthetic-token-'+request.botId+'-'+calls.length,expiresAt:now+(request.botId==='bot-a'?10000:20000)};
    return options.credentials?options.credentials(request,base):base;
  };
  const transportFactory=async callbacks=>{
    const transport={callbacks,connectCalls:[],closed:0,
      async connect(credential){this.connectCalls.push(credential);return options.connect?options.connect(callbacks,credential):{authenticatedAppId:callbacks.appId};},
      close(){this.closed++;}};
    transports.push(transport);return transport;
  };
  const create=()=>{const lifecycle=new BotTransportLifecycle(config,{gateway,store,credentialProvider,transportFactory,clock,refreshBeforeMs:1000,baseBackoffMs:100,maxBackoffMs:250,maxRetries:3,...options.policy});lifecycles.push(lifecycle);return lifecycle;};
  const lifecycle=create();
  const pair=(botId='bot-a',expiresAt=now+3600000)=>gateway.pair({botId,senderRef:'same-user',conversationRef:'same-conversation',expiresAt});
  const latest=botId=>transports.filter(tr=>tr.callbacks.botId===botId).at(-1);
  return {config,store,gateway,lifecycle,create,calls,transports,pair,latest,advance:ms=>{now+=ms;},now:()=>now};
}

test('each Bot resolves its own credential reference and authenticates an independent connection',async t=>{
  const f=fixture(t);f.pair();f.pair('bot-b');await Promise.all([f.lifecycle.start('bot-a'),f.lifecycle.start('bot-b')]);
  assert.deepEqual(f.calls.map(c=>[c.botId,c.credentialRef]),[['bot-a','synthetic-bot-a'],['bot-b','synthetic-bot-b']]);
  const a=f.latest('bot-a'),b=f.latest('bot-b');assert.notEqual(a.connectCalls[0].token,b.connectCalls[0].token);
  const ra=a.callbacks.onMessage(message()),rb=b.callbacks.onMessage(message('b'));assert.notEqual(ra.taskId,rb.taskId);
  assert.equal(a.callbacks.onMessage(message()).duplicate,true);
  assert.throws(()=>f.lifecycle.start('bot-a'),{code:'BOT_CONNECTION_EXISTS'});
  assert.equal(JSON.stringify(f.lifecycle.status('bot-a')).includes('synthetic-token'),false);
  f.lifecycle.stop('bot-a');assert.equal(f.lifecycle.status('bot-b').state,'connected');
  assert.equal(b.callbacks.onMessage(message('b','after-a-stop')).duplicate,false);
});
test('refresh rotates only the expiring Bot, rejects its old callback and preserves inbound de-duplication',async t=>{
  const f=fixture(t);f.pair();f.pair('bot-b');await f.lifecycle.start('bot-a');await f.lifecycle.start('bot-b');
  const old=f.latest('bot-a'),b=f.latest('bot-b');const first=old.callbacks.onMessage(message());
  f.advance(9000);await f.lifecycle.tick();assert.equal(f.calls.length,3);assert.equal(f.calls[2].botId,'bot-a');
  assert.equal(old.closed,1);assert.equal(b.closed,0);assert.equal(f.lifecycle.status('bot-b').generation,1);
  assert.equal(old.callbacks.onMessage(message('a','late')).ignored,true);
  assert.equal(f.latest('bot-a').callbacks.onMessage(message()).taskId,first.taskId);
  assert.equal(f.latest('bot-b').callbacks.onMessage(message('b')).duplicate,false);
});
for(const mode of ['cross-bot','expired','handshake'])test('invalid '+mode+' credentials stop only the affected Bot without automatic retry',async t=>{
  const f=fixture(t,{credentials:(request,base)=>request.botId==='bot-a'?{...base,...(mode==='cross-bot'?{botId:'bot-b'}:mode==='expired'?{expiresAt:1000}:{})}:base,
    connect:async cb=>({authenticatedAppId:cb.botId==='bot-a'&&mode==='handshake'?'10000002':cb.appId})});
  await f.lifecycle.start('bot-a');await f.lifecycle.start('bot-b');
  assert.equal(f.lifecycle.status('bot-a').state,'credential_error');assert.equal(f.lifecycle.status('bot-b').state,'connected');
  f.advance(5000);await f.lifecycle.tick();assert.equal(f.calls.filter(c=>c.botId==='bot-a').length,1);
});
test('untrusted exception text is redacted and reconnect has capped delays and a finite retry budget',async t=>{
  const f=fixture(t,{connect:async cb=>{if(cb.botId==='bot-a')throw Error('synthetic-secret-must-not-leak');return {authenticatedAppId:cb.appId};}});
  await f.lifecycle.start('bot-a');await f.lifecycle.start('bot-b');const delays=[];
  while(f.lifecycle.status('bot-a').state==='backoff'){
    const status=f.lifecycle.status('bot-a');delays.push(status.retryAt-f.now());f.advance(delays.at(-1));await f.lifecycle.tick();
  }
  assert.deepEqual(delays,[100,200,250]);assert.equal(f.lifecycle.status('bot-a').state,'exhausted');
  assert.equal(f.calls.filter(c=>c.botId==='bot-a').length,4);assert.equal(f.calls.filter(c=>c.botId==='bot-b').length,1);
  assert.equal(JSON.stringify(f.lifecycle.status('bot-a')).includes('secret'),false);
  f.advance(1000);await f.lifecycle.tick();assert.equal(f.lifecycle.status('bot-a').attempts,4);
});
test('stopping during credential refresh invalidates its result before constructing a replacement transport',async t=>{
  const gate=deferred();let hold=false;
  const f=fixture(t,{credentials:async (req,base)=>{if(hold&&req.botId==='bot-a')await gate.promise;return base;}});
  f.pair();await f.lifecycle.start('bot-a');const old=f.latest('bot-a');hold=true;f.advance(9000);
  const refresh=f.lifecycle.tick();f.lifecycle.stop('bot-a');gate.resolve();await refresh;
  assert.equal(f.transports.length,1);assert.equal(f.lifecycle.status('bot-a').state,'stopped');
  assert.equal(old.callbacks.onMessage(message()).ignored,true);assert.equal(f.store.transportState('bot-a').stopped,true);
  f.advance(1000);await f.lifecycle.tick();assert.equal(f.transports.length,1);
});
test('stopping during a handshake prevents a late successful connection from attaching',async t=>{
  const gate=deferred(),entered=deferred();const f=fixture(t,{connect:async cb=>{entered.resolve();await gate.promise;return {authenticatedAppId:cb.appId};}});
  const opening=f.lifecycle.start('bot-a');await entered.promise;const tr=f.latest('bot-a');
  f.lifecycle.stop('bot-a');gate.resolve();await opening;
  assert.equal(tr.closed,1);assert.equal(f.lifecycle.status('bot-a').state,'stopped');assert.equal(tr.callbacks.onMessage(message()).ignored,true);
});
test('expiry rejects callbacks even when host ticks are delayed',async t=>{
  const f=fixture(t);f.pair();await f.lifecycle.start('bot-a');const tr=f.latest('bot-a');
  f.advance(10000);assert.equal(f.lifecycle.status('bot-a').state,'expired');assert.deepEqual(tr.callbacks.onMessage(message()),{ignored:true,reason:'expired_connection'});
  assert.equal(tr.closed,1);await f.lifecycle.tick();assert.equal(f.lifecycle.status('bot-a').state,'connected');
});
test('transport and local rate limits remain Bot scoped and reconnect cannot reset a local rate window',async t=>{
  const f=fixture(t,{messagesPerMinute:1});f.pair();f.pair('bot-b');await f.lifecycle.start('bot-a');await f.lifecycle.start('bot-b');
  f.latest('bot-a').callbacks.onMessage(message());f.latest('bot-a').callbacks.onDisconnect();f.advance(100);await f.lifecycle.tick();
  assert.throws(()=>f.latest('bot-a').callbacks.onMessage(message('a','another')),{code:'BOT_RATE_LIMITED'});
  f.latest('bot-a').callbacks.onRateLimit(2000);assert.throws(()=>f.latest('bot-a').callbacks.onMessage(message('a','third')),{code:'BOT_RATE_LIMITED'});
  assert.equal(f.latest('bot-b').callbacks.onMessage(message('b')).duplicate,false);
});
test('revoked pairings, expiry and renewed pairings cannot dispatch old queued tasks',async t=>{
  const f=fixture(t);f.pair('bot-a',2000);await f.lifecycle.start('bot-a');const old=f.latest('bot-a').callbacks.onMessage(message());
  f.advance(1000);assert.throws(()=>f.store.beginRun(old.scope,old.taskId,{dispatchKey:'expired'}),{code:'PAIRING_REQUIRED'});
  f.pair();assert.throws(()=>f.store.beginRun(old.scope,old.taskId,{dispatchKey:'renewed'}),{code:'TASK_AUTHORIZATION_REVOKED'});
  const queued=f.latest('bot-a').callbacks.onMessage(message('a','new'));f.gateway.unpair({botId:'bot-a',senderRef:'same-user',conversationRef:'same-conversation'});
  assert.throws(()=>f.store.beginRun(queued.scope,queued.taskId,{dispatchKey:'revoked'}),{code:'PAIRING_REQUIRED'});
  f.pair();assert.equal(f.store.task(queued.scope,queued.taskId).state,'held');
  assert.throws(()=>f.store.beginRun(queued.scope,queued.taskId,{dispatchKey:'new-lease'}),{code:'TASK_AUTHORIZATION_REVOKED'});
  const fresh=f.latest('bot-a').callbacks.onMessage(message('a','fresh'));assert.equal(f.store.beginRun(fresh.scope,fresh.taskId,{dispatchKey:'fresh-run'}).state,'dispatching');
});
test('rebind invalidates old transport and queued work without reconnecting or disturbing another Bot',async t=>{
  const f=fixture(t);f.pair();f.pair('bot-b');await f.lifecycle.start('bot-a');await f.lifecycle.start('bot-b');
  const old=f.latest('bot-a'),queued=old.callbacks.onMessage(message()),next=structuredClone(f.config);next.revision=2;next.bindings[0].version=2;
  f.lifecycle.replaceConfiguration(next);assert.equal(old.callbacks.onMessage(message()).ignored,true);
  assert.throws(()=>f.store.beginRun(queued.scope,queued.taskId,{dispatchKey:'rebound'}),{code:'STALE_BINDING_SCOPE'});
  await f.lifecycle.tick();assert.equal(f.calls.length,2);assert.equal(f.lifecycle.status('bot-b').state,'connected');
  await f.lifecycle.start('bot-a');assert.throws(()=>f.latest('bot-a').callbacks.onMessage(message('a','new')),{code:'PAIRING_REQUIRED'});
});
test('stop persists across database reopen and an explicit resume never resurrects old queued tasks',async t=>{
  const database=path.join(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'lifecycle-')),'state.sqlite');
  let now=1000,config=configuration();config.bots[0].credentialRef='synthetic-a';
  let store=new WorkStore(database,{hostId:'host-test',clock:()=>now}),gateway=new LocalGateway(config,store,{clock:()=>now});
  gateway.pair({botId:'bot-a',senderRef:'same-user',conversationRef:'same-conversation',expiresAt:100000});
  const handle=gateway.attach('bot-a',{authenticatedAppId:'10000001'}),queued=handle.receive(message());store.stopBot('bot-a');handle.close();store.close();
  store=new WorkStore(database,{hostId:'host-test',clock:()=>now});t.after(()=>store.close());gateway=new LocalGateway(config,store,{clock:()=>now});
  let calls=0;const lifecycle=new BotTransportLifecycle(config,{gateway,store,clock:()=>now,credentialProvider:()=>{calls++;},transportFactory:()=>{}});
  assert.throws(()=>lifecycle.start('bot-a'),{code:'BOT_STOPPED'});await lifecycle.tick();assert.equal(calls,0);
  lifecycle.resume('bot-a');assert.equal(calls,0);assert.equal(store.task(queued.scope,queued.taskId).state,'held');
  gateway.pair({botId:'bot-a',senderRef:'same-user',conversationRef:'same-conversation',expiresAt:100000});
  assert.throws(()=>store.beginRun(queued.scope,queued.taskId,{dispatchKey:'after-resume'}),{code:'TASK_AUTHORIZATION_REVOKED'});
});
test('a scheduler checks the pairing again when its previously queued callback actually runs',async t=>{
  const f=fixture(t),gate=deferred(),entered=deferred(),scheduler=new SessionScheduler({maxConcurrent:1});t.after(()=>scheduler.close());
  f.pair();await f.lifecycle.start('bot-a');const queued=f.latest('bot-a').callbacks.onMessage(message());
  const first=scheduler.submit(queued.scope,'blocking-task',async()=>{entered.resolve();await gate.promise;});await entered.promise;
  const pending=scheduler.submit(queued.scope,queued.taskId,()=>f.store.beginRun(queued.scope,queued.taskId,{dispatchKey:'scheduled-after-revoke'}));
  const rejected=assert.rejects(pending,{code:'PAIRING_REQUIRED'});f.gateway.unpair({botId:'bot-a',senderRef:'same-user',conversationRef:'same-conversation'});
  gate.resolve();await first;await rejected;assert.equal(f.store.task(queued.scope,queued.taskId).current_run_id,null);
});
test('an external configuration change cancels an already planned reconnect',async t=>{
  const f=fixture(t);await f.lifecycle.start('bot-a');const old=f.latest('bot-a');old.callbacks.onDisconnect();
  const next=structuredClone(f.config);next.revision=2;next.bindings[0].version=2;f.gateway.replaceConfiguration(next);
  f.advance(1000);await f.lifecycle.tick();assert.equal(f.calls.length,1);assert.equal(f.lifecycle.status('bot-a').state,'idle');
  assert.equal(old.callbacks.onMessage(message()).ignored,true);
});
test('host stop immediately invalidates callbacks and health without restarting another Bot',async t=>{
  const f=fixture(t);await f.lifecycle.start('bot-a');await f.lifecycle.start('bot-b');
  f.store.stop('host-test');assert.equal(f.lifecycle.status('bot-a').state,'stopped');assert.equal(f.lifecycle.status('bot-b').state,'stopped');
  assert.equal(f.latest('bot-a').callbacks.onMessage(message()).ignored,true);await f.lifecycle.tick();assert.equal(f.calls.length,2);
  assert.throws(()=>f.lifecycle.resume('bot-a'),{code:'HOST_STOPPED'});
});
test('disconnect and reconnect never replay an unknown submission or sending attempt',async t=>{
  const f=fixture(t);f.pair();await f.lifecycle.start('bot-a');const cb=f.latest('bot-a').callbacks,first=cb.onMessage(message());
  const run=f.store.beginRun(first.scope,first.taskId,{dispatchKey:'unknown-submit'});f.store.recover(first.scope);
  f.store.reconcileRun(first.scope,run.id,{state:'unknown',dispatchKey:run.dispatch_key,externalRef:null});
  const second=cb.onMessage(message('a','second')),done=f.store.beginRun(second.scope,second.taskId,{dispatchKey:'done'});
  f.store.recordSubmission(second.scope,done.id,'synthetic-upstream');f.store.recordEvent(second.scope,done.id,{...event(1,'run.succeeded',{summary:'result'}),correlationId:'done'});
  const out=f.store.enqueueResult(second.scope,done.id,'synthetic body');f.store.claimDelivery(second.scope,out.id);f.store.recover(second.scope);
  cb.onDisconnect();f.advance(100);await f.lifecycle.tick();
  assert.equal(f.store.run(first.scope,run.id).state,'unknown');assert.equal(f.store.outbox(second.scope,out.id).state,'unknown');
  assert.throws(()=>f.store.beginRun(first.scope,first.taskId,{dispatchKey:'retry',retry:true}),{code:'RUN_REQUIRES_RECONCILIATION'});
  assert.throws(()=>f.store.claimDelivery(second.scope,out.id),{code:'OUTBOX_NOT_QUEUED'});
});
