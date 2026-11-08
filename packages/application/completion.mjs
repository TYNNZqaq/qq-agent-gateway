// Keep the final answer's paragraphs, indentation, code and full length.
// Credential masking applies before splitting, so a boundary cannot expose it.
export function completionText(value) {
  return String(value ?? '')
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|$)/g, '[私钥已隐藏]')
    .replace(/((?:password|passwd|pwd|secret)["']?[ \t]*[:=][ \t]*["']?)[^\s"',;}\]]+/gi, '$1[已隐藏]')
    .replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/)[^@\s]+:[^@\s]+@/gi, '$1[凭据已隐藏]@')
    .replace(/(?:Bearer|QQBot)[ \t]+[^\s]+/gi, '[凭据已隐藏]')
    .replace(/((?:app.?secret|client.?secret|access.?token|refresh.?token|api.?key|token)[ \t]*["']?[ \t]*[:=][ \t]*["']?)[^\s"',}]+/gi, '$1[已隐藏]')
    .replace(/绑定[\s:：+＋]*[a-f0-9]{24}/gi, '绑定 [已隐藏]')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, '[已隐藏]');
}

export function formatCompletion(heading, value) {
  const body = completionText(value);
  const label = String(heading);
  const chunks = []; let rest = body;
  // 800 UTF-16 units leaves room for identity and part numbering within the
  // established 900-unit message size; do not cut CRLF or a surrogate pair.
  const budget = Math.max(32, Math.min(800, 900 - label.length - 24));
  while (rest.length > budget) {
    let end = budget;
    const newline = rest.lastIndexOf('\n', budget - 1);
    if (newline >= budget / 2) end = newline + 1;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1]) || (rest[end - 1] === '\r' && rest[end] === '\n')) end--;
    chunks.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  chunks.push(rest);
  const parts = chunks.map((chunk, index) => label + (chunks.length > 1 ? `（${index + 1}/${chunks.length}）` : '') + '\n\n' + chunk);
  return { body, content: label + '\n\n' + body, parts };
}

export const desktopNoticeId = number => `D${String(number).padStart(6, '0')}`;
