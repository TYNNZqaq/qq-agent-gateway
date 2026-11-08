import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root,file) => { const rel=path.relative(root,file);return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel); };
const quote = value => '"'+value.replaceAll('"','""')+'"';
function checked(value,{directory=false}={}) {
  if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)===path.parse(value).root)throw Error('MIGRATION_PATH_INVALID');
  for(let p=path.resolve(value);;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('MIGRATION_LINK_FORBIDDEN');if(p===path.dirname(p))break;}
  if(existsSync(value)){const st=lstatSync(value);if(directory?!st.isDirectory():!st.isFile()||st.nlink!==1)throw Error('MIGRATION_FILE_INVALID');}
  return path.resolve(value);
}
const encode = value => JSON.stringify(value,(_key,v)=>typeof v==='bigint'?{bigint:v.toString()}:v instanceof Uint8Array?{bytes:Buffer.from(v).toString('base64')}:v);
export function databaseManifest(db) {
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return tables.map(({name,sql})=>{
    const rows=db.prepare('SELECT * FROM '+quote(name)).all().map(encode).sort();
    return {name,count:rows.length,schemaHash:hash(sql),contentHash:hash(rows.join('\n'))};
  });
}
function relocate(value,source,destination,key='') {
  const pathKeys=new Set(['path','root','cwd','local_path','spool_path','spoolPath','stateDir','directory','exports']);
  if(typeof value==='string'&&pathKeys.has(key)&&path.isAbsolute(value)&&inside(source,value))return path.join(destination,path.relative(source,value));
  if(Array.isArray(value))return value.map(v=>relocate(v,source,destination,key));
  if(value&&Object.getPrototypeOf(value)===Object.prototype)return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,relocate(v,source,destination,k)]));
  return value;
}
export function relocateMetadata(db,source,destination) {
  const changes=[];
  db.exec('BEGIN IMMEDIATE');
  try{
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    for(const [table,column]of [['file_transfers','spool_path'],['received_files','local_path']]){
      if(!tables.has(table)||!db.prepare('PRAGMA table_info('+quote(table)+')').all().some(c=>c.name===column))continue;
      for(const row of db.prepare('SELECT rowid AS migration_row,'+quote(column)+' AS value FROM '+quote(table)).all()){
        if(typeof row.value!=='string'||!path.isAbsolute(row.value)||!inside(source,row.value))continue;
        const target=path.join(destination,path.relative(source,row.value));
        if(!existsSync(target)){
          const fields=db.prepare('PRAGMA table_info('+quote(table)+')').all().map(c=>c.name);
          let released=false;
          if(table==='file_transfers'&&fields.includes('upload_state')&&fields.includes('outbox_id')){
            const transfer=db.prepare('SELECT upload_state,outbox_id FROM file_transfers WHERE rowid=?').get(row.migration_row),outbox=tables.has('outbox')&&db.prepare('SELECT status FROM outbox WHERE id=?').get(transfer.outbox_id);
            released=transfer.upload_state==='released'&&outbox?.status==='sent';
          }
          if(!released)throw Error('MIGRATION_REFERENCED_FILE_MISSING');
        }
        db.prepare('UPDATE '+quote(table)+' SET '+quote(column)+'=? WHERE rowid=?').run(target,row.migration_row);
        changes.push({table,column});
      }
    }
    if(tables.has('settings'))for(const row of db.prepare("SELECT key,value FROM settings WHERE key LIKE 'artifactManifest:%' OR key LIKE 'bridgeTask:%'").all()){
      let parsed;try{parsed=JSON.parse(row.value);}catch{throw Error('MIGRATION_METADATA_INVALID');}
      const value=JSON.stringify(relocate(parsed,source,destination));
      if(value!==row.value){db.prepare('UPDATE settings SET value=? WHERE key=?').run(value,row.key);changes.push({table:'settings',column:'value'});}
    }
    db.exec('COMMIT');return changes;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

// The trusted host resolves the two app-specific directories and verifies the
// old service is stopped. This operation is never exposed to model tools.
export async function migrateBusiness({sourceDirectory,destinationDirectory,sourceInactive,accountHome,binding,executable}) {
  const source=checked(sourceDirectory,{directory:true}),destination=checked(destinationDirectory,{directory:true});
  if(sourceInactive!==true||inside(source,destination)||inside(destination,source))throw Error('MIGRATION_SOURCE_MUST_BE_STOPPED');
  if(existsSync(destination)&&readdirSync(destination).length)throw Error('MIGRATION_DESTINATION_NOT_EMPTY');
  const sourceConfig=checked(path.join(source,'config.local.json')),sourceDb=checked(path.join(source,'state.sqlite')),credential=checked(path.join(source,'qq.secret'));
  if(!existsSync(credential)||!existsSync(sourceDb))throw Error('MIGRATION_SOURCE_INCOMPLETE');
  if(!binding||!['botId','agentId','bindingId'].every(k=>/^[a-f0-9-]{36}$/i.test(binding[k]))||!Number.isSafeInteger(binding.bindingVersion)||binding.bindingVersion<1)throw Error('MIGRATION_BINDING_REQUIRED');
  const config=JSON.parse(readFileSync(sourceConfig,'utf8').replace(/^\uFEFF/,''));
  if(!/^\d{1,30}$/.test(config.qq?.appId)||config.qq.credentialFile!=='qq.secret')throw Error('MIGRATION_BOT_INVALID');
  if(config.integration?.backend!=='app-server')throw Error('MIGRATION_BACKEND_REVIEW_REQUIRED');
  checked(accountHome,{directory:true});checked(executable);
  mkdirSync(destination,{recursive:true});
  const migrationId=randomUUID(),manifest={schemaVersion:1,migrationId,state:'copying',copied:[],metadataChanges:[],startedAt:new Date().toISOString()};
  const reportFile=path.join(destination,'migration.json');
  const save=()=>writeFileSync(reportFile,JSON.stringify(manifest,null,2),{mode:0o600});save();
  let db;
  try{
    db=new DatabaseSync(sourceDb,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');
    for(const table of ['tasks','chat_turns','outbox']){
      const live=db.prepare('SELECT count(*) n FROM '+quote(table)+" WHERE status IN ('queued','running','sending','pending')").get().n;
      if(live)throw Error('MIGRATION_PENDING_WORK_REQUIRES_REVIEW');
    }
    manifest.before=databaseManifest(db);save();
    await backup(db,path.join(destination,'state.sqlite'));
    if(encode(databaseManifest(db))!==encode(manifest.before))throw Error('MIGRATION_SOURCE_CHANGED');
    db.close();db=null;
    let files=0,bytes=0;
    const copy=(relative)=>{
      const from=checked(path.join(source,relative)),to=path.join(destination,relative),st=lstatSync(from);
      if(++files>4096||(bytes+=st.size)>512*1024*1024)throw Error('MIGRATION_COPY_LIMIT');
      mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);
      const digest=hash(readFileSync(from));if(hash(readFileSync(to))!==digest)throw Error('MIGRATION_COPY_MISMATCH');
      manifest.copied.push({file:relative,bytes:st.size,sha256:digest});
    };
    const walk=relative=>{checked(path.join(source,relative),{directory:true});mkdirSync(path.join(destination,relative),{recursive:true});for(const item of readdirSync(path.join(source,relative),{withFileTypes:true})){if(item.isSymbolicLink())throw Error('MIGRATION_LINK_FORBIDDEN');const next=path.join(relative,item.name);if(item.isDirectory())walk(next);else if(item.isFile())copy(next);else throw Error('MIGRATION_FILE_INVALID');}};
    copy('qq.secret');
    for(const dir of ['artifact-spool','received','runs','chat-runs'])if(existsSync(path.join(source,dir)))walk(dir);
    db=new DatabaseSync(path.join(destination,'state.sqlite'));
    manifest.copiedDatabase=databaseManifest(db);
    if(encode(manifest.copiedDatabase)!==encode(manifest.before))throw Error('MIGRATION_DATABASE_MISMATCH');
    manifest.metadataChanges=relocateMetadata(db,source,destination);
    manifest.after=databaseManifest(db);
    const changed=new Set(manifest.metadataChanges.map(c=>c.table));
    if(manifest.before.some((t,i)=>t.count!==manifest.after[i].count||t.schemaHash!==manifest.after[i].schemaHash||!changed.has(t.name)&&t.contentHash!==manifest.after[i].contentHash))throw Error('MIGRATION_CONTENT_MISMATCH');
    db.close();db=null;
    config.schemaVersion=3;config.policyVersion=3;config.stateDir=destination;config.accountHome=realpathSync(accountHome);config.binding={...binding};
    config.executor.binary=realpathSync(executable);config.executor.enabled=false;
    config.fileReceive={...config.fileReceive,directory:path.join(destination,'received')};mkdirSync(config.fileReceive.directory,{recursive:true});
    config.integration={backend:'app-server'};for(const k of ['desktop','desktopTasks','desktopNotifications','desktopApprovals','desktopQuestions'])config[k]={enabled:false};
    config.migration={id:migrationId,sourceDirectory:source,sourceConfigHash:hash(readFileSync(sourceConfig)),originalInstanceId:config.instanceId};
    writeFileSync(path.join(destination,'config.local.json'),JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
    manifest.state='preserved';manifest.finishedAt=new Date().toISOString();save();
    return {migrationId,botPreserved:true,tables:manifest.after.map(t=>({name:t.name,count:t.count})),copiedFiles:files,metadataChanges:manifest.metadataChanges.length,executionEnabled:false};
  }catch(error){if(db)db.close();manifest.state='incomplete';manifest.error=/^[A-Z_]+$/.test(error.message)?error.message:'MIGRATION_FAILED';save();throw error;}
}
