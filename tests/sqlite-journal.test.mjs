import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteJournal } from '../packages/storage/sqlite-journal.mjs';
import { digest } from '../packages/core/contracts.mjs';

const owner={hostId:'host-test',agentId:'agent-a'};
const snapshot=(revision=1,extra={})=>({schemaVersion:1,revision,owner,...extra});
function fixture(t){
  const root=process.env.QQ_TEST_ROOT??path.resolve('QQ插件运行目录/test-work');mkdirSync(root,{recursive:true});
  const database=path.join(mkdtempSync(path.join(root,'journal-')),'synthetic.sqlite'),all=[];
  const open=(options={})=>{const j=new SqliteJournal(database,{...owner,channel:'adapter',...options});all.push(j);return j;};
  t.after(()=>{for(const j of all)j.close();});return {database,open};
}
test('SQLite journal persists snapshots and rejects stale or skipped CAS revisions across connections',t=>{
  const f=fixture(t),a=f.open(),b=f.open();assert.equal(a.load(),null);
  assert.equal(a.commit(snapshot(),0),true);assert.equal(b.commit(snapshot(1,{label:'loser'}),0),false);
  assert.throws(()=>a.commit(snapshot(3),1),{code:'JOURNAL_REVISION_MISMATCH'});
  assert.equal(b.commit(snapshot(2,{label:'winner'}),1),true);assert.equal(a.load().label,'winner');
  a.close();assert.equal(f.open().load().revision,2);
});
test('SQLite journal isolates Agent owners and host/adapter channels',t=>{
  const f=fixture(t),a=f.open(),b=f.open({agentId:'agent-b'}),host=f.open({channel:'host'});
  a.commit(snapshot(),0);assert.equal(b.load(),null);assert.equal(host.load(),null);
  assert.throws(()=>b.commit(snapshot(),0),{code:'JOURNAL_OWNER_MISMATCH'});
  assert.equal(host.commit(snapshot(1,{label:'host'}),0),true);a.close();assert.equal(host.load().label,'host');
});
for(const point of ['before-write','before-commit'])test('SQLite journal rolls back injected '+point+' failure without reporting success',t=>{
  const f=fixture(t);let armed=false;const a=f.open({fault:stage=>{if(armed&&stage===point)throw Error('synthetic storage fault');}});
  a.commit(snapshot(),0);armed=true;assert.throws(()=>a.commit(snapshot(2,{label:'uncommitted'}),1));assert.equal(a.load().revision,1);
  assert.equal(f.open().commit(snapshot(2,{label:'recovery'}),1),true);
});
test('SQLite journal lost commit acknowledgement is durable and cannot be blindly retried',t=>{
  const f=fixture(t),a=f.open({fault:stage=>{if(stage==='after-commit')throw Error('synthetic lost ack');}});
  assert.throws(()=>a.commit(snapshot(),0));const reopened=f.open();assert.equal(reopened.load().revision,1);assert.equal(reopened.commit(snapshot(),0),false);
});
test('SQLite journal refuses foreign WorkStore databases and future store schemas',t=>{
  const f=fixture(t);let db=new DatabaseSync(f.database);db.exec('CREATE TABLE work_meta(key TEXT);');db.close();assert.throws(()=>f.open(),{code:'JOURNAL_DATABASE_NOT_OWNED'});
  const g=fixture(t);g.open().close();db=new DatabaseSync(g.database);db.exec("UPDATE journal_meta SET value='2' WHERE key='schema'");db.close();assert.throws(()=>g.open(),{code:'JOURNAL_SCHEMA_UNSUPPORTED'});
});
test('SQLite journal rejects snapshot version/owner, corrupt data and oversized snapshots',t=>{
  const f=fixture(t),a=f.open();assert.throws(()=>a.commit(snapshot(1,{schemaVersion:2}),0),{code:'JOURNAL_SNAPSHOT_VERSION_UNSUPPORTED'});
  assert.throws(()=>a.commit(snapshot(1,{owner:{...owner,agentId:'foreign'}}),0),{code:'JOURNAL_OWNER_MISMATCH'});
  assert.throws(()=>a.commit(snapshot(1,{text:'x'.repeat(16*1024*1024)}),0),{code:'JOURNAL_CAPACITY'});
  a.commit(snapshot(),0);const db=new DatabaseSync(f.database);db.exec("UPDATE journal_snapshots SET snapshot='{}'");db.close();assert.throws(()=>a.load(),{code:'JOURNAL_CORRUPT'});
});
test('SQLite journal rejects a future snapshot even when its checksum is valid',t=>{
  const f=fixture(t),a=f.open();a.commit(snapshot(),0);const text=JSON.stringify(snapshot(1,{schemaVersion:2})),db=new DatabaseSync(f.database);
  db.prepare('UPDATE journal_snapshots SET snapshot=?,checksum=?').run(text,digest(text));db.close();assert.throws(()=>a.load(),{code:'JOURNAL_SNAPSHOT_VERSION_UNSUPPORTED'});
});
test('SQLite journal atomic absent-row CAS has exactly one winner in independent Node processes',async t=>{
  const f=fixture(t);f.open();const workers=[];
  function launch(label){
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/journal-cas-worker.mjs',import.meta.url)),f.database,'race',label],{windowsHide:true,stdio:['pipe','pipe','pipe']});workers.push(child);
    let output='',errors='',resolveReady;const ready=new Promise(r=>resolveReady=r);
    const done=new Promise((resolve,reject)=>{
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('ready\n'))resolveReady();});child.stderr.on('data',chunk=>errors+=chunk);
      child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(output.trim().split('\n').at(-1))):reject(Error(errors)));
    });return {child,ready,done};
  }
  t.after(()=>workers.forEach(w=>{if(w.exitCode===null)w.kill();}));
  const a=launch('a'),b=launch('b');await Promise.all([a.ready,b.ready]);a.child.stdin.end('go');b.child.stdin.end('go');
  const results=await Promise.all([a.done,b.done]);assert.deepEqual(results.map(x=>x.won).sort(),[false,true]);
  assert.equal(f.open({channel:'race'}).load().label,results.find(x=>x.won).label);
});
