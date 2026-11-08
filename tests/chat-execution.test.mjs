import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createChatExecution} from '../packages/application/chat-execution.mjs';
function fixture(mode){
 const data=new Map([['owner','paired-person']]),store={get:k=>data.get(k),set:(k,v)=>data.set(k,v)},workspace=mkdtempSync(path.join(os.tmpdir(),'qq-chat-execution-')),home=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'qq-chat-account-')),config={instanceId:randomUUID(),binding:{},chatWorkspace:workspace,accountHome:home,stateDir:home,executor:{timeoutMs:1000}},turn={id:1,owner_key:'paired-person'},calls=[];
 class Rpc extends EventEmitter{constructor(){super();this.permissionProfile='qq-project-'+randomUUID();}async start(){}async close(){this.emit('closed');}reject(){}async call(method,p){calls.push(method);if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='thread/start')return {thread:{id:'thread-own'},cwd:workspace,activePermissionProfile:{id:p.permissions},sandbox:{type:mode==='writable'?'workspaceWrite':'readOnly',networkAccess:false}};if(method==='turn/start'){
  if(mode==='closed'){this.emit('closed');return {turn:{id:'turn-own'}};}
  const text=JSON.stringify({outcome:'completed',reply_text:'合成聊天回复',memory_candidates:[],topic_update:null});this.emit('notification',{method:'item/completed',params:{threadId:'thread-own',turnId:'turn-foreign',item:{type:'agentMessage',text:'foreign'}}});this.emit('notification',{method:'item/completed',params:{threadId:'thread-own',turnId:'turn-own',item:{type:'agentMessage',phase:'final_answer',text}}});this.emit('notification',{method:'turn/completed',params:{threadId:'thread-own',turn:{id:'turn-own',status:'completed'}}});return {turn:{id:'turn-own'}};
 }throw Error('UNEXPECTED_SYNTHETIC_CALL');}}
 const execute=createChatExecution(config,store,{rpcFactory:()=>new Rpc()}),input={prompt:'synthetic',schema:{},model:'synthetic-chat-model',reasoning:'medium',turn};return {execute,input,calls,data};
}
test('chat binds early notifications to the exact owned turn and never submits the same local turn twice',async()=>{const f=fixture('normal'),r=await f.execute(f.input);assert.equal(r.status,'succeeded');assert.equal(r.reply_text,'合成聊天回复');assert.equal(r.threadId,'thread-own');assert.equal((await f.execute(f.input)).status,'unknown');assert.equal(f.calls.filter(x=>x==='turn/start').length,1);});
test('chat refuses writable session projection before model dispatch',async()=>{const f=fixture('writable');assert.equal((await f.execute(f.input)).status,'failed');assert.equal(f.calls.includes('turn/start'),false);});
test('chat connection loss after dispatch stays unknown and requires reconciliation',async()=>{const f=fixture('closed');assert.equal((await f.execute(f.input)).status,'unknown');assert.equal(f.data.get('chatDispatch:1:0').state,'unknown');assert.equal((await f.execute(f.input)).status,'unknown');assert.equal(f.calls.filter(x=>x==='turn/start').length,1);});
