export const WORK_OPTIONS = [
  ['项目列表'], ['选择项目'], ['当前项目'], ['项目进度'], ['项目任务'],
  ['新建任务', '新任务'], ['任务列表'], ['查询任务状态', '状态'],
  ['查看任务结果', '结果'], ['继续任务', '继续'], ['取消任务', '取消'],
  ['补发通知', '补发'], ['停止接单'], ['恢复接单'], ['模型与推理设置', '模型选择', '模型设置']
];

// Old command names remain aliases. Numbers always belong to the visible page.
export const WORK_SECTIONS = [
  { name: '项目管理', screen: 'work_projects', options: [
    ['选择或切换项目', '选择项目'], ['当前项目', '当前项目'], ['项目进度', '项目进度']
  ] },
  { name: '任务管理', screen: 'work_tasks', options: [
    ['新建任务', '新建任务'], ['进行中任务', '任务列表'], ['近期全部任务', '项目任务'],
    ['查看状态与结果', '查询任务状态'], ['指导或继续任务', '选择已有任务'],
    ['取消任务', '取消任务'], ['补发结果通知', '补发通知'], ['跨项目 QQ 任务', '任务列表 全部']
  ] },
  { name: '文件与图片', screen: 'work_files', options: [
    ['上传文件或图片', '接收文件'], ['接收状态', '接收状态'], ['确认上传完成', '文件已发完'],
    ['重试接收', '重试接收'], ['取消接收', '取消接收'], ['查看文件发送状态', '文件状态'], ['补发文件', '补发文件']
  ] },
  { name: '审批与问答', screen: 'work_review', options: [
    ['待审批', '审批列表'], ['查看审批', '查看审批'], ['待回答', '问题列表'], ['查看问题', '查看问题'], ['回答问题', '回答问题']
  ] },
  { name: '模型与推理设置', screen: 'model_settings' },
  { name: '接单设置', screen: 'work_intake', options: [['暂停接单', '停止接单'], ['恢复接单', '恢复接单']] }
];

export const workSection = screen => WORK_SECTIONS.find(section => section.screen === screen && section.options);
export function workSectionChoice(screen, text) {
  const options = screen === 'menu' ? WORK_SECTIONS.map(section => [section.name, section.screen]) : workSection(screen)?.options;
  if (!options) return null;
  return (/^[1-9]\d*$/.test(text) ? options[Number(text) - 1] : options.find(option => option[0] === text))?.[1] || null;
}

export function workSectionMenu(screen, paused = false, portable = false, remoteApprovals = false) {
  const section = workSection(screen);
  if (!section) return '';
  return `Codex 工作 · ${section.name}\n`
    + (screen === 'work_intake' ? `当前状态：${paused ? '已暂停接单' : '正常接单'}\n` : '')
    + section.options.map(([name], index) => `${index + 1}．${name}`).join('\n')
    + (screen === 'work_review' ? remoteApprovals ? '\n“待审批”同时显示任务和桌面审批。核对当前完整通知后，直接回复“批准”或“拒绝”；每次只处理当前一条。任务问题按 B 编号回答；客户端问题按 Q 编号查看并在原卡片作答。' : portable ? '\n普通问题请回复 B编号；审批请在本机管理台逐项核对并决定。' : '\n批准或拒绝请原样回复审批通知中的指令与验证码。' : '')
    + (screen === 'work_files' ? '\n可直接发送 QQ 图片或文件；需要分析时发送“新任务：读取图片或文件并说明要求”。' : '')
    + '\n0．返回工作菜单';
}

export function interaction(store, owner) {
  const saved = store.get('interaction:' + owner);
  if (!saved || saved.version !== 1 || !['main', 'chatgpt', 'codex'].includes(saved.mode)) {
    return { version: 1, mode: 'main', screen: 'menu' };
  }
  return saved;
}

export function navigate(store, owner, mode, screen = 'menu', pending = null) {
  const state = { version: 1, mode, screen, ...(pending ? { pending } : {}) };
  store.set('interaction:' + owner, state);
  return state;
}

export const lineName = value => String(value).replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 100);

export function mainMenu() {
  return '当前模式：主菜单\n1．Codex 聊天\n2．Codex 工作\n聊天可选择人设，工作用于项目任务。';
}

export function workMenu(projectName, preferences = {}, desktop = false) {
  return `当前模式：Codex 工作\n当前项目：${projectName ? lineName(projectName) + (desktop === 'app-server' ? '（按本机项目授权执行）' : desktop ? '（桌面执行）' : '（只读）') : '尚未选择'}\n`
    + `工作模型：${preferences.model || (desktop === 'app-server' ? '本人 Codex 默认' : desktop ? '桌面默认' : 'CLI 默认')}\n工作推理：${preferences.reasoning || (desktop === 'app-server' ? '本人 Codex 默认' : desktop ? '桌面默认' : 'CLI 默认')}\n`
    + WORK_SECTIONS.map((section, index) => `${index + 1}．${section.name}`).join('\n')
    + '\n编号格式：项目名 A/D/T数字；无来源项目为杂项。'
    + '\n编号以当前页为准；原文字指令仍可直接使用。'
    + '\n0．返回上一级';
}

export function workOption(text) {
  const index = WORK_OPTIONS.findIndex(names => names.includes(text));
  return index >= 0 ? index + 1 : null;
}
