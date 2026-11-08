import { navigate } from './menus.mjs';

export const CHAT_MODEL = 'gpt-6-luna';
export const CHAT_EFFORT = 'max';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function selectedChatModel(config = {}) { return { model: config.chat?.model || CHAT_MODEL, reasoning: config.chat?.reasoning || CHAT_EFFORT }; }

export function modelCatalog(config={}) {
 return Array.isArray(config.modelCatalog)?config.modelCatalog.map(m=>({id:m.id,name:m.name||m.id,efforts:[...m.efforts],defaultEffort:m.defaultEffort})):[];
}

export function workPreferences(store, owner) {
  return store.get('workPreferences:' + owner, { model: null, reasoning: null });
}

export function modelSettingsMenu(store, owner, desktop = false) {
  const saved = workPreferences(store, owner);
  const defaults = desktop === 'app-server' ? '本人 Codex 默认' : desktop ? '桌面默认' : 'CLI 默认';
  return `当前模式：Codex 工作\n工作模型：${saved.model || defaults}\n工作推理：${saved.reasoning || defaults}\n1．更换工作模型\n2．调整推理强度\n3．恢复${defaults}\n0．返回工作菜单\n设置只用于以后提交的工作；聊天模型在本机插件设置中独立选择。`;
}

export function validateModel(config, model, reasoning) {
  if (!model && !reasoning) return;
  const found = modelCatalog(config).find(item => item.id === model);
  if (!found || !found.efforts.includes(reasoning)) throw new Error('MODEL_CONFIGURATION_UNAVAILABLE');
}

export function routeModelSettings(store, config, owner, state, content, reply, workMenuText) {
  const menu = () => modelSettingsMenu(store, owner, config.integration?.backend === 'app-server' ? 'app-server' : config.desktopTasks?.enabled === true);
  if (content === '0') {
    if (state.screen === 'model_settings') { navigate(store, owner, 'codex'); return reply(workMenuText()); }
    navigate(store, owner, 'codex', 'model_settings'); return reply(menu());
  }
  if (state.screen === 'model_settings') {
    if (content === '1' || content === '更换工作模型') {
      const catalog = modelCatalog(config);
      if (!catalog.length) return reply('本机模型列表暂不可读，未改变工作设置。');
      navigate(store, owner, 'codex', 'model_pick', { models: catalog.map(item => item.id) });
      return reply('当前模式：Codex 工作\n请选择工作模型：\n' + catalog.map((item, index) => `${index + 1}．${item.id}`).join('\n') + '\n0．返回模型设置');
    }
    if (content === '2' || content === '调整推理强度') {
      const saved = workPreferences(store, owner); const model = modelCatalog(config).find(item => item.id === saved.model);
      if (!model) return reply('请先选择一个明确的工作模型，再调整它支持的推理强度。');
      navigate(store, owner, 'codex', 'effort_pick', { model: model.id, efforts: model.efforts });
      return reply(`当前模式：Codex 工作\n工作模型：${model.id}\n请选择推理强度：\n` + model.efforts.map((level, index) => `${index + 1}．${level}`).join('\n') + '\n0．返回模型设置');
    }
    if (content === '3' || content === '恢复 CLI 默认' || content === '恢复桌面默认' || content === '恢复本人 Codex 默认') {
      store.set('workPreferences:' + owner, { model: null, reasoning: null });
      return reply('已恢复以后的工作使用默认模型和推理。\n' + menu());
    }
    return reply(menu());
  }
  if (state.screen === 'model_pick') {
    const ids = state.pending.models; const selected = /^\d+$/.test(content) ? ids[Number(content) - 1] : content;
    const model = modelCatalog(config).find(item => item.id === selected && ids.includes(item.id));
    if (!model) return reply('该模型不在本机可选列表中；请输入显示的编号或完整模型名。');
    const previous = workPreferences(store, owner);
    store.set('workPreferences:' + owner, { model: model.id, reasoning: model.efforts.includes(previous.reasoning) ? previous.reasoning : model.defaultEffort });
    navigate(store, owner, 'codex', 'model_settings');
    return reply('工作模型已保存；聊天设置不变。\n' + menu());
  }
  const levels = state.pending.efforts; const selected = /^\d+$/.test(content) ? levels[Number(content) - 1] : content.toLowerCase();
  const saved = workPreferences(store, owner);
  try { validateModel(config, state.pending.model, selected); } catch { return reply('该推理强度不受当前模型支持，请使用显示的编号或名称。'); }
  if (saved.model !== state.pending.model) return reply('工作模型已经变化，请发送“菜单”重新选择。');
  store.set('workPreferences:' + owner, { model: saved.model, reasoning: selected });
  navigate(store, owner, 'codex', 'model_settings');
  return reply('工作推理强度已保存。\n' + menu());
}
