import { freeze, identifier, integer, normalizeEvent, object, reject, scope, scopeKey, TERMINAL_STATES } from '../../core/contracts.mjs';
import { eventEnvelopeDigest, normalizeEventEnvelope, normalizeEventSource } from '../../core/event-contracts.mjs';
import { DESCRIPTOR, METHODS, PINNED_PROTOCOL, decode, fingerprint, initializeParams, openParams, protocolText, steerParams, submitParams, turnState } from './protocol.mjs';

const clone=value=>structuredClone(value);
const targetFields=['scope','taskId','runId','attempt','kind','leaseId','externalRef'];
const terminal=run=>TERMINAL_STATES.includes(run.state);
// Trusted offline composition only. No real-transport factory, implicit login,
// timer, model fallback or production registration is supplied by this module.
export class CodexOfflineAdapter {
  #owner;#transport;#journal;#authorize;#state;#revision=0;#ready=false;#closed=false;#faulted=false;#models=new Set();#busy=new Set();#probePromise;
  constructor({hostId,agentId,transport,journal,authorize}){
    this.#owner={hostId:identifier(hostId),agentId:identifier(agentId)};
    if(transport?.mode!=='synthetic'||transport?.protocolVersion!==PINNED_PROTOCOL||transport?.hostId!==hostId||transport?.agentId!==agentId||['request','notify','respond','prepare','close'].some(k=>typeof transport[k]!=='function'))reject('CODEX_SYNTHETIC_TRANSPORT_REQUIRED');
    if(!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||typeof authorize!=='function')reject('CODEX_HOST_DEPENDENCIES_REQUIRED');
    this.#transport=transport;this.#journal=journal;this.#authorize=authorize;
    const saved=journal.load();
    this.#state=saved?clone(saved):{schemaVersion:1,revision:0,owner:this.#owner,nextRequest:1,sessions:[],runs:[]};
    this.#validateJournal();
    this.#revision=this.#state.revision;
    // A new object is a new connection. Never replay saved requests on reopen.
    for(const session of this.#state.sessions)if(session.state==='opening')session.state='unknown';
    for(const run of this.#state.runs){if(!terminal(run))run.state='unknown';for(const op of run.operations)if(op.state==='dispatching')op.state='unknown';}
    this.#save();
  }
  #validateJournal(){
    const s=this.#state;
    if(s.schemaVersion!==1||fingerprint(s.owner)!==fingerprint(this.#owner)||!Array.isArray(s.sessions)||!Array.isArray(s.runs)||s.sessions.length>32||s.runs.length>128)reject('CODEX_JOURNAL_MISMATCH');
    integer(s.nextRequest);integer(s.revision,0);
    const sessions=new Set(),threads=new Set(),runs=new Set(),refs=new Set(),keys=new Set();
    for(const session of s.sessions){this.#scope(session.scope);identifier(session.sessionId);identifier(session.ref);identifier(session.modelRef);
      if(!['open','opening','unknown'].includes(session.state)||sessions.has(session.ref))reject('CODEX_JOURNAL_MISMATCH');sessions.add(session.ref);
      if(session.threadId){identifier(session.threadId);if(threads.has(session.threadId))reject('CODEX_JOURNAL_MISMATCH');threads.add(session.threadId);}
    }
    for(const run of s.runs){this.#scope(run.scope);for(const k of ['taskId','runId','dispatchKey','leaseId'])identifier(run[k]);integer(run.attempt);integer(run.lastSeq,0);
      const session=s.sessions.find(x=>x.ref===run.sessionRef);
      if(!session||scopeKey(session.scope)!==scopeKey(run.scope)||!['work','chat'].includes(run.kind)||!['dispatching','running','waiting_input','waiting_approval','cancelling','unknown',...TERMINAL_STATES].includes(run.state)||runs.has(run.runId)||keys.has(run.dispatchKey))reject('CODEX_JOURNAL_MISMATCH');
      runs.add(run.runId);keys.add(run.dispatchKey);
      if(run.turnId){identifier(run.turnId);if(run.externalRef!==this.#external(session,run))reject('CODEX_JOURNAL_MISMATCH');}
      if(run.externalRef){if(refs.has(run.externalRef))reject('CODEX_JOURNAL_MISMATCH');refs.add(run.externalRef);}
      if(typeof run.approvalPending!=='boolean'||typeof run.cancelRequested!=='boolean'||!Array.isArray(run.operations)||run.operations.length>64||!Array.isArray(run.events)||!Array.isArray(run.observations)||run.events.length+run.observations.length>256)reject('CODEX_JOURNAL_MISMATCH');
      const operationKeys=new Set();
      for(const op of run.operations){identifier(op.key);if(operationKeys.has(op.key)||!['dispatching','accepted','unknown','rejected'].includes(op.state)||typeof op.fingerprint!=='string')reject('CODEX_JOURNAL_MISMATCH');operationKeys.add(op.key);}
      for(const record of run.events){const event=normalizeEvent(record.event);if(event.correlationId!==run.dispatchKey)reject('CODEX_JOURNAL_MISMATCH');if(record.source!==undefined)normalizeEventSource(record.source);}
    }
  }
  #scope(value){const checked=scope(value);if(checked.hostId!==this.#owner.hostId||checked.agentId!==this.#owner.agentId)reject('CODEX_SCOPE_MISMATCH');return checked;}
  #available(){
    if(this.#closed||this.#faulted)reject('CODEX_ADAPTER_UNAVAILABLE');
    let current;try{current=this.#journal.load();}catch{this.#faulted=true;reject('CODEX_JOURNAL_UNAVAILABLE');}
    if(current?.revision!==this.#revision){this.#faulted=true;reject('CODEX_JOURNAL_FENCED');}
  }
  #save(){
    try{
      this.#state.revision=this.#revision+1;
      // The trusted journal must atomically compare and commit this revision.
      // Reopening fences an older object before it can dispatch or overwrite.
      if(this.#journal.commit(clone(this.#state),this.#revision)!==true)throw Error();
      this.#revision=this.#state.revision;
    }catch{this.#faulted=true;reject('CODEX_JOURNAL_UNAVAILABLE');}
  }
  #session(ref,value){this.#available();const checked=this.#scope(value),session=this.#state.sessions.find(x=>x.ref===ref&&scopeKey(x.scope)===scopeKey(checked));if(!session)reject('CODEX_OWNED_SESSION_REQUIRED');return session;}
  #run(session,request){
    this.#scope(request.scope);
    const run=this.#state.runs.find(x=>x.runId===request.runId&&x.sessionRef===session.ref);
    if(!run||scopeKey(run.scope)!==scopeKey(request.scope)||['taskId','attempt','kind','leaseId','externalRef'].some(k=>request[k]!==run[k]))reject('CODEX_RUN_OWNERSHIP_MISMATCH');
    return run;
  }
  #external(session,run){return 'cx_'+fingerprint([this.#owner,session.ref,session.threadId,run.taskId,run.runId,run.attempt,run.turnId]);}
  #permission(operation,request,phase){
    this.#available();
    // Synchronous by contract: no await between this check and fake dispatch.
    let decision;try{decision=this.#authorize(freeze(clone({operation,phase,...request,executionApproved:false})));}catch{reject('CODEX_AUTHORIZATION_REJECTED');}
    if(decision!==true)reject('CODEX_AUTHORIZATION_REJECTED');
  }
  async #request(method,params,request,guard,controlOperation=null){
    await this.probe();
    const id='rpc_'+this.#state.nextRequest++;this.#save();
    const frame=freeze({id,method,params});
    await this.#transport.prepare(frame);
    const authorization=controlOperation?{...request,controlOperation}:request;
    guard();this.#permission(method,authorization,'before');
    // Only this injected synthetic transport can consume a protocol frame.
    const result=await this.#transport.request(frame);
    this.#permission(method,authorization,'after');
    return result;
  }
  probe(){
    this.#available();if(this.#ready)return Promise.resolve(this.#probeResult());
    if(!this.#probePromise)this.#probePromise=this.#probe().catch(()=>{this.#faulted=true;reject('CODEX_HANDSHAKE_FAILED');});
    return this.#probePromise;
  }
  async #probe(){
    const initialized=await this.#transport.request(freeze({id:'initialize',method:METHODS.initialize,params:initializeParams()}));
    if(typeof initialized?.userAgent!=='string'||!initialized.userAgent.includes('0.163.0-alpha.11.2'))reject('CODEX_VERSION_MISMATCH');
    this.#available();await this.#transport.notify(freeze({method:METHODS.initialized}));
    const response=await this.#transport.request(freeze({id:'models',method:METHODS.models,params:{includeHidden:false,limit:100}}));
    if(!Array.isArray(response?.data)||response.data.length>100||response.nextCursor)reject('CODEX_MODEL_LIST_INCOMPLETE');
    for(const model of response.data){identifier(model.model);if(model.hidden===false)this.#models.add(model.model);}
    this.#available();this.#ready=true;return this.#probeResult();
  }
  #probeResult(){return freeze({descriptor:DESCRIPTOR,protocolVersion:PINNED_PROTOCOL,synthetic:true,realRuntime:false,models:[...this.#models]});}
  async openSession(value,request){
    this.#available();const checked=this.#scope(value);object(request,['sessionId','modelRef']);identifier(request.sessionId);identifier(request.modelRef);
    await this.probe();if(!this.#models.has(request.modelRef))reject('CODEX_MODEL_UNAVAILABLE');
    const ref='cs_'+fingerprint([checked,request.sessionId]);
    const prior=this.#state.sessions.find(x=>x.ref===ref);
    if(prior){if(prior.modelRef!==request.modelRef)reject('CODEX_SESSION_MODEL_CONFLICT');return freeze({sessionRef:ref,state:prior.state,synthetic:true});}
    if(this.#state.sessions.length>=32)reject('CODEX_SESSION_CAPACITY');
    const session={scope:checked,sessionId:request.sessionId,modelRef:request.modelRef,ref,threadId:null,state:'opening'};
    this.#state.sessions.push(session);this.#save();
    try{
      const result=await this.#request(METHODS.open,openParams(request.modelRef),{scope:checked,sessionId:request.sessionId},()=>{if(session.state!=='opening')reject('CODEX_SESSION_CHANGED');});
      identifier(result?.thread?.id);
      if(result.model!==request.modelRef||result.thread.ephemeral!==true||result.sandbox?.type!=='readOnly'||result.sandbox.networkAccess===true||result.approvalPolicy!=='never'||this.#state.sessions.some(x=>x!==session&&x.threadId===result.thread.id))reject('CODEX_SESSION_POLICY_MISMATCH');
      session.threadId=result.thread.id;session.state='open';this.#save();
    }catch{session.state='unknown';this.#save();}
    return freeze({sessionRef:ref,state:session.state,synthetic:true});
  }
  async submit(sessionRef,request,key){
    object(request,['scope','taskId','runId','attempt','kind','leaseId','dispatchKey','text','executionApproved']);
    const session=this.#session(sessionRef,request.scope);identifier(key);
    for(const k of ['taskId','runId','leaseId','dispatchKey'])identifier(request[k]);integer(request.attempt);
    if(request.executionApproved!==false||!['work','chat'].includes(request.kind))reject('CODEX_INVALID_SUBMISSION');
    if(key!==request.dispatchKey)reject('CODEX_DISPATCH_KEY_MISMATCH');protocolText(request.text);
    const hash=fingerprint(request),prior=this.#state.runs.find(x=>x.runId===request.runId);
    if(prior){if(prior.sessionRef!==sessionRef||prior.fingerprint!==hash||prior.dispatchKey!==key)reject('CODEX_SUBMISSION_CONFLICT');return this.#report(prior);}
    if(session.state!=='open')reject('CODEX_SESSION_REQUIRES_RECONCILIATION');
    if(this.#state.runs.some(x=>x.dispatchKey===key))reject('CODEX_DISPATCH_KEY_REUSED');
    if(this.#state.runs.some(x=>x.sessionRef===sessionRef&&!terminal(x)))reject('CODEX_SESSION_BUSY');
    if(this.#state.runs.length>=128)reject('CODEX_RUN_CAPACITY');
    const run={scope:session.scope,sessionRef,taskId:request.taskId,runId:request.runId,attempt:request.attempt,kind:request.kind,leaseId:request.leaseId,dispatchKey:key,fingerprint:hash,externalRef:null,turnId:null,state:'dispatching',lastSeq:0,question:null,approvalPending:false,cancelRequested:false,events:[],observations:[],operations:[]};
    this.#state.runs.push(run);this.#save();
    try{
      const result=await this.#request(METHODS.submit,submitParams(session.threadId,session.modelRef,request.text,key),request,()=>{if(run.state!=='dispatching')reject('CODEX_RUN_CHANGED');});
      turnState(result?.turn);
      if(this.#state.runs.some(x=>x!==run&&x.sessionRef===sessionRef&&x.turnId===result.turn.id))reject('CODEX_TURN_REUSED');
      run.turnId=result.turn.id;run.externalRef=this.#external(session,run);
      if(run.state==='dispatching')run.state=turnState(result.turn);
      this.#save();
    }catch{if(!terminal(run))run.state='unknown';this.#save();}
    return this.#report(run);
  }
  #report(run){return freeze({state:run.state,externalRef:run.externalRef,dispatchKey:run.dispatchKey,synthetic:true,automaticSubmissions:0});}
  #operation(run,key,request){
    identifier(key);const hash=fingerprint(request),prior=run.operations.find(x=>x.key===key);
    if(prior){if(prior.fingerprint!==hash)reject('CODEX_INPUT_CONFLICT');return {op:prior,duplicate:true};}
    if(run.operations.length>=64)reject('CODEX_INPUT_CAPACITY');
    const op={key,fingerprint:hash,state:'dispatching',receiptRef:null};run.operations.push(op);this.#save();return {op,duplicate:false};
  }
  async sendInput(sessionRef,request,key){
    object(request,[...targetFields,'operation','text','questionId','questionSeq','executionApproved']);
    const session=this.#session(sessionRef,request.scope),run=this.#run(session,request);
    if(!['continue','correct','answer'].includes(request.operation)||request.executionApproved!==false)reject('CODEX_ORDINARY_INPUT_REQUIRED');
    protocolText(request.text);
    const prior=run.operations.find(x=>x.key===key);
    if(prior){this.#operation(run,key,request);return this.#inputReport(run,prior);}
    const expectedQuestion=run.question?clone(run.question):null;
    const guard=()=>{
      if(this.#busy.has(run.runId)&&!busyOwner)reject('CODEX_INPUT_BUSY');
      if(request.operation==='answer'){
        if(run.state!=='waiting_input'||!run.question||request.questionId!==run.question.questionId||request.questionSeq!==run.question.seq||run.question.rpcId!==expectedQuestion?.rpcId)reject('CODEX_STALE_QUESTION');
      }else if(run.state!=='running')reject('CODEX_INPUT_STATE_REJECTED');
    };
    let busyOwner=false;guard();const {op}=this.#operation(run,key,request);this.#busy.add(run.runId);busyOwner=true;
    try{
      if(request.operation==='answer'){
        const frame=freeze({id:expectedQuestion.rpcId,result:{answers:{[request.questionId]:{answers:[request.text]}}}});
        await this.#transport.prepare(frame);guard();this.#permission('ordinary-answer',request,'before');
        const receipt=await this.#transport.respond(frame);
        this.#permission('ordinary-answer',request,'after');guard();
        if(receipt?.accepted!==true)reject('CODEX_ANSWER_UNCONFIRMED');
        run.question=null;run.state='running';
      }else{
        const result=await this.#request(METHODS.input,steerParams(session.threadId,run.turnId,request.text,key),request,guard);
        guard();if(result?.turnId!==run.turnId)reject('CODEX_INPUT_TURN_MISMATCH');
      }
      op.state='accepted';op.receiptRef='receipt_'+fingerprint([run.externalRef,key]);this.#save();
    }catch{op.state='unknown';if(!terminal(run)&&run.state!=='waiting_approval'&&run.state!=='cancelling')run.state='unknown';this.#save();}
    finally{this.#busy.delete(run.runId);}
    return this.#inputReport(run,op);
  }
  #inputReport(run,op){return freeze({state:op.state,receiptRef:op.receiptRef,externalRef:run.externalRef,executionApproved:false,synthetic:true});}
  async cancel(sessionRef,request,key){
    object(request,targetFields);const session=this.#session(sessionRef,request.scope),run=this.#run(session,request);
    if(terminal(run))return freeze({...this.#report(run),requested:false,confirmed:run.state==='cancelled',requestAccepted:false});
    const prior=run.operations.find(x=>x.key===key);
    if(prior){this.#operation(run,key,{cancel:request});return freeze({...this.#report(run),requested:true,confirmed:false,operationState:prior.state,requestAccepted:prior.state==='accepted'?true:null});}
    if(run.cancelRequested)reject('CODEX_CANCEL_ALREADY_REQUESTED');
    if(['unknown','dispatching'].includes(run.state)||!run.turnId)reject('CODEX_CANCEL_REQUIRES_RECONCILIATION');
    const {op}=this.#operation(run,key,{cancel:request});run.state='cancelling';run.cancelRequested=true;run.question=null;this.#save();
    try{
      const result=await this.#request(METHODS.cancel,{threadId:session.threadId,turnId:run.turnId},request,()=>{if(run.state!=='cancelling')reject('CODEX_RUN_CHANGED');},'cancel');
      if(!result||Object.keys(result).length)reject('CODEX_INTERRUPT_UNCONFIRMED');
      op.state='accepted';this.#save();
    }catch{op.state='unknown';if(!terminal(run))run.state='unknown';this.#save();}
    return freeze({...this.#report(run),requested:true,confirmed:false,operationState:op.state,requestAccepted:op.state==='accepted'?true:null});
  }
  ingest(sessionRef,request,envelope){
    object(request,targetFields);const session=this.#session(sessionRef,request.scope),run=this.#run(session,request);
    envelope=normalizeEventEnvelope(envelope);
    const mapped=decode(envelope.message);
    if(mapped.threadId!==session.threadId||!run.turnId||mapped.turnId!==run.turnId)reject('CODEX_EVENT_OWNERSHIP_MISMATCH');
    if(typeof envelope.occurredAt!=='string'||!Number.isFinite(Date.parse(envelope.occurredAt))||new Date(envelope.occurredAt).toISOString()!==envelope.occurredAt)reject('INVALID_EVENT_TIME');
    const id='event_'+fingerprint([run.externalRef,envelope.deliveryId]),hash=fingerprint(envelope),prior=[...run.events,...run.observations].find(x=>(x.event?.id??x.id)===id||(x.event?.seq??x.seq)===envelope.seq);
    if(prior){if(prior.fingerprint!==hash)reject('CODEX_EVENT_CONFLICT');return freeze({...clone(prior),duplicate:true});}
    if(run.events.length+run.observations.length>=256){if(!terminal(run))run.state='unknown';this.#save();reject('CODEX_EVENT_CAPACITY');}
    if(mapped.reason){const late=envelope.seq<=run.lastSeq;if(!terminal(run)&&!late)run.state='unknown';const record={id,seq:envelope.seq,fingerprint:hash,accepted:false,state:run.state,reason:mapped.reason,late};run.observations.push(record);this.#save();return freeze({...record,synthetic:true});}
    const event=normalizeEvent({schemaVersion:1,id,seq:envelope.seq,type:mapped.type,occurredAt:envelope.occurredAt,correlationId:run.dispatchKey,data:mapped.data});
    let authorized=false;try{this.#permission('event',{...request,event},'observe');authorized=true;}catch{}
    const late=event.seq<=run.lastSeq;
    const applied=authorized&&!late&&!terminal(run)&&run.state!=='unknown'&&!(run.state==='waiting_approval'&&!['run.waiting_approval','run.succeeded','run.failed','run.cancelled'].includes(event.type))&&!(run.state==='cancelling'&&!['run.succeeded','run.failed','run.cancelled'].includes(event.type));
    // Additive optional v1 provenance. Historical records remain readable but
    // cannot prove a Host delivery when this metadata is absent.
    const record={event,fingerprint:hash,source:{deliveryId:envelope.deliveryId,envelopeDigest:eventEnvelopeDigest(envelope)},applied,late};run.events.push(record);
    if(applied){
      run.lastSeq=event.seq;
      const state={'run.started':'running','run.waiting_input':'waiting_input','run.waiting_approval':'waiting_approval','run.succeeded':'succeeded','run.failed':'failed','run.cancelled':'cancelled'}[event.type];
      if(state)run.state=state;
      if(state==='waiting_approval')run.approvalPending=true;
      if(mapped.question)run.question={...mapped.question,seq:event.seq};else if(state)run.question=null;
    }
    this.#save();return freeze({...clone(record),duplicate:false,accepted:true,synthetic:true});
  }
  events(sessionRef,request){object(request,targetFields);const session=this.#session(sessionRef,request.scope),run=this.#run(session,request);return freeze(clone(run.events));}
  async reconcile(sessionRef,request){
    object(request,targetFields);const session=this.#session(sessionRef,request.scope),run=this.#run(session,request);
    if(terminal(run))return this.#report(run);
    if(!run.turnId)return freeze({...this.#report(run),state:'unknown',reason:'CODEX_NO_CORRELATED_TURN'});
    try{
      const result=await this.#request(METHODS.read,{threadId:session.threadId,includeTurns:true},request,()=>{},'reconcile');
      if(result?.thread?.id!==session.threadId||!Array.isArray(result.thread.turns)||(result.thread.model!=null&&result.thread.model!==session.modelRef))reject('CODEX_RECONCILIATION_MISMATCH');
      const matches=result.thread.turns.filter(x=>x.id===run.turnId);if(matches.length!==1)reject('CODEX_NO_CORRELATED_TURN');
      const state=turnState(matches[0]);
      // Read observes a Run only; it cannot prove input consumption, restore a
      // pending question or approve a tool. Unknown input still blocks input.
      if(state==='running'&&(run.question||run.approvalPending||run.cancelRequested||run.operations.some(x=>x.state==='unknown')))reject('CODEX_RECONCILIATION_INCOMPLETE');
      if(!terminal(run))run.state=state;this.#save();
    }catch{if(!terminal(run))run.state='unknown';this.#save();}
    return this.#report(run);
  }
  async close(){
    if(this.#closed)return;
    let journalSaved=false;
    if(!this.#faulted){try{this.#available();for(const run of this.#state.runs)if(!terminal(run))run.state='unknown';this.#save();journalSaved=true;}catch{}}
    this.#closed=true;try{await this.#transport.close();}catch{reject('CODEX_CLOSE_FAILED');}
    return freeze({closed:true,journalSaved,synthetic:true});
  }
}

export function registerCodexOffline(registry,dependencies){
  registry.register(DESCRIPTOR,context=>new CodexOfflineAdapter({...dependencies(context),hostId:context.hostId,agentId:context.agentId}));
}
