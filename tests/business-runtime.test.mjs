import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ManagementStore} from '../packages/storage/management-store.mjs';
import {Store} from '../packages/application/store.mjs';
import {runBusiness} from '../packages/application/business-runtime.mjs';
import {validQQSecretText} from '../packages/application/qq.mjs';
import {approvalWithinProject} from '../packages/application/app-server-work.mjs';
import {route} from '../packages/application/router.mjs';
test('bot ingress, duplicate protection, scoped work, early events, final delivery and graceful stop compose without any real QQ or model call',async()=>{
 const root=realpathSync(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'qq-business-e2e-'))),runtime=path.join(root,'runtime'),directory=path.join(runtime,'business'),project=realpathSync(mkdtempSync(path.join(os.tmpdir(),'qq-project-e2e-'))),home=path.join(runtime,'codex-account','home');for(const d of [runtime,directory,home])mkdirSync(d,{recursive:true});
 const management=new ManagementStore(path.join(runtime,'management.sqlite'),['codex']);const bot=management.createBot({name:'Synthetic bot',appId:'12345',expectedRevision:0}),agent=management.createAgent({name:'Synthetic agent',toolId:'codex',expectedRevision:1});management.bind({botId:bot.id,agentId:agent.id,expectedRevision:2});const b=management.snapshot().bindings[0];management.close();
 const account=new DatabaseSync(path.join(runtime,'codex-account','control.sqlite'));account.exec('CREATE TABLE account_control(id INTEGER PRIMARY KEY,snapshot TEXT)');account.prepare('INSERT INTO account_control VALUES(1,?)').run(JSON.stringify({agentId:agent.id,connectionId:randomUUID(),selected:{model:'synthetic-model',accountEpoch:'synthetic-epoch'},actions:[]}));account.close();
 const config={schemaVersion:3,instanceId:randomUUID(),runtimeRoot:runtime,stateDir:directory,accountHome:home,file:path.join(directory,'config.local.json'),externalUseConsent:{confirmed:true},binding:{botId:bot.id,agentId:agent.id,bindingId:b.id,bindingVersion:b.version},policyVersion:3,integration:{backend:'app-server'},executor:{enabled:true,binary:process.execPath,timeoutMs:5000,dailyTaskLimit:20,maxQueuedTasks:10},qq:{appId:'12345',passiveWindowSeconds:300,maxPassiveReplies:4,minimumSendIntervalMs:0,allowProactive:false},chat:{model:'synthetic-model',reasoning:'medium'},chatWorkspace:project,chatProjectId:randomUUID(),chatGrantId:randomUUID(),modelCatalog:[{id:'synthetic-model',efforts:['medium'],defaultEffort:'medium'}],projects:{demo:{id:randomUUID(),label:'demo',path:project,mode:'workspace-write',tools:['read','edit'],policyVersion:1}},fileReceive:{enabled:false},fileDelivery:{enabled:false},desktop:{enabled:false},desktopTasks:{enabled:false},desktopApprovals:{enabled:false}};
 writeFileSync(config.file,JSON.stringify(config));const owner=JSON.stringify(['12345','c2c','paired-person']),initial=new Store(directory,{numberingConfig:config});initial.set('owner',owner);initial.close();
 let modelCalls=0;const sent=[];
 class FakeRpc extends EventEmitter{async start(){}async call(method,params){
   if(method==='config/read')return {config:{mcp_servers:{}}};if(method==='model/list')return {data:[{id:'synthetic-model',model:'synthetic-model',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
   if(method==='mcpServerStatus/list')return {data:[]};if(method==='thread/start')return {thread:{id:'owned-thread'},cwd:project,modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',activePermissionProfile:{id:params.permissions,extends:null},sandbox:{type:'workspaceWrite',networkAccess:false},reasoningEffort:'medium'};
   if(method==='turn/start'){modelCalls++;this.emit('notification',{method:'item/completed',params:{threadId:'owned-thread',turnId:'owned-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({outcome:'completed',summary:'合成执行完成'})}}});this.emit('notification',{method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'owned-turn',status:'completed'}}});return {turn:{id:'owned-turn'}};}
   return {};
 }respond(){}reject(){}close(){this.emit('closed');}}
 let stopped=false,finishStart;
 const transport={bot:new EventEmitter(),onMessage(fn){this.receive=fn;},async send(message){sent.push(message);if(message.content.includes('合成执行完成'))setTimeout(()=>this.stop(),20);return {id:'synthetic-send-'+sent.length};},start(signal){signal.addEventListener('abort',()=>this.stop(),{once:true});return new Promise(resolve=>{finishStart=resolve;this.bot.emit('ready');const event={appId:'12345',scope:'c2c',sender:'paired-person',target:'paired-person',sentAt:Date.now()};this.receive({...event,id:'menu',content:'2'});setTimeout(()=>{this.receive({...event,id:'work',content:'新任务 demo：合成检查'});this.receive({...event,id:'work',content:'新任务 demo：合成检查'});this.receive({...event,id:'foreign',sender:'stranger',target:'stranger',content:'新任务 demo：不得执行'});},40);});},stop(){if(stopped)return;stopped=true;finishStart?.();}};
 const fallback=setTimeout(()=>transport.stop(),5000);try{await runBusiness(config,{transportFactory:async()=>transport,workFactory:()=>()=>new FakeRpc()});}finally{clearTimeout(fallback);}
 assert.equal(modelCalls,1);const db=new DatabaseSync(path.join(directory,'state.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);assert.equal(db.prepare('SELECT status FROM tasks').get().status,'succeeded');assert.equal(db.prepare("SELECT status FROM outbox WHERE kind='final'").get().status,'sent');db.close();assert.ok(sent.some(m=>m.content.includes('合成执行完成')));assert.equal(JSON.parse(readFileSync(path.join(directory,'service.json'))).state,'stopped');
});
test('credential validation accepts ordinary secret characters and rejects actual control characters',()=>{
 assert.equal(validQQSecretText('rnx001SyntheticReference'),true);for(const value of ['',null,'a\nb','a\rb','a\0b','x'.repeat(513)])assert.equal(validQQSecretText(value),false);
});
test('local approvals cannot grant network or wider filesystem access',()=>{
 const project=realpathSync(mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'qq-local-approval-')));
 assert.equal(approvalWithinProject({method:'item/commandExecution/requestApproval',params:{cwd:project,sandboxPermissions:'use_default'}},project),true);
 assert.equal(approvalWithinProject({method:'item/commandExecution/requestApproval',params:{cwd:project,sandboxPermissions:'require_escalated'}},project),false);
 assert.equal(approvalWithinProject({method:'item/commandExecution/requestApproval',params:{cwd:project,sandboxPermissions:'use_default',networkApprovalContext:{host:'external.invalid'}}},project),false);
});

test('an unknown original task cannot be continued as a new remote turn before reconciliation',()=>{
 const directory=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'qq-unknown-continuation-')),config={stateDir:directory,policyVersion:3,integration:{backend:'app-server'},qq:{appId:'12345'},executor:{enabled:true,dailyTaskLimit:20,maxQueuedTasks:10},projects:{demo:{path:directory,label:'demo'}},fileReceive:{enabled:false}},store=new Store(directory,{numberingConfig:config});
 const owner=JSON.stringify(['12345','c2c','paired-person']);store.set('owner',owner);let serial=0;const send=content=>route(store,config,{appId:'12345',scope:'c2c',sender:'paired-person',target:'paired-person',id:'synthetic-'+(++serial),sentAt:Date.now(),content});
 try{send('2');send('新任务 demo：合成任务');const task=store.tasks(owner)[0];store.db.prepare("UPDATE tasks SET status='unknown',thread_id='owned-prior' WHERE id=?").run(task.id);send('继续 '+task.display_id+'：再次执行');assert.equal(store.tasks(owner).length,1);assert.match(store.outbox().at(-1).content,/原任务结果待核对/);}finally{store.close();}
});
