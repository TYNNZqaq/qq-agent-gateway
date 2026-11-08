import { taskId } from './store.mjs';
import { publicText } from './portable-view.mjs';
import {nativeCatalogSnapshot} from './native-global-notifications.mjs';

const labels = { waiting_files: '等待上传文件', queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', needs_input: '等待补充', active_recorded: '执行中（最近记录）', ended_recorded: '已输出答复', completed: '本轮已结束', unconfirmed: '上次记录执行中，当前待确认', unknown: '状态待确认' };
export const statusLabel = value => labels[value] || '状态待确认';
const clock = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '未知';
export function availableProjects(store, config) {
  const desktop = config.desktop?.enabled === true ? store.get('desktopSnapshot')?.projects || [] : [];
  const staticProjects = Object.entries(config.projects).filter(([, project]) => !project.discovered).map(([key, project]) => ({ key, name: project.label || key, aliases:project.aliases||[], path: project.path, executable: true, kind: 'local' }));
  const result=[...desktop,...staticProjects];
  for(const project of nativeCatalogSnapshot(store,config)?.projects||[])if(!result.some(p=>p.key===project.key))result.push(project);
  return result;
}
export function resolveProject(store, config, owner, query) {
  const projects = availableProjects(store, config); const text = String(query || '').trim();
  if (!text) return projects.find(project => project.key === store.get('selectedProject:' + owner)) || null;
  if (/^\d{1,3}$/.test(text)) {
    const picker = store.get('projectPicker:' + owner);
    if (!picker || Date.now() - picker.at > 600000) return null;
    return projects.find(project => project.key === picker.keys[Number(text) - 1]) || null;
  }
  const exactKey = projects.find(project => project.key === text);
  if (exactKey) return exactKey;
  const matches = projects.filter(project => project.name.toLocaleLowerCase() === text.toLocaleLowerCase() || (project.aliases||[]).some(alias=>alias.toLocaleLowerCase()===text.toLocaleLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}
export function projectList(store, config, owner) {
  const projects = availableProjects(store, config);
  store.set('projectPicker:' + owner, { at: Date.now(), keys: projects.map(project => project.key) });
  const selected = store.get('selectedProject:' + owner);
  const lines = projects.map((project, index) => `${index + 1}. ${project.name}${project.aliases?.length?'（别名：'+project.aliases.join('、')+'）':''}${project.key === selected ? '【当前】' : ''}${project.kind === 'native'?'（浏览与通知）':project.kind === 'cloud' ? '（云端，仅列出）' : project.executable ? (config.integration?.backend === 'app-server' ? '（按本机项目授权执行）' : config.desktopTasks?.enabled ? '（桌面执行）' : '（只读）') : '（目录不可用）'}`);
  return '项目列表\n' + lines.join('\n') + '\n发送“选择项目 名称”或“选择项目 编号”。';
}
export function projectProgress(store, config, owner, project, page = 1, includeRecent = false, now = Date.now()) {
  const snapshot = nativeCatalogSnapshot(store,config)||store.get('desktopSnapshot'); const health = store.get('desktopHealth');
  const local = store.db.prepare('SELECT id,status,progress,progress_at,started_at,created_at FROM tasks WHERE owner_key=? AND project=? ORDER BY id DESC LIMIT 30').all(owner, project.key);
  const desktop = project.desktopId||project.kind==='native' ? (snapshot?.threads || []).filter(thread => thread.project === project.key).map(thread => thread.status === 'active_recorded' && now - thread.updatedAt > 600000 ? { ...thread, status: 'unconfirmed' } : thread) : [];
  const localActive = local.filter(task => ['queued', 'running', 'waiting_files', 'needs_input'].includes(task.status));
  const desktopActive = desktop.filter(task => ['active_recorded', 'unconfirmed'].includes(task.status));
  const rows = [
    ...(includeRecent ? local : localActive).map(task => ({ source: 'QQ', title: taskId(store.task(task.id)), status: task.status, stage: task.progress || (task.status === 'queued' ? '等待前面的任务完成' : '暂无阶段记录'), updatedAt: task.progress_at || task.started_at || task.created_at })),
    ...(includeRecent ? desktop : desktopActive).map(task => ({ source: '桌面', ...task }))
  ];
  const start = (page - 1) * 3; const selected = rows.slice(start, start + 3);
  let result = `${project.name}｜项目${includeRecent ? '任务' : '进度'}\nQQ 进行中 ${localActive.length}；桌面最近记录进行中 ${desktopActive.length}\n`;
  if (project.kind === 'cloud') return result + '此云端项目的实时聊天记录未在本机开放，不能据此判断任务是否运行。';
  if (project.desktopId) result += `桌面记录读取：${clock(snapshot?.checkedAt)}${health?.ok === false || now - (snapshot?.checkedAt || 0) > 30000 ? '（读取异常，结果可能过时）' : ''}\n`;
  const unknown = desktop.filter(task => task.status === 'unknown').length;
  if (unknown) result += `另有 ${unknown} 条桌面记录状态待确认，可发“项目任务”查看。\n`;
  if (!selected.length) result += page > 1 ? '本页没有更多任务。' : '当前未记录到进行中的任务。可发“项目任务”查看近期记录。';
  for (const task of selected) {
    const plan = task.plan?.total ? `；计划步骤 ${task.plan.completed}/${task.plan.total}` : '';
    const block = `\n[${task.source}] ${task.title}\n${statusLabel(task.status)}${plan}；更新 ${clock(task.updatedAt)}\n${publicText(task.stage, 130)}\n`;
    if (result.length + block.length > 810) { result += '\n部分任务标题较长，请在桌面端查看完整记录。'; break; }
    result += block;
  }
  if (rows.length > start + 3) result += `\n第 ${page} 页；更多发送“${includeRecent ? '项目任务' : '项目进度'} ${project.name} 第${page + 1}页”。`;
  if (snapshot?.truncated) result += '\n仅查询最近 200 条桌面记录。';
  return result;
}
