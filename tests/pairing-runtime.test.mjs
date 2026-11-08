import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {freshContext} from './helpers/fresh-context.mjs';
import {prepareFreshBusiness,activateFreshBusiness} from '../packages/application/fresh-bootstrap.mjs';
import {runPairing} from '../packages/application/pairing-runtime.mjs';
test('pairing admits only the one-time human code, records the actual owner and never enables model work',async()=>{
 const f=freshContext(),config=prepareFreshBusiness(f.paths.dataDirectory,{executable:process.execPath}).config,code='a'.repeat(24),sent=[];let finish;
 const transport={bot:new EventEmitter(),onMessage(fn){this.receive=fn;},async send(m){sent.push(m);return {id:'synthetic-pair-receipt'};},start(signal){signal.addEventListener('abort',()=>this.stop(),{once:true});return new Promise(resolve=>{finish=resolve;this.bot.emit('ready');const e={appId:'12345',scope:'c2c',sender:'synthetic-person',target:'synthetic-person',sentAt:Date.now()};this.receive({...e,id:'wrong',sender:'stranger',target:'stranger',content:'绑定 '+ 'b'.repeat(24)});this.receive({...e,id:'pair',content:'绑定 '+code});});},stop(){finish?.();}};
 const result=await runPairing(config,{operationId:randomUUID(),code,transportFactory:async()=>transport,expiresMs:2000});assert.equal(result.paired,true);assert.equal(sent.length,1);assert.equal(sent[0].target,'synthetic-person');const db=new DatabaseSync(path.join(config.stateDir,'state.sqlite'),{readOnly:true});assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='owner'").get().value),JSON.stringify(['12345','c2c','synthetic-person']));assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);db.close();assert.equal(JSON.parse(readFileSync(path.join(config.stateDir,'config.local.json'))).executor.enabled,false);assert.throws(()=>activateFreshBusiness(f.paths.dataDirectory),/CODEX_WORK_NOT_VERIFIED/);for(const file of ['service.json','pairing-result.json','state.sqlite'])assert.equal(readFileSync(path.join(config.stateDir,file)).includes(Buffer.from(code)),false);
});
test('expired pairing handoffs cannot open a QQ transport or extend their original deadline',async()=>{
 let opened=0;await assert.rejects(runPairing({}, {operationId:randomUUID(),code:'a'.repeat(24),expiresAt:Date.now()-1,transportFactory:()=>{opened++;}}),/PAIRING_CODE_EXPIRED/);assert.equal(opened,0);
});
