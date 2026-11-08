import { freeze, identifier, integer, object, reject, TERMINAL_STATES } from './contracts.mjs';

export const CANCELLATION_TARGET_FIELDS=Object.freeze(['taskId','runId','attempt','kind','leaseId','externalRef']);
export function cancellationTarget(value){
  object(value,CANCELLATION_TARGET_FIELDS);
  for(const key of ['taskId','runId','leaseId','externalRef'])identifier(value[key]);integer(value.attempt);
  if(!['work','chat'].includes(value.kind))reject('INVALID_CANCELLATION_TARGET');
  return freeze(Object.fromEntries(CANCELLATION_TARGET_FIELDS.map(key=>[key,value[key]])));
}
// Additive common cancel receipt. A request acknowledgement is independent of
// terminal evidence; callers must not turn confirmed in this receipt into a
// Store terminal without a normalized event or explicit exact reconciliation.
export function cancellationReceipt(value){
  if(!value||!['unknown','cancelling',...TERMINAL_STATES].includes(value.state)||typeof value.requested!=='boolean'||typeof value.confirmed!=='boolean'||![true,false,null].includes(value.requestAccepted))reject('INVALID_CANCELLATION_RECEIPT');
  identifier(value.externalRef);identifier(value.dispatchKey);
  if(value.confirmed&&value.state!=='cancelled'||value.requestAccepted===true&&!value.requested)reject('INVALID_CANCELLATION_RECEIPT');
  return freeze(Object.fromEntries(['state','externalRef','dispatchKey','requested','confirmed','requestAccepted'].map(key=>[key,value[key]])));
}
