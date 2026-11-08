import { clip, estimateTokens } from './chat-options.mjs';
import { batchInputs } from './chat-batcher.mjs';
import { memoryState } from './memory-store.mjs';
import { retrieveMemories } from './memory-retrieval.mjs';
import { eventState, inferKind, localDate } from './memory-policy.mjs';

export function buildChatContext(store, turn, now = Date.now()) {
  const entered = performance.now(); const options = store.chatOptions;
  const session = store.db.prepare('SELECT * FROM chat_sessions WHERE id=? AND owner_key=?').get(turn.session_id, turn.owner_key);
  if (!session) throw new Error('CHAT_SESSION_MISSING');
  const inputs = batchInputs(store, turn);
  const state = memoryState(store, turn.owner_key);
  const current = inputs.filter(row => row.id >= session.context_floor && row.content !== '[已由用户删除]');
  const query = current.map(row => row.content).join('\n');
  const memoryEnabled = options.memoryRead && !state.paused && session.memory_enabled;
  const currentIds = new Set(inputs.map(row => row.id));
  const memories = memoryEnabled ? retrieveMemories(store, turn.owner_key, session.persona_id, query, { now, limit: options.memoryLimit + 3 })
    .filter(row => !store.db.prepare('SELECT message_id FROM chat_memory_sources WHERE memory_id=?').all(row.id).every(source => currentIds.has(source.message_id)))
    .slice(0, options.memoryLimit) : [];
  if (memories.length) store.set('memoryLastRecall:' + turn.owner_key, { ids: memories.map(row => row.id), at: now });
  const inputIds = new Set(inputs.map(row => row.id));
  const upper = Math.max(...inputs.map(row => row.id), turn.user_message_id);
  const users = store.db.prepare(`SELECT m.id,m.content,m.created_at FROM chat_messages m JOIN chat_turns t ON t.user_message_id=m.id
    WHERE m.session_id=? AND m.role='user' AND m.is_control=0 AND m.id>=? AND m.id<=? AND m.delivery_status!='not_sent'
    ORDER BY m.id DESC LIMIT ?`).all(session.id, session.context_floor, upper, options.recentMessages * 2)
    .filter(row => !inputIds.has(row.id)).map(row => ({ role: 'user', content: row.content, at: row.created_at, order: row.id }));
  const sent = store.db.prepare(`SELECT d.* FROM chat_deliveries d JOIN chat_turns t ON t.id=d.turn_id
    WHERE d.session_id=? AND t.user_message_id>=? AND d.turn_id!=? ORDER BY d.sent_at DESC,d.outbox_id DESC,d.part_no DESC LIMIT ?`)
    .all(session.id, session.context_floor, turn.id, options.recentMessages * 2)
    .map(row => ({ role: 'assistant', content: row.content, at: row.sent_at, order: row.outbox_id + row.part_no / 10 }));
  const history = [...users, ...sent].sort((a, b) => a.at - b.at || (a.role === b.role ? a.order - b.order : a.role === 'user' ? -1 : 1));
  const sources = current.map(row => ({ id: row.id, text: clip(row.content, 5000), at: new Date(row.source_time || row.created_at).toISOString(), memory_allowed: !!(!row.memory_blocked && options.memoryWrite && !state.paused && session.memory_capture_enabled) }));
  let budget = options.contextChars - query.length - 2000; const recent = [];
  for (const row of history.slice(-options.recentMessages).reverse()) {
    if (budget <= 0) break;
    if (row.content.length > budget) continue;
    budget -= row.content.length; recent.unshift({ role: row.role, content: row.content });
  }
  const topic = options.topicState ? store.db.prepare('SELECT * FROM chat_topics WHERE session_id=? AND memory_revision=?').get(session.id, state.revision) : null;
  const summary = options.topicState ? store.db.prepare('SELECT * FROM chat_summaries WHERE session_id=? AND memory_revision=?').get(session.id, state.revision) : null;
  const context = {
    persona: JSON.parse(session.persona_snapshot), date: localDate(now), time_zone: 'Asia/Shanghai',
    memory_enabled: !!memoryEnabled,
    memories: memories.map(row => ({ kind: row.kind, text: clip(row.content, 220), source_date: localDate(row.valid_from), valid_until: row.expires_at ? new Date(row.expires_at).toISOString() : null, event_date: row.event_date,
      state: row.expires_at && row.expires_at <= now && row.kind === 'event' ? 'past_unconfirmed' : row.event_status, version: row.version, scope: row.persona_id ? 'current_persona' : 'user' })),
    topic: topic ? { text: clip(topic.content, 500), state: topic.state } : null,
    summary: summary ? clip(summary.content, 800) : null,
    messages: [...recent, { role: 'user', content: query || '用户刚才要求更新或忘记记忆。不要复述已排除的内容，简短接话即可。' }],
    current_sources: sources,
    unanswered_user_inputs: store.db.prepare(`SELECT id,content FROM chat_messages WHERE session_id=? AND role='user' AND is_control=0
      AND id>=? AND id<? AND delivery_status IN ('queued','awaiting_delivery','failed') ORDER BY id DESC LIMIT 6`)
      .all(session.id, session.context_floor, Math.min(...inputs.map(row => row.id))).reverse().map(row => clip(row.content, 300)),
    memory_receipts: current.map(row => store.get('memoryReceipt:' + row.id)).filter(Boolean).map(receipt => ({ saved: receipt.saved.length > 0, saved_count: receipt.saved.length, rejection_reasons: receipt.rejected })),
    recent_replies: options.replyPolicy ? sent.sort((a, b) => b.at - a.at || b.order - a.order).slice(0, 3).reverse().map(row => clip(row.content, 240)) : []
  };
  const estimated = () => estimateTokens(JSON.stringify(context)) + 2400;
  while (estimated() > options.contextTokenBudget && context.messages.length > 1) context.messages.shift();
  if (estimated() > options.contextTokenBudget) context.summary = null;
  while (estimated() > options.contextTokenBudget && context.unanswered_user_inputs.length) context.unanswered_user_inputs.shift();
  while (estimated() > options.contextTokenBudget && context.memories.length) context.memories.pop();
  if (estimated() > options.contextTokenBudget) context.topic = null;
  if (estimated() > options.contextTokenBudget) throw new Error('CHAT_CONTEXT_TOO_LARGE');
  store.db.prepare("UPDATE chat_turns SET timings=json_set(timings,'$.estimated_context_tokens',?) WHERE id=?").run(estimated(), turn.id);
  store.db.prepare("UPDATE chat_turns SET timings=json_set(timings,'$.retrieval_ms',?,'$.queue_ms',?) WHERE id=?").run(Number((performance.now() - entered).toFixed(3)), Math.max(0, now - turn.created_at), turn.id);
  return context;
}

export function updateTopic(store, turn, proposed, now = Date.now()) {
  if (!store.chatOptions.topicState) return;
  const session = store.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(turn.session_id);
  const inputs = batchInputs(store, turn).filter(row => !row.memory_blocked && row.id >= session.context_floor);
  if (!inputs.length) return;
  const ids = inputs.map(row => row.id);
  let content = inputs.map(row => row.content).join('\n');
  if (proposed && ids.includes(Number(proposed.source_message_id)) && typeof proposed.focus_quote === 'string'
    && inputs.find(row => row.id === Number(proposed.source_message_id))?.content.includes(proposed.focus_quote)) content = proposed.focus_quote;
  const revision = memoryState(store, turn.owner_key).revision;
  store.db.prepare(`INSERT INTO chat_topics(session_id,content,state,source_ids,memory_revision,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET content=excluded.content,state=excluded.state,source_ids=excluded.source_ids,memory_revision=excluded.memory_revision,updated_at=excluded.updated_at`)
    .run(turn.session_id, clip(content, 600), inferKind(content) === 'event' ? eventState(content) : 'ongoing', JSON.stringify(ids), revision, now);
  const previous = store.db.prepare('SELECT through_message_id FROM chat_summaries WHERE session_id=?').get(turn.session_id)?.through_message_id || 0;
  const rows = store.db.prepare(`SELECT m.* FROM chat_messages m JOIN chat_turns t ON t.user_message_id=m.id
    WHERE m.session_id=? AND m.id>=? AND m.id<=? AND m.id>? AND m.memory_blocked=0 ORDER BY m.id`)
    .all(turn.session_id, session.context_floor, Math.max(...ids), previous);
  if (rows.length < store.chatOptions.summaryAfter && rows.reduce((n, row) => n + row.content.length, 0) < store.chatOptions.contextChars / 2) return;
  // A bounded, extractive summary does not invent completion, emotion labels or assistant commitments, and costs no extra model call.
  const selected = rows.slice(-8);
  const summary = selected.map(row => `${localDate(row.source_time || row.created_at)} 用户原话：${clip(row.content, 90)}`).join('\n');
  store.db.prepare(`INSERT INTO chat_summaries(session_id,content,source_ids,through_message_id,memory_revision,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET content=excluded.content,source_ids=excluded.source_ids,through_message_id=excluded.through_message_id,memory_revision=excluded.memory_revision,updated_at=excluded.updated_at`)
    .run(turn.session_id, clip(summary, 800), JSON.stringify(selected.map(row => row.id)), Math.max(...ids), revision, now);
}
