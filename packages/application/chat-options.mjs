// All switches affect ordinary chat only. Work-task permissions remain independent.
export function chatOptions(config = {}) {
  const c = config.chat || {};
  const integer = (key, fallback, min, max) => Number.isInteger(c[key]) && c[key] >= min && c[key] <= max ? c[key] : fallback;
  return {
    memoryRead: c.memoryRead !== false, memoryWrite: c.memoryWrite !== false,
    topicState: c.topicState !== false, batchInputs: c.batchInputs !== false,
    replyPolicy: c.replyPolicy !== false,
    debounceMs: integer('debounceMs', 800, 0, 2000), maxBatchWaitMs: integer('maxBatchWaitMs', 2000, 0, 5000),
    longMessageChars: integer('longMessageChars', 1000, 100, 5000),
    batchChars: integer('batchChars', 8000, 5000, 16000), batchMessages: integer('batchMessages', 12, 2, 20),
    contextChars: integer('contextChars', 14000, 2000, 32000), recentMessages: integer('recentMessages', 28, 4, 80),
    contextTokenBudget: integer('contextTokenBudget', 24000, 6000, 60000),
    memoryLimit: integer('memoryLimit', 5, 1, 8), summaryAfter: integer('summaryAfter', 12, 4, 30),
    replyChars: integer('replyChars', 3400, 900, 12000), partChars: integer('partChars', 850, 200, 900),
    maxParts: integer('maxParts', 4, 1, 4)
  };
}

export const clip = (text, length) => Array.from(String(text || '')).slice(0, length).join('');

// Conservative local estimate, not a claim about the executor's tokenizer. Actual usage is recorded when provided by Codex.
export function estimateTokens(text) {
  const value = String(text); const cjk = (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  return Math.ceil(cjk * 1.35 + (value.length - cjk) / 3);
}

export function splitChatReply(text, options) {
  const body = String(text || '').trim();
  if (!body) throw new Error('CHAT_EMPTY_REPLY');
  if (Array.from(body).length > options.replyChars) throw new Error('CHAT_REPLY_TOO_LONG');
  // Split on whole Unicode code points, preferring paragraph and sentence boundaries.
  // Never silently discard a suffix or split a surrogate pair.
  const parts = []; let remaining = Array.from(body);
  while (remaining.length) {
    let end = Math.min(options.partChars, remaining.length);
    if (end < remaining.length) {
      const candidate = remaining.slice(0, end).join('');
      const boundaries = [...candidate.matchAll(/[。！？!?；;\n](?:[”」』】）)]*)/gu)];
      const boundary = boundaries.at(-1);
      if (boundary && Array.from(candidate.slice(0, boundary.index + boundary[0].length)).length >= Math.min(80, end / 3)) end = Array.from(candidate.slice(0, boundary.index + boundary[0].length)).length;
    }
    parts.push(remaining.splice(0, end).join(''));
  }
  if (parts.length > options.maxParts) throw new Error('CHAT_TOO_MANY_PARTS');
  return parts;
}
