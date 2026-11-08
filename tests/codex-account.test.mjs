import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, mkdirSync, linkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexAccountController } from '../packages/host-control/codex-account-controller.mjs';
import { AccountControlStore } from '../packages/storage/account-control-store.mjs';
import { accountEnvironment, accountArguments, checkAccountRpc, loginHandoff, ACCOUNT_CLI_VERSION, checkAccountConfiguration } from '../packages/host-control/codex-account-policy.mjs';
import {applicationCacheEnvironment} from '../packages/host-control/application-cache.mjs';
import { accountDirectories, locateAccountCli, openAccountProcess } from '../packages/host-control/codex-account-process.mjs';
import {parseAccountProtocolVersion,parseReviewedCodexVersion,parseVerifiedCodexVersion} from '../packages/host-control/codex-version-policy.mjs';

const id=randomUUID(),other=randomUUID(),secret='synthetic-secret-never-log',email='private-user@example.invalid';
const init=()=>({schemaVersion:1,connectionId:randomUUID(),agentId:null,lease:null,process:null,selected:null,actions:[]});
const errorCode=(fn,code)=>assert.throws(fn,e=>e.code===code);
const rejection=(fn,code)=>assert.rejects(fn,e=>e.code===code);
function fixture(t,{journal,now=()=>1000,...extra}={}) {
  let authenticated=null,opens=0,calls=[],options,currentTransport;
  const agents=[{id,toolId:'codex',name:'Synthetic instance',status:'registered'},{id:other,toolId:'gemini',status:'registered'}];
  const handlers={};
  const openProcess=async opts=>{opens++;options=opts;opts.onSpawn(10000+opens);currentTransport={pid:10000+opens,version:ACCOUNT_CLI_VERSION,
    request:async(method,params)=>{opts.guard();checkAccountRpc(method,params);calls.push({method,params});if(handlers[method])return handlers[method](params,opts);
      if(method==='account/read')return {account:authenticated,requiresOpenaiAuth:true};
      if(method==='model/list')return {data:[{id:'catalog-model',model:'catalog-model',displayName:'Synthetic model',hidden:false}],nextCursor:null};
      if(method==='account/login/start')return params.type==='chatgpt'?{type:params.type,loginId:'synthetic-login-'+opens,authUrl:'https://auth.openai.com/authorize?state='+secret}:{type:params.type,loginId:'synthetic-login-'+opens,verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-1234'};
      if(method==='account/login/cancel')return {status:'canceled'};
      if(method==='account/logout'){authenticated=null;return {};}
      throw Error('unexpected synthetic method');},close:async()=>{opts.onClose();}};return currentTransport;};
  journal??=new AccountControlStore(':memory:',init());
  const managementStore={snapshot:()=>({agents})};
  const controller=new CodexAccountController({managementStore,journal,now,openProcess,...extra});t.after(()=>controller.close());
  const input=(body={})=>({...body,expectedAccountRevision:controller.snapshot().revision});
  const associate=()=>controller.associate(input({agentId:id}));
  return {controller,journal,input,associate,agents,handlers,calls,get opens(){return opens;},get options(){return options;},login:async(type='chatgpt',operationId=randomUUID())=>controller.login(input({type,operationId}),'local-session'),auth:(value={type:'chatgpt',email,planType:'pro'})=>authenticated=value,notify:(method,params)=>options.onNotification(method,params),refresh:()=>controller.refresh(input())};
}

test('current account fixture is real 0.164 schema and managed login types are explicit',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/codex/current-account-protocol.json',import.meta.url)));
  assert.equal(fixture.cliVersion,ACCOUNT_CLI_VERSION);assert.equal(fixture.fullSchemaFileCount,320);
  const schemas=fixture.schemas;
  for(const type of ['chatgpt','chatgptDeviceCode'])assert.ok(schemas['v2/LoginAccountParams.json'].oneOf.some(x=>x.properties.type.enum.includes(type)));
  assert.deepEqual(schemas['v2/CancelLoginAccountResponse.json'].definitions.CancelLoginAccountStatus.enum,['canceled','notFound']);
  assert.ok(schemas['v2/LoginAccountParams.json'].oneOf.some(x=>x.properties.type.enum.includes('chatgptAuthTokens')),'upstream existence does not authorize token injection');
});
test('account environment is a system allowlist with a new CODEX_HOME',()=>{
  const home=path.join(process.env.QQ_TEST_ROOT,'own-home'),value=accountEnvironment({PATH:'synthetic-path',CODEX_HOME:'old-home',OPENAI_API_KEY:secret,OPENAI_BASE_URL:'https://example.invalid',ACCESS_TOKEN:secret,AZURE_OPENAI_API_KEY:secret,AWS_PROFILE:secret,CODEX_AUTH_TOKEN:secret,HTTP_PROXY:secret,NODE_OPTIONS:secret,PYTHONPATH:secret,UNKNOWN:secret},home);
  assert.deepEqual(value,{PATH:'synthetic-path',CODEX_HOME:home,...applicationCacheEnvironment(home)});assert.ok(!JSON.stringify(value).includes(secret));
  assert.ok(accountArguments.includes('forced_login_method="chatgpt"'));assert.ok(accountArguments.includes('model_provider="openai"'));assert.ok(accountArguments.includes('stdio://'));
});
for(const type of ['apiKey','chatgptAuthTokens','amazonBedrock','gcp','personalAccessToken'])test('wire rejects authentication type '+type,()=>errorCode(()=>checkAccountRpc('account/login/start',{type,apiKey:secret}),'ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN'));
for(const method of ['turn/start','thread/start','thread/resume','command/exec','config/value/write','account/chatgptAuthTokens/refresh','account/rateLimits/reset'])test('wire denies non-account method '+method,()=>errorCode(()=>checkAccountRpc(method,{}),'ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN'));
test('account wire rejects extra fields, refresh and hidden catalog overrides',()=>{
  for(const [method,params]of [['account/login/start',{type:'chatgpt',accessToken:secret}],['account/read',{refreshToken:true}],['model/list',{includeHidden:true,limit:100,cursor:null}],['account/logout',{}]])errorCode(()=>checkAccountRpc(method,params),'ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN');
});
for(const url of ['http://auth.openai.com/authorize','https://auth.openai.com.evil.invalid/authorize','https://user:pass@auth.openai.com/authorize','https://auth.openai.com:444/authorize','javascript:alert(1)','https://auth.openai.com/authorize?redirect_uri=https%3A%2F%2Fexample.invalid'])test('login handoff rejects nonofficial or unsafe URL '+url,()=>errorCode(()=>loginHandoff({type:'chatgpt',loginId:'exact-original',authUrl:url},'chatgpt'),'ACCOUNT_LOGIN_URL_INVALID'));
test('device code requires exact official location and bounded code',()=>{
  assert.equal(loginHandoff({type:'chatgptDeviceCode',loginId:'exact',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-1234'},'chatgptDeviceCode').userCode,'TEST-1234');
  errorCode(()=>loginHandoff({type:'chatgptDeviceCode',loginId:'exact',verificationUrl:'https://auth.openai.com/codex/device?secret=x',userCode:'TEST'},'chatgptDeviceCode'),'ACCOUNT_LOGIN_RESPONSE_INVALID');
});
test('configuration read must prove managed ChatGPT and the OpenAI provider',()=>{
  const config={forced_login_method:'chatgpt',cli_auth_credentials_store:'file',model_provider:'openai',mcp_servers:{}};checkAccountConfiguration({config});
  for(const delta of [{forced_login_method:'api'},{model_provider:'compatible'},{cli_auth_credentials_store:'keyring'},{mcp_servers:{external:{}}}])errorCode(()=>checkAccountConfiguration({config:{...config,...delta}}),'ACCOUNT_CONFIGURATION_REJECTED');
});
test('account controller is lazy and refuses execution or fake online state',t=>{const f=fixture(t);const s=f.controller.snapshot();assert.equal(f.opens,0);assert.equal(s.account.status,'not_checked');assert.equal(s.runtimeConnected,false);assert.equal(s.qqConnected,false);assert.equal(s.executionEnabled,false);assert.equal(s.modelAccessVerified,false);});
test('association accepts only an existing active Codex instance and is fixed one-to-one',t=>{const f=fixture(t);errorCode(()=>f.controller.associate(f.input({agentId:other})),'ACCOUNT_AGENT_REQUIRED');f.associate();assert.equal(f.controller.snapshot().agentId,id);f.agents.push({id:randomUUID(),toolId:'codex',status:'registered'});errorCode(()=>f.controller.associate(f.input({agentId:f.agents[2].id})),'ACCOUNT_ALREADY_ASSOCIATED');});
test('stale account window and unrecognized fields cannot change association',t=>{const f=fixture(t),old=f.input({agentId:id});f.associate();errorCode(()=>f.controller.associate(old),'ACCOUNT_STALE_REVISION');errorCode(()=>f.controller.associate(f.input({agentId:id,executionEnabled:true})),'UNEXPECTED_FIELD');});
test('login needs associated active ownership and rejects forbidden auth before a process',async t=>{const f=fixture(t);await rejection(()=>f.login(),'ACCOUNT_AGENT_REQUIRED');f.associate();await rejection(()=>f.login('apiKey'),'ACCOUNT_AUTH_MODE_FORBIDDEN');f.agents[0].status='paused';await rejection(()=>f.login(),'ACCOUNT_AGENT_PAUSED');assert.equal(f.opens,0);});
test('browser login has a durable exact intent and a session-bound ephemeral handoff',async t=>{
  const f=fixture(t);f.associate();await f.login();const s=f.controller.snapshot();assert.equal(s.login.state,'awaiting');assert.equal(s.login.canCancel,true);
  const args=f.input({operationId:s.login.operationId});assert.ok(f.controller.reveal(args,'local-session').url.includes(secret));
  errorCode(()=>f.controller.reveal(args,'other-session'),'ACCOUNT_HANDOFF_UNAVAILABLE');
  const persisted=JSON.stringify(f.journal.load()),publicState=JSON.stringify(s);for(const value of [secret,email,'https://']){assert.ok(!persisted.includes(value));assert.ok(!publicState.includes(value));}
});
test('device login code is not included in status or persisted state',async t=>{const f=fixture(t);f.associate();await f.login('chatgptDeviceCode');assert.equal(f.controller.reveal(f.input({operationId:f.controller.snapshot().login.operationId}),'local-session').userCode,'TEST-1234');assert.ok(!JSON.stringify(f.controller.snapshot()).includes('TEST-1234'));assert.ok(!JSON.stringify(f.journal.load()).includes('TEST-1234'));});
test('repeated identical login returns original intent even with stale account revision',async t=>{const f=fixture(t);f.associate();const operationId=randomUUID(),input=f.input({operationId,type:'chatgpt'});await f.controller.login(input,'local-session');const n=f.calls.length;await f.controller.login(input,'local-session');assert.equal(f.calls.length,n);await rejection(()=>f.controller.login({...input,type:'chatgptDeviceCode'},'local-session'),'ACCOUNT_OPERATION_CONFLICT');await rejection(()=>f.login(),'ACCOUNT_LOGIN_PENDING_OR_UNKNOWN');});
test('refreshing an awaiting login retains its original handoff and does not restart login',async t=>{const f=fixture(t);f.associate();await f.login();await f.refresh();assert.equal(f.controller.snapshot().login.handoffAvailable,true);assert.equal(f.calls.filter(c=>c.method==='account/login/start').length,1);});
test('completion correlates only the exact login and never treats account observation as operation proof',async t=>{const f=fixture(t);f.associate();await f.login();f.notify('account/login/completed',{loginId:'foreign',success:true,error:secret});f.auth();await f.refresh();assert.equal(f.controller.snapshot().login.state,'awaiting');f.notify('account/login/completed',{loginId:'synthetic-login-1',success:true});assert.equal(f.controller.snapshot().login.state,'completed');assert.equal(f.controller.snapshot().runtimeConnected,false);});
test('completion before start response is bounded and associated after the exact response',async t=>{const f=fixture(t);f.associate();f.handlers['account/login/start']=(_p,o)=>{o.onNotification('account/login/completed',{loginId:'early-exact',success:true});return {type:'chatgpt',loginId:'early-exact',authUrl:'https://auth.openai.com/authorize'};};await f.login();assert.equal(f.controller.snapshot().login.state,'completed');});
test('failed completion discards official error text and login secret',async t=>{const f=fixture(t);f.associate();await f.login();f.notify('account/login/completed',{loginId:'synthetic-login-1',success:false,error:secret+' '+email});assert.equal(f.controller.snapshot().login.state,'failed');assert.ok(!JSON.stringify(f.journal.load()).includes(secret));assert.equal(f.controller.snapshot().login.handoffAvailable,false);});
test('cancel sends the stored exact login once, including after Agent pause',async t=>{const f=fixture(t);f.associate();await f.login();f.agents[0].status='paused';const input=f.input({operationId:randomUUID(),loginOperationId:f.controller.snapshot().login.operationId});await f.controller.cancel(input);await f.controller.cancel(input);assert.equal(f.controller.snapshot().login.state,'canceled');assert.deepEqual(f.calls.filter(c=>c.method==='account/login/cancel').map(c=>c.params),[{loginId:'synthetic-login-1'}]);});
test('cancel notFound stays unknown and cannot be retried with a fresh key',async t=>{const f=fixture(t);f.associate();await f.login();f.handlers['account/login/cancel']=()=>({status:'notFound'});const loginOperationId=f.controller.snapshot().login.operationId;await f.controller.cancel(f.input({operationId:randomUUID(),loginOperationId}));assert.equal(f.controller.snapshot().login.state,'unknown');await rejection(()=>f.controller.cancel(f.input({operationId:randomUUID(),loginOperationId})),'ACCOUNT_EXACT_LOGIN_UNAVAILABLE');assert.equal(f.calls.filter(c=>c.method==='account/login/cancel').length,1);});
test('successful login racing cancellation remains successful instead of canceled',async t=>{const f=fixture(t);f.associate();await f.login();f.handlers['account/login/cancel']=(_p,o)=>{o.onNotification('account/login/completed',{loginId:'synthetic-login-1',success:true});return {status:'canceled'};};await f.controller.cancel(f.input({operationId:randomUUID(),loginOperationId:f.controller.snapshot().login.operationId}));assert.equal(f.controller.snapshot().login.state,'completed');});
test('exact cancellation response confirms cancellation even when failure notification arrives first',async t=>{const f=fixture(t);f.associate();await f.login();f.handlers['account/login/cancel']=(_p,o)=>{o.onNotification('account/login/completed',{loginId:'synthetic-login-1',success:false,error:secret});return {status:'canceled'};};await f.controller.cancel(f.input({operationId:randomUUID(),loginOperationId:f.controller.snapshot().login.operationId}));assert.equal(f.controller.snapshot().login.state,'canceled');});
test('login timeout retains unknown intent without new login or cancellation by guess',async t=>{const f=fixture(t);f.associate();f.handlers['account/login/start']=()=>{throw Object.assign(Error(secret),{code:'ACCOUNT_RPC_TIMEOUT'});};await rejection(()=>f.login(),'ACCOUNT_RPC_TIMEOUT');assert.equal(f.controller.snapshot().login.state,'unknown');await rejection(()=>f.login(),'ACCOUNT_LOGIN_PENDING_OR_UNKNOWN');await rejection(()=>f.controller.cancel(f.input({operationId:randomUUID(),loginOperationId:f.controller.snapshot().login.operationId})),'ACCOUNT_EXACT_LOGIN_UNAVAILABLE');assert.equal(f.calls.filter(c=>c.method==='account/login/start').length,1);assert.ok(!JSON.stringify(f.journal.load()).includes(secret));});
test('cancel timeout is unknown and cannot resend an action under a new key',async t=>{const f=fixture(t);f.associate();await f.login();f.handlers['account/login/cancel']=()=>{throw Object.assign(Error(secret),{code:'ACCOUNT_RPC_TIMEOUT'});};await rejection(()=>f.controller.cancel(f.input({operationId:randomUUID(),loginOperationId:f.controller.snapshot().login.operationId})),'ACCOUNT_RPC_TIMEOUT');assert.equal(f.controller.snapshot().login.canCancel,false);});
test('login wait expiration projects unknown and removes ephemeral handoff without restarting',async t=>{let now=1000;const f=fixture(t,{now:()=>now});f.associate();await f.login();now+=600001;assert.equal(f.controller.snapshot().login.state,'unknown');assert.equal(f.controller.snapshot().login.handoffAvailable,false);await rejection(()=>f.login(),'ACCOUNT_LOGIN_PENDING_OR_UNKNOWN');});
test('process exit preserves unknown login and explicit refresh is a read-only separate observation',async t=>{const f=fixture(t);f.associate();await f.login();f.options.onClose();assert.equal(f.controller.snapshot().login.state,'unknown');f.auth();await f.refresh();assert.equal(f.opens,2);assert.equal(f.controller.snapshot().account.status,'authenticated');assert.equal(f.controller.snapshot().login.state,'unknown');assert.equal(f.controller.snapshot().login.canCancel,false);assert.equal(f.calls.filter(c=>c.method==='account/login/start').length,1);});
test('logout requires closing an unresolved current login, then resets only plugin credentials',async t=>{const f=fixture(t);f.associate();await f.login();await rejection(()=>f.controller.logout(f.input({operationId:randomUUID()})),'ACCOUNT_CANCEL_OR_CLOSE_FIRST');await f.controller.disconnect(f.input({operationId:randomUUID()}));await f.controller.logout(f.input({operationId:randomUUID()}));assert.equal(f.controller.snapshot().login.state,'closed_unknown');assert.equal(f.controller.snapshot().account.status,'not_authenticated');assert.equal(f.calls.filter(c=>c.method==='account/logout').length,1);});
test('model selection is explicit and catalog presence never proves access',async t=>{const f=fixture(t);f.associate();await f.refresh();errorCode(()=>f.controller.select(f.input({model:'catalog-model'})),'ACCOUNT_EXPLICIT_MODEL_REQUIRED');f.auth();await f.refresh();assert.equal(f.controller.snapshot().selectedModel,null);errorCode(()=>f.controller.select(f.input({model:'other-model'})),'ACCOUNT_EXPLICIT_MODEL_REQUIRED');f.controller.select(f.input({model:'catalog-model'}));assert.equal(f.controller.snapshot().selectionStatus,'selected_unverified');assert.equal(f.controller.snapshot().modelAccessVerified,false);assert.ok(!f.calls.some(c=>c.method==='turn/start'));});
test('account identity changes and account updates invalidate selection',async t=>{const f=fixture(t);f.associate();f.auth();await f.refresh();f.controller.select(f.input({model:'catalog-model'}));f.auth({type:'chatgpt',email:'other@example.invalid',planType:'plus'});await f.refresh();assert.equal(f.controller.snapshot().selectionStatus,'needs_reconfirmation');f.notify('account/updated',{authMode:'apikey',planType:'pro'});assert.equal(f.controller.snapshot().account.status,'forbidden');assert.equal(f.controller.snapshot().models.length,0);});
test('unexpected account provider is refused without fallback or exposing email',async t=>{const f=fixture(t);f.associate();f.auth({type:'apiKey',email,apiKey:secret});await f.refresh();assert.equal(f.controller.snapshot().account.status,'forbidden');await rejection(()=>f.login(),'ACCOUNT_AUTH_MODE_FORBIDDEN');assert.ok(!JSON.stringify(f.controller.snapshot()).includes(secret));});
test('paginated catalog must complete, excludes hidden entries and retains no default choice',async t=>{const f=fixture(t);f.associate();f.auth();f.handlers['model/list']=p=>p.cursor?{data:[{id:'second',model:'second',displayName:'Second'}],nextCursor:null}:{data:[{id:'hidden',model:'hidden',hidden:true}],nextCursor:'next-page'};await f.refresh();assert.deepEqual(f.controller.snapshot().models.map(m=>m.model),['second']);assert.equal(f.controller.snapshot().selectedModel,null);});
test('broken catalog pagination remains unavailable and cannot silently use a partial list',async t=>{const f=fixture(t);f.associate();f.auth();f.handlers['model/list']=()=>({data:[],nextCursor:'same-page'});await rejection(()=>f.refresh(),'ACCOUNT_CATALOG_INCOMPLETE');assert.equal(f.controller.snapshot().models.length,0);});
test('old objects fail CAS before starting another process or accepting a late response',async t=>{const f=fixture(t);f.associate();const data=f.journal.load();f.journal.commit({...data,agentId:id},data.revision);await rejection(()=>f.login(),'ACCOUNT_CONTROL_STALE');assert.equal(f.opens,0);});
test('late login response after CAS fencing cannot publish a handoff or confirm intent',async t=>{const f=fixture(t);f.associate();f.handlers['account/login/start']=()=>{const old=f.journal.load();f.journal.commit(old,old.revision);return {type:'chatgpt',loginId:'exact',authUrl:'https://auth.openai.com/authorize'};};await rejection(()=>f.login(),'ACCOUNT_CONTROL_STALE');assert.equal(f.journal.load().actions[0].state,'intent');assert.equal(f.controller.handoff,null);});
test('persistence failure after login response cannot become success or repeat transport',async t=>{const f=fixture(t);f.associate();const original=f.journal.commit.bind(f.journal);f.handlers['account/login/start']=()=>{f.journal.commit=()=>{throw Object.assign(Error('synthetic failure'),{code:'ACCOUNT_STORAGE_FAILED'});};return {type:'chatgpt',loginId:'accepted-exact',authUrl:'https://auth.openai.com/authorize'};};await rejection(()=>f.login(),'ACCOUNT_STORAGE_FAILED');f.journal.commit=original;assert.equal(f.journal.load().actions[0].state,'intent');await rejection(()=>f.login(),'ACCOUNT_CONTROL_UNAVAILABLE');assert.equal(f.calls.filter(c=>c.method==='account/login/start').length,1);});
test('concurrent login action is fenced while the first result is pending',async t=>{const f=fixture(t);f.associate();let release;f.handlers['account/login/start']=()=>new Promise(r=>release=r);const first=f.login();await new Promise(resolve=>setImmediate(resolve));await rejection(()=>f.login(),'ACCOUNT_CONTROL_BUSY');release({type:'chatgpt',loginId:'exact',authUrl:'https://auth.openai.com/authorize'});await first;});
test('shutdown waits for its current account request and releases only its own lease',async t=>{const f=fixture(t);f.associate();let release;f.handlers['account/login/start']=()=>new Promise(r=>release=r);const first=f.login();await new Promise(resolve=>setImmediate(resolve));const closing=f.controller.close();release({type:'chatgpt',loginId:'exact',authUrl:'https://auth.openai.com/authorize'});await first;await closing;assert.equal(f.controller.closed,true);assert.equal(f.controller.data.lease,null);});
test('login history limit reserves room for exact cancel and local cleanup',async t=>{const state=init();state.actions=Array.from({length:56},()=>({id:randomUUID(),kind:'login',state:'failed'}));const f=fixture(t,{journal:new AccountControlStore(':memory:',state)});f.associate();await rejection(()=>f.login(),'ACCOUNT_ACTION_LIMIT');assert.equal(f.opens,0);assert.equal(f.journal.load().actions.length,56);});
test('reopening a clean controller keeps the selected model but requires explicit reconfirmation',async t=>{const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'account-reopen-')),file=path.join(root,'control.sqlite');const f=fixture(t,{journal:new AccountControlStore(file,init())});f.associate();f.auth();await f.refresh();f.controller.select(f.input({model:'catalog-model'}));await f.controller.close();const g=fixture(t,{journal:new AccountControlStore(file,init())});assert.equal(g.controller.snapshot().selectedModel,'catalog-model');assert.equal(g.controller.snapshot().selectionStatus,'needs_reconfirmation');assert.equal(g.opens,0);});
test('controller lease blocks another live manager and unrecorded process outcome',()=>{
  for(const processState of [{id:'unknown',state:'starting',pid:null},{id:'live',state:'ready',pid:99}]){
    const state={...init(),lease:{id:'other',pid:42},process:processState};const journal=new AccountControlStore(':memory:',state);
    errorCode(()=>new CodexAccountController({managementStore:{snapshot:()=>({agents:[]})},journal,pidAlive:pid=>processState.state==='ready'&&pid===99}),processState.state==='starting'?'ACCOUNT_PREVIOUS_PROCESS_UNKNOWN':'ACCOUNT_CONTROL_IN_USE');
  }
});
test('independent account journal persists metadata and enforces atomic revision CAS',()=>{
  const dir=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'account-cas-')),file=path.join(dir,'control.sqlite');
  const a=new AccountControlStore(file,init()),b=new AccountControlStore(file,init()),old=a.load();a.commit({...old,agentId:id},old.revision);
  errorCode(()=>b.commit(old,old.revision),'ACCOUNT_CONTROL_STALE');b.close();a.close();const reopened=new AccountControlStore(file,init());assert.equal(reopened.load().agentId,id);reopened.close();
});
test('account directory rejects altered config and injected multilink file metadata',()=>{
  const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'account-home-')),dirs=accountDirectories(root),file=path.join(dirs.home,'config.toml');
  errorCode(()=>accountDirectories(root,{fileInfo:file=>Object.assign(lstatSync(file),{nlink:2})}),'ACCOUNT_CONFIG_CHANGED');
  const root2=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'account-config-')),dirs2=accountDirectories(root2);writeFileSync(path.join(dirs2.home,'config.toml'),'model_provider="external"');errorCode(()=>accountDirectories(root2),'ACCOUNT_CONFIG_CHANGED');
});
test('CLI locator never reads legacy local mapping and requires a direct executable',()=>{
  errorCode(()=>locateAccountCli({PATH:'',CODEX_EXECUTABLE:'old-cli.exe'}),'ACCOUNT_CLI_NOT_FOUND');
  errorCode(()=>locateAccountCli({PATH:'',CODEX_APP_RUNTIME_CLI_PATH:'relative/codex.exe'}),'ACCOUNT_CLI_NOT_FOUND');
});

function processFixture({badVersion=false,actualVersion=ACCOUNT_CLI_VERSION,handshakeVersion=actualVersion}={}) {
  const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'account-wire-')),file=path.join(root,process.platform==='win32'?'codex.exe':'codex');writeFileSync(file,'synthetic binary never executed');
  let child,spawnArgs,sent=[];
  const spawnProcess=(_file,args,options)=>{
    spawnArgs={file:_file,args,options};child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,_encoding,done){const frame=JSON.parse(chunk.toString());sent.push(frame);if(frame.method==='initialize')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:frame.id,result:{userAgent:'codex-cli/'+handshakeVersion}})+'\n'));if(frame.method==='config/read')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:frame.id,result:{config:{forced_login_method:'chatgpt',cli_auth_credentials_store:'file',model_provider:'openai',mcp_servers:{}}}})+'\n'));done();},final(done){queueMicrotask(()=>child.emit('close',0));done();}});child.kill=()=>{queueMicrotask(()=>child.emit('close',0));return true;};return child;
  };
  return {root,file,sent,spawnProcess,environment:{CODEX_APP_RUNTIME_CLI_PATH:file,PATH:'synthetic-path',OPENAI_API_KEY:secret,NODE_OPTIONS:secret},versionProcess:()=>({status:0,stdout:'codex-cli '+(badVersion?'0.0.0':actualVersion)}),get child(){return child;},get spawnArgs(){return spawnArgs;}};
}
test('stdio account process forces clean config and refuses server token/tool requests',async()=>{
  const f=processFixture(),transport=await openAccountProcess({runtimeDirectory:f.root,...f});
  assert.deepEqual(f.sent.map(x=>x.method),['initialize','initialized','config/read']);assert.equal(f.spawnArgs.options.shell,false);assert.equal(f.spawnArgs.options.windowsHide,true);assert.ok(!JSON.stringify(f.spawnArgs.options.env).includes(secret));
  errorCode(()=>transport.request('turn/start',{}),'ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN');
  f.child.stdout.write(JSON.stringify({method:'account/chatgptAuthTokens/refresh',id:99,params:{reason:secret}})+'\n');assert.equal(f.sent.at(-1).error.code,-32601);assert.ok(!JSON.stringify(f.sent).includes(secret));await transport.close();
});
test('unverified CLI version fails before app server start',async()=>{const f=processFixture({badVersion:true});await rejection(()=>openAccountProcess({runtimeDirectory:f.root,...f}),'ACCOUNT_CLI_VERSION_UNVERIFIED');assert.equal(f.child,undefined);});

test('reviewed 0.166 account transport preserves its exact version and tool denial',async()=>{
  const f=processFixture({actualVersion:'0.166.0-alpha.5.1'}),transport=await openAccountProcess({runtimeDirectory:f.root,...f});
  assert.equal(transport.version,'0.166.0-alpha.5.1');
  errorCode(()=>transport.request('turn/start',{}),'ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN');
  assert.equal(f.spawnArgs.options.shell,false);assert.ok(!JSON.stringify(f.spawnArgs.options.env).includes(secret));await transport.close();
});

test('reviewed version cannot accept a different server handshake or an unreviewed patch',async()=>{
  const f=processFixture({actualVersion:'0.166.0-alpha.5.1',handshakeVersion:ACCOUNT_CLI_VERSION});
  await rejection(()=>openAccountProcess({runtimeDirectory:f.root,...f}),'ACCOUNT_HANDSHAKE_UNVERIFIED');
  const unknown=processFixture({actualVersion:'0.166.0-alpha.5.10'});
  await rejection(()=>openAccountProcess({runtimeDirectory:unknown.root,...unknown}),'ACCOUNT_CLI_VERSION_UNVERIFIED');assert.equal(unknown.child,undefined);
});
test('wire timeouts return generic unknown without retrying or exposing diagnostics',async()=>{const f=processFixture(),transport=await openAccountProcess({runtimeDirectory:f.root,...f,timeoutMs:15});const request=transport.request('account/read',{refreshToken:false});f.child.stderr.write(secret+' '+email);await rejection(()=>request,'ACCOUNT_RPC_TIMEOUT');assert.equal(f.sent.filter(x=>x.method==='account/read').length,1);await transport.close();});
test('invalid stdio frame closes only its owned child and leaves pending result unknown',async()=>{const f=processFixture(),transport=await openAccountProcess({runtimeDirectory:f.root,...f});const pending=transport.request('account/read',{refreshToken:false});f.child.stdout.write('not-json\n');await rejection(()=>pending,'ACCOUNT_TRANSPORT_UNKNOWN');await transport.close();});
test('scalar JSON stdio frame cannot crash the account controller',async()=>{const f=processFixture(),transport=await openAccountProcess({runtimeDirectory:f.root,...f});const pending=transport.request('account/read',{refreshToken:false});f.child.stdout.write('null\n');await rejection(()=>pending,'ACCOUNT_TRANSPORT_UNKNOWN');await transport.close();});

function npmFixture({local=false,shim='codex.cmd',split=false,leaf='bin',version='0.167.0'}={}){
  const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'public-npm-cli-'));
  const directory=local?path.join(root,'项目 space','node_modules','.bin'):path.join(root,'npm prefix');
  const packageRoot=local?path.join(path.dirname(directory),'@openai','codex'):path.join(directory,'node_modules','@openai','codex');
  const write=(file,value)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  write(path.join(directory,shim),'throw "This shim must never execute"');write(path.join(packageRoot,'bin','codex.js'),'throw new Error("This entrypoint must never execute")');
  const platformName='@openai/codex-win32-'+process.arch,platformVersion=version+'-win32-'+process.arch;
  const pkg={name:'@openai/codex',version,bin:{codex:'bin/codex.js'},...(split?{optionalDependencies:{[platformName]:'npm:@openai/codex@'+platformVersion}}:{})};
  const packageFile=path.join(packageRoot,'package.json');write(packageFile,pkg);
  const platformRoot=split?path.join(path.dirname(packageRoot),'codex-win32-'+process.arch):packageRoot;
  const platform={name:'@openai/codex',version:platformVersion,os:['win32'],cpu:[process.arch]};
  const platformFile=split?path.join(platformRoot,'package.json'):null;if(platformFile)write(platformFile,platform);
  const target={x64:'x86_64-pc-windows-msvc',arm64:'aarch64-pc-windows-msvc'}[process.arch];
  const binary=path.join(platformRoot,'vendor',target,leaf,'codex.exe');write(binary,'synthetic binary never executed');
  return {root,directory,packageRoot,packageFile,pkg,platformRoot,platformFile,platform,binary,write,environment:{PATH:directory}};
}
const windowsNpm={skip:process.platform!=='win32'||!['x64','arm64'].includes(process.arch)};
test('Windows public npm cmd discovery returns the bundled executable without executing a shim',windowsNpm,()=>{
  const f=npmFixture({leaf:'codex'});assert.equal(locateAccountCli(f.environment),f.binary);
});
test('Windows public npm ps1 discovery supports local bin directories and exact platform aliases',windowsNpm,async()=>{
  const f=npmFixture({local:true,shim:'codex.ps1',split:true}),wire=processFixture({actualVersion:'0.167.0'});
  const transport=await openAccountProcess({runtimeDirectory:wire.root,...wire,environment:f.environment});
  assert.equal(wire.spawnArgs.file,f.binary);assert.equal(wire.spawnArgs.options.shell,false);assert.ok(!wire.spawnArgs.args.some(value=>value.endsWith('.cmd')||value.endsWith('.ps1')||value.endsWith('codex.js')));await transport.close();
});
test('public npm discovery rejects a foreign package name or an unreviewed bin entry',windowsNpm,()=>{
  for(const delta of [{name:'unrelated-cli'},{bin:{codex:'../../another-program.exe'}}]){const f=npmFixture();f.write(f.packageFile,{...f.pkg,...delta});errorCode(()=>locateAccountCli(f.environment),'ACCOUNT_CLI_NOT_FOUND');}
});
test('public npm discovery requires matching alias target, version, operating system and architecture',windowsNpm,()=>{
  for(const delta of [{name:'unrelated-platform'},{version:'99.0.0-win32-'+process.arch},{os:['darwin']},{cpu:[process.arch==='x64'?'arm64':'x64']}]){
    const f=npmFixture({split:true});f.write(f.platformFile,{...f.platform,...delta});errorCode(()=>locateAccountCli(f.environment),'ACCOUNT_CLI_PACKAGE_INVALID');
  }
  const f=npmFixture({split:true});f.write(f.packageFile,{...f.pkg,optionalDependencies:{['@openai/codex-win32-'+process.arch]:'npm:@openai/codex@99.0.0'}});errorCode(()=>locateAccountCli(f.environment),'ACCOUNT_CLI_PACKAGE_INVALID');
});
test('public npm discovery refuses hardlinked executable and package metadata',windowsNpm,()=>{
  const executable=npmFixture();linkSync(executable.binary,path.join(executable.root,'same-executable'));errorCode(()=>locateAccountCli(executable.environment),'ACCOUNT_PATH_LINK_FORBIDDEN');
  const metadata=npmFixture();linkSync(metadata.packageFile,path.join(metadata.root,'same-metadata'));errorCode(()=>locateAccountCli(metadata.environment),'ACCOUNT_CLI_PACKAGE_UNSAFE');
});
test('public npm discovery refuses linked package directories instead of following another installation',windowsNpm,()=>{
  const f=npmFixture(),linked=path.join(f.root,'linked prefix');mkdirSync(linked);f.write(path.join(linked,'codex.cmd'),'not executable');symlinkSync(path.join(f.directory,'node_modules'),path.join(linked,'node_modules'),'junction');errorCode(()=>locateAccountCli({PATH:linked}),'ACCOUNT_PATH_LINK_FORBIDDEN');
});
test('an unrelated Windows shim cannot invoke shell or start a process without a reviewed public package',windowsNpm,async()=>{
  const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'untrusted-shim-'));writeFileSync(path.join(root,'codex.cmd'),'exit /b 0');let versionCalls=0,spawnCalls=0;
  await rejection(()=>openAccountProcess({runtimeDirectory:root,environment:{PATH:root},versionProcess:()=>{versionCalls++;},spawnProcess:()=>{spawnCalls++;}}),'ACCOUNT_CLI_NOT_FOUND');assert.equal(versionCalls,0);assert.equal(spawnCalls,0);
});
test('current account-only versions cannot grant independent model execution',async()=>{
  for(const version of ['0.167.0-alpha.3.2','0.167.0']){
    assert.equal(parseAccountProtocolVersion('codex-cli '+version),version);assert.equal(parseReviewedCodexVersion('codex-cli '+version),null);assert.equal(parseVerifiedCodexVersion('codex-cli '+version),null);
    const f=processFixture({actualVersion:version}),transport=await openAccountProcess({runtimeDirectory:f.root,...f});assert.equal(transport.version,version);errorCode(()=>transport.request('turn/start',{}),'ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN');await transport.close();
  }
});
test('account-only compatibility rejects another patch and version substring handshakes',async()=>{
  for(const version of ['0.167.1','0.167.0-alpha.3.3']){const f=processFixture({actualVersion:version});await rejection(()=>openAccountProcess({runtimeDirectory:f.root,...f}),'ACCOUNT_CLI_VERSION_UNVERIFIED');assert.equal(f.child,undefined);}
  const f=processFixture({actualVersion:'0.167.0-alpha.3.2',handshakeVersion:'0.167.0-alpha.3.20'});await rejection(()=>openAccountProcess({runtimeDirectory:f.root,...f}),'ACCOUNT_HANDSHAKE_UNVERIFIED');
});
