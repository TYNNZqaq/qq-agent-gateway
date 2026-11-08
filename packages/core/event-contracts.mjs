import { digest, freeze, identifier, integer, normalizeEvent, object, reject } from './contracts.mjs';

// Provenance supplied by a TRUSTED synthetic ingress. This does not assert
// that an upstream protocol provides identifiers, ordering or replay.
function canonical(value,depth=0){
  if(depth>32)reject('EVENT_ENVELOPE_TOO_DEEP');
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
  reject('EVENT_ENVELOPE_JSON_REQUIRED');
}
export function normalizeEventEnvelope(value){
  object(value,['deliveryId','seq','occurredAt','message']);identifier(value.deliveryId);integer(value.seq);object(value.message,Object.keys(value.message??{}));
  if(typeof value.occurredAt!=='string'||!Number.isFinite(Date.parse(value.occurredAt))||new Date(value.occurredAt).toISOString()!==value.occurredAt)reject('INVALID_EVENT_TIME');
  const serialized=canonical(value);
  if(new TextEncoder().encode(serialized).byteLength>65536)reject('EVENT_ENVELOPE_TOO_LARGE');
  return freeze(JSON.parse(serialized));
}
export const eventEnvelopeDigest=value=>digest(canonical(normalizeEventEnvelope(value)));
export function normalizeEventSource(value){
  object(value,['deliveryId','envelopeDigest']);identifier(value.deliveryId);
  if(typeof value.envelopeDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.envelopeDigest))reject('EVENT_SOURCE_DIGEST_REQUIRED');
  return freeze({deliveryId:value.deliveryId,envelopeDigest:value.envelopeDigest});
}
export function normalizeAdapterEvent(value){
  // The common events interface may include Adapter diagnostics. Only this
  // projection is authority for the bridge; no private operations are read.
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||typeof value.applied!=='boolean'||typeof value.late!=='boolean')reject('EVENT_SOURCE_RECORD_INVALID');
  return freeze({event:normalizeEvent(value.event),source:normalizeEventSource(value.source),applied:value.applied,late:value.late});
}
