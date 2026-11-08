import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const CHAT_SCHEMA_VERSION = 1;

export function migrateChat(store, { backup = false } = {}) {
  if (store.get('chatSchemaVersion', 0) >= CHAT_SCHEMA_VERSION) return;
  let backupFile = null;
  if (backup) {
    const directory = path.join(store.directory, 'backups'); mkdirSync(directory, { recursive: true });
    backupFile = path.join(directory, `chat-v1-before-${Date.now()}.sqlite`);
    store.db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
  }
  store.transaction(() => {
    if (store.get('chatSchemaVersion', 0) >= CHAT_SCHEMA_VERSION) return;
    const add = (table, fields) => {
      const names = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const [name, type] of fields) if (!names.has(name)) store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    add('chat_sessions', [['input_version', 'INTEGER NOT NULL DEFAULT 0'], ['memory_enabled', 'INTEGER NOT NULL DEFAULT 1'], ['memory_capture_enabled', 'INTEGER NOT NULL DEFAULT 1'], ['context_floor', 'INTEGER NOT NULL DEFAULT 0']]);
    add('chat_messages', [['trigger_event', 'TEXT REFERENCES inbox(event_key)'], ['source_time', 'INTEGER'], ['memory_blocked', 'INTEGER NOT NULL DEFAULT 0'], ['is_control', 'INTEGER NOT NULL DEFAULT 0'], ['turn_id', 'INTEGER REFERENCES chat_turns(id)']]);
    add('chat_turns', [['batch_id', 'INTEGER'], ['input_version', 'INTEGER NOT NULL DEFAULT 0'], ['memory_revision', 'INTEGER NOT NULL DEFAULT 0'], ['ready_at', 'INTEGER NOT NULL DEFAULT 0'], ['recompute_count', 'INTEGER NOT NULL DEFAULT 0'], ['pending_correction', 'INTEGER NOT NULL DEFAULT 0'], ['generation_version', 'INTEGER NOT NULL DEFAULT 0'], ['timings', "TEXT NOT NULL DEFAULT '{}'" ]]);
    add('outbox', [['chat_turn_id', 'INTEGER REFERENCES chat_turns(id)'], ['chat_session_id', 'TEXT'], ['input_version', 'INTEGER'], ['memory_revision', 'INTEGER']]);
    store.db.exec(`CREATE TABLE chat_memory_state (
      owner_key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE chat_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, persona_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, memory_key TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1, explicit INTEGER NOT NULL DEFAULT 0,
      valid_from INTEGER NOT NULL, expires_at INTEGER, event_date TEXT, event_status TEXT NOT NULL DEFAULT 'fact',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX chat_memory_scope ON chat_memories(owner_key,persona_id,status);
      CREATE UNIQUE INDEX chat_memory_slot ON chat_memories(owner_key,persona_id,memory_key) WHERE status='active';
      CREATE TABLE chat_memory_sources (
      memory_id INTEGER NOT NULL REFERENCES chat_memories(id), message_id INTEGER NOT NULL REFERENCES chat_messages(id),
      excerpt TEXT NOT NULL, message_time INTEGER NOT NULL, PRIMARY KEY(memory_id,message_id));
      CREATE TABLE chat_memory_revisions (
      memory_id INTEGER NOT NULL REFERENCES chat_memories(id), version INTEGER NOT NULL,
      operation TEXT NOT NULL, source_message_id INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY(memory_id,version));
      CREATE TABLE chat_memory_terms (
      memory_id INTEGER NOT NULL REFERENCES chat_memories(id), term TEXT NOT NULL, PRIMARY KEY(memory_id,term));
      CREATE INDEX chat_term_lookup ON chat_memory_terms(term,memory_id);
      CREATE TABLE chat_memory_tombstones (
      owner_key TEXT NOT NULL, persona_id TEXT NOT NULL, memory_key TEXT NOT NULL,
      source_cutoff INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_key,persona_id,memory_key));
      CREATE TABLE chat_topics (
      session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id), content TEXT NOT NULL, state TEXT NOT NULL,
      source_ids TEXT NOT NULL, memory_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE chat_summaries (
      session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id), content TEXT NOT NULL, source_ids TEXT NOT NULL,
      through_message_id INTEGER NOT NULL, memory_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE chat_memory_imports (
      id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, memory_revision INTEGER NOT NULL,
      candidates TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'preview');
      CREATE TABLE chat_deliveries (
      outbox_id INTEGER NOT NULL REFERENCES outbox(id), part_no INTEGER NOT NULL,
      turn_id INTEGER NOT NULL REFERENCES chat_turns(id), session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      content TEXT NOT NULL, provider_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(outbox_id,part_no));
      CREATE INDEX chat_delivery_session ON chat_deliveries(session_id,sent_at,outbox_id,part_no);`);
    // Preserve all old messages. Backfill only provider-confirmed body text; generated text is never proof of delivery.
    store.db.exec(`UPDATE chat_turns SET batch_id=id;
      UPDATE chat_messages SET turn_id=(SELECT id FROM chat_turns WHERE response_message_id=chat_messages.id) WHERE role='assistant';
      UPDATE chat_messages SET trigger_event=(SELECT trigger_event FROM chat_turns WHERE user_message_id=chat_messages.id),
      source_time=COALESCE((SELECT i.sent_at FROM chat_turns t JOIN inbox i ON i.event_key=t.trigger_event WHERE t.user_message_id=chat_messages.id),created_at) WHERE role='user';
      UPDATE outbox SET chat_turn_id=(SELECT id FROM chat_turns WHERE outbox_id=outbox.id),
      chat_session_id=(SELECT session_id FROM chat_turns WHERE outbox_id=outbox.id),input_version=0,memory_revision=0 WHERE kind='chat';
      INSERT INTO chat_deliveries(outbox_id,part_no,turn_id,session_id,content,provider_id,sent_at)
      SELECT o.id,p.part_no,t.id,t.session_id,p.content,COALESCE(p.provider_id,'legacy-confirmed'),COALESCE(t.finished_at,o.created_at)
      FROM outbox o JOIN chat_turns t ON t.outbox_id=o.id JOIN outbox_parts p ON p.notification_id=o.id WHERE p.status='sent';
      INSERT INTO chat_deliveries(outbox_id,part_no,turn_id,session_id,content,provider_id,sent_at)
      SELECT o.id,1,t.id,t.session_id,o.content,COALESCE(o.provider_id,'legacy-confirmed'),COALESCE(t.finished_at,o.created_at)
      FROM outbox o JOIN chat_turns t ON t.outbox_id=o.id WHERE o.status='sent' AND NOT EXISTS(SELECT 1 FROM outbox_parts WHERE notification_id=o.id);
      UPDATE chat_messages SET delivery_status=CASE WHEN EXISTS(SELECT 1 FROM chat_turns t JOIN chat_deliveries d ON d.turn_id=t.id WHERE t.response_message_id=chat_messages.id) THEN 'sent' ELSE 'generated' END WHERE role='assistant';`);
    store.set('chatSchemaVersion', CHAT_SCHEMA_VERSION);
    store.set('chatMigration', { version: CHAT_SCHEMA_VERSION, migratedAt: Date.now(), backupFile, historicalMemoryImported: false });
  });
}
