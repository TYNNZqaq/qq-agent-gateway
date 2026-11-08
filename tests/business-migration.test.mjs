import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {migrateBusiness,databaseManifest} from '../packages/host-control/business-migration.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'business-migration-')),source=path.join(root,'source'),destination=path.join(root,'destination'),home=path.join(root,'account','home'),executable=path.join(root,'codex.exe');
  for(const directory of [source,home,path.join(source,'artifact-spool'),path.join(source,'received'),path.join(source,'chat-runs'),path.join(source,'runs')])mkdirSync(directory,{recursive:true});writeFileSync(executable,'synthetic never executed');
  const file=path.join(source,'artifact-spool','delivered.txt'),received=path.join(source,'received','input.txt');writeFileSync(file,'original exported bytes');writeFileSync(received,'original attachment bytes');
  writeFileSync(path.join(source,'chat-runs','metadata.json'),'{"outcome":"preserved"}');writeFileSync(path.join(source,'qq.secret'),'SYNTHETIC_ENCRYPTED_CIPHERTEXT');
  const config={schemaVersion:2,instanceId:randomUUID(),qq:{appId:'12345',credentialFile:'qq.secret',passiveWindowSeconds:300,maxPassiveReplies:4,minimumSendIntervalMs:3200,allowProactive:true},executor:{enabled:true,timeoutMs:60000,dailyTaskLimit:20,maxQueuedTasks:10},integration:{backend:'app-server'},chat:{model:'synthetic-selected-model',reasoning:'medium'},projects:{},fileReceive:{enabled:true,directory:path.join(source,'received')}};
  writeFileSync(path.join(source,'config.local.json'),JSON.stringify(config));
  const db=new DatabaseSync(path.join(source,'state.sqlite'));
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE tasks(id INTEGER PRIMARY KEY,status TEXT);CREATE TABLE chat_turns(id INTEGER PRIMARY KEY,status TEXT);CREATE TABLE outbox(id INTEGER PRIMARY KEY,status TEXT);CREATE TABLE file_transfers(id INTEGER PRIMARY KEY,spool_path TEXT);CREATE TABLE received_files(id INTEGER PRIMARY KEY,local_path TEXT);CREATE TABLE preserved_records(id INTEGER PRIMARY KEY,body TEXT);`);
  db.prepare('INSERT INTO settings VALUES(?,?)').run('owner',JSON.stringify(['12345','c2c','paired-person']));
  db.prepare('INSERT INTO settings VALUES(?,?)').run('artifactManifest:T:1',JSON.stringify([{path:file,root:path.dirname(file),owner:'paired-person'}]));
  db.prepare('INSERT INTO file_transfers VALUES(?,?)').run(1,file);db.prepare('INSERT INTO received_files VALUES(?,?)').run(1,received);
  db.prepare('INSERT INTO preserved_records VALUES(?,?)').run(1,'原始聊天、人设、记忆和遗忘墓碑内容');db.prepare('INSERT INTO preserved_records VALUES(?,?)').run(2,'用户正文中的旧路径 '+file);
  db.exec("INSERT INTO tasks VALUES(1,'succeeded');INSERT INTO chat_turns VALUES(1,'succeeded');INSERT INTO outbox VALUES(1,'sent');");db.close();
  const binding={botId:randomUUID(),agentId:randomUUID(),bindingId:randomUUID(),bindingVersion:1};
  return {root,source,destination,home,executable,config,binding,options:{sourceDirectory:source,destinationDirectory:destination,sourceInactive:true,accountHome:home,binding,executable}};
}
test('existing bot migration preserves the encrypted bot identity, every row and user text, and relocates only file metadata',async()=>{
  const f=fixture(),before=hash(readFileSync(path.join(f.source,'state.sqlite'))),result=await migrateBusiness(f.options);
  assert.equal(result.botPreserved,true);assert.equal(result.executionEnabled,false);assert.equal(hash(readFileSync(path.join(f.source,'state.sqlite'))),before);
  assert.deepEqual(readFileSync(path.join(f.destination,'qq.secret')),readFileSync(path.join(f.source,'qq.secret')));
  const target=new DatabaseSync(path.join(f.destination,'state.sqlite'),{readOnly:true}),original=new DatabaseSync(path.join(f.source,'state.sqlite'),{readOnly:true});
  assert.deepEqual(target.prepare('SELECT * FROM preserved_records').all(),original.prepare('SELECT * FROM preserved_records').all());
  assert.deepEqual(databaseManifest(target).map(x=>[x.name,x.count,x.schemaHash]),databaseManifest(original).map(x=>[x.name,x.count,x.schemaHash]));
  assert.equal(target.prepare('SELECT spool_path p FROM file_transfers').get().p,path.join(f.destination,'artifact-spool','delivered.txt'));
  assert.equal(target.prepare('SELECT local_path p FROM received_files').get().p,path.join(f.destination,'received','input.txt'));
  const config=JSON.parse(readFileSync(path.join(f.destination,'config.local.json')));assert.deepEqual(config.chat,f.config.chat);assert.equal(config.qq.appId,f.config.qq.appId);assert.deepEqual(config.binding,f.binding);assert.equal(config.executor.enabled,false);target.close();original.close();
});
test('migration refuses active or uncertain source, existing destination and incomplete binding',async()=>{
  for(const field of ['active','destination','binding']){const f=fixture();if(field==='active')f.options.sourceInactive=false;if(field==='destination'){mkdirSync(f.destination);writeFileSync(path.join(f.destination,'untouched.txt'),'keep');}if(field==='binding')f.options.binding={};await assert.rejects(migrateBusiness(f.options));if(field==='destination')assert.equal(readFileSync(path.join(f.destination,'untouched.txt'),'utf8'),'keep');}
});
test('pending work is preserved at source and blocks copying into a runnable instance',async()=>{
  const f=fixture(),db=new DatabaseSync(path.join(f.source,'state.sqlite'));db.exec("UPDATE outbox SET status='sending'");db.close();await assert.rejects(migrateBusiness(f.options),/MIGRATION_PENDING_WORK_REQUIRES_REVIEW/);assert.equal(existsSync(path.join(f.destination,'config.local.json')),false);
});
test('failed attachment relocation leaves an explicit incomplete report and does not alter the original database',async()=>{
  const f=fixture(),db=new DatabaseSync(path.join(f.source,'state.sqlite'));db.prepare('UPDATE received_files SET local_path=?').run(path.join(f.source,'received','missing.txt'));db.close();const before=hash(readFileSync(path.join(f.source,'state.sqlite')));await assert.rejects(migrateBusiness(f.options),/MIGRATION_REFERENCED_FILE_MISSING/);assert.equal(hash(readFileSync(path.join(f.source,'state.sqlite'))),before);assert.equal(JSON.parse(readFileSync(path.join(f.destination,'migration.json'))).state,'incomplete');assert.equal(existsSync(path.join(f.destination,'config.local.json')),false);
});
test('already delivered and deliberately released spool metadata remains preserved without resurrecting deleted bytes',async()=>{
 const f=fixture(),db=new DatabaseSync(path.join(f.source,'state.sqlite'));db.exec("ALTER TABLE file_transfers ADD COLUMN upload_state TEXT;ALTER TABLE file_transfers ADD COLUMN outbox_id INTEGER;");db.prepare('UPDATE file_transfers SET spool_path=?,upload_state=?,outbox_id=?').run(path.join(f.source,'artifact-spool','already-released.txt'),'released',1);db.close();await migrateBusiness(f.options);const copied=new DatabaseSync(path.join(f.destination,'state.sqlite'),{readOnly:true}),row=copied.prepare('SELECT spool_path,upload_state FROM file_transfers').get();assert.equal(row.upload_state,'released');assert.equal(existsSync(row.spool_path),false);assert.equal(row.spool_path,path.join(f.destination,'artifact-spool','already-released.txt'));copied.close();
});
