import { learnFromMessage, memoryState } from './memory-store.mjs';

export const correctionInput = text => /不对|不是|别(?:给|急|再|分析|排)|不要|先别|等一下|等等|改成|改到|更正|撤回|算了|说错|刚才.*错|其实|还没|取消/.test(text);

export function cancelChatSession(store, owner, sessionId, now = Date.now()) {
  if (!sessionId) return;
  store.db.prepare("UPDATE chat_turns SET status='cancelled',finished_at=?,error='CHAT_SESSION_CHANGED' WHERE session_id=? AND owner_key=? AND status IN ('queued','running','batched')").run(now, sessionId, owner);
  store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='CHAT_SESSION_CHANGED' WHERE status='pending' AND notification_id IN (SELECT id FROM outbox WHERE chat_session_id=?)").run(sessionId);
  store.db.prepare("UPDATE outbox SET status='cancelled',error='CHAT_SESSION_CHANGED' WHERE chat_session_id=? AND status='pending'").run(sessionId);
  store.db.prepare("UPDATE chat_messages SET delivery_status='cancelled' WHERE session_id=? AND role='assistant' AND delivery_status IN ('generated','partial')").run(sessionId);
}

export function enqueueChatInput(store, owner, trigger, sessionId, content, model, reasoning, now) {
  const options = store.chatOptions;
  const session = store.db.prepare('SELECT * FROM chat_sessions WHERE id=? AND owner_key=? AND ended_at IS NULL').get(sessionId, owner);
  if (!session) throw new Error('CHAT_SESSION_MISSING');
  const version = session.input_version + 1;
  store.db.prepare('UPDATE chat_sessions SET input_version=? WHERE id=?').run(version, sessionId);
  const sourceTime = store.db.prepare('SELECT sent_at FROM inbox WHERE event_key=?').get(trigger)?.sent_at || now;
  const message = store.db.prepare(`INSERT INTO chat_messages(session_id,role,content,created_at,delivery_status,trigger_event,source_time)
    VALUES (?,'user',?,?,'queued',?,?)`).run(sessionId, content, now, trigger, sourceTime);
  const sourceId = Number(message.lastInsertRowid);
  const ready = !options.batchInputs || content.length >= options.longMessageChars ? now : now + options.debounceMs;
  const row = store.db.prepare(`INSERT INTO chat_turns(owner_key,session_id,trigger_event,user_message_id,model,reasoning_effort,created_at,input_version,ready_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(owner, sessionId, trigger, sourceId, model, reasoning, now, version, ready);
  const id = Number(row.lastInsertRowid);
  store.db.prepare('UPDATE chat_turns SET batch_id=id WHERE id=?').run(id);
  let leader = null;
  if (options.batchInputs) {
    const running = store.db.prepare("SELECT * FROM chat_turns WHERE session_id=? AND status='running' AND id<? ORDER BY id LIMIT 1").get(sessionId, id);
    if (running && correctionInput(content)) leader = running;
    if (!leader && correctionInput(content)) {
      const pending = store.db.prepare(`SELECT t.* FROM chat_turns t JOIN outbox o ON o.id=t.outbox_id
        WHERE t.session_id=? AND o.status='pending' AND t.id<? ORDER BY t.id DESC LIMIT 1`).get(sessionId, id);
      if (pending) {
        store.db.prepare("UPDATE outbox SET status='cancelled',error='CHAT_INPUT_CHANGED' WHERE id=?").run(pending.outbox_id);
        store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='CHAT_INPUT_CHANGED' WHERE notification_id=? AND status='pending'").run(pending.outbox_id);
        store.db.prepare("UPDATE chat_messages SET delivery_status='cancelled' WHERE id=? AND delivery_status!='sent'").run(pending.response_message_id);
        store.db.prepare("UPDATE chat_turns SET status='queued',response_message_id=NULL,outbox_id=NULL,recompute_count=MIN(1,recompute_count+1) WHERE id=?").run(pending.id);
        leader = { ...pending, status: 'queued' };
      }
    }
    if (!leader) leader = store.db.prepare(`SELECT * FROM chat_turns WHERE session_id=? AND status='queued' AND id<?
      AND ready_at>=? AND created_at>=? ORDER BY id DESC LIMIT 1`).get(sessionId, id, now, now - options.maxBatchWaitMs);
    if (leader) {
      const size = store.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(LENGTH(m.content)),0) chars FROM chat_turns t JOIN chat_messages m ON m.id=t.user_message_id WHERE t.batch_id=?').get(leader.id);
      if (size.n >= options.batchMessages || size.chars + content.length > options.batchChars) {
        if (correctionInput(content)) store.db.prepare("UPDATE chat_turns SET status='cancelled',error='CHAT_BATCH_REPLACED' WHERE id=?").run(leader.id);
        leader = null;
      }
    }
    if (leader) {
      store.db.prepare("UPDATE chat_turns SET status='batched',batch_id=? WHERE id=?").run(leader.id, id);
      const nextReady = Math.min(leader.created_at + options.maxBatchWaitMs, ready);
      store.db.prepare('UPDATE chat_turns SET trigger_event=?,input_version=?,ready_at=?,pending_correction=? WHERE id=?')
        // trigger_event is unique per inbox input; leave it on its own turn and resolve the latest member when sending.
        .run(leader.trigger_event, version, nextReady, Number(leader.status === 'running'), leader.id);
      if (leader.status === 'running') {
        // A correction absorbs pending supplements from the same batch window, preserving their source rows.
        for (const pending of store.db.prepare("SELECT id FROM chat_turns WHERE session_id=? AND status='queued' AND id>? AND id<?").all(sessionId, leader.id, id)) {
          store.db.prepare("UPDATE chat_turns SET status='batched',batch_id=? WHERE id=? OR batch_id=?").run(leader.id, pending.id, pending.id);
        }
      }
    }
  }
  const learned = learnFromMessage(store, owner, session, sourceId, now);
  // Only IDs and rejection codes are persisted here. Source text lives in the explicit memory/source tables.
  store.set('memoryReceipt:' + sourceId, { saved: learned.saved, rejected: learned.rejected });
  const result = store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(leader?.id || id);
  return { ...result, received_turn_id: id };
}

export function nextChatBatch(store, now) {
  return store.transaction(() => {
    const turn = store.db.prepare(`SELECT t.* FROM chat_turns t JOIN chat_sessions s ON s.id=t.session_id
      WHERE t.status='queued' AND t.ready_at<=? AND s.ended_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.chat_session_id=t.session_id AND o.status IN ('pending','sending'))
      ORDER BY t.id LIMIT 1`).get(now);
    if (!turn) return null;
    store.db.prepare("UPDATE chat_turns SET status='running',started_at=?,generation_version=input_version,pending_correction=0,memory_revision=? WHERE id=?")
      .run(now, memoryState(store, turn.owner_key).revision, turn.id);
    return store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(turn.id);
  });
}

export function batchInputs(store, turn) {
  return store.db.prepare(`SELECT m.*,t.trigger_event,t.id AS input_turn_id FROM chat_turns t JOIN chat_messages m ON m.id=t.user_message_id
    WHERE t.batch_id=? AND t.owner_key=? AND t.session_id=? ORDER BY m.id`).all(turn.batch_id || turn.id, turn.owner_key, turn.session_id);
}

export function draftState(store, turn) {
  const current = store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(turn.id);
  const session = store.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(turn.session_id);
  if (!current || current.status !== 'running' || !session || session.ended_at) return 'cancelled';
  if (current.input_version !== turn.input_version || memoryState(store, turn.owner_key).revision !== turn.memory_revision) return 'stale';
  return 'current';
}

export function retryChatBatch(store, turn, now = Date.now()) {
  const current = store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(turn.id);
  if (!current || current.status !== 'running' || current.recompute_count >= 1) return null;
  store.db.prepare('UPDATE chat_turns SET recompute_count=recompute_count+1,generation_version=input_version,pending_correction=0,memory_revision=?,started_at=? WHERE id=?')
    .run(memoryState(store, turn.owner_key).revision, now, turn.id);
  return store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(turn.id);
}

export function chatOutboxValid(store, item) {
  if (!item.chat_turn_id) return true;
  const turn = store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(item.chat_turn_id);
  const session = store.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(item.chat_session_id);
  return !!turn && !!session && !session.ended_at && !['cancelled', 'superseded'].includes(turn.status)
    && turn.input_version === item.input_version && memoryState(store, turn.owner_key).revision === item.memory_revision;
}
