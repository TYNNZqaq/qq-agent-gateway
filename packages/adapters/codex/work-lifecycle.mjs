import { scope,scopeKey,identifier,reject,freeze } from '../../core/contracts.mjs';

// Independent current work prerequisite. Not registered as an executable
// eight-method Adapter; the historical synthetic Adapter is unchanged.
export const WORK_LIFECYCLE_PROTOCOL='codex-app-server/0.164.0-alpha.11.1';
export class CodexWorkLifecycle {
  #journal;#state;#factory;#authorize;#handle=null;#busy=false;#closed=false;#broken=false;
  constructor({owner,runtimeIdentity,journal,transportFactory,authorize}){
    Object.defineProperty(this,'owner',{value:scope(owner),writable:false,configurable:false});if(!journal||typeof journal.load!=='function'||typeof journal.commit!=='function'||typeof transportFactory!=='function'||typeof authorize!=='function')reject('WORK_DEPENDENCIES_REQUIRED');
    identifier(runtimeIdentity);
    this.#journal=journal;this.#factory=transportFactory;this.#authorize=authorize;
    const old=journal.load();
    if(old&&(old.schemaVersion!==1||old.channelKind!=='codex-work-lifecycle'||old.protocol!==WORK_LIFECYCLE_PROTOCOL||old.runtimeIdentity!==runtimeIdentity||scopeKey(old.scope)!==scopeKey(this.owner)))reject('WORK_JOURNAL_OWNER_OR_VERSION');
    this.#state=old??{schemaVersion:1,channelKind:'codex-work-lifecycle',revision:0,owner:{hostId:this.owner.hostId,agentId:this.owner.agentId},scope:this.owner,runtimeIdentity,protocol:WORK_LIFECYCLE_PROTOCOL,process:null,sessions:[]};
    if(!Array.isArray(this.#state.sessions)||this.#state.sessions.length>64)reject('WORK_JOURNAL_INVALID');
    const keys=new Set(),threads=new Set();for(const s of this.#state.sessions){identifier(s.key);if(keys.has(s.key)||!['intent','unknown','opened','closed'].includes(s.state)||(s.threadId!==null&&(identifier(s.threadId),threads.has(s.threadId))))reject('WORK_JOURNAL_INVALID');keys.add(s.key);if(s.threadId)threads.add(s.threadId);}
    // Reopen fences the old object, never spawns or retries a previous action.
    for(const s of this.#state.sessions)if(s.state==='intent')s.state='unknown';
    this.#save();
  }
  #guard(){if(this.#closed||this.#broken)reject('WORK_OBJECT_UNAVAILABLE');const current=this.#journal.load();if((current?.revision??0)!==this.#state.revision){this.#broken=true;reject('WORK_STALE_OBJECT');}}
  #save(){const next=structuredClone(this.#state);next.revision++;try{if(this.#journal.commit(next,this.#state.revision)!==true)reject('WORK_STALE_OBJECT');this.#state=next;}catch(error){this.#broken=true;throw error;}}
  #check(owner,operation){this.#guard();if(scopeKey(owner)!==scopeKey(this.owner))reject('WORK_OWNER_MISMATCH');if(this.#authorize(freeze({scope:scope(owner),operation,executionApproved:false}))!==true)reject('WORK_AUTHORIZATION_REJECTED');this.#guard();}
  #session(key){identifier(key);const s=this.#state.sessions.find(x=>x.key===key);if(!s)reject('WORK_SESSION_NOT_OWNED');return s;}
  snapshot(owner){this.#check(owner,'status');return structuredClone({...this.#state,executionEnabled:false,eventsReliable:false});}
  async #process(owner){
    this.#check(owner,'prepare');if(this.#handle)return this.#handle;
    if(this.#state.process)reject('WORK_PREVIOUS_PROCESS_REQUIRES_RECONCILIATION');
    this.#state.process={state:'starting',pid:null};this.#save();
    const h=await this.#factory({owner:this.owner,runtimeIdentity:this.#state.runtimeIdentity,guard:()=>this.#check(owner,'transport'),onSpawn:pid=>{this.#check(owner,'spawn');if(!Number.isSafeInteger(pid)||pid<=0)reject('WORK_PROCESS_ID_INVALID');this.#state.process.pid=pid;this.#save();}});
    try{this.#check(owner,'prepared');if(h?.mode!=='real-no-generation'||h.protocolVersion!==WORK_LIFECYCLE_PROTOCOL||h.pid!==this.#state.process.pid||h.pid===null)reject('WORK_TRANSPORT_MODE_REJECTED');this.#state.process.state='ready';this.#save();this.#handle=h;return h;}catch(error){await h?.close();throw error;}
  }
  async #serial(owner,operation,work){this.#check(owner,operation);if(this.#busy)reject('WORK_BUSY');this.#busy=true;try{return await work();}finally{this.#busy=false;}}
  async probe(owner){return this.#serial(owner,'probe',async()=>{const h=await this.#process(owner);this.#check(owner,'probe');return h.probe();});}
  async openSession(owner,{key,...extra}){
    identifier(key);if(Object.keys(extra).length)reject('WORK_SESSION_FIELDS_FORBIDDEN');
    return this.#serial(owner,'openSession',async()=>{
      const existing=this.#state.sessions.find(s=>s.key===key);if(existing)return structuredClone(existing);
      if(this.#state.sessions.length>=64)reject('WORK_SESSION_LIMIT');
      if(this.#state.sessions.some(s=>['intent','unknown'].includes(s.state)))reject('WORK_UNKNOWN_SESSION_PENDING');
      this.#state.sessions.push({key,state:'intent',threadId:null,empty:true});this.#save();
      try{const h=await this.#process(owner);this.#check(owner,'beforeOpen');const result=await h.startEmpty();this.#check(owner,'afterOpen');identifier(result?.threadId);if(result.empty!==true||this.#state.sessions.some(s=>s.threadId===result.threadId))reject('WORK_THREAD_RESULT_REJECTED');const s=this.#session(key);s.threadId=result.threadId;s.state='opened';this.#save();return structuredClone(s);}
      catch(error){try{this.#guard();this.#session(key).state='unknown';this.#save();}catch{}throw error;}
    });
  }
  async reconcile(owner,{key,...extra}){if(Object.keys(extra).length)reject('WORK_SESSION_FIELDS_FORBIDDEN');return this.#serial(owner,'reconcile',async()=>{const s=this.#session(key);if(!s.threadId||s.state!=='opened'||!this.#handle)return {state:'unknown',threadId:s.threadId,reason:'NO_ACTIVE_OWNED_EMPTY_SESSION'};const r=await this.#handle.readEmpty(s.threadId);this.#check(owner,'afterRead');return {state:'observed_empty',threadId:r.threadId,executionEnabled:false};});}
  events(owner,{key}){this.#check(owner,'events');this.#session(key);return {events:[],reliable:false,reason:'NO_TURNS_OR_DURABLE_UPSTREAM_EVENT_BRIDGE'};}
  submit(){reject('WORK_EXECUTION_PREREQUISITES_NOT_ACCEPTED');}
  sendInput(){reject('WORK_EXECUTION_PREREQUISITES_NOT_ACCEPTED');}
  cancel(){reject('WORK_EXECUTION_PREREQUISITES_NOT_ACCEPTED');}
  // Storage fencing must not prevent ending this object's own empty process.
  // This cleanup does not mark any persisted action closed or cancel a turn.
  async dispose(){this.#closed=true;const handle=this.#handle;this.#handle=null;if(handle)await handle.close();return {localHandleEnded:true,persistedOutcomeUnchanged:true};}
  async close(owner){return this.#serial(owner,'close',async()=>{if(this.#handle){await this.#handle.close();this.#check(owner,'afterClose');this.#state.process.state='closed';for(const s of this.#state.sessions)if(s.state==='opened')s.state='closed';this.#save();}else if(this.#state.process&&this.#state.process.state!=='closed')reject('WORK_PREVIOUS_PROCESS_REQUIRES_RECONCILIATION');this.#closed=true;return {closed:true};});}
}
