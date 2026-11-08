export function routeQuestion(store,config,owner,trigger,content) { if(/^(?:问题列表|待回答|查看问题|问题|回答)(?:\s|$)/.test(content)&&!(config.policyVersion>=2)){store.reply(trigger,'手机问答尚未启用。请在本机处理。');return {accepted:true};}return null; }
export const questionsEnabled = config => config?.nativeDesktopQuestions?.enabled===true;
