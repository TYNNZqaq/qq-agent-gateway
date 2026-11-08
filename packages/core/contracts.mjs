import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 1;
export class CoreError extends Error {
  constructor(code) { super(code); this.name = 'CoreError'; this.code = code; }
}
export const reject = code => { throw new CoreError(code); };
export function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k))) reject('INVALID_FIELDS');
  return value;
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) reject('INVALID_IDENTIFIER');
  return value;
}
export function integer(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) reject('INVALID_VERSION');
  return value;
}
export function boundedText(value, maximum = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) reject('INVALID_TEXT');
  return value;
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
export const SCOPE_FIELDS = Object.freeze(['hostId', 'botId', 'agentId', 'bindingId', 'bindingVersion', 'principalId', 'conversationId', 'projectId', 'policyVersion']);
export function scope(value) {
  object(value, SCOPE_FIELDS);
  return Object.freeze(Object.fromEntries(SCOPE_FIELDS.map(key => [key, key.endsWith('Version') ? integer(value[key]) : identifier(value[key])])));
}
export const scopeKey = value => digest(JSON.stringify(scope(value)));
export const principalId = (hostId, botId, externalRef) => 'p_' + digest(JSON.stringify([identifier(hostId), identifier(botId), boundedText(externalRef, 512)]));
export const conversationId = (botId, externalRef) => 'c_' + digest(JSON.stringify([identifier(botId), boundedText(externalRef, 512)]));
export const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);
export const RUN_STATES = Object.freeze(['dispatching', 'running', 'waiting_input', 'waiting_approval', 'cancelling', 'reconciling', 'unknown', ...TERMINAL_STATES]);
export const EVENT_STATES = Object.freeze({ 'run.started':'running', 'run.waiting_input':'waiting_input', 'run.waiting_approval':'waiting_approval', 'cancel.requested':'cancelling', 'run.succeeded':'succeeded', 'run.failed':'failed', 'run.cancelled':'cancelled' });
export function normalizeEvent(value) {
  object(value, ['schemaVersion','id','seq','type','occurredAt','correlationId','data']); identifier(value.id); integer(value.seq);identifier(value.correlationId);
  if(value.schemaVersion!==1)reject('EVENT_SCHEMA_UNSUPPORTED');
  if(typeof value.occurredAt!=='string'||!Number.isFinite(Date.parse(value.occurredAt))||new Date(value.occurredAt).toISOString()!==value.occurredAt)reject('INVALID_EVENT_TIME');
  const fields = {
    'run.started':[], 'run.progress':['text'], 'run.waiting_input':['questionId','prompt'],
    'run.waiting_approval':['requestId','actionFingerprint'], 'cancel.requested':[],
    'run.succeeded':['summary'], 'run.failed':['code'], 'run.cancelled':[]
  }[value.type];
  if (!fields) reject('INVALID_EVENT_TYPE');
  object(value.data, fields);
  const data=Object.fromEntries(fields.map(k => [k, boundedText(value.data[k], k==='text'||k==='summary'||k==='prompt'?8192:128)]));
  return freeze({schemaVersion:1,id:value.id,seq:value.seq,type:value.type,occurredAt:value.occurredAt,correlationId:value.correlationId,data});
}
