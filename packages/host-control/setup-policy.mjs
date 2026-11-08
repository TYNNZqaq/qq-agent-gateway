import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {resolveApplicationPaths,readApplicationIdentity} from './application-paths.mjs';
export const SETUP_PRIVACY_VERSION=1;
export const SETUP_PRIVACY_TEXT='本机安装与初次打开不上传数据库、配置、日志或凭据。经你明确同意后，仅使用本插件独立登录的 ChatGPT 账号，将已配对本人通过所选 QQ 机器人发送的任务、聊天、人设、相关来源记忆及明确授权项目中所需文件和 AGENTS 规则发送至 OpenAI 推理，并通过同一 QQ 机器人向本人回复。自检仅在全新合成目录调用一次所选模型。账号登录由本人在官方页面完成，QQ 平台凭据仅在本机加密保存。不读取其他应用登录库，不使用 API Key，不自动购买额度，不上传发布或扫描其他目录。诊断导出须先脱敏预览。';
export const SETUP_PRIVACY_HASH=createHash('sha256').update(SETUP_PRIVACY_TEXT).digest('hex');
export const SETUP_DESKTOP_PRIVACY_TEXT='启用本机原生会话功能后，程序只在当前用户声明的 Codex 资料目录核对本机桌面来源的会话、状态和普通问题；从启用时间起，通过当前已配对的 QQ 机器人向本人同步通知与可用的完整问题。本人通过 QQ 发出的指导、同会话继续、原回合取消及问题答案，经原会话、目录、owner 和回合匹配后交回该桌面会话，沿用原窗口的权限。它不新增工作项目权限，不读取桌面账号凭据，不自动信任 hook 或代答浏览器应用授权。独立聊天和新任务生成须另经当前账号及项目的真实执行验证。';
export const SETUP_DESKTOP_PRIVACY_HASH=createHash('sha256').update(SETUP_DESKTOP_PRIVACY_TEXT).digest('hex');
export const desktopFeatureConsentValid=consent=>consent?.confirmed===true&&consent.desktopFeatures?.policyVersion===1&&consent.desktopFeatures.policyHash===SETUP_DESKTOP_PRIVACY_HASH&&consent.desktopFeatures.enabled===true;
export const setupScope=({identity,account,binding})=>({hostId:identity.hostId,instanceId:identity.instanceId,botId:binding.botId,agentId:binding.agentId,bindingId:binding.bindingId,bindingVersion:binding.bindingVersion,accountConnectionId:account.connectionId,selectedModel:account.selected?.model||null,selectionEpoch:account.selected?.accountEpoch||null});
export function assertConsentMirror(paths,consent){try{const s=lstatSync(paths.consentFile);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384||JSON.stringify(JSON.parse(readFileSync(paths.consentFile,'utf8')))!==JSON.stringify(consent))throw Error('mismatch');}catch{throw Error('SETUP_CONSENT_MIRROR_CHANGED');}}
export function readSetupContext(runtimeDirectory){
 const paths=resolveApplicationPaths({dataDirectory:runtimeDirectory}),identity=readApplicationIdentity(paths);let management,account,setup;
 try{
  management=new DatabaseSync(paths.managementDatabase,{readOnly:true});account=new DatabaseSync(path.join(paths.accountDirectory,'control.sqlite'),{readOnly:true});setup=new DatabaseSync(path.join(paths.dataDirectory,'setup.sqlite'),{readOnly:true});
  const a=JSON.parse(account.prepare('SELECT snapshot FROM account_control WHERE id=1').get().snapshot),s=JSON.parse(setup.prepare('SELECT snapshot FROM setup_control WHERE id=1').get().snapshot),b=management.prepare('SELECT * FROM ui_bindings WHERE agent_id=? AND active=1').get(a.agentId);
  if(s.schemaVersion!==1||s.instanceId!==identity.instanceId||s.hostId!==identity.hostId||!b||!a.selected?.model||a.actions.some(x=>['login','logout'].includes(x.kind)&&['intent','awaiting','unknown'].includes(x.state)))throw Error('SETUP_ACCOUNT_BINDING_REQUIRED');
  const bot=management.prepare('SELECT * FROM ui_bots WHERE id=?').get(b.bot_id),agent=management.prepare('SELECT * FROM ui_agents WHERE id=?').get(b.agent_id);if(!bot||bot.archived||bot.status!=='registered'||!agent||agent.archived||agent.status!=='registered'||agent.tool_id!=='codex')throw Error('SETUP_ACTIVE_OWNER_REQUIRED');
  const binding={botId:b.bot_id,agentId:b.agent_id,bindingId:b.id,bindingVersion:b.version},scope=setupScope({identity,account:a,binding}),consent=s.consent;
  if(consent?.confirmed!==true||consent.policyVersion!==SETUP_PRIVACY_VERSION||consent.policyHash!==SETUP_PRIVACY_HASH||JSON.stringify(consent.scope)!==JSON.stringify(scope))throw Error('SETUP_EXPLICIT_CONSENT_REQUIRED');
  assertConsentMirror(paths,consent);
  return {paths,identity,account:a,setup:s,binding,bot,consent,scope};
 }finally{setup?.close();account?.close();management?.close();}
}
