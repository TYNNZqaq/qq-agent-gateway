import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pendingKey} from './bridge-requests.mjs';
import {normalizeNativeQuestions} from './desktop-questions.mjs';
import {completionText} from './completion.mjs';
import {sha256,secretText} from './boundaries.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const key=value=>'clientMcpQuestion:'+value;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const reserved=new Set(['__proto__','constructor','prototype']);
const fail=code=>{throw Error(code);};
const ownerScope=(config,owner)=>({instanceId:config.instanceId,hostId:config.hostId,runtimeRoot:config.runtimeRoot,appId:config.qq.appId,binding:config.binding,owner});
const immutable=r=>({id:r.id,kind:r.kind,transport:r.transport,owner:r.owner,scope:r.scope,requestKey:r.requestKey,source:r.source,questions:r.questions,createdAt:r.createdAt,expiresAt:r.expiresAt,notificationId:r.notificationId});
function inputQuestions(value){
 if(!Array.isArray(value)||value.length<1||value.length>3)fail('CLIENT_QUESTION_FORMAT_INVALID');
 const ids=new Set();
 for(const q of value){
  if(!q||typeof q.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(q.id)||reserved.has(q.id)||ids.has(q.id)||q.isSecret===true)fail('CLIENT_QUESTION_FORMAT_INVALID');
  ids.add(q.id);
  if(q.allow_freeform!==undefined&&typeof q.allow_freeform!=='boolean')fail('CLIENT_QUESTION_FORMAT_INVALID');
 }
 const normalized=normalizeNativeQuestions({questions:value.map(q=>({...q,question:q.question??q.title}))});
 if(normalized.warning||normalized.questions.length!==value.length||JSON.stringify(value).length>12000)fail('CLIENT_QUESTION_LOCAL_ONLY');
 return normalized.questions.map((q,i)=>({id:q.id,question:q.text,options:q.options,allowFreeform:value[i].allow_freeform!==false}));
}
function prompt(request){
 const lines=['客户端问答 B'+request.id,'来源：'+request.source.title+'（客户端声明）'];
 if(request.source.threadId)lines.push('会话：'+request.source.threadId);
 for(const q of request.questions){
  lines.push('\n'+(request.questions.length>1?'['+q.id+'] ':'')+q.question);
  for(const [i,o]of q.options.entries())lines.push((i+1)+'．'+o.label+(o.description?' — '+o.description:''));
 }
 lines.push('\n回复“回答 B'+request.id+'：答案”。');
 if(request.questions.length>1)lines.push('多题使用 JSON 对象，以题目 id 为键，例如：'+JSON.stringify(Object.fromEntries(request.questions.map(q=>[q.id,'答案']))));
 else if(request.questions[0].options.length)lines.push('可回复选项编号、完整选项或自填答案。');
 lines.push('这是普通问答，答案没有工具或权限批准效力。有效期 5 分钟。');
 return lines.join('\n');
}
function answersFor(request){
 const input=request.answers;
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==request.questions.length)fail('CLIENT_ANSWER_FORMAT_INVALID');
 const answers=Object.create(null);
 for(const q of request.questions){
  const values=Object.hasOwn(input,q.id)&&input[q.id]?.answers;
  if(!Array.isArray(values)||values.length!==1||typeof values[0]!=='string'||!values[0].trim()||values[0].length>2000)fail('CLIENT_ANSWER_FORMAT_INVALID');
  let text=values[0].trim();
  if(secretText(text))fail('CLIENT_ANSWER_LOCAL_ONLY');
  if(q.options.length&&/^[1-9]\d?$/.test(text)){
   const option=q.options[Number(text)-1];if(!option)fail('CLIENT_ANSWER_OPTION_INVALID');text=option.label;
  }
  if(q.options.length&&!q.allowFreeform&&!q.options.some(o=>o.label===text))fail('CLIENT_ANSWER_OPTION_INVALID');
  answers[q.id]={answers:[text]};
 }
 return answers;
}
export class ClientQuestionGateway{
 constructor(store,config,{guard=()=>{},now=()=>Date.now()}={}){Object.assign(this,{store,config,guard,now});}
 scope(){return ownerScope(this.config,this.store.get('owner'));}
 identify(args){
  if(!uuid(args?.request_key)||!uuid(args?.reply_key))fail('CLIENT_QUESTION_HANDLE_INVALID');
  const meta=this.store.get(key(args.request_key));
  if(!meta||!same(meta.replyKeyHash,sha256(args.reply_key)))fail('CLIENT_QUESTION_NOT_FOUND');
  if(JSON.stringify(meta.scope)!==JSON.stringify(this.scope()))fail('CLIENT_QUESTION_SCOPE_CHANGED');
  const request=this.store.get(pendingKey(meta.id));
  if(!request||sha256(JSON.stringify(immutable(request)))!==meta.fingerprint)fail('CLIENT_QUESTION_CHANGED');
  return {meta,request};
 }
 ask(args){
  this.guard({online:true});
  if(!uuid(args?.request_key)||!uuid(args?.reply_key))fail('CLIENT_QUESTION_HANDLE_INVALID');
  const questions=inputQuestions(args.questions),source=args.source||{};
  if(typeof source.title!=='string'||!source.title.trim()||source.title.length>100||source.thread_id!==undefined&&!uuid(source.thread_id)||secretText(source.title))fail('CLIENT_QUESTION_SOURCE_INVALID');
  const described={title:completionText(source.title),...(source.thread_id?{threadId:source.thread_id}:{}),confidence:'client-supplied'},inputHash=sha256(JSON.stringify({questions,source:described}));
  this.store.transaction(()=>{
   if(this.store.get(key(args.request_key))){const old=this.identify(args);if(old.meta.inputHash!==inputHash)fail('CLIENT_QUESTION_RETRY_CHANGED');return;}
   const active=this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'clientMcpQuestion:%'").all().map(r=>JSON.parse(r.value)).filter(m=>m.scope.owner===this.store.get('owner')&&m.expiresAt>this.now()&&!m.closedAt);
   if(active.length>=32)fail('CLIENT_QUESTION_QUEUE_FULL');
   const owner=this.store.get('owner');if(!owner)fail('CLIENT_QUESTION_OWNER_REQUIRED');
   const now=this.now(),request={id:randomUUID(),kind:'question',transport:'client-mcp',owner,scope:this.scope(),requestKey:args.request_key,source:described,questions,status:'pending',createdAt:now,expiresAt:now+300000};
   const notice=this.store.ownerNotice('client-mcp-question:'+request.id,prompt(request),this.config.qq.appId,now,'【客户端问答】','bridge_question');
   if(!notice)fail('CLIENT_QUESTION_RECIPIENT_MISSING');
   request.notificationId=notice;
   this.store.set(pendingKey(request.id),request);
   this.store.set(key(args.request_key),{schemaVersion:1,id:request.id,scope:request.scope,replyKeyHash:sha256(args.reply_key),inputHash,fingerprint:sha256(JSON.stringify(immutable(request))),expiresAt:request.expiresAt,closedAt:null});
  });
  return this.read(args);
 }
 read(args){
  this.guard({online:false});
  return this.store.transaction(()=>{
   const {meta,request}=this.identify(args),notice=this.store.db.prepare('SELECT status,provider_id FROM outbox WHERE id=?').get(request.notificationId);
   const base={request_key:args.request_key,question_ref:'B'+request.id,expires_at:request.expiresAt,flow:'original-client-mcp-tool-result',authorization_effect:'none',native_q_form_writeback:false};
   if(request.status==='pending'&&request.expiresAt<=this.now()){
    request.status='expired';this.store.set(pendingKey(request.id),request);this.cancelNotice(request.notificationId);return {...base,status:'expired'};
   }
   if(['queued','submitted','resolved'].includes(request.status)){
    if(notice?.status!=='sent'||!notice.provider_id||this.store.db.prepare("SELECT id FROM outbox_parts WHERE notification_id=? AND (status!='sent' OR provider_id IS NULL)").get(request.notificationId))fail('CLIENT_QUESTION_DELIVERY_UNCONFIRMED');
    let answers;try{answers=answersFor(request);}catch(error){
     if(request.status!=='queued')throw error;
     request.status=error.message==='CLIENT_ANSWER_LOCAL_ONLY'?'blocked':'pending';delete request.answers;this.store.set(pendingKey(request.id),request);
     this.store.ownerNotice('client-mcp-answer-invalid:'+request.id+':'+randomUUID(),'B'+request.id+' 的答案未交给客户端：'+(request.status==='blocked'?'敏感内容请在本机处理。':'请按完整题目重新回复有效选项或答案。'),this.config.qq.appId,this.now(),'【问答提示】','question_reply');
     return {...base,status:request.status,error:error.message};
    }
    const answerHash=sha256(JSON.stringify(answers));
    if(request.status==='queued'){request.status='submitted';this.store.set(pendingKey(request.id),request);}
    return {...base,status:request.status==='resolved'?'acknowledged':'answered',answers,answer_hash:answerHash};
   }
   return {...base,status:request.status,delivery_status:notice?.status||'missing'};
  });
 }
 acknowledge(args){
  this.guard({online:false});
  return this.store.transaction(()=>{
   const result=this.read(args);if(!['answered','acknowledged'].includes(result.status)||!same(result.answer_hash,args.answer_hash))fail('CLIENT_ANSWER_ACK_MISMATCH');
   const {meta,request}=this.identify(args);
   if(request.status!=='resolved'){
    request.status='resolved';this.store.set(pendingKey(request.id),request);meta.closedAt=this.now();this.store.set(key(args.request_key),meta);
    this.store.ownerNotice('client-mcp-answer-ack:'+request.id,'B'+request.id+'：原客户端已领取这条普通答案。',this.config.qq.appId,this.now(),'【问答状态】','question_reply');
   }
   return {...result,status:'acknowledged'};
  });
 }
 cancel(args){
  this.guard({online:false});
  return this.store.transaction(()=>{
   const {meta,request}=this.identify(args);
   if(request.status==='pending'){request.status='cancelled';meta.closedAt=this.now();this.store.set(pendingKey(request.id),request);this.store.set(key(args.request_key),meta);this.cancelNotice(request.notificationId);}
   return {question_ref:'B'+request.id,status:request.status,authorization_effect:'none'};
  });
 }
 cancelNotice(id){
  this.store.db.prepare("UPDATE outbox SET status='cancelled',error='CLIENT_QUESTION_CLOSED' WHERE id=? AND status IN('pending','held')").run(id);
  this.store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='CLIENT_QUESTION_CLOSED' WHERE notification_id=? AND status IN('pending','held')").run(id);
 }
}
