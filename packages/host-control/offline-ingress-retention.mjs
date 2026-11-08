import { digest, freeze, identifier, integer, object, reject, scope, scopeKey } from '../core/contracts.mjs';
import { eventEnvelopeDigest, normalizeEventEnvelope } from '../core/event-contracts.mjs';
import { SessionScheduler } from '../core/session-scheduler.mjs';

const hash=value=>digest(JSON.stringify(value));
const targetFields=['taskId','runId','attempt','kind','leaseId','externalRef'];
function target(value){
  if(value===null)return null;
  object(value,targetFields);for(const key of targetFields.filter(k=>!['attempt','kind'].includes(k)))identifier(value[key]);integer(value.attempt);
  if(!['work','chat'].includes(value.kind))reject('HOST_INGRESS_TARGET_INVALID');
  return freeze(Object.fromEntries(targetFields.map(k=>[k,value[k]])));
}
function context(value){
  return freeze(Object.fromEntries(['sessionId','sessionRef','dispatchKey'].map(k=>[k,identifier(value[k])])));
}
const reasonOf=error=>typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)?error.code:'INGRESS_RESULT_UNKNOWN';

// Retention starts ONLY after a trusted caller hands us this envelope. IDs
// are caller supplied; no upstream acknowledgement, replay or identity is
// invented here. Existing Host receipts remain a separate journal/domain.
export class OfflineIngressRetention {
  #owner;#agent;#sourceId;#journal;#resolve;#receive;#status;#replay;#fault;#state;#revision=0;#faulted=false;#closed=false;
  #scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1,maxQueued:32});
  constructor({hostId,agent,sourceId,journal,resolveTarget,receiveEvent,eventStatus,replayEvent,fault=()=>{}}){
    object(agent,['id','adapterId','modelRef']);
    this.#owner={hostId:identifier(hostId),agentId:identifier(agent.id)};this.#agent=freeze({id:agent.id,adapterId:identifier(agent.adapterId),modelRef:identifier(agent.modelRef)});this.#sourceId=identifier(sourceId);
    if(!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||[resolveTarget,receiveEvent,eventStatus,replayEvent].some(f=>typeof f!=='function'))reject('HOST_INGRESS_DEPENDENCIES_REQUIRED');
    this.#journal=journal;this.#resolve=resolveTarget;this.#receive=receiveEvent;this.#status=eventStatus;this.#replay=replayEvent;this.#fault=fault;
    const saved=journal.load();this.#state=saved?structuredClone(saved):{schemaVersion:1,revision:0,owner:this.#owner,agent:this.#agent,sourceId:this.#sourceId,channelKind:'ingress-retention',records:[]};
    this.#validate();this.#revision=this.#state.revision;
    for(const r of this.#state.records)if(r.phase==='delivering'){r.phase='unknown';r.reason='INGRESS_INTERRUPTED';}
    // Reopening fences old objects but never delivers, reads the Adapter or
    // starts a model/input/cancel operation. recover() itself is read only.
    this.#save();
  }
  #scope(value){const s=scope(value);if(s.hostId!==this.#owner.hostId||s.agentId!==this.#owner.agentId)reject('HOST_INGRESS_SCOPE_MISMATCH');return s;}
  #envelope(value){
    object(value,['sourceId','deliveryId','seq','occurredAt','message']);
    if(value.sourceId!==this.#sourceId)reject('HOST_INGRESS_SOURCE_MISMATCH');
    const e=normalizeEventEnvelope(Object.fromEntries(['deliveryId','seq','occurredAt','message'].map(k=>[k,value[k]])));
    return freeze({sourceId:this.#sourceId,...e});
  }
  #digest(e){return eventEnvelopeDigest(Object.fromEntries(['deliveryId','seq','occurredAt','message'].map(k=>[k,e[k]])));}
  #receipt(r,value){
    if(!value||value.sourceId!==this.#sourceId||value.deliveryId!==r.envelope.deliveryId||value.envelopeDigest!==r.envelopeDigest||value.taskId!==r.target.taskId||value.runId!==r.target.runId||!['confirmed','unknown'].includes(value.state))reject('HOST_INGRESS_RECEIPT_MISMATCH');
    if(value.eventId!==null)identifier(value.eventId);
    if(value.state==='confirmed'&&(!value.eventId||typeof value.applied!=='boolean')||value.state==='unknown'&&value.applied!==null)reject('HOST_INGRESS_RECEIPT_MISMATCH');
    return freeze({sourceId:value.sourceId,deliveryId:value.deliveryId,envelopeDigest:value.envelopeDigest,taskId:value.taskId,runId:value.runId,eventId:value.eventId,state:value.state,applied:value.applied});
  }
  #validate(){
    const s=this.#state;
    if(s.schemaVersion!==1||s.channelKind!=='ingress-retention'||hash(s.owner)!==hash(this.#owner)||hash(s.agent)!==hash(this.#agent)||s.sourceId!==this.#sourceId||!Array.isArray(s.records)||s.records.length>4096)reject('HOST_INGRESS_JOURNAL_MISMATCH');
    integer(s.revision,0);const deliveries=new Set(),sequences=new Set(),counts=new Map();
    for(const r of s.records){
      const key=scopeKey(this.#scope(r.scope));target(r.target);this.#envelope(r.envelope);
      if(r.envelopeDigest!==this.#digest(r.envelope)||!['retained','delivering','unknown','recorded'].includes(r.phase)||r.reason!==null&&(typeof r.reason!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(r.reason)))reject('HOST_INGRESS_JOURNAL_MISMATCH');
      const delivery=key+':'+r.envelope.deliveryId;if(deliveries.has(delivery))reject('HOST_INGRESS_JOURNAL_MISMATCH');deliveries.add(delivery);
      if(r.context!==null)context(r.context);
      if(r.target===null&&(r.context!==null||r.phase!=='retained'||r.receipt!==null)||r.phase!=='retained'&&r.context===null)reject('HOST_INGRESS_JOURNAL_MISMATCH');
      if(r.target){
        const run=key+':'+r.target.runId,sequence=run+':'+r.envelope.seq;
        if(sequences.has(sequence))reject('HOST_INGRESS_JOURNAL_MISMATCH');sequences.add(sequence);counts.set(run,(counts.get(run)??0)+1);if(counts.get(run)>256)reject('HOST_INGRESS_JOURNAL_MISMATCH');
      }
      if(r.receipt!==null)this.#receipt(r,r.receipt);
      if(r.phase==='recorded'&&r.receipt?.state!=='confirmed'||r.phase!=='recorded'&&r.receipt?.state==='confirmed'||r.phase==='retained'&&r.receipt!==null)reject('HOST_INGRESS_JOURNAL_MISMATCH');
    }
  }
  #available(){
    if(this.#closed||this.#faulted)reject('HOST_INGRESS_UNAVAILABLE');
    try{if(this.#journal.load()?.revision!==this.#revision)throw Error();}catch{this.#faulted=true;reject('HOST_INGRESS_JOURNAL_FENCED');}
  }
  #save(){
    try{
      this.#state.revision=this.#revision+1;
      if(new TextEncoder().encode(JSON.stringify(this.#state)).byteLength>16*1024*1024)throw Error();
      if(this.#journal.commit(structuredClone(this.#state),this.#revision)!==true)throw Error();this.#revision=this.#state.revision;
    }catch{this.#faulted=true;reject('HOST_INGRESS_JOURNAL_UNAVAILABLE');}
  }
  #find(s,deliveryId){return this.#state.records.find(r=>scopeKey(r.scope)===scopeKey(s)&&r.envelope.deliveryId===deliveryId);}
  #record(s,deliveryId){identifier(deliveryId);this.#available();const r=this.#find(s,deliveryId);if(!r)reject('HOST_INGRESS_RECORD_ABSENT');return r;}
  #current(r){
    this.#available();const resolved=context(this.#resolve(r.scope,r.target));
    if(r.context!==null&&hash(r.context)!==hash(resolved))reject('HOST_INGRESS_TARGET_CHANGED');return resolved;
  }
  #guard(r){this.#current(r);if(r.phase!=='delivering')reject('HOST_INGRESS_DELIVERY_NOT_CURRENT');return true;}
  #report(r,duplicate=false,reason=r.reason){
    return freeze({sourceId:this.#sourceId,deliveryId:r.envelope.deliveryId,taskId:r.target?.taskId??null,runId:r.target?.runId??null,
      retained:true,state:r.target===null?'unassociated':r.phase==='retained'?'retained':r.phase==='recorded'?'recorded':'unknown',
      handoffStarted:r.phase!=='retained',hostState:r.receipt?.state??null,eventId:r.receipt?.eventId??null,applied:r.receipt?.applied??null,
      duplicate,reason,executionApproved:false,automaticSubmissions:0,automaticIngestions:0,synthetic:true});
  }
  #unknown(r,reason){this.#available();r.phase='unknown';r.reason=reason;this.#save();return this.#report(r);}
  #finish(r,value){
    this.#current(r);const receipt=this.#receipt(r,value);this.#fault('before-ingress-confirmation');
    r.receipt=receipt;r.phase=receipt.state==='confirmed'?'recorded':'unknown';r.reason=receipt.state==='confirmed'?null:'HOST_EVENT_RESULT_UNKNOWN';this.#save();return this.#report(r);
  }
  retain(value,input,envelope){
    const s=this.#scope(value),t=target(input),e=this.#envelope(envelope);this.#available();const fingerprint=this.#digest(e),prior=this.#find(s,e.deliveryId);
    if(prior){if(hash(prior.target)!==hash(t)||prior.envelopeDigest!==fingerprint)reject('HOST_INGRESS_DELIVERY_CONFLICT');return this.#report(prior,true);}
    const run=t?this.#state.records.filter(r=>scopeKey(r.scope)===scopeKey(s)&&r.target?.runId===t.runId):[];
    if(run.some(r=>r.envelope.seq===e.seq))reject('HOST_INGRESS_SEQUENCE_CONFLICT');
    if(this.#state.records.length>=4096||run.length>=256)reject('HOST_INGRESS_CAPACITY');
    let resolved=null,reason=t===null?'INGRESS_UNASSOCIATED':null;
    if(t){try{resolved=context(this.#resolve(s,t));}catch(error){reason=reasonOf(error);}}
    const r={scope:s,target:t,context:resolved,envelope:e,envelopeDigest:fingerprint,phase:'retained',receipt:null,reason};
    this.#fault('before-ingress-retain');this.#state.records.push(r);this.#save();this.#fault('after-ingress-retain');return this.#report(r);
  }
  deliver(value,deliveryId){
    const s=this.#scope(value);this.#record(s,deliveryId);
    return this.#scheduler.submit(s,'ingress-'+hash(deliveryId),async()=>{
      const r=this.#record(s,deliveryId);
      if(r.target===null)return this.#report(r);
      if(r.phase!=='retained')return this.#report(r,true,r.phase==='recorded'?null:'EXPLICIT_INGRESS_REPLAY_REQUIRED');
      try{r.context=this.#current(r);}catch(error){if(this.#faulted||this.#closed)throw error;r.reason=reasonOf(error);this.#save();return this.#report(r);}
      r.phase='delivering';r.reason=null;this.#save();
      try{
        this.#fault('after-ingress-intent');this.#guard(r);
        const receipt=await this.#receive(r.scope,r.target,r.envelope,()=>this.#guard(r));
        this.#guard(r);this.#fault('after-ingress-host');return this.#finish(r,receipt);
      }catch(error){if(this.#faulted||this.#closed)throw error;return this.#unknown(r,reasonOf(error));}
    });
  }
  replay(value,deliveryId){
    const s=this.#scope(value);this.#record(s,deliveryId);
    return this.#scheduler.submit(s,'ingress-'+hash(deliveryId),async()=>{
      const r=this.#record(s,deliveryId);
      if(r.target===null||r.phase==='recorded')return this.#report(r,true);
      if(r.phase==='retained')return this.#report(r,false,'EXPLICIT_INGRESS_DELIVERY_REQUIRED');
      try{
        this.#current(r);let receipt=this.#status(r.scope,r.target,deliveryId);
        if(receipt.state!=='confirmed')receipt=await this.#replay(r.scope,r.target,deliveryId);
        this.#current(r);return this.#finish(r,receipt);
      }catch(error){if(this.#faulted||this.#closed)throw error;return this.#unknown(r,reasonOf(error));}
    });
  }
  status(value,deliveryId){const s=this.#scope(value);return this.#report(this.#record(s,deliveryId));}
  recover(value){
    const s=this.#scope(value);this.#available();
    return freeze(this.#state.records.filter(r=>scopeKey(r.scope)===scopeKey(s)&&r.phase!=='recorded').map(r=>({...this.#report(r),target:structuredClone(r.target),context:structuredClone(r.context),envelope:structuredClone(r.envelope)})));
  }
  close(){if(this.#closed)return;this.#closed=true;this.#scheduler.close();}
}
