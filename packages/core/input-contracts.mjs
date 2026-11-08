import { boundedText, freeze, identifier, integer, object, reject } from './contracts.mjs';

export const INPUT_VERSION = 1;
export const INPUT_DEFAULTS = Object.freeze({windowMs:250,maxFragments:16,maxBytes:32768,maxPendingPerScope:16,maxPendingPerBot:64,maxPending:256});
const ceilings = {windowMs:10000,maxFragments:64,maxBytes:65536,maxPendingPerScope:32,maxPendingPerBot:128,maxPending:512};
export const textBytes = text => new TextEncoder().encode(text).byteLength;
export function inputLimits(value={}) {
  object(value,Object.keys(INPUT_DEFAULTS));
  const result={...INPUT_DEFAULTS,...value};
  for(const key of Object.keys(result))if(integer(result[key])>ceilings[key])reject('INPUT_LIMIT_TOO_LARGE');
  return freeze(result);
}

// The trusted host supplies routing and intent. Text is never parsed for a
// target, identity, project, policy, pairing, or approval decision.
export function normalizeInput(value) {
  const operation=value?.operation;
  if(!['new','continue','correct','answer','cancel'].includes(operation))reject('INVALID_INPUT_OPERATION');
  const fields=['eventId','operation','kind'];
  if(operation!=='new')fields.push('taskId','runId','attempt');
  if(operation!=='cancel')fields.push('text');
  if(operation==='answer')fields.push('questionId','questionSeq');
  object(value,fields);
  boundedText(value.eventId,512);
  if(!['work','chat'].includes(value.kind))reject('INVALID_TASK_KIND');
  const result={eventId:value.eventId,operation,kind:value.kind};
  if(operation!=='new')Object.assign(result,{taskId:identifier(value.taskId),runId:identifier(value.runId),attempt:integer(value.attempt)});
  if(operation!=='cancel'){
    boundedText(value.text);
    if(textBytes(value.text)>8192)reject('INPUT_FRAGMENT_TOO_LARGE');
    result.text=value.text;
  }
  if(operation==='answer')Object.assign(result,{questionId:boundedText(value.questionId,128),questionSeq:integer(value.questionSeq)});
  return freeze(result);
}
