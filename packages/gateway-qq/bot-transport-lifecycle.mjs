import { boundedText, identifier, integer, object, reject } from '../core/contracts.mjs';
import { activeBinding, validateConfiguration } from '../core/configuration.mjs';

// Trusted-host, offline transport contract. The caller supplies every operation;
// this module imports no SDK, starts no timers and never submits work or output.
export class BotTransportLifecycle {
  #config; #gateway; #store; #credentials; #factory; #clock; #options; #bots=new Map();
  constructor(configuration,{gateway,store,credentialProvider,transportFactory,clock=()=>Date.now(),refreshBeforeMs=30000,baseBackoffMs=1000,maxBackoffMs=60000,maxRetries=3}){
    this.#config=validateConfiguration(configuration);
    if(typeof credentialProvider!=='function'||typeof transportFactory!=='function')reject('INVALID_TRANSPORT_FACTORY');
    integer(refreshBeforeMs,0);integer(baseBackoffMs);integer(maxBackoffMs);integer(maxRetries,0);
    if(baseBackoffMs>maxBackoffMs||maxRetries>20||maxBackoffMs>3600000)reject('INVALID_RECONNECT_POLICY');
    this.#gateway=gateway;this.#store=store;this.#credentials=credentialProvider;this.#factory=transportFactory;this.#clock=clock;
    this.#options={refreshBeforeMs,baseBackoffMs,maxBackoffMs,maxRetries};
  }
  #now(){return integer(this.#clock(),0);}
  #identity(botId){return JSON.stringify(activeBinding(this.#config,botId));}
  #entry(botId){
    identifier(botId);
    if(!this.#bots.has(botId)){
      activeBinding(this.#config,botId);
      const control=this.#store.transportState(botId);
      this.#bots.set(botId,{botId,phase:control.stopped||control.hostStopped?'stopped':'idle',op:null,attempts:0,failures:0,retryAt:null,expiresAt:null,refreshAt:null,rateLimitedUntil:0,errorCode:null,cleanupFailed:false});
    }
    return this.#bots.get(botId);
  }
  #current(entry,op){
    const control=this.#store.transportState(entry.botId);
    return entry.op===op&&!op.retired&&!control.stopped&&!control.hostStopped&&control.generation===op.generation;
  }
  #close(entry,transport){
    try{Promise.resolve(transport?.close()).catch(()=>{entry.cleanupFailed=true;});}catch{entry.cleanupFailed=true;}
  }
  #retire(entry){
    const op=entry.op;if(!op||op.retired)return;
    op.retired=true;op.controller.abort();op.port?.close();this.#close(entry,op.transport);
  }
  #backoff(entry,op,code,retryAfterMs=0){
    if(!this.#current(entry,op))return;
    this.#retire(entry);entry.errorCode=code;entry.failures++;
    entry.expiresAt=null;entry.refreshAt=null;
    if(entry.failures>this.#options.maxRetries){entry.phase='exhausted';entry.retryAt=null;return;}
    entry.phase='backoff';
    const delay=Math.min(this.#options.maxBackoffMs,this.#options.baseBackoffMs*2**(entry.failures-1));
    entry.retryAt=this.#now()+Math.max(delay,retryAfterMs);
  }
  #message(entry,op,raw){
    if(!this.#current(entry,op)||entry.phase!=='connected')return {ignored:true,reason:'stale_connection'};
    if(this.#now()>=entry.expiresAt){
      this.#retire(entry);entry.phase='backoff';entry.retryAt=this.#now();entry.errorCode='CREDENTIAL_EXPIRED';
      return {ignored:true,reason:'expired_connection'};
    }
    if(this.#now()<entry.rateLimitedUntil)reject('BOT_RATE_LIMITED');
    return op.port.receive(raw);
  }
  async #connect(entry){
    this.#retire(entry);
    const {bot}=activeBinding(this.#config,entry.botId);
    const generation=this.#store.nextTransportGeneration(bot.id);
    const op={generation,retired:false,transport:null,port:null,controller:new AbortController()};
    entry.op=op;entry.phase='connecting';entry.retryAt=null;entry.expiresAt=null;entry.refreshAt=null;entry.errorCode=null;entry.attempts++;
    let stage='credential';
    try{
      if(bot.credentialRef===null)reject('CREDENTIAL_REFERENCE_REQUIRED');
      const credential=await this.#credentials({botId:bot.id,credentialRef:bot.credentialRef,generation,signal:op.controller.signal});
      if(!this.#current(entry,op))return this.status(bot.id);
      object(credential,['botId','credentialRef','appId','token','expiresAt']);
      if(credential.botId!==bot.id||credential.credentialRef!==bot.credentialRef||credential.appId!==bot.appId)reject('CREDENTIAL_IDENTITY_MISMATCH');
      boundedText(credential.token,4096);integer(credential.expiresAt);
      if(credential.expiresAt<=this.#now())reject('CREDENTIAL_EXPIRED');
      stage='transport';
      const transport=await this.#factory({botId:bot.id,appId:bot.appId,generation,signal:op.controller.signal,
        onMessage:raw=>this.#message(entry,op,raw),
        onDisconnect:()=>this.#backoff(entry,op,'TRANSPORT_DISCONNECTED'),
        onAuthenticationFailure:()=>{
          if(!this.#current(entry,op))return;
          this.#retire(entry);entry.phase='credential_error';entry.errorCode='BOT_AUTHENTICATION_FAILED';entry.retryAt=null;
          entry.expiresAt=null;entry.refreshAt=null;
        },
        onRateLimit:retryAfterMs=>{
          if(!this.#current(entry,op))return;
          integer(retryAfterMs,0);if(retryAfterMs>3600000)reject('INVALID_RATE_LIMIT');
          entry.rateLimitedUntil=Math.max(entry.rateLimitedUntil,this.#now()+retryAfterMs);
        }});
      if(!this.#current(entry,op)){this.#close(entry,transport);return this.status(bot.id);}
      op.transport=transport;
      if(typeof transport?.connect!=='function'||typeof transport?.close!=='function')reject('INVALID_TRANSPORT_FACTORY');
      const result=await transport.connect({token:credential.token,appId:bot.appId,signal:op.controller.signal});
      if(!this.#current(entry,op))return this.status(bot.id);
      object(result,['authenticatedAppId']);
      if(result.authenticatedAppId!==bot.appId)reject('BOT_AUTHENTICATION_FAILED');
      if(credential.expiresAt<=this.#now())reject('CREDENTIAL_EXPIRED');
      op.port=this.#gateway.attach(bot.id,result);
      entry.phase='connected';entry.expiresAt=credential.expiresAt;
      entry.refreshAt=Math.max(this.#now()+1,credential.expiresAt-this.#options.refreshBeforeMs);
    }catch(error){
      if(this.#current(entry,op)){
        // Never retain a provider/transport error message, token or stack.
        const authentication=['BOT_AUTHENTICATION_FAILED','CREDENTIAL_EXPIRED'].includes(error?.code);
        if(stage==='credential'||authentication){
          this.#retire(entry);entry.phase='credential_error';entry.errorCode='BOT_AUTHENTICATION_FAILED';entry.retryAt=null;
        }else this.#backoff(entry,op,'TRANSPORT_CONNECT_FAILED');
      }
    }
    return this.status(bot.id);
  }
  start(botId){
    const entry=this.#entry(botId),control=this.#store.transportState(botId);
    if(control.hostStopped)reject('HOST_STOPPED');if(control.stopped)reject('BOT_STOPPED');
    if(['connecting','connected'].includes(entry.phase))reject('BOT_CONNECTION_EXISTS');
    entry.failures=0;return this.#connect(entry);
  }
  stop(botId){
    const entry=this.#entry(botId);this.#store.stopBot(botId);this.#retire(entry);
    entry.phase='stopped';entry.retryAt=null;entry.expiresAt=null;entry.refreshAt=null;
    return this.status(botId);
  }
  resume(botId){
    const entry=this.#entry(botId);this.#store.resumeBot(botId);this.#retire(entry);
    entry.phase='idle';entry.retryAt=null;return this.status(botId);
  }
  replaceConfiguration(input){
    const next=validateConfiguration(input);this.#gateway.replaceConfiguration(next);
    const previous=this.#config;this.#config=next;
    for(const entry of this.#bots.values()){
      let changed=true;try{changed=JSON.stringify(activeBinding(previous,entry.botId))!==this.#identity(entry.botId);}catch{}
      if(changed){this.#retire(entry);entry.phase='idle';entry.retryAt=null;entry.expiresAt=null;entry.refreshAt=null;}
    }
  }
  async tick(){
    const pending=[];
    for(const entry of this.#bots.values()){
      const control=this.#store.transportState(entry.botId);
      if(control.stopped||control.hostStopped){this.#retire(entry);entry.phase='stopped';entry.retryAt=null;continue;}
      if(entry.op&&control.generation!==entry.op.generation){
        this.#retire(entry);entry.phase='idle';entry.retryAt=null;continue;
      }
      if(entry.phase==='connected'&&this.#now()>=entry.refreshAt||entry.phase==='backoff'&&this.#now()>=entry.retryAt)pending.push(this.#connect(entry));
    }
    await Promise.all(pending);
    return [...this.#bots.values()].map(entry=>this.#snapshot(entry));
  }
  #snapshot(entry){
    const control=this.#store.transportState(entry.botId);
    const state=control.stopped||control.hostStopped?'stopped':entry.op&&control.generation!==entry.op.generation?'idle':entry.phase==='connected'&&this.#now()>=entry.expiresAt?'expired':entry.phase;
    return Object.freeze({botId:entry.botId,state,generation:control.generation,
      attempts:entry.attempts,failures:entry.failures,expiresAt:state==='connected'?entry.expiresAt:null,refreshAt:state==='connected'?entry.refreshAt:null,retryAt:state==='backoff'?entry.retryAt:null,
      rateLimitedUntil:entry.rateLimitedUntil,errorCode:entry.errorCode,cleanupFailed:entry.cleanupFailed});
  }
  status(botId){return this.#snapshot(this.#entry(botId));}
}
