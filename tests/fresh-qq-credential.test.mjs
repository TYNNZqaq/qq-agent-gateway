import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readSecret} from '../packages/application/qq.mjs';
function fixture(){const directory=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'fresh-qq-secret-')),credentialFile=path.join(directory,'qq.secret'),binding={botId:randomUUID(),agentId:randomUUID(),bindingId:randomUUID(),bindingVersion:1},accountConnectionId=randomUUID();writeFileSync(credentialFile,'synthetic-ciphertext');return {config:{qq:{appId:'12345',credentialFile,credentialFormat:'dpapi-qq-owner-v1'},binding,accountConnectionId},plain:{owner:{...binding,accountConnectionId},appId:'12345',appSecret:'synthetic-bot-secret-not-real'}};}
test('fresh bot credentials are decrypted only inside their exact local bot, binding and account owner',async()=>{const f=fixture();assert.equal(await readSecret(f.config,{protector:{open:async cipher=>{assert.equal(cipher,'synthetic-ciphertext');return JSON.stringify(f.plain);}}}),f.plain.appSecret);});
test('a credential for another bot or account cannot be reused and its plaintext never appears in errors',async()=>{for(const field of ['appId','owner']){const f=fixture();if(field==='appId')f.plain.appId='67890';else f.plain.owner.accountConnectionId=randomUUID();await assert.rejects(readSecret(f.config,{protector:{open:async()=>JSON.stringify(f.plain)}}),e=>e.message==='QQ_CREDENTIAL_UNAVAILABLE'&&!e.message.includes(f.plain.appSecret));}});
