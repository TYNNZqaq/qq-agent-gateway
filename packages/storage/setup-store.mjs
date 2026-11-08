import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync} from 'node:fs';
import {fail} from '../core/management.mjs';
export class SetupStore{
 constructor(database,identity){
  this.identity=identity;
  if(database!==':memory:')for(const file of [database,database+'-wal',database+'-shm',database+'-journal'])if(existsSync(file)){const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('SETUP_DATABASE_UNSAFE',409);}
  this.db=new DatabaseSync(database);this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS setup_control(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,snapshot TEXT NOT NULL)');
  this.db.prepare('INSERT OR IGNORE INTO setup_control VALUES(1,0,?)').run(JSON.stringify({schemaVersion:1,hostId:identity.hostId,instanceId:identity.instanceId,consent:null,projects:[],actions:[]}));try{this.load();}catch(error){this.db.close();throw error;}
 }
 load(){const r=this.db.prepare('SELECT revision,snapshot FROM setup_control WHERE id=1').get();if(Buffer.byteLength(r.snapshot)>262144)fail('SETUP_STATE_LIMIT',409);const s=JSON.parse(r.snapshot);if(s.schemaVersion!==1||!Array.isArray(s.projects)||!Array.isArray(s.actions))fail('SETUP_SCHEMA_UNSUPPORTED',409);if(s.hostId!==this.identity.hostId||s.instanceId!==this.identity.instanceId)fail('SETUP_INSTANCE_MISMATCH',409);return {...s,revision:r.revision};}
 assertRevision(expected){if(this.load().revision!==expected)fail('SETUP_STALE_REVISION',409);}
 commit(value,expected){const {revision,...s}=value;if(s.hostId!==this.identity.hostId||s.instanceId!==this.identity.instanceId)fail('SETUP_INSTANCE_MISMATCH',409);const text=JSON.stringify(s);if(Buffer.byteLength(text)>262144)fail('SETUP_STATE_LIMIT',409);if(this.db.prepare('UPDATE setup_control SET revision=revision+1,snapshot=? WHERE id=1 AND revision=?').run(text,expected).changes!==1)fail('SETUP_STALE_REVISION',409);return expected+1;}
 close(){this.db.close();}
}
