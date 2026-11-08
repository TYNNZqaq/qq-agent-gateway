import { digest, freeze, identifier, integer, reject, scope, scopeKey, TERMINAL_STATES } from '../core/contracts.mjs';
import { cancellationReceipt, cancellationTarget } from '../core/cancel-contracts.mjs';
import { SessionScheduler } from '../core/session-scheduler.mjs';

const hash=value=>digest(JSON.stringify(value));
// Independent control journal. Recovery never calls cancel. Run observations
// cannot prove a missing acknowledgement of a cancellation request.
export class OfflineCancellation {
  #owner;#agent;#store;#journal;#resolve;#prepare;#fault;#state;#revision=0;#faulted=false;#closed=false;
  #scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1,maxQueued:32});
  constructor({hostId,agent,store,journal,resolveTarget,prepareSource,fault=()=>{}}){
    this.#owner={hostId:identifier(hostId),agentId:identifier(agent.id)};this.#agent=agent;
    if(!store||!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||typeof resolveTarget!=='function'||typeof prepareSource!=='function')reject('HOST_CANCEL_DEPENDENCIES_REQUIRED');
    this.#store=store;this.#journal=journal;this.#resolve=resolveTarget;this.#prepare=prepareSource;this.#fault=fault;
    const saved=journal.load();this.#state=saved?structuredClone(saved):{schemaVersion:1,revision:0,owner:this.#owner,agent,records:[]};
    this.#validate();this.#revision=this.#state.revision;
    for(const r of this.#state.records)if(r.phase!=='settled')r.phase='unknown';
    this.#save();
  }
  #scope(value){const s=scope(value);if(s.hostId!==this.#owner.hostId||s.agentId!==this.#owner.agentId)reject('HOST_CANCEL_SCOPE_MISMATCH');return s;}
  #validate(){
    const s=this.#state;
    if(s.schemaVersion!==1||hash(s.owner)!==hash(this.#owner)||hash(s.agent)!==hash(this.#agent)||!Array.isArray(s.records)||s.records.length>128)reject('HOST_CANCEL_JOURNAL_MISMATCH');
    integer(s.revision,0);const runs=new Set(),keys=new Set();
    for(const r of s.records){
      this.#scope(r.scope);cancellationTarget(r.target);for(const key of ['key','intentId','sessionId','sessionRef','dispatchKey'])identifier(r[key]);
      const run=scopeKey(r.scope)+':'+r.target.runId,key=scopeKey(r.scope)+':'+r.key;
      if(runs.has(run)||keys.has(key)||!['requesting','requested','unknown','settled'].includes(r.phase)||r.terminal!==null&&!TERMINAL_STATES.includes(r.terminal)||r.phase==='settled'&&!r.terminal)reject('HOST_CANCEL_JOURNAL_MISMATCH');runs.add(run);keys.add(key);
      if(r.receipt!==null){const receipt=cancellationReceipt(r.receipt);if(receipt.externalRef!==r.target.externalRef||receipt.dispatchKey!==r.dispatchKey)reject('HOST_CANCEL_RECEIPT_MISMATCH');}
      if(r.phase==='requested'&&r.receipt?.requestAccepted!==true)reject('HOST_CANCEL_JOURNAL_MISMATCH');
      if(r.terminalEvidence!==null){const e=r.terminalEvidence;if(!TERMINAL_STATES.includes(e.state)||e.externalRef!==r.target.externalRef||e.dispatchKey!==r.dispatchKey)reject('HOST_CANCEL_RECEIPT_MISMATCH');}
    }
  }
  #available(){
    if(this.#closed||this.#faulted)reject('HOST_CANCEL_UNAVAILABLE');
    try{if(this.#journal.load()?.revision!==this.#revision)throw Error();}catch{this.#faulted=true;reject('HOST_CANCEL_JOURNAL_FENCED');}
  }
  #save(){
    try{this.#state.revision=this.#revision+1;if(this.#journal.commit(structuredClone(this.#state),this.#revision)!==true)throw Error();this.#revision=this.#state.revision;}
    catch{this.#faulted=true;reject('HOST_CANCEL_JOURNAL_UNAVAILABLE');}
  }
  #find(s,t,key){
    const r=this.#state.records.find(v=>scopeKey(v.scope)===scopeKey(s)&&(v.target.runId===t.runId||v.key===key));
    if(r&&(r.key!==key||hash(r.target)!==hash(t)))reject('HOST_CANCEL_INTENT_CONFLICT');return r;
  }
  #context(r){
    this.#available();const owned=this.#resolve(r.scope,r.target),current=this.#store.cancellationContext(r.scope,r.target,r.key);
    if(owned.sessionId!==r.sessionId||owned.sessionRef!==r.sessionRef||owned.dispatchKey!==r.dispatchKey||current.intent?.id!==r.intentId)reject('HOST_CANCEL_TARGET_CHANGED');return current;
  }
  #report(r,reason=null,duplicate=false){
    const current=this.#context(r),settled=r.phase==='settled'&&current.run.state===r.terminal;
    return freeze({taskId:r.target.taskId,runId:r.target.runId,attempt:r.target.attempt,cancelKey:r.key,externalRef:r.target.externalRef,
      state:settled?(r.terminal==='cancelled'?'confirmed':r.terminal):r.phase==='requested'?'requested':'unknown',runState:current.run.state,
      requested:true,requestAccepted:r.receipt?.requestAccepted??null,confirmed:settled&&r.terminal==='cancelled',terminal:settled?r.terminal:null,
      duplicate,reason,executionApproved:false,automaticSubmissions:0,automaticCancels:0,synthetic:true});
  }
  #unknown(r,reason){this.#context(r);r.phase='unknown';this.#save();return this.#report(r,reason);}
  #confirm(r,evidence=null){
    const current=this.#context(r);
    // Cancel ACKs are not terminal proof. Applied Store events or an explicit
    // exact reconciliation are separate, durable completion evidence.
    if(!TERMINAL_STATES.includes(current.run.state)){
      if(!evidence)return null;
      this.#fault('before-cancel-store-terminal');this.#store.completeCancellation(r.scope,r.target,r.key,evidence);
      this.#fault('after-cancel-store-terminal');
    }
    const run=this.#context(r).run;
    if(!TERMINAL_STATES.includes(run.state))return null;
    const conflict=evidence&&evidence.state!==run.state;
    this.#fault('before-cancel-confirmation');r.terminal=run.state;r.phase='settled';this.#save();return this.#report(r,conflict?'STORE_TERMINAL_PRESERVED':null);
  }
  request(value,input,key){
    const s=this.#scope(value),t=cancellationTarget(input);identifier(key);this.#available();
    const owned=this.#resolve(s,t),prior=this.#find(s,t,key);
    if(prior)return Promise.resolve(this.#report(prior,prior.phase==='settled'?null:'EXPLICIT_CANCEL_RECONCILIATION_REQUIRED',true));
    if(this.#state.records.length>=128)reject('HOST_CANCEL_CAPACITY');
    // Persist before queueing so an input awaiting Adapter preparation loses
    // its permission immediately, without entering that input's scheduler.
    const intent=this.#store.requestHostCancellation(s,t,key);
    this.#fault('after-cancel-store-intent');
    const r={scope:s,target:t,key,intentId:intent.id,sessionId:owned.sessionId,sessionRef:owned.sessionRef,dispatchKey:owned.dispatchKey,phase:intent.created?'requesting':'unknown',receipt:null,terminal:null,terminalEvidence:null};
    this.#state.records.push(r);this.#save();
    if(!intent.created)return Promise.resolve(this.#report(r,'HOST_CANCEL_INTENT_GAP_NO_REDISPATCH'));
    return this.#scheduler.submit(s,'cancel-'+hash([t.runId,key]),async()=>{
      try{
        this.#context(r);this.#fault('after-cancel-intent');
        const existing=this.#confirm(r);if(existing)return existing;
        const source=await this.#prepare(s,t,key);this.#context(r);
        const terminal=this.#confirm(r);if(terminal)return terminal;
        this.#fault('before-cancel-send');const result=await source.cancel();this.#context(r);this.#fault('after-cancel-adapter');
        const receipt=cancellationReceipt(result);
        if(receipt.externalRef!==t.externalRef||receipt.dispatchKey!==r.dispatchKey)reject('HOST_CANCEL_RECEIPT_MISMATCH');
        r.receipt=receipt;r.phase=receipt.requestAccepted===true?'requested':'unknown';this.#save();this.#fault('after-cancel-host-receipt');
        return this.#confirm(r)??this.#report(r,receipt.requestAccepted===true?'TERMINAL_CONFIRMATION_REQUIRED':'CANCEL_ACCEPTANCE_UNKNOWN');
      }catch(error){if(this.#faulted||this.#closed)throw error;return this.#unknown(r,error?.code??'CANCEL_RESULT_UNKNOWN');}
    });
  }
  #record(value,input,key){
    const s=this.#scope(value),t=cancellationTarget(input);identifier(key);this.#available();this.#resolve(s,t);
    const r=this.#find(s,t,key);if(!r)reject('HOST_CANCEL_INTENT_ABSENT');this.#context(r);return r;
  }
  status(value,input,key){return this.#report(this.#record(value,input,key));}
  authorizeControl(value,input,key,mode){
    const r=this.#record(value,input,key);
    return mode==='cancel'?r.phase==='requesting':mode==='reconcile';
  }
  recover(value,input,key){
    const r=this.#record(value,input,key);
    return this.#confirm(r,r.terminalEvidence)??this.#unknown(r,'EXPLICIT_CANCEL_RECONCILIATION_REQUIRED');
  }
  reconcile(value,input,key){
    const r=this.#record(value,input,key);
    return this.#scheduler.submit(r.scope,'cancel-'+hash([r.target.runId,key]),async()=>{
      try{
        const existing=this.#confirm(r);if(existing)return existing;
        const source=await this.#prepare(r.scope,r.target,key);this.#context(r);
        const report=await source.reconcile();this.#context(r);this.#fault('after-cancel-reconciliation');
        if(report?.dispatchKey!==r.dispatchKey||report.externalRef!==r.target.externalRef||!['unknown','running',...TERMINAL_STATES].includes(report.state))reject('HOST_CANCEL_RECEIPT_MISMATCH');
        if(!TERMINAL_STATES.includes(report.state))return this.#unknown(r,'EXACT_TERMINAL_REQUIRED_RUN_UNCHANGED');
        r.terminalEvidence={state:report.state,dispatchKey:report.dispatchKey,externalRef:report.externalRef};this.#save();
        this.#fault('after-cancel-terminal-receipt');
        return this.#confirm(r,r.terminalEvidence);
      }catch(error){if(this.#faulted||this.#closed)throw error;return this.#unknown(r,error?.code??'CANCEL_RECONCILIATION_UNKNOWN');}
    });
  }
  close(){if(this.#closed)return;this.#closed=true;this.#scheduler.close();}
}
