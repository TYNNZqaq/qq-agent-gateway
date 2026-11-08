import { boundedText, digest, freeze, identifier, reject } from '../../core/contracts.mjs';

export const PINNED_PROTOCOL='codex-app-server/0.163.0-alpha.11.2';
// Protocol constants only. There is no process, socket, account or SDK here.
export const METHODS=freeze({initialize:'initialize',initialized:'initialized',models:'model/list',open:'thread/start',submit:'turn/start',input:'turn/steer',cancel:'turn/interrupt',read:'thread/read'});
export const DESCRIPTOR=freeze({id:'codex-offline-reference',version:'1.0.0',contractVersion:1,protocolRange:PINNED_PROTOCOL,capabilities:{
  sessions:{status:'degraded',reason:'Pinned schema and historical empty ephemeral session only; this module uses synthetic transport.'},
  input:{status:'unsupported',reason:'Synthetic mapping only. No real turn or mid-turn input verified.'},
  cancel:{status:'unsupported',reason:'An interrupt acknowledgement is not cancellation confirmation. No real cancellation verified.'},
  reconcile:{status:'degraded',reason:'Synthetic owned-turn observation only; unknown submissions without a turn id stay unknown.'},
  media:{status:'unsupported',reason:'Text-only offline reference. No attachments or artifact delivery.'},
  toolApproval:{status:'unsupported',reason:'Independent local approval is not implemented; ordinary answers cannot approve tools.'},
  fileIsolation:{status:'unsupported',reason:'No OS, Shell, network, inherited tool or MCP execution isolation verified.'},
  modelSelection:{status:'unsupported',reason:'Only a synthetic explicit model list is used; no real login or usable model verified.'}
}});

export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const fingerprint=value=>digest(canonical(value));
export function protocolText(text){boundedText(text,32768);if(new TextEncoder().encode(text).byteLength>32768)reject('CODEX_TEXT_TOO_LARGE');return text;}
export const textInput=text=>[{type:'text',text:protocolText(text),text_elements:[]}];
export const initializeParams=()=>({clientInfo:{name:'qq_gateway_offline_reference',version:'1.0.0'},capabilities:{experimentalApi:false}});
export const openParams=model=>({model:identifier(model),ephemeral:true,sandbox:'read-only',approvalPolicy:'never'});
export const submitParams=(threadId,model,text,key)=>({threadId,model,input:textInput(text),clientUserMessageId:key,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
export const steerParams=(threadId,turnId,text,key)=>({threadId,expectedTurnId:turnId,input:textInput(text),clientUserMessageId:key});
export function turnState(turn){
  identifier(turn?.id);
  const states={inProgress:'running',completed:'succeeded',interrupted:'cancelled',failed:'failed'};
  if(!Object.hasOwn(states,turn.status))reject('CODEX_UNKNOWN_TURN_STATUS');
  const state=states[turn.status];
  if(!Array.isArray(turn.items))reject('CODEX_INVALID_TURN');
  return state;
}

// The delivery id/seq/time belong to a trusted synthetic transport envelope.
// App Server notifications themselves provide no reliable event sequence/id.
export function decode(message){
  if(!message||typeof message.method!=='string'||!message.params)reject('CODEX_INVALID_MESSAGE');
  const p=message.params,threadId=identifier(p.threadId),turnId=identifier(p.turn?.id??p.turnId);
  let type,data={},question=null;
  switch(message.method){
    case 'turn/started':
      if(turnState(p.turn)!=='running')reject('CODEX_INVALID_TURN');
      type='run.started';break;
    case 'turn/completed':{
      const state=turnState(p.turn);
      if(state==='running')reject('CODEX_INVALID_TERMINAL');
      type='run.'+state;
      if(state==='succeeded')data={summary:'Upstream turn completed; artifacts, delivery and goal acceptance are separate.'};
      if(state==='failed')data={code:'CODEX_TURN_FAILED'};
      break;
    }
    case 'item/agentMessage/delta':
      identifier(p.itemId);type='run.progress';data={text:boundedText(p.delta)};break;
    case 'item/tool/requestUserInput':{
      if(message.id===undefined||p.isBlocking!==true||!Array.isArray(p.questions)||p.questions.length!==1)return {threadId,turnId,reason:'CODEX_QUESTION_UNSUPPORTED'};
      const q=p.questions[0];
      if(q.isSecret||q.options?.length)return {threadId,turnId,reason:'CODEX_QUESTION_UNSUPPORTED'};
      const questionId=identifier(q.id);boundedText(q.question);identifier(p.itemId);
      if(typeof message.id!=='string'&&!Number.isSafeInteger(message.id))reject('CODEX_INVALID_RPC_ID');
      type='run.waiting_input';data={questionId,prompt:q.question};question={questionId,rpcId:message.id};break;
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
      if(message.id===undefined)reject('CODEX_INVALID_RPC_ID');
      type='run.waiting_approval';data={requestId:'approval_'+fingerprint([message.method,message.id]),actionFingerprint:fingerprint(message)};break;
    case 'model/rerouted':return {threadId,turnId,reason:'CODEX_MODEL_REROUTED'};
    case 'error':return {threadId,turnId,reason:'CODEX_RUNTIME_ERROR'};
    default:return {threadId,turnId,reason:'CODEX_EVENT_UNSUPPORTED'};
  }
  return {threadId,turnId,type,data,question};
}
