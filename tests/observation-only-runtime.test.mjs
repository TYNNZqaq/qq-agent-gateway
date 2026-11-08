import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {ManagementStore} from '../packages/storage/management-store.mjs';
import {Store} from '../packages/application/store.mjs';
import {runBusiness} from '../packages/application/business-runtime.mjs';
import {navigate} from '../packages/application/menus.mjs';
import {route} from '../packages/application/router.mjs';

function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'observe-only-'))),runtime=path.join(root,'data'),stateDir=path.join(runtime,'business'),accountHome=path.join(runtime,'codex-account','home'),nativeHome=path.join(root,'native'),project=path.join(root,'project');
 for(const d of [stateDir,accountHome,path.join(nativeHome,'sessions'),project])fs.mkdirSync(d,{recursive:true});
 const management=new ManagementStore(path.join(runtime,'management.sqlite'),['codex']),bot=management.createBot({name:'Synthetic bot',appId:'12345',expectedRevision:0}),agent=management.createAgent({name:'Synthetic agent',toolId:'codex',expectedRevision:1});management.bind({botId:bot.id,agentId:agent.id,expectedRevision:2});const b=management.snapshot().bindings[0];management.close();
 const account=new DatabaseSync(path.join(runtime,'codex-account','control.sqlite'));account.exec('CREATE TABLE account_control(id INTEGER PRIMARY KEY,snapshot TEXT)');account.prepare('INSERT INTO account_control VALUES(1,?)').run(JSON.stringify({agentId:agent.id,connectionId:randomUUID(),selected:{model:'preserved-model',accountEpoch:'synthetic'},actions:[]}));account.close();
 const native=new DatabaseSync(path.join(nativeHome,'state_5.sqlite'));native.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,source TEXT,originator TEXT,cwd TEXT,cli_version TEXT,title TEXT,updated_at INTEGER)');native.close();
 const config={instanceId:randomUUID(),hostId:randomUUID(),runtimeRoot:runtime,stateDir,accountHome,file:path.join(stateDir,'config.local.json'),externalUseConsent:{confirmed:true},binding:{botId:bot.id,agentId:agent.id,bindingId:b.id,bindingVersion:b.version},policyVersion:3,integration:{backend:'app-server'},executor:{enabled:true,binary:process.execPath,maxQueuedTasks:10,dailyTaskLimit:20},qq:{appId:'12345',passiveWindowSeconds:300,maxPassiveReplies:4,minimumSendIntervalMs:0,allowProactive:false},chat:{model:'preserved-model',reasoning:'medium'},chatWorkspace:project,projects:{demo:{path:project,label:'合成项目',mode:'workspace-write',tools:['read','edit']}},desktopNotifications:{enabled:true,scope:'all-local',observationOnlyFallback:true,home:nativeHome,since:Date.now()-1000},fileReceive:{enabled:false},fileDelivery:{enabled:false}};
 fs.writeFileSync(config.file,JSON.stringify(config));const owner=JSON.stringify(['12345','c2c','paired-person']),store=new Store(stateDir,{numberingConfig:config});store.set('owner',owner);store.close();return {root,config,stateDir,owner};
}
test('proof failure connects observation service with explicit status and zero work, chat or catalog dispatch',async()=>{
 const f=fixture();let calls=0,finish,ready;
 const workFactory=()=>Object.assign(()=>{calls++;throw Error('MUST_NOT_DISPATCH');},{readiness:()=>({verified:false,reason:'CODEX_PROOF_SOURCE_CHANGED'})});
 const transport={bot:new EventEmitter(),onMessage(fn){this.receive=fn;},send:async()=>({id:'synthetic-receipt'}),start(){return new Promise(resolve=>{finish=resolve;this.bot.emit('ready');ready=JSON.parse(fs.readFileSync(path.join(f.stateDir,'service.json')));setTimeout(()=>this.stop(),1100);});},stop(){finish?.();}};
 await runBusiness(f.config,{workFactory,transportFactory:async()=>transport});assert.equal(calls,0);assert.equal(ready.qqConnected,true);assert.equal(ready.executionEnabled,false);assert.equal(ready.codexVerified,false);assert.equal(ready.observationOnly,true);assert.equal(ready.executionBlockedReason,'CODEX_PROOF_SOURCE_CHANGED');assert.equal(JSON.parse(fs.readFileSync(f.config.file)).executor.enabled,true);
});
test('observation fallback requires explicit configuration and does not consume an unverified execution request',async()=>{
 const f=fixture();f.config.desktopNotifications.observationOnlyFallback=false;fs.writeFileSync(f.config.file,JSON.stringify(f.config));let connected=0;const workFactory=()=>Object.assign(()=>{throw Error('MUST_NOT_DISPATCH');},{readiness:()=>({verified:false,reason:'CODEX_PROOF_SOURCE_CHANGED'})});
 await assert.rejects(runBusiness(f.config,{workFactory,transportFactory:async()=>{connected++;}}),/CODEX_PROOF_SOURCE_CHANGED/);assert.equal(connected,0);
});
test('observation-only chat and task input cannot silently create a future generation queue',()=>{
 const f=fixture(),store=new Store(f.stateDir,{numberingConfig:f.config});f.config.executor.enabled=false;f.config.executionBlockedReason='CODEX_PROOF_SOURCE_CHANGED';let serial=0;const send=content=>route(store,f.config,{appId:'12345',scope:'c2c',sender:'paired-person',target:'paired-person',id:'message-'+(++serial),sentAt:Date.now(),content});
 try{navigate(store,f.owner,'codex');send('新任务 demo：不要建立待执行任务');assert.equal(store.tasks(f.owner).length,0);assert.match(store.outbox().at(-1).content,/尚未创建任务/);navigate(store,f.owner,'chatgpt');send('开始新对话');send('一条普通聊天');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM chat_turns').get().n,0);assert.match(store.outbox().at(-1).content,/没有加入生成队列/);}finally{store.close();}
});
