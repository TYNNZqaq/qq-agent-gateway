import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { fail } from '../core/management.mjs';

// Separate nonsecret account-control journal. No management/business/login database is opened.
export class AccountControlStore {
  constructor(database,initial) {
    if(database!==':memory:')for(const file of [database,database+'-wal',database+'-shm',database+'-journal'])if(existsSync(file)){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('ACCOUNT_DATABASE_UNSAFE',409);}
    this.db=new DatabaseSync(database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS account_control(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, snapshot TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO account_control VALUES(1,0,?)').run(JSON.stringify(initial));
    this.load();
  }
  load() {
    const row=this.db.prepare('SELECT revision,snapshot FROM account_control WHERE id=1').get();
    if(Buffer.byteLength(row.snapshot)>262144)fail('ACCOUNT_JOURNAL_LIMIT',409);
    const snapshot=JSON.parse(row.snapshot);
    if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.actions))fail('ACCOUNT_SCHEMA_UNSUPPORTED',409);
    return {...snapshot,revision:row.revision};
  }
  assertRevision(expected){if(this.load().revision!==expected)fail('ACCOUNT_CONTROL_STALE',409);}
  commit(value,expected) {
    const {revision,...snapshot}=value,text=JSON.stringify(snapshot);
    if(Buffer.byteLength(text)>262144)fail('ACCOUNT_JOURNAL_LIMIT',409);
    const result=this.db.prepare('UPDATE account_control SET revision=revision+1,snapshot=? WHERE id=1 AND revision=?').run(text,expected);
    if(result.changes!==1)fail('ACCOUNT_CONTROL_STALE',409);
    return expected+1;
  }
  close(){this.db.close();}
}
