import { randomUUID } from 'node:crypto';
import { navigate, lineName } from './menus.mjs';
import { CHAT_MODEL, CHAT_EFFORT, selectedChatModel } from './models.mjs';
import { cancelChatSession } from './chat-batcher.mjs';
import { routeMemoryCommand } from './memory-store.mjs';

// UI routing only creates chat_turns. It never creates a Codex work task.
export const CHAT_PROVIDER_STATUS = 'codex_luna_max';
export const DEFAULT_PERSONA = Object.freeze({ id: 'default', name: '普通助手', background: '普通聊天助手', personality: '友善、诚实', speech: '清晰自然', relationship: '用户的助手', instructions: '以普通助手身份进行日常聊天。' });
const PAGE_SIZE = 8;

export function chatPreferences(store, owner) {
  return store.get('chatPreferences:' + owner, { personaId: 'default', sessionId: null });
}

export function personas(store, owner) {
  return [DEFAULT_PERSONA, ...store.db.prepare('SELECT * FROM chat_personas WHERE owner_key=? ORDER BY created_at,id').all(owner)];
}

export function currentPersona(store, owner) {
  return personas(store, owner).find(card => card.id === chatPreferences(store, owner).personaId) || DEFAULT_PERSONA;
}

export function chatMenu(store, owner) {
  return `当前模式：Codex 聊天\n当前人设：${lineName(currentPersona(store, owner).name)}\n1．开始新对话\n2．更换人设卡\n0．返回上一级\n记忆：查看记忆 / 暂停记忆；可说“本次不带记忆”。`;
}

function picker(store, owner, page = 0) {
  const cards = personas(store, owner);
  page = Math.max(0, Math.min(page, Math.ceil(cards.length / PAGE_SIZE) - 1));
  navigate(store, owner, 'chatgpt', 'personas', { page });
  const selected = currentPersona(store, owner);
  const lines = cards.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((card, index) => `${page * PAGE_SIZE + index + 2}．${lineName(card.name)}${card.id === selected.id ? '【当前】' : ''}`);
  return `当前模式：Codex 聊天\n当前人设：${lineName(selected.name)}\n人设卡（第 ${page + 1} 页）\n1．新增自定义人设\n`
    + lines.join('\n') + (page > 0 ? '\n上一页' : '') + ((page + 1) * PAGE_SIZE < cards.length ? '\n下一页' : '')
    + '\n0．返回聊天菜单\n输入本页编号或人设名称切换；切换后建立新对话。';
}

export function parsePersona(text) {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  const name = lines.shift().replace(/^名称\s*[:：]\s*/, '').trim();
  const instructions = lines.join('\n').trim();
  if (!name || name.length > 40 || /[\x00-\x1f]/.test(name) || name === DEFAULT_PERSONA.name) throw new Error('请使用 1 至 40 字符的自定义名称，不能覆盖“普通助手”。');
  if (!instructions || instructions.length > 4000) throw new Error('请在名称下一行填写人设内容（最多 4000 字符）。');
  const field = label => instructions.match(new RegExp('(?:^|\\n)' + label + '\\s*[:：]\\s*([^\\n]*)'))?.[1]?.trim() || '';
  return { name, instructions, background: field('身份背景'), personality: field('性格'), speech: field('说话方式'), relationship: field('互动关系') };
}

function startSession(store, owner, persona, now, memoryEnabled = true) {
  const preferences = chatPreferences(store, owner);
  if (preferences.sessionId) {
    cancelChatSession(store, owner, preferences.sessionId, now);
    store.db.prepare('UPDATE chat_sessions SET ended_at=COALESCE(ended_at,?) WHERE id=? AND owner_key=?').run(now, preferences.sessionId, owner);
  }
  const id = randomUUID();
  // Snapshot the persona so later edits never change an older conversation.
  const snapshot = { id: persona.id, name: persona.name, background: persona.background, personality: persona.personality, speech: persona.speech, relationship: persona.relationship, instructions: persona.instructions };
  store.db.prepare('INSERT INTO chat_sessions(id,owner_key,persona_id,persona_snapshot,created_at,memory_enabled) VALUES (?,?,?,?,?,?)').run(id, owner, persona.id, JSON.stringify(snapshot), now, Number(memoryEnabled));
  store.set('chatPreferences:' + owner, { personaId: persona.id, sessionId: id });
  navigate(store, owner, 'chatgpt', 'conversation');
  return `已开始新对话，当前人设：${lineName(persona.name)}。${memoryEnabled ? '\n有效个人记忆会保留。' : '\n本次不调用以前的个人记忆。'}\n直接发送文字即可聊天；发送“菜单”查看聊天菜单。`;
}

export function routeChat(store, owner, state, content, now, reply, trigger, config = {}) {
  if (state.screen === 'persona_input') {
    let card;
    try { card = parsePersona(content); } catch (error) { return reply(error.message + '\n发送“菜单”可退出填写。'); }
    const old = store.db.prepare('SELECT id,created_at FROM chat_personas WHERE owner_key=? AND name=?').get(owner, card.name);
    card.id = old?.id || randomUUID();
    store.db.prepare(`INSERT INTO chat_personas(owner_key,id,name,background,personality,speech,relationship,instructions,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_key,id) DO UPDATE SET name=excluded.name,background=excluded.background,personality=excluded.personality,speech=excluded.speech,relationship=excluded.relationship,instructions=excluded.instructions,updated_at=excluded.updated_at`)
      .run(owner, card.id, card.name, card.background, card.personality, card.speech, card.relationship, card.instructions, old?.created_at ?? now, now);
    return reply('人设已保存并切换。\n' + startSession(store, owner, card, now));
  }
  if (state.screen === 'personas') {
    if (content === '0') { navigate(store, owner, 'chatgpt'); return reply(chatMenu(store, owner)); }
    if (content === '下一页' || content === '上一页') return reply(picker(store, owner, (state.pending?.page || 0) + (content === '下一页' ? 1 : -1)));
    if (['1', '新增自定义人设', '自定义人设'].includes(content)) {
      navigate(store, owner, 'chatgpt', 'persona_input');
      return reply('当前模式：Codex 聊天\n请在下一条消息一次填写，例如：\n名称：星遥\n身份背景：星际领航员\n性格：沉稳、好奇\n说话方式：简洁温和\n互动关系：同行伙伴\n同名自定义人设会更新，历史对话保留原人设快照。发送“菜单”可退出。');
    }
    const cards = personas(store, owner);
    let card;
    if (/^\d+$/.test(content)) {
      const index = Number(content) - 2; const start = (state.pending?.page || 0) * PAGE_SIZE;
      if (index >= start && index < start + PAGE_SIZE) card = cards[index];
    } else card = cards.find(item => item.name === content);
    return reply(card ? '已切换人设。\n' + startSession(store, owner, card, now) : picker(store, owner, state.pending?.page || 0));
  }
  if (/^(?:这次从零聊[，,\s]*不带以前的记忆|本次不带记忆|不带记忆开始新对话|这次从零聊)[。！!]*$/.test(content)) return reply(startSession(store, owner, currentPersona(store, owner), now, false));
  if (content === '开始新对话' || (state.screen === 'menu' && content === '1')) return reply(startSession(store, owner, currentPersona(store, owner), now));
  if (content === '更换人设卡' || (state.screen === 'menu' && content === '2')) return reply(picker(store, owner));
  const preferences = chatPreferences(store, owner);
  const session = store.db.prepare('SELECT * FROM chat_sessions WHERE id=? AND owner_key=?').get(preferences.sessionId, owner);
  const memoryCommand = routeMemoryCommand(store, owner, session, content, trigger, now, reply);
  if (memoryCommand) return memoryCommand;
  if (state.screen !== 'conversation') return reply(chatMenu(store, owner));
  if (!session) { navigate(store, owner, 'chatgpt'); return reply(chatMenu(store, owner)); }
  if (!content) return reply('请输入要聊的文字。');
  if(config.executionBlockedReason)return reply('Codex 当前等待新版本隔离验证，聊天生成暂不可用。菜单、资料与状态查询仍可使用；本条没有加入生成队列。');
  const active = store.db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE status IN ('queued','running')").get().n;
  if (active >= 10) return reply('聊天队列已满，请等待前面的回复。');
  const selected = selectedChatModel(config);
  const chatTurn = store.enqueueChat(owner, trigger, session.id, content, selected.model, selected.reasoning, now);
  return { accepted: true, chatTurn };
}
