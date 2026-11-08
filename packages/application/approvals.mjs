export function routeApproval(store,config,owner,trigger,content,event,now) {
  if (/^(?:审批|审批列表|待审批)(?:\s|$)/.test(content)) { store.reply(trigger,config.policyVersion>=2?'请在本机管理台查看本插件待审批请求。':'手机审批尚未启用。请在本机管理台处理。'); return {accepted:true}; }
  if (/^(?:批准|拒绝|允许|同意)\s+A\d+/i.test(content)) { store.reply(trigger,'请在本机管理台核对并逐项处理审批。'); return {accepted:true}; }
  return null;
}
