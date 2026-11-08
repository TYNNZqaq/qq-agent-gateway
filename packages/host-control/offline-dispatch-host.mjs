import { ADAPTER_METHODS } from '../core/adapter-registry.mjs';
import { digest, EVENT_STATES, freeze, identifier, integer, normalizeEvent, object, reject, scope, scopeKey, TERMINAL_STATES } from '../core/contracts.mjs';
import { SessionScheduler } from '../core/session-scheduler.mjs';
import { activeBinding, validateConfiguration } from '../core/configuration.mjs';
import { OfflineEventReceiver } from './offline-event-receiver.mjs';
import { OfflineCancellation } from './offline-cancellation.mjs';
import { OfflineIngressRetention } from './offline-ingress-retention.mjs';
import { cancellationTarget } from '../core/cancel-contracts.mjs';

// Explicit trusted OFFLINE composition. No registration in the management
// service, concrete Runtime import, transport factory, timers or approval API.
// InputCoordinator owns scheduling, claim and WorkStore input completion. Its
// receiver calls below deliberately do not submit to the scheduler again.
export const HOST_SNAPSHOT_VERSION=2;
export class OfflineDispatchHost {
  #store; #owner; #agent; #journal; #adapterJournal; #prepare; #scheduler; #ownScheduler;
  #state; #config; #revision=0; #fault; #faulted=false; #closed=false; #adapter; #adapterPromise; #contexts=new Map();
  #eventReceiver; #observations=new Map(); #ingressRetention;
  #cancellation; #cancelControls=new Map();
  constructor({store,hostId,agent,configuration,journal,adapterJournal,prepareAdapter,scheduler,events=null,cancellations=null,fault=()=>{}}){
    object(agent,['id','adapterId','modelRef']);
    this.#agent=freeze({id:identifier(agent.id),adapterId:identifier(agent.adapterId),modelRef:identifier(agent.modelRef)});
    this.#owner={hostId:identifier(hostId),agentId:agent.id};
    this.#config=validateConfiguration(configuration);
    const configured=this.#config.agents.find(a=>a.id===agent.id);
    if(this.#config.hostId!==hostId||!configured||configured.adapterId!==agent.adapterId||configured.modelRef!==agent.modelRef)reject('HOST_AGENT_CONFIGURATION_MISMATCH');
    if(!store||!journal||!adapterJournal||journal===adapterJournal||typeof prepareAdapter!=='function'||[journal,adapterJournal].some(j=>typeof j.load!=='function'||typeof j.commit!=='function'))reject('HOST_DEPENDENCIES_REQUIRED');
    this.#store=store;this.#journal=journal;this.#adapterJournal=adapterJournal;this.#prepare=prepareAdapter;this.#fault=fault;
    this.#ownScheduler=!scheduler;this.#scheduler=scheduler??new SessionScheduler();
    const saved=journal.load();
    this.#state=saved?structuredClone(saved):{schemaVersion:2,revision:0,owner:this.#owner,agent:this.#agent,sessions:[],dispatches:[],continuations:[],inputs:[]};
    this.#validate();this.#revision=this.#state.revision;
    // Only this consumer snapshot upgrades. The journal database, Adapter,
    // WorkStore, configuration and Core versions do not change. CAS preserves
    // the original channel and fences actual v1 objects before any operation.
    if(this.#state.schemaVersion===1)Object.assign(this.#state,{schemaVersion:2,continuations:[],inputs:[]});
    for(const entry of this.#runs())entry.phase='unknown';
    for(const entry of this.#state.inputs)entry.phase='unknown';
    for(const session of this.#state.sessions)if(session.state==='opening')session.state='unknown';
    // New lifecycle owns the journal before any asynchronous factory starts.
    this.#save();
    if(events!==null){
      object(events,['sourceId','journal','prepareIngress','retention']);
      if(events.journal===journal||events.journal===adapterJournal||typeof events.prepareIngress!=='function')reject('HOST_EVENT_DEPENDENCIES_REQUIRED');
      this.#eventReceiver=new OfflineEventReceiver({hostId,agent:this.#agent,sourceId:events.sourceId,store,journal:events.journal,
        resolveTarget:(s,t)=>this.#eventTarget(s,t),prepareSource:(s,t)=>this.#eventSource(s,t,events.prepareIngress),fault});
      if(events.retention!==undefined){
        object(events.retention,['journal']);
        if([journal,adapterJournal,events.journal,cancellations?.journal].includes(events.retention.journal))reject('HOST_INGRESS_DEPENDENCIES_REQUIRED');
        this.#ingressRetention=new OfflineIngressRetention({hostId,agent:this.#agent,sourceId:events.sourceId,journal:events.retention.journal,
          resolveTarget:(s,t)=>this.#eventTarget(s,t),receiveEvent:(s,t,e,guard)=>this.#eventReceiver.receive(s,t,e,guard),
          eventStatus:(s,t,id)=>this.#eventReceiver.status(s,t,id),replayEvent:(s,t,id)=>this.#eventReceiver.replay(s,t,id),fault});
      }
    }
    if(cancellations!==null){
      object(cancellations,['journal']);
      if([journal,adapterJournal,events?.journal].includes(cancellations.journal))reject('HOST_CANCEL_DEPENDENCIES_REQUIRED');
      this.#cancellation=new OfflineCancellation({hostId,agent:this.#agent,store,journal:cancellations.journal,
        resolveTarget:(s,t)=>this.#cancelTarget(s,t),prepareSource:(s,t,k)=>this.#cancelSource(s,t,k),fault});
    }
  }
  #validate(){
    const s=this.#state;
    if(![1,2].includes(s.schemaVersion)||digest(JSON.stringify(s.owner))!==digest(JSON.stringify(this.#owner))||digest(JSON.stringify(s.agent))!==digest(JSON.stringify(this.#agent))||!Array.isArray(s.sessions)||s.sessions.length>32||!Array.isArray(s.dispatches)||s.dispatches.length>128)reject('HOST_JOURNAL_MISMATCH');
    if(s.schemaVersion===1&&(s.continuations!==undefined||s.inputs!==undefined))reject('HOST_JOURNAL_MISMATCH');
    if(s.schemaVersion===2&&(!Array.isArray(s.continuations)||!Array.isArray(s.inputs)||s.dispatches.length+s.continuations.length>128||s.inputs.length>512))reject('HOST_JOURNAL_MISMATCH');
    integer(s.revision,0);const sessions=new Set(),tasks=new Set(),runs=new Set();
    for(const session of s.sessions){this.#scope(session.scope);identifier(session.sessionId);if(session.sessionRef!==null)identifier(session.sessionRef);
      const key=scopeKey(session.scope);if(sessions.has(key)||!['opening','open','unknown'].includes(session.state))reject('HOST_JOURNAL_MISMATCH');sessions.add(key);
    }
    for(const entry of s.dispatches){this.#scope(entry.scope);for(const key of ['taskId','runId','sessionId','leaseId','dispatchKey'])identifier(entry[key]);integer(entry.attempt);
      if(entry.externalRef!==null)identifier(entry.externalRef);
      if(!['preparing','submitted','accepted','unknown'].includes(entry.phase)||!['work','chat'].includes(entry.kind)||typeof entry.textHash!=='string'||tasks.has(entry.taskId)||runs.has(entry.runId))reject('HOST_JOURNAL_MISMATCH');tasks.add(entry.taskId);runs.add(entry.runId);
    }
    const keys=new Set(s.dispatches.map(e=>e.dispatchKey));
    if(keys.size!==s.dispatches.length)reject('HOST_JOURNAL_MISMATCH');
    for(const entry of s.continuations??[]){
      this.#scope(entry.scope);for(const key of ['taskId','runId','sessionId','leaseId','dispatchKey','baseRunId','batchId'])identifier(entry[key]);integer(entry.attempt);
      if(entry.externalRef!==null)identifier(entry.externalRef);
      const base=[...s.dispatches,...s.continuations].find(e=>e.runId===entry.baseRunId);
      if(!base||scopeKey(base.scope)!==scopeKey(entry.scope)||base.taskId!==entry.taskId||base.attempt+1!==entry.attempt||base.sessionId!==entry.sessionId||base.leaseId!==entry.leaseId||base.kind!==entry.kind||runs.has(entry.runId)||keys.has(entry.dispatchKey)||entry.dispatchKey!=='input-'+entry.batchId||!['preparing','submitted','accepted','unknown'].includes(entry.phase)||typeof entry.textHash!=='string')reject('HOST_JOURNAL_MISMATCH');
      runs.add(entry.runId);keys.add(entry.dispatchKey);
    }
    const inputs=new Set(),counts=new Map();
    for(const input of s.inputs??[]){
      this.#scope(input.scope);for(const key of ['taskId','runId','baseRunId','sessionId','leaseId','batchId','inputKey','attemptToken'])identifier(input[key]);integer(input.attempt);
      for(const key of ['externalRef','receiptRef'])if(input[key]!==null)identifier(input[key]);
      const entry=[...s.dispatches,...s.continuations].find(e=>e.runId===input.runId);
      if(!entry||scopeKey(entry.scope)!==scopeKey(input.scope)||entry.taskId!==input.taskId||entry.sessionId!==input.sessionId||entry.leaseId!==input.leaseId||entry.attempt!==input.attempt||entry.kind!==input.kind||inputs.has(input.inputKey)||input.inputKey!=='input-'+input.batchId||typeof input.requestHash!=='string'||!['preparing','accepted','unknown'].includes(input.phase)||!['input','submit'].includes(input.mode)||!['continue','correct','answer'].includes(input.operation)||(input.mode==='submit'&&(input.operation!=='continue'||entry.baseRunId!==input.baseRunId||entry.batchId!==input.batchId))||(input.mode==='input'&&input.baseRunId!==input.runId)||(input.externalRef&&entry.externalRef!==input.externalRef)||(input.receiptRef&&!input.externalRef))reject('HOST_JOURNAL_MISMATCH');
      inputs.add(input.inputKey);counts.set(input.runId,(counts.get(input.runId)??0)+1);if(counts.get(input.runId)>64)reject('HOST_JOURNAL_MISMATCH');
    }
  }
  #runs(){return [...this.#state.dispatches,...this.#state.continuations];}
  #scope(value){const checked=scope(value);if(checked.hostId!==this.#owner.hostId||checked.agentId!==this.#owner.agentId)reject('HOST_SCOPE_MISMATCH');return checked;}
  #bindingMatches(checked,identity){
    const {bot,agent,binding,policy}=activeBinding(this.#config,checked.botId);
    return agent.id===this.#agent.id&&identity===digest(JSON.stringify({bot,agent,binding,policy,project:this.#config.projects.find(p=>p.id===agent.workspaceRef)}));
  }
  #available(){
    if(this.#closed||this.#faulted)reject('HOST_UNAVAILABLE');
    try{if(this.#journal.load()?.revision!==this.#revision)throw Error();}catch{this.#faulted=true;reject('HOST_JOURNAL_FENCED');}
  }
  #save(){
    try{this.#state.revision=this.#revision+1;if(this.#journal.commit(structuredClone(this.#state),this.#revision)!==true)throw Error();this.#revision=this.#state.revision;}
    catch{this.#faulted=true;reject('HOST_JOURNAL_UNAVAILABLE');}
  }
  #entry(checked,taskId){return this.#state.dispatches.find(e=>e.taskId===taskId&&scopeKey(e.scope)===scopeKey(checked));}
  #runEntry(checked,taskId,runId){return this.#runs().find(e=>e.taskId===taskId&&e.runId===runId&&scopeKey(e.scope)===scopeKey(checked));}
  #currentEntry(checked,taskId){
    const task=this.#store.task(checked,taskId),entry=this.#runEntry(checked,taskId,task.current_run_id);
    if(!entry&&this.#entry(checked,taskId))reject('HOST_RUN_CHANGED');return entry;
  }
  #permission(request){
    this.#available();const checked=this.#scope(request.scope);
    if(request.controlOperation!==undefined){
      if(this.#cancelControls.has(scopeKey(checked)))return this.#cancelPermission(checked,request);
      if(request.controlOperation!=='reconcile'||this.#contexts.get(scopeKey(checked))?.mode!=='reconcile')return false;
    }
    if(request.operation==='event')return this.#eventPermission(checked,request);
    const context=this.#contexts.get(scopeKey(checked));
    if(!context||request.executionApproved!==false)return false;
    if(context.mode==='input')return this.#inputPermission(context,request);
    const e=context.entry,{task,run,leaseId,session,bindingIdentity}=this.#store.dispatchContext(checked,e.taskId,e.runId);
    if(!this.#bindingMatches(checked,bindingIdentity))return false;
    if(leaseId!==e.leaseId||task.kind!==e.kind||session.id!==e.sessionId||run.attempt!==e.attempt||run.dispatch_key!==e.dispatchKey)return false;
    if(request.sessionId!==undefined&&request.sessionId!==e.sessionId)return false;
    for(const [key,expected] of Object.entries({taskId:e.taskId,runId:e.runId,attempt:e.attempt,kind:e.kind,leaseId:e.leaseId,dispatchKey:e.dispatchKey}))if(request[key]!==undefined&&request[key]!==expected)return false;
    if(context.mode==='dispatch')return e.phase==='preparing'&&run.state==='dispatching'&&task.state==='dispatching'&&run.external_ref===null&&digest(task.goal)===e.textHash;
    return !TERMINAL_STATES.includes(run.state)&&(!run.external_ref||run.external_ref===context.externalRef)&&(!request.externalRef||request.externalRef===context.externalRef);
  }
  #sameInput(request,expected){
    object(request,Object.keys(expected));
    for(const key of Object.keys(expected)){
      if(key==='scope'){if(scopeKey(request.scope)!==scopeKey(expected.scope))reject('HOST_INPUT_REQUEST_MISMATCH');}
      else if(key==='fragments'){
        if(!Array.isArray(request.fragments))reject('HOST_INPUT_REQUEST_MISMATCH');
        const fragments=request.fragments.map(f=>{object(f,['eventId','text']);return {eventId:f.eventId,text:f.text};});
        if(JSON.stringify(fragments)!==JSON.stringify(expected.fragments))reject('HOST_INPUT_REQUEST_MISMATCH');
      }else if(JSON.stringify(request[key])!==JSON.stringify(expected[key]))reject('HOST_INPUT_REQUEST_MISMATCH');
    }
    return expected;
  }
  #inputProjection(request,entry){
    const target={scope:entry.scope,taskId:entry.taskId,runId:entry.runId,attempt:entry.attempt,kind:entry.kind,leaseId:entry.leaseId};
    return request.mode==='submit'?{...target,dispatchKey:entry.dispatchKey,text:request.text,executionApproved:false}:{...target,externalRef:entry.externalRef,operation:request.operation,text:request.text,questionId:request.questionId,questionSeq:request.questionSeq,executionApproved:false};
  }
  #inputPermission(context,request){
    const {entry,input}=context,current=this.#store.inputDispatchContext(entry.scope,input.batchId,input.attemptToken);
    if(digest(JSON.stringify(current.request))!==input.requestHash||current.leaseId!==entry.leaseId||current.session.id!==entry.sessionId||!this.#bindingMatches(entry.scope,current.bindingIdentity)||current.run.dispatch_key!==entry.dispatchKey||current.run.attempt!==entry.attempt)return false;
    const expected=this.#inputProjection(current.request,entry);
    for(const key of Object.keys(expected))if(key!=='scope'&&JSON.stringify(request[key])!==JSON.stringify(expected[key]))return false;
    return current.request.mode==='submit'?(entry.phase==='preparing'&&current.run.external_ref===null):(entry.externalRef!==null&&current.run.external_ref===entry.externalRef);
  }
  #assertInputPermission(entry,input){
    const request=this.#store.inputAttempt(entry.scope,input.batchId,input.attemptToken).request;
    this.#contexts.set(scopeKey(entry.scope),{entry,input,mode:'input'});
    if(this.#permission(this.#inputProjection(request,entry))!==true)reject('HOST_AUTHORIZATION_REJECTED');
  }
  #assertPermission(entry,mode='dispatch',externalRef=entry.externalRef){
    this.#contexts.set(scopeKey(entry.scope),{entry,mode,externalRef});
    if(this.#permission({scope:entry.scope,executionApproved:false})!==true)reject('HOST_AUTHORIZATION_REJECTED');
  }
  #eventTarget(checked,target){
    this.#available();checked=this.#scope(checked);
    const entry=this.#runEntry(checked,target.taskId,target.runId),current=this.#store.eventContext(checked,target.taskId,target.runId);
    if(!entry)reject('HOST_EVENT_OWNED_RUN_REQUIRED');
    const session=this.#state.sessions.find(s=>scopeKey(s.scope)===scopeKey(checked));
    if(!session||session.state!=='open'||!session.sessionRef||session.sessionId!==entry.sessionId)reject('HOST_OWNED_SESSION_REQUIRED');
    if(current.session.id!==entry.sessionId||current.task.session_id!==entry.sessionId||current.leaseId!==entry.leaseId||current.task.kind!==entry.kind||current.run.attempt!==entry.attempt||current.run.dispatch_key!==entry.dispatchKey||!entry.externalRef||current.run.external_ref!==entry.externalRef)reject('HOST_EVENT_RECONCILIATION_REQUIRED');
    for(const [key,expected] of Object.entries({taskId:entry.taskId,runId:entry.runId,attempt:entry.attempt,kind:entry.kind,leaseId:entry.leaseId,externalRef:entry.externalRef}))if(target[key]!==expected)reject('HOST_EVENT_TARGET_MISMATCH');
    const authorized=current.active&&this.#bindingMatches(checked,current.bindingIdentity)&&current.task.current_run_id===entry.runId&&entry.phase==='accepted'&&!['unknown','reconciling',...TERMINAL_STATES].includes(current.run.state);
    return {sessionId:entry.sessionId,sessionRef:session.sessionRef,dispatchKey:entry.dispatchKey,runState:current.run.state,authorized};
  }
  #eventPermission(checked,request){
    const observation=this.#observations.get(scopeKey(checked)),target=observation?.target;
    if(!target||request.executionApproved!==false||request.phase!=='observe')return false;
    for(const key of ['taskId','runId','attempt','kind','leaseId','externalRef'])if(request[key]!==target[key])return false;
    const context=this.#eventTarget(checked,target),event=normalizeEvent(request.event),next=EVENT_STATES[event.type];
    if(event.seq!==observation.envelope.seq||event.occurredAt!==observation.envelope.occurredAt||event.correlationId!==context.dispatchKey)return false;
    if(context.runState==='cancelling'&&!TERMINAL_STATES.includes(next))return false;
    if(context.runState==='waiting_approval'&&next!=='waiting_approval'&&!TERMINAL_STATES.includes(next))return false;
    // A started observation is no acknowledgement of an ordinary answer.
    // Only completeInput's exact question transaction clears this wait. An
    // input-only reconciliation deliberately leaves a residual question.
    if(context.runState==='waiting_input'&&next==='running')return false;
    return context.authorized;
  }
  async #eventSource(checked,target,prepareIngress){
    const context=this.#eventTarget(checked,target),adapter=await this.#getAdapter();this.#eventTarget(checked,target);
    const request=freeze({scope:checked,...target});
    return {events:()=>{this.#eventTarget(checked,target);return adapter.events(context.sessionRef,request);},prepare:async envelope=>{
      const receive=await prepareIngress(Object.freeze({adapter,sessionRef:context.sessionRef,request,envelope}));
      this.#eventTarget(checked,target);if(typeof receive!=='function')reject('HOST_EVENT_INGRESS_REQUIRED');
      return e=>{
        this.#eventTarget(checked,target);const key=scopeKey(checked);if(this.#observations.has(key))reject('HOST_EVENT_SCOPE_BUSY');
        this.#observations.set(key,{target,envelope:e});
        try{
          const result=receive(e);
          if(result&&typeof result.then==='function'){result.catch(()=>{});reject('HOST_EVENT_INGRESS_MUST_BE_SYNCHRONOUS');}
          this.#eventTarget(checked,target);return result;
        }finally{this.#observations.delete(key);}
      };
    }};
  }
  receiveEvent(value,target,envelope){if(!this.#eventReceiver)reject('HOST_EVENT_SOURCE_NOT_CONFIGURED');return this.#eventReceiver.receive(value,target,envelope);}
  replayEvent(value,target,deliveryId){if(!this.#eventReceiver)reject('HOST_EVENT_SOURCE_NOT_CONFIGURED');return this.#eventReceiver.replay(value,target,deliveryId);}
  eventStatus(value,target,deliveryId){if(!this.#eventReceiver)reject('HOST_EVENT_SOURCE_NOT_CONFIGURED');return this.#eventReceiver.status(value,target,deliveryId);}
  retainEvent(value,target,envelope){if(!this.#ingressRetention)reject('HOST_INGRESS_NOT_CONFIGURED');return this.#ingressRetention.retain(value,target,envelope);}
  deliverRetainedEvent(value,deliveryId){if(!this.#ingressRetention)reject('HOST_INGRESS_NOT_CONFIGURED');return this.#ingressRetention.deliver(value,deliveryId);}
  replayRetainedEvent(value,deliveryId){if(!this.#ingressRetention)reject('HOST_INGRESS_NOT_CONFIGURED');return this.#ingressRetention.replay(value,deliveryId);}
  ingressStatus(value,deliveryId){if(!this.#ingressRetention)reject('HOST_INGRESS_NOT_CONFIGURED');return this.#ingressRetention.status(value,deliveryId);}
  recoverIngress(value){if(!this.#ingressRetention)reject('HOST_INGRESS_NOT_CONFIGURED');return this.#ingressRetention.recover(value);}
  #cancelTarget(value,input){
    this.#available();const checked=this.#scope(value),target=cancellationTarget(input),entry=this.#runEntry(checked,target.taskId,target.runId);
    if(!entry)reject('HOST_CANCEL_OWNED_RUN_REQUIRED');
    const current=this.#store.eventContext(checked,target.taskId,target.runId),session=this.#state.sessions.find(s=>scopeKey(s.scope)===scopeKey(checked));
    if(!session||session.state!=='open'||!session.sessionRef||session.sessionId!==entry.sessionId)reject('HOST_OWNED_SESSION_REQUIRED');
    if(current.session.id!==entry.sessionId||current.task.session_id!==entry.sessionId||current.task.kind!==entry.kind||current.run.attempt!==entry.attempt||current.leaseId!==entry.leaseId||current.run.dispatch_key!==entry.dispatchKey||current.run.external_ref!==entry.externalRef||!entry.externalRef)reject('HOST_CANCEL_RECONCILIATION_REQUIRED');
    for(const [key,expected] of Object.entries({taskId:entry.taskId,runId:entry.runId,attempt:entry.attempt,kind:entry.kind,leaseId:entry.leaseId,externalRef:entry.externalRef}))if(target[key]!==expected)reject('HOST_CANCEL_TARGET_MISMATCH');
    // Audit context alone does not authorize. #cancelPermission provides the
    // separate original-Run revocation capability only with durable intent.
    return {sessionId:entry.sessionId,sessionRef:session.sessionRef,dispatchKey:entry.dispatchKey};
  }
  #cancelPermission(checked,request){
    const control=this.#cancelControls.get(scopeKey(checked));
    if(!control||request.controlOperation!==control.mode||request.executionApproved!==false||!['before','after'].includes(request.phase))return false;
    for(const key of ['taskId','runId','attempt','kind','leaseId','externalRef'])if(request[key]!==control.target[key])return false;
    if(['text','questionId','questionSeq','event','dispatchKey','sessionId'].some(key=>request[key]!==undefined))return false;
    if(this.#cancellation.authorizeControl(checked,control.target,control.key,control.mode)!==true)return false;
    const owned=this.#cancelTarget(checked,control.target),current=this.#store.cancellationContext(checked,control.target,control.key);
    if(!current.intent||current.intent.sessionId!==owned.sessionId||current.intent.dispatchKey!==owned.dispatchKey)return false;
    if(control.mode==='cancel'&&request.phase==='before'&&TERMINAL_STATES.includes(current.run.state))return false;
    return true;
  }
  async #cancelSource(checked,target,key){
    const owned=this.#cancelTarget(checked,target),adapter=await this.#getAdapter();this.#cancelTarget(checked,target);
    const request=freeze({scope:checked,...target});
    const invoke=async mode=>{
      this.#cancelTarget(checked,target);const slot=scopeKey(checked);
      if(this.#cancelControls.has(slot))reject('HOST_CANCEL_SCOPE_BUSY');
      this.#cancelControls.set(slot,{target,key,mode});
      try{return mode==='cancel'?await adapter.cancel(owned.sessionRef,request,key):await adapter.reconcile(owned.sessionRef,request);}
      finally{this.#cancelControls.delete(slot);}
    };
    return {cancel:()=>invoke('cancel'),reconcile:()=>invoke('reconcile')};
  }
  cancel(value,target,key){if(!this.#cancellation)reject('HOST_CANCEL_NOT_CONFIGURED');return this.#cancellation.request(value,target,key);}
  cancelStatus(value,target,key){if(!this.#cancellation)reject('HOST_CANCEL_NOT_CONFIGURED');return this.#cancellation.status(value,target,key);}
  recoverCancel(value,target,key){if(!this.#cancellation)reject('HOST_CANCEL_NOT_CONFIGURED');return this.#cancellation.recover(value,target,key);}
  reconcileCancel(value,target,key){if(!this.#cancellation)reject('HOST_CANCEL_NOT_CONFIGURED');return this.#cancellation.reconcile(value,target,key);}
  async #getAdapter(){
    if(!this.#adapterPromise)this.#adapterPromise=(async()=>{
      const adapter=await this.#prepare({context:freeze({...this.#owner,adapterId:this.#agent.adapterId,modelRef:this.#agent.modelRef}),journal:this.#adapterJournal,authorize:request=>{try{return this.#permission(request)===true;}catch{return false;}}});
      if(!adapter||ADAPTER_METHODS.some(method=>typeof adapter[method]!=='function'))reject('HOST_ADAPTER_METHOD_MISSING');
      if(this.#closed){await adapter.close();reject('HOST_UNAVAILABLE');}
      try{this.#available();}catch(error){await adapter.close();throw error;}
      this.#adapter=adapter;return adapter;
    })();
    return this.#adapterPromise;
  }
  #report(entry,reason=null){
    if(this.#store.task(entry.scope,entry.taskId).current_run_id!==entry.runId)reject('HOST_RUN_CHANGED');
    const run=this.#store.run(entry.scope,entry.runId);
    const state=entry.phase==='accepted'?run.state:'unknown';
    return freeze({taskId:entry.taskId,runId:entry.runId,attempt:entry.attempt,dispatchKey:entry.dispatchKey,externalRef:entry.externalRef,state,storeState:run.state,reason,executionApproved:false,automaticSubmissions:0,synthetic:true});
  }
  #unknown(entry){
    // A failed/fenced journal cannot authorize a late WorkStore mutation. The
    // explicit recover method accounts for that gap on the new lifecycle.
    this.#available();entry.phase='unknown';this.#save();
    this.#store.markDispatchUnknown(entry.scope,entry.runId,entry.dispatchKey);
    return this.#report(entry,'DISPATCH_REQUIRES_RECONCILIATION');
  }
  async #open(entry,adapter){
    const key=scopeKey(entry.scope);let saved=this.#state.sessions.find(s=>scopeKey(s.scope)===key);
    if(saved){if(saved.sessionId!==entry.sessionId||saved.state!=='open')reject('HOST_SESSION_REQUIRES_RECONCILIATION');return saved.sessionRef;}
    if(this.#state.sessions.length>=32)reject('HOST_SESSION_CAPACITY');
    saved={scope:entry.scope,sessionId:entry.sessionId,sessionRef:null,state:'opening'};this.#state.sessions.push(saved);this.#save();
    this.#assertPermission(entry);
    const result=await adapter.openSession(entry.scope,{sessionId:entry.sessionId,modelRef:this.#agent.modelRef});
    this.#assertPermission(entry);
    saved.state=result?.state==='open'?'open':'unknown';saved.sessionRef=result?.sessionRef??null;
    if(saved.sessionRef!==null)identifier(saved.sessionRef);this.#save();
    if(saved.state!=='open')reject('HOST_SESSION_REQUIRES_RECONCILIATION');
    this.#fault('after-session-receipt');return saved.sessionRef;
  }
  dispatch(value,taskId){
    const checked=this.#scope(value);identifier(taskId);this.#available();
    return this.#scheduler.submit(checked,'initial-'+taskId,async()=>{
      this.#available();if(this.#contexts.has(scopeKey(checked)))reject('HOST_SCOPE_BUSY');const prior=this.#entry(checked,taskId);if(prior)return this.#report(prior);
      const before=this.#store.dispatchContext(checked,taskId);
      if(!this.#bindingMatches(checked,before.bindingIdentity))reject('HOST_AGENT_CONFIGURATION_MISMATCH');
      if(before.task.state!=='queued'||before.task.current_run_id)reject('HOST_INITIAL_QUEUED_TASK_REQUIRED');
      for(const e of this.#runs().filter(e=>scopeKey(e.scope)===scopeKey(checked))){if(!TERMINAL_STATES.includes(this.#store.run(checked,e.runId).state))reject('HOST_SESSION_BUSY');}
      if(this.#runs().length>=128)reject('HOST_DISPATCH_CAPACITY');
      const run=this.#store.beginRun(checked,taskId,{dispatchKey:'initial-'+taskId});
      const entry={scope:checked,taskId,runId:run.id,attempt:run.attempt,sessionId:before.session.id,leaseId:before.leaseId,kind:before.task.kind,dispatchKey:run.dispatch_key,textHash:digest(before.task.goal),externalRef:null,phase:'preparing'};
      try{
        this.#fault('after-run-intent');this.#state.dispatches.push(entry);this.#save();
        this.#assertPermission(entry);const adapter=await this.#getAdapter();this.#assertPermission(entry);
        const sessionRef=await this.#open(entry,adapter);this.#assertPermission(entry);
        this.#fault('before-submit');
        const report=await adapter.submit(sessionRef,freeze({scope:checked,taskId,runId:run.id,attempt:run.attempt,kind:entry.kind,leaseId:entry.leaseId,dispatchKey:run.dispatch_key,text:before.task.goal,executionApproved:false}),run.dispatch_key);
        this.#assertPermission(entry);this.#fault('after-adapter-receipt');
        if(report?.dispatchKey!==run.dispatch_key)reject('HOST_RECEIPT_MISMATCH');
        if(report.externalRef!==null&&report.externalRef!==undefined){entry.externalRef=identifier(report.externalRef);entry.phase='submitted';this.#save();}
        if(report.state!=='running'||!entry.externalRef)return this.#unknown(entry);
        // Adapter receipt -> host receipt -> WorkStore confirmation -> host ack.
        // These are separate commits. Every gap requires explicit accounting.
        this.#fault('before-store-confirmation');
        this.#store.recordSubmission(checked,run.id,entry.externalRef);
        this.#fault('after-store-confirmation');
        entry.phase='accepted';this.#save();return this.#report(entry);
      }catch(error){
        if(this.#faulted||this.#closed)throw error;
        return this.#unknown(entry);
      }finally{this.#contexts.delete(scopeKey(checked));}
    });
  }
  prepareInput(request){
    this.#available();const checked=this.#scope(request.scope);
    const current=this.#store.inputDispatchContext(checked,request.batchId,request.attemptToken);
    const canonical=this.#sameInput(request,current.request);
    // Preparation returns only a receiver. The claimed Run already exists;
    // neither preparing nor receiving may call beginRun or open a new Session.
    return received=>this.#receiveInput(this.#sameInput(received,canonical));
  }
  async #receiveInput(request){
    const checked=this.#scope(request.scope),key=scopeKey(checked);this.#available();
    if(this.#contexts.has(key))reject('HOST_SCOPE_BUSY');
    const current=this.#store.inputDispatchContext(checked,request.batchId,request.attemptToken);
    this.#sameInput(request,current.request);
    if(!this.#bindingMatches(checked,current.bindingIdentity))reject('HOST_AGENT_CONFIGURATION_MISMATCH');
    const session=this.#state.sessions.find(s=>scopeKey(s.scope)===key);
    if(!session||session.state!=='open'||session.sessionId!==current.session.id||!session.sessionRef)reject('HOST_OWNED_SESSION_REQUIRED');
    let input=this.#state.inputs.find(i=>i.inputKey===request.inputKey),entry=this.#runEntry(checked,request.taskId,request.runId);
    if(input){
      if(input.requestHash!==digest(JSON.stringify(current.request))||input.attemptToken!==request.attemptToken)reject('HOST_INPUT_REQUEST_MISMATCH');
      if(input.phase==='accepted'&&input.receiptRef)return freeze({receiptRef:input.receiptRef,externalRef:input.externalRef});
      reject('HOST_INPUT_REQUIRES_RECONCILIATION');
    }
    if(this.#state.inputs.length>=512||this.#state.inputs.filter(i=>i.runId===request.runId).length>=64)reject('HOST_INPUT_CAPACITY');
    if(request.mode==='submit'){
      const base=this.#runEntry(checked,request.taskId,request.baseRunId),baseRun=this.#store.run(checked,request.baseRunId);
      if(entry||!base||base.sessionId!==session.sessionId||base.leaseId!==current.leaseId||!base.externalRef||baseRun.external_ref!==base.externalRef||!TERMINAL_STATES.includes(baseRun.state)||request.attempt!==base.attempt+1||request.operation!=='continue'||current.run.dispatch_key!==request.inputKey)reject('HOST_CONTINUATION_MISMATCH');
      for(const other of this.#runs().filter(e=>scopeKey(e.scope)===key))if(!TERMINAL_STATES.includes(this.#store.run(checked,other.runId).state))reject('HOST_SESSION_BUSY');
      if(this.#runs().length>=128)reject('HOST_DISPATCH_CAPACITY');
      entry={scope:checked,taskId:request.taskId,runId:request.runId,attempt:request.attempt,sessionId:session.sessionId,leaseId:current.leaseId,kind:request.kind,dispatchKey:current.run.dispatch_key,textHash:digest(request.text),externalRef:null,phase:'preparing',baseRunId:request.baseRunId,batchId:request.batchId};
    }else if(!entry||entry.leaseId!==current.leaseId||entry.sessionId!==session.sessionId||entry.phase!=='accepted'||!entry.externalRef||request.externalRef!==entry.externalRef)reject('HOST_INPUT_RUN_REQUIRES_RECONCILIATION');
    input={scope:checked,taskId:request.taskId,runId:request.runId,baseRunId:request.baseRunId,attempt:request.attempt,kind:request.kind,sessionId:session.sessionId,leaseId:current.leaseId,batchId:request.batchId,inputKey:request.inputKey,attemptToken:request.attemptToken,mode:request.mode,operation:request.operation,requestHash:digest(JSON.stringify(current.request)),externalRef:request.externalRef,receiptRef:null,phase:'preparing'};
    try{
      this.#fault('before-input-intent');
      if(request.mode==='submit')this.#state.continuations.push(entry);
      this.#state.inputs.push(input);this.#save();
      this.#assertInputPermission(entry,input);const adapter=await this.#getAdapter();this.#assertInputPermission(entry,input);
      this.#fault('before-input-send');
      const target=freeze(this.#inputProjection(request,entry));
      const report=request.mode==='submit'?await adapter.submit(session.sessionRef,target,request.inputKey):await adapter.sendInput(session.sessionRef,target,request.inputKey);
      this.#assertInputPermission(entry,input);this.#fault('after-input-adapter-receipt');
      if(request.mode==='submit'){
        if(report?.dispatchKey!==request.inputKey)reject('HOST_RECEIPT_MISMATCH');
        if(report.externalRef!=null){
          identifier(report.externalRef);if(this.#runs().some(e=>e!==entry&&e.externalRef===report.externalRef))reject('HOST_REFERENCE_CONFLICT');
          entry.externalRef=report.externalRef;input.externalRef=entry.externalRef;
        }
        if(report.state!=='running'||!entry.externalRef)reject('HOST_INPUT_REQUIRES_RECONCILIATION');
        input.receiptRef='host_receipt_'+digest(JSON.stringify([this.#owner,request.inputKey,entry.runId,entry.externalRef]));entry.phase='submitted';
      }else{
        if(report?.state!=='accepted'||report.executionApproved!==false||report.externalRef!==entry.externalRef)reject('HOST_RECEIPT_MISMATCH');
        input.receiptRef=identifier(report.receiptRef);
      }
      input.phase='accepted';this.#save();this.#fault('after-input-host-receipt');
      return freeze({receiptRef:input.receiptRef,externalRef:input.externalRef});
    }catch(error){
      if(this.#faulted||this.#closed)throw error;
      this.#available();input.phase='unknown';if(request.mode==='submit')entry.phase='unknown';
      this.#save();this.#store.markInputUnknown(checked,request.batchId,request.attemptToken);throw error;
    }finally{this.#contexts.delete(key);}
  }
  #inputRecord(checked,batchId){
    const batch=this.#store.inputBatch(checked,batchId),input=this.#state.inputs.find(i=>i.batchId===batchId&&scopeKey(i.scope)===scopeKey(checked));
    if(input){const attempt=this.#store.inputAttempt(checked,batchId,input.attemptToken);if(input.requestHash!==digest(JSON.stringify(attempt.request))||input.leaseId!==attempt.leaseId)reject('HOST_INPUT_REQUEST_MISMATCH');}
    return {batch,input};
  }
  #inputReport(batch,input,reason=null){return freeze({batchId:batch.batchId,inputKey:batch.inputKey,taskId:batch.taskId,runId:batch.deliveryRunId??batch.runId,state:batch.state,receiptRef:input?.receiptRef??null,externalRef:input?.externalRef??null,reason,executionApproved:false,automaticSubmissions:0,synthetic:true});}
  confirmInput(request){
    const checked=this.#scope(request.scope);this.#available();const {batch,input}=this.#inputRecord(checked,request.batchId);
    const canonical=this.#store.inputAttempt(checked,request.batchId,request.attemptToken).request;this.#sameInput(request,canonical);
    const direct=batch.receipt?.attemptToken===input?.attemptToken&&batch.receipt?.externalRef===input?.externalRef;
    const reconciled=batch.reason==='host_reconciled'&&batch.receipt?.state==='consumed'&&batch.receipt?.inputKey===input?.inputKey;
    if(!input||batch.state!=='consumed'||!input.receiptRef||batch.receipt?.receiptRef!==input.receiptRef||(!direct&&!reconciled))reject('HOST_INPUT_RECEIPT_CONFLICT');
    const entry=this.#runEntry(checked,input.taskId,input.runId),run=this.#store.run(checked,input.runId);
    if((run.external_ref&&run.external_ref!==input.externalRef)||(!run.external_ref&&!reconciled))reject('HOST_REFERENCE_CONFLICT');
    this.#fault('before-input-host-confirmation');input.phase='accepted';if(input.mode==='submit'&&run.external_ref===input.externalRef)entry.phase='accepted';this.#save();
    return this.#inputReport(batch,input);
  }
  recoverInput(value,batchId){
    const checked=this.#scope(value);identifier(batchId);this.#available();
    if(this.#contexts.has(scopeKey(checked)))reject('HOST_SCOPE_BUSY');
    let {batch,input}=this.#inputRecord(checked,batchId);
    if(batch.state==='consumed'&&input?.receiptRef){this.confirmInput(this.#store.inputAttempt(checked,batchId,input.attemptToken).request);return this.#inputReport(batch,input);}
    if(batch.state==='dispatching')batch=this.#store.markInputUnknown(checked,batchId,batch.attemptToken);
    if(input){input.phase='unknown';this.#save();}
    return this.#inputReport(batch,input,input?'EXPLICIT_INPUT_RECONCILIATION_REQUIRED':'HOST_INPUT_INTENT_ABSENT');
  }
  reconcileInput(value,batchId){
    const checked=this.#scope(value);identifier(batchId);this.#available();
    if(this.#contexts.has(scopeKey(checked)))reject('HOST_SCOPE_BUSY');
    const {batch,input}=this.#inputRecord(checked,batchId);
    if(batch.state!=='unknown')return this.#inputReport(batch,input);
    // Generic Run reconciliation cannot prove input consumption. Only an
    // already durable, exact Host receipt can resolve this local input attempt.
    // No receipt means unknown; never call sendInput/submit to obtain one.
    if(!input?.receiptRef||!input.externalRef)return this.#inputReport(batch,input,'DURABLE_INPUT_RECEIPT_REQUIRED');
    if(batch.receipt&&(batch.receipt.receiptRef!==input.receiptRef||batch.receipt.attemptToken!==input.attemptToken||batch.receipt.externalRef!==input.externalRef))reject('HOST_INPUT_RECEIPT_CONFLICT');
    const run=this.#store.run(checked,input.runId),entry=this.#runEntry(checked,input.taskId,input.runId);
    if((run.external_ref&&run.external_ref!==input.externalRef)||entry.externalRef!==input.externalRef)reject('HOST_REFERENCE_CONFLICT');
    const result=this.#store.reconcileInput(checked,batchId,{state:'consumed',inputKey:input.inputKey,receiptRef:input.receiptRef});
    input.phase='accepted';this.#save();return this.#inputReport(result,input,'INPUT_ONLY_RUN_UNCHANGED');
  }
  recover(value,taskId){
    const checked=this.#scope(value);identifier(taskId);this.#available();
    if(this.#contexts.has(scopeKey(checked)))reject('HOST_SCOPE_BUSY');
    const task=this.#store.task(checked,taskId);if(!task.current_run_id)reject('HOST_RUN_REQUIRED');
    const run=this.#store.run(checked,task.current_run_id),entry=this.#currentEntry(checked,taskId);
    if(entry&&entry.runId!==run.id)reject('HOST_RUN_CHANGED');
    const saved=this.#store.markDispatchUnknown(checked,run.id,run.dispatch_key);
    if(entry){entry.phase='unknown';this.#save();return this.#report(entry,'EXPLICIT_RECONCILIATION_REQUIRED');}
    return freeze({taskId,runId:run.id,state:TERMINAL_STATES.includes(saved.state)?saved.state:'unknown',storeState:saved.state,reason:'HOST_INTENT_ABSENT',automaticSubmissions:0});
  }
  reconcile(value,taskId,evidence=null){
    const checked=this.#scope(value);identifier(taskId);this.#available();
    if(evidence!==null){object(evidence,['externalRef','basisRef']);identifier(evidence.externalRef);identifier(evidence.basisRef);}
    return this.#scheduler.submit(checked,'reconcile-'+taskId,async()=>{
      this.#available();if(this.#contexts.has(scopeKey(checked)))reject('HOST_SCOPE_BUSY');const entry=this.#currentEntry(checked,taskId);if(!entry)reject('HOST_INTENT_ABSENT');
      const candidate=evidence?.externalRef??entry.externalRef;
      if(entry.externalRef&&candidate!==entry.externalRef)reject('HOST_REFERENCE_CONFLICT');
      const session=this.#state.sessions.find(s=>scopeKey(s.scope)===scopeKey(checked));
      if(!candidate||!session?.sessionRef)return this.#report(entry,'TRUSTED_REFERENCE_EVIDENCE_REQUIRED');
      const current=this.#store.run(checked,entry.runId);
      if(TERMINAL_STATES.includes(current.state))return this.#report(entry,'STORE_TERMINAL_PRESERVED');
      this.#store.markDispatchUnknown(checked,entry.runId,entry.dispatchKey);
      try{
        this.#assertPermission(entry,'reconcile',candidate);const adapter=await this.#getAdapter();this.#assertPermission(entry,'reconcile',candidate);
        const report=await adapter.reconcile(session.sessionRef,freeze({scope:checked,taskId,runId:entry.runId,attempt:entry.attempt,kind:entry.kind,leaseId:entry.leaseId,externalRef:candidate}));
        this.#assertPermission(entry,'reconcile',candidate);
        if(report?.dispatchKey!==entry.dispatchKey||report.externalRef!==candidate||!['unknown','running',...TERMINAL_STATES].includes(report.state))reject('HOST_RECEIPT_MISMATCH');
        entry.externalRef=candidate;entry.basisRef=evidence?.basisRef??'persisted-adapter-receipt';entry.phase='submitted';this.#save();
        const now=this.#store.run(checked,entry.runId);
        // Reconciliation must not erase a question, approval or cancellation.
        if(!['unknown','reconciling'].includes(now.state))return this.#unknown(entry);
        this.#store.reconcileRun(checked,entry.runId,{state:report.state,dispatchKey:entry.dispatchKey,externalRef:candidate});
        entry.phase=report.state==='unknown'?'unknown':'accepted';this.#save();return this.#report(entry);
      }catch(error){if(this.#faulted||this.#closed)throw error;return this.#unknown(entry);}
      finally{this.#contexts.delete(scopeKey(checked));}
    });
  }
  async close(){
    if(this.#closed)return;
    this.#eventReceiver?.close();
    this.#ingressRetention?.close();
    this.#cancellation?.close();
    // A supplied scheduler can be shared by multiple instances. Its owner
    // controls its lifecycle; stopping this Host never closes that scheduler.
    if(this.#ownScheduler)this.#scheduler.close();
    let journalSaved=false;
    try{this.#available();for(const e of this.#runs())e.phase='unknown';for(const input of this.#state.inputs)input.phase='unknown';this.#save();journalSaved=true;}catch{}
    this.#closed=true;if(this.#adapter)await this.#adapter.close();
    return freeze({closed:true,journalSaved,synthetic:true});
  }
}
