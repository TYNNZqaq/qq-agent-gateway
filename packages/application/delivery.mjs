import { fileBytes, reportFiles } from './files.mjs';
import { chatOutboxValid } from './chat-batcher.mjs';
import { desktopNoticeValid } from './desktop-notifications.mjs';
import {approvalConversationForDelivery,recordApprovalPromptReceipt} from './approval-conversation.mjs';
import {nativeQuestionNoticeValid} from './desktop-questions.mjs';
import {recordApprovalClock} from './approval-clock.mjs';

export class SendError extends Error {
  constructor(code, { uncertain = false, retryable = false } = {}) {
    super(String(code)); this.code = code; this.uncertain = uncertain; this.retryable = retryable;
  }
}

export function sendingAllowed(store, config, file = false) {
  return !config.runtimeStopping && store.get('egressPaused', false) !== true && config.sending?.enabled !== false
    && (!file || config.fileDelivery?.enabled !== false && config.fileDelivery?.sendEnabled !== false);
}
export async function deliverOne(store, config, transport, now = Date.now()) {
  const entered = Date.now();
  if (store.get('lastSend', 0) + config.qq.minimumSendIntervalMs > now) return null;
  const {blockedNoticeIds}=approvalConversationForDelivery(store,config,now);
  const block=blockedNoticeIds.length?' AND id NOT IN ('+blockedNoticeIds.map(()=>'?').join(',')+')':'';
  const item = store.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_at<=? AND (after_id IS NULL OR EXISTS(SELECT 1 FROM outbox parent WHERE parent.id=outbox.after_id AND parent.status='sent'))"+block+" ORDER BY CASE WHEN kind IN ('approval_notice','local_approval','approval_reply','question_notice','question_reply') THEN 0 ELSE 1 END,id LIMIT 1").get(now,...blockedNoticeIds);
  if (!item) return null;
  const hold = () => {
    store.db.prepare("UPDATE outbox SET status='held',error='EGRESS_DISABLED' WHERE id=? AND status='pending'").run(item.id);
    store.db.prepare("UPDATE outbox_parts SET status='held',error='EGRESS_DISABLED' WHERE notification_id=? AND status='pending'").run(item.id);
    return { id: item.id, status: 'held' };
  };
  if (!sendingAllowed(store, config, item.kind === 'artifact_file')) return hold();
  if (!desktopNoticeValid(store, config, item)) {
    store.db.prepare("UPDATE outbox SET status='blocked',error='DESKTOP_SCOPE_CHANGED' WHERE id=?").run(item.id);
    store.db.prepare("UPDATE outbox_parts SET status='blocked',error='DESKTOP_SCOPE_CHANGED' WHERE notification_id=? AND status='pending'").run(item.id);
    return { id: item.id, status: 'blocked' };
  }
  if(!nativeQuestionNoticeValid(store,config,item)){
    store.db.prepare("UPDATE outbox SET status='cancelled',error='NATIVE_QUESTION_CHANGED' WHERE id=?").run(item.id);
    store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='NATIVE_QUESTION_CHANGED' WHERE notification_id=? AND status='pending'").run(item.id);
    return {id:item.id,status:'cancelled'};
  }
  if (!chatOutboxValid(store, item)) {
    store.transaction(() => {
      store.db.prepare("UPDATE outbox SET status='cancelled',error='CHAT_DRAFT_STALE' WHERE id=?").run(item.id);
      store.db.prepare("UPDATE outbox_parts SET status='cancelled',error='CHAT_DRAFT_STALE' WHERE notification_id=? AND status='pending'").run(item.id);
      store.db.prepare("UPDATE chat_messages SET delivery_status='cancelled' WHERE id=(SELECT response_message_id FROM chat_turns WHERE id=?) AND delivery_status!='sent'").run(item.chat_turn_id);
    });
    return { id: item.id, status: 'cancelled' };
  }
  const part = store.db.prepare("SELECT * FROM outbox_parts WHERE notification_id=? AND status!='sent' ORDER BY part_no LIMIT 1").get(item.id);
  if (part && part.status !== 'pending') {
    store.db.prepare('UPDATE outbox SET status=?,error=? WHERE id=?').run(part.status, part.error, item.id);
    return { id: item.id, status: part.status };
  }
  const inbox = store.db.prepare('SELECT * FROM inbox WHERE event_key=?').get(item.trigger_event);
  if (!inbox) throw new Error('NOTIFICATION_TARGET_MISSING');
  const file = item.kind === 'artifact_file' ? store.db.prepare('SELECT f.*,b.owner_key FROM file_transfers f JOIN file_batches b ON b.source_key=f.batch_key WHERE f.outbox_id=?').get(item.id) : null;
  const outcome = (status, extra = {}) => { if (file) reportFiles(store, now); return { id: item.id, status, ...extra }; };
  if (true) {
    const owner = JSON.stringify([inbox.app_id, inbox.scope, inbox.sender]);
    if (owner !== store.get('owner') || (file && file.owner_key !== owner) || inbox.target !== inbox.sender || inbox.app_id !== config.qq.appId) {
      store.db.prepare("UPDATE outbox SET status='blocked',error='通知对象已变化，需在本机核对' WHERE id=?").run(item.id);
      if (part) store.db.prepare("UPDATE outbox_parts SET status='blocked',error='通知对象已变化，需在本机核对' WHERE id=?").run(part.id);
      return outcome('blocked');
    }
  }
  let passive = !item.force_proactive && now - inbox.sent_at >= 0 && now - inbox.sent_at < config.qq.passiveWindowSeconds * 1000 && inbox.replies < config.qq.maxPassiveReplies;
  if (!passive && config.qq.allowProactive !== true) {
    store.db.prepare("UPDATE outbox SET status='blocked',error='被动回复窗口或次数已用尽；主动发送尚未验证启用' WHERE id=?").run(item.id);
    if (part) store.db.prepare("UPDATE outbox_parts SET status='blocked',error='被动回复窗口或次数已用尽；主动发送尚未验证启用' WHERE id=?").run(part.id);
    return outcome('blocked');
  }
  let fileInfo;
  if (item.kind === 'artifact_file') {
    if (!file) {
      store.db.prepare("UPDATE outbox SET status='blocked',error='FILE_RECORD_MISSING' WHERE id=?").run(item.id); return outcome('blocked');
    }
    let bytes;
    try { bytes = fileBytes(store, file); }
    catch { store.db.prepare("UPDATE outbox SET status='blocked',error='FILE_SNAPSHOT_CHANGED' WHERE id=?").run(item.id); return outcome('blocked'); }
    fileInfo = file.file_info;
    if (!fileInfo || file.expires_at <= now + 30000) {
      store.db.prepare("UPDATE file_transfers SET upload_state='uploading',upload_attempts=upload_attempts+1 WHERE id=?").run(file.id);
      try {
        if (!sendingAllowed(store, config, true)) return hold();
        const uploaded = await transport.uploadFile({ scope: inbox.scope, target: inbox.target }, bytes, file.filename);
        if (!uploaded?.fileInfo) throw new SendError('FILE_UPLOAD_INVALID_RESPONSE', { retryable: true });
        fileInfo = uploaded.fileInfo;
        store.db.prepare("UPDATE file_transfers SET upload_state='uploaded',file_info=?,expires_at=? WHERE id=?").run(fileInfo, now + Math.min(Number(uploaded.ttl) || 300, 86400) * 1000, file.id);
      } catch (error) {
        const retry = error instanceof SendError && error.retryable && file.upload_attempts < 2;
        store.db.prepare("UPDATE file_transfers SET upload_state='ready' WHERE id=?").run(file.id);
        store.db.prepare('UPDATE outbox SET status=?,error=?,next_at=? WHERE id=?').run(retry ? 'pending' : 'blocked', String(error instanceof SendError ? error.code : 'FILE_UPLOAD_FAILED').slice(0, 100), now + 10000 * (file.upload_attempts + 1), item.id);
        return outcome(retry ? 'pending' : 'blocked');
      }
    }
    if (!sendingAllowed(store, config, true)) return hold();
    // Upload is asynchronous; ownership must still match immediately before send.
    if (store.get('owner') !== file.owner_key) {
      store.db.prepare("UPDATE outbox SET status='blocked',error='文件接收对象已变化' WHERE id=?").run(item.id); return outcome('blocked');
    }
  }
  const sendingAt = now + Math.max(0, Date.now() - entered);
  if (file) {
    const fresh = store.db.prepare('SELECT replies FROM inbox WHERE event_key=?').get(item.trigger_event);
    passive = !item.force_proactive && sendingAt - inbox.sent_at >= 0 && sendingAt - inbox.sent_at < config.qq.passiveWindowSeconds * 1000 && fresh.replies < config.qq.maxPassiveReplies;
    if (!passive && config.qq.allowProactive !== true) {
      store.db.prepare("UPDATE outbox SET status='blocked',error='上传完成时被动回复窗口已过期' WHERE id=?").run(item.id); return outcome('blocked');
    }
  }
  if (!sendingAllowed(store, config, !!file)) return hold();
  const mode = passive ? 'passive' : 'proactive';
  // Reserve reply sequence before I/O. A crash consumes this slot and never repeats it automatically.
  const seq = store.transaction(() => {
    const fresh = store.db.prepare('SELECT replies FROM inbox WHERE event_key=?').get(item.trigger_event);
    const value = fresh.replies + 1;
    if (passive) store.db.prepare('UPDATE inbox SET replies=? WHERE event_key=?').run(value, item.trigger_event);
    store.db.prepare("UPDATE outbox SET status='sending',mode=?,attempts=attempts+1 WHERE id=?").run(mode, item.id);
    if (part) store.db.prepare("UPDATE outbox_parts SET status='sending',attempts=attempts+1 WHERE id=?").run(part.id);
    store.set('lastSend', sendingAt);
    return value;
  });
  try {
    const result = await transport.send({ scope: inbox.scope, target: inbox.target, content: part?.content ?? item.content, ...(fileInfo ? { fileInfo } : {}), ...(passive ? { msgId: inbox.message_id, seq } : {}) });
    if (!result?.id) throw new SendError('发送响应缺少消息ID', { uncertain: true });
    const status = store.transaction(() => {
      if (part) store.db.prepare("UPDATE outbox_parts SET status='sent',provider_id=?,error=NULL WHERE id=?").run(result.id, part.id);
      const remaining = part && store.db.prepare("SELECT id FROM outbox_parts WHERE notification_id=? AND status!='sent' LIMIT 1").get(item.id);
      const next = remaining ? 'pending' : 'sent';
      store.db.prepare('UPDATE outbox SET status=?,provider_id=?,error=NULL,next_at=0 WHERE id=?').run(next, result.id, item.id);
      if (item.chat_turn_id) {
        const sentAt = sendingAt + Math.max(0, Date.now() - entered);
        store.db.prepare(`INSERT OR IGNORE INTO chat_deliveries(outbox_id,part_no,turn_id,session_id,content,provider_id,sent_at)
          VALUES (?,?,?,?,?,?,?)`).run(item.id, part?.part_no || 1, item.chat_turn_id, item.chat_session_id, part?.content ?? item.content, result.id, sentAt);
        store.db.prepare('UPDATE chat_messages SET delivery_status=? WHERE id=(SELECT response_message_id FROM chat_turns WHERE id=?)').run(next === 'sent' ? 'sent' : 'partial', item.chat_turn_id);
        if (next === 'sent') store.db.prepare("UPDATE chat_messages SET delivery_status='answered' WHERE id IN (SELECT user_message_id FROM chat_turns WHERE batch_id=?)").run(item.chat_turn_id);
        store.db.prepare("UPDATE chat_turns SET timings=json_set(timings,'$.send_wait_ms',?,'$.confirmed_at',?) WHERE id=?").run(Math.max(0, sendingAt - item.created_at), sentAt, item.chat_turn_id);
      }
      if(next==='sent')recordApprovalPromptReceipt(store,config,item.id,Date.now(),result);
      if(next==='sent'&&item.kind==='bridge_question')recordApprovalClock(store,item.id,result,Date.now());
      return next;
    });
    return outcome(status, { mode });
  } catch (error) {
    const attempts = part?.attempts ?? item.attempts;
    const status = error.uncertain || !(error instanceof SendError) ? 'unknown' : error.retryable && attempts < 2 ? 'pending' : 'blocked';
    store.transaction(() => {
      const message = String(error.code || '发送结果未知').slice(0, 100);
      store.db.prepare('UPDATE outbox SET status=?,error=?,next_at=? WHERE id=?').run(status, message, now + 10000 * (attempts + 1), item.id);
      if (part) store.db.prepare('UPDATE outbox_parts SET status=?,error=? WHERE id=?').run(status, message, part.id);
      if (item.chat_turn_id) store.db.prepare('UPDATE chat_messages SET delivery_status=? WHERE id=(SELECT response_message_id FROM chat_turns WHERE id=?)').run(status, item.chat_turn_id);
    });
    return outcome(status);
  }
}

export class MockTransport {
  constructor() { this.messages = []; }
  async send(message) { this.messages.push(message); return { id: `mock-${this.messages.length}` }; }
}
