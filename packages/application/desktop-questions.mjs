import path from 'node:path';
import {NativeDesktopReader} from '../host-control/native-desktop-reader.mjs';
import {completionText} from './completion.mjs';
import {sha256,secretText} from './boundaries.mjs';
import {readNativeCatalog} from '../host-control/native-desktop-catalog.mjs';
import {nativeGlobalEnabled} from './native-desktop-scope.mjs';
import {nativeOwnerEnabled} from './native-owner-state.mjs';
import {queueNativeQuestionAnswer} from './native-owner-input.mjs';

const kind='native-client-question',tools=new Set(['request_user_input','request_user_input_async']);
const dataKey=id=>'nativeClientQuestion:'+id,noticeKey=id=>'nativeQuestionNotice:'+id;
export const nativeQuestionData=(store,row)=>row&&store.get(dataKey(row.id));
export {current as nativeQuestionCurrent};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const callId=value=>typeof value==='string'&&/^[a-zA-Z0-9_:-]{1,160}$/.test(value);
const parse=value=>typeof value==='string'?JSON.parse(value):value;
function scope(config,owner){return {schemaVersion:1,instanceId:config.instanceId,hostId:config.hostId,runtimeRoot:config.runtimeRoot||config.stateDir,appId:config.qq.appId,binding:config.binding,owner,home:config.nativeDesktopQuestions?.home,since:config.nativeDesktopQuestions?.since};}
function current(store,config,row){
 if(config.nativeDesktopQuestions?.enabled!==true||!row||row.kind!==kind||row.owner_key!==store.get('owner'))return false;
 const data=store.get(dataKey(row.id));
 return !!data&&JSON.stringify(data.identity.scope)===JSON.stringify(scope(config,store.get('owner')))&&sha256(JSON.stringify(data.identity))===row.fingerprint;
}
export function normalizeNativeQuestions(input){
 if(!input||typeof input!=='object'||!Array.isArray(input.questions)||!input.questions.length||input.questions.length>3)return {questions:[],count:0,warning:'客户端提问格式暂不支持，请在原问题卡片查看。'};
 const count=input.questions.length,raw=JSON.stringify(input);
 if(raw.length>24000)return {questions:[],count,warning:'完整问题超过 QQ 同步长度，请在客户端原问题卡片查看。'};
 if(input.questions.some(q=>q?.isSecret===true)||secretText(raw))return {questions:[],count,warning:'本条包含敏感问题，请在客户端原问题卡片查看和回答。'};
 const questions=input.questions.map((q,index)=>{
  if(!q||typeof q!=='object')throw Error('NATIVE_QUESTION_FORMAT_INVALID');
  const text=q.question??q.title;
  if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('NATIVE_QUESTION_FORMAT_INVALID');
  if(q.options!=null&&(!Array.isArray(q.options)||q.options.length>12))throw Error('NATIVE_QUESTION_FORMAT_INVALID');
  const options=(q.options||[]).map(option=>{
   const label=typeof option==='string'?option:option?.label,description=typeof option==='object'?option.description:null;
   if(typeof label!=='string'||!label.trim()||label.length>2000||description!=null&&(typeof description!=='string'||description.length>2000))throw Error('NATIVE_QUESTION_FORMAT_INVALID');
   return {label:completionText(label),...(description?{description:completionText(description)}:{})};
  });
  return {id:typeof q.id==='string'?q.id:'question_'+index,index,text:completionText(text),options};
 });
 return {questions,count,warning:null};
}
export function nativeQuestionText(row,data){
 const questions=JSON.parse(row.questions),lines=['客户端提问 Q'+row.id,'来源：'+row.title,'会话：'+row.thread_id];
 if(data.warning)lines.push(data.warning);
 else for(const [index,q] of questions.entries()){
  lines.push('\n'+(questions.length>1?'问题 '+(index+1)+'：':'')+q.text);
  for(const [n,option] of q.options.entries())lines.push((n+1)+'．'+option.label+(option.description?' — '+option.description:''));
 }
 lines.push(row.remote_supported===1?'\n回复“回答 Q'+row.id+'：选项编号或文字”。多题可用“1=答案；2=答案”；会交回原问题卡片。':'\n请在客户端原问题卡片回答。客户端作答后，QQ 会收到状态更新。');
 return lines.join('\n');
}
function cancelNotice(store,id){
 if(!id)return;
 store.db.prepare("UPDATE outbox SET status='cancelled',error='NATIVE_QUESTION_ENDED' WHERE id=? AND status IN('pending','held')").run(id);
 store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='NATIVE_QUESTION_ENDED' WHERE notification_id=? AND status='pending'").run(id);
}
function finish(store,config,row,status,now){
 if(row.status!=='pending'||!current(store,config,row))return;
 store.db.prepare("UPDATE desktop_questions SET status=?,last_seen=?,responded_at=? WHERE id=? AND status='pending'").run(status,now,status==='answered'?now:null,row.id);
 const sent=row.notification_id&&store.db.prepare('SELECT provider_id FROM outbox WHERE id=?').get(row.notification_id)?.provider_id;
 cancelNotice(store,row.notification_id);
 if(sent)store.ownerNotice('native-question-state:'+row.request_key,'客户端提问 Q'+row.id+(status==='answered'?'：已在客户端作答。':'：原客户端问题已结束。'),config.qq.appId,now,'【客户端问题状态】','question_reply');
}
export function nativeQuestionNoticeValid(store,config,item){
 const link=store.get(noticeKey(item.id));if(!link)return true;
 const row=store.db.prepare('SELECT * FROM desktop_questions WHERE id=?').get(link.id);
 return current(store,config,row)&&(link.history===true||row.status==='pending');
}
export class DesktopQuestions{
 constructor(store,config,{reader,now=()=>Date.now()}={}){
  Object.assign(this,{store,config,now});this.owner=store.get('owner');this.enabled=config.nativeDesktopQuestions?.enabled===true;this.reader=this.enabled?(reader||new NativeDesktopReader(config.nativeDesktopQuestions.home)):null;this.rotation=0;
 }
 refresh(){
  if(!this.enabled)return;
  const errors=[];
  try{
   this.config.runtimeGuard?.();if(this.owner!==this.store.get('owner'))throw Error('NATIVE_QUESTION_OWNER_CHANGED');
   let rows;
   if(nativeGlobalEnabled(this.config)){const catalog=readNativeCatalog(this.config.nativeDesktopQuestions.home,{reader:this.reader});rows=catalog.rows;errors.push(...catalog.errors);}
   else rows=this.reader.listAll(this.config.nativeDesktopQuestions.since-86400000);
   const selected=new Map(rows.slice(0,2).map(row=>[row.id,row]));
   for(let i=0;i<Math.min(2,rows.length);i++){const row=rows[(this.rotation+i)%rows.length];selected.set(row.id,row);}if(rows.length)this.rotation=(this.rotation+2)%rows.length;
   for(const row of selected.values()){
    if(this.store.get('bridgeThread:'+row.id)||this.store.db.prepare('SELECT id FROM tasks WHERE thread_id=?').get(row.id))continue;
    try{this.observe(row);}catch(error){errors.push({threadId:row.id,error:/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_QUESTION_OBSERVATION_FAILED'});}
   }
   for(const row of this.store.db.prepare("SELECT * FROM desktop_questions WHERE kind=? AND owner_key=? AND status='pending' AND created_at<?").all(kind,this.owner,this.now()-86400000))finish(this.store,this.config,row,'expired',this.now());
  }catch(error){errors.push({error:/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_QUESTION_OBSERVER_UNAVAILABLE'});}
  this.store.set('nativeQuestionStatus',{enabled:true,checkedAt:this.now(),source:'verified-native-client-question-events',error:errors[0]?.error||null,errors:errors.slice(0,12)});
 }
 observe(row){
  const ownerScope=scope(this.config,this.owner),scopeHash=sha256(JSON.stringify(ownerScope)),key='nativeQuestionCursor:'+scopeHash+':'+row.id,prior=this.store.get(key),batch=this.reader.read(row,prior?.cursor,{includeFrames:true,questionEventsOnly:true,readOnlyCatalog:nativeGlobalEnabled(this.config)});
  let activeTurn=prior?.activeTurn||null;
  this.store.transaction(()=>{
   for(const {frame,evidence} of batch.frames){
    const p=frame.payload,at=Date.parse(frame.timestamp);if(!p||!Number.isFinite(at))continue;
    if(frame.type==='event_msg'&&p.type==='task_started'&&uuid(p.turn_id)){
     for(const old of this.pending(row.id).filter(q=>q.turn_id!==p.turn_id&&this.store.get(dataKey(q.id)).toolName==='request_user_input'))finish(this.store,this.config,old,'ended',this.now());activeTurn=p.turn_id;continue;
    }
    if(frame.type==='event_msg'&&['task_complete','turn_aborted'].includes(p.type)&&uuid(p.turn_id)){
     for(const old of this.pending(row.id).filter(q=>q.turn_id===p.turn_id&&this.store.get(dataKey(q.id)).toolName==='request_user_input'))finish(this.store,this.config,old,'ended',this.now());if(activeTurn===p.turn_id)activeTurn=null;continue;
    }
    if(frame.type==='response_item'&&p.type==='function_call'&&tools.has(p.name)&&callId(p.call_id)&&activeTurn&&at>=Math.max(this.config.nativeDesktopQuestions.since,this.config.nativeDesktopQuestions.discoverySince||0)&&at<=this.now()+30000){
     this.register(row,activeTurn,p,at,evidence,batch.cursor.identity,ownerScope);continue;
    }
    if(frame.type==='response_item'&&p.type==='function_call_output'&&callId(p.call_id)){
     const matching=this.pending(row.id).filter(q=>q.request_id===p.call_id);if(!matching.length)continue;
     let output;try{output=parse(p.output);}catch{continue;}
     if(output&&typeof output==='object'&&(Object.hasOwn(output,'answers')||output.accepted===false))for(const q of matching)finish(this.store,this.config,q,Object.keys(output.answers||{}).length?'answered':'ended',this.now());continue;
    }
    if(frame.type==='response_item'&&p.type==='message'&&p.role==='user'){
     const text=(Array.isArray(p.content)?p.content:[]).filter(part=>['input_text','text'].includes(part.type)&&typeof part.text==='string').map(part=>part.text).join('\n').trim();
     const match=/^<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>$/.exec(text);if(!match||match[1].length>65536)continue;
     let replies;try{replies=JSON.parse(match[1]);}catch{continue;}if(!Array.isArray(replies))continue;
     for(const reply of replies){let identity;try{identity=parse(reply.questionItemId);}catch{continue;}if(!Array.isArray(identity)||!tools.has(identity[0])||!callId(identity[1])||!Number.isInteger(identity[2]))continue;
      for(const q of this.pending(row.id).filter(q=>q.request_id===identity[1])){
       const data=this.store.get(dataKey(q.id));if(identity[0]!==data.toolName||identity[2]<0||identity[2]>=data.count)continue;
       data.answeredIndices=[...new Set([...(data.answeredIndices||[]),identity[2]])];this.store.set(dataKey(q.id),data);if(data.answeredIndices.length===data.count)finish(this.store,this.config,q,'answered',this.now());
      }
     }
    }
   }
   for(const question of this.pending(row.id)){
    if(!current(this.store,this.config,question))continue;
    if(!question.notification_id){
     const data=this.store.get(dataKey(question.id)),notice=this.store.ownerNotice('native-question:'+question.request_key,nativeQuestionText(question,data),this.config.qq.appId,this.now(),'【客户端普通提问】','question_notice');
     if(!notice)throw Error('NATIVE_QUESTION_RECIPIENT_MISSING');this.store.db.prepare('UPDATE desktop_questions SET notification_id=? WHERE id=?').run(notice,question.id);this.store.set(noticeKey(notice),{id:question.id});
    }
   }
   this.store.set(key,{cursor:batch.cursor,activeTurn});
  });
 }
 pending(thread){return this.store.db.prepare("SELECT * FROM desktop_questions WHERE kind=? AND owner_key=? AND thread_id=? AND status='pending'").all(kind,this.owner,thread);}
 register(row,turn,p,at,evidence,metadataHash,ownerScope){
  let input;try{input=parse(p.arguments);}catch{input=null;}
  const inputHash=sha256(JSON.stringify(input??p.arguments??null)),requestKey=sha256(JSON.stringify([ownerScope,row.id,turn,p.call_id])),existing=this.store.db.prepare('SELECT * FROM desktop_questions WHERE request_key=?').get(requestKey);
  if(existing){if(this.store.get(dataKey(existing.id)).identity.inputHash!==inputHash){finish(this.store,this.config,existing,'ended',this.now());this.store.db.prepare("UPDATE desktop_questions SET error='NATIVE_QUESTION_CHANGED' WHERE id=?").run(existing.id);}return;}
  let normalized;try{normalized=normalizeNativeQuestions(input);}catch{normalized={questions:[],count:0,warning:'客户端问题格式需要本机查看，请在原问题卡片处理。'};}
  const identity={scope:ownerScope,source:{threadId:row.id,turnId:turn,cwd:row.cwd,transcriptPath:evidence.file,metadataHash,cliVersion:row.cli_version},callId:p.call_id,inputHash},title=completionText(path.basename(row.cwd)||'无项目').slice(0,80);
  const inserted=this.store.db.prepare("INSERT INTO desktop_questions(owner_key,request_key,thread_id,turn_id,kind,request_id,fingerprint,task_ref,title,questions,remote_supported,status,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,0,'pending',?,?)").run(this.owner,requestKey,row.id,turn,kind,p.call_id,sha256(JSON.stringify(identity)),row.id+':'+turn,title,JSON.stringify(normalized.questions),at,this.now());
  this.store.set(dataKey(Number(inserted.lastInsertRowid)),{identity,evidence,toolName:p.name,count:normalized.count,warning:normalized.warning,answeredIndices:[]});
 }
 snapshot(){
  if(!this.enabled)return {enabled:false};
  const control=this.store.get('nativeOwnerStatus'),ready=nativeOwnerEnabled(this.config)&&control?.connected===true&&this.now()>=control.checkedAt&&this.now()-control.checkedAt<=15000;
  return {...this.store.get('nativeQuestionStatus',{enabled:true,checkedAt:null,error:null}),mode:ready?'native-owner-question-writeback':'notification-and-client-answer-state',qqAnswerSubmission:ready,qqAnswerVerification:ready?'connected-no-real-answer-test':'not-connected',counts:this.store.db.prepare('SELECT status,COUNT(*) count FROM desktop_questions WHERE kind=? AND owner_key=? GROUP BY status').all(kind,this.owner),recent:this.store.db.prepare('SELECT id,title,status,notification_id notificationId,error FROM desktop_questions WHERE kind=? AND owner_key=? ORDER BY id DESC LIMIT 5').all(kind,this.owner)};
 }
}
export function routeNativeQuestionCommand(store,config,owner,content,trigger,now=Date.now()){
 if(config.nativeDesktopQuestions?.enabled!==true||owner!==store.get('owner'))return null;
 const match=/^(查看问题|问题|回答)\s+Q([1-9]\d{0,11})(?:\s*[:：]\s*([\s\S]+))?$/i.exec(content);
 if(match){
  const row=store.db.prepare('SELECT * FROM desktop_questions WHERE id=? AND owner_key=? AND kind=?').get(Number(match[2]),owner,kind);
  if(!row||!current(store,config,row))return {text:'未找到当前本人的客户端问题，请发送“问题列表”核对。'};
  if(match[1]==='回答')return nativeOwnerEnabled(config)?queueNativeQuestionAnswer(store,config,row,match[3],trigger,now):{text:'Q'+row.id+' 是客户端问题，请在原客户端问题卡片作答；尚未向客户端提交这条 QQ 文字。'};
  const data=store.get(dataKey(row.id)),notice=store.completion(trigger,'【客户端问题】Q'+row.id+' · '+row.status,nativeQuestionText(row,data),'question_notice');store.set(noticeKey(notice),{id:row.id,history:true});return {sent:true};
 }
 if(!/^(问题列表|待回答|查看问题|回答问题)$/.test(content))return null;
 const native=store.db.prepare("SELECT * FROM desktop_questions WHERE kind=? AND owner_key=? AND status='pending' ORDER BY id DESC LIMIT 8").all(kind,owner).filter(row=>current(store,config,row));
 const bridge=store.db.prepare("SELECT value FROM settings WHERE key LIKE 'bridgeRequest:%'").all().map(row=>JSON.parse(row.value)).filter(row=>row.kind==='question'&&row.owner===owner&&row.status==='pending'&&row.expiresAt>now).slice(0,4);
 const lines=native.map(row=>'客户端问题 Q'+row.id+' · '+row.title+'\n'+(row.remote_supported===1?'可回复“回答 Q'+row.id+'：答案”；':'在原客户端卡片作答；')+'查看完整内容可发送“查看问题 Q'+row.id+'”。');
 lines.push(...bridge.map(row=>'任务问题 B'+row.id+'\n按原通知回复“回答 B'+row.id+'：答案”。'));
 return {text:lines.length?lines.join('\n\n'):'当前没有待回答问题。'};
}
