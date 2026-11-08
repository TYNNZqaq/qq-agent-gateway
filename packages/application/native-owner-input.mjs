import {randomUUID} from 'node:crypto';
import {sha256,secretText} from './boundaries.mjs';
import {nativeControlTarget,nativeControlAvailable,nativeOwnerScope} from './native-owner-state.mjs';
export function queueNativeOperation(store,config,owner,trigger,threadId,{action='guide',prompt='',expectedTurnId}={},now=Date.now()){
 const target=nativeControlTarget(store,config,threadId),live=store.get('nativeOwnerThread:'+threadId);
 if(owner!==store.get('owner')||!target)return {error:'原会话来源或本人绑定已变化，请刷新任务列表。'};
 if(!nativeControlAvailable(store,config,threadId,now))return {error:'正在核对原会话控制连接，请稍后刷新任务详情；本条尚未发送。'};
 if(store.get('paused',false)&&action==='guide')return {error:'当前暂停接单。'};
 if(!['guide','cancel'].includes(action)||action==='guide'&&(!prompt.trim()||prompt.length>4000))return {error:'指导内容需要 1 至 4000 字符。'};
 if(action==='cancel'&&(!live.activeTurnId||expectedTurnId&&expectedTurnId!==live.activeTurnId))return {error:'所引用的原回合已结束或发生变化，本次没有发出取消。'};
 const existing=store.db.prepare('SELECT id,status FROM native_control_operations WHERE trigger_event=?').get(trigger);if(existing)return {id:existing.id,text:'这条原会话操作已登记，当前状态：'+existing.status+'。'};
 const pending=store.db.prepare("SELECT COUNT(*) n FROM native_control_operations WHERE status IN('queued','checking','sending')").get().n;
 const daily=store.db.prepare('SELECT COUNT(*) n FROM native_control_operations WHERE created_at>=?').get(now-86400000).n+store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE created_at>=?').get(now-86400000).n;
 if(pending>=config.executor.maxQueuedTasks||daily>=config.executor.dailyTaskLimit)return {error:'已达到队列或每日工作要求上限。'};
 const meta={scope:nativeOwnerScope(store,config),project:target.project,expectedOwnerId:live.owner,expectedActiveTurnId:live.activeTurnId||null,sourceTurnId:target.turnId||null};
 const result=store.db.prepare("INSERT INTO native_control_operations(request_key,owner_key,trigger_event,thread_id,cwd,action,prompt,data,status,created_at) VALUES(?,?,?,?,?,?,?,?,'queued',?)").run(randomUUID(),owner,trigger,threadId,target.cwd,action,prompt,JSON.stringify(meta),now);
 return {id:Number(result.lastInsertRowid),text:'原会话'+(action==='cancel'?'取消':'指导')+' #'+result.lastInsertRowid+' 已登记，等待原客户端回执。'};
}
export function nativeQuestionWritebackReady(store,config,row,now=Date.now()){
 const live=row&&store.get('nativeQuestionLive:'+row.id);
 return row?.status==='pending'&&row.remote_supported===1&&live?.scope===nativeOwnerScope(store,config)&&live.phase==='ready'&&now>=live.checkedAt&&now-live.checkedAt<=15000&&nativeControlAvailable(store,config,row.thread_id,now)?live:null;
}
export function queueNativeQuestionAnswer(store,config,row,text,trigger,now=Date.now()){
 const prior=store.get('nativeQuestionLive:'+row.id);
 if(['queued','sending','submitted'].includes(prior?.phase))return {text:'Q'+row.id+' 的答案已登记，正在核对原问题回执，未重复提交。'};
 if(prior?.phase==='unknown')return {text:'Q'+row.id+' 上次答案的返回结果待核对，请在原卡片确认；本条没有重复提交。'};
 const live=nativeQuestionWritebackReady(store,config,row,now);if(!live)return {text:'Q'+row.id+' 当前没有可核验的原问题控制连接，请在原卡片处理；本条尚未提交。'};
 const inbox=store.db.prepare('SELECT app_id,scope,sender,received_at,sent_at FROM inbox WHERE event_key=?').get(trigger),clock=store.get('qqProviderClock');
 if(!inbox||JSON.stringify([inbox.app_id,inbox.scope,inbox.sender])!==row.owner_key||!Number.isFinite(inbox.received_at)||now-inbox.received_at>120000||inbox.received_at>now+1500)return {text:'这条问题回答已过期，未提交。'};
 const providerOffset=clock?.ownerHash===sha256(row.owner_key)&&Number.isFinite(clock.localAt)&&Number.isFinite(clock.providerAt)&&now-clock.localAt<=86400000?clock.localAt-clock.providerAt:0;
 if(inbox.sent_at+providerOffset<row.created_at-30000)return {text:'这条回答早于原问题，未提交。'};
 const notice=store.db.prepare('SELECT status,provider_id FROM outbox WHERE id=?').get(row.notification_id);
 if(notice?.status!=='sent'||!notice.provider_id||store.db.prepare("SELECT id FROM outbox_parts WHERE notification_id=? AND (status!='sent' OR provider_id IS NULL)").get(row.notification_id))return {text:'原问题内容尚未完整送达，请等完整通知后回答。'};
 if(!text?.trim())return {text:'请回复“回答 Q'+row.id+'：选项编号或文字”。多题可用“1=答案；2=答案”。'};
 const questions=JSON.parse(row.questions),answers=JSON.parse(row.answers||'{}'),needed=live.entry.questions;
 const values=needed.length===1?[[needed[0].index,text]]:/^\s*\d+\s*[=＝]/.test(text)?text.split(/[；;\r\n]+/).filter(s=>s.trim()).map(value=>{const m=/^\s*(\d+)\s*[=＝]\s*([\s\S]*)$/.exec(value);return m?[Number(m[1])-1,m[2]]:[-1,''];}):[[needed.find(q=>!Object.hasOwn(answers,q.id))?.index??-1,text]];
 const seen=new Set();for(const [index,raw]of values){const q=questions[index],liveQuestion=needed.find(q=>q.index===index),value=String(raw).trim();if(!q||!liveQuestion||seen.has(index)||!value||value.length>4000||secretText(value))return {text:'题号、回答格式或内容需要核对；每题可填写 1 至 4000 字符，请勿发送密码或密钥。'};seen.add(index);let answer=value.replace(/^文字[:：]\s*/,'');if(/^\d+$/.test(value)&&q.options.length){const option=q.options[Number(value)-1];if(!option)return {text:'第 '+(index+1)+' 题选项编号无效。'};answer=option.label;}Object.defineProperty(answers,liveQuestion.id,{value:answer,enumerable:true,configurable:true,writable:true});}
 store.db.prepare('UPDATE desktop_questions SET answers=?,response_event=? WHERE id=? AND status=\'pending\'').run(JSON.stringify(answers),trigger,row.id);
 if(!needed.every(q=>Object.hasOwn(answers,q.id)))return {text:'Q'+row.id+' 已保存部分答案，请继续填写其余题目，或用“1=答案；2=答案”。'};
 store.set('nativeQuestionLive:'+row.id,{...live,phase:'queued',trigger,queuedAt:now,answers,messageId:randomUUID()});
 return {text:'Q'+row.id+' 答案已登记，正在交回原问题；原客户端记录确认后另行通知。'};
}
