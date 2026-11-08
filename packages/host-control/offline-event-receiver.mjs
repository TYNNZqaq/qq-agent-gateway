import { digest, freeze, identifier, integer, normalizeEvent, object, reject, scope, scopeKey } from '../core/contracts.mjs';
import { eventEnvelopeDigest, normalizeAdapterEvent, normalizeEventEnvelope } from '../core/event-contracts.mjs';
import { SessionScheduler } from '../core/session-scheduler.mjs';

const hash=value=>digest(JSON.stringify(value));
const targetFields=['taskId','runId','attempt','kind','leaseId','externalRef'];
function target(value){
  object(value,targetFields);for(const key of targetFields.filter(k=>!['attempt','kind'].includes(k)))identifier(value[key]);integer(value.attempt);
  if(!['work','chat'].includes(value.kind))reject('HOST_EVENT_TARGET_INVALID');
  return freeze(Object.fromEntries(targetFields.map(k=>[k,value[k]])));
}
// Independent v1 receipt channel: existing Host v2 and Adapter v1 snapshots
// keep their format and channel. Only explicit receives/replays do any work.
export class OfflineEventReceiver {
  #owner;#agent;#sourceId;#store;#journal;#resolve;#prepare;#fault;#state;#revision=0;#faulted=false;#closed=false;
  #scheduler=new SessionScheduler({maxConcurrent:2,perAgent:1,maxQueued:32});
  constructor({hostId,agent,sourceId,store,journal,resolveTarget,prepareSource,fault=()=>{}}){
    this.#owner={hostId:identifier(hostId),agentId:identifier(agent.id)};this.#agent=agent;this.#sourceId=identifier(sourceId);
    if(!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||typeof resolveTarget!=='function'||typeof prepareSource!=='function')reject('HOST_EVENT_DEPENDENCIES_REQUIRED');
    this.#store=store;this.#journal=journal;this.#resolve=resolveTarget;this.#prepare=prepareSource;this.#fault=fault;
    const saved=journal.load();this.#state=saved?structuredClone(saved):{schemaVersion:1,revision:0,owner:this.#owner,agent,sourceId,records:[]};
    this.#validate();this.#revision=this.#state.revision;
    for(const record of this.#state.records)if(record.phase==='receiving')record.phase='unknown';
    this.#save();
  }
  #scope(value){const s=scope(value);if(s.hostId!==this.#owner.hostId||s.agentId!==this.#owner.agentId)reject('HOST_EVENT_SCOPE_MISMATCH');return s;}
  #validate(){
    const s=this.#state;
    if(s.schemaVersion!==1||hash(s.owner)!==hash(this.#owner)||hash(s.agent)!==hash(this.#agent)||s.sourceId!==this.#sourceId||!Array.isArray(s.records)||s.records.length>4096)reject('HOST_EVENT_JOURNAL_MISMATCH');
    integer(s.revision,0);const keys=new Set(),sequences=new Set(),counts=new Map();
    for(const r of s.records){
      this.#scope(r.scope);target(r.target);identifier(r.deliveryId);integer(r.seq);identifier(r.sessionId);identifier(r.sessionRef);identifier(r.dispatchKey);
      if(!/^[a-f0-9]{64}$/.test(r.envelopeDigest)||typeof r.occurredAt!=='string'||!Number.isFinite(Date.parse(r.occurredAt))||new Date(r.occurredAt).toISOString()!==r.occurredAt||!['receiving','received','confirmed','unknown'].includes(r.phase))reject('HOST_EVENT_JOURNAL_MISMATCH');
      const key=scopeKey(r.scope)+':'+r.target.runId,delivery=key+':'+r.deliveryId,seq=key+':'+r.seq;
      if(keys.has(delivery)||sequences.has(seq))reject('HOST_EVENT_JOURNAL_MISMATCH');keys.add(delivery);sequences.add(seq);counts.set(key,(counts.get(key)??0)+1);if(counts.get(key)>256)reject('HOST_EVENT_JOURNAL_MISMATCH');
      if(r.record!==null){const record=normalizeAdapterEvent(r.record);this.#matches(r,record);}
      if(r.phase==='confirmed'&&(!r.record||typeof r.applied!=='boolean'))reject('HOST_EVENT_JOURNAL_MISMATCH');
    }
  }
  #available(){
    if(this.#closed||this.#faulted)reject('HOST_EVENT_UNAVAILABLE');
    try{if(this.#journal.load()?.revision!==this.#revision)throw Error();}catch{this.#faulted=true;reject('HOST_EVENT_JOURNAL_FENCED');}
  }
  #save(){
    try{this.#state.revision=this.#revision+1;if(this.#journal.commit(structuredClone(this.#state),this.#revision)!==true)throw Error();this.#revision=this.#state.revision;}
    catch{this.#faulted=true;reject('HOST_EVENT_JOURNAL_UNAVAILABLE');}
  }
  #find(s,t,deliveryId){return this.#state.records.find(r=>scopeKey(r.scope)===scopeKey(s)&&r.target.runId===t.runId&&r.deliveryId===deliveryId);}
  #resolveRecord(r){
    this.#available();const context=this.#resolve(r.scope,r.target);
    if(context.sessionId!==r.sessionId||context.sessionRef!==r.sessionRef||context.dispatchKey!==r.dispatchKey)reject('HOST_EVENT_TARGET_CHANGED');
    return context;
  }
  #matches(r,record){
    if(record.source.deliveryId!==r.deliveryId||record.source.envelopeDigest!==r.envelopeDigest||record.event.seq!==r.seq||record.event.occurredAt!==r.occurredAt||record.event.correlationId!==r.dispatchKey)reject('HOST_EVENT_SOURCE_CONFLICT');
    if(r.record&&hash(r.record)!==hash(record))reject('HOST_EVENT_RECEIPT_CONFLICT');
  }
  #report(r,reason=null,duplicate=false){
    return freeze({sourceId:this.#sourceId,deliveryId:r.deliveryId,envelopeDigest:r.envelopeDigest,taskId:r.target.taskId,runId:r.target.runId,eventId:r.record?.event.id??null,state:r.phase==='confirmed'?'confirmed':'unknown',applied:r.phase==='confirmed'?r.applied:null,adapterApplied:r.record?.applied??null,late:r.record?.late??null,duplicate,reason,executionApproved:false,automaticSubmissions:0,synthetic:true});
  }
  #readReceipt(r){
    const rows=this.#store.events(r.scope,r.target.runId).filter(e=>e.id===r.record.event.id||e.seq===r.seq);
    if(rows.length!==1)return null;
    const row=rows[0],event=normalizeEvent(Object.fromEntries(['schemaVersion','id','seq','type','occurredAt','correlationId','data'].map(k=>[k,row[k]])));
    if(hash(event)!==hash(r.record.event))reject('HOST_EVENT_STORE_CONFLICT');
    return row;
  }
  #confirm(r){
    this.#resolveRecord(r);let receipt=this.#readReceipt(r);
    if(!receipt){
      this.#fault('before-event-store');
      this.#store.recordEvent(r.scope,r.target.runId,r.record.event,{apply:r.record.applied});
      this.#fault('after-event-store');receipt=this.#readReceipt(r);
    }
    if(!receipt)reject('HOST_EVENT_STORE_RECEIPT_REQUIRED');
    if(receipt.applied&&!r.record.applied)reject('HOST_EVENT_STORE_CONFLICT');
    this.#fault('before-event-confirmation');r.applied=receipt.applied;r.phase='confirmed';this.#save();return this.#report(r);
  }
  #unknown(r,reason){this.#available();r.phase='unknown';this.#save();return this.#report(r,reason);}
  async #readSource(r,source){
    const rows=await source.events();this.#resolveRecord(r);
    if(!Array.isArray(rows)||rows.length>256)reject('HOST_EVENT_SOURCE_INVALID');
    // A delivery reference AND full envelope digest are required. Neither a
    // timestamp, sequence alone nor a latest event establishes provenance.
    const matches=rows.filter(v=>v?.source?.deliveryId===r.deliveryId);
    if(matches.length!==1)return null;
    const record=normalizeAdapterEvent(matches[0]);this.#matches(r,record);
    // Also reject a conflicting id/sequence elsewhere in the public stream.
    if(rows.some(v=>v!==matches[0]&&(v?.event?.id===record.event.id||v?.event?.seq===record.event.seq)))reject('HOST_EVENT_SOURCE_CONFLICT');
    r.record=record;r.phase='received';this.#save();this.#fault('after-event-host-receipt');return record;
  }
  receive(value,input,envelope,guard=()=>true){
    const s=this.#scope(value),t=target(input);this.#available();object(envelope,['sourceId','deliveryId','seq','occurredAt','message']);
    if(envelope.sourceId!==this.#sourceId)reject('HOST_EVENT_SOURCE_MISMATCH');
    const e=normalizeEventEnvelope(Object.fromEntries(['deliveryId','seq','occurredAt','message'].map(k=>[k,envelope[k]]))),fingerprint=eventEnvelopeDigest(e);
    return this.#scheduler.submit(s,'event-'+hash([t.runId,e.deliveryId]),async()=>{
      if(guard()!==true)reject('HOST_EVENT_INGRESS_FENCED');
      this.#available();const context=this.#resolve(s,t);let r=this.#find(s,t,e.deliveryId);
      if(r){
        if(hash(r.target)!==hash(t)||r.envelopeDigest!==fingerprint)reject('HOST_EVENT_DELIVERY_CONFLICT');
        // Receiving the same pending delivery NEVER invokes ingress again.
        return this.#report(r,r.phase==='confirmed'?null:'EXPLICIT_EVENT_REPLAY_REQUIRED',true);
      }
      if(this.#state.records.some(v=>scopeKey(v.scope)===scopeKey(s)&&v.target.runId===t.runId&&v.seq===e.seq))reject('HOST_EVENT_SEQUENCE_CONFLICT');
      if(this.#state.records.length>=4096||this.#state.records.filter(v=>v.target.runId===t.runId&&scopeKey(v.scope)===scopeKey(s)).length>=256)reject('HOST_EVENT_CAPACITY');
      r={scope:s,target:t,sessionId:context.sessionId,sessionRef:context.sessionRef,dispatchKey:context.dispatchKey,deliveryId:e.deliveryId,seq:e.seq,occurredAt:e.occurredAt,envelopeDigest:fingerprint,phase:'receiving',record:null,applied:null};
      this.#state.records.push(r);this.#save();
      try{
        const recheck=()=>{if(guard()!==true)reject('HOST_EVENT_INGRESS_FENCED');this.#resolveRecord(r);};
        this.#fault('after-event-intent');const source=await this.#prepare(s,t);recheck();
        const receive=await source.prepare(e);recheck();
        if(typeof receive!=='function')reject('HOST_EVENT_INGRESS_REQUIRED');
        // The trusted source invokes a synchronous Adapter accept entry point.
        // No event authorization survives an await or leaks into other work.
        const accepted=receive(e);if(accepted&&typeof accepted.then==='function')reject('HOST_EVENT_INGRESS_MUST_BE_SYNCHRONOUS');
        recheck();this.#fault('after-event-adapter');
        if(!await this.#readSource(r,source))return this.#unknown(r,'DURABLE_EVENT_SOURCE_REQUIRED');
        recheck();
        return this.#confirm(r);
      }catch(error){
        if(this.#faulted||this.#closed)throw error;
        return this.#unknown(r,error?.code??'EVENT_RECEIPT_UNKNOWN');
      }
    });
  }
  replay(value,input,deliveryId){
    const s=this.#scope(value),t=target(input);identifier(deliveryId);this.#available();
    return this.#scheduler.submit(s,'event-'+hash([t.runId,deliveryId]),async()=>{
      const r=this.#find(s,t,deliveryId);if(!r||hash(r.target)!==hash(t))reject('HOST_EVENT_INTENT_ABSENT');
      this.#resolveRecord(r);if(r.phase==='confirmed')return this.#report(r,null,true);
      try{
        // Always revalidate the durable public source, including after a Host
        // receipt. Adapter journal failure cannot become a Store acceptance.
        const source=await this.#prepare(s,t);this.#resolveRecord(r);
        if(!await this.#readSource(r,source))return this.#unknown(r,'DURABLE_EVENT_SOURCE_REQUIRED');
        return this.#confirm(r);
      }catch(error){if(this.#faulted||this.#closed)throw error;return this.#unknown(r,error?.code??'EVENT_RECEIPT_UNKNOWN');}
    });
  }
  status(value,input,deliveryId){
    const s=this.#scope(value),t=target(input);identifier(deliveryId);this.#available();const r=this.#find(s,t,deliveryId);
    if(!r||hash(r.target)!==hash(t))reject('HOST_EVENT_INTENT_ABSENT');this.#resolveRecord(r);return this.#report(r);
  }
  close(){if(this.#closed)return;this.#closed=true;this.#scheduler.close();}
}
