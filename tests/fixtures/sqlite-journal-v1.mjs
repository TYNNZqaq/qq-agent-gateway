import { DatabaseSync } from 'node:sqlite';
import { digest, identifier, integer, object, reject } from '../../packages/core/contracts.mjs';

// A trusted local snapshot store. Each channel has a separate owner and CAS
// sequence. It neither opens WorkStore nor imports an Adapter or transport.
export class SqliteJournal {
  #db; #owner; #channel; #fault; #closed=false;
  constructor(database,{hostId,agentId,channel,fault=()=>{}}){
    this.#owner={hostId:identifier(hostId),agentId:identifier(agentId)};
    this.#channel=identifier(channel);this.#fault=fault;
    this.#db=new DatabaseSync(database);
    try{
      this.#db.exec('PRAGMA busy_timeout=5000;');
      this.#transaction(()=>{
        const tables=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
        if(tables.length&&(!tables.includes('journal_meta')||!tables.includes('journal_snapshots')||tables.some(x=>!['journal_meta','journal_snapshots'].includes(x))))reject('JOURNAL_DATABASE_NOT_OWNED');
        if(tables.length){
          if(this.#db.prepare("SELECT value FROM journal_meta WHERE key='schema'").get()?.value!=='1')reject('JOURNAL_SCHEMA_UNSUPPORTED');
        }else{
          this.#db.exec(`CREATE TABLE journal_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO journal_meta VALUES('schema','1');
            CREATE TABLE journal_snapshots(host_id TEXT NOT NULL,agent_id TEXT NOT NULL,channel TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),snapshot TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(host_id,agent_id,channel));`);
        }
      });
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    }catch(error){this.#db.close();throw error;}
  }
  #transaction(work){
    this.#db.exec('BEGIN IMMEDIATE');
    try{const result=work();this.#db.exec('COMMIT');return result;}
    catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  #available(){if(this.#closed)reject('JOURNAL_CLOSED');}
  #validate(value){
    if(!value||value.schemaVersion!==1)reject('JOURNAL_SNAPSHOT_VERSION_UNSUPPORTED');
    integer(value.revision,0);object(value.owner,['hostId','agentId']);
    if(value.owner.hostId!==this.#owner.hostId||value.owner.agentId!==this.#owner.agentId)reject('JOURNAL_OWNER_MISMATCH');
  }
  load(){
    this.#available();
    const row=this.#db.prepare('SELECT * FROM journal_snapshots WHERE host_id=? AND agent_id=? AND channel=?').get(this.#owner.hostId,this.#owner.agentId,this.#channel);
    if(!row)return null;
    if(digest(row.snapshot)!==row.checksum)reject('JOURNAL_CORRUPT');
    let value;try{value=JSON.parse(row.snapshot);}catch{reject('JOURNAL_CORRUPT');}
    this.#validate(value);if(value.revision!==row.revision)reject('JOURNAL_CORRUPT');
    return value;
  }
  commit(snapshot,expectedRevision){
    this.#available();integer(expectedRevision,0);this.#validate(snapshot);
    if(snapshot.revision!==expectedRevision+1)reject('JOURNAL_REVISION_MISMATCH');
    const serialized=JSON.stringify(snapshot);
    if(Buffer.byteLength(serialized,'utf8')>16*1024*1024)reject('JOURNAL_CAPACITY');
    const committed=this.#transaction(()=>{
      // Comparison and write share the SQLite writer transaction, including
      // the absent-row case. Independent processes cannot both win revision 0.
      const current=this.load();
      if((current?.revision??0)!==expectedRevision)return false;
      this.#fault('before-write');
      this.#db.prepare(`INSERT INTO journal_snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(host_id,agent_id,channel)
        DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,checksum=excluded.checksum`).run(this.#owner.hostId,this.#owner.agentId,this.#channel,snapshot.revision,serialized,digest(serialized));
      this.#fault('before-commit');return true;
    });
    // A lost local acknowledgement is deliberately distinguishable in tests:
    // commit may be durable although the caller sees an exception. Reopen/CAS
    // decides ownership; callers must never retry a model operation.
    if(committed)this.#fault('after-commit');
    return committed;
  }
  close(){if(!this.#closed){this.#closed=true;this.#db.close();}}
}
