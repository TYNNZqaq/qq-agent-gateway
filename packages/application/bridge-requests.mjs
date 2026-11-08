import {approvalReplyIsFresh} from './approval-clock.mjs';
export const pendingKey = id => 'bridgeRequest:' + id;

export function routeBridgeAnswer(store, owner, content, now = Date.now(), sentAt = now,{trigger}={}) {
  const match = /^回答\s+B([a-f0-9-]{36})\s*[:：]\s*([\s\S]+)$/i.exec(content);
  if (!match) return null;
  const request = store.get(pendingKey(match[1]));
  if (!request || request.kind !== 'question' || request.owner !== owner || request.status !== 'pending' || request.expiresAt <= now) return '该提问已过期或不属于当前本人。';
  if (!approvalReplyIsFresh(store,owner,trigger,{sentAt},{noticeId:request.notificationId,createdAt:request.createdAt,now})) return '这条回答已过期，请重新回答当前问题。';
  const questions = request.questions || [];
  if (questions.some(question => question.isSecret)) return '敏感问题请在本机处理。';
  let values;
  if (questions.length === 1) values = { [questions[0].id]: match[2].trim() };
  else { try { values = JSON.parse(match[2]); } catch { return '多题答案请使用 JSON 对象，以题目 id 为键。'; } }
  if (!values || Array.isArray(values) || typeof values !== 'object' || Object.keys(values).length !== questions.length) return '答案数量与当前问题不一致。';
  const answers = {};
  for (const question of questions) {
    const text = values[question.id];
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return '答案不能为空或超过 2000 字符。';
    answers[question.id] = { answers: [text.trim()] };
  }
  store.set(pendingKey(match[1]), { ...request, status: 'queued', answers });
  return '已登记答案，等待原插件会话确认。';
}
