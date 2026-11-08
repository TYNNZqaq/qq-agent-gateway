import { randomUUID } from 'node:crypto';
import { boundedText, conversationId, identifier, integer, object, principalId, reject, scope } from '../core/contracts.mjs';
import { activeBinding, validateConfiguration } from '../core/configuration.mjs';

// Contract for a future authenticated SDK transport. No network SDK is imported
// or constructed here. Only the trusted host receives connection handles.
export class LocalGateway {
  #config; #store; #clock; #ports=new Map(); #rates=new Map(); #limits;
  constructor(configuration,store,{clock=()=>Date.now(),messagesPerMinute=60}={}){
    this.#config=validateConfiguration(configuration);this.#store=store;this.#clock=clock;this.#limits=integer(messagesPerMinute);
    store.installConfiguration(this.#config);
  }
  #scope(botId,senderRef,conversationRef){
    const {bot,binding,agent,policy}=activeBinding(this.#config,identifier(botId));
    return scope({hostId:this.#config.hostId,botId:bot.id,agentId:agent.id,bindingId:binding.id,bindingVersion:binding.version,
      principalId:principalId(this.#config.hostId,bot.id,senderRef),conversationId:conversationId(bot.id,conversationRef),projectId:agent.workspaceRef,policyVersion:policy.version});
  }
  pair({botId,senderRef,conversationRef,expiresAt}){
    identifier(botId);boundedText(senderRef,512);boundedText(conversationRef,512);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=this.#clock())reject('PAIRING_EXPIRED');
    return this.#store.grantPairing(this.#scope(botId,senderRef,conversationRef),{expiresAt});
  }
  unpair({botId,senderRef,conversationRef}){
    return this.#store.revokePairing(this.#scope(identifier(botId),boundedText(senderRef,512),boundedText(conversationRef,512)));
  }
  replaceConfiguration(input){
    const next=validateConfiguration(input);
    if(next.hostId!==this.#config.hostId)reject('HOST_MISMATCH');
    // Commit and validate binding versions before invalidating transport handles.
    this.#store.installConfiguration(next);
    for(const [botId,port] of this.#ports){
      let nextIdentity;try{nextIdentity=JSON.stringify(activeBinding(next,botId));}catch{nextIdentity=null;}
      if(nextIdentity!==port.identity){port.closed=true;this.#ports.delete(botId);}
    }
    this.#config=next;
  }
  attach(botId,connection){
    object(connection,['authenticatedAppId']);
    const identity=activeBinding(this.#config,identifier(botId));
    const control=this.#store.transportState(botId);
    if(control.hostStopped)reject('HOST_STOPPED');if(control.stopped)reject('BOT_STOPPED');
    if(connection.authenticatedAppId!==identity.bot.appId)reject('BOT_AUTHENTICATION_FAILED');
    if(this.#ports.has(botId))reject('BOT_CONNECTION_EXISTS');
    const port={id:randomUUID(),botId,identity:JSON.stringify(identity),closed:false};
    if(!this.#rates.has(botId))this.#rates.set(botId,{window:this.#clock(),count:0});
    this.#ports.set(botId,port);
    return Object.freeze({id:port.id,botId,
      receive:raw=>this.#receive(port,raw),
      close:()=>{if(this.#ports.get(botId)===port)this.#ports.delete(botId);port.closed=true;}
    });
  }
  #receive(port,raw){
    if(port.closed||this.#ports.get(port.botId)!==port)reject('CONNECTION_REVOKED');
    object(raw,['eventId','senderRef','conversationRef','senderIsBot','targetAppId','kind','text']);
    const {bot}=activeBinding(this.#config,port.botId);
    if(raw.targetAppId!==bot.appId)reject('WRONG_BOT_TARGET');
    boundedText(raw.eventId,512);boundedText(raw.senderRef,512);boundedText(raw.conversationRef,512);
    if(typeof raw.senderIsBot!=='boolean')reject('INVALID_TRANSPORT_AUTHOR');
    if(raw.senderIsBot)return {ignored:true,reason:'bot_echo'};
    const checked=this.#scope(bot.id,raw.senderRef,raw.conversationRef);this.#store.requirePairing(checked);
    const rate=this.#rates.get(bot.id),now=this.#clock();if(now-rate.window>=60000){rate.window=now;rate.count=0;}
    if(rate.count>=this.#limits)reject('BOT_RATE_LIMITED');rate.count++;
    return {scope:checked,...this.#store.acceptInbound(checked,{eventId:raw.eventId,kind:raw.kind,text:raw.text})};
  }
}
