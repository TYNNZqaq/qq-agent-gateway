import {sha256} from './boundaries.mjs';

const clockKey=id=>'approvalPromptClock:'+id;
export function providerTimestamp(value){
 if(typeof value==='string'&&value.trim()&&!/^\d+(?:\.\d+)?$/.test(value.trim())){const at=Date.parse(value);return Number.isFinite(at)?at:null;}
 if(!['number','string'].includes(typeof value)||String(value).trim()==='')return null;
 const number=Number(value),at=number<1e11?number*1000:number;
 return Number.isFinite(at)&&at>0&&Number.isSafeInteger(Math.round(at))?Math.round(at):null;
}
// Both clocks come from the successful QQ HTTPS response, never from a reply
// or an assumed machine offset. The last part's receipt anchors the full prompt.
export function qqMessageReceipt(id,result,headers){
 const timestamp=providerTimestamp(result.timestamp),httpDate=providerTimestamp(headers?.get?.('date'));
 return {id,...(timestamp!==null?{providerSentAt:timestamp,providerClockSource:'qq-message-timestamp'}:httpDate!==null?{providerSentAt:httpDate,providerClockSource:'qq-response-date'}:{})};
}
export function rememberQQClock(store,receipt,localAt){
 const owner=store.get('owner');
 if(owner&&Number.isSafeInteger(receipt?.providerSentAt)&&['qq-message-timestamp','qq-response-date'].includes(receipt.providerClockSource))store.set('qqProviderClock',{ownerHash:sha256(owner),providerAt:receipt.providerSentAt,localAt,source:receipt.providerClockSource});
}
export function qqEventTimestampIsPlausible(store,owner,event,now){
 if(!Number.isFinite(event.sentAt))return false;
 const clock=store.get('qqProviderClock');
 const trusted=clock?.ownerHash===sha256(owner)&&['qq-message-timestamp','qq-response-date'].includes(clock.source)&&Number.isFinite(clock.providerAt)&&Number.isFinite(clock.localAt)&&now>=clock.localAt-1500&&now-clock.localAt<=86400000;
 const reference=trusted?clock.providerAt+Math.max(0,now-clock.localAt):now;
 return event.sentAt<=reference+30000&&reference-event.sentAt<=86400000;
}
export function recordApprovalClock(store,noticeId,receipt,localDeliveredAt){
 if(!Number.isSafeInteger(receipt?.providerSentAt)||!['qq-message-timestamp','qq-response-date'].includes(receipt.providerClockSource))return;
 const notice=store.db.prepare('SELECT status,provider_id,created_at FROM outbox WHERE id=?').get(noticeId),owner=store.get('owner');
 if(!owner||notice?.status!=='sent'||!receipt.id||notice.provider_id!==receipt.id||store.db.prepare("SELECT id FROM outbox_parts WHERE notification_id=? AND (status!='sent' OR provider_id IS NULL)").get(noticeId))return;
 store.set(clockKey(noticeId),{schemaVersion:1,noticeId,ownerHash:sha256(owner),providerIdHash:sha256(receipt.id),noticeCreatedAt:notice.created_at,providerSentAt:receipt.providerSentAt,localDeliveredAt,source:receipt.providerClockSource});
 rememberQQClock(store,receipt,localDeliveredAt);
}
export function approvalReplyIsFresh(store,owner,trigger,event,{noticeId,createdAt,presentedAt,now=Date.now()}={}){
 if(!Number.isFinite(event.sentAt))return false;
 const clock=Number.isSafeInteger(noticeId)&&store.get(clockKey(noticeId));
 if(clock){
  const notice=store.db.prepare('SELECT status,provider_id,created_at FROM outbox WHERE id=?').get(noticeId),inbox=store.db.prepare('SELECT received_at,sent_at FROM inbox WHERE event_key=?').get(trigger);
  if(clock.schemaVersion!==1||clock.noticeId!==noticeId||clock.ownerHash!==sha256(owner)||notice?.status!=='sent'||!notice.provider_id||clock.providerIdHash!==sha256(notice.provider_id)||clock.noticeCreatedAt!==notice.created_at||!Number.isFinite(clock.localDeliveredAt)||!Number.isFinite(clock.providerSentAt)||!inbox||inbox.sent_at!==event.sentAt)return false;
  // Arrival age stays on the local clock; ordering and sender age stay on QQ's
  // clock. This keeps expiry/replay checks valid with either sign of clock skew.
  if(inbox.received_at<clock.localDeliveredAt-1500||inbox.received_at>now+1500||now-inbox.received_at>120000||clock.localDeliveredAt>now+1500)return false;
  const providerNow=clock.providerSentAt+Math.max(0,now-clock.localDeliveredAt);
  return event.sentAt>=clock.providerSentAt-1500&&event.sentAt<=providerNow+30000&&providerNow-event.sentAt<=120000;
 }
 // Historical prompts without provider timing retain their original strict
 // checks. Never reinterpret an old decision using a newly estimated offset.
 const earliest=Number.isFinite(presentedAt)?presentedAt-1500:createdAt-30000;
 return Number.isFinite(earliest)&&event.sentAt>=earliest&&event.sentAt<=now+30000&&now-event.sentAt<=120000;
}
