import { routeBridgeAnswer } from './bridge-requests.mjs';
import { ownerKey, taskId } from './store.mjs';
import { availableProjects, resolveProject, projectList, projectProgress, statusLabel } from './projects.mjs';
import { interaction, navigate, mainMenu, workMenu, workOption, WORK_SECTIONS, workSection, workSectionChoice, workSectionMenu } from './menus.mjs';
import { chatMenu, routeChat } from './chat.mjs';
import { workPreferences, modelSettingsMenu, routeModelSettings } from './models.mjs';
import { routeApproval } from './approvals.mjs';
import { routeRemoteApproval } from './approval-control.mjs';
import {routeNativeApproval} from './desktop-permission-control.mjs';
import {routeSimpleApproval,routeApprovalOverview} from './approval-conversation.mjs';
import {qqEventTimestampIsPlausible} from './approval-clock.mjs';
import { parseReference, findReference, resolveTaskNumber } from './numbering.mjs';
import { batchStatus, retryFiles } from './files.mjs';
import { wantsInputFiles, waitingFileTask, claimInputFiles, queueAttachments, routeReceiveCommand, receiveDirectory } from './file-receive.mjs';
import { showProjectTasks, selectProjectTask, selectedTaskDetails, clearSelectedTask, queueTaskGuidance } from './project-tasks.mjs';
import { routeQuestion } from './questions.mjs';
import {routeNativeQuestionCommand} from './desktop-questions.mjs';
import {nativeCatalogSnapshot} from './native-global-notifications.mjs';
import {nativeOwnerEnabled} from './native-owner-state.mjs';
import {queueNativeOperation} from './native-owner-input.mjs';

const workBackend = config => config.integration?.backend === 'app-server' ? 'app-server' : config.desktopTasks?.enabled === true ? 'desktop' : 'readonly';
const attempts = new WeakMap();
const number = (store, owner, text) => resolveTaskNumber(store, owner, text);
const continuation = text => /^(.+?\s+T\s*[1-9]\d*|T\d+)\s*[:：]\s*([\s\S]+)$/i.exec(text);

export function currentMenu(store, config, owner, mode = interaction(store, owner).mode) {
  if (mode === 'chatgpt') return chatMenu(store, owner);
  if (mode === 'codex') return workMenu(resolveProject(store, config, owner)?.name, workPreferences(store, owner), config.integration?.backend === 'app-server' ? 'app-server' : config.desktopTasks?.enabled === true);
  return mainMenu();
}

function fileCommand(store, owner, trigger, content, reply) {
  const match = /^(文件状态|补发文件)\s+(.+)$/i.exec(content); if (!match) return null;
  const reference = findReference(store, owner, match[2]); let key;
  if (reference && reference.kind !== 'A') key = reference.kind + ':' + reference.entity_key;
  else if (/^T\d{1,12}$/i.test(match[2])) {
    const task = store.task(Number(match[2].slice(1))); if (task?.owner_key === owner) key = 'T:' + task.id;
  } else if (/^D\d{1,12}$/i.test(match[2])) {
    const desktop = store.db.prepare('SELECT thread_id,turn_id FROM desktop_completions WHERE notice_number=? AND owner_key=?').get(Number(match[2].slice(1)), owner);
    if (desktop) key = 'D:' + desktop.thread_id + ':' + desktop.turn_id;
  }
  const batch = key && store.db.prepare('SELECT * FROM file_batches WHERE source_key=? AND owner_key=?').get(key, owner);
  if (!batch) return reply('尚无该任务的文件发送记录。请在任务完成后使用完整编号，例如“文件状态 示例项目 D1”。');
  if (match[1] === '文件状态') {
    const text = batchStatus(store, batch);
    store.completion(trigger, '【文件状态】', text, 'file_status'); return { accepted: true };
  }
  const count = retryFiles(store, batch, trigger);
  return reply(count ? `已安排补发 ${count} 个未确认送达的文件。已发送成功的文件不会重发；此前结果未知的文件可能重复。` : '该任务没有可以补发的文件；未找到、超限或不属于本轮的文件需要在新任务中重新产出。');
}

function continuationError(task, owner, config) {
  if (!task || task.owner_key !== owner || !task.thread_id) return '该任务没有可继续的 Codex 会话。';
  if (task.status === 'unknown') return '原任务结果待核对。请先在本机确认原任务终态；当前没有重新提交或继续执行。';
  if (['queued', 'running', 'waiting_files'].includes(task.status)) return '原任务尚未结束。';
  if (task.execution_backend === 'desktop' && task.desktop_phase !== 'submitted') return '原桌面任务的提交结果尚待核对，请先在桌面确认。';
  if (task.project_root && config.projects[task.project]?.path !== task.project_root) return '原项目目录已变更，请重新创建任务。';
  return null;
}

function submitWork(store, config, owner, trigger, project, prompt, parent, now, reply) {
  if (!prompt.trim()) return reply('请输入具体任务要求。');
  if (store.get('paused', false)) return reply('当前暂停接单。');
  if (config.executor.enabled !== true) return reply(config.executionBlockedReason?'Codex 当前等待新版本隔离验证，尚未创建任务。项目浏览、状态和结果查询仍可使用。':'本地执行器尚未启用；请在本机完成 Codex 自检。');
  if (!Object.hasOwn(config.projects, project)) return reply('该项目尚未开放本机执行，请发“项目列表”重新选择。');
  if (prompt.length > 4000) return reply('任务要求请控制在 4000 字符以内。');
  const inputRequested = config.fileReceive?.enabled !== false && (wantsInputFiles(prompt) || !!store.db.prepare('SELECT id FROM received_files WHERE trigger_event=? AND owner_key=? AND task_id IS NULL').get(trigger, owner));
  if (inputRequested && waitingFileTask(store, owner)) return reply(`当前 ${taskId(waitingFileTask(store, owner))} 正在等待文件，请先上传并回复“文件已发完”，或发送“取消接收”。`);
  if (inputRequested && !['desktop', 'app-server'].includes(parent?.execution_backend || workBackend(config))) return reply('读取 QQ 附件需要桌面工作任务。请启用桌面任务后新建任务；原只读会话不支持读取这些附件。');
  const active = store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','running','waiting_files')").get().n + store.db.prepare("SELECT COUNT(*) n FROM task_guidance WHERE status IN ('queued','checking','sending')").get().n;
  const daily = store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE created_at>=?').get(now - 86400000).n + store.db.prepare('SELECT COUNT(*) n FROM task_guidance WHERE created_at>=?').get(now - 86400000).n;
  if (active >= config.executor.maxQueuedTasks || daily >= config.executor.dailyTaskLimit) return reply('已达到队列或每日任务上限。');
  const name = availableProjects(store, config).find(item => item.key === project)?.name || parent?.project_name || project;
  const preferences = { ...workPreferences(store, owner), backend: workBackend(config) };
  const task = store.enqueue(owner, trigger, project, prompt, parent, now, config.projects[project].path, name, preferences);
  navigate(store, owner, 'codex');
  if (inputRequested) {
    store.db.prepare("UPDATE tasks SET status='waiting_files',progress='等待 QQ 上传文件',progress_at=? WHERE id=?").run(now, task.id);
    const count = claimInputFiles(store, owner, task, trigger, now);
    store.reply(trigger, `【Codex】${taskId(task)} 等待文件。\n${count ? `已关联 ${count} 个刚接收的文件，可继续上传。` : '请直接发送 QQ 图片、截图或文件，可混合上传多份。'}\n接收目录：${receiveDirectory(config)}\n全部发完后回复“文件已发完”，保存成功后开始桌面任务。单个最多 20 MiB，每任务最多 10 个。`, 'file_request', task.id);
    return { accepted: true, task: store.task(task.id), waitingFiles: true };
  }
  const desktop = task.execution_backend === 'desktop';
  const portable = task.execution_backend === 'app-server';
  store.reply(trigger, `【Codex】${taskId(task)} 已受理，${portable ? '交给已授权的插件会话执行' : desktop ? '交给桌面对话执行' : '只读执行'}。\n模型：${task.model || (desktop ? '桌面默认' : 'CLI 默认')}；推理：${task.reasoning_effort || (desktop ? '桌面默认' : 'CLI 默认')}。`, 'ack', task.id);
  return { accepted: true, task };
}

function lookupWork(store, owner, trigger, command, identifier, reply,config={}) {
  if (/^D\d{1,12}$/i.test(identifier) || parseReference(identifier)?.kind === 'D') {
    const reference = findReference(store, owner, identifier, 'D');
    const notice = reference ? store.db.prepare('SELECT * FROM desktop_completions WHERE thread_id=? AND turn_id=? AND owner_key=?').get(...reference.entity_key.split(':'), owner)
      : /^D\d{1,12}$/i.test(identifier) ? store.db.prepare('SELECT * FROM desktop_completions WHERE notice_number=? AND owner_key=?').get(Number(identifier.slice(1)), owner) : null;
    const observed=reference&&store.db.prepare('SELECT * FROM desktop_observations WHERE thread_id=? AND turn_id=?').get(...reference.entity_key.split(':'));
    const native=reference&&(nativeCatalogSnapshot(store,config)?.threads||[]).find(row=>row.id+':'+row.turnId===reference.entity_key);
    if(command==='取消'&&native&&nativeOwnerEnabled(config)){const result=queueNativeOperation(store,config,owner,trigger,native.id,{action:'cancel',expectedTurnId:reference.entity_key.split(':')[1]});return reply(result.error||result.text);}
    if(command==='取消'&&(notice||native))return reply('原客户端控制尚未接通，QQ 端尚未发出取消。请在原对话停止任务；收到原终态后再更新状态。');
    if(observed&&command!=='补发')return reply(`【桌面 Codex】${identifier} ${statusLabel(observed.status)}\n${command==='结果'?observed.summary:'原回合终态已核对。'}`);
    if(native&&command!=='补发')return reply(`【桌面 Codex】${identifier} ${statusLabel(native.status)}\n${command==='结果'?(native.summary||'原回合尚无已确认的最终结果。'):native.stage}`);
    if (reference && !notice) return reply('该桌面任务尚未形成完成通知，请在桌面对话查看当前状态。');
    if (!notice) return reply('没有找到本人名下的桌面通知序号。');
    if (command !== '补发') return reply('该序号为桌面完成通知；请在桌面对话查看任务，或用“补发 项目名 D编号”补发发送失败的部分。');
    const item = store.db.prepare('SELECT id FROM outbox WHERE notification_key=?').get('desktop:' + notice.thread_id + ':' + notice.turn_id);
    return reply(item && store.requeueCompletion(trigger, item.id) ? '已安排补发未确认送达的部分，已发送成功的部分不会重发。' : '该通知没有需要补发的部分。');
  }
  const id = number(store, owner, identifier); const task = id === null ? null : store.task(id);
  if (!task || task.owner_key !== owner) return reply('没有找到本人名下的任务，请输入完整编号，例如“示例项目 T1”。');
  navigate(store, owner, 'codex');
  if (command === '取消') {
    if (task.execution_backend === 'desktop' && (task.status === 'running' || (task.status === 'queued' && task.desktop_phase === 'submitted'))) return reply(`${taskId(task)} 已提交桌面对话；请在桌面点击停止。QQ 端未中止任务，仍会查询进度并通知结果。`);
    const updated = store.cancel(id, owner);
    return { ...reply(`${taskId(updated)} ${updated.status === 'running' ? '已请求中止。' : statusLabel(updated.status)}`), cancelId: updated.status === 'running' ? id : null };
  }
  if (command === '补发') {
    const item = store.db.prepare("SELECT id FROM outbox WHERE task_id=? AND kind='final'").get(id);
    return reply(item && store.requeueCompletion(trigger, item.id) ? '已按本次查询消息安排补发。' : '该任务没有需要补发的通知。');
  }
  return reply(`【Codex】${taskId(task)} ${statusLabel(task.status)}\n${task.summary || task.error || task.progress || '任务尚未结束。'}`);
}

function chooseProject(store, config, owner, query, pending, reply) {
  if (!query.trim()) return reply('请补充项目编号或名称，发送“菜单”可退出。');
  const selected = resolveProject(store, config, owner, query);
  if (!selected) return reply('没有唯一匹配的项目；请使用列表编号或完整名称，发送“菜单”可退出。');
  if ((!selected.executable || !Object.hasOwn(config.projects, selected.key))&&selected.kind!=='native') return reply('该项目目前只能列出，尚未开放本机执行。');
  store.set('selectedProject:' + owner, selected.key);
  clearSelectedTask(store, owner);
  if (pending?.after === 'new_task') {
    if(selected.kind==='native')return reply('已选择浏览项目：'+selected.name+'。此项目尚未取得 QQ 新任务执行授权，可发送“项目任务”浏览原会话。');
    navigate(store, owner, 'codex', 'prompt', { action: 'new_task', project: selected.key });
    return reply(`当前模式：Codex 工作\n已选择项目：${selected.name}（${config.integration?.backend === 'app-server' ? '按本机项目授权执行' : config.desktopTasks?.enabled ? '桌面执行' : '只读'}）\n请在下一条消息输入具体任务要求，收到要求后才会创建任务。`);
  }
  return reply(showProjectTasks(store, config, owner, selected, 1, false, Date.now(), `已选择项目：${selected.name.slice(0, 80)}\n`));
}

function routeWork(store, config, owner, trigger, state, content, now, reply, event) {
  if (['model_settings', 'model_pick', 'effort_pick'].includes(state.screen)) return routeModelSettings(store, config, owner, state, content, reply, () => currentMenu(store, config, owner));
  const ask = (pending, text) => {
    navigate(store, owner, 'codex', 'prompt', pending);
    return reply(`当前模式：Codex 工作\n当前项目：${resolveProject(store, config, owner)?.name || '尚未选择'}\n${text}\n发送“菜单”可退出填写。`);
  };
  const group = state.screen !== 'prompt' && (state.screen === 'menu' ? workSectionChoice('menu', content) : WORK_SECTIONS.find(section => section.name === content)?.screen);
  if (group) {
    clearSelectedTask(store, owner);
    navigate(store, owner, 'codex', group);
    return reply(group === 'model_settings' ? modelSettingsMenu(store, owner, config.integration?.backend === 'app-server' ? 'app-server' : config.desktopTasks?.enabled === true) : workSectionMenu(group, store.get('paused', false), config.policyVersion >= 2, config.remoteApprovals?.enabled===true||config.nativeDesktopApprovals?.enabled===true));
  }
  if (workSection(state.screen)) {
    if (['0', '返回上一级'].includes(content)) {
      navigate(store, owner, 'codex'); return reply(currentMenu(store, config, owner));
    }
    const choice = workSectionChoice(state.screen, content);
    if (choice) content = choice;
    else if (/^\d+$/.test(content)) return reply(workSectionMenu(state.screen, store.get('paused', false),config.policyVersion>=2,config.remoteApprovals?.enabled===true||config.nativeDesktopApprovals?.enabled===true));
  }
  const approvalOverview=routeApprovalOverview(store,config,owner,content,now);
  if(approvalOverview)return reply(approvalOverview);
  const nativeQuestion=routeNativeQuestionCommand(store,config,owner,content,trigger,now);
  if(nativeQuestion)return nativeQuestion.sent?{accepted:true}:reply(nativeQuestion.text);
  if (state.screen !== 'prompt' && content === '选择已有任务') content = '项目任务';
  if (['文件状态', '补发文件', '查看审批', '查看问题', '回答问题'].includes(content) && state.screen !== 'prompt') {
    const commands = { 文件状态: '文件状态', 补发文件: '补发文件', 查看审批: '审批', 查看问题: '问题', 回答问题: '回答' };
    return ask({ action: 'group_command', command: commands[content], returnScreen: workSection(state.screen) ? state.screen : 'menu' }, content === '回答问题' || content === '查看问题'
      ? '请在下一条消息输入问题编号，例如“Q1”；回答时也可输入“Q1：答案”。'
      : '请在下一条消息输入完整编号，例如“示例项目 ' + (content === '查看审批' ? 'A1' : 'T1') + '”。');
  }
  if (state.screen !== 'prompt') {
    const receive = routeReceiveCommand(store, config, owner, trigger, content, reply);
    if (receive) return receive;
    const approval = routeApproval(store, config, owner, trigger, content, event, now);
    if (approval) return approval;
    const bridgeAnswer = routeBridgeAnswer(store, owner, content, now, event.sentAt,{trigger});
    if (bridgeAnswer) return reply(bridgeAnswer);
    const question = routeQuestion(store, config, owner, trigger, content, event, now);
    if (question) return question;
  }
  if (['task_picker', 'task_conversation'].includes(state.screen) && ['退出任务', '返回项目', '0'].includes(content)) {
    clearSelectedTask(store, owner); navigate(store, owner, 'codex'); return reply(currentMenu(store, config, owner));
  }
  const selectTask = /^选择任务\s+(.+)$/.exec(content);
  if ((selectTask && state.screen !== 'prompt') || (state.screen === 'task_picker' && /^\d{1,4}$/.test(content))) {
    const selected = state.screen === 'task_picker' ? availableProjects(store, config).find(project => project.key === state.pending?.project) : resolveProject(store, config, owner);
    if (!selected) return reply('请先选择项目。');
    const result = selectProjectTask(store, config, owner, selected, (selectTask?.[1] || content).trim(), now);
    return reply(result.error || result.text);
  }
  if (state.screen === 'task_picker' && ['下一页', '上一页'].includes(content)) {
    const project = resolveProject(store, config, owner);
    return reply(project ? showProjectTasks(store, config, owner, project, (state.pending?.page || 1) + (content === '下一页' ? 1 : -1), state.pending?.recent, now) : '请先选择项目。');
  }
  if (state.screen === 'task_conversation') {
    if (['任务详情', '当前任务', '刷新任务'].includes(content)) return reply(selectedTaskDetails(store, config, owner));
    const command = workOption(content) !== null || /^(?:选择项目\s|项目进度(?:\s|$)|项目任务(?:\s|$)|进行中任务(?:\s|$)|任务列表(?:\s|$)|新任务(?:\s|[:：])|继续\s|状态\s|结果\s|取消\s|补发\s)/.test(content);
    if (!command) {
      if (config.fileReceive?.enabled !== false && wantsInputFiles(content)) return reply(`请先通过 QQ 发送要读取的图片或文件，保存后会返回本机路径。\n随后在当前任务直接发送“读取该本机路径，并说明具体要求”，即可继续原任务对话。\n接收目录：${receiveDirectory(config)}\n当前任务选择保留。`);
      const result = queueTaskGuidance(store, config, owner, trigger, content.replace(/^(?:指导|继续对话)\s*[:：]\s*/, ''), now);
      if (result.legacy) {
        const error = continuationError(result.legacy, owner, config);
        return error ? reply(error) : submitWork(store, config, owner, trigger, result.legacy.project, content, result.legacy, now, reply);
      }
      return reply(result.error || result.text);
    }
  }
  if (state.screen === 'prompt') {
    const pending = state.pending || {};
    if (pending.action === 'group_command') {
      const command = pending.command + ' ' + content.replace(new RegExp('^' + pending.command + '\\s+'), '');
      navigate(store, owner, 'codex', pending.returnScreen || 'menu');
      return fileCommand(store, owner, trigger, command, reply)
        || routeApproval(store, config, owner, trigger, command, event, now)
        || routeQuestion(store, config, owner, trigger, command, event, now)
        || reply('请输入提示中的编号，发送“菜单”可退出。');
    }
    if (pending.action === 'select_project') return chooseProject(store, config, owner, content.replace(/^选择项目\s+/, ''), pending, reply);
    if (pending.action === 'new_task') return submitWork(store, config, owner, trigger, pending.project, content, null, now, reply);
    if (pending.action === 'lookup') return lookupWork(store, owner, trigger, pending.command, content, reply,config);
    if (pending.action === 'project_query') {
      const project = resolveProject(store, config, owner, content);
      if (!project) return reply('请补充唯一项目名称或项目代号，发送“菜单”可退出。');
      navigate(store, owner, 'codex');
      return reply(pending.browser ? showProjectTasks(store, config, owner, project, 1, pending.recent, now) : projectProgress(store, config, owner, project, 1, pending.recent));
    }
    if (pending.action === 'continue_id') {
      const combined = continuation(content);
      const id = number(store, owner, combined?.[1] || content); const parent = id === null ? null : store.task(id);
      const error = continuationError(parent, owner, config);
      if (error) return reply(error + '\n请补充完整任务编号，例如“示例项目 T1”，或发送“菜单”退出。');
      if (combined) return submitWork(store, config, owner, trigger, parent.project, combined[2], parent, now, reply);
      return ask({ action: 'continue_prompt', taskId: id }, `将继续 ${taskId(parent)}；沿用原项目与会话。\n请在下一条消息输入补充要求，收到要求后才会创建继续任务。`);
    }
    if (pending.action === 'continue_prompt') {
      const parent = store.task(pending.taskId); const error = continuationError(parent, owner, config);
      if (error) { navigate(store, owner, 'codex'); return reply(error); }
      return submitWork(store, config, owner, trigger, parent.project, content, parent, now, reply);
    }
    navigate(store, owner, 'codex');
    return reply(currentMenu(store, config, owner));
  }

  const option = workOption(content);
  if (option === 15) { navigate(store, owner, 'codex', 'model_settings'); return reply(modelSettingsMenu(store, owner, config.integration?.backend === 'app-server' ? 'app-server' : config.desktopTasks?.enabled === true)); }
  if (option === 2) return ask({ action: 'select_project' }, projectList(store, config, owner) + '\n请在下一条消息输入项目编号或名称。');
  if (option === 6) {
    const selected = resolveProject(store, config, owner);
    if (!selected) return ask({ action: 'select_project', after: 'new_task' }, projectList(store, config, owner) + '\n请先输入项目编号或名称，再填写任务要求。');
    return ask({ action: 'new_task', project: selected.key }, '请在下一条消息输入具体任务要求，收到要求后才会创建任务。');
  }
  if ([8, 9, 11, 12].includes(option)) return ask({ action: 'lookup', command: { 8: '状态', 9: '结果', 11: '取消', 12: '补发' }[option] }, '请在下一条消息输入完整任务编号，例如“示例项目 T1”。');
  if (option === 10) return ask({ action: 'continue_id' }, '请先输入要继续的完整任务编号，例如“示例项目 T1”，再输入补充要求。');
  const command = ({ 1: '项目列表', 3: '当前项目', 4: '项目进度', 5: '项目任务', 7: '任务列表', 13: '停止接单', 14: '恢复接单' })[option] || content;
  if (command === '项目列表') return reply(projectList(store, config, owner));
  const choose = /^选择项目\s+(.+)$/.exec(command);
  if (choose) return chooseProject(store, config, owner, choose[1], null, reply);
  if (command === '当前项目') {
    const selected = resolveProject(store, config, owner);
    return reply(selected ? `当前模式：Codex 工作\n当前项目：${selected.name}\n${selected.kind==='native'?'浏览原会话状态与结果':config.integration?.backend === 'app-server' ? '通过插件自有会话按本机授权执行' : config.desktopTasks?.enabled ? '通过桌面对话执行任务' : '只读分析'}。发送“项目进度”查询 QQ 与桌面任务。` : '尚未选择项目，请先发“选择项目”。');
  }
  const projectQuery = /^(项目进度|项目任务|进行中任务)(?:\s+([\s\S]+))?$/.exec(command);
  if (projectQuery) {
    let query = projectQuery[2] || ''; const pageMatch = /(?:^|\s)第(\d{1,3})页$/.exec(query);
    const page = pageMatch ? Math.max(1, Number(pageMatch[1])) : 1;
    if (pageMatch) query = query.slice(0, pageMatch.index).trim();
    const selected = resolveProject(store, config, owner, query);
    if (!selected) return ask({ action: 'project_query', recent: projectQuery[1] === '项目任务', browser: projectQuery[1] !== '项目进度' }, '请补充项目名称，或先通过“选择项目”保存当前项目。');
    return reply(projectQuery[1] === '项目进度' ? projectProgress(store, config, owner, selected, page, false) : showProjectTasks(store, config, owner, selected, page, projectQuery[1] === '项目任务', now));
  }
  if (command === '任务列表' || command === '任务列表 全部') {
    const selected = command === '任务列表' ? resolveProject(store, config, owner) : null;
    if (selected) return reply(showProjectTasks(store, config, owner, selected, 1, false, now));
    const tasks = store.tasks(owner, 100).filter(task => !selected || task.project === selected.key).slice(0, 10);
    return reply((selected ? `${selected.name}｜QQ 任务\n` : '') + (tasks.map(task => `${taskId(task)} ${statusLabel(task.status)} ${task.progress || ''}`).join('\n') || '暂无 QQ 任务。'));
  }
  if (command === '停止接单') { store.set('paused', true); return reply('已暂停接收新任务；已有任务和查询仍可处理。'); }
  if (command === '恢复接单') { store.set('paused', false); return reply('已恢复接收新任务。'); }
  const lookup = /^(状态|结果|取消|补发)\s+(.+)$/i.exec(command);
  if (lookup) return lookupWork(store, owner, trigger, lookup[1], lookup[2], reply,config);
  const fresh = /^新任务(?:\s+([^:：\r\n]{1,100}))?\s*[:：]\s*([\s\S]+)$/.exec(command);
  const follow = /^继续\s+/.test(command) ? continuation(command.replace(/^继续\s+/, '')) : null;
  if (fresh) {
    const selected = resolveProject(store, config, owner, fresh[1]);
    if (!selected) return reply(fresh[1] ? '项目名称未授权或不唯一，请先发“项目列表”。' : '请先“选择项目 名称”，再发送“新任务：具体要求”。');
    return submitWork(store, config, owner, trigger, selected.key, fresh[2], null, now, reply);
  }
  if (follow) {
    const parent = store.task(number(store, owner, follow[1])); const error = continuationError(parent, owner, config);
    if (error) return reply(error);
    return submitWork(store, config, owner, trigger, parent.project, follow[2], parent, now, reply);
  }
  if (wantsInputFiles(command)) {
    const selected = resolveProject(store, config, owner);
    if (selected) return submitWork(store, config, owner, trigger, selected.key, command, null, now, reply);
  }
  return reply(currentMenu(store, config, owner));
}

export function route(store, config, event, now = Date.now()) {
  store.configureChat(config);
  if (event.scope !== 'c2c') return { ignored: true, reason: 'unsupported_scope' };
  if (event.appId !== config.qq.appId || typeof event.id !== 'string' || !event.id || event.id.length > 256 || typeof event.sender !== 'string' || !event.sender || event.sender.length > 256 || event.sender !== event.target) return { ignored: true, reason: 'invalid_identity' };
  if (!qqEventTimestampIsPlausible(store,ownerKey(event),event,now)) return { ignored: true, reason: 'invalid_timestamp' };
  const content = String(event.content || '').trim();
  if (content.length > 5000) return { ignored: true, reason: 'content_too_long' };
  const owner = ownerKey(event);
  if (store.get('owner') !== owner) {
    if (store.get('owner')) return { ignored: true, reason: 'identity_rejected' };
    let limit = attempts.get(store);
    if (!limit || now - limit.at > 60000) { limit = { at: now, count: 0 }; attempts.set(store, limit); }
    if (++limit.count > 40) return { ignored: true, reason: 'pairing_rate_limited' };
    const pairing = /^绑定[\s:：+＋]*([a-f0-9]{24})$/i.exec(content);
    if (!pairing) return { ignored: true, reason: 'binding_format' };
    return store.ingest(event, trigger => {
      if (!store.tryPair(event, pairing[1].toLowerCase(), now)) return { ignored: true, reason: 'binding_rejected' };
      navigate(store, owner, 'main');
      store.reply(trigger, '本人绑定成功。\n' + mainMenu());
      return { paired: true };
    });
  }
  return store.ingest(event, trigger => {
    const reply = text => { store.reply(trigger, text); return { accepted: true }; };
    const entry = interaction(store, owner);
    if (entry.screen === 'prompt' && entry.pending?.action === 'group_command' && content.startsWith(entry.pending.command + ' ')) {
      navigate(store, owner, 'codex', entry.pending.returnScreen || 'menu');
    }
    const incoming = queueAttachments(store, config, owner, trigger, event, now);
    if (incoming?.error) return reply(incoming.error);
    const receive = routeReceiveCommand(store, config, owner, trigger, content, reply);
    if (receive) return receive;
    const nativeQuestion=routeNativeQuestionCommand(store,config,owner,content,trigger,now);
    if(nativeQuestion)return nativeQuestion.sent?{accepted:true}:reply(nativeQuestion.text);
    const bridgeAnswer = routeBridgeAnswer(store, owner, content, now, event.sentAt,{trigger});
    if (bridgeAnswer) return reply(bridgeAnswer);
    const simpleApproval=routeSimpleApproval(store,config,owner,content,trigger,event,now);
    if(simpleApproval)return reply(simpleApproval);
    const approvalOverview=routeApprovalOverview(store,config,owner,content,now);
    if(approvalOverview)return reply(approvalOverview);
    const nativeApproval=routeNativeApproval(store,config,owner,content,trigger,event,now);
    if(nativeApproval)return reply(nativeApproval);
    const remoteApproval=routeRemoteApproval(store,config,owner,content,trigger,event,now);
    if(remoteApproval)return reply(remoteApproval);
    if (config.policyVersion >= 2 && /^(审批列表|待审批|查看审批|问题列表|待回答|查看问题|回答问题)(?:\s|$)/.test(content)) {
      const pending = store.db.prepare("SELECT value FROM settings WHERE key LIKE 'bridgeRequest:%'").all()
        .map(row => JSON.parse(row.value)).filter(row => row.owner === owner && row.status === 'pending' && row.expiresAt > now);
      return reply(pending.length ? pending.map(row => (row.kind === 'approval' ? '本机审批 ' : '问题 B') + row.id + '\n' + row.details
        + (row.kind === 'approval' ? '\n请在本机管理台「接入 → Codex」决定。' : '\n回复“回答 B' + row.id + '：答案”。')).join('\n\n') : '当前没有本插件任务的待处理请求。');
    }
    const question = config.policyVersion >= 2 ? null : routeQuestion(store, config, owner, trigger, content, event, now);
    if (question) return question;
    const inputState = interaction(store, owner);
    if (incoming?.count && !(inputState.mode === 'codex' && (inputState.screen === 'prompt' && ['new_task','continue_prompt'].includes(inputState.pending?.action) && content || /^(新任务|继续\s+)/.test(content) || wantsInputFiles(content)))) {
      return reply(`已收到 ${incoming.count} 个文件，正在保存到本机已配置的接收目录。${incoming.task ? '\n可继续上传；全部发完后回复“文件已发完”。' : '\n保存后会返回本机路径。要读取内容，请在 Codex 工作模式创建任务。'}`);
    }
    const approval = routeApproval(store, config, owner, trigger, content, event, now);
    if (approval) return approval;
    const files = fileCommand(store, owner, trigger, content, reply);
    if (files) return files;
    const state = interaction(store, owner);
    if (content === '主菜单' || (content === '返回上一级' && !(state.mode === 'codex' && workSection(state.screen))) || (state.screen === 'menu' && content === '0')) {
      navigate(store, owner, 'main'); return reply(mainMenu());
    }
    if (/^(菜单|帮助|help)$/i.test(content)) {
      navigate(store, owner, state.mode); return reply(currentMenu(store, config, owner, state.mode));
    }
    if (state.mode === 'main') {
      const mode = ['1', 'Codex 聊天', 'ChatGPT 聊天', 'ChatGPT 聊天（免费模式）', 'ChatGPT'].includes(content) ? 'chatgpt' : ['2', 'Codex 工作', 'Codex'].includes(content) ? 'codex' : null;
      if (!mode) return reply(mainMenu());
      navigate(store, owner, mode); return reply(currentMenu(store, config, owner, mode));
    }
    // Chat dispatch happens before any project or work-command parser.
    if (state.mode === 'chatgpt') {
      if (state.screen === 'conversation' && config.fileReceive?.enabled !== false && wantsInputFiles(content)) return reply(`请通过 QQ 发送图片或文件，我会保存到：\n${receiveDirectory(config)}\n需要读取和分析内容时，请进入“Codex 工作”并发送“新任务：${content}”。`);
      return routeChat(store, owner, state, content, now, reply, trigger, config);
    }
    return routeWork(store, config, owner, trigger, state, content, now, reply, event);
  });
}
