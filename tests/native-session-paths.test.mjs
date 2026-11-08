import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {relocateNativeSessionPaths} from '../packages/host-control/native-session-paths.mjs';
function fixture(){const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'native-paths-')),home=path.join(root,'home'),sessions=path.join(home,'sessions','2026','10','26');mkdirSync(sessions,{recursive:true});const db=new DatabaseSync(path.join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,cwd TEXT NOT NULL,title TEXT);');return {root,home,sessions,db};}
function add(f,{valid=true}={}){const id=randomUUID(),file=path.join(f.sessions,'rollout-synthetic-'+id+'.jsonl'),bytes=JSON.stringify({type:'session_meta',payload:{id:valid?id:randomUUID(),cwd:'synthetic'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',content:'synthetic retained conversation'}})+'\n';writeFileSync(file,bytes);const old=path.join(f.root,'retired-home','sessions','2026','10','26',path.basename(file));f.db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(id,old,f.root,'retained title');return {id,file,old,bytes};}
test('native history relocates only to copied session files with matching identities and preserves content',()=>{
 const f=fixture(),row=add(f);f.db.close();const result=relocateNativeSessionPaths(f.home);assert.equal(result.checked,1);assert.equal(result.changed,1);const db=new DatabaseSync(path.join(f.home,'state_5.sqlite'));try{const current=db.prepare('SELECT * FROM threads').get();assert.equal(current.rollout_path,row.file);assert.equal(current.title,'retained title');assert.equal(current.cwd,f.root);assert.equal(readFileSync(row.file,'utf8'),row.bytes);}finally{db.close();}assert.equal(relocateNativeSessionPaths(f.home).changed,0);
});
test('a mismatched copied history file rolls back every native index change without following the old path',()=>{
 const f=fixture(),first=add(f),second=add(f,{valid:false});f.db.close();assert.throws(()=>relocateNativeSessionPaths(f.home),/NATIVE_SESSION_FILE_IDENTITY_MISMATCH/);const db=new DatabaseSync(path.join(f.home,'state_5.sqlite'));try{assert.equal(db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(first.id).rollout_path,first.old);assert.equal(db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(second.id).rollout_path,second.old);}finally{db.close();}
});
