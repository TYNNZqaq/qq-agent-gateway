import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { boundedText, digest, EVENT_STATES, freeze, identifier, normalizeEvent, object, reject, scope, scopeKey, TERMINAL_STATES } from '../core/contracts.mjs';
import { activeBinding, validateConfiguration } from '../core/configuration.mjs';
import { inputLimits, normalizeInput, textBytes } from '../core/input-contracts.mjs';
import { cancellationTarget } from '../core/cancel-contracts.mjs';

// New business schema. No legacy database, management database, credential store
// or application-private files are opened by this module.
export class WorkStore {
  #db; #hostId; #fault; #clock;
  constructor(database,{hostId,fault=()=>{},clock=()=>Date.now(),upgradeBackup=null}) {
    this.#hostId=identifier(hostId);this.#fault=fault;this.#clock=clock;
    this.#db=new DatabaseSync(database);
    const tables=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t=>t.name);
    if(tables.length&&!tables.includes('work_meta')){this.#db.close();reject('DATABASE_NOT_OWNED');}
    const version=tables.length?this.#db.prepare("SELECT value FROM work_meta WHERE key='schema'").get():null;
    if(version&&!['1','2','3'].includes(version.value)){this.#db.close();reject('WORK_SCHEMA_UNSUPPORTED');}
    const host=tables.length?this.#db.prepare("SELECT value FROM work_meta WHERE key='host'").get():null;
    if(host&&host.value!==this.#hostId){this.#db.close();reject('HOST_MISMATCH');}
    if(tables.length&&(!version||!host)){this.#db.close();reject('WORK_METADATA_INVALID');}
    if(version&&version.value!=='3'){
      // Explicit, exclusive, consistent snapshot before any older schema changes.
      // Rollback requires the matching old code AND the complete database.
      if(typeof upgradeBackup!=='string'||!upgradeBackup.trim()){this.#db.close();reject('WORK_SCHEMA_UPGRADE_BACKUP_REQUIRED');}
      try{closeSync(openSync(upgradeBackup,'wx'));this.#db.prepare('VACUUM INTO ?').run(upgradeBackup);}
      catch(error){this.#db.close();throw error;}
    }
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`);
    try{this.#transaction(()=>{this.#db.exec(`
      CREATE TABLE IF NOT EXISTS work_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS binding_heads(bot_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,binding_id TEXT NOT NULL,version INTEGER NOT NULL,project_id TEXT NOT NULL,policy_version INTEGER NOT NULL,identity_digest TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)));
      CREATE UNIQUE INDEX IF NOT EXISTS active_work_agent ON binding_heads(agent_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS work_sessions(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,scope_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES work_sessions(id),scope_key TEXT NOT NULL,bot_id TEXT NOT NULL,number INTEGER NOT NULL CHECK(number>0),kind TEXT NOT NULL CHECK(kind IN('work','chat')),goal TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('queued','held','dispatching','running','waiting_input','waiting_approval','cancelling','reconciling','unknown','succeeded','failed','cancelled')),current_run_id TEXT REFERENCES work_runs(id),created_at TEXT NOT NULL,UNIQUE(bot_id,number),UNIQUE(id,scope_key));
      CREATE TABLE IF NOT EXISTS work_inbox(bot_id TEXT NOT NULL,event_id TEXT NOT NULL,scope_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES work_tasks(id),PRIMARY KEY(bot_id,event_id));
      CREATE TABLE IF NOT EXISTS work_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES work_tasks(id),scope_key TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>0),state TEXT NOT NULL CHECK(state IN('dispatching','running','waiting_input','waiting_approval','cancelling','reconciling','unknown','succeeded','failed','cancelled')),dispatch_key TEXT NOT NULL UNIQUE,external_ref TEXT,last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0),policy_version INTEGER NOT NULL CHECK(policy_version>0),UNIQUE(task_id,attempt),UNIQUE(scope_key,external_ref),FOREIGN KEY(task_id,scope_key) REFERENCES work_tasks(id,scope_key));
      CREATE TABLE IF NOT EXISTS work_events(run_id TEXT NOT NULL REFERENCES work_runs(id),event_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),type TEXT NOT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1),occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,correlation_id TEXT NOT NULL,data_json TEXT NOT NULL,event_digest TEXT NOT NULL,applied INTEGER NOT NULL CHECK(applied IN(0,1)),PRIMARY KEY(run_id,seq),UNIQUE(run_id,event_id));
      CREATE TABLE IF NOT EXISTS work_actions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES work_runs(id),scope_key TEXT NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_outbox(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES work_runs(id),body TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('queued','sending','sent','failed','frozen','unknown')),attempt_token TEXT,receipt_ref TEXT,UNIQUE(run_id));
      CREATE TABLE IF NOT EXISTS work_pairings(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,bot_id TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL CHECK(revoked IN(0,1)));
      CREATE UNIQUE INDEX IF NOT EXISTS active_work_pairing ON work_pairings(scope_key) WHERE revoked=0;
      CREATE TABLE IF NOT EXISTS work_task_authorizations(task_id TEXT PRIMARY KEY REFERENCES work_tasks(id),pairing_id TEXT NOT NULL REFERENCES work_pairings(id));
      CREATE TABLE IF NOT EXISTS work_bot_control(bot_id TEXT PRIMARY KEY,stopped INTEGER NOT NULL CHECK(stopped IN(0,1)),generation INTEGER NOT NULL CHECK(generation>=0));
      CREATE TABLE IF NOT EXISTS work_input_batches(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES work_tasks(id),run_id TEXT NOT NULL REFERENCES work_runs(id),attempt INTEGER NOT NULL CHECK(attempt>0),kind TEXT NOT NULL CHECK(kind IN('work','chat')),operation TEXT NOT NULL CHECK(operation IN('continue','correct','answer')),pairing_id TEXT NOT NULL REFERENCES work_pairings(id),mode TEXT NOT NULL CHECK(mode IN('input','submit')),merge_key TEXT NOT NULL,question_id TEXT,question_seq INTEGER NOT NULL CHECK(question_seq>=0),state TEXT NOT NULL CHECK(state IN('collecting','dispatching','consumed','invalidated','unknown')),reason TEXT,created_at INTEGER NOT NULL,closes_at INTEGER NOT NULL CHECK(closes_at>=created_at),fragment_count INTEGER NOT NULL CHECK(fragment_count>0),byte_count INTEGER NOT NULL CHECK(byte_count>0),max_fragments INTEGER NOT NULL CHECK(max_fragments BETWEEN 1 AND 64),max_bytes INTEGER NOT NULL CHECK(max_bytes BETWEEN 1 AND 65536),attempt_token TEXT,delivery_run_id TEXT REFERENCES work_runs(id),receipt_json TEXT,UNIQUE(id,scope_key),CHECK(fragment_count<=max_fragments),CHECK(byte_count<=max_bytes));
      CREATE INDEX IF NOT EXISTS collecting_work_input ON work_input_batches(scope_key,merge_key,state,closes_at);
      CREATE TABLE IF NOT EXISTS work_inputs(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,event_id TEXT NOT NULL,scope_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES work_tasks(id),run_id TEXT REFERENCES work_runs(id),operation TEXT NOT NULL CHECK(operation IN('new','continue','correct','answer','cancel')),batch_id TEXT REFERENCES work_input_batches(id),text TEXT,input_digest TEXT NOT NULL,result_json TEXT NOT NULL,UNIQUE(bot_id,event_id));
    `);
      for(const [key,value] of [['schema','3'],['host',this.#hostId],['configuration_revision','0'],['stopped','0']])
        this.#db.prepare('INSERT OR IGNORE INTO work_meta VALUES(?,?)').run(key,value);
      if(version?.value==='1'){
        // V1 had no persistent pairing provenance. Preserve history, but never
        // infer permission for its queued work from a later host pairing.
        for(const row of this.#db.prepare('SELECT bot_id FROM binding_heads').all())this.#invalidate(row.bot_id);
        this.#fault('after-v1-authorization-migration');
      }
      if(version&&version.value!=='3'){
        this.#db.prepare("UPDATE work_meta SET value='3' WHERE key='schema'").run();
        this.#fault('after-input-schema-migration');
      }
    });}catch(error){this.#db.close();throw error;}
  }
  close(){this.#db.close();}
  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {const result=work();this.#db.exec('COMMIT');return result;}
    catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  #meta(key){return this.#db.prepare('SELECT value FROM work_meta WHERE key=?').get(key)?.value;}
  #scope(input){const checked=scope(input);if(checked.hostId!==this.#hostId)reject('HOST_MISMATCH');return {value:checked,key:scopeKey(checked)};}
  #active(value){
    const head=this.#db.prepare('SELECT * FROM binding_heads WHERE bot_id=? AND active=1').get(value.botId);
    if(!head||head.agent_id!==value.agentId||head.binding_id!==value.bindingId||head.version!==value.bindingVersion||head.project_id!==value.projectId||head.policy_version!==value.policyVersion)reject('STALE_BINDING_SCOPE');
  }
  #available(botId){
    if(this.#meta('stopped')==='1')reject('HOST_STOPPED');
    if(this.#db.prepare('SELECT stopped FROM work_bot_control WHERE bot_id=?').get(botId)?.stopped)reject('BOT_STOPPED');
  }
  #pairing(s){
    const row=this.#db.prepare('SELECT * FROM work_pairings WHERE scope_key=? AND revoked=0').get(s.key);
    if(!row||row.expires_at<=this.#clock())reject('PAIRING_REQUIRED');
    return row;
  }
  #expirePairing(s){
    const expired=this.#db.prepare('SELECT id FROM work_pairings WHERE scope_key=? AND revoked=0 AND expires_at<=?').get(s.key,this.#clock());
    // Commit expiry before the caller's transaction can fail. An observed
    // deadline must not revive after a restart or a backward wall-clock jump.
    if(expired)this.#transaction(()=>{
      if(this.#db.prepare('SELECT id FROM work_pairings WHERE id=? AND revoked=0 AND expires_at<=?').get(expired.id,this.#clock()))this.#invalidateScope(s.key);
    });
  }
  #taskAuthorization(s,taskId){
    const pairing=this.#pairing(s);
    if(this.#db.prepare('SELECT pairing_id FROM work_task_authorizations WHERE task_id=?').get(taskId)?.pairing_id!==pairing.id)reject('TASK_AUTHORIZATION_REVOKED');
  }
  #invalidateScope(key){
    this.#invalidateInputs('scope_key=?',[key],'pairing_revoked');
    this.#db.prepare('UPDATE work_pairings SET revoked=1 WHERE scope_key=?').run(key);
    this.#db.prepare("UPDATE work_outbox SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'frozen' END WHERE scope_key=? AND state IN('queued','sending')").run(key);
    this.#db.prepare("UPDATE work_runs SET state='unknown' WHERE scope_key=? AND state NOT IN('succeeded','failed','cancelled','unknown')").run(key);
    this.#db.prepare("UPDATE work_tasks SET state=CASE WHEN current_run_id IS NULL THEN 'held' ELSE 'unknown' END WHERE scope_key=? AND state NOT IN('succeeded','failed','cancelled','unknown','held')").run(key);
  }
  // These methods are trusted-host operations; no message body can grant a lease.
  grantPairing(input,{expiresAt}){
    const s=this.#scope(input);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=this.#clock())reject('PAIRING_EXPIRED');
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);this.#invalidateScope(s.key);
      const id=randomUUID();this.#db.prepare('INSERT INTO work_pairings VALUES(?,?,?,?,0)').run(id,s.key,s.value.botId,expiresAt);
      return {id,expiresAt,executionApproved:false};
    });
  }
  revokePairing(input){
    const s=this.#scope(input);
    return this.#transaction(()=>{
      const existed=!!this.#db.prepare('SELECT id FROM work_pairings WHERE scope_key=? AND revoked=0').get(s.key);
      this.#invalidateScope(s.key);return existed;
    });
  }
  requirePairing(input){const s=this.#scope(input);this.#expirePairing(s);this.#active(s.value);this.#available(s.value.botId);const p=this.#pairing(s);return {id:p.id,expiresAt:p.expires_at};}
  transportState(botId){
    identifier(botId);const row=this.#db.prepare('SELECT * FROM work_bot_control WHERE bot_id=?').get(botId);
    return {stopped:!!row?.stopped,hostStopped:this.#meta('stopped')==='1',generation:row?.generation??0};
  }
  nextTransportGeneration(botId){
    identifier(botId);
    return this.#transaction(()=>{
      this.#available(botId);
      if(!this.#db.prepare('SELECT bot_id FROM binding_heads WHERE bot_id=? AND active=1').get(botId))reject('BOT_NOT_BOUND');
      this.#db.prepare('INSERT INTO work_bot_control VALUES(?,0,1) ON CONFLICT(bot_id) DO UPDATE SET generation=generation+1').run(botId);
      return this.transportState(botId).generation;
    });
  }
  stopBot(botId){
    identifier(botId);return this.#transaction(()=>{
      if(!this.#db.prepare('SELECT bot_id FROM binding_heads WHERE bot_id=?').get(botId))reject('BOT_NOT_BOUND');
      this.#invalidate(botId);
      this.#db.prepare('INSERT INTO work_bot_control VALUES(?,1,1) ON CONFLICT(bot_id) DO UPDATE SET stopped=1').run(botId);
      return this.transportState(botId);
    });
  }
  resumeBot(botId){
    identifier(botId);return this.#transaction(()=>{
      if(this.#meta('stopped')==='1')reject('HOST_STOPPED');
      if(!this.#db.prepare('SELECT bot_id FROM binding_heads WHERE bot_id=? AND active=1').get(botId))reject('BOT_NOT_BOUND');
      this.#db.prepare('UPDATE work_bot_control SET stopped=0 WHERE bot_id=?').run(botId);
      return this.transportState(botId);
    });
  }
  #row(table,key,id){
    identifier(id);
    const row=this.#db.prepare(`SELECT * FROM ${table} WHERE scope_key=? AND id=?`).get(key,id);
    if(!row)reject('SCOPED_NOT_FOUND');return {...row};
  }
  #taskState(run,state){this.#db.prepare('UPDATE work_tasks SET state=? WHERE id=? AND current_run_id=?').run(state,run.task_id,run.id);}
  #invalidate(botId){
    this.#invalidateInputs('scope_key IN(SELECT scope_key FROM work_tasks WHERE bot_id=?)',[botId],'bot_invalidated');
    this.#db.prepare('UPDATE work_pairings SET revoked=1 WHERE bot_id=?').run(botId);
    this.#db.prepare('INSERT INTO work_bot_control VALUES(?,0,1) ON CONFLICT(bot_id) DO UPDATE SET generation=generation+1').run(botId);
    this.#db.prepare("UPDATE work_outbox SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'frozen' END WHERE state IN('queued','sending') AND scope_key IN(SELECT scope_key FROM work_tasks WHERE bot_id=?)").run(botId);
    this.#db.prepare("UPDATE work_runs SET state='unknown' WHERE state NOT IN('succeeded','failed','cancelled','unknown') AND scope_key IN(SELECT scope_key FROM work_tasks WHERE bot_id=?)").run(botId);
    this.#db.prepare("UPDATE work_tasks SET state=CASE WHEN current_run_id IS NULL THEN 'held' ELSE 'unknown' END WHERE bot_id=? AND state NOT IN('succeeded','failed','cancelled','unknown','held')").run(botId);
  }
  installConfiguration(input){
    const config=validateConfiguration(input);if(config.hostId!==this.#hostId)reject('HOST_MISMATCH');
    const hash=digest(JSON.stringify(config));
    return this.#transaction(()=>{
      const revision=Number(this.#meta('configuration_revision'));
      if(config.revision===revision&&this.#meta('configuration_digest')===hash)return {revision,reused:true};
      if(config.revision<=revision)reject('STALE_CONFIGURATION');
      const next=new Map();
      for(const binding of config.bindings.filter(b=>b.enabled)){
        const {bot,agent,policy}=activeBinding(config,binding.botId);
        const identity=digest(JSON.stringify({bot,agent,binding,policy,project:config.projects.find(p=>p.id===agent.workspaceRef)}));
        next.set(bot.id,{bot,agent,binding,policy,identity});
      }
      const previous=this.#db.prepare('SELECT * FROM binding_heads').all();
      for(const old of previous){
        const n=next.get(old.bot_id);
        if(n&&(n.identity!==old.identity_digest||!old.active)&&n.binding.version<=old.version)reject('BINDING_VERSION_REQUIRED');
        if(n&&n.binding.version<old.version)reject('BINDING_VERSION_REQUIRED');
        if(old.active&&(!n||n.identity!==old.identity_digest))this.#invalidate(old.bot_id);
      }
      this.#db.exec('UPDATE binding_heads SET active=0');
      for(const {bot,agent,binding,policy,identity} of next.values()){
        this.#db.prepare(`INSERT INTO binding_heads VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(bot_id) DO UPDATE SET agent_id=excluded.agent_id,binding_id=excluded.binding_id,version=excluded.version,project_id=excluded.project_id,policy_version=excluded.policy_version,identity_digest=excluded.identity_digest,active=1`).run(bot.id,agent.id,binding.id,binding.version,agent.workspaceRef,policy.version,identity);
      }
      this.#db.prepare("UPDATE work_meta SET value=? WHERE key='configuration_revision'").run(String(config.revision));
      this.#db.prepare("INSERT INTO work_meta VALUES('configuration_digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash);
      return {revision:config.revision,reused:false};
    });
  }
  acceptInbound(input,event){
    const s=this.#scope(input);object(event,['eventId','kind','text']);boundedText(event.eventId,512);boundedText(event.text);
    if(!['work','chat'].includes(event.kind))reject('INVALID_TASK_KIND');
    this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);const pairing=this.#pairing(s);
      return this.#insertInbound(s,event,pairing);
    });
  }
  #insertInbound(s,event,pairing){
      const prior=this.#db.prepare('SELECT * FROM work_inbox WHERE bot_id=? AND event_id=?').get(s.value.botId,event.eventId);
      if(prior)return prior.scope_key===s.key?{duplicate:true,taskId:prior.task_id}:{duplicate:true,stale:true,taskId:null};
      let session=this.#db.prepare('SELECT id FROM work_sessions WHERE scope_key=?').get(s.key);
      if(!session){session={id:randomUUID()};this.#db.prepare('INSERT INTO work_sessions VALUES(?,?,?)').run(session.id,s.key,JSON.stringify(s.value));}
      const taskId=randomUUID(),number=this.#db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM work_tasks WHERE bot_id=?').get(s.value.botId).n;
      this.#db.prepare("INSERT INTO work_tasks VALUES(?,?,?,?,?,?,?,'queued',NULL,?)").run(taskId,session.id,s.key,s.value.botId,number,event.kind,event.text,new Date().toISOString());
      this.#db.prepare('INSERT INTO work_task_authorizations VALUES(?,?)').run(taskId,pairing.id);
      this.#fault('after-task-before-inbox');
      this.#db.prepare('INSERT INTO work_inbox VALUES(?,?,?,?)').run(s.value.botId,event.eventId,s.key,taskId);
      return {duplicate:false,taskId,sessionId:session.id,number};
  }
  #invalidateInputs(where,parameters,reason){
    this.#db.prepare(`UPDATE work_input_batches SET state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'invalidated' END,reason=? WHERE (${where}) AND state IN('collecting','dispatching')`).run(reason,...parameters);
  }
  #question(s,runId,questionId,questionSeq){
    const row=this.#db.prepare("SELECT seq,data_json FROM work_events WHERE run_id=? AND applied=1 AND type='run.waiting_input' ORDER BY seq DESC LIMIT 1").get(runId);
    if(!row||row.seq!==questionSeq||JSON.parse(row.data_json).questionId!==questionId)reject('STALE_INPUT_QUESTION');
  }
  #inputTarget(s,batch,claimed=false){
    this.#active(s.value);this.#available(s.value.botId);this.#taskAuthorization(s,batch.task_id);
    if(this.#pairing(s).id!==batch.pairing_id)reject('TASK_AUTHORIZATION_REVOKED');
    const task=this.#row('work_tasks',s.key,batch.task_id);
    const target=claimed?batch.delivery_run_id:batch.run_id;
    if(task.current_run_id!==target)reject('STALE_INPUT_RUN');
    if(task.kind!==batch.kind)reject('INPUT_KIND_MISMATCH');
    const run=this.#row('work_runs',s.key,target);
    if(run.task_id!==task.id||run.attempt!==batch.attempt+(claimed&&batch.mode==='submit'?1:0))reject('STALE_INPUT_RUN');
    if(batch.mode==='submit'){
      if(claimed?(run.state!=='dispatching'||!!run.external_ref):!TERMINAL_STATES.includes(run.state))reject('STALE_INPUT_RUN');
    }else if(batch.operation==='answer'){
      if(run.state!=='waiting_input')reject('NOT_WAITING_FOR_ORDINARY_INPUT');
      this.#question(s,run.id,batch.question_id,batch.question_seq);
    }else if(run.state!=='running')reject('INPUT_RUN_NOT_RUNNING');
    return {task,run};
  }
  #failInput(batch,error){
    if(error.name!=='CoreError')throw error;
    this.#db.prepare("UPDATE work_input_batches SET state=?,reason=? WHERE id=?").run(batch.state==='dispatching'?'unknown':'invalidated',error.code,batch.id);
    if(batch.state==='dispatching')this.#unknownInputSubmission(batch);
  }
  #unknownInputSubmission(batch){
    if(batch.mode!=='submit'||!batch.delivery_run_id)return;
    const run=this.#row('work_runs',batch.scope_key,batch.delivery_run_id);
    if(run.state==='dispatching'){
      this.#db.prepare("UPDATE work_runs SET state='unknown' WHERE id=?").run(run.id);this.#taskState(run,'unknown');
    }
  }
  #refreshInputs(s,runId){
    const rows=this.#db.prepare("SELECT * FROM work_input_batches WHERE scope_key=? AND (run_id=? OR delivery_run_id=?) AND state IN('collecting','dispatching')").all(s.key,runId,runId);
    for(const batch of rows)try{this.#inputTarget(s,batch,batch.state==='dispatching');}catch(error){this.#failInput(batch,error);}
  }
  #inputResult(s,id){
    const row=this.#row('work_input_batches',s.key,id);
    return {batchId:row.id,inputKey:'input-'+row.id,taskId:row.task_id,runId:row.run_id,deliveryRunId:row.delivery_run_id,operation:row.operation,state:row.state,reason:row.reason,closesAt:row.closes_at,fragmentCount:row.fragment_count,byteCount:row.byte_count,attemptToken:row.attempt_token,receipt:row.receipt_json?JSON.parse(row.receipt_json):null,executionApproved:false};
  }
  inputBatch(input,id){const s=this.#scope(input);return this.#inputResult(s,id);}
  inputRecord(input,eventId){
    const s=this.#scope(input);boundedText(eventId,512);
    const row=this.#db.prepare('SELECT * FROM work_inputs WHERE scope_key=? AND bot_id=? AND event_id=?').get(s.key,s.value.botId,eventId);
    if(!row)reject('SCOPED_NOT_FOUND');
    return {...row,result:JSON.parse(row.result_json),batch:row.batch_id?this.#inputResult(s,row.batch_id):null};
  }
  #inputCapacity(s,limits){
    const batches=this.#db.prepare("SELECT b.scope_key,t.bot_id FROM work_input_batches b JOIN work_tasks t ON t.id=b.task_id WHERE b.state IN('collecting','dispatching','unknown')").all();
    const queued=this.#db.prepare("SELECT scope_key,bot_id FROM work_tasks WHERE state='queued'").all();
    const pending=[...batches,...queued];
    if(pending.length>=limits.maxPending||pending.filter(x=>x.bot_id===s.value.botId).length>=limits.maxPendingPerBot||pending.filter(x=>x.scope_key===s.key).length>=limits.maxPendingPerScope)reject('INPUT_QUEUE_FULL');
  }
  queueInput(input,value,options={}){
    const s=this.#scope(input),command=normalizeInput(value),limits=inputLimits(options),hash=digest(JSON.stringify(command));
    this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);const pairing=this.#pairing(s);
      const prior=this.#db.prepare('SELECT * FROM work_inbox WHERE bot_id=? AND event_id=?').get(s.value.botId,command.eventId);
      if(prior){
        if(prior.scope_key!==s.key)return {duplicate:true,stale:true,taskId:null};
        const receipt=this.#db.prepare('SELECT * FROM work_inputs WHERE bot_id=? AND event_id=?').get(s.value.botId,command.eventId);
        if(!receipt)return {duplicate:true,taskId:prior.task_id};
        if(receipt.input_digest!==hash)reject('INPUT_EVENT_CONFLICT');
        return {...JSON.parse(receipt.result_json),...(receipt.batch_id?this.#inputResult(s,receipt.batch_id):{}),duplicate:true};
      }
      let result,batchId=null;
      if(command.operation==='new'){
        this.#inputCapacity(s,limits);
        result={...this.#insertInbound(s,{eventId:command.eventId,kind:command.kind,text:command.text},pairing),operation:'new',state:'queued',executionApproved:false};
      }else{
        const task=this.#row('work_tasks',s.key,command.taskId),run=this.#row('work_runs',s.key,command.runId);
        this.#taskAuthorization(s,task.id);
        if(task.current_run_id!==run.id||run.task_id!==task.id||run.attempt!==command.attempt)reject('STALE_INPUT_RUN');
        if(task.kind!==command.kind)reject('INPUT_KIND_MISMATCH');
        if(command.operation==='cancel'){
          result={...this.#cancelRun(s,run),taskId:task.id,runId:run.id,operation:'cancel',executionApproved:false};
        }else{
          const now=this.#clock();if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+limits.windowMs))reject('INVALID_INPUT_CLOCK');
          const mode=command.operation==='continue'&&TERMINAL_STATES.includes(run.state)?'submit':'input';
          const target={task_id:task.id,run_id:run.id,attempt:run.attempt,kind:task.kind,operation:command.operation,pairing_id:pairing.id,mode,question_id:command.questionId??null,question_seq:command.questionSeq??0};
          this.#inputTarget(s,target);
          const mergeKey=digest(JSON.stringify([s.key,task.id,run.id,run.attempt,task.kind,command.operation,pairing.id,mode,target.question_id,target.question_seq]));
          const current=this.#db.prepare("SELECT * FROM work_input_batches WHERE scope_key=? AND merge_key=? AND state='collecting' AND created_at<=? AND closes_at>? ORDER BY rowid DESC LIMIT 1").get(s.key,mergeKey,now,now);
          const bytes=textBytes(command.text)+(current?1:0);
          if(current){
            if(current.fragment_count>=Math.min(current.max_fragments,limits.maxFragments)||current.byte_count+bytes>Math.min(current.max_bytes,limits.maxBytes))reject('INPUT_BATCH_FULL');
            batchId=current.id;
            this.#db.prepare('UPDATE work_input_batches SET fragment_count=fragment_count+1,byte_count=byte_count+? WHERE id=?').run(bytes,batchId);
          }else{
            this.#inputCapacity(s,limits);if(bytes>limits.maxBytes)reject('INPUT_BATCH_FULL');
            batchId=randomUUID();
            this.#db.prepare("INSERT INTO work_input_batches(id,scope_key,task_id,run_id,attempt,kind,operation,pairing_id,mode,merge_key,question_id,question_seq,state,created_at,closes_at,fragment_count,byte_count,max_fragments,max_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'collecting',?,?,1,?,?,?)").run(batchId,s.key,task.id,run.id,run.attempt,task.kind,command.operation,pairing.id,mode,mergeKey,target.question_id,target.question_seq,now,now+limits.windowMs,bytes,limits.maxFragments,limits.maxBytes);
          }
          result={duplicate:false,...this.#inputResult(s,batchId)};
        }
      }
      this.#db.prepare('INSERT INTO work_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),s.value.botId,command.eventId,s.key,result.taskId,command.runId??null,command.operation,batchId,command.text??null,hash,JSON.stringify(result));
      this.#fault('after-input-before-inbox');
      if(command.operation!=='new')this.#db.prepare('INSERT INTO work_inbox VALUES(?,?,?,?)').run(s.value.botId,command.eventId,s.key,command.taskId);
      return result;
    });
  }
  #insertRun(s,task,dispatchKey){
    if(this.#db.prepare('SELECT id FROM work_runs WHERE dispatch_key=?').get(dispatchKey))reject('DISPATCH_KEY_REUSED');
    const attempt=this.#db.prepare('SELECT COALESCE(MAX(attempt),0)+1 n FROM work_runs WHERE task_id=?').get(task.id).n;
    const id=randomUUID();this.#db.prepare("INSERT INTO work_runs VALUES(?,?,?,?,'dispatching',?,NULL,0,?)").run(id,task.id,s.key,attempt,dispatchKey,s.value.policyVersion);
    this.#db.prepare("UPDATE work_tasks SET state='dispatching',current_run_id=? WHERE id=?").run(id,task.id);
    return this.run(s.value,id);
  }
  #inputRequest(s,batch){
    if(!batch.attempt_token||!batch.delivery_run_id)reject('INPUT_ATTEMPT_REQUIRED');
    const run=this.#row('work_runs',s.key,batch.delivery_run_id);
    const fragments=this.#db.prepare('SELECT event_id AS eventId,text FROM work_inputs WHERE batch_id=? ORDER BY rowid').all(batch.id).map(x=>({...x}));
    // A submit claim originally had no external reference. Reconstruct the
    // original request even after completeInput has recorded its new reference.
    return freeze({schemaVersion:1,inputKey:'input-'+batch.id,batchId:batch.id,attemptToken:batch.attempt_token,scope:s.value,taskId:batch.task_id,runId:run.id,baseRunId:batch.run_id,attempt:run.attempt,kind:batch.kind,operation:batch.operation,mode:batch.mode,externalRef:batch.mode==='submit'?null:run.external_ref,questionId:batch.question_id,questionSeq:batch.question_seq,fragments,text:fragments.map(x=>x.text).join('\n'),executionApproved:false});
  }
  inputAttempt(input,id,token){
    const s=this.#scope(input);identifier(token);const batch=this.#row('work_input_batches',s.key,id);
    if(batch.attempt_token!==token)reject('INPUT_ATTEMPT_MISMATCH');
    // Audit only. Reading an old/unknown/consumed attempt grants no dispatch.
    return freeze({request:this.#inputRequest(s,batch),leaseId:batch.pairing_id});
  }
  inputDispatchContext(input,id,token){
    const s=this.#scope(input);identifier(token);this.#expirePairing(s);
    return this.#transaction(()=>{
      const batch=this.#row('work_input_batches',s.key,id);
      if(batch.attempt_token!==token)reject('INPUT_ATTEMPT_MISMATCH');
      if(batch.state!=='dispatching')reject('INPUT_REQUIRES_RECONCILIATION');
      const {task,run}=this.#inputTarget(s,batch,true);
      const bindingIdentity=this.#db.prepare('SELECT identity_digest FROM binding_heads WHERE bot_id=?').get(s.value.botId).identity_digest;
      return freeze({request:this.#inputRequest(s,batch),leaseId:batch.pairing_id,task,run,session:this.session(s.value),bindingIdentity});
    });
  }
  claimInput(input,id){
    const s=this.#scope(input);this.#expirePairing(s);
    return this.#transaction(()=>{
      let batch=this.#row('work_input_batches',s.key,id);
      if(batch.state!=='collecting')return this.#inputResult(s,id);
      try{this.#inputTarget(s,batch);}catch(error){this.#failInput(batch,error);return this.#inputResult(s,id);}
      if(this.#clock()<batch.closes_at)return this.#inputResult(s,id);
      const ordinal=this.#db.prepare('SELECT rowid FROM work_input_batches WHERE id=?').get(id).rowid;
      if(this.#db.prepare("SELECT id FROM work_input_batches WHERE scope_key=? AND rowid<? AND state IN('collecting','dispatching','unknown') LIMIT 1").get(s.key,ordinal))reject('INPUT_ORDER_BLOCKED');
      let deliveryRunId=batch.run_id;
      if(batch.mode==='submit'){
        deliveryRunId=this.#insertRun(s,this.#row('work_tasks',s.key,batch.task_id),'input-'+id).id;
        this.#invalidateInputs('task_id=? AND id<>?',[batch.task_id,id],'run_changed');
      }
      const token=randomUUID();
      this.#db.prepare("UPDATE work_input_batches SET state='dispatching',attempt_token=?,delivery_run_id=? WHERE id=?").run(token,deliveryRunId,id);
      this.#fault('after-input-claim');
      batch=this.#row('work_input_batches',s.key,id);
      return {...this.#inputResult(s,id),request:this.#inputRequest(s,batch)};
    });
  }
  authorizeInputDispatch(input,id,token){
    const s=this.#scope(input);identifier(token);this.#expirePairing(s);
    return this.#transaction(()=>{
      const batch=this.#row('work_input_batches',s.key,id);
      if(batch.attempt_token!==token)reject('INPUT_ATTEMPT_MISMATCH');
      if(batch.state!=='dispatching')return {...this.#inputResult(s,id),authorized:false};
      try{this.#inputTarget(s,batch,true);}catch(error){this.#failInput(batch,error);return {...this.#inputResult(s,id),authorized:false};}
      return {authorized:true};
    });
  }
  completeInput(input,id,report){
    object(report,['attemptToken','receiptRef','externalRef']);identifier(report.attemptToken);boundedText(report.receiptRef,512);
    if(report.externalRef!==undefined&&report.externalRef!==null)boundedText(report.externalRef,512);
    const s=this.#scope(input);this.#expirePairing(s);
    return this.#transaction(()=>{
      const batch=this.#row('work_input_batches',s.key,id);
      if(batch.attempt_token!==report.attemptToken)reject('INPUT_ATTEMPT_MISMATCH');
      if(batch.state==='consumed')reject('INPUT_REQUIRES_RECONCILIATION');
      if(batch.receipt_json&&batch.receipt_json!==JSON.stringify(report))reject('INPUT_RECEIPT_CONFLICT');
      // A late receipt remains available for explicit reconciliation. It does
      // not revive the Run, its question, pairing, or execution approval.
      this.#db.prepare('UPDATE work_input_batches SET receipt_json=? WHERE id=?').run(JSON.stringify(report),id);
      if(batch.state!=='dispatching')return this.#inputResult(s,id);
      let run;
      try{
        ({run}=this.#inputTarget(s,batch,true));
        if(batch.mode==='submit'){
          if(!report.externalRef)reject('EXTERNAL_REFERENCE_REQUIRED');
          if(this.#db.prepare('SELECT id FROM work_runs WHERE scope_key=? AND external_ref=?').get(s.key,report.externalRef))reject('EXTERNAL_REFERENCE_REUSED');
        }else if(report.externalRef!==undefined&&report.externalRef!==run.external_ref)reject('EXTERNAL_REFERENCE_MISMATCH');
      }catch(error){this.#failInput(batch,error);return this.#inputResult(s,id);}
      if(batch.mode==='submit'){
        this.#db.prepare("UPDATE work_runs SET state='running',external_ref=? WHERE id=?").run(report.externalRef,run.id);this.#taskState(run,'running');
      }else if(batch.operation==='answer'){
        this.#db.prepare("UPDATE work_runs SET state='running' WHERE id=?").run(run.id);this.#taskState(run,'running');
      }
      this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(randomUUID(),run.id,s.key,'coordinated_input',JSON.stringify({batchId:id,operation:batch.operation,questionId:batch.question_id,questionSeq:batch.question_seq,executionApproved:false}));
      this.#db.prepare("UPDATE work_input_batches SET state='consumed',reason=NULL WHERE id=?").run(id);
      this.#fault('before-input-completion-commit');
      return this.#inputResult(s,id);
    });
  }
  markInputUnknown(input,id,token){
    const s=this.#scope(input);identifier(token);
    return this.#transaction(()=>{
      const batch=this.#row('work_input_batches',s.key,id);if(batch.attempt_token!==token)reject('INPUT_ATTEMPT_MISMATCH');
      this.#db.prepare("UPDATE work_input_batches SET state='unknown',reason='dispatch_unconfirmed' WHERE id=? AND state='dispatching'").run(id);
      if(batch.state==='dispatching')this.#unknownInputSubmission(batch);
      return this.#inputResult(s,id);
    });
  }
  reconcileInput(input,id,report){
    const s=this.#scope(input);object(report,['state','inputKey','receiptRef']);
    if(!['unknown','consumed','invalidated'].includes(report.state)||report.inputKey!=='input-'+id)reject('INPUT_RECONCILIATION_MISMATCH');
    if(report.receiptRef!==null)boundedText(report.receiptRef,512);
    if(report.state==='consumed'&&!report.receiptRef)reject('RECEIPT_REQUIRED');
    return this.#transaction(()=>{
      const batch=this.#row('work_input_batches',s.key,id);if(batch.state!=='unknown')reject('INPUT_REQUIRES_RECONCILIATION');
      this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(randomUUID(),batch.delivery_run_id??batch.run_id,s.key,'input_reconciliation',JSON.stringify({batchId:id,previousReceipt:batch.receipt_json?JSON.parse(batch.receipt_json):null,report,executionApproved:false}));
      this.#db.prepare("UPDATE work_input_batches SET state=?,receipt_json=?,reason='host_reconciled' WHERE id=?").run(report.state,JSON.stringify(report),id);
      return this.#inputResult(s,id);
    });
  }
  task(input,id){return this.#row('work_tasks',this.#scope(input).key,id);}
  run(input,id){return this.#row('work_runs',this.#scope(input).key,id);}
  session(input){const s=this.#scope(input);const row=this.#db.prepare('SELECT * FROM work_sessions WHERE scope_key=?').get(s.key);if(!row)reject('SCOPED_NOT_FOUND');return {...row};}
  // Synchronous trusted-host check, reusable at the Adapter's actual accept
  // boundary. It returns the ORIGINAL Task lease, never a replacement pairing.
  dispatchContext(input,taskId,runId=null){
    const s=this.#scope(input);identifier(taskId);if(runId!==null)identifier(runId);this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);
      const task=this.#row('work_tasks',s.key,taskId),run=runId===null?null:this.#row('work_runs',s.key,runId);
      this.#taskAuthorization(s,taskId);
      if(run&&(run.task_id!==taskId||task.current_run_id!==runId))reject('DISPATCH_RUN_MISMATCH');
      const bindingIdentity=this.#db.prepare('SELECT identity_digest FROM binding_heads WHERE bot_id=?').get(s.value.botId).identity_digest;
      return freeze({task,run,leaseId:this.#pairing(s).id,session:this.session(s.value),bindingIdentity});
    });
  }
  // Observation is scoped to an EXISTING exact Run and its ORIGINAL lease.
  // Reading revoked/old work is permitted for audit; active=false confers no
  // execution permission and never restores a pairing or current Task Run.
  eventContext(input,taskId,runId){
    const s=this.#scope(input);identifier(taskId);identifier(runId);this.#expirePairing(s);
    return this.#transaction(()=>{
      const task=this.#row('work_tasks',s.key,taskId),run=this.#row('work_runs',s.key,runId);
      if(run.task_id!==taskId)reject('EVENT_RUN_MISMATCH');
      const leaseId=this.#db.prepare('SELECT pairing_id FROM work_task_authorizations WHERE task_id=?').get(taskId)?.pairing_id;
      if(!leaseId)reject('EVENT_ORIGINAL_LEASE_REQUIRED');
      const bindingIdentity=this.#db.prepare('SELECT identity_digest FROM binding_heads WHERE bot_id=?').get(s.value.botId)?.identity_digest??null;
      let active=true;try{this.#active(s.value);this.#available(s.value.botId);this.#taskAuthorization(s,taskId);}catch{active=false;}
      return freeze({task,run,leaseId,session:this.session(s.value),bindingIdentity,active});
    });
  }
  markDispatchUnknown(input,runId,dispatchKey){
    const s=this.#scope(input);identifier(dispatchKey);
    return this.#transaction(()=>{
      const run=this.#row('work_runs',s.key,runId);
      if(run.dispatch_key!==dispatchKey)reject('DISPATCH_KEY_MISMATCH');
      // Preserve questions, approval and cancellation intent. This narrow
      // recovery interface never clears input records or touches another Run.
      if(['dispatching','running'].includes(run.state)){
        this.#db.prepare("UPDATE work_runs SET state='unknown' WHERE id=?").run(runId);this.#taskState(run,'unknown');
      }
      return this.run(s.value,runId);
    });
  }
  beginRun(input,taskId,{dispatchKey,retry=false}={}){
    const s=this.#scope(input);identifier(dispatchKey);if(typeof retry!=='boolean')reject('INVALID_RETRY');
    this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);
      const task=this.#row('work_tasks',s.key,taskId);
      this.#taskAuthorization(s,taskId);
      if(task.state!=='queued'&&!(retry&&['failed','cancelled'].includes(task.state)))reject('RUN_REQUIRES_RECONCILIATION');
      const run=this.#insertRun(s,task,dispatchKey);this.#invalidateInputs('task_id=?',[taskId],'run_changed');return run;
    });
  }
  recordSubmission(input,runId,externalRef){
    const s=this.#scope(input);boundedText(externalRef,512);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);const run=this.#row('work_runs',s.key,runId);
      if(run.external_ref===externalRef)return run;
      if(run.state!=='dispatching'||run.external_ref)reject('SUBMISSION_REQUIRES_RECONCILIATION');
      if(this.#db.prepare('SELECT id FROM work_runs WHERE scope_key=? AND external_ref=?').get(s.key,externalRef))reject('EXTERNAL_REFERENCE_REUSED');
      this.#db.prepare("UPDATE work_runs SET state='running',external_ref=? WHERE id=?").run(externalRef,runId);this.#taskState(run,'running');
      this.#fault('before-submission-commit');
      return this.run(s.value,runId);
    });
  }
  recordEvent(input,runId,inputEvent,{apply=true}={}){
    if(typeof apply!=='boolean')reject('INVALID_EVENT_APPLICATION');
    const s=this.#scope(input),event=normalizeEvent(inputEvent),hash=digest(JSON.stringify(event));
    this.#expirePairing(s);
    return this.#transaction(()=>{
      const run=this.#row('work_runs',s.key,runId);
      if(event.correlationId!==run.dispatch_key)reject('EVENT_CORRELATION_MISMATCH');
      const prior=this.#db.prepare('SELECT event_digest FROM work_events WHERE run_id=? AND (seq=? OR event_id=?)').get(runId,event.seq,event.id);
      if(prior){if(prior.event_digest!==hash)reject('EVENT_CONFLICT');return {duplicate:true,applied:false};}
      const currentTask=this.#row('work_tasks',s.key,run.task_id),nextState=EVENT_STATES[event.type];
      const isTerminal=TERMINAL_STATES.includes(run.state);
      let active=true;try{this.#active(s.value);this.#available(s.value.botId);this.#taskAuthorization(s,run.task_id);}catch{active=false;}
      const approvalBypass=run.state==='waiting_approval'&&nextState&&!['waiting_approval','cancelling',...TERMINAL_STATES].includes(nextState);
      const questionBypass=run.state==='waiting_input'&&nextState==='running';
      const applied=apply&&active&&!!run.external_ref&&!isTerminal&&!['unknown','reconciling'].includes(run.state)&&event.seq>run.last_seq&&currentTask.current_run_id===runId&&!approvalBypass&&!questionBypass&&!(run.state==='cancelling'&&nextState&&!TERMINAL_STATES.includes(nextState)&&nextState!=='cancelling');
      this.#db.prepare('INSERT INTO work_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(runId,event.id,event.seq,event.type,event.schemaVersion,event.occurredAt,new Date().toISOString(),event.correlationId,JSON.stringify(event.data),hash,Number(applied));
      if(applied){
        if(nextState==='cancelling'&&!this.#cancelPending(s,runId))this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(randomUUID(),runId,s.key,'cancel_requested','{}');
        this.#db.prepare('UPDATE work_runs SET last_seq=?,state=? WHERE id=?').run(event.seq,nextState||run.state,runId);
        if(nextState)this.#taskState(run,nextState);
        if(nextState)this.#refreshInputs(s,runId);
      }
      this.#fault('before-event-commit');
      return {duplicate:false,applied,late:event.seq<=run.last_seq,conflictingTerminal:isTerminal&&!!nextState&&nextState!==run.state};
    });
  }
  events(input,runId){
    const s=this.#scope(input),run=this.#row('work_runs',s.key,runId),task=this.#row('work_tasks',s.key,run.task_id);
    return this.#db.prepare('SELECT event_id AS id,seq,type,schema_version AS schemaVersion,occurred_at AS occurredAt,received_at AS receivedAt,correlation_id AS correlationId,data_json AS data,applied FROM work_events WHERE run_id=? ORDER BY seq').all(runId).map(e=>({...e,runId,taskId:task.id,sessionId:task.session_id,scope:s.value,data:JSON.parse(e.data),applied:!!e.applied}));
  }
  answerInput(input,runId,text,question){
    const s=this.#scope(input);boundedText(text);
    object(question,['questionId','questionSeq']);boundedText(question.questionId,128);
    this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);const run=this.#row('work_runs',s.key,runId);this.#taskAuthorization(s,run.task_id);
      if(run.state!=='waiting_input')reject('NOT_WAITING_FOR_ORDINARY_INPUT');
      this.#question(s,runId,question.questionId,question.questionSeq);
      const id=randomUUID();this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(id,runId,s.key,'ordinary_input',JSON.stringify({text}));
      return {id,executionApproved:false};
    });
  }
  requestCancel(input,runId){
    const s=this.#scope(input);
    return this.#transaction(()=>{
      this.#active(s.value);const run=this.#row('work_runs',s.key,runId);
      return this.#cancelRun(s,run);
    });
  }
  #cancelRun(s,run){
    this.#invalidateInputs('scope_key=? AND (run_id=? OR delivery_run_id=?)',[s.key,run.id,run.id],'cancel_requested');
    if(TERMINAL_STATES.includes(run.state))return {state:run.state,requested:false};
    if(['unknown','reconciling'].includes(run.state))reject('CANCEL_REQUIRES_RECONCILIATION');
    if(!this.#cancelPending(s,run.id))this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(randomUUID(),run.id,s.key,'cancel_requested','{}');
    this.#db.prepare("UPDATE work_runs SET state='cancelling' WHERE id=?").run(run.id);this.#taskState(run,'cancelling');
    return {state:'cancelling',requested:true};
  }
  #cancelPending(s,runId){return !!this.#db.prepare("SELECT id FROM work_actions WHERE scope_key=? AND run_id=? AND type IN('cancel_requested','host_cancel_intent') LIMIT 1").get(s.key,runId);}
  #cancelContext(s,target,key){
    const task=this.#row('work_tasks',s.key,target.taskId),run=this.#row('work_runs',s.key,target.runId),session=this.session(s.value);
    const leaseId=this.#db.prepare('SELECT pairing_id FROM work_task_authorizations WHERE task_id=?').get(task.id)?.pairing_id;
    if(run.task_id!==task.id||task.session_id!==session.id||run.attempt!==target.attempt||task.kind!==target.kind||leaseId!==target.leaseId||run.external_ref!==target.externalRef)reject('CANCELLATION_TARGET_MISMATCH');
    const row=this.#db.prepare("SELECT * FROM work_actions WHERE scope_key=? AND run_id=? AND type='host_cancel_intent'").get(s.key,run.id);
    const intent=row?{id:row.id,...JSON.parse(row.data_json)}:null;
    if(intent&&(intent.key!==key||digest(JSON.stringify(intent.target))!==digest(JSON.stringify(target))||intent.sessionId!==session.id||intent.dispatchKey!==run.dispatch_key))reject('CANCELLATION_INTENT_CONFLICT');
    return {task,run,session,leaseId,intent};
  }
  // A trusted Host may revoke ONLY its already correlated original Run after
  // stop/unbind/expiry. This does not check or grant a new pairing, change the
  // current Run, or authorize submission/input/events/approval. Unknown stays
  // unknown. Host ownership and the exact Adapter/model remain Host checks.
  requestHostCancellation(input,value,key){
    const s=this.#scope(input),target=cancellationTarget(value);identifier(key);this.#expirePairing(s);
    return this.#transaction(()=>{
      const context=this.#cancelContext(s,target,key);
      if(context.intent)return freeze({...context.intent,created:false});
      const intents=this.#db.prepare("SELECT data_json FROM work_actions WHERE scope_key=? AND type='host_cancel_intent'").all(s.key);
      if(intents.some(row=>JSON.parse(row.data_json).key===key))reject('CANCELLATION_KEY_CONFLICT');
      if(context.task.current_run_id!==target.runId&&!TERMINAL_STATES.includes(context.run.state))reject('CANCELLATION_STALE_RUN');
      const data={key,target,sessionId:context.session.id,dispatchKey:context.run.dispatch_key},id=randomUUID();
      this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(id,target.runId,s.key,'host_cancel_intent',JSON.stringify(data));
      this.#invalidateInputs('scope_key=? AND (run_id=? OR delivery_run_id=?)',[s.key,target.runId,target.runId],'cancel_requested');
      if(!['unknown','reconciling',...TERMINAL_STATES].includes(context.run.state)){
        this.#db.prepare("UPDATE work_runs SET state='cancelling' WHERE id=?").run(target.runId);this.#taskState(context.run,'cancelling');
      }
      this.#fault('before-cancel-intent-commit');return freeze({id,...data,created:true});
    });
  }
  cancellationContext(input,value,key){
    const s=this.#scope(input),target=cancellationTarget(value);identifier(key);this.#expirePairing(s);
    return this.#transaction(()=>freeze(this.#cancelContext(s,target,key)));
  }
  completeCancellation(input,value,key,report){
    const s=this.#scope(input),target=cancellationTarget(value);identifier(key);object(report,['state','dispatchKey','externalRef']);
    if(!TERMINAL_STATES.includes(report.state)||report.externalRef!==target.externalRef)reject('CANCELLATION_TERMINAL_REQUIRED');
    return this.#transaction(()=>{
      const {run,intent}=this.#cancelContext(s,target,key);
      if(!intent||report.dispatchKey!==run.dispatch_key)reject('CANCELLATION_INTENT_REQUIRED');
      if(TERMINAL_STATES.includes(run.state)){
        if(run.state!==report.state)reject('CANCELLATION_TERMINAL_CONFLICT');return run;
      }
      this.#db.prepare('UPDATE work_runs SET state=? WHERE id=?').run(report.state,run.id);this.#taskState(run,report.state);
      this.#invalidateInputs('scope_key=? AND (run_id=? OR delivery_run_id=?)',[s.key,run.id,run.id],'run_terminal');
      this.#fault('before-cancel-terminal-commit');return this.run(s.value,run.id);
    });
  }
  recover(input){
    const s=this.#scope(input);
    return this.#transaction(()=>{
      const rows=this.#db.prepare("SELECT * FROM work_runs WHERE scope_key=? AND state IN('dispatching','running','waiting_input','waiting_approval','cancelling')").all(s.key);
      for(const run of rows){
        if(run.state==='cancelling'&&!this.#cancelPending(s,run.id))this.#db.prepare('INSERT INTO work_actions VALUES(?,?,?,?,?)').run(randomUUID(),run.id,s.key,'cancel_requested','{}');
        this.#db.prepare("UPDATE work_runs SET state='reconciling' WHERE id=?").run(run.id);this.#taskState(run,'reconciling');
      }
      this.#db.prepare("UPDATE work_outbox SET state='unknown' WHERE scope_key=? AND state='sending'").run(s.key);
      this.#db.prepare("UPDATE work_input_batches SET state='unknown',reason='restart_unconfirmed' WHERE scope_key=? AND state='dispatching'").run(s.key);
      return {runs:rows.map(r=>({id:r.id,dispatchKey:r.dispatch_key,externalRef:r.external_ref})),automaticSubmissions:0,automaticSends:0};
    });
  }
  reconcileRun(input,runId,report){
    const s=this.#scope(input);object(report,['state','dispatchKey','externalRef']);
    if(!['unknown','running',...TERMINAL_STATES].includes(report.state))reject('INVALID_RECONCILIATION');
    if(report.externalRef!==null)boundedText(report.externalRef,512);
    return this.#transaction(()=>{
      const run=this.#row('work_runs',s.key,runId);
      if(!['reconciling','unknown'].includes(run.state)||report.dispatchKey!==run.dispatch_key)reject('RECONCILIATION_MISMATCH');
      if(run.external_ref&&report.externalRef!==run.external_ref)reject('EXTERNAL_REFERENCE_MISMATCH');
      if(report.state!=='unknown'&&!report.externalRef)reject('EXTERNAL_REFERENCE_REQUIRED');
      if(report.state==='running'&&this.#cancelPending(s,runId))reject('CANCELLATION_RECONCILIATION_REQUIRED');
      this.#db.prepare('UPDATE work_runs SET state=?,external_ref=? WHERE id=?').run(report.state,report.externalRef,runId);this.#taskState(run,report.state);
      return this.run(s.value,runId);
    });
  }
  enqueueResult(input,runId,body){
    const s=this.#scope(input);boundedText(body);
    this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);const run=this.#row('work_runs',s.key,runId);this.#taskAuthorization(s,run.task_id);
      if(!TERMINAL_STATES.includes(run.state))reject('RUN_NOT_TERMINAL');
      const existing=this.#db.prepare('SELECT id,body FROM work_outbox WHERE run_id=?').get(runId);
      if(existing){if(existing.body!==body)reject('OUTBOX_CONFLICT');return {id:existing.id,reused:true};}
      const id=randomUUID();this.#db.prepare('INSERT INTO work_outbox VALUES(?,?,?,?,?,NULL,NULL)').run(id,s.key,runId,body,this.#meta('stopped')==='1'?'frozen':'queued');
      return {id,reused:false};
    });
  }
  outbox(input,id){return this.#row('work_outbox',this.#scope(input).key,id);}
  claimDelivery(input,id){
    const s=this.#scope(input);
    this.#expirePairing(s);
    return this.#transaction(()=>{
      this.#active(s.value);this.#available(s.value.botId);
      const row=this.#row('work_outbox',s.key,id);if(row.state!=='queued')reject('OUTBOX_NOT_QUEUED');
      this.#taskAuthorization(s,this.#row('work_runs',s.key,row.run_id).task_id);
      const token=randomUUID();this.#db.prepare("UPDATE work_outbox SET state='sending',attempt_token=? WHERE id=?").run(token,id);
      return {id,body:row.body,attemptToken:token};
    });
  }
  recordDelivery(input,id,report){
    object(report,['state','attemptToken','receiptRef']);const {state,attemptToken,receiptRef=null}=report;identifier(attemptToken);
    const s=this.#scope(input);if(!['sent','failed','unknown'].includes(state))reject('INVALID_DELIVERY_STATE');
    if(receiptRef!==null)boundedText(receiptRef,512);if(state==='sent'&&!receiptRef)reject('RECEIPT_REQUIRED');
    return this.#transaction(()=>{
      const row=this.#row('work_outbox',s.key,id);
      if(row.state!=='sending'||row.attempt_token!==attemptToken)reject('DELIVERY_REQUIRES_RECONCILIATION');
      this.#db.prepare('UPDATE work_outbox SET state=?,receipt_ref=? WHERE id=?').run(state,receiptRef,id);
      return {state};
    });
  }
  stop(hostId){
    if(identifier(hostId)!==this.#hostId)reject('HOST_MISMATCH');
    return this.#transaction(()=>{
      this.#db.prepare("UPDATE work_meta SET value='1' WHERE key='stopped'").run();
      for(const row of this.#db.prepare('SELECT bot_id FROM binding_heads').all())this.#invalidate(row.bot_id);
      this.#db.exec("UPDATE work_outbox SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'frozen' END WHERE state IN('queued','sending')");
      return {stopped:true};
    });
  }
}
