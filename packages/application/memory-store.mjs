import { randomBytes } from 'node:crypto';
import { clip } from './chat-options.mjs';
import { validateCandidate, deterministicCandidates, digest, localDate } from './memory-policy.mjs';
import { indexMemory, memoryTerms } from './memory-retrieval.mjs';

export function memoryState(store, owner) {
  return store.db.prepare('SELECT * FROM chat_memory_state WHERE owner_key=?').get(owner) || { owner_key: owner, revision: 0, paused: 0 };
}

export function advanceMemoryRevision(store, owner, now = Date.now(), { clearHistory = false } = {}) {
  store.db.prepare(`INSERT INTO chat_memory_state(owner_key,revision,updated_at) VALUES (?,1,?)
    ON CONFLICT(owner_key) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at`).run(owner, now);
  store.db.prepare('DELETE FROM chat_topics WHERE session_id IN (SELECT id FROM chat_sessions WHERE owner_key=?)').run(owner);
  store.db.prepare('DELETE FROM chat_summaries WHERE session_id IN (SELECT id FROM chat_sessions WHERE owner_key=?)').run(owner);
  store.db.prepare('DELETE FROM chat_memory_imports WHERE owner_key=?').run(owner);
  if (clearHistory) {
    // Chat archives remain intact, but a model cannot relearn a deletion from an old turn or a derived reply.
    const floor = store.db.prepare('SELECT COALESCE(MAX(m.id),0)+1 n FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.owner_key=?').get(owner).n;
    store.db.prepare('UPDATE chat_sessions SET context_floor=? WHERE owner_key=?').run(floor, owner);
  }
  const pending = store.db.prepare(`SELECT o.id,o.chat_turn_id FROM outbox o JOIN chat_sessions s ON s.id=o.chat_session_id
    WHERE s.owner_key=? AND o.status='pending'`).all(owner);
  for (const row of pending) {
    store.db.prepare("UPDATE outbox SET status='cancelled',error='CHAT_MEMORY_CHANGED' WHERE id=?").run(row.id);
    store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='CHAT_MEMORY_CHANGED' WHERE notification_id=? AND status='pending'").run(row.id);
    store.db.prepare("UPDATE chat_turns SET status='superseded',error='CHAT_MEMORY_CHANGED' WHERE id=? AND status='succeeded'").run(row.chat_turn_id);
    store.db.prepare("UPDATE chat_messages SET delivery_status='cancelled' WHERE id=(SELECT response_message_id FROM chat_turns WHERE id=?) AND delivery_status!='sent'").run(row.chat_turn_id);
  }
  return memoryState(store, owner).revision;
}

export function memorySource(store, owner, id) {
  return store.db.prepare(`SELECT m.*,s.persona_id FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id
    JOIN inbox i ON i.event_key=m.trigger_event WHERE m.id=? AND s.owner_key=? AND m.role='user'
    AND i.app_id=json_extract(s.owner_key,'$[0]') AND i.scope=json_extract(s.owner_key,'$[1]') AND i.sender=json_extract(s.owner_key,'$[2]')`).get(id, owner);
}

export function saveCandidates(store, owner, persona, candidates, { expectedRevision, allowedSourceIds, now = Date.now(), targetId = null } = {}) {
  return store.transaction(() => {
    const state = memoryState(store, owner);
    if (!store.chatOptions.memoryWrite || state.paused || (expectedRevision !== undefined && state.revision !== expectedRevision)) return { saved: [], rejected: ['MEMORY_DISABLED_OR_STALE'] };
    const saved = [], rejected = [];
    for (const candidate of (Array.isArray(candidates) ? candidates : []).slice(0, 8)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { rejected.push('CANDIDATE_SCHEMA_INVALID'); continue; }
      const id = Number(candidate.source_message_id);
      if (!Number.isSafeInteger(id) || (allowedSourceIds && !allowedSourceIds.includes(id))) { rejected.push('SOURCE_NOT_IN_BATCH'); continue; }
      const source = memorySource(store, owner, id);
      const session = source && store.db.prepare('SELECT memory_capture_enabled FROM chat_sessions WHERE id=?').get(source.session_id);
      if (!session?.memory_capture_enabled) { rejected.push('CAPTURE_DISABLED'); continue; }
      const checked = validateCandidate(candidate, source, persona);
      if (checked.error) { rejected.push(checked.error); continue; }
      const value = checked.value;
      let previous = targetId ? store.db.prepare("SELECT * FROM chat_memories WHERE id=? AND owner_key=? AND persona_id IN ('',?) AND status='active'").get(targetId, owner, persona)
        : store.db.prepare("SELECT * FROM chat_memories WHERE owner_key=? AND persona_id=? AND memory_key=? AND status='active'").get(owner, value.persona_id, value.memory_key);
      // A short-lived preference overlays a stable one instead of destroying it.
      if (!targetId && previous && !previous.expires_at && value.expires_at && value.kind === 'preference') {
        value.memory_key = digest('temporary:' + value.memory_key);
        previous = store.db.prepare("SELECT * FROM chat_memories WHERE owner_key=? AND persona_id=? AND memory_key=? AND status='active'").get(owner, value.persona_id, value.memory_key);
      }
      const tombstone = store.db.prepare('SELECT source_cutoff FROM chat_memory_tombstones WHERE owner_key=? AND persona_id=? AND memory_key=?').get(owner, value.persona_id, previous?.memory_key || value.memory_key);
      if (tombstone && id <= tombstone.source_cutoff) { rejected.push('FORGOTTEN_SOURCE'); continue; }
      if (targetId && !previous) { rejected.push('TARGET_UNAVAILABLE'); continue; }
      if (targetId && previous.persona_id !== value.persona_id) { rejected.push('SCOPE_CHANGE_REQUIRES_NEW_STATEMENT'); continue; }
      if (previous && previous.content === value.content && previous.event_date === value.event_date) { saved.push(previous.id); continue; }
      if (previous && source.source_time < previous.updated_at && !targetId) { rejected.push('OLDER_SOURCE'); continue; }
      let memoryId, version;
      if (previous) {
        memoryId = previous.id; version = previous.version + 1;
        store.db.prepare(`UPDATE chat_memories SET content=?,kind=?,version=?,explicit=?,valid_from=?,expires_at=?,event_date=?,event_status=?,updated_at=? WHERE id=?`)
          .run(value.content, value.kind, version, value.explicit, value.valid_from, value.expires_at, value.event_date, value.event_status, value.source_time, memoryId);
        store.db.prepare('DELETE FROM chat_memory_sources WHERE memory_id=?').run(memoryId);
      } else {
        const row = store.db.prepare(`INSERT INTO chat_memories(owner_key,persona_id,kind,memory_key,content,explicit,valid_from,expires_at,event_date,event_status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner, value.persona_id, value.kind, value.memory_key, value.content, value.explicit, value.valid_from, value.expires_at, value.event_date, value.event_status, now, value.source_time);
        memoryId = Number(row.lastInsertRowid); version = 1;
      }
      store.db.prepare('INSERT INTO chat_memory_sources(memory_id,message_id,excerpt,message_time) VALUES (?,?,?,?)').run(memoryId, id, value.source_quote, value.source_time);
      store.db.prepare('INSERT INTO chat_memory_revisions(memory_id,version,operation,source_message_id,created_at) VALUES (?,?,?,?,?)').run(memoryId, version, previous ? 'revised' : 'created', id, now);
      indexMemory(store, memoryId, value.content); saved.push(memoryId);
      advanceMemoryRevision(store, owner, now);
      if (previous) {
        // Exclude superseded statements from ordinary history while keeping the new correction visible.
        store.db.prepare('UPDATE chat_sessions SET context_floor=MAX(context_floor,?) WHERE owner_key=?').run(id, owner);
      }
    }
    if (saved.length) store.set('memoryFocus:' + owner, { ids: [...new Set(saved)], at: now });
    return { saved: [...new Set(saved)], rejected };
  });
}

export function learnFromMessage(store, owner, session, sourceId, now) {
  const source = memorySource(store, owner, sourceId);
  if (!source) return { saved: [], rejected: [] };
  return saveCandidates(store, owner, session.persona_id, deterministicCandidates(source), { allowedSourceIds: [sourceId], now });
}

export function forgetMemories(store, owner, ids, now = Date.now()) {
  return store.transaction(() => {
    const sources = new Set(); let count = 0;
    const cutoff = store.db.prepare('SELECT COALESCE(MAX(m.id),0) n FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.owner_key=?').get(owner).n;
    for (const id of ids) {
      const row = store.db.prepare("SELECT * FROM chat_memories WHERE id=? AND owner_key=? AND status!='deleted'").get(id, owner);
      if (!row) continue;
      for (const source of store.db.prepare('SELECT message_id FROM chat_memory_sources WHERE memory_id=?').all(id)) sources.add(source.message_id);
      store.db.prepare(`INSERT INTO chat_memory_tombstones(owner_key,persona_id,memory_key,source_cutoff,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(owner_key,persona_id,memory_key) DO UPDATE SET source_cutoff=MAX(source_cutoff,excluded.source_cutoff),created_at=excluded.created_at`).run(owner, row.persona_id, row.memory_key, cutoff, now);
      store.db.prepare("UPDATE chat_memories SET content='',status='deleted',version=version+1,event_date=NULL,expires_at=NULL,updated_at=? WHERE id=?").run(now, id);
      store.db.prepare('DELETE FROM chat_memory_sources WHERE memory_id=?').run(id);
      store.db.prepare('DELETE FROM chat_memory_terms WHERE memory_id=?').run(id);
      store.db.prepare('INSERT INTO chat_memory_revisions(memory_id,version,operation,created_at) VALUES (?,?,?,?)').run(id, row.version + 1, 'deleted', now);
      count++;
    }
    for (const id of sources) store.db.prepare('UPDATE chat_messages SET memory_blocked=1 WHERE id=?').run(id);
    if (count) {
      advanceMemoryRevision(store, owner, now, { clearHistory: true });
      store.set('memoryFocus:' + owner, null); store.set('memoryLastRecall:' + owner, null);
      store.set('memoryLastForgot:' + owner, { sourceIds: [...sources], at: now });
    }
    return count;
  });
}

const visible = (store, owner, persona, now) => store.db.prepare(`SELECT * FROM chat_memories WHERE owner_key=? AND persona_id IN ('',?) AND status='active'
  AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,id DESC`).all(owner, persona, now);

function selectMemory(store, owner, persona, query, now) {
  const rows = visible(store, owner, persona, now);
  const numeric = /^(?:记忆\s*#?\s*)?(\d+)[。！!吧]*$/.exec(query.trim());
  if (numeric) return rows.filter(row => row.id === Number(numeric[1]));
  const normalized = query.replace(/(?:以前记的|关于|这件事|那件事|这一条|那一条|那条|这条|删掉|忘掉|吧|[“”「」"。！!])/g, '').trim();
  if (!normalized || /^(它|这个|那个|这件|那件)$/.test(normalized)) {
    const focus = store.get('memoryFocus:' + owner) || store.get('memoryLastRecall:' + owner);
    return focus && now - focus.at < 1800000 ? rows.filter(row => focus.ids.includes(row.id)) : [];
  }
  const exact = rows.filter(row => row.content.includes(normalized) || normalized.includes(row.content));
  if (exact.length) return exact;
  const terms = new Set(memoryTerms(normalized));
  const ranked = rows.map(row => ({ row, score: memoryTerms(row.content).reduce((n, term) => n + (terms.has(term) ? term.startsWith('@') ? 4 : 1 : 0), 0) })).filter(item => item.score >= 3).sort((a, b) => b.score - a.score);
  return ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score * 1.4) ? [ranked[0].row] : ranked.slice(0, 3).map(item => item.row);
}

export function recordControl(store, owner, sessionId, trigger, text, now) {
  if (!sessionId) return null;
  const sourceTime = store.db.prepare('SELECT sent_at FROM inbox WHERE event_key=?').get(trigger)?.sent_at || now;
  return Number(store.db.prepare(`INSERT INTO chat_messages(session_id,role,content,created_at,delivery_status,trigger_event,source_time,is_control)
    VALUES (?,'user',?,?,'control',?,?,1)`).run(sessionId, text, now, trigger, sourceTime).lastInsertRowid);
}

export function routeMemoryCommand(store, owner, session, text, trigger, now, reply) {
  const persona = session?.persona_id || 'default';
  const control = () => recordControl(store, owner, session?.id, trigger, text, now);
  if (/^(?:你还记得我什么|查看记忆|记忆列表)[？?。]*$/.test(text)) {
    control(); const rows = visible(store, owner, persona, now).slice(0, 8);
    store.set('memoryFocus:' + owner, { ids: rows.map(row => row.id), at: now });
    const labels = { preference: '偏好', fact: '事实', event: '近期事情', persona: '人设互动' };
    return reply(rows.length ? rows.map(row => `记忆 ${row.id}｜${labels[row.kind]}：${clip(row.content, 85)}${row.event_date ? `（${row.event_date}，${row.event_status === 'completed' ? '已完成' : row.event_status === 'cancelled' ? '已取消' : '计划或进行中'}）` : ''}`).join('\n') + '\n可说“为什么记得记忆 编号”“修改记忆 编号：新内容”或“忘记记忆 编号”。' : '现在没有保存可用的个人记忆。');
  }
  const why = /^(?:你)?为什么记得(?:这个|这条|那条|记忆\s*#?\s*(\d+))?[？?。]*$/.exec(text);
  if (why) {
    control(); const selected = selectMemory(store, owner, persona, why[1] || '这条', now);
    if (selected.length !== 1) return reply('你指的是哪一条？可以先说“查看记忆”，再告诉我编号。');
    const sources = store.db.prepare('SELECT excerpt,message_time FROM chat_memory_sources WHERE memory_id=? ORDER BY message_time DESC LIMIT 2').all(selected[0].id);
    return reply(sources.length ? sources.map(source => `你在 ${localDate(source.message_time)} 说过：“${clip(source.excerpt, 220)}”。`).join('\n') : '这条没有可核验的来源，我不会把它当作确定的往事。');
  }
  if (/^(暂停记忆|恢复记忆|继续记忆|开启记忆)[。！!]*$/.test(text)) {
    control(); const paused = text.startsWith('暂停');
    advanceMemoryRevision(store, owner, now);
    store.db.prepare('UPDATE chat_memory_state SET paused=? WHERE owner_key=?').run(Number(paused), owner);
    return reply(paused ? '好，已暂停保存和调用个人记忆。当前这段聊天还可以正常接着聊。' : '个人记忆已恢复。');
  }
  if (/^(?:这段|接下来这段)(?:对话)?不要记[。！!]*$/.test(text)) {
    control(); if (!session) return reply('好，这段不保存个人记忆。');
    const last = store.db.prepare('SELECT batch_id FROM chat_turns WHERE session_id=? ORDER BY id DESC LIMIT 1').get(session.id);
    if (last) {
      const inputs = store.db.prepare('SELECT user_message_id FROM chat_turns WHERE batch_id=?').all(last.batch_id).map(row => row.user_message_id);
      const memories = new Set();
      for (const id of inputs) {
        store.db.prepare('UPDATE chat_messages SET memory_blocked=1 WHERE id=?').run(id);
        for (const row of store.db.prepare('SELECT memory_id FROM chat_memory_sources WHERE message_id=?').all(id)) memories.add(row.memory_id);
      }
      forgetMemories(store, owner, [...memories], now);
    }
    store.db.prepare('UPDATE chat_sessions SET memory_capture_enabled=0 WHERE id=?').run(session.id);
    advanceMemoryRevision(store, owner, now);
    return reply('好，这段不再保存新记忆，刚才这批消息形成的记忆也已移除。新开对话后恢复正常积累。');
  }
  const forget = /^(?:忘记|删除记忆|忘掉)\s*([\s\S]+?)[。！!]*$/.exec(text)
    || /^(?:以前记的|把以前记的|把记的)([\s\S]+?)(?:那条|这条)?(?:删掉|删除|忘掉)(?:吧)?[。！!]*$/.exec(text);
  if (forget) {
    control();
    const rows = /^(所有记忆|全部记忆)$/.test(forget[1]) ? store.db.prepare("SELECT id FROM chat_memories WHERE owner_key=? AND status!='deleted'").all(owner) : selectMemory(store, owner, persona, forget[1], now);
    if (!rows.length) return reply('没有找到对应的有效记忆。可以说“查看记忆”确认一下。');
    if (rows.length > 1 && !/^(所有记忆|全部记忆)$/.test(forget[1])) return reply('有几条可能符合：\n' + rows.map(row => `记忆 ${row.id}：${clip(row.content, 80)}`).join('\n') + '\n告诉我忘记哪个编号就好。');
    const count = forgetMemories(store, owner, rows.map(row => row.id), now);
    return reply(count ? '好，已经忘掉了。原聊天记录仍保留；需要一起删时，可以说“同时删除对应聊天记录”。' : '这条已经不在有效记忆里了。');
  }
  if (/^同时删除对应聊天记录[。！!]*$/.test(text)) {
    control(); const previous = store.get('memoryLastForgot:' + owner);
    if (!previous || now - previous.at > 600000) return reply('请先告诉我要忘记哪条记忆，再删除对应聊天记录。');
    for (const id of previous.sourceIds) {
      store.db.prepare("UPDATE chat_messages SET content='[已由用户删除]',memory_blocked=1 WHERE id=?").run(id);
      const turns = store.db.prepare('SELECT batch_id FROM chat_turns WHERE user_message_id=?').all(id);
      for (const turn of turns) {
        store.db.prepare("UPDATE chat_messages SET content='[已由用户删除]' WHERE id IN (SELECT response_message_id FROM chat_turns WHERE batch_id=?)").run(turn.batch_id);
        store.db.prepare("UPDATE chat_messages SET content='[已由用户删除]' WHERE role='assistant' AND turn_id=?").run(turn.batch_id);
        store.db.prepare("UPDATE chat_deliveries SET content='[已由用户删除]' WHERE turn_id=?").run(turn.batch_id);
        store.db.prepare("UPDATE outbox SET content='[已由用户删除]' WHERE chat_turn_id=?").run(turn.batch_id);
        store.db.prepare("UPDATE outbox_parts SET content='[已由用户删除]' WHERE notification_id IN (SELECT id FROM outbox WHERE chat_turn_id=?)").run(turn.batch_id);
      }
    }
    store.set('memoryLastForgot:' + owner, null);
    return reply('对应的本地聊天正文已删除。迁移前备份单独保留，不参与聊天召回。');
  }
  const revise = /^(?:修改记忆\s*#?\s*(\d+)\s*[:：]|(?:那条|这条)(?:改一下|改成|修改)[，,：:\s]*)\s*([\s\S]+)$/.exec(text);
  if (revise) {
    const sourceId = control();
    if (!sourceId || !session) return reply('请先开始一段对话，再修改记忆。');
    const focused = selectMemory(store, owner, persona, revise[1] || '那条', now);
    const rows = focused.length === 1 ? focused : selectMemory(store, owner, persona, revise[2], now);
    if (rows.length !== 1) return reply('你指的是哪条记忆？告诉我编号就能改。');
    const quote = revise[2].trim();
    const result = saveCandidates(store, owner, persona, [{ source_message_id: sourceId, source_quote: quote, content: quote }], { targetId: rows[0].id, allowedSourceIds: [sourceId], now });
    return reply(result.saved.length ? '好，已按你刚才说的改好了。' : '这次没有保存修改。请直接说完整的新事实，暂停记忆时需先恢复。');
  }
  const preview = /^预览历史记忆(?:\s+(最近\s*(\d{1,2})\s*天|\d{4}-\d{2}-\d{2}\s*至\s*\d{4}-\d{2}-\d{2}))?[。！!]*$/.exec(text);
  if (preview) {
    control(); let from = now - Math.min(30, Number(preview[2]) || 7) * 86400000, to = now;
    if (preview[1]?.includes('至')) {
      const dates = preview[1].split(/\s*至\s*/); from = Date.parse(dates[0] + 'T00:00:00+08:00'); to = Date.parse(dates[1] + 'T23:59:59+08:00');
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 31 * 86400000) return reply('请限定在 31 天以内，例如“预览历史记忆 2026-10-01 至 2026-10-07”。');
    }
    const sources = store.db.prepare(`SELECT m.* FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id
      WHERE s.owner_key=? AND s.persona_id=? AND m.role='user' AND m.is_control=0 AND m.memory_blocked=0
      AND m.source_time BETWEEN ? AND ? ORDER BY m.id DESC LIMIT 200`).all(owner, persona, from, to);
    const candidates = [];
    for (const source of sources.reverse()) for (const candidate of deterministicCandidates(source)) {
      const checked = validateCandidate(candidate, source, persona);
      if (checked.error) continue;
      const tombstone = store.db.prepare('SELECT source_cutoff FROM chat_memory_tombstones WHERE owner_key=? AND persona_id=? AND memory_key=?').get(owner, checked.value.persona_id, checked.value.memory_key);
      if (tombstone && source.id <= tombstone.source_cutoff) continue;
      const existing = store.db.prepare("SELECT id FROM chat_memories WHERE owner_key=? AND persona_id=? AND memory_key=? AND status='active'").get(owner, checked.value.persona_id, checked.value.memory_key);
      if (!existing) candidates.push(candidate);
    }
    const id = randomBytes(3).toString('hex');
    store.db.prepare('INSERT INTO chat_memory_imports(id,owner_key,memory_revision,candidates,expires_at) VALUES (?,?,?,?,?)').run(id, owner, memoryState(store, owner).revision, JSON.stringify(candidates.slice(0, 30)), now + 600000);
    return reply(candidates.length ? `仅预览最近限定范围内的普通聊天，未导入（最多 30 条）：\n${candidates.slice(0, 5).map(candidate => clip(candidate.source_quote, 90)).join('\n')}\n共 ${Math.min(30, candidates.length)} 条。确认时发送“确认导入记忆 ${id}”。` : '这段范围内没有可导入的新记忆。未修改现有记忆。');
  }
  const confirm = /^确认导入记忆\s+([a-f0-9]{6})$/i.exec(text);
  if (confirm) {
    control(); const row = store.db.prepare("SELECT * FROM chat_memory_imports WHERE id=? AND owner_key=? AND status='preview'").get(confirm[1], owner);
    if (!row || row.expires_at < now || row.memory_revision !== memoryState(store, owner).revision) return reply('这份预览已过期或记忆已变化，请重新预览。');
    const candidates = JSON.parse(row.candidates); let count = 0;
    // The preview is bounded, explicit and source-checked; it is never a scan of work tasks or Codex memory files.
    for (const candidate of candidates) count += saveCandidates(store, owner, persona, [candidate], { allowedSourceIds: [candidate.source_message_id], now }).saved.length;
    store.db.prepare("UPDATE chat_memory_imports SET status='imported',candidates='[]' WHERE id=?").run(row.id);
    return reply(count ? `已导入 ${count} 条有原话来源的记忆。` : '没有导入新记忆。可能处于暂停状态，或来源已经被排除。');
  }
  return null;
}
