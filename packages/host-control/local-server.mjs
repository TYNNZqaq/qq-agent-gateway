import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ManagementStore } from '../storage/management-store.mjs';
import { ManagementError } from '../core/management.mjs';
import { discoverTools,toolIds } from './tool-catalog.mjs';
import { CodexAccountController } from './codex-account-controller.mjs';
import { QQConnectionController } from './qq-connection-controller.mjs';
import {codexLiveStatus} from './codex-live-status.mjs';
import {createHash} from 'node:crypto';
import {BusinessController} from './business-controller.mjs';
import {SetupController} from './setup-controller.mjs';

const uiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../management-ui');
const programVersion=JSON.parse(readFileSync(path.resolve(uiRoot,'../../package.json'),'utf8')).version;
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']],['/favicon.svg',['favicon.svg','image/svg+xml']]]);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function checkedDirectory(dir){
  const full=path.resolve(dir); if(full===path.parse(full).root)throw Error('UNSAFE_RUNTIME_DIRECTORY');
  let cursor=full; while(cursor!==path.dirname(cursor)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw Error('RUNTIME_LINK_FORBIDDEN');cursor=path.dirname(cursor);}
  mkdirSync(full,{recursive:true});return realpathSync(full);
}
export async function createManagementServer({runtimeDirectory,port=0,database,tools,mode='foundation',instanceId=randomBytes(16).toString('hex'),accountControlFactory,qqConnectionFactory,businessControlFactory,setupControlFactory}={}) {
  if(!runtimeDirectory&&!database)throw Error('RUNTIME_DIRECTORY_REQUIRED');
  if(!database){runtimeDirectory=checkedDirectory(runtimeDirectory);database=path.join(runtimeDirectory,'management.sqlite');if(existsSync(database)){const st=lstatSync(database);if(st.isSymbolicLink()||st.nlink!==1)throw Error('UNSAFE_DATABASE_FILE');}}
  const store=new ManagementStore(database,toolIds),sessions=new Map(),rate=new Map();
  let accountControl=null,accountIssue='ACCOUNT_DIRECTORY_REQUIRED';
  try{accountControl=accountControlFactory?accountControlFactory(store):runtimeDirectory?new CodexAccountController({runtimeDirectory,managementStore:store}):null;}catch(error){accountIssue=error instanceof ManagementError?error.code:'ACCOUNT_CONTROL_UNAVAILABLE';}
  const accountState=()=>{try{return accountControl?accountControl.snapshot():{available:false,reason:accountIssue,executionEnabled:false};}catch{return {available:false,reason:'ACCOUNT_CONTROL_UNAVAILABLE',executionEnabled:false};}};
  let qqConnection=null,qqIssue='QQ_DIRECTORY_REQUIRED';
  try{qqConnection=qqConnectionFactory?qqConnectionFactory(store,accountControl):runtimeDirectory?new QQConnectionController({runtimeDirectory,managementStore:store,accountControl}):null;}catch(error){qqIssue=error instanceof ManagementError?error.code:'QQ_CONTROL_UNAVAILABLE';}
  const qqState=()=>{try{return qqConnection?qqConnection.snapshot():{available:false,reason:qqIssue,executionEnabled:false};}catch{return {available:false,reason:'QQ_CONTROL_UNAVAILABLE',executionEnabled:false};}};
  const workState=()=>{const a=accountControl?.data,s=store.snapshot(),b=s.bindings.find(x=>x.agentId===a?.agentId);return codexLiveStatus({runtimeDirectory,agentId:a?.agentId,connectionId:a?.connectionId,model:a?.selected?.model,selectionEpoch:a?.selected?.accountEpoch,accountActionsFingerprint:createHash('sha256').update(JSON.stringify((a?.actions||[]).filter(x=>['login','logout'].includes(x.kind)))).digest('hex'),binding:b?{...b,bindingId:b.id,bindingVersion:b.version}:null});};
  const business=businessControlFactory?businessControlFactory(store,accountControl):runtimeDirectory?new BusinessController({runtimeDirectory,managementStore:store,accountControl}):null;
  const businessState=()=>{try{return business?business.snapshot():{available:false,configured:false,running:false};}catch{return {available:false,configured:false,running:false,error:'BUSINESS_CONTROL_UNAVAILABLE'};}};
  let setup=null;try{setup=setupControlFactory?setupControlFactory(store,accountControl,business):runtimeDirectory&&existsSync(path.join(runtimeDirectory,'instance.json'))?new SetupController({runtimeDirectory,managementStore:store,accountControl,businessControl:business,qqConnection,executionStatus:workState}):null;}catch{}
  const setupState=sessionId=>{try{return setup?setup.snapshot(sessionId):{available:false};}catch{return {available:false,error:'SETUP_CONTROL_UNAVAILABLE'};}};
  let origin;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      if(req.headers.host!==new URL(origin).host || req.headers.origin&&req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site')throw new ManagementError('LOCAL_ORIGIN_REQUIRED',403);
      const url=new URL(req.url,origin);const asset=assets.get(url.pathname);
      if(asset&&req.method==='GET'){res.writeHead(200,{'Content-Type':asset[1]});res.end(readFileSync(path.join(uiRoot,asset[0])));return;}
      if(url.pathname==='/health'&&req.method==='GET'){json(res,200,{service:'qq-agent-management',version:programVersion,mode,instanceId,executionEnabled:false});return;}
      const current=Date.now(),key=req.socket.remoteAddress;const limit=rate.get(key);
      if(!limit||current-limit.start>60000)rate.set(key,{start:current,count:1});else if(++limit.count>240)throw new ManagementError('RATE_LIMITED',429);
      if(url.pathname==='/api/bootstrap'&&req.method==='GET'){
        for(const [id,s]of sessions)if(s.expires<current)sessions.delete(id);
        let token=/\bqq_console=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1];let session=sessions.get(token);
        if(!session||session.expires<current){if(sessions.size>=32)throw new ManagementError('SESSION_LIMIT',429);token=randomBytes(32).toString('hex');session={csrf:randomBytes(24).toString('hex'),expires:current+8*3600000};sessions.set(token,session);}
        res.setHeader('Set-Cookie',`qq_console=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);json(res,200,{csrf:session.csrf,mode,executionEnabled:false});return;
      }
      const session=sessions.get(/\bqq_console=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1]);
      if(!session||session.expires<current)throw new ManagementError('LOCAL_SESSION_REQUIRED',401);
      if(url.pathname==='/api/state'&&req.method==='GET'){json(res,200,{...store.snapshot(),tools:tools||discoverTools(runtimeDirectory),codexAccount:accountState(),codexWork:workState(),business:businessState(),qqConnection:qqState(),setup:setupState(session.csrf),mode,executionEnabled:false,service:{startedAt,version:programVersion}});return;}
      if(url.pathname==='/api/codex/account'&&req.method==='GET'){json(res,200,accountState());return;}
      if(url.pathname==='/api/qq/connection'&&req.method==='GET'){json(res,200,qqState());return;}
      if(url.pathname==='/api/diagnostics/preview'&&req.method==='GET'){if(!setup)throw new ManagementError('SETUP_CONTROL_UNAVAILABLE',503);json(res,200,setup.diagnostics());return;}
      if(!['POST','PATCH','DELETE','PUT'].includes(req.method))throw new ManagementError('NOT_FOUND',404);
      if(req.headers.origin!==origin||!equal(req.headers['x-csrf-token'],session.csrf))throw new ManagementError('LOCAL_CONFIRMATION_REQUIRED',403);
      if(req.headers['content-type']!=='application/json')throw new ManagementError('JSON_REQUIRED',415);
      let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>16384)throw new ManagementError('BODY_TOO_LARGE',413);chunks.push(c);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ManagementError('INVALID_JSON');}
      if(url.pathname==='/api/diagnostics/export'&&req.method==='POST'){
        if(!setup)throw new ManagementError('SETUP_CONTROL_UNAVAILABLE',503);if(body?.expectedRevision!==store.revision())throw new ManagementError('STALE_REVISION',409);const {expectedRevision,...input}=body;json(res,200,setup.exportDiagnostics(input));return;
      }
      const setupRoute=/^\/api\/setup\/(consent|project|verification-project|initialize|self-test|pair|pair-code|activate)$/.exec(url.pathname);
      if(setupRoute&&req.method==='POST'){
        if(!setup)throw new ManagementError('SETUP_CONTROL_UNAVAILABLE',503);
        if(!body||Array.isArray(body)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==store.revision())throw new ManagementError('STALE_REVISION',409);
        const {expectedRevision,...input}=body,methods={'self-test':'selfTest','pair-code':'pairCode','verification-project':'verificationProject'};json(res,200,await setup[methods[setupRoute[1]]||setupRoute[1]](input,session.csrf));return;
      }
      const businessRoute=/^\/api\/business\/(prepare|start|stop|approve|project)$/.exec(url.pathname);
      if(businessRoute&&req.method==='POST'){
        if(!business)throw new ManagementError('BUSINESS_CONTROL_UNAVAILABLE',503);
        if(!body||Array.isArray(body)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==store.revision())throw new ManagementError('STALE_REVISION',409);
        const {expectedRevision,...input}=body;const result=await business[businessRoute[1]](input);json(res,200,result);return;
      }
      const qqRoute=/^\/api\/qq\/connection\/(credentials|verify|cancel|disconnect)$/.exec(url.pathname);
      if(qqRoute&&req.method==='POST'){
        if((businessState().running||businessState().pending)&&['credentials','disconnect','verify'].includes(qqRoute[1]))throw new ManagementError('BUSINESS_STOP_FIRST',409);
        if(!qqConnection)throw new ManagementError(qqIssue,503);
        if(!body||Array.isArray(body)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==store.revision())throw new ManagementError('STALE_REVISION',409);
        const {expectedRevision,...input}=body;const result=await qqConnection[qqRoute[1]](input);json(res,200,result);return;
      }
      const accountRoute=/^\/api\/codex\/account\/(associate|status|login|handoff|cancel|model|logout|close)$/.exec(url.pathname);
      if(accountRoute&&req.method==='POST'){
        if((businessState().running||businessState().pending)&&['associate','login','model','logout','close'].includes(accountRoute[1]))throw new ManagementError('BUSINESS_STOP_FIRST',409);
        if(!accountControl)throw new ManagementError(accountIssue,503);
        if(!body||Array.isArray(body)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==store.revision())throw new ManagementError('STALE_REVISION',409);
        const {expectedRevision,...input}=body;
        const methods={associate:'associate',status:'refresh',login:'login',handoff:'reveal',cancel:'cancel',model:'select',logout:'logout',close:'disconnect'};
        const result=await accountControl[methods[accountRoute[1]]](input,session.csrf);
        json(res,200,result);return;
      }
      const match=/^\/api\/(bots|agents)\/([a-f0-9-]{36})$/.exec(url.pathname);let result;
      if(url.pathname==='/api/bots'&&req.method==='POST')result=store.createBot(body);
      else if(url.pathname==='/api/agents'&&req.method==='POST')result=store.createAgent(body);
      else if(url.pathname==='/api/bindings'&&req.method==='PUT')result=store.bind(body);
      else if(match&&req.method==='PATCH')result=match[1]==='bots'?store.updateBot(match[2],body):store.updateAgent(match[2],body);
      else if(match&&req.method==='DELETE'){
        if(match[1]==='agents'&&accountControl&&accountControl.snapshot().agentId===match[2])throw new ManagementError('ACCOUNT_ASSOCIATION_PRESENT',409);
        result=match[1]==='bots'?store.archiveBot(match[2],body):store.archiveAgent(match[2],body);
      }
      else throw new ManagementError('NOT_FOUND',404);
      json(res,200,{...result,revision:store.revision(),executionEnabled:false});
    }catch(error){json(res,error instanceof ManagementError?error.status:500,{error:error instanceof ManagementError?error.code:'MANAGEMENT_REQUEST_FAILED'});}
  });
  const startedAt=new Date().toISOString();
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxHeadersCount=40;
  server.on('clientError',(_e,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(e){await setup?.close();await qqConnection?.close();await accountControl?.close();store.close();throw e;}
  origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,server,store,accountControl,qqConnection,setup,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await setup?.close();await qqConnection?.close();await accountControl?.close();store.close();}};
}
