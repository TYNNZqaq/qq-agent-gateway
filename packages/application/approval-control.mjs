import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { noLinks, sha256 } from './boundaries.mjs';
import {executeFileProposal} from './project-file-proposal.mjs';
import {approvalReplyIsFresh} from './approval-clock.mjs';

const activeStates = ['pending', 'queued'];
export const approvalByKey = (store, key) => store.db.prepare('SELECT * FROM bridge_approvals WHERE request_key=?').get(key);
export const approvalData = row => ({ ...JSON.parse(row.data), status: row.status, number: row.id, expiresAt: row.expires_at, error: row.error, decision: row.decision });
function scope(config, owner, task, project, request, fingerprint, expiresAt) {
  return { schemaVersion: 1, instanceId: config.instanceId, hostId: config.hostId || config.instanceId, dataDirectory:config.runtimeRoot||config.stateDir,...config.binding,
    appId: config.qq.appId, owner, accountConnectionId: config.accountConnectionId || null,
    project: { key: task.project, id: project.id || null, grantId: project.grantId || null, path: noLinks(project.path), mode: project.mode, tools: [...project.tools], policyVersion: project.policyVersion || 1 },
    taskId: task.id, threadId: request.params.threadId, turnId: request.params.turnId, requestId: request.id, itemId: request.params.itemId || request.params.callId || null,
    method: request.method, fingerprint, expiresAt };
}
export function registerApproval(store, config, task, request, data, now = Date.now()) {
  if (!config.binding?.botId || !config.binding?.agentId || !config.binding?.bindingId || !Number.isInteger(config.binding.bindingVersion)) throw Error('APPROVAL_BINDING_REQUIRED');
  if (!(typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128 || Number.isSafeInteger(request.id))) throw Error('APPROVAL_REQUEST_ID_INVALID');
  const project=config.projects[task.project];if(!project||!project.id||!project.grantId)throw Error('APPROVAL_PROJECT_IDENTITY_REQUIRED');
  const expiresAt = now + 300000, identity = scope(config, task.owner_key, task, config.projects[task.project], request, data.fingerprint, expiresAt), code = randomBytes(6).toString('hex');
  const value = { ...data, scope: identity, scopeFingerprint: sha256(JSON.stringify(identity)), createdAt: now, expiresAt, code };
  const inserted = store.db.prepare("INSERT INTO bridge_approvals(request_key,owner_key,status,fingerprint,scope_fingerprint,data,code_hash,created_at,expires_at) VALUES(?,?,'pending',?,?,?,?,?,?)")
    .run(data.id, task.owner_key, data.fingerprint, value.scopeFingerprint, JSON.stringify(value), sha256(code), now, expiresAt);
  return { ...value, number: Number(inserted.lastInsertRowid) };
}
export function approvalStillCurrent(store, config, row, entry, { queued = false } = {}) {
  if (!row || !entry || row.expires_at <= Date.now() || ![queued ? 'queued' : 'pending'].includes(row.status)) return false;
  try {
    config.runtimeGuard?.();
    const data = approvalData(row), task = store.task(data.taskId), pending = entry.requests.get(row.request_key), project = task && config.projects[task.project];
    const turn=task&&store.get('bridgeTask:'+task.id);
    if (!task || !project || task.status !== 'running' || task.owner_key !== store.get('owner') || row.owner_key !== task.owner_key || task.thread_id!==entry.threadId||turn?.threadId!==entry.threadId||turn?.turnId!==entry.turnId||entry.cancelRequested||entry.rpc.closed===true||entry.threadId !== data.threadId || entry.turnId !== data.turnId || !pending || pending.fingerprint !== row.fingerprint || pending.requestId !== data.scope.requestId || pending.method !== data.scope.method) return false;
    if(sha256(JSON.stringify({id:pending.requestId,method:pending.method,params:pending.request.params,item:pending.item||null}))!==row.fingerprint)return false;
    const current = scope(config, store.get('owner'), task, project, pending.request, row.fingerprint, row.expires_at);
    return sha256(JSON.stringify(current)) === row.scope_fingerprint && data.scopeFingerprint === row.scope_fingerprint;
  } catch { return false; }
}
export function submitApproval(store, config, entry, row, accept, channel) {
  if (!approvalStillCurrent(store, config, row, entry, { queued: channel === 'qq' })) throw Error('APPROVAL_STALE');
  const data = approvalData(row), pending = entry.requests.get(row.request_key);
  if (accept && (data.canAccept !== true||pending.canAccept!==true)) throw Error('APPROVAL_OUTSIDE_PROJECT_GRANT');
  if (accept && channel === 'qq' && (config.remoteApprovals?.enabled !== true || data.canRemoteAccept !== true||pending.canRemoteAccept!==true)) throw Error('REMOTE_APPROVAL_OUTSIDE_PROJECT_GRANT');
  const expected = channel === 'qq' ? 'queued' : 'pending';
  if (store.db.prepare("UPDATE bridge_approvals SET status='sending',decision=?,channel=?,submitted_at=? WHERE id=? AND status=? AND fingerprint=?").run(accept ? 'accept' : 'decline', channel, Date.now(), row.id, expected, row.fingerprint).changes !== 1) throw Error('APPROVAL_ALREADY_DECIDED');
  try {
    const result=pending.proposal?executeFileProposal(store,config,row,pending,accept):{decision:accept?'accept':'decline'};
    entry.rpc.respond(pending.requestId,result);
    store.db.prepare("UPDATE bridge_approvals SET status='submitted' WHERE id=? AND status='sending'").run(row.id);
  } catch (error) {
    store.db.prepare("UPDATE bridge_approvals SET status='unknown',error='APPROVAL_WRITE_UNKNOWN' WHERE id=? AND status IN('sending','submitted')").run(row.id); throw error;
  }
  return { status: 'submitted', outcome: 'server-confirmation-pending' };
}
export function resolveApproval(store, key, now = Date.now(), evidence = 'serverRequest/resolved') {
  const row = approvalByKey(store, key); if (!row) return;
  const next = ['sending', 'submitted', 'unknown'].includes(row.status) ? 'resolved' : activeStates.includes(row.status) ? 'cancelled' : row.status;
  store.db.prepare('UPDATE bridge_approvals SET status=?,resolved_at=?,resolution_evidence=? WHERE id=?').run(next, now, evidence, row.id);
}
export function approvalInstructions(data, remoteEnabled) {
  if (!remoteEnabled) return '请在本机管理台「接入 → Codex」逐项核对并决定。';
  return data.canRemoteAccept ? '请直接回复“批准”或“拒绝”。多条审批会逐条展示，每次回复只处理当前这一条。' : '请直接回复“拒绝”，或在本机核对完整权限后处理。';
}
export function routeRemoteApproval(store, config, owner, content, trigger, event, now = Date.now()) {
  if (config.remoteApprovals?.enabled !== true) return null;
  if (/^(?:审批|审批列表|待审批|查看审批)$/.test(content)) {
    const pending = store.db.prepare("SELECT * FROM bridge_approvals WHERE owner_key=? AND status='pending' AND expires_at>? ORDER BY id DESC LIMIT 5").all(owner, now);
    return pending.length ? pending.map(row => { const d = approvalData(row); return '审批 A' + row.id + ' · ' + d.projectName.slice(0,60) + '\n有效至：' + new Date(row.expires_at).toISOString(); }).join('\n\n')+'\n\n请核对原审批通知中的完整操作，然后直接回复“批准”或“拒绝”即可。' : '当前没有本插件任务的待审批请求。';
  }
  const match = /^(批准|拒绝|撤销审批)\s+A([1-9]\d{0,11})\s+([a-f0-9]{12})$/i.exec(content);
  if (!match) return /^(?:批准|拒绝|撤销审批)(?:\s|$)/.test(content) ? '请直接回复“批准”或“拒绝”，每次处理当前正在展示的那一条审批。' : null;
  const row = store.db.prepare('SELECT * FROM bridge_approvals WHERE id=?').get(Number(match[2]));
  if (!row || row.owner_key !== owner || owner !== store.get('owner') || !timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(sha256(match[3].toLowerCase()), 'hex'))) return '审批编号、本人或一次性校验码不匹配，未提交决定。';
  const data = approvalData(row);
  if (!activeStates.includes(row.status) || row.expires_at <= now) return '此审批已提交、撤销或过期，不能重复决定。结果未知时请先在本机核对。';
  if (!approvalReplyIsFresh(store,owner,trigger,event,{noticeId:data.notificationId,createdAt:row.created_at,now})) return '审批消息已过期，未提交决定。';
  try {
    config.runtimeGuard?.(); const task = store.task(data.taskId), project = task && config.projects[task.project];
    const turn=task&&store.get('bridgeTask:'+task.id);
    if (!task || !project || task.owner_key !== owner || task.status !== 'running' ||task.thread_id!==data.threadId||turn?.threadId!==data.threadId||turn?.turnId!==data.turnId||sha256(JSON.stringify(scope(config, owner, task, project, { id: data.scope.requestId, method: data.scope.method, params: { threadId: data.threadId, turnId: data.turnId, itemId: data.scope.itemId } }, row.fingerprint, row.expires_at))) !== row.scope_fingerprint) throw Error();
  } catch { return '审批归属或项目授权已变化，未提交决定；请在本机核对。'; }
  if (row.status === 'queued'&&match[1]!=='撤销审批') return '本次决定已登记，等待原会话确认；不会重复提交。';
  const accept = match[1] === '批准';
  if (accept && data.canRemoteAccept !== true) return '此请求超出已证明的原项目范围，不能通过 QQ 扩大权限。可拒绝后在本机核对。';
  const next = match[1] === '撤销审批' ? 'revoked' : 'queued';
  const updated = store.db.prepare("UPDATE bridge_approvals SET status=?,decision=?,channel='qq',decision_event=?,decided_at=? WHERE id=? AND status IN("+(next==='revoked'?"'pending','queued'":"'pending'")+") AND fingerprint=? AND expires_at>?").run(next, accept ? 'accept' : 'decline', trigger, now, row.id, row.fingerprint, now);
  return updated.changes === 1 ? next === 'revoked' ? '已撤销本次审批，原请求将按拒绝处理。' : '已登记本次决定，等待原会话确认；尚未证明操作已执行。' : '本次审批状态已变化，没有重复提交。';
}
export function enqueueApprovalCheck(store, config, projectKey) {
  if(config.remoteApprovals?.enabled!==true||!Object.hasOwn(config.projects,projectKey))throw Error('APPROVAL_CHECK_NOT_ENABLED');
  const project=config.projects[projectKey],owner=store.get('owner');
  if(project.mode!=='workspace-write'||!project.tools.includes('edit')||!owner)throw Error('APPROVAL_CHECK_WRITABLE_PROJECT_REQUIRED');
  const identity=JSON.parse(owner),inbox=store.db.prepare("SELECT event_key FROM inbox WHERE app_id=? AND scope='c2c' AND sender=? AND target=sender ORDER BY received_at DESC LIMIT 1").get(config.qq.appId,identity[2]);
  if(!inbox||store.db.prepare("SELECT id FROM tasks WHERE status IN('queued','running','waiting_files')").get())throw Error('APPROVAL_CHECK_OWNER_OR_IDLE_REQUIRED');
  return store.transaction(()=>{const filename='qq-remote-approval-'+randomUUID()+'.txt',task=store.enqueue(owner,inbox.event_key,projectKey,'本次仅验证原本人远程审批。请仅使用 qq_propose_text_file 提出创建单个文件 '+filename+' 的改动，内容严格为 QQ_REMOTE_APPROVAL_OK。等待本人逐项审批；保留原项目权限，不用 apply_patch 或命令自行写入，不改其他文件、不申请网络或更大权限。获准后验证文件；被拒绝或超时则如实返回 needs_input，不重新申请或重试。',null,Date.now(),project.path,project.label||projectKey,{backend:'app-server',model:config.work.model,reasoning:config.work.reasoning});store.set('bridgeConfirmEdits:'+task.id,true);store.set('bridgeApprovalCheck:'+task.id,{filename,owner,projectKey,createdAt:Date.now()});return {taskId:task.id,filename,projectKey};});
}
