import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,utimesSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {connectOnDesktopStart,connectionDecision,clientGeneration,createManagementClient} from '../packages/host-control/desktop-autoconnect.mjs';
const read=f=>JSON.parse(readFileSync(f,'utf8'));
function fixture(){
 const runtime=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'autoconnect-')),instanceId=randomUUID(),hostId=randomUUID(),botId=randomUUID();
 const save=(relative,v)=>{const file=path.join(runtime,relative);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(v));return file;};
 save('instance.json',{schemaVersion:1,kind:'qq-agent-user-instance',instanceId,hostId});
 const prefs={schemaVersion:1,enabled:true,instanceId,hostId};save('desktop-autoconnect.json',prefs);
 save('management-service.json',{service:'qq-agent-management',status:'running',instance:randomUUID(),url:'http://127.0.0.1:17391'});
 save('business/active.json',{botId,configRelative:botId+'/config.local.json'});
 const b={configured:true,paired:true,executionConfigured:true,running:false,pending:false,processAlive:false,serviceFresh:false,qqConnected:false};
 const state={revision:17,business:b},calls=[];
 const client={state:async()=>state,start:async(s,id)=>{calls.push({state:s,operationId:id});b.running=true;b.serviceFresh=true;b.qqConnected=true;}};
 const args={runtimeDirectory:runtime,clientPid:7788,clientStartedAt:Date.now()-10000,managementClient:client,ownerReady:async()=>{},waitMs:0};
 return {runtime,save,prefs,b,state,client,calls,args,botId};
}
test('desktop startup starts the original paired bot through one durable management operation',async()=>{
 const f=fixture(),result=await connectOnDesktopStart(f.args);assert.equal(result.status,'connected');assert.equal(result.reused,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].state.revision,17);
 const journal=read(path.join(f.runtime,'desktop-autoconnect-attempt.json'));assert.equal(journal.state,'submitted');assert.equal(journal.operationId,f.calls[0].operationId);
 assert.equal((await connectOnDesktopStart(f.args)).status,'connected');assert.equal(f.calls.length,1);
});
test('desktop startup reuses a fresh online service without owner mutation or another start',async()=>{
 const f=fixture();Object.assign(f.b,{running:true,serviceFresh:true,qqConnected:true});f.args.ownerReady=()=>assert.fail('online service must be reused');
 assert.equal((await connectOnDesktopStart(f.args)).reused,true);assert.equal(f.calls.length,0);
});
test('desktop startup does not duplicate a pending launch or a stale live process',async()=>{
 for(const change of [{pending:true},{processAlive:true}]){const f=fixture();Object.assign(f.b,change);assert.equal((await connectOnDesktopStart(f.args)).status,'pending');assert.equal(f.calls.length,0);}
});
test('desktop startup does not auto-pair, enable execution or initialize an unconfigured installation',async()=>{
 for(const change of [{configured:false},{paired:false},{executionConfigured:false}]){const f=fixture();Object.assign(f.b,change);assert.equal((await connectOnDesktopStart(f.args)).status,'needs-configuration');assert.equal(f.calls.length,0);}
});
test('disabled or another instance preference cannot start the bot',async()=>{
 for(const change of [{enabled:false},{instanceId:randomUUID()},{hostId:randomUUID()}]){const f=fixture();f.save('desktop-autoconnect.json',{...f.prefs,...change});assert.equal((await connectOnDesktopStart(f.args)).status,'disabled');assert.equal(f.calls.length,0);}
});
test('turning off auto-connect while waiting for the desktop cancels the pending startup',async()=>{
 const f=fixture();f.args.ownerReady=async()=>f.save('desktop-autoconnect.json',{...f.prefs,enabled:false});assert.equal((await connectOnDesktopStart(f.args)).status,'disabled');assert.equal(f.calls.length,0);
});
test('concurrent desktop window events cannot launch the same bot twice',async()=>{
 const f=fixture();let second;f.args.ownerReady=async()=>{second=await connectOnDesktopStart({...f.args,ownerReady:async()=>{}});};assert.equal((await connectOnDesktopStart(f.args)).status,'connected');assert.equal(second.status,'busy');assert.equal(f.calls.length,1);
});
test('ambiguous startup response is recorded and never automatically replayed for the same client',async()=>{
 const f=fixture();f.client.start=async()=>{f.calls.push(1);throw Error('network ambiguity');};assert.equal((await connectOnDesktopStart(f.args)).status,'unknown');assert.equal((await connectOnDesktopStart(f.args)).status,'already-attempted');assert.equal(f.calls.length,1);assert.equal(read(path.join(f.runtime,'desktop-autoconnect-attempt.json')).state,'unknown');
});
test('a definite rejected request is preserved without background resubmission',async()=>{
 const f=fixture();f.client.start=async()=>{f.calls.push(1);throw Object.assign(Error('rejected'),{definite:true});};assert.equal((await connectOnDesktopStart(f.args)).status,'rejected');assert.equal((await connectOnDesktopStart(f.args)).status,'already-attempted');assert.equal(f.calls.length,1);
});
test('a new client process generation can make its own startup attempt',async()=>{
 const f=fixture();await connectOnDesktopStart(f.args);Object.assign(f.b,{running:false,serviceFresh:false,qqConnected:false});assert.equal((await connectOnDesktopStart({...f.args,clientStartedAt:f.args.clientStartedAt+1})).status,'connected');assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].operationId,f.calls[1].operationId);
});
test('same-launch manual bot stop is preserved; a later desktop launch can reconnect',async()=>{
 const f=fixture(),instance=randomUUID();f.save('business/'+f.botId+'/service.json',{instance});f.save('business/'+f.botId+'/stop.request.json',{instance,operationId:randomUUID()});
 assert.equal((await connectOnDesktopStart(f.args)).status,'manual-stop-preserved');assert.equal(f.calls.length,0);
 const file=path.join(f.runtime,'business',f.botId,'stop.request.json');const old=(f.args.clientStartedAt-1000)/1000;utimesSync(file,old,old);
 assert.equal((await connectOnDesktopStart(f.args)).status,'connected');assert.equal(f.calls.length,1);
});
test('an old service stop request cannot suppress the current service instance',async()=>{
 const f=fixture();f.save('business/'+f.botId+'/service.json',{instance:randomUUID()});f.save('business/'+f.botId+'/stop.request.json',{instance:randomUUID()});assert.equal((await connectOnDesktopStart(f.args)).status,'connected');
});
test('manual management stop during the same client generation is preserved',async()=>{
 const f=fixture();f.save('management-service.json',{status:'stopped'});assert.equal((await connectOnDesktopStart(f.args)).status,'manual-stop-preserved');assert.equal(f.calls.length,0);
});
test('the state is rechecked before startup if another component connected during owner readiness',async()=>{
 const f=fixture();f.args.ownerReady=async()=>Object.assign(f.b,{running:true,serviceFresh:true,qqConnected:true});assert.equal((await connectOnDesktopStart(f.args)).status,'connected');assert.equal(f.calls.length,0);
});
test('management client pins loopback origin, instance nonce and local session before POST',async()=>{
 const instance=randomUUID(),requests=[];const fetcher=async(url,options)=>{requests.push({url,options});if(url.endsWith('/health'))return Response.json({service:'qq-agent-management',instanceId:instance});if(url.endsWith('/api/bootstrap'))return Response.json({csrf:'a'.repeat(48)},{headers:{'set-cookie':'qq_console='+'b'.repeat(64)+'; HttpOnly'}});return Response.json({revision:12});};
 const metadata={service:'qq-agent-management',status:'running',instance,url:'http://127.0.0.1:17391'},client=await createManagementClient(metadata,{fetcher});await client.state();const operationId=randomUUID();await client.start({revision:12},operationId);
 const post=requests.at(-1);assert.equal(post.options.redirect,'error');assert.equal(post.options.headers.Origin,metadata.url);assert.equal(post.options.headers['X-CSRF-Token'],'a'.repeat(48));assert.deepEqual(JSON.parse(post.options.body),{expectedRevision:12,operationId});
 for(const url of ['https://127.0.0.1:17391','http://localhost:17391','http://127.0.0.1:17391/evil','http://127.0.0.1:99999','http://user@127.0.0.1:17391','http://192.168.1.1:17391'])await assert.rejects(createManagementClient({...metadata,url},{fetcher}));
 await assert.rejects(createManagementClient({...metadata,instance:randomUUID()},{fetcher}),/MANAGEMENT_CHANGED/);
});
test('client generations reject missing identity, invalid process ids and future start times',async()=>{
 assert.notEqual(clientGeneration(1,2),clientGeneration(1,3));for(const [p,t]of [[0,2],[1,0],[1,NaN],[-1,2]])assert.throws(()=>clientGeneration(p,t));const f=fixture();await assert.rejects(connectOnDesktopStart({...f.args,clientStartedAt:Date.now()+99999}),/CLIENT_INVALID/);
});
test('business freshness rather than a stale running label decides whether a connection is reusable',()=>{
 assert.equal(connectionDecision({business:{running:true,serviceFresh:false,processAlive:true}}),'pending');assert.equal(connectionDecision({business:{running:true,serviceFresh:true,qqConnected:false}}),'connecting');
});
