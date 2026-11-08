import { createHash } from 'node:crypto';

export const digest = text => createHash('sha256').update(String(text)).digest('hex');
export const explicitMemory = text => /(?:请)?(?:记住|记下来|记一下|记着|帮我记|别忘了|保存这条)/.test(text);
const secret = /密码|口令|验证码|私钥|密钥|api[ _-]?key|bearer\s|\bsk-[a-z0-9_-]{8,}|access[_-]?token/i;
const sensitive = /电话|手机号|住址|身份证|银行卡|病|诊断|抑郁|药|过敏|疾病|性取向|宗教|政治立场|\b1[3-9]\d{9}\b/;
const hypothetical = /如果|假如|假设|比如|例如|举例|示例|小说|台词|引用|转述|他说|她说|朋友|同事|他喜欢|她喜欢|[“”「」『』"<>]|```|^>/;
const entities = ['答辩', '目录', '论文', '面试', '旅行', '汇报', '考试', '搬家', '演出', '比赛', '会议', '项目'];
const clean = text => String(text).replace(/^(?:请|帮我)?(?:记住|记下来|记一下|记着|记得|保存这条)(?:啊|哦|呀)?[，,：:\s]*/, '').trim().replace(/[。！!]+$/, '');

export function localDate(at) { return new Date(at + 8 * 3600000).toISOString().slice(0, 10); }
const dayStart = date => Date.parse(date + 'T00:00:00+08:00');
const datePlus = (date, days) => new Date(dayStart(date) + days * 86400000 + 8 * 3600000).toISOString().slice(0, 10);

export function resolveEventDate(text, sourceTime) {
  const today = localDate(sourceTime);
  const full = /(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(text);
  const md = /(\d{1,2})月(\d{1,2})[日号]?/.exec(text);
  const validate = value => Number.isFinite(dayStart(value)) && localDate(dayStart(value)) === value ? value : null;
  if (full) return validate(`${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`);
  if (md) return validate(`${today.slice(0, 4)}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`);
  if (/后天/.test(text)) return datePlus(today, 2);
  if (/明天|明晚/.test(text)) return datePlus(today, 1);
  if (/今天|今晚|今夜/.test(text)) return today;
  const week = /(下周|本周|这周|周|星期|礼拜)([一二三四五六日天])/.exec(text);
  if (week) {
    const current = (new Date(dayStart(today) + 8 * 3600000).getUTCDay() + 6) % 7;
    const target = '一二三四五六日'.indexOf(week[2].replace('天', '日'));
    let delta = target - current;
    if (week[1] === '下周') delta += 7;
    else if (delta < 0 && !['本周', '这周'].includes(week[1])) delta += 7;
    return datePlus(today, delta);
  }
  return null;
}

export function eventState(text) {
  if (/取消|不去了|不办了|不用.*(?:改|做|准备)|放弃.*计划/.test(text)) return 'cancelled';
  if (!/还没|没有|没做|未完成|准备|打算|将要|计划/.test(text) && /完成|结束|做完|改完|答辩完|旅行回来了|已经.*(?:好了|通过)/.test(text)) return 'completed';
  if (/正在|还在|继续|进行中/.test(text)) return 'ongoing';
  if (/也许|可能|待定|不确定/.test(text)) return 'uncertain';
  return 'planned';
}

function slot(content, kind) {
  if (kind === 'event') return 'event:' + (entities.find(word => content.includes(word)) || clean(content));
  if (kind === 'persona') return /叫|称呼|前辈/.test(content) ? 'persona:address' : 'persona:' + clean(content);
  if (/建议|分析|先听|倾诉|吐槽|排计划/.test(content)) return 'preference:advice';
  if (/简短|啰嗦|长篇|简洁|详细解释/.test(content)) return 'preference:length';
  if (/叫我|称呼|昵称/.test(content)) return 'preference:address';
  if (kind === 'fact' && /专业|我(?:现在|目前)?学/.test(content)) return 'fact:专业';
  for (const item of ['咖啡', '香菜', '茶', '跑步', '读书', '阅读', '熬夜', '睡觉', '专业', '工作', '项目', '编程']) if (content.includes(item)) return kind + ':' + item;
  return kind + ':' + clean(content);
}

export function inferKind(text) {
  if (/约定|虚构|场景|角色|扮演|前辈|彩羽/.test(text) && !/建议|吐槽|倾诉|简短|啰嗦/.test(text)) return 'persona';
  if (entities.some(word => text.includes(word)) && /周|星期|今天|今晚|明天|后天|月\d|准备|打算|计划|改到|改成|完成|取消|结束|还没|正在|继续/.test(text)) return 'event';
  if (/喜欢|不喜欢|不喝|爱喝|(?:现在|已经|开始|平时|通常)喝|不吃|爱吃|别.*(?:建议|分析|计划)|不要.*建议|先.*听|少.*(?:建议|叫|称呼)|叫我|称呼|简短|简洁|啰嗦|吐槽.*建议|常用/.test(text)) return 'preference';
  if (/我的专业|专业(?:改|是|换)|我(?:现在|目前)?(?:是|在|学|做|从事|负责|叫)|持续.*项目/.test(text)) return 'fact';
  return null;
}

// Candidates may quote only the current user's authenticated source. Confidence and model-provided scope/key are never evidence.
export function validateCandidate(candidate, source, personaId) {
  if (!candidate || !source || source.role !== 'user' || source.memory_blocked || !source.trigger_event) return { error: 'SOURCE_UNAVAILABLE' };
  const quote = String(candidate.source_quote || '').trim();
  if (!quote || quote.length > 500 || !source.content.includes(quote)) return { error: 'SOURCE_QUOTE_MISMATCH' };
  if (secret.test(source.content)) return { error: 'SECRET' };
  if (/[？?]|我是不是|我是否|我能不能|你觉得我|我该不该|我应该|我.{0,30}吗/.test(quote)) return { error: 'QUESTION_IS_NOT_A_FACT' };
  if (/(?:他|她|妈妈|爸爸|弟弟|姐姐|同学).{0,12}(?:答辩|旅行|面试|专业|喜欢|不喝|计划|准备)/.test(quote)) return { error: 'THIRD_PERSON_FACT' };
  const explicit = explicitMemory(source.content);
  const fictional = explicit && /约定|虚构场景|角色场景/.test(quote);
  if (hypothetical.test(source.content) && !fictional) return { error: 'NOT_FIRST_PERSON_EVIDENCE' };
  if (sensitive.test(quote) && !explicit) return { error: 'SENSITIVE_REQUIRES_EXPLICIT' };
  const content = clean(quote);
  // Requiring an extractive body prevents an apparently plausible, unsupported paraphrase from becoming a fact.
  if (clean(candidate.content || quote) !== content) return { error: 'UNSUPPORTED_PARAPHRASE' };
  let kind = inferKind(content);
  if (!kind && explicit && /我|叫我/.test(content)) kind = 'fact';
  if (!kind || (!explicit && !/我|今晚|今天|明天|后天|答辩|目录|论文|旅行|面试|别|不要|称呼/.test(content))) return { error: 'INSUFFICIENT_EVIDENCE' };
  if (fictional) kind = 'persona';
  // Third-person role definitions and promises made by the assistant cannot reach this path.
  const scope = kind === 'persona' ? personaId : '';
  const at = source.source_time || source.created_at;
  const eventDate = kind === 'event' ? resolveEventDate(content, at) : null;
  const state = kind === 'event' ? eventState(content) : fictional ? 'fictional' : 'fact';
  let expires = null;
  if (kind === 'event') expires = eventDate ? dayStart(datePlus(eventDate, 1)) : at + 14 * 86400000;
  if (kind === 'preference' && /最近|暂时|今天|今晚|这次|现在不想/.test(content)) expires = /今天|今晚|这次/.test(content) ? dayStart(datePlus(localDate(at), 1)) : at + 7 * 86400000;
  return { value: { kind, content, persona_id: scope, memory_key: digest(slot(content, kind)), explicit: Number(explicit), valid_from: at, expires_at: expires, event_date: eventDate, event_status: state, source_message_id: source.id, source_quote: quote, source_time: at } };
}

export function deterministicCandidates(source) {
  const text = source.content.trim();
  if (text.length <= 400) {
    const kind = inferKind(text);
    if (kind || explicitMemory(text)) {
      // Separate two concrete plans, but keep an expression preference and its condition in one source quote.
      if (kind !== 'event') return [{ source_message_id: source.id, source_quote: text, content: text }];
    }
  }
  return text.split(/[。；;\n]/).flatMap(part => {
    const clauses = inferKind(part) === 'event' ? part.split(/[，,]/) : [part];
    return clauses.map(clause => clause.trim()).filter(clause => clause && (inferKind(clause) || explicitMemory(clause)))
      .map(quote => ({ source_message_id: source.id, source_quote: quote, content: quote }));
  }).slice(0, 6);
}
