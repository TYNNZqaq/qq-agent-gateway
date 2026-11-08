import { noLinks, secretText, privateFilename } from './boundaries.mjs';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { taskId } from './store.mjs';
import { resolveRolloutFile } from './portable-view.mjs';
import {nativeGlobalEnabled} from './native-desktop-scope.mjs';
import {NativeDesktopFiles,recordNativeArtifacts,readStableArtifact,nativeVisualizationRoot} from './native-desktop-files.mjs';

export const FILE_LIMITS = Object.freeze({ count: 10, bytes: 20 * 1024 * 1024, total: 100 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plainPath = value => typeof value === 'string' && value.startsWith('\\\\?\\') && /^[A-Za-z]:[\\/]/.test(value.slice(4)) ? value.slice(4) : value;
const realLocalPath = value => plainPath(realpathSync.native(plainPath(value)));
const inside = (root, file) => { const relative = path.relative(plainPath(root), plainPath(file)); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const safeName = name => name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);

// Consent comes only from the human prompt for this exact turn. Documentation,
// quoted examples, feature requests and negated instructions are not send requests.
export function wantsFiles(prompt) {
  const text = String(prompt || '').replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/(?:例如|示例|举例|比如)\s*[:：]?\s*[“"「][^”"」]*[”"」]/g, '')
    .replace(/[“"「][^”"」]*(?:qq|ＱＱ)[^”"」]*[”"」]/gi, '');
  if (/当我在提示词中|(?:新增|增加|添加|实现|开发|修改|优化).{0,32}(?:文件|附件).{0,16}(?:发送|传输|交付).{0,16}(?:功能|规则|机制)|(?:新增|增加|添加|实现|开发|修改|优化).{0,40}(?:QQ|ＱＱ).{0,16}交付.{0,24}(?:功能|规则|机制)|(?:新增|增加|添加).{0,8}功能\s*[，,:：].{0,16}(?:当|如果|提示词)/i.test(text)) return false;
  if (!/文件|文档|报告|报表|周报|月报|方案|表格|附件|产出|产物|成果|pdf|docx?|xlsx?|pptx?|zip|图片|图像|图表|视频|音频|\bfiles?\b|\breport\b/i.test(text)) return false;
  const clauses = text.split(/[。！!？?；;，,\n]/);
  const relevant = clauses.filter(line => /qq|ＱＱ/i.test(line));
  if (relevant.some(line => /(?:不要|不必|无需|不用|别|禁止|取消|停止|不允许).{0,24}(?:发|传|送|交付)|(?:do\s+not|don't|never)\s+(?:send|upload|deliver)/i.test(line))) return false;
  return relevant.some(line => /(?:发送|发给|发到|发至|发我|传到|传至|上传|传给|送到|送至|交付(?:给|到|至)?).{0,32}(?:qq|ＱＱ)|(?:通过|经由|用|在)\s*(?:qq|ＱＱ)\s*(?:交付|发送|上传)|(?:文件|文档|报告|附件).{0,8}发\s*(?:qq|ＱＱ)|\b(?:send|deliver|upload)\b.{0,80}\bqq\b/i.test(line));
}

export const fileInstructions = prompt => wantsFiles(prompt) ? '\n\n【QQ 文件交付】请在最终答复中用 Markdown 链接列出本轮实际生成或更新的交付文件的完整绝对路径。QQ 服务会在完成后发送这些文件；只有服务回执确认后才算发送成功。' : '';

export function fileCandidates(final, cwd) {
  if (!cwd) return [];
  const values = [];
  for (const match of String(final || '').matchAll(/\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^)\r\n])+))\s*\)/g)) values.push(match[1] || match[2]);
  for (const match of String(final || '').matchAll(/`([^`\r\n]+)`/g)) if (/^(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/]|(?:outputs?|artifacts)[\\/])/i.test(match[1])) values.push(match[1]);
  for (const match of String(final || '').matchAll(/^\s*((?:[A-Za-z]:[\\/]|\/)[^\r\n]+)\s*$/gm)) values.push(match[1]);
  return [...new Set(values.map(value => {
    let candidate = plainPath(value.trim().replace(/\\([ ()])/g, '$1').replace(/:[0-9]+(?::[0-9]+)?$/, ''));
    if (/^(?:https?|file|data|plugin|codex|sandbox):/i.test(candidate) || /^[/\\]{2}/.test(candidate)) return null;
    if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
    try { candidate = decodeURIComponent(candidate); } catch { return null; }
    if (/^[/\\]{2}/.test(candidate) || /^(?:https?|file|data|plugin|codex|sandbox):/i.test(candidate)) return null;
    return path.resolve(plainPath(cwd), candidate);
  }).filter(Boolean))];
}

function snapshotFile(candidate, cwd, store, config, startedAt, completedAt, key) {
  let manifest;
  if (config.policyVersion >= 2) {
    const safe = noLinks(candidate);
    manifest = store.get('artifactManifest:' + key, []).find(item => item.path === safe && item.owner === store.get('owner'));
    if (!manifest || privateFilename(safe) || lstatSync(safe).nlink !== 1) throw Error('PRIVATE_FILE');
  }
  const nativeVisual=manifest?.origin==='native-human-turn-delivery'?nativeVisualizationRoot(config,manifest.threadId,noLinks(candidate)):null;
  const roots = [cwd, ...(config.fileDelivery?.allowedRoots || []), ...(manifest?.origin==='native-human-turn-delivery'?[nativeVisual]:[path.join(os.homedir(), '.codex', 'visualizations')])].filter(Boolean)
    .flatMap(root => { try { return [realLocalPath(root)]; } catch { return []; } });
  const file = realLocalPath(candidate), root = roots.find(item => inside(item, file));
  if (!root || inside(store.directory, file)) throw Error('OUTSIDE_OUTPUT_SCOPE');
  const relative = path.relative(root, file);
  if (/(?:^|[\\/])(?:\.git|\.aws|\.ssh|\.codex|\.agents|node_modules|qq-codex-runtime)(?:[\\/]|$)/i.test(relative)
    || /^(?:\.env(?:\..*)?|config\.local\.json|auth\.json|credentials(?:\..*)?|.*\.(?:sqlite(?:-wal|-shm)?|pem|key|pfx))$/i.test(path.basename(file))) throw Error('PRIVATE_FILE');
  const {bytes}=readStableArtifact(candidate,{maxBytes:FILE_LIMITS.bytes,startedAt,completedAt,requireTimeWindow:true});
  if (config.policyVersion >= 2 && (manifest.sha256 !== digest(bytes) || manifest.bytes !== bytes.length || secretText(bytes.toString('utf8')))) throw Error('PRIVATE_FILE');
  return { bytes, sha256: digest(bytes), filename: safeName(path.basename(file)), sourcePath: process.platform === 'win32' ? file.toLowerCase() : file };
}

// Stream public user/lifecycle records, retaining neither hidden reasoning nor
// tool calls/results. Reading the exact turn prevents old consent leaking forward.
export async function readFileTurn(home, rollout, turnId) {
  const file = resolveRolloutFile(home, rollout);
  let active = null, startedAt = null, cwd = null, prompt = '', human = '', final = '', completedAt = null, attribution = null;
  let carry = Buffer.alloc(0), skip = false, total = 0;
  const consume = line => {
    if (!line.includes('"event_msg"') && !line.includes('"turn_context"') && !line.includes('"session_meta"') && !line.includes('"response_item"')) return;
    let event; try { event = JSON.parse(line); } catch { return; }
    const payload = event.payload || {};
    const userMessage = message => {
      const value = message.slice(0, 128000);
      prompt += '\n' + value;
      if (!attribution || /^(?:user|human|composer|submit|follow_up|user_message)/.test(attribution)) human += '\n' + value;
    };
    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && active === turnId) {
      const message = (payload.content || []).filter(item => ['input_text','text'].includes(item.type) && typeof item.text === 'string').map(item => item.text).join('\n');
      if (message) userMessage(message);
    }
    if (event.type === 'session_meta' && !cwd) cwd = payload.cwd || null;
    if (event.type === 'turn_context' && payload.turn_id) { active = payload.turn_id; if (active === turnId) cwd = payload.cwd || cwd; }
    if (event.type !== 'event_msg') return;
    if (['task_started', 'turn_started'].includes(payload.type)) {
      active = payload.turn_id;
      if (active === turnId) { startedAt ??= Date.parse(event.timestamp); attribution = payload.turn_attribution?.turn_trigger || null; }
    }
    if (active !== turnId || (payload.turn_id && payload.turn_id !== turnId)) return;
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      // App tool submissions and inter-agent messages are not desktop human opt-in.
      userMessage(payload.message);
    }
    if (['task_complete', 'task_completed', 'turn_completed', 'turn_aborted', 'task_aborted'].includes(payload.type)) {
      final = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      completedAt = Date.parse(event.timestamp);
    }
  };
  for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
    total += chunk.length; if (total > 512 * 1024 * 1024) throw Error('ROLLOUT_SCAN_LIMIT');
    let cursor = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      if (!skip) consume(Buffer.concat([carry, chunk.subarray(cursor, index)]).toString('utf8'));
      carry = Buffer.alloc(0); skip = false; cursor = index + 1;
    }
    if (!skip) {
      carry = Buffer.concat([carry, chunk.subarray(cursor)]);
      if (carry.length > 1024 * 1024) { carry = Buffer.alloc(0); skip = true; }
    }
    if (completedAt) break;
  }
  if (!completedAt) throw Error('TURN_CONTEXT_INCOMPLETE');
  return { prompt: human, rawPrompt: prompt, startedAt, completedAt, cwd: plainPath(cwd), final };
}

export function planFiles(store, config, { key, noticeId, label, prompt, final, cwd, startedAt, completedAt, owner = store.get('owner') }, now = Date.now()) {
  if (store.db.prepare('SELECT source_key FROM file_batches WHERE source_key=?').get(key)) return false;
  const notice = store.db.prepare('SELECT * FROM outbox WHERE id=?').get(noticeId);
  if (!notice || owner !== store.get('owner')) return false;
  const requested = wantsFiles(prompt);
  const files = [], warnings = [];
  if (requested) {
    const candidates = fileCandidates(final, cwd); let total = 0; const seen = new Set();
    for (const candidate of candidates) {
      const name = safeName(path.basename(candidate));
      try {
        if (files.length >= FILE_LIMITS.count) throw Error('COUNT_LIMIT');
        const file = snapshotFile(candidate, cwd, store, config, startedAt, completedAt, key);
        if (seen.has(file.sourcePath)) continue;
        if (total + file.bytes.length > FILE_LIMITS.total) throw Error('TOTAL_SIZE_LIMIT');
        total += file.bytes.length; seen.add(file.sourcePath); files.push(file);
      } catch (error) { warnings.push({ filename: name, reason: ['OUTSIDE_OUTPUT_SCOPE','PRIVATE_FILE','NOT_REGULAR_FILE','TOO_LARGE','NOT_FROM_THIS_TURN','FILE_CHANGED','COUNT_LIMIT','TOTAL_SIZE_LIMIT'].includes(error.message) ? error.message : 'FILE_UNAVAILABLE' }); }
    }
    if (!candidates.length) warnings.push({ filename: '', reason: 'NO_OUTPUT_LINKS' });
  }
  const spool = path.join(store.directory, 'artifact-spool');
  if (files.length) mkdirSync(spool, { recursive: true });
  const staged = files.map((file, index) => {
    const spoolPath = path.join(spool, digest(key) + '-' + index + '.bin');
    writeFileSync(spoolPath, file.bytes, { mode: 0o600 }); return { ...file, spoolPath };
  });
  store.transaction(() => {
    store.db.prepare('INSERT INTO file_batches(source_key,owner_key,notice_id,label,requested,warnings,created_at) VALUES (?,?,?,?,?,?,?)').run(key, owner, noticeId, label, Number(requested), JSON.stringify(warnings), now);
    for (const [index, file] of staged.entries()) {
      const outboxId = Number(store.db.prepare("INSERT INTO outbox(task_id,trigger_event,kind,content,created_at,force_proactive,notification_key,after_id) VALUES (?,?,'artifact_file',?,?,?,?,?)")
        .run(notice.task_id, notice.trigger_event, `【QQ 文件】${label}（${index + 1}/${staged.length}）\n${file.filename}`, now, notice.force_proactive, 'file:' + key + ':' + index, noticeId).lastInsertRowid);
      store.db.prepare('INSERT INTO file_transfers(batch_key,outbox_id,filename,spool_path,sha256,bytes) VALUES (?,?,?,?,?,?)').run(key, outboxId, file.filename, file.spoolPath, file.sha256, file.bytes.length);
    }
  });
  reportFiles(store, now); return true;
}

export function fileBytes(store, file) {
  const spool = realLocalPath(path.join(store.directory, 'artifact-spool')), candidate = realLocalPath(file.spool_path);
  if (!inside(spool, candidate) || !lstatSync(candidate).isFile()) throw Error('SPOOL_INVALID');
  const stat = lstatSync(candidate); if (stat.size !== file.bytes || stat.size > FILE_LIMITS.bytes) throw Error('SPOOL_CHANGED');
  let bytes;try{({bytes}=readStableArtifact(file.spool_path,{maxBytes:Math.min(FILE_LIMITS.bytes,file.bytes)}));}catch{throw Error('SPOOL_CHANGED');}
  if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw Error('SPOOL_CHANGED');
  return bytes;
}

const reasonLabel = code => ({ TOO_LARGE: '超过单文件 20 MB', COUNT_LIMIT: '超过每轮 10 个文件', TOTAL_SIZE_LIMIT: '超过每轮 100 MB', NOT_FROM_THIS_TURN: '不是本轮生成或更新的文件', NO_OUTPUT_LINKS: '最终答复未列出可读取的本轮文件链接', PRIVATE_FILE: '属于私密配置文件', OUTSIDE_OUTPUT_SCOPE: '文件不在任务输出目录内', NOT_REGULAR_FILE: '不是普通文件', FILE_CHANGED: '文件仍在变化', FILE_UNAVAILABLE: '文件不可读取' }[code] || '发送失败，请核对后补发');
export function batchStatus(store, batch) {
  const rows = store.db.prepare('SELECT f.filename,o.status,o.error FROM file_transfers f JOIN outbox o ON o.id=f.outbox_id WHERE f.batch_key=? ORDER BY f.id').all(batch.source_key);
  const warnings = JSON.parse(batch.warnings);
  if (!batch.requested) return `${batch.label} 本轮未要求发送文件至 QQ。`;
  const count = status => rows.filter(row => row.status === status).length;
  const lines = [`【QQ 文件】${batch.label}`, `已发送 ${count('sent')} 个，待发送 ${count('pending') + count('sending')} 个，失败 ${count('blocked')} 个，结果未知 ${count('unknown')} 个。`];
  for (const row of rows.filter(item => item.status !== 'sent')) lines.push(`${row.filename}：${row.status === 'unknown' ? '发送结果未知，未自动重发' : row.status === 'blocked' ? '发送失败（' + (row.error || '请核对') + '）' : '待发送'}`);
  for (const warning of warnings) lines.push(`${warning.filename ? warning.filename + '：' : ''}${reasonLabel(warning.reason)}`);
  if (count('blocked') || count('unknown')) lines.push(`核对收件情况后可发送“补发文件 ${batch.label}”；结果未知的文件可能重复。`);
  return lines.join('\n');
}

export function reportFiles(store, now = Date.now()) {
  releaseSentFiles(store);
  for (const batch of store.db.prepare('SELECT * FROM file_batches WHERE requested=1 AND report_id IS NULL').all()) {
    if (store.db.prepare("SELECT o.id FROM file_transfers f JOIN outbox o ON o.id=f.outbox_id WHERE f.batch_key=? AND o.status IN ('pending','sending') LIMIT 1").get(batch.source_key)) continue;
    if (batch.owner_key !== store.get('owner')) continue;
    const notice = store.db.prepare('SELECT * FROM outbox WHERE id=?').get(batch.notice_id);
    const id = store.completion(notice.trigger_event, '【QQ 文件发送结果】', batchStatus(store, batch), 'file_report', notice.task_id, now, 'files-result:' + batch.source_key + ':' + batch.revision, !!notice.force_proactive);
    if (id) { store.db.prepare('UPDATE outbox SET after_id=? WHERE id=?').run(notice.id, id); store.db.prepare('UPDATE file_batches SET report_id=? WHERE source_key=?').run(id, batch.source_key); }
  }
}

export function releaseSentFiles(store) {
  const rows = store.db.prepare("SELECT f.id,f.spool_path FROM file_transfers f JOIN outbox o ON o.id=f.outbox_id WHERE o.status='sent' AND f.upload_state NOT IN ('released','cleanup_failed') LIMIT 50").all();
  for (const row of rows) {
    try {
      if (existsSync(row.spool_path)) {
        const spool = realLocalPath(path.join(store.directory, 'artifact-spool')), file = realLocalPath(row.spool_path);
        if (!inside(spool, file) || !lstatSync(file).isFile()) throw Error('SPOOL_INVALID');
        unlinkSync(file);
      }
      store.db.prepare("UPDATE file_transfers SET upload_state='released',file_info=NULL,expires_at=NULL WHERE id=?").run(row.id);
    } catch { store.db.prepare("UPDATE file_transfers SET upload_state='cleanup_failed' WHERE id=?").run(row.id); }
  }
}

export function retryFiles(store, batch, trigger) {
  if (batch.owner_key !== store.get('owner')) return 0;
  return store.transaction(() => {
    store.db.prepare("UPDATE file_transfers SET upload_attempts=0 WHERE batch_key=? AND outbox_id IN (SELECT id FROM outbox WHERE status IN ('blocked','unknown'))").run(batch.source_key);
    const changed = store.db.prepare("UPDATE outbox SET status='pending',attempts=0,error=NULL,next_at=0,trigger_event=?,force_proactive=0,after_id=NULL WHERE id IN (SELECT outbox_id FROM file_transfers WHERE batch_key=?) AND status IN ('blocked','unknown')").run(trigger, batch.source_key).changes;
    if (changed) {
      if (batch.report_id) {
        store.db.prepare("UPDATE outbox SET status='blocked',error='FILE_REPORT_SUPERSEDED' WHERE id=? AND status='pending'").run(batch.report_id);
        store.db.prepare("UPDATE outbox_parts SET status='blocked',error='FILE_REPORT_SUPERSEDED' WHERE notification_id=? AND status='pending'").run(batch.report_id);
      }
      store.db.prepare('UPDATE file_batches SET report_id=NULL,revision=revision+1 WHERE source_key=?').run(batch.source_key);
    }
    return changed;
  });
}

export class FileObserver {
  constructor(store, config, { readTurn = readFileTurn } = {}) {
    Object.assign(this, { store, config, readTurn }); this.working = false;
    this.home = config.desktop?.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.native=nativeGlobalEnabled(config)?new NativeDesktopFiles(store,config):null;
    if (config.fileDelivery?.enabled !== false && !store.get('fileDeliveryStartedAt')) store.set('fileDeliveryStartedAt', Date.now());
  }
  stop() { this.stopped = true; }
  scanScope(owner,since){return digest(JSON.stringify([owner,this.config.instanceId||null,this.config.binding||null,this.config.desktopNotifications?.home||null,since]));}
  page(kind,owner,since,scope){
    const key='fileObserverCursor:'+scope+':'+kind,seed=kind==='tasks'?{id:0}:{at:Math.max(0,since-1),thread:'',turn:''};
    let cursor=this.store.get(key)||seed;
    if(kind==='tasks'&&(!Number.isSafeInteger(cursor.id)||cursor.id<0)||kind==='desktop'&&(!Number.isSafeInteger(cursor.at)||typeof cursor.thread!=='string'||typeof cursor.turn!=='string'))cursor=seed;
    const query=after=>kind==='tasks'
      ?this.store.db.prepare("SELECT t.*,o.id notice_id FROM tasks t JOIN outbox o ON o.task_id=t.id AND o.kind='final' WHERE t.finished_at>=? AND t.status='succeeded' AND t.owner_key=? AND t.id>? AND NOT EXISTS(SELECT 1 FROM file_batches b WHERE b.source_key='T:'||t.id) ORDER BY t.id LIMIT 20").all(since,owner,after.id)
      :this.store.db.prepare("SELECT d.*,o.id notice_id,o.content FROM desktop_completions d JOIN outbox o ON o.notification_key='desktop:'||d.thread_id||':'||d.turn_id WHERE d.completed_at>=? AND d.status='completed' AND d.owner_key=? AND (d.completed_at>? OR (d.completed_at=? AND (d.thread_id>? OR (d.thread_id=? AND d.turn_id>?)))) AND NOT EXISTS(SELECT 1 FROM file_batches b WHERE b.source_key='D:'||d.thread_id||':'||d.turn_id) ORDER BY d.completed_at,d.thread_id,d.turn_id LIMIT 20").all(since,owner,after.at,after.at,after.thread,after.thread,after.turn);
    let rows=query(cursor);
    if(!rows.length&&JSON.stringify(cursor)!==JSON.stringify(seed)){cursor=seed;this.store.set(key,seed);rows=query(cursor);}
    return {rows,advance:row=>this.store.set(key,kind==='tasks'?{id:row.id}:{at:row.completed_at,thread:row.thread_id,turn:row.turn_id})};
  }
  retryKey(scope,key){return 'fileObserverRetry:'+scope+':'+digest(key);}
  deferred(scope,key,now){const retry=this.store.get(this.retryKey(scope,key));return !!retry&&Number.isFinite(retry.nextAt)&&retry.nextAt>now&&retry.nextAt-now<=300000;}
  fail(scope,key,error,now){
    const stateKey=this.retryKey(scope,key),prior=this.store.get(stateKey),attempts=Math.min(10,(Number.isSafeInteger(prior?.attempts)?prior.attempts:0)+1),delay=Math.min(300000,1000*2**(attempts-1));
    this.store.set(stateKey,{attempts,nextAt:now+delay,error:/^[A-Z_]{1,100}$/.test(error?.message||'')?error.message:'FILE_CONTEXT_UNAVAILABLE'});
  }
  clearRetry(scope,key){if(this.store.get(this.retryKey(scope,key)))this.store.set(this.retryKey(scope,key),null);}
  async refresh(now = Date.now()) {
    if (this.working || this.stopped || this.config.fileDelivery?.enabled === false || !this.store.get('owner')) return;
    this.working = true; let failures = 0,deferred=0;
    try {
      const since = this.native?Math.max(this.store.get('fileDeliveryStartedAt'),this.config.desktopNotifications.since,this.config.desktopNotifications.discoverySince||0):this.store.get('fileDeliveryStartedAt');
      const owner=this.store.get('owner'),scope=this.scanScope(owner,since),tasks=this.page('tasks',owner,since,scope);
      for (const task of tasks.rows) {
        if (this.stopped) break;
        const key='T:'+task.id;
        try {
          if(this.config.policyVersion>=2&&task.execution_backend!=='app-server')continue;
          if(this.deferred(scope,key,now)){deferred++;continue;}
          planFiles(this.store,this.config,{key,noticeId:task.notice_id,label:taskId(this.store.task(task.id)),prompt:task.prompt,final:task.summary,cwd:task.project_root,startedAt:task.desktop_dispatched_at||task.started_at,completedAt:task.finished_at,owner:task.owner_key},now);this.clearRetry(scope,key);
        }catch(error){failures++;this.fail(scope,key,error,now);}
        finally{tasks.advance(task);}
      }
      const completions=this.config.policyVersion>=2&&!this.native?{rows:[]}:this.page('desktop',owner,since,scope);
      for (const row of completions.rows) {
        if (this.stopped) break;
        const key='D:'+row.thread_id+':'+row.turn_id;
        try {
          if(this.deferred(scope,key,now)){deferred++;continue;}
          const context = this.native?this.native.read(row):await this.readTurn(this.home, row.rollout_path, row.turn_id);
          if (row.project_root && context.cwd && realLocalPath(row.project_root).toLocaleLowerCase() !== realLocalPath(context.cwd).toLocaleLowerCase()) throw Error('TURN_DIRECTORY_CHANGED');
          const label = this.store.db.prepare("SELECT project_name,kind,local_number FROM number_references WHERE owner_key=? AND kind='D' AND entity_key=?").get(row.owner_key, row.thread_id + ':' + row.turn_id);
          if (!label) throw Error('REFERENCE_MISSING');
          if(this.native&&wantsFiles(context.prompt))recordNativeArtifacts(this.store,this.config,key,context,fileCandidates(context.final,context.cwd),FILE_LIMITS);
          planFiles(this.store,this.config,{key,noticeId:row.notice_id,label:`${label.project_name} D${label.local_number}`,prompt:context.prompt,final:context.final,cwd:context.cwd||row.project_root,startedAt:context.startedAt,completedAt:row.completed_at,owner:row.owner_key},now);this.clearRetry(scope,key);
        }catch(error){failures++;this.fail(scope,key,error,now);}
        finally{completions.advance(row);}
      }
      reportFiles(this.store, now);
      this.store.set('fileDeliveryHealth', { ok: failures === 0&&deferred===0, checkedAt: now, failures, retryDeferred:deferred, retryMaxDelayMs:300000, enabled: true, maxFileBytes: FILE_LIMITS.bytes, maxFilesPerTurn: FILE_LIMITS.count });
    } finally { this.working = false; }
  }
}
