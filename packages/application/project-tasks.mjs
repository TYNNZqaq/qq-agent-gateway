import { taskId } from './store.mjs';
import { publicText, readDesktopSnapshot } from './portable-view.mjs';
import { availableProjects, statusLabel } from './projects.mjs';
import { resolveTaskNumber, findReference } from './numbering.mjs';
import { navigate } from './menus.mjs';
import { validThreadId } from './portable-view.mjs';
import { sameDirectory } from './portable-view.mjs';
import { fileInstructions } from './files.mjs';
import path from 'node:path';
import {nativeCatalogSnapshot} from './native-global-notifications.mjs';
import {referenceLabel} from './numbering.mjs';
import {nativeControlAvailable,nativeOwnerEnabled} from './native-owner-state.mjs';
import {queueNativeOperation} from './native-owner-input.mjs';

const ACTIVE = new Set(['queued', 'running', 'waiting_files', 'needs_input', 'active_recorded', 'unconfirmed', 'ended_recorded', 'unknown']);
const PAGE_SIZE = 2;
const selectedKey = owner => 'selectedWorkTask:' + owner;
const pickerKey = owner => 'workTaskPicker:' + owner;

// A picker stores immutable identifiers, never positions in a refreshed list.
export function projectTaskRows(store, owner, project, recent = false, now = Date.now(), config = {}) {
  const portable = config.policyVersion >= 2 || config.integration?.backend === 'app-server';
  const catalog=nativeCatalogSnapshot(store,config);
  const desktop = (catalog?.threads||(portable?[]:store.get('desktopSnapshot')?.threads||[])).filter(row=>row.project===project.key);
  const local = store.db.prepare('SELECT id FROM tasks WHERE owner_key=? AND project=? ORDER BY id DESC LIMIT 200').all(owner, project.key).map(row => store.task(row.id)).filter(task => !portable || task.execution_backend === 'app-server' && sameDirectory(task.project_root, project.path));
  const rows = [], seen = new Set();
  for (const task of local) {
    const native = desktop.find(row => row.id === task.thread_id);
    // A later desktop turn may be running in a conversation whose old QQ
    // task already ended. Show the current desktop task in that case.
    if (native && ACTIVE.has(native.status) && !ACTIVE.has(task.status)) continue;
    if (!recent && !ACTIVE.has(task.status)) continue;
    if (task.thread_id && seen.has(task.thread_id)) continue;
    if (task.thread_id) seen.add(task.thread_id);
    rows.push({ key: 't:' + task.id, kind: 'qq', taskId: task.id, threadId: task.thread_id, project: project.key,
      cwd: task.desktop_cwd || native?.cwd || task.project_root, title: task.desktop_title || publicText(task.prompt, 90), label: taskId(task),
      brief: publicText(task.prompt, 150), status: task.status, stage: native?.stage || task.progress || '暂无阶段记录', updatedAt: task.progress_at || task.created_at });
  }
  for (const task of desktop) {
    const status = task.status === 'active_recorded' && now - task.updatedAt > 600000 ? 'unconfirmed' : task.status;
    if (seen.has(task.id) || (!recent && !ACTIVE.has(status))) continue;
    rows.push({ key: 'd:' + task.id, kind: 'desktop', taskId: null, threadId: task.id, project: project.key, cwd: task.cwd,
      title: task.title, label: task.reference?referenceLabel(task.reference):'桌面', brief: task.brief || task.summary || task.title, status, stage: task.stage, updatedAt: task.updatedAt, turnId:task.turnId,readOnly:!!catalog&&!nativeControlAvailable(store,config,task.id,now),nativeOwner:!!catalog&&nativeControlAvailable(store,config,task.id,now) });
  }
  return rows.sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.updatedAt - a.updatedAt);
}

export function showProjectTasks(store, config, owner, project, page = 1, recent = false, now = Date.now(), prefix = '') {
  const rows = projectTaskRows(store, owner, project, recent, now, config);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); page = Math.max(1, Math.min(page, pages));
  const start = (page - 1) * PAGE_SIZE, visible = rows.slice(start, start + PAGE_SIZE);
  store.set(pickerKey(owner), { at: now, project: project.key, recent, page, entries: visible.map(row => ({ key: row.key, number: start + visible.indexOf(row) + 1 })) });
  navigate(store, owner, 'codex', rows.length ? 'task_picker' : 'menu', rows.length ? { project: project.key, recent, page } : null);
  const snapshot = store.get('desktopSnapshot'), health = store.get('desktopHealth');
  let text = prefix + `${publicText(project.name, 80)}｜${recent ? '项目任务' : '进行中任务'}（${rows.length}）\n`;
  if (config.desktop?.enabled && (health?.ok === false || now - (snapshot?.checkedAt || 0) > 30000)) text += '桌面记录读取异常，状态可能过时；发送前会重新核对。\n';
  for (const [index, row] of visible.entries()) text += `\n${start + index + 1}. [${publicText(row.label, 70)}] ${publicText(row.title, 65)}\n${statusLabel(row.status)}\n简介：${publicText(row.brief, 100)}\n进度：${publicText(row.stage, 65)}\n`;
  if (!rows.length) text += '当前没有记录到进行中的任务。发送“项目任务”可查看近期任务，或“新任务：具体要求”。\n';
  else text += '\n回复“选择任务 编号”或直接回复本页编号；选定后查看详情和当前可用操作。\n';
  if (pages > 1) text += `第 ${page}/${pages} 页；下一页 / 上一页。\n`;
  if (snapshot?.truncated) text += '桌面范围：最近 200 条公开任务。\n';
  text += '项目任务：含近期记录；菜单：工作菜单。';
  return text;
}

export function selectProjectTask(store, config, owner, project, query, now = Date.now()) {
  const picker = store.get(pickerKey(owner)), rows = projectTaskRows(store, owner, project, true, now, config);
  let key;
  if (/^\d{1,4}$/.test(query)) {
    if (!picker || picker.project !== project.key || now - picker.at > 600000) return { error: '任务列表已过期或项目已切换，请发送“进行中任务”刷新后选择。' };
    key = picker.entries.find(entry => entry.number === Number(query))?.key;
  } else {
    const id = resolveTaskNumber(store, owner, query);
    if (id !== null) key = 't:' + id;
    if (!key) {
      const reference = findReference(store, owner, query, 'D');
      const threadId = reference?.entity_key.split(':')[0];
      if (threadId) key = 'd:' + threadId;
      else if (validThreadId(query)) key = 'd:' + query;
    }
  }
  const row = rows.find(item => item.key === key || (key?.startsWith('d:') && item.threadId === key.slice(2)));
  if (!row) return { error: '没有找到本项目的唯一任务。请按当前列表的编号选择，或输入完整 T/D编号。' };
  store.set('selectedProject:' + owner, project.key);
  store.set(selectedKey(owner), { ...row, projectRoot: project.path });
  navigate(store, owner, 'codex', 'task_conversation');
  return { row, text: selectedTaskDetails(store, config, owner) };
}

export function selectedTaskDetails(store, config, owner) {
  const selected = store.get(selectedKey(owner));
  const project = availableProjects(store, config).find(row => row.key === selected?.project);
  const row = project && projectTaskRows(store, owner, project, true, Date.now(), config).find(row => row.key === selected.key);
  if (!row) return '所选任务暂不可用，请发送“进行中任务”重新选择。';
  const last = store.db.prepare('SELECT id,status FROM task_guidance WHERE owner_key=? AND target_key=? ORDER BY id DESC LIMIT 1').get(owner, row.key);
  const labels = { queued: '等待发送', checking: '核对原对话', sending: '正在发送', sent: '原对话已接收', merged: '已补充到待执行要求', unknown: '结果待核对，未自动重发', failed: '未发送成功' };
  return `已选择任务：[${publicText(row.label, 70)}] ${publicText(row.title, 95)}\n项目：${publicText(project.name, 80)}\n状态：${statusLabel(row.status)}\n简介：${publicText(row.brief, 180)}\n进度：${publicText(row.stage, 150)}\n`
    + (last ? `最近指导 #${last.id}：${labels[last.status] || '待核对'}\n` : '')
    + (row.readOnly?'可查询原回合状态和结果。当前原客户端控制尚未接通，指导、继续和取消请在原客户端操作。\n':'直接输入指导或补充要求，将发送到此任务原对话；任务结束后仍可继续此对话。\n')
    + '任务详情：刷新状态；任务列表：重新选择；退出任务：返回工作菜单。';
}

export function clearSelectedTask(store, owner) { store.set(selectedKey(owner), null); }

export function queueTaskGuidance(store, config, owner, trigger, prompt, now = Date.now()) {
  const target = store.get(selectedKey(owner));
  if (!target || target.project !== store.get('selectedProject:' + owner)) return { error: '请先在当前项目选择任务。' };
  if(target.kind==='desktop'&&nativeOwnerEnabled(config))return queueNativeOperation(store,config,owner,trigger,target.threadId,{action:'guide',prompt},now);
  if(target.readOnly)return {error:'原客户端控制尚未接通，请在原对话输入指导、继续或取消。当前没有新建替代会话。'};
  if (!prompt.trim() || prompt.length > 4000) return { error: '指导内容需要 1 至 4000 字符。' };
  if (store.get('paused', false) || config.executor.enabled !== true) return { error: '当前暂停接收工作要求，请恢复接单后再发送。' };
  if (!config.projects[target.project] || !sameDirectory(config.projects[target.project].path, target.projectRoot)) return { error: '项目目录已变化，请重新选择项目和任务。' };
  const task = target.taskId ? store.task(target.taskId) : null;
  if (target.kind === 'qq' && (!task || task.owner_key !== owner || task.project !== target.project)) return { error: '所选任务已不可用，请重新选择。' };
  if (task?.execution_backend === 'readonly' && !['queued', 'waiting_files'].includes(task.status)) return { legacy: task };
  if (config.desktopTasks?.enabled !== true && !task) return { error: '桌面对话接入尚未启用。' };
  const pending = store.db.prepare("SELECT COUNT(*) n FROM task_guidance WHERE status IN ('queued','checking','sending')").get().n;
  const daily = store.db.prepare('SELECT COUNT(*) n FROM task_guidance WHERE created_at>=?').get(now - 86400000).n + store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE created_at>=?').get(now - 86400000).n;
  if (pending >= config.executor.maxQueuedTasks || daily >= config.executor.dailyTaskLimit) return { error: '已达到队列或每日工作要求上限。' };
  const result = store.db.prepare(`INSERT INTO task_guidance(owner_key,trigger_event,project,project_root,target_key,target_cwd,task_id,thread_id,title,prompt,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(owner, trigger, target.project, target.projectRoot, target.key, target.cwd || null, task?.id || null, target.threadId || null, publicText(target.title, 160), prompt, now);
  const id = Number(result.lastInsertRowid);
  return { id, text: `任务指导 #${id} 已受理。\n[${publicText(target.label, 70)}] ${publicText(target.title, 120)}\n核对原任务后发送；收到桌面回执后另行确认。` };
}

export class TaskGuidanceWorker {
  constructor(store, config, client, { readSnapshot = null } = {}) {
    Object.assign(this, { store, config, client });
    const home = config.desktop?.home || process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
    this.readSnapshot = readSnapshot || (() => readDesktopSnapshot(home)); this.working = false;
  }
  stop() { this.stopped = true; }
  finish(message, status, text, error = null) {
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE task_guidance SET status=?,finished_at=?,error=? WHERE id=?').run(status, Date.now(), error, message.id);
      this.store.reply(message.trigger_event, `任务指导 #${message.id}：${text}\n${publicText(message.title, 120)}`, 'guidance_result');
    });
  }
  async runOnce() {
    if (this.working || this.stopped) return false; this.working = true;
    let message;
    try {
      message = this.store.transaction(() => {
        const row = this.store.db.prepare("SELECT * FROM task_guidance WHERE status='queued' ORDER BY id LIMIT 1").get();
        if (row) this.store.db.prepare("UPDATE task_guidance SET status='checking' WHERE id=?").run(row.id);
        return row;
      });
      if (!message) return false;
      if (this.store.get('owner') !== message.owner_key || this.config.executor.enabled !== true) throw Error('OWNER_CHANGED');
      if (Date.now() - message.created_at > 600000) throw Error('GUIDANCE_EXPIRED');
      const project = this.config.projects[message.project];
      if (!project || !sameDirectory(project.path, message.project_root)) throw Error('PROJECT_CHANGED');
      const task = message.task_id ? this.store.task(message.task_id) : null;
      if (message.task_id && (!task || task.owner_key !== message.owner_key || task.project !== message.project)) throw Error('TARGET_CHANGED');
      if (task && ['queued', 'waiting_files'].includes(task.status) && !task.desktop_phase) {
        const prompt = task.prompt + '\n\n【QQ 补充指导】\n' + message.prompt;
        if (prompt.length > 8000) throw Error('PROMPT_TOO_LONG');
        this.store.transaction(() => {
          this.store.db.prepare('UPDATE tasks SET prompt=? WHERE id=? AND status IN (\'queued\',\'waiting_files\') AND desktop_phase IS NULL').run(prompt, task.id);
          this.finish(message, 'merged', '已补充到待执行任务，将随原要求一起执行。');
        });
        return true;
      }
      if (task?.execution_backend === 'app-server') {
        await this.client.guide(message, task);
        this.finish(message, 'sent', '原插件会话已接收；已结束的任务会形成继续任务。');
        return true;
      }
      if (this.config.desktopTasks?.enabled !== true) throw Error('DESKTOP_DISABLED');
      if (task && (task.execution_backend !== 'desktop' || task.desktop_phase !== 'submitted')) throw Error('TARGET_NOT_READY');
      const threadId = task?.thread_id || message.thread_id;
      if (!validThreadId(threadId)) throw Error('TARGET_NOT_READY');
      const snapshot = this.readSnapshot();
      const current = snapshot.threads.find(row => row.id === threadId && row.project === message.project);
      if (!current || !sameDirectory(current.cwd, message.target_cwd)) throw Error('TARGET_CHANGED');
      const state = await this.client.read(threadId, 'local', 1);
      if (state.thread?.id !== threadId || !sameDirectory(state.thread.cwd, message.target_cwd)) throw Error('TARGET_CHANGED');
      if (this.store.get('owner') !== message.owner_key || !sameDirectory(this.config.projects[message.project]?.path, message.project_root)) throw Error('TARGET_CHANGED');
      if (this.stopped) { this.store.db.prepare("UPDATE task_guidance SET status='queued' WHERE id=?").run(message.id); return false; }
      // Persist the mutation boundary before writing to the desktop. Running
      // threads receive a follow-up through the app's normal steering path.
      this.store.db.prepare("UPDATE task_guidance SET status='sending',thread_id=?,dispatched_at=? WHERE id=?").run(threadId, Date.now(), message.id);
      const result = await this.client.send({ threadId, hostId: 'local', prompt: `【QQ 任务指导 #${message.id}】\n${message.prompt}${fileInstructions(message.prompt)}` });
      if (result?.threadId !== threadId) throw Error('DESKTOP_RESPONSE_UNKNOWN');
      this.finish(message, 'sent', '原任务对话已接收。正在执行时作为补充指导，空闲时继续原对话；结果沿用 QQ 完成通知。');
      return true;
    } catch (error) {
      if (message) {
        const sending = this.store.db.prepare('SELECT status FROM task_guidance WHERE id=?').get(message.id)?.status === 'sending';
        const errors = { PROJECT_CHANGED: '项目目录已变化，请重新选择。', TARGET_CHANGED: '原任务已移出项目、归档或目录变化，请刷新任务列表。', TARGET_NOT_READY: '原任务尚未确认提交，请稍后刷新任务详情。', GUIDANCE_EXPIRED: '等待发送超过 10 分钟，请核对后重新输入。', PROMPT_TOO_LONG: '累计任务要求超过 8000 字符，请缩短补充内容。' };
        this.finish(message, sending ? 'unknown' : 'failed', sending ? '发送结果待核对，请先在原桌面对话核对；未自动重发。' : (errors[error.message] || '未能连接或核对原对话，本条未发送。请恢复连接后重新输入。'), error.code || error.message);
      }
      return false;
    } finally {
      this.working = false;
      this.store.set('taskGuidanceHealth', { ok: true, checkedAt: Date.now(), pending: this.store.db.prepare("SELECT COUNT(*) n FROM task_guidance WHERE status IN ('queued','checking','sending')").get().n });
    }
  }
}
