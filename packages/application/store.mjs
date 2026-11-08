import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { formatCompletion } from './completion.mjs';
import { ensureReference, referenceLabel, migrateReferences } from './numbering.mjs';
import { chatOptions, splitChatReply } from './chat-options.mjs';
import { migrateChat } from './chat-migration.mjs';
import { enqueueChatInput, nextChatBatch, batchInputs } from './chat-batcher.mjs';
import { buildChatContext, updateTopic } from './context-builder.mjs';
import { memoryState, saveCandidates } from './memory-store.mjs';

export const taskId = value => typeof value === 'object' && value?.display_id ? value.display_id : `T${String(typeof value === 'object' ? value?.id : value).padStart(6, '0')}`;
export const ownerKey = event => JSON.stringify([event.appId, event.scope, event.sender]);
export const eventKey = event => JSON.stringify([event.appId, event.scope, event.id]);
const hash = text => createHash('sha256').update(text).digest('hex');

export class Store {
  constructor(directory, { numberingConfig = {} } = {}) {
    this.directory = path.resolve(directory);
    this.numberingConfig = numberingConfig;
    this.chatOptions = chatOptions(numberingConfig);
    mkdirSync(directory, { recursive: true });
    const existed = existsSync(path.join(directory, 'state.sqlite'));
    this.db = new DatabaseSync(path.join(directory, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        event_key TEXT PRIMARY KEY, app_id TEXT NOT NULL, scope TEXT NOT NULL,
        sender TEXT NOT NULL, target TEXT NOT NULL, message_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL, replies INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
        trigger_event TEXT NOT NULL REFERENCES inbox(event_key), project TEXT NOT NULL,
        prompt TEXT NOT NULL, parent_id INTEGER REFERENCES tasks(id), thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL,
        started_at INTEGER, finished_at INTEGER, summary TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER REFERENCES tasks(id),
        trigger_event TEXT NOT NULL REFERENCES inbox(event_key), kind TEXT NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, provider_id TEXT, error TEXT, mode TEXT,
        created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS final_once ON outbox(task_id) WHERE kind='final';
      CREATE INDEX IF NOT EXISTS queue_order ON tasks(status, id);
      CREATE INDEX IF NOT EXISTS send_order ON outbox(status, next_at, id);
      CREATE TABLE IF NOT EXISTS outbox_parts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL REFERENCES outbox(id),
        part_no INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, provider_id TEXT, error TEXT,
        UNIQUE(notification_id,part_no));
      CREATE TABLE IF NOT EXISTS chat_personas (
        owner_key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
        background TEXT NOT NULL, personality TEXT NOT NULL, speech TEXT NOT NULL,
        relationship TEXT NOT NULL, instructions TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_key,id), UNIQUE(owner_key,name));
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, persona_id TEXT NOT NULL,
        persona_snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id), role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL, delivery_status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id),
        trigger_event TEXT NOT NULL UNIQUE REFERENCES inbox(event_key),
        user_message_id INTEGER NOT NULL REFERENCES chat_messages(id),
        response_message_id INTEGER REFERENCES chat_messages(id),
        outbox_id INTEGER REFERENCES outbox(id),
        model TEXT NOT NULL, reasoning_effort TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL,
        started_at INTEGER, finished_at INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS chat_queue ON chat_turns(status,id);
      CREATE INDEX IF NOT EXISTS chat_owner_sessions ON chat_sessions(owner_key,created_at);
      CREATE INDEX IF NOT EXISTS chat_session_messages ON chat_messages(session_id,id);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
    for (const [name, type] of [['project_root', 'TEXT'], ['progress', 'TEXT'], ['progress_at', 'INTEGER'], ['project_name', 'TEXT'], ['model', 'TEXT'], ['reasoning_effort', 'TEXT'], ['execution_backend', "TEXT NOT NULL DEFAULT 'readonly'"], ['desktop_phase', 'TEXT'], ['desktop_host_id', 'TEXT'], ['desktop_turn_id', 'TEXT'], ['desktop_cursor', 'TEXT'], ['desktop_title', 'TEXT'], ['desktop_cwd', 'TEXT'], ['desktop_dispatched_at', 'INTEGER'], ['desktop_after_turn_id', 'TEXT']]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
    const outboxColumns = new Set(this.db.prepare('PRAGMA table_info(outbox)').all().map(column => column.name));
    for (const [name, type] of [['force_proactive', 'INTEGER NOT NULL DEFAULT 0'], ['notification_key', 'TEXT'], ['after_id', 'INTEGER REFERENCES outbox(id)']]) {
      if (!outboxColumns.has(name)) this.db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS desktop_notice_once ON outbox(notification_key) WHERE notification_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS desktop_link_once ON outbox(task_id) WHERE kind='desktop_link';
      CREATE TABLE IF NOT EXISTS desktop_completions (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, completed_at INTEGER NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(thread_id,turn_id));`);
    const completionColumns = new Set(this.db.prepare('PRAGMA table_info(desktop_completions)').all().map(column => column.name));
    for (const [name, type] of [['notice_number', 'INTEGER'], ['owner_key', 'TEXT'], ['rollout_path', 'TEXT'], ['project_root', 'TEXT']]) {
      if (!completionColumns.has(name)) this.db.exec(`ALTER TABLE desktop_completions ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS desktop_notice_number ON desktop_completions(notice_number) WHERE notice_number IS NOT NULL;
      CREATE TABLE IF NOT EXISTS desktop_task_refs (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, notice_number INTEGER NOT NULL UNIQUE,
        owner_key TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS desktop_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, request_id TEXT NOT NULL,
        method TEXT NOT NULL, fingerprint TEXT NOT NULL, task_ref TEXT NOT NULL,
        title TEXT NOT NULL, details TEXT NOT NULL, remote_supported INTEGER NOT NULL,
        code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        notification_id INTEGER REFERENCES outbox(id), decision TEXT,
        decision_event TEXT REFERENCES inbox(event_key), decided_at INTEGER, error TEXT, failures INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS approval_pending ON desktop_approvals(status,id);
      CREATE TABLE IF NOT EXISTS number_references (
        owner_key TEXT NOT NULL, project_key TEXT NOT NULL, project_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('A','D','T')), local_number INTEGER NOT NULL,
        entity_key TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(owner_key,kind,entity_key), UNIQUE(owner_key,project_key,kind,local_number));
      CREATE INDEX IF NOT EXISTS number_label_lookup ON number_references(owner_key,project_name,kind,local_number);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS file_batches (
      source_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, notice_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id),
      label TEXT NOT NULL, requested INTEGER NOT NULL, warnings TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, report_id INTEGER REFERENCES outbox(id), revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS file_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_key TEXT NOT NULL REFERENCES file_batches(source_key),
        outbox_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id), filename TEXT NOT NULL,
        spool_path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
        upload_state TEXT NOT NULL DEFAULT 'ready', file_info TEXT, expires_at INTEGER, upload_attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(batch_key,spool_path));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS received_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
      trigger_event TEXT NOT NULL REFERENCES inbox(event_key), attachment_index INTEGER NOT NULL,
      task_id INTEGER REFERENCES tasks(id), filename TEXT NOT NULL, content_type TEXT NOT NULL,
      url TEXT, declared_size INTEGER, status TEXT NOT NULL DEFAULT 'queued',
      local_path TEXT, bytes INTEGER, sha256 TEXT, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
      UNIQUE(trigger_event,attachment_index));
      CREATE INDEX IF NOT EXISTS receive_queue ON received_files(status,id);
      CREATE INDEX IF NOT EXISTS receive_task ON received_files(task_id,id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_guidance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
      trigger_event TEXT NOT NULL UNIQUE REFERENCES inbox(event_key), project TEXT NOT NULL,
      project_root TEXT NOT NULL, target_key TEXT NOT NULL, target_cwd TEXT,
      task_id INTEGER REFERENCES tasks(id), thread_id TEXT, title TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      created_at INTEGER NOT NULL, dispatched_at INTEGER, finished_at INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS guidance_queue ON task_guidance(status,id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_control_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,request_key TEXT NOT NULL UNIQUE,owner_key TEXT NOT NULL,
      trigger_event TEXT NOT NULL UNIQUE REFERENCES inbox(event_key),thread_id TEXT NOT NULL,cwd TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN('guide','cancel')),prompt TEXT NOT NULL,data TEXT NOT NULL,
      status TEXT NOT NULL,created_at INTEGER NOT NULL,dispatched_at INTEGER,finished_at INTEGER,
      message_id TEXT,result_turn_id TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS native_control_queue ON native_control_operations(status,id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, task_ref TEXT NOT NULL, title TEXT NOT NULL, questions TEXT NOT NULL,
      answers TEXT NOT NULL DEFAULT '{}', remote_supported INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      notification_id INTEGER REFERENCES outbox(id), response_event TEXT REFERENCES inbox(event_key), responded_at INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS question_pending ON desktop_questions(status,id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_observations (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,scope_json TEXT NOT NULL,
      thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,project_root TEXT NOT NULL,
      status TEXT NOT NULL,completed_at INTEGER NOT NULL,summary TEXT NOT NULL,
      evidence TEXT NOT NULL,observed_at INTEGER NOT NULL,outbox_id INTEGER UNIQUE REFERENCES outbox(id),
      UNIQUE(thread_id,turn_id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS bridge_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,request_key TEXT NOT NULL UNIQUE,owner_key TEXT NOT NULL,
      status TEXT NOT NULL,fingerprint TEXT NOT NULL,scope_fingerprint TEXT NOT NULL,data TEXT NOT NULL,code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,decision TEXT,channel TEXT,decision_event TEXT REFERENCES inbox(event_key),
      decided_at INTEGER,submitted_at INTEGER,resolved_at INTEGER,resolution_evidence TEXT,error TEXT);`);
    migrateReferences(this, numberingConfig);
    migrateChat(this, { backup: existed });
  }
  configureChat(config = {}) { this.chatOptions = chatOptions(config); }
  close() { this.db.close(); }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  pairingCode(now = Date.now()) {
    const code = randomBytes(12).toString('hex');
    this.set('pairing', { digest: hash(code), expires: now + 600000, failures: 0 });
    return code;
  }
  tryPair(event, code, now) {
    if (this.get('owner') || event.scope !== 'c2c') return false;
    const pairing = this.get('pairing');
    if (!pairing || pairing.expires < now || pairing.failures >= 10) return false;
    if (!timingSafeEqual(Buffer.from(pairing.digest, 'hex'), Buffer.from(hash(code), 'hex'))) {
      pairing.failures++; this.set('pairing', pairing); return false;
    }
    this.set('owner', ownerKey(event)); this.set('pairing', null); return true;
  }
  ingest(event, callback) {
    return this.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO inbox
        (event_key,app_id,scope,sender,target,message_id,sent_at,received_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(eventKey(event), event.appId, event.scope, event.sender, event.target, event.id, event.sentAt, Date.now());
      return inserted.changes ? callback(eventKey(event)) : { duplicate: true };
    });
  }
  enqueue(owner, trigger, project, prompt, parent = null, now = Date.now(), projectRoot = null, projectName = null, preferences = {}) {
    const result = this.db.prepare(`INSERT INTO tasks
      (owner_key,trigger_event,project,prompt,parent_id,thread_id,created_at,project_root,progress,progress_at,project_name,model,reasoning_effort,execution_backend) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(owner, trigger, project, prompt, parent?.id ?? null, parent?.thread_id ?? null, now, projectRoot || parent?.project_root || null, '等待前面的任务完成', now, projectName || parent?.project_name || project, preferences.model || null, preferences.reasoning || null, parent?.execution_backend || preferences.backend || 'readonly');
    return this.task(Number(result.lastInsertRowid));
  }
  task(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); if (!task) return task;
    const reference = ensureReference(this, this.numberingConfig, 'T', task.id, { task, owner: task.owner_key, at: task.created_at });
    return { ...task, display_id: referenceLabel(reference) };
  }
  tasks(owner, limit = 10) { return this.db.prepare('SELECT id FROM tasks WHERE owner_key=? ORDER BY id DESC LIMIT ?').all(owner, limit).map(row => this.task(row.id)); }
  enqueueChat(owner, trigger, sessionId, content, model, reasoning, now = Date.now()) {
    return this.transaction(() => enqueueChatInput(this, owner, trigger, sessionId, content, model, reasoning, now));
  }
  nextChatTurn(now = Date.now()) {
    return nextChatBatch(this, now);
  }
  chatContext(turn, now = Date.now()) { return buildChatContext(this, turn, now); }
  finishChat(id, result, now = Date.now()) {
    return this.transaction(() => {
      const turn = this.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(id);
      if (!turn || turn.status !== 'running') return;
      const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(turn.session_id);
      if (session.ended_at) { this.db.prepare("UPDATE chat_turns SET status='cancelled',finished_at=? WHERE id=?").run(now, id); return; }
      let body = String(result.reply_text || result.summary || '').trim();
      let succeeded = ['succeeded', 'needs_input'].includes(result.status) && !!body;
      let parts;
      if (succeeded) {
        try { parts = splitChatReply(body, this.chatOptions); }
        catch (error) { succeeded = false; result = { status: 'failed', error: error.message }; }
      }
      const inputs = batchInputs(this, turn);
      if (succeeded) {
        saveCandidates(this, turn.owner_key, session.persona_id, result.memory_candidates, { expectedRevision: turn.memory_revision, allowedSourceIds: inputs.map(row => row.id), now });
        updateTopic(this, turn, result.topic_update, now);
      }
      let responseId = null;
      if (succeeded) {
        const inserted = this.db.prepare("INSERT INTO chat_messages(session_id,role,content,created_at,delivery_status,turn_id) VALUES (?,'assistant',?,?,'generated',?)").run(turn.session_id, body, now, turn.id);
        responseId = Number(inserted.lastInsertRowid);
      }
      if (!succeeded) {
        body = result.error === 'CHAT_CONTEXT_TOO_LARGE' ? '这几条内容太长，一次接不完。分成两次发给我吧。'
          : ['CHAT_REPLY_TOO_LONG', 'CHAT_TOO_MANY_PARTS'].includes(result.error) ? '这段内容一次放不下。可以先聊其中一部分，或分次说明。'
          : result.status === 'interrupted' ? '刚才的对话中断了，请重新发送要聊的内容。' : '刚才没能接上这段对话，请稍后再发一次。';
        parts = [body];
      }
      const revision = memoryState(this, turn.owner_key).revision;
      const trigger = inputs.at(-1)?.trigger_event || turn.trigger_event;
      const outboxId = Number(this.db.prepare(`INSERT INTO outbox(trigger_event,kind,content,created_at,chat_turn_id,chat_session_id,input_version,memory_revision)
        VALUES (?,'chat',?,?,?,?,?,?)`).run(trigger, body, now, turn.id, turn.session_id, turn.input_version, revision).lastInsertRowid);
      for (const [index, part] of parts.entries()) this.db.prepare('INSERT INTO outbox_parts(notification_id,part_no,content) VALUES (?,?,?)').run(outboxId, index + 1, part);
      this.db.prepare('UPDATE chat_messages SET delivery_status=? WHERE id IN (SELECT user_message_id FROM chat_turns WHERE batch_id=?)').run(succeeded ? 'awaiting_delivery' : 'failed', turn.id);
      this.db.prepare("UPDATE chat_turns SET status='included',finished_at=? WHERE batch_id=? AND id!=? AND status='batched'").run(now, turn.id, turn.id);
      this.db.prepare('UPDATE chat_turns SET status=?,response_message_id=?,outbox_id=?,finished_at=?,error=?,memory_revision=?,pending_correction=0 WHERE id=?')
        .run(succeeded ? 'succeeded' : result.status === 'interrupted' ? 'interrupted' : 'failed', responseId, outboxId, now, succeeded ? null : (result.error || result.status || 'failed'), revision, id);
      return outboxId;
    });
  }
  reply(trigger, content, kind = 'reply', task = null, now = Date.now()) {
    return Number(this.db.prepare(`INSERT INTO outbox (task_id,trigger_event,kind,content,created_at) VALUES (?,?,?,?,?)`)
      .run(task, trigger, kind, content.slice(0, 900), now).lastInsertRowid);
  }
  completion(trigger, heading, body, kind = 'final', task = null, now = Date.now(), key = null, proactive = false) {
    return this.transaction(() => {
      const formatted = formatCompletion(heading, body);
      const inserted = this.db.prepare('INSERT OR IGNORE INTO outbox(task_id,trigger_event,kind,content,created_at,force_proactive,notification_key) VALUES (?,?,?,?,?,?,?)').run(task, trigger, kind, formatted.content, now, Number(proactive), key);
      if (!inserted.changes) return null;
      const id = Number(inserted.lastInsertRowid);
      for (const [index, content] of formatted.parts.entries()) this.db.prepare('INSERT INTO outbox_parts(notification_id,part_no,content) VALUES (?,?,?)').run(id, index + 1, content);
      return id;
    });
  }
  requeueCompletion(trigger, id) {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE outbox SET trigger_event=?,status='pending',attempts=0,next_at=0,error=NULL WHERE id=? AND status IN ('blocked','unknown')").run(trigger, id);
      if (changed.changes) this.db.prepare("UPDATE outbox_parts SET status='pending',attempts=0,error=NULL WHERE notification_id=? AND status IN ('blocked','unknown')").run(id);
      return !!changed.changes;
    });
  }
  desktopNoticeNumber(thread, turn) {
    const row = this.db.prepare('SELECT notice_number,owner_key FROM desktop_completions WHERE thread_id=? AND turn_id=?').get(thread, turn);
    if (!row) throw new Error('DESKTOP_COMPLETION_MISSING');
    if (row.notice_number) return row.notice_number;
    const next = this.desktopTaskNumber(thread, turn);
    this.db.prepare('UPDATE desktop_completions SET notice_number=?,owner_key=? WHERE thread_id=? AND turn_id=?').run(next, this.get('owner'), thread, turn);
    return next;
  }
  desktopTaskNumber(thread, turn) {
    return this.transaction(() => {
      const owner = this.get('owner'); if (!owner) throw new Error('OWNER_MISSING');
      const known = this.db.prepare('SELECT notice_number FROM desktop_task_refs WHERE thread_id=? AND turn_id=? AND owner_key=?').get(thread, turn, owner)
        || this.db.prepare('SELECT notice_number FROM desktop_completions WHERE thread_id=? AND turn_id=? AND owner_key=? AND notice_number IS NOT NULL').get(thread, turn, owner);
      if (known) return known.notice_number;
      const next = Math.max(this.get('desktopNoticeSequence', 0), this.db.prepare('SELECT COALESCE(MAX(notice_number),0) n FROM desktop_completions').get().n, this.db.prepare('SELECT COALESCE(MAX(notice_number),0) n FROM desktop_task_refs').get().n) + 1;
      this.set('desktopNoticeSequence', next);
      this.db.prepare('INSERT INTO desktop_task_refs(thread_id,turn_id,notice_number,owner_key) VALUES (?,?,?,?)').run(thread, turn, next, owner);
      return next;
    });
  }
  nextTask(now = Date.now()) {
    return this.transaction(() => {
      const task = this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY id LIMIT 1").get();
      if (!task) return null;
      this.db.prepare("UPDATE tasks SET status='running',started_at=?,progress='准备执行',progress_at=? WHERE id=? AND status='queued'").run(now, now, task.id);
      return this.task(task.id);
    });
  }
  progress(id, stage, now = Date.now()) {
    this.db.prepare("UPDATE tasks SET progress=?,progress_at=? WHERE id=? AND status='running'").run(String(stage).slice(0, 180), now, id);
  }
  desktopDispatch(id, afterTurn = null) {
    const result = this.db.prepare("UPDATE tasks SET desktop_phase='dispatching',desktop_dispatched_at=?,desktop_after_turn_id=? WHERE id=? AND status='running' AND execution_backend='desktop' AND desktop_phase IS NULL").run(Date.now(), afterTurn, id);
    if (result.changes !== 1) throw new Error('DESKTOP_ALREADY_DISPATCHED');
  }
  desktopLinked(id, link) {
    this.transaction(() => {
      const task = this.task(id);
      this.db.prepare("UPDATE tasks SET thread_id=?,desktop_host_id=?,desktop_cwd=?,desktop_title=?,desktop_phase='submitted' WHERE id=? AND desktop_phase='dispatching'").run(link.threadId, link.hostId, link.cwd || null, link.title || null, id);
      if (!this.db.prepare("SELECT id FROM outbox WHERE task_id=? AND kind='desktop_link'").get(id)) this.reply(task.trigger_event, `【Codex】${taskId(task)} 已交给桌面对话执行。\n${link.threadId}\n可在桌面查看任务、处理审批；完成后会通知 QQ。`, 'desktop_link', id);
    });
  }
  desktopTurn(id, turnId, cursor = null) {
    this.db.prepare('UPDATE tasks SET desktop_turn_id=COALESCE(?,desktop_turn_id),desktop_cursor=COALESCE(?,desktop_cursor) WHERE id=?').run(turnId, cursor, id);
  }
  ownerNotice(key, content, appId, now = Date.now(), heading = null, kind = 'desktop_final') {
    const owner = this.get('owner'); if (!owner) return null;
    let identity; try { identity = JSON.parse(owner); } catch { return null; }
    if (identity[0] !== appId || identity[1] !== 'c2c') return null;
    // Use an authentic owner inbox row only to resolve the bound QQ recipient.
    // Autonomous notifications always use proactive delivery, never its reply budget.
    const inbox = this.db.prepare("SELECT event_key FROM inbox WHERE app_id=? AND scope='c2c' AND sender=? AND target=sender ORDER BY received_at DESC LIMIT 1").get(appId, identity[2]);
    if (!inbox) return null;
    if (heading !== null) return this.completion(inbox.event_key, heading, content, kind, null, now, key, true);
    return this.transaction(() => {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO outbox(trigger_event,kind,content,created_at,force_proactive,notification_key) VALUES (?,'desktop_final',?,?,1,?)").run(inbox.event_key, content.slice(0, 900), now, key);
      return inserted.changes ? Number(inserted.lastInsertRowid) : null;
    });
  }
  finish(id, status, summary, error = null, threadId = null) {
    this.transaction(() => {
      const task = this.task(id);
      if (!task || task.status !== 'running') return;
      this.db.prepare('UPDATE tasks SET status=?,summary=?,error=?,thread_id=COALESCE(?,thread_id),finished_at=?,progress=?,progress_at=? WHERE id=?')
        .run(status, summary, error, threadId, Date.now(), status === 'succeeded' ? '任务已完成' : '任务已结束，请查看结果', Date.now(), id);
      this.completion(task.trigger_event, `【Codex】${taskId(task)}`, summary || error || '任务已结束。', 'final', id);
    });
  }
  cancel(id, owner) {
    const task = this.task(id);
    if (!task || task.owner_key !== owner) return null;
    if (['queued', 'waiting_files'].includes(task.status)) {
      this.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
      this.finish(id, 'cancelled', '任务在开始前已取消。');
    }
    return this.task(id);
  }
  recover() {
    this.transaction(() => {
      this.db.prepare("UPDATE desktop_approvals SET status='expired',error='NATIVE_HOOK_SERVICE_INSTANCE_ENDED' WHERE method='PermissionRequest' AND status IN('pending','queued')").run();
      this.db.prepare("UPDATE desktop_approvals SET status='unknown',error='NATIVE_HOOK_RETURN_REQUIRES_RECONCILIATION' WHERE method='PermissionRequest' AND status='submitted'").run();
      this.db.prepare("UPDATE bridge_approvals SET status='expired',error='ORIGINAL_APPROVAL_CONNECTION_LOST' WHERE status IN('pending','queued')").run();
      this.db.prepare("UPDATE bridge_approvals SET status='unknown',error='APPROVAL_SUBMISSION_REQUIRES_RECONCILIATION' WHERE status IN('sending','submitted')").run();
      for (const question of this.db.prepare("SELECT * FROM desktop_questions WHERE status='sending'").all()) {
        this.db.prepare("UPDATE desktop_questions SET status='unknown',error='服务在提交答案时中断' WHERE id=?").run(question.id);
        if (question.response_event) this.reply(question.response_event, `Q${question.id} 答案提交结果待核对。请在原桌面对话核对，未自动重发。`, 'question_reply');
      }
      this.db.prepare("UPDATE task_guidance SET status='queued' WHERE status='checking'").run();
      for (const message of this.db.prepare("SELECT * FROM task_guidance WHERE status='sending'").all()) {
        this.db.prepare("UPDATE task_guidance SET status='unknown',error='服务在发送指导时中断',finished_at=? WHERE id=?").run(Date.now(), message.id);
        this.reply(message.trigger_event, `任务指导 #${message.id} 的发送结果待核对。请在原桌面对话核对，未自动重发。`, 'guidance_result');
      }
      for (const task of this.db.prepare("SELECT * FROM tasks WHERE status='running'").all()) {
        if (task.execution_backend === 'desktop' && task.desktop_phase === 'submitted' && task.thread_id) {
          this.db.prepare("UPDATE tasks SET status='queued',progress='恢复桌面任务进度查询；不会重新提交' WHERE id=?").run(task.id);
        } else if (task.execution_backend === 'desktop' && task.desktop_phase === 'dispatching') {
          this.db.prepare("UPDATE tasks SET desktop_phase='unknown' WHERE id=?").run(task.id);
          this.finish(task.id, 'needs_input', '服务在提交桌面任务时中断，提交结果待核对。请先在桌面查找 QQ 任务编号；未自动重发。');
        } else if(task.execution_backend==='app-server'){
          this.db.prepare("UPDATE tasks SET status='unknown',error='服务在真实工作期间中断，终态待核对',finished_at=? WHERE id=?").run(Date.now(),task.id);
          const dispatch=this.get('bridgeDispatch:'+task.id);if(dispatch)this.set('bridgeDispatch:'+task.id,{...dispatch,state:'unknown'});
          this.reply(task.trigger_event,`【Codex】${taskId(task)} 结果待核对，未自动重新执行。`,'final',task.id);
        }else this.finishInTransaction(task.id);
      }
      for (const turn of this.db.prepare("SELECT id FROM chat_turns WHERE status='running'").all()) this.finishChat(turn.id, { status: 'interrupted' });
      this.db.prepare("UPDATE outbox SET status='unknown',error='服务在发送期间中断；等待人工核对' WHERE status='sending'").run();
      this.db.prepare("UPDATE outbox_parts SET status='unknown',error='服务在发送期间中断；等待人工核对' WHERE status='sending'").run();
      this.db.prepare("UPDATE chat_messages SET delivery_status='unknown' WHERE role='assistant' AND id IN (SELECT t.response_message_id FROM chat_turns t JOIN outbox o ON o.id=t.outbox_id WHERE o.status='unknown')").run();
      this.db.prepare("UPDATE desktop_approvals SET status='unknown',error='服务在提交审批时中断，未自动重试' WHERE status='sending'").run();
      // Uploads cannot send a message (srv_send_msg=false), so only this stage is safe to retry.
      this.db.prepare("UPDATE file_transfers SET upload_state='ready' WHERE upload_state='uploading'").run();
      // Downloading input files is safe to resume; waiting work is never dispatched.
      this.db.prepare("UPDATE received_files SET status='queued' WHERE status='downloading'").run();
    });
  }
  finishInTransaction(id) {
    const task = this.task(id);
    this.db.prepare("UPDATE tasks SET status='interrupted',error='服务中断，未自动重跑',finished_at=? WHERE id=?").run(Date.now(), id);
    this.reply(task.trigger_event, `【Codex】${taskId(task)} interrupted\n服务中断，任务没有自动重跑。可查询结果并决定是否重试。`, 'final', id);
  }
  outbox() { return this.db.prepare('SELECT * FROM outbox ORDER BY id').all(); }
  snapshot() {
    return {
      tasks: this.db.prepare('SELECT id,project,status,summary,error FROM tasks ORDER BY id').all(),
      messages: this.db.prepare('SELECT id,task_id,kind,status,mode,error FROM outbox ORDER BY id').all()
    };
  }
}
