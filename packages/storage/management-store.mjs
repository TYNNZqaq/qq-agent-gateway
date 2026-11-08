import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fail, record, label, internalId, expectedRevision, appIdentity, configurationStatus } from '../core/management.mjs';

// New control metadata only. Never opens or migrates legacy business databases.
export class ManagementStore {
  constructor(database, toolIds) {
    this.toolIds = new Set(toolIds);
    this.db = new DatabaseSync(database);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ui_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO ui_meta VALUES('revision',0);
      INSERT OR IGNORE INTO ui_meta VALUES('schema',1);
      CREATE TABLE IF NOT EXISTS ui_bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,app_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('registered','paused')),archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS ui_app_unique ON ui_bots(app_id) WHERE app_id<>'' AND archived=0;
      CREATE TABLE IF NOT EXISTS ui_agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,tool_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('registered','paused')),archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_bindings(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES ui_bots(id),agent_id TEXT NOT NULL REFERENCES ui_agents(id),version INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS ui_bot_binding ON ui_bindings(bot_id) WHERE active=1;
      CREATE UNIQUE INDEX IF NOT EXISTS ui_agent_binding ON ui_bindings(agent_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS ui_audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,resource_id TEXT NOT NULL,at TEXT NOT NULL,revision INTEGER NOT NULL);`);
    if (this.db.prepare("SELECT value FROM ui_meta WHERE key='schema'").get().value !== 1) fail('SCHEMA_UNSUPPORTED', 409);
  }
  close() { this.db.close(); }
  revision() { return this.db.prepare("SELECT value FROM ui_meta WHERE key='revision'").get().value; }
  transaction(revision, action, resource, work) {
    expectedRevision(revision);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (revision !== this.revision()) fail('STALE_REVISION', 409);
      const value = work();
      this.db.prepare("UPDATE ui_meta SET value=value+1 WHERE key='revision'").run();
      this.db.prepare('INSERT INTO ui_audit VALUES(?,?,?,?,?)').run(randomUUID(), action, resource, new Date().toISOString(), this.revision());
      this.db.exec('COMMIT'); return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(table, id) {
    internalId(id);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND archived=0`).get(id);
    if (!row) fail('NOT_FOUND', 404);
    return row;
  }
  snapshot() {
    const bots = this.db.prepare('SELECT * FROM ui_bots WHERE archived=0 ORDER BY created_at,id').all().map(b => ({ id:b.id,name:b.name,status:b.status,appIdConfigured:!!b.app_id,appIdMasked:b.app_id ? '•••• '+b.app_id.slice(-4) : '',connection:'offline',createdAt:b.created_at }));
    const agents = this.db.prepare('SELECT * FROM ui_agents WHERE archived=0 ORDER BY created_at,id').all().map(a => ({ id:a.id,name:a.name,toolId:a.tool_id,status:a.status,connection:'not_connected',createdAt:a.created_at }));
    const bindings = this.db.prepare('SELECT id,bot_id AS botId,agent_id AS agentId,version FROM ui_bindings WHERE active=1').all();
    const activity = this.db.prepare('SELECT id,action,resource_id AS resourceId,at,revision FROM ui_audit ORDER BY revision DESC LIMIT 30').all();
    return { revision:this.revision(), bots, agents, bindings, activity };
  }
  createBot(input) {
    record(input,['name','appId','expectedRevision']); const id = randomUUID(), name = label(input.name), appId = appIdentity(input.appId ?? '');
    return this.transaction(input.expectedRevision,'bot.created',id,() => {
      if (appId && this.db.prepare('SELECT id FROM ui_bots WHERE app_id=? AND archived=0').get(appId)) fail('APP_ID_IN_USE',409);
      this.db.prepare('INSERT INTO ui_bots(id,name,app_id,status,created_at) VALUES(?,?,?,?,?)').run(id,name,appId,'registered',new Date().toISOString()); return {id};
    });
  }
  updateBot(id,input) {
    record(input,['name','appId','status','expectedRevision']);
    return this.transaction(input.expectedRevision,'bot.updated',id,() => {
      const old=this.get('ui_bots',id), name=input.name===undefined?old.name:label(input.name), appId=input.appId===undefined?old.app_id:appIdentity(input.appId), status=input.status===undefined?old.status:configurationStatus(input.status);
      if (appId && this.db.prepare('SELECT id FROM ui_bots WHERE app_id=? AND id<>? AND archived=0').get(appId,id)) fail('APP_ID_IN_USE',409);
      this.db.prepare('UPDATE ui_bots SET name=?,app_id=?,status=? WHERE id=?').run(name,appId,status,id); return {id};
    });
  }
  archiveBot(id,input) {
    record(input,['expectedRevision']);
    return this.transaction(input.expectedRevision,'bot.archived',id,() => { this.get('ui_bots',id); this.db.prepare('UPDATE ui_bindings SET active=0 WHERE bot_id=? AND active=1').run(id); this.db.prepare('UPDATE ui_bots SET archived=1 WHERE id=?').run(id); return {id,dataPreserved:true}; });
  }
  createAgent(input) {
    record(input,['name','toolId','expectedRevision']); const id=randomUUID(), name=label(input.name);
    if (!this.toolIds.has(input.toolId)) fail('UNKNOWN_TOOL');
    return this.transaction(input.expectedRevision,'agent.created',id,() => { this.db.prepare('INSERT INTO ui_agents(id,name,tool_id,status,created_at) VALUES(?,?,?,?,?)').run(id,name,input.toolId,'registered',new Date().toISOString()); return {id}; });
  }
  updateAgent(id,input) {
    record(input,['name','status','expectedRevision']);
    return this.transaction(input.expectedRevision,'agent.updated',id,() => { const old=this.get('ui_agents',id); this.db.prepare('UPDATE ui_agents SET name=?,status=? WHERE id=?').run(input.name===undefined?old.name:label(input.name),input.status===undefined?old.status:configurationStatus(input.status),id); return {id}; });
  }
  archiveAgent(id,input) {
    record(input,['expectedRevision']);
    return this.transaction(input.expectedRevision,'agent.archived',id,() => { this.get('ui_agents',id); if(this.db.prepare('SELECT id FROM ui_bindings WHERE agent_id=? AND active=1').get(id)) fail('AGENT_STILL_BOUND',409); this.db.prepare('UPDATE ui_agents SET archived=1 WHERE id=?').run(id); return {id,dataPreserved:true}; });
  }
  bind(input) {
    record(input,['botId','agentId','expectedRevision']); internalId(input.botId); if(input.agentId!==null)internalId(input.agentId);
    return this.transaction(input.expectedRevision,input.agentId?'binding.updated':'binding.removed',input.botId,() => {
      const bot=this.get('ui_bots',input.botId); if(bot.status==='paused'&&input.agentId)fail('BOT_PAUSED',409);
      if(input.agentId){const agent=this.get('ui_agents',input.agentId); if(agent.status==='paused')fail('AGENT_PAUSED',409); const used=this.db.prepare('SELECT bot_id FROM ui_bindings WHERE agent_id=? AND active=1').get(input.agentId); if(used && used.bot_id!==input.botId)fail('AGENT_ALREADY_BOUND',409);}
      const last=this.db.prepare('SELECT COALESCE(MAX(version),0) n FROM ui_bindings WHERE bot_id=?').get(input.botId).n;
      this.db.prepare('UPDATE ui_bindings SET active=0 WHERE bot_id=? AND active=1').run(input.botId);
      if(input.agentId)this.db.prepare('INSERT INTO ui_bindings VALUES(?,?,?,?,1,?)').run(randomUUID(),input.botId,input.agentId,last+1,new Date().toISOString());
      return {version:last+1};
    });
  }
}
