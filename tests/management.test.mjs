import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ManagementStore } from '../packages/storage/management-store.mjs';
import { createManagementServer } from '../packages/host-control/local-server.mjs';
import { discoverTools } from '../packages/host-control/tool-catalog.mjs';
import { CodexAccountController } from '../packages/host-control/codex-account-controller.mjs';
import { AccountControlStore } from '../packages/storage/account-control-store.mjs';
import { randomUUID } from 'node:crypto';
import { QQConnectionController } from '../packages/host-control/qq-connection-controller.mjs';
import { QQControlStore } from '../packages/storage/qq-control-store.mjs';

const memory=()=>new ManagementStore(':memory:',['codex','gemini','dsh']);
const code=(fn,expected)=>assert.throws(fn,e=>e.code===expected);
test('empty install contains no copied identities or fake connections',()=>{const s=memory();assert.deepEqual(s.snapshot(),{revision:0,bots:[],agents:[],bindings:[],activity:[]});s.close();});
test('bot metadata masks platform identity and rejects a duplicate AppID',()=>{const s=memory();s.createBot({name:'Bot A',appId:'1234567890',expectedRevision:0});const snapshot=s.snapshot();assert.equal(snapshot.bots[0].appIdMasked,'•••• 7890');assert.equal(snapshot.bots[0].connection,'offline');assert.ok(!JSON.stringify(snapshot).includes('1234567890'));code(()=>s.createBot({name:'Bot B',appId:'1234567890',expectedRevision:1}),'APP_ID_IN_USE');assert.equal(s.revision(),1);s.close();});
test('secret and permission fields cannot be stored through registration',()=>{const s=memory();for(const key of ['appSecret','password','token','policy','executionEnabled'])code(()=>s.createBot({name:'B',expectedRevision:0,[key]:'synthetic'}),'UNEXPECTED_FIELD');assert.equal(s.revision(),0);s.close();});
test('unknown tool is rejected, configured tools remain disconnected',()=>{const s=memory();code(()=>s.createAgent({name:'A',toolId:'unknown',expectedRevision:0}),'UNKNOWN_TOOL');s.createAgent({name:'A',toolId:'codex',expectedRevision:0});assert.equal(s.snapshot().agents[0].connection,'not_connected');s.close();});
test('binding preserves one-to-one ownership and rejects a stale window',()=>{const s=memory();const b1=s.createBot({name:'B1',expectedRevision:0}).id,b2=s.createBot({name:'B2',expectedRevision:1}).id,a=s.createAgent({name:'A',toolId:'codex',expectedRevision:2}).id;s.bind({botId:b1,agentId:a,expectedRevision:3});code(()=>s.bind({botId:b2,agentId:a,expectedRevision:4}),'AGENT_ALREADY_BOUND');code(()=>s.updateBot(b1,{name:'stale',expectedRevision:3}),'STALE_REVISION');assert.equal(s.snapshot().bots.find(b=>b.id===b1).name,'B1');assert.equal(s.snapshot().bindings.length,1);s.close();});
test('rebinding increments versions and retains prior binding history',()=>{const s=memory();const b=s.createBot({name:'B',expectedRevision:0}).id,a1=s.createAgent({name:'A1',toolId:'codex',expectedRevision:1}).id,a2=s.createAgent({name:'A2',toolId:'dsh',expectedRevision:2}).id;assert.equal(s.bind({botId:b,agentId:a1,expectedRevision:3}).version,1);assert.equal(s.bind({botId:b,agentId:a2,expectedRevision:4}).version,2);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM ui_bindings').get().n,2);assert.equal(s.snapshot().bindings[0].agentId,a2);s.close();});
test('archiving a bot preserves records and frees its Agent binding',()=>{const s=memory();const b=s.createBot({name:'B',expectedRevision:0}).id,a=s.createAgent({name:'A',toolId:'codex',expectedRevision:1}).id;s.bind({botId:b,agentId:a,expectedRevision:2});code(()=>s.archiveAgent(a,{expectedRevision:3}),'AGENT_STILL_BOUND');s.archiveBot(b,{expectedRevision:3});assert.equal(s.snapshot().bots.length,0);assert.equal(s.snapshot().agents.length,1);assert.equal(s.snapshot().bindings.length,0);assert.equal(s.db.prepare('SELECT archived FROM ui_bots WHERE id=?').get(b).archived,1);s.close();});
test('paused configurations cannot be newly bound but can be unbound',()=>{const s=memory();const b=s.createBot({name:'B',expectedRevision:0}).id,a=s.createAgent({name:'A',toolId:'codex',expectedRevision:1}).id;s.bind({botId:b,agentId:a,expectedRevision:2});s.updateBot(b,{status:'paused',expectedRevision:3});code(()=>s.bind({botId:b,agentId:a,expectedRevision:4}),'BOT_PAUSED');s.bind({botId:b,agentId:null,expectedRevision:4});assert.equal(s.snapshot().bindings.length,0);s.close();});
test('database survives restart with revision and metadata intact',()=>{const dir=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'persist-')),db=path.join(dir,'management.sqlite');let s=new ManagementStore(db,['codex']);const b=s.createBot({name:'Persistent Bot',expectedRevision:0}).id;s.close();s=new ManagementStore(db,['codex']);assert.equal(s.snapshot().bots[0].id,b);assert.equal(s.revision(),1);assert.equal(s.snapshot().activity.length,1);s.close();});
test('display-only discovery does not imply CLI, login or model access',()=>{const tools=discoverTools('',{environment:{PATH:''},readMapping:false});assert.equal(tools.length,3);assert.ok(tools.every(t=>!t.detected&&t.connection==='not_connected'&&!t.executionEnabled));});

async function fixture(t,options={}){const app=await createManagementServer({database:':memory:',tools:discoverTools('',{environment:{PATH:''},readMapping:false}),...options});t.after(()=>app.close());const b=await fetch(app.origin+'/api/bootstrap');const cookie=b.headers.get('set-cookie').split(';')[0],csrf=(await b.json()).csrf;const request=(route,method='GET',body,extra={})=>fetch(app.origin+route,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json',Origin:app.origin,'X-CSRF-Token':csrf}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {...app,request,cookie,csrf};}
test('HTTP delivers the page and a local, non-executing health check',async t=>{const f=await fixture(t);const page=await fetch(f.origin);assert.equal(page.status,200);assert.match(await page.text(),/QQ Agent/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);const h=await(await fetch(f.origin+'/health')).json();assert.equal(h.executionEnabled,false);assert.equal(f.server.address().address,'127.0.0.1');});
test('API data requires a local session and private files are never served',async t=>{const f=await fixture(t);assert.equal((await fetch(f.origin+'/api/state')).status,401);for(const route of ['/QQ插件运行目录/local-paths.json','/packages/host-control/cli.mjs','/.env'])assert.equal((await f.request(route)).status,404);});
test('foreign origins and CSRF attempts cannot mutate local metadata',async t=>{const f=await fixture(t);const body={name:'B',expectedRevision:0};assert.equal((await f.request('/api/bots','POST',body,{Origin:'https://example.invalid'})).status,403);assert.equal((await f.request('/api/bots','POST',body,{'X-CSRF-Token':'bad'})).status,403);assert.equal((await f.request('/api/bootstrap','GET',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal(f.store.revision(),0);});
test('network API persists a bot, Agent and binding without execution endpoints',async t=>{const f=await fixture(t);const b=await(await f.request('/api/bots','POST',{name:'Bot A',expectedRevision:0})).json();const a=await(await f.request('/api/agents','POST',{name:'Agent A',toolId:'codex',expectedRevision:1})).json();assert.equal((await f.request('/api/bindings','PUT',{botId:b.id,agentId:a.id,expectedRevision:2})).status,200);const state=await(await f.request('/api/state')).json();assert.equal(state.bindings.length,1);assert.equal(state.executionEnabled,false);for(const route of ['/api/execute','/api/approve','/api/connect','/api/qq/send'])assert.equal((await f.request(route,'POST',{expectedRevision:3})).status,404);});
test('HTTP detects stale writes instead of silently replacing another window',async t=>{const f=await fixture(t);assert.equal((await f.request('/api/bots','POST',{name:'First',expectedRevision:0})).status,200);const r=await f.request('/api/bots','POST',{name:'Stale',expectedRevision:0});assert.equal(r.status,409);assert.equal((await r.json()).error,'STALE_REVISION');assert.equal(f.store.snapshot().bots.length,1);});
test('user text is returned as data and static code does not use inline handlers',async t=>{const f=await fixture(t),name='<img src=x onerror=alert(1)>';await f.request('/api/bots','POST',{name,expectedRevision:0});const s=await(await f.request('/api/state')).json();assert.equal(s.bots[0].name,name);const page=await(await fetch(f.origin)).text();assert.ok(!page.includes(name));const script=await(await fetch(f.origin+'/app.js')).text();assert.match(script,/const esc=/);assert.doesNotMatch(page,/<script[^>]*>[^<]+/);});

async function accountFixture(t){
 const calls=[];let account=null,options;
 const f=await fixture(t,{accountControlFactory:store=>new CodexAccountController({managementStore:store,
  journal:new AccountControlStore(':memory:',{schemaVersion:1,connectionId:randomUUID(),agentId:null,lease:null,process:null,selected:null,actions:[]}),
  openProcess:async o=>{options=o;o.onSpawn(24680);return {close:async()=>o.onClose(),request:async(method,params)=>{calls.push({method,params});
    if(method==='account/read')return {account,requiresOpenaiAuth:true};
    if(method==='account/login/start')return {type:'chatgpt',loginId:'exact-synthetic-login',authUrl:'https://auth.openai.com/authorize?state=synthetic-private-state'};
    if(method==='account/login/cancel')return {status:'canceled'};
    if(method==='account/logout'){account=null;return {};}
    if(method==='model/list')return {data:[{id:'synthetic',model:'synthetic',displayName:'Synthetic model'}],nextCursor:null};throw Error('unexpected method');}};}})});
 const accountRequest=async(action,extra={},headers={})=>{const s=await(await f.request('/api/state')).json();return f.request('/api/codex/account/'+action,'POST',{expectedRevision:s.revision,expectedAccountRevision:s.codexAccount.revision,...extra},headers);};
 const a=await(await f.request('/api/agents','POST',{name:'User metadata retained',toolId:'codex',expectedRevision:0})).json();
 return {...f,calls,accountRequest,agentId:a.id,auth:()=>{account={type:'chatgpt',email:'hidden@example.invalid',planType:'pro'};},notify:params=>options.onNotification('account/login/completed',params)};
}
test('account HTTP retains local session, same-origin and CSRF protection',async t=>{
 const f=await accountFixture(t);assert.equal((await fetch(f.origin+'/api/codex/account')).status,401);
 assert.equal((await f.accountRequest('associate',{agentId:f.agentId},{Origin:'https://foreign.invalid'})).status,403);
 assert.equal((await f.accountRequest('status',{}, {'X-CSRF-Token':'bad'})).status,403);
 assert.equal(f.calls.length,0);
});
test('account HTTP association preserves original metadata and cannot fake online state',async t=>{
 const f=await accountFixture(t);assert.equal((await f.accountRequest('associate',{agentId:f.agentId})).status,200);
 const s=await(await f.request('/api/state')).json();assert.equal(s.agents[0].name,'User metadata retained');assert.equal(s.revision,1);assert.equal(s.agents[0].connection,'not_connected');assert.equal(s.codexAccount.agentId,f.agentId);assert.equal(s.codexAccount.runtimeConnected,false);assert.equal(s.executionEnabled,false);
 assert.equal((await f.request('/api/agents/'+f.agentId,'DELETE',{expectedRevision:1})).status,409);
});
test('account HTTP rejects stale versions, raw credentials, generic RPC and task endpoints',async t=>{
 const f=await accountFixture(t);assert.equal((await f.accountRequest('associate',{agentId:f.agentId,expectedRevision:0})).status,409);
 assert.equal((await f.accountRequest('associate',{agentId:f.agentId,expectedAccountRevision:0})).status,409);
 await f.accountRequest('associate',{agentId:f.agentId});
 for(const extra of [{type:'apiKey',apiKey:'synthetic-secret'},{type:'chatgptAuthTokens',accessToken:'synthetic-secret'},{type:'chatgpt',executable:'arbitrary',cwd:'arbitrary'}])assert.equal((await f.accountRequest('login',{operationId:randomUUID(),...extra})).status,400);
 for(const route of ['rpc','execute','turn/start','config/write','qq/send'])assert.equal((await f.accountRequest(route,{method:'account/login/start',params:{type:'apiKey'}})).status,404);
 assert.equal(f.calls.length,0);
});
test('account HTTP supports real control flow with synthetic wire and exact cancellation',async t=>{
 const f=await accountFixture(t);await f.accountRequest('associate',{agentId:f.agentId});const operationId=randomUUID();
 const start=await(await f.accountRequest('login',{operationId,type:'chatgpt'})).json();assert.equal(start.login.state,'awaiting');
 await f.accountRequest('login',{operationId,type:'chatgpt'});assert.equal(f.calls.filter(x=>x.method==='account/login/start').length,1);
 const handoff=await(await f.accountRequest('handoff',{operationId})).json();assert.ok(handoff.url.includes('synthetic-private-state'));
 const state=JSON.stringify(await(await f.request('/api/state')).json());assert.ok(!state.includes('synthetic-private-state'));
 assert.equal((await f.accountRequest('cancel',{operationId:randomUUID(),loginOperationId:operationId})).status,200);
 assert.deepEqual(f.calls.find(x=>x.method==='account/login/cancel').params,{loginId:'exact-synthetic-login'});
});
test('account HTTP handoff is confined to its initiating local session',async t=>{
 const f=await accountFixture(t);await f.accountRequest('associate',{agentId:f.agentId});const operationId=randomUUID();await f.accountRequest('login',{operationId,type:'chatgpt'});
 const response=await fetch(f.origin+'/api/bootstrap'),otherCookie=response.headers.get('set-cookie').split(';')[0],otherCsrf=(await response.json()).csrf;
 const s=await(await f.request('/api/state')).json();const result=await fetch(f.origin+'/api/codex/account/handoff',{method:'POST',headers:{Cookie:otherCookie,Origin:f.origin,'Content-Type':'application/json','X-CSRF-Token':otherCsrf},body:JSON.stringify({operationId,expectedRevision:s.revision,expectedAccountRevision:s.codexAccount.revision})});assert.equal(result.status,409);
});
test('account HTTP model choice is explicit and account login never enables execution',async t=>{
 const f=await accountFixture(t);await f.accountRequest('associate',{agentId:f.agentId});f.auth();await f.accountRequest('status');
 const s=await(await f.request('/api/codex/account')).json();assert.equal(s.account.status,'authenticated');assert.equal(s.selectedModel,null);assert.ok(!JSON.stringify(s).includes('hidden@example.invalid'));
 const result=await(await f.accountRequest('model',{model:'synthetic'})).json();assert.equal(result.selectionStatus,'selected_unverified');assert.equal(result.modelAccessVerified,false);assert.equal(result.executionEnabled,false);
 assert.equal((await f.accountRequest('model',{model:'not-in-catalog'})).status,409);
});
test('account HTTP keeps body size and JSON content-type limits',async t=>{
 const f=await accountFixture(t);assert.equal((await f.accountRequest('status',{}, {'Content-Type':'text/plain'})).status,415);
 const result=await f.accountRequest('status',{extra:'x'.repeat(17000)});assert.equal(result.status,413);assert.equal(f.calls.length,0);
});

async function qqHttpFixture(t){
 const calls=[],account={available:true,agentId:null,associationValid:true,connectionId:randomUUID(),account:{status:'authenticated'},models:[]};
 const f=await fixture(t,{accountControlFactory:()=>({snapshot:()=>account,close:async()=>{}}),qqConnectionFactory:(store,control)=>new QQConnectionController({managementStore:store,accountControl:control,
  journal:new QQControlStore(':memory:',{schemaVersion:1,salt:'synthetic',lease:null,owner:null,credential:null,observation:null,actions:[]}),
  protector:{seal:async raw=>Buffer.from(raw).toString('base64'),open:async raw=>Buffer.from(raw,'base64').toString()},
  client:{verifyIdentity:async input=>{calls.push(input);input.guard();return {platformUserId:'synthetic-bot-1234',expiresAt:Date.now()+7200000,trustBasis:'official_app_credentials_and_authenticated_bot_profile'};}}})});
 const bot=await(await f.request('/api/bots','POST',{name:'Existing Bot',appId:'1234567890',expectedRevision:0})).json(),agent=await(await f.request('/api/agents','POST',{name:'Existing Codex',toolId:'codex',expectedRevision:1})).json();
 await f.request('/api/bindings','PUT',{botId:bot.id,agentId:agent.id,expectedRevision:2});account.agentId=agent.id;
 const qqRequest=async(action,extra={},headers={})=>{const s=await(await f.request('/api/state')).json();return f.request('/api/qq/connection/'+action,'POST',{botId:bot.id,operationId:randomUUID(),expectedRevision:s.revision,expectedConnectionRevision:s.qqConnection.revision,...extra},headers);};
 const save=()=>qqRequest('credentials',{appId:'1234567890',appSecret:'synthetic-platform-secret-12345',environment:'sandbox'});
 return {...f,calls,botId:bot.id,agentId:agent.id,qqRequest,save};
}
test('QQ connection HTTP requires session and preserves origin and CSRF checks',async t=>{const f=await qqHttpFixture(t);assert.equal((await fetch(f.origin+'/api/qq/connection')).status,401);assert.equal((await f.qqRequest('credentials',{appId:'1234567890',appSecret:'synthetic-platform-secret-12345',environment:'sandbox'},{Origin:'https://foreign.invalid'})).status,403);assert.equal((await f.qqRequest('verify',{}, {'X-CSRF-Token':'wrong'})).status,403);assert.equal(f.calls.length,0);});
test('QQ connection GET never fetches a token or implies a live event channel',async t=>{const f=await qqHttpFixture(t);for(let i=0;i<2;i++){const s=await(await f.request('/api/qq/connection')).json();assert.equal(s.state,'unconfigured');assert.equal(s.qqConnected,false);assert.equal(s.eventTransportConnected,false);}assert.equal(f.calls.length,0);});
test('QQ local credential form API preserves user metadata and hides platform secrets',async t=>{const f=await qqHttpFixture(t);assert.equal((await f.save()).status,200);const s=await(await f.request('/api/state')).json();assert.equal(s.revision,3);assert.equal(s.bots[0].name,'Existing Bot');assert.equal(s.qqConnection.credentialConfigured,true);assert.ok(!JSON.stringify(s).includes('synthetic-platform-secret-12345'));assert.ok(!JSON.stringify(s).includes('1234567890'));assert.equal(f.calls.length,0);});
test('QQ identity API runs only on explicit POST and never enables QQ or model execution',async t=>{const f=await qqHttpFixture(t);await f.save();const s=await(await f.qqRequest('verify')).json();assert.equal(s.identityVerified,true);assert.equal(s.qqConnected,false);assert.equal(s.executionEnabled,false);assert.equal(f.calls.length,1);});
test('QQ HTTP rejects model credentials, arbitrary routes and generic network parameters',async t=>{const f=await qqHttpFixture(t);for(const field of ['apiKey','accessToken','url','method','command','path'])assert.equal((await f.qqRequest('credentials',{appId:'1234567890',appSecret:'synthetic-platform-secret-12345',environment:'sandbox',[field]:'synthetic'})).status,400);for(const action of ['send','rpc','connect','webhook','execute'])assert.equal((await f.qqRequest(action)).status,404);assert.equal(f.calls.length,0);});
test('QQ HTTP applies both revision guards instead of silently replacing stale data',async t=>{const f=await qqHttpFixture(t);assert.equal((await f.qqRequest('credentials',{expectedRevision:0,appId:'1234567890',appSecret:'synthetic-platform-secret-12345',environment:'sandbox'})).status,409);assert.equal((await f.qqRequest('credentials',{expectedConnectionRevision:0,appId:'1234567890',appSecret:'synthetic-platform-secret-12345',environment:'sandbox'})).status,409);assert.equal(f.calls.length,0);});
test('QQ HTTP cannot cancel a foreign verification and retains request size limits',async t=>{const f=await qqHttpFixture(t);await f.save();assert.equal((await f.qqRequest('cancel',{verificationOperationId:randomUUID()})).status,409);assert.equal((await f.qqRequest('credentials',{appSecret:'x'.repeat(17000)})).status,413);assert.equal(f.calls.length,0);});

test('business HTTP controls preserve local session, CSRF and management revision checks before dispatch',async t=>{
 const calls=[],f=await fixture(t,{businessControlFactory:()=>({snapshot:()=>({available:true,running:false}),start:input=>{calls.push(input);return {accepted:true};}})}),body={expectedRevision:0,operationId:randomUUID()};
 assert.equal((await fetch(f.origin+'/api/business/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
 assert.equal((await f.request('/api/business/start','POST',body,{Origin:'https://foreign.invalid'})).status,403);assert.equal((await f.request('/api/business/start','POST',{...body,expectedRevision:1})).status,409);assert.equal(calls.length,0);assert.equal((await f.request('/api/business/start','POST',body)).status,200);assert.deepEqual(calls,[{operationId:body.operationId}]);
});
