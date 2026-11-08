// CJK bigrams plus explicit, reviewable synonym families. No FTS tokenizer or cloud embedding is assumed.
const families = [
  ['coffee', /咖啡|拿铁|美式|卡布奇诺/], ['tea', /喝茶|红茶|绿茶|乌龙/], ['travel', /旅行|旅游|出游|出行/],
  ['defense', /答辩|答辨/], ['outline', /目录|提纲|大纲/], ['interview', /面试|应聘/],
  ['vent', /吐槽|倾诉|烦|委屈|累|泄气|难受|被打回|被退回|压力|心情不好/],
  ['replylength', /简短|长篇|啰嗦|简洁|详细解释|简短一点/], ['nickname', /称呼|叫我|名字|昵称|前辈/],
  ['reading', /读书|阅读|看书|小说/], ['running', /跑步|慢跑|晨跑/], ['code', /编程|写代码|程序开发/],
  ['food', /吃饭|午饭|晚饭|餐厅|菜品/], ['cilantro', /香菜|芫荽/], ['sleep', /睡觉|睡眠|熬夜|作息/],
  ['study', /专业|学习方向|学科/], ['project', /项目|作品|创作/]
];

export function memoryTerms(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase(); const terms = new Set();
  for (const chunk of normalized.match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_-]+/gu) || []) {
    if (/^[a-z0-9]/.test(chunk)) { terms.add(chunk); continue; }
    const chars = Array.from(chunk);
    for (let n = 2; n <= 3; n++) for (let i = 0; i <= chars.length - n; i++) terms.add(chars.slice(i, i + n).join(''));
  }
  for (const [name, pattern] of families) if (pattern.test(normalized)) terms.add('@' + name);
  return [...terms].slice(0, 500);
}

export function indexMemory(store, id, content) {
  store.db.prepare('DELETE FROM chat_memory_terms WHERE memory_id=?').run(id);
  const insert = store.db.prepare('INSERT OR IGNORE INTO chat_memory_terms(memory_id,term) VALUES (?,?)');
  for (const term of memoryTerms(content)) insert.run(id, term);
}

export function retrieveMemories(store, owner, persona, query, { now = Date.now(), limit = 5 } = {}) {
  if (!/我|我的|记得|之前|上次/.test(query) && /分子式|定义|公式|的原理|是什么|怎么萃取|如何萃取|虚构.*角色|小说.*角色/.test(query)) return [];
  const terms = new Set(memoryTerms(query));
  const continuation = /接着|继续.*(?:昨天|之前|那个)|昨天那个|上次那|那件事/.test(query);
  const rows = store.db.prepare(`SELECT * FROM chat_memories WHERE owner_key=? AND persona_id IN ('',?) AND status='active'
    AND valid_from<=? AND (expires_at IS NULL OR expires_at>? OR (?=1 AND kind='event' AND event_status IN ('planned','ongoing','uncertain') AND expires_at>?))`)
    .all(owner, persona, now, now, Number(continuation), now - 7 * 86400000);
  const ranked = [];
  const lookup = store.db.prepare('SELECT term FROM chat_memory_terms WHERE memory_id=?');
  for (const row of rows) {
    let score = 0; let matches = 0;
    for (const { term } of lookup.all(row.id)) if (terms.has(term)) {
      matches++; score += term.startsWith('@') ? 4 : Array.from(term).length === 3 ? 1.8 : 1;
    }
    if (continuation && row.kind === 'event' && ['planned', 'ongoing', 'uncertain'].includes(row.event_status) && now - row.updated_at < 7 * 86400000) score += 5;
    // A reply-style preference is relevant when the user is venting; unrelated questions get no injected profile.
    if (row.kind === 'preference' && terms.has('@vent') && /建议|分析|先听|倾诉|吐槽/.test(row.content)) score += 4;
    if (score < 3 || (matches === 0 && !continuation)) continue;
    if (row.kind === 'event' && ['completed', 'cancelled'].includes(row.event_status)) score *= 0.8;
    score += row.explicit ? 0.25 : 0;
    score += Math.max(0, 1 - (now - row.updated_at) / (30 * 86400000)) * 0.3;
    ranked.push({ ...row, score });
  }
  return ranked.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at || b.id - a.id).slice(0, limit);
}
