import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { fail } from '../core/management.mjs';

// Independent control journal: secret material is stored only as an opaque DPAPI envelope.
export class QQControlStore {
  constructor(database,initial){
    if(database!==':memory:')for(const file of [database,database+'-wal',database+'-shm',database+'-journal'])if(existsSync(file)){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('QQ_CONTROL_FILE_UNSAFE',409);}
    this.db=new DatabaseSync(database);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS qq_control(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,snapshot TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO qq_control VALUES(1,0,?)').run(JSON.stringify(initial));this.load();
  }
  load(){const row=this.db.prepare('SELECT revision,snapshot FROM qq_control WHERE id=1').get();if(Buffer.byteLength(row.snapshot)>262144)fail('QQ_CONTROL_LIMIT',409);const s=JSON.parse(row.snapshot);if(s.schemaVersion!==1||!Array.isArray(s.actions))fail('QQ_CONTROL_SCHEMA_UNSUPPORTED',409);return {...s,revision:row.revision};}
  assertRevision(revision){if(this.load().revision!==revision)fail('QQ_CONTROL_STALE',409);}
  commit(value,expected){const {revision,...s}=value,text=JSON.stringify(s);if(Buffer.byteLength(text)>262144)fail('QQ_CONTROL_LIMIT',409);if(this.db.prepare('UPDATE qq_control SET revision=revision+1,snapshot=? WHERE id=1 AND revision=?').run(text,expected).changes!==1)fail('QQ_CONTROL_STALE',409);return expected+1;}
  close(){this.db.close();}
}
