import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';

export const nativeUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
// Reviewed against the existing local-program adapter and desktop stream v11.
// This client follows an owner. It never starts a router or claims ownership.
const versions=new Map([['initialize',0],['thread-owner-discovery',1],['thread-follower-steer-turn',1],['thread-follower-start-turn',2],['thread-follower-interrupt-turn',4],['thread-follower-submit-user-input',1]]);
const limit=32*1024*1024;
export class NativeOwnerError extends Error{constructor(code,uncertain=false){super(code);this.code=code;this.uncertain=uncertain;}}
export class NativeOwnerConnection{
 constructor({connect=createConnection,timeoutMs=5000,guard=()=>{},now=()=>Date.now()}={}){Object.assign(this,{connect,timeoutMs,guard,now});this.pending=new Map();this.waiters=new Map();this.followed=new Map();this.snapshots=new WeakSet();this.clientId=null;this.epoch=0;this.socket=null;this.opening=null;}
 async ready(){this.guard();if(this.socket?.writable&&this.clientId)return;if(this.opening)return this.opening;this.opening=this.open();try{await this.opening;}finally{this.opening=null;}}
 async open(){
  const socket=this.connect('\\\\.\\pipe\\codex-ipc');this.socket=socket;this.bytes=Buffer.alloc(0);this.clientId=null;this.epoch++;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(new NativeOwnerError('NATIVE_OWNER_CONNECT_TIMEOUT'));},this.timeoutMs);socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.on('data',chunk=>{if(this.socket===socket)this.consume(chunk);});socket.on('error',()=>{clearTimeout(timer);reject(new NativeOwnerError('NATIVE_OWNER_UNAVAILABLE'));if(this.socket===socket)this.disconnected();});socket.on('close',()=>{clearTimeout(timer);reject(new NativeOwnerError('NATIVE_OWNER_CONNECTION_LOST'));if(this.socket===socket)this.disconnected();});});
  const response=await this.request('initialize',{clientType:'qq-native-owner-bridge'});
  if(!nativeUuid(response.result?.clientId)){this.close();throw new NativeOwnerError('NATIVE_OWNER_PROTOCOL_UNSUPPORTED');}this.clientId=response.result.clientId;
 }
 disconnected(){this.clientId=null;this.epoch++;this.followed.clear();for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new NativeOwnerError('NATIVE_OWNER_CONNECTION_LOST',entry.write&&entry.sent));}this.pending.clear();for(const entry of this.waiters.values()){clearTimeout(entry.timer);entry.reject(new NativeOwnerError('NATIVE_OWNER_CONNECTION_LOST'));}this.waiters.clear();}
 frame(message){this.guard();if(!this.socket?.writable)throw new NativeOwnerError('NATIVE_OWNER_UNAVAILABLE');const bytes=Buffer.from(JSON.stringify(message));if(!bytes.length||bytes.length>limit)throw new NativeOwnerError('NATIVE_OWNER_FRAME_TOO_LARGE');const frame=Buffer.alloc(bytes.length+4);frame.writeUInt32LE(bytes.length);bytes.copy(frame,4);this.socket.write(frame);}
 consume(chunk){
  try{
   this.guard();this.bytes=Buffer.concat([this.bytes,chunk]);
   while(this.bytes.length>=4){const size=this.bytes.readUInt32LE(0);if(!size||size>limit)throw Error('INVALID_FRAME');if(this.bytes.length<size+4)break;const message=JSON.parse(this.bytes.subarray(4,size+4).toString('utf8'));this.bytes=this.bytes.subarray(size+4);
    if(message.type==='response'){
     const entry=this.pending.get(message.requestId);if(!entry)continue;this.pending.delete(message.requestId);clearTimeout(entry.timer);
     if(message.resultType!=='success'||entry.target&&message.handledByClientId!==entry.target)entry.reject(new NativeOwnerError('NATIVE_OWNER_REQUEST_FAILED',entry.write&&entry.sent));else entry.resolve(message);
    }else if(message.type==='client-discovery-request')this.frame({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});
    else if(message.type==='broadcast'&&message.method==='thread-stream-state-changed'){
     const p=message.params,entry=this.waiters.get(p?.conversationId);if(!entry||entry.owner!==message.sourceClientId||p.hostId!=='local'||p.change?.type!=='snapshot')continue;
     if(message.version!==11){this.waiters.delete(p.conversationId);clearTimeout(entry.timer);entry.reject(new NativeOwnerError('NATIVE_OWNER_STREAM_VERSION_UNSUPPORTED'));continue;}
     const state=p.change.conversationState;if(state?.id!==p.conversationId||state.hostId!=='local')continue;
     this.waiters.delete(p.conversationId);clearTimeout(entry.timer);const snapshot={state,owner:entry.owner,epoch:this.epoch,receivedAt:this.now(),streamVersion:11,supportsUntrustedAppInput:entry.supportsUntrustedAppInput};this.snapshots.add(snapshot);entry.resolve(snapshot);
    }
   }
   if(this.bytes.length>limit+4)throw Error('INVALID_FRAME');
  }catch{this.close();}
 }
 request(method,params,target){
  if(!versions.has(method))return Promise.reject(new NativeOwnerError('NATIVE_OWNER_METHOD_FORBIDDEN'));
  const requestId=randomUUID(),write=method.startsWith('thread-follower-');
  return new Promise((resolve,reject)=>{const entry={resolve,reject,target,write,sent:false,timer:setTimeout(()=>{this.pending.delete(requestId);reject(new NativeOwnerError('NATIVE_OWNER_TIMEOUT',write&&entry.sent));},this.timeoutMs)};this.pending.set(requestId,entry);
   try{this.guard();entry.sent=true;this.frame({type:'request',requestId,sourceClientId:this.clientId||'initializing-client',method,params,version:versions.get(method),...(target?{targetClientId:target}:{}),timeoutMs:this.timeoutMs});}catch(error){clearTimeout(entry.timer);this.pending.delete(requestId);reject(new NativeOwnerError(error.code||'NATIVE_OWNER_UNAVAILABLE',write&&entry.sent));}
  });
 }
 async snapshot(threadId){
  if(!nativeUuid(threadId))throw new NativeOwnerError('NATIVE_OWNER_THREAD_INVALID');await this.ready();
  const discovery=await this.request('thread-owner-discovery',{hostId:'local',conversationId:threadId}),owner=discovery.handledByClientId;if(!nativeUuid(owner))throw new NativeOwnerError('NATIVE_OWNER_MISSING');
  if(this.waiters.has(threadId))throw new NativeOwnerError('NATIVE_OWNER_SNAPSHOT_BUSY');
  const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(threadId);reject(new NativeOwnerError('NATIVE_OWNER_SNAPSHOT_TIMEOUT'));},this.timeoutMs);this.waiters.set(threadId,{owner,resolve,reject,timer,supportsUntrustedAppInput:discovery.result?.supportsUntrustedAppInput===true});});
  try{this.followed.set(threadId,owner);this.frame({type:'broadcast',sourceClientId:this.clientId,targetClientIds:[owner],method:'thread-stream-following-changed',version:1,params:{conversationId:threadId,hostId:'local',following:true}});}catch(error){const waiter=this.waiters.get(threadId);if(waiter){this.waiters.delete(threadId);clearTimeout(waiter.timer);waiter.reject(error);}}
  try{return await result;}finally{this.followed.delete(threadId);try{this.frame({type:'broadcast',sourceClientId:this.clientId,targetClientIds:[owner],method:'thread-stream-following-changed',version:1,params:{conversationId:threadId,hostId:'local',following:false}});}catch{}}
 }
 bound(snapshot){this.guard();if(!this.snapshots.has(snapshot)||snapshot.epoch!==this.epoch||!this.socket?.writable||!nativeUuid(snapshot.owner)||snapshot.state.hostId!=='local'||this.now()-snapshot.receivedAt>10000||this.now()<snapshot.receivedAt)throw new NativeOwnerError('NATIVE_OWNER_SNAPSHOT_STALE');}
 async mutate(snapshot,method,params){this.bound(snapshot);if(!method.startsWith('thread-follower-')||params.conversationId!==snapshot.state.id)throw new NativeOwnerError('NATIVE_OWNER_TARGET_CHANGED');const reply=await this.request(method,params,snapshot.owner);if(reply.result?.method!==method)throw new NativeOwnerError('NATIVE_OWNER_RESPONSE_UNKNOWN',true);return reply.result.result;}
 async guide(snapshot,text,{activeTurnId,messageId=randomUUID()}={}){
  if(typeof text!=='string'||!text.trim()||text.length>8000)throw new NativeOwnerError('NATIVE_OWNER_INPUT_INVALID');
  const input=[{type:'text',text,text_elements:[]}],restoreMessage={id:messageId,cwd:snapshot.state.cwd,context:{prompt:text,workspaceRoots:snapshot.state.cwd?[snapshot.state.cwd]:[],addedFiles:[],fileAttachments:[],imageAttachments:[],ideContext:null}};
  const result=activeTurnId?await this.mutate(snapshot,'thread-follower-steer-turn',{conversationId:snapshot.state.id,clientUserMessageId:messageId,input,restoreMessage})
   :await this.mutate(snapshot,'thread-follower-start-turn',{conversationId:snapshot.state.id,turnStart:{request:{threadId:snapshot.state.id,input,clientUserMessageId:messageId},context:{inheritThreadSettings:true,restoreMessage}}});
  const turnId=result?.result?.turnId||result?.result?.turn?.id;if(!nativeUuid(turnId)||activeTurnId&&turnId!==activeTurnId)throw new NativeOwnerError('NATIVE_OWNER_RESPONSE_UNKNOWN',true);return {turnId,messageId};
 }
 async interrupt(snapshot,turnId){if(!nativeUuid(turnId))throw new NativeOwnerError('NATIVE_OWNER_TURN_REQUIRED');const result=await this.mutate(snapshot,'thread-follower-interrupt-turn',{conversationId:snapshot.state.id,mode:'user-stop',expectedTurnId:turnId});if(result?.ok!==true||result.interruptedTurnId!==turnId)throw new NativeOwnerError('NATIVE_OWNER_RESPONSE_UNKNOWN',true);return {turnId,accepted:true};}
 async answer(snapshot,entry,answers,{messageId=randomUUID()}={}){
  if(!nativeUuid(entry?.turnId)||!Array.isArray(entry.questions)||!entry.questions.length||!entry.questions.every(q=>Object.hasOwn(answers,q.id)&&typeof answers[q.id]==='string'&&answers[q.id].trim()))throw new NativeOwnerError('NATIVE_OWNER_ANSWER_INVALID');
  if(entry.kind==='sync'){
   const response={answers:Object.fromEntries(entry.questions.map(q=>[q.id,{answers:[answers[q.id]]}]))},result=await this.mutate(snapshot,'thread-follower-submit-user-input',{conversationId:snapshot.state.id,requestId:entry.requestId,response});
   if(result?.ok!==true)throw new NativeOwnerError('NATIVE_OWNER_RESPONSE_UNKNOWN',true);return {accepted:true};
  }
  if(entry.kind!=='async'||entry.questions.some(q=>!q.questionItemId))throw new NativeOwnerError('NATIVE_OWNER_ANSWER_INVALID');
  const text='<send_user_message_question_reply>\n'+JSON.stringify(entry.questions.map(q=>({questionItemId:q.questionItemId,question:q.text,answer:answers[q.id]})))+'\n</send_user_message_question_reply>';
  return this.guide(snapshot,text,{activeTurnId:entry.turnId,messageId});
 }
 close(){if(this.socket?.writable&&this.clientId)for(const [conversationId,owner]of this.followed)try{this.frame({type:'broadcast',sourceClientId:this.clientId,targetClientIds:[owner],method:'thread-stream-following-changed',version:1,params:{conversationId,hostId:'local',following:false}});}catch{}const socket=this.socket;this.socket=null;socket?.destroy();this.disconnected();}
}
