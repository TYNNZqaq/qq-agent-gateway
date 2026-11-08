import { ADAPTER_METHODS } from '../../packages/core/adapter-registry.mjs';
import { digest, freeze, identifier, integer, object, reject, scope, scopeKey, TERMINAL_STATES } from '../../packages/core/contracts.mjs';
import { SessionScheduler } from '../../packages/core/session-scheduler.mjs';
import { activeBinding, validateConfiguration } from '../../packages/core/configuration.mjs';

// Explicit trusted OFFLINE composition. No registration in the management
// service, concrete Runtime import, transport factory, timers or approval API.
// This step implements initial dispatch only; InputCoordinator remains separate.
export class OfflineDispatchHost {
  #store; #owner; #agent; #journal; #adapterJournal; #prepare; #scheduler; #ownScheduler;
  #state; #config; #revision=0; #fault; #faulted=false; #closed=false; #adapter; #adapterPromise; #contexts=new Map();
  constructor({store,hostId,agent,configuration,journal,adapterJournal,prepareAdapter,scheduler,fault=()=>{}}){
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
    this.#state=saved?structuredClone(saved):{schemaVersion:1,revision:0,owner:this.#owner,agent:this.#agent,sessions:[],dispatches:[]};
    this.#validate();this.#revision=this.#state.revision;
    for(const entry of this.#state.dispatches)entry.phase='unknown';
    for(const session of this.#state.sessions)if(session.state==='opening')session.state='unknown';
    // New lifecycle owns the journal before any asynchronous factory starts.
    this.#save();
  }
  #validate(){
    const s=this.#state;
    if(s.schemaVersion!==1||digest(JSON.stringify(s.owner))!==digest(JSON.stringify(this.#owner))||digest(JSON.stringify(s.agent))!==digest(JSON.stringify(this.#agent))||!Array.isArray(s.sessions)||s.sessions.length>32||!Array.isArray(s.dispatches)||s.dispatches.length>128)reject('HOST_JOURNAL_MISMATCH');
    integer(s.revision,0);const sessions=new Set(),tasks=new Set(),runs=new Set();
    for(const session of s.sessions){this.#scope(session.scope);identifier(session.sessionId);if(session.sessionRef!==null)identifier(session.sessionRef);
      const key=scopeKey(session.scope);if(sessions.has(key)||!['opening','open','unknown'].includes(session.state))reject('HOST_JOURNAL_MISMATCH');sessions.add(key);
    }
    for(const entry of s.dispatches){this.#scope(entry.scope);for(const key of ['taskId','runId','sessionId','leaseId','dispatchKey'])identifier(entry[key]);integer(entry.attempt);
      if(entry.externalRef!==null)identifier(entry.externalRef);
      if(!['preparing','submitted','accepted','unknown'].includes(entry.phase)||!['work','chat'].includes(entry.kind)||typeof entry.textHash!=='string'||tasks.has(entry.taskId)||runs.has(entry.runId))reject('HOST_JOURNAL_MISMATCH');tasks.add(entry.taskId);runs.add(entry.runId);
    }
  }
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
  #permission(request){
    this.#available();const checked=this.#scope(request.scope),context=this.#contexts.get(scopeKey(checked));
    if(!context||request.executionApproved!==false)return false;
    const e=context.entry,{task,run,leaseId,session,bindingIdentity}=this.#store.dispatchContext(checked,e.taskId,e.runId);
    if(!this.#bindingMatches(checked,bindingIdentity))return false;
    if(leaseId!==e.leaseId||task.kind!==e.kind||session.id!==e.sessionId||run.attempt!==e.attempt||run.dispatch_key!==e.dispatchKey)return false;
    if(request.sessionId!==undefined&&request.sessionId!==e.sessionId)return false;
    for(const [key,expected] of Object.entries({taskId:e.taskId,runId:e.runId,attempt:e.attempt,kind:e.kind,leaseId:e.leaseId,dispatchKey:e.dispatchKey}))if(request[key]!==undefined&&request[key]!==expected)return false;
    if(context.mode==='dispatch')return e.phase==='preparing'&&run.state==='dispatching'&&task.state==='dispatching'&&run.external_ref===null&&digest(task.goal)===e.textHash;
    return !TERMINAL_STATES.includes(run.state)&&(!run.external_ref||run.external_ref===context.externalRef)&&(!request.externalRef||request.externalRef===context.externalRef);
  }
  #assertPermission(entry,mode='dispatch',externalRef=entry.externalRef){
    this.#contexts.set(scopeKey(entry.scope),{entry,mode,externalRef});
    if(this.#permission({scope:entry.scope,executionApproved:false})!==true)reject('HOST_AUTHORIZATION_REJECTED');
  }
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
      this.#available();const prior=this.#entry(checked,taskId);if(prior)return this.#report(prior);
      const before=this.#store.dispatchContext(checked,taskId);
      if(!this.#bindingMatches(checked,before.bindingIdentity))reject('HOST_AGENT_CONFIGURATION_MISMATCH');
      if(before.task.state!=='queued'||before.task.current_run_id)reject('HOST_INITIAL_QUEUED_TASK_REQUIRED');
      for(const e of this.#state.dispatches.filter(e=>scopeKey(e.scope)===scopeKey(checked))){if(!TERMINAL_STATES.includes(this.#store.run(checked,e.runId).state))reject('HOST_SESSION_BUSY');}
      if(this.#state.dispatches.length>=128)reject('HOST_DISPATCH_CAPACITY');
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
  recover(value,taskId){
    const checked=this.#scope(value);identifier(taskId);this.#available();
    if(this.#contexts.has(scopeKey(checked)))reject('HOST_SCOPE_BUSY');
    const task=this.#store.task(checked,taskId);if(!task.current_run_id)reject('HOST_RUN_REQUIRED');
    const run=this.#store.run(checked,task.current_run_id),entry=this.#entry(checked,taskId);
    if(entry&&entry.runId!==run.id)reject('HOST_RUN_CHANGED');
    const saved=this.#store.markDispatchUnknown(checked,run.id,run.dispatch_key);
    if(entry){entry.phase='unknown';this.#save();return this.#report(entry,'EXPLICIT_RECONCILIATION_REQUIRED');}
    return freeze({taskId,runId:run.id,state:TERMINAL_STATES.includes(saved.state)?saved.state:'unknown',storeState:saved.state,reason:'HOST_INTENT_ABSENT',automaticSubmissions:0});
  }
  reconcile(value,taskId,evidence=null){
    const checked=this.#scope(value);identifier(taskId);this.#available();
    if(evidence!==null){object(evidence,['externalRef','basisRef']);identifier(evidence.externalRef);identifier(evidence.basisRef);}
    return this.#scheduler.submit(checked,'reconcile-'+taskId,async()=>{
      this.#available();const entry=this.#entry(checked,taskId);if(!entry)reject('HOST_INTENT_ABSENT');
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
    // A supplied scheduler can be shared by multiple instances. Its owner
    // controls its lifecycle; stopping this Host never closes that scheduler.
    if(this.#ownScheduler)this.#scheduler.close();
    let journalSaved=false;
    try{this.#available();for(const e of this.#state.dispatches)e.phase='unknown';this.#save();journalSaved=true;}catch{}
    this.#closed=true;if(this.#adapter)await this.#adapter.close();
    return freeze({closed:true,journalSaved,synthetic:true});
  }
}
