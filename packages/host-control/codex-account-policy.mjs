import { ManagementError } from '../core/management.mjs';
import {localCodexProxy} from './codex-network-policy.mjs';
import {createHash} from 'node:crypto';
import {withApplicationCache} from './application-cache.mjs';
export function accountIdentityFingerprint(account){
 if(account?.type!=='chatgpt')throw Error('ACCOUNT_IDENTITY_UNAVAILABLE');
 const email=typeof account.email==='string'&&account.email?account.email:null,workspace=account.workspaceRouting?.chatgptAccountId||null;
 if(!email&&!workspace)throw Error('ACCOUNT_IDENTITY_UNAVAILABLE');return createHash('sha256').update(JSON.stringify([email,workspace])).digest('hex');
}

// This current-version account protocol is independent of the historical offline Adapter.
export const ACCOUNT_CLI_VERSION = '0.164.0-alpha.11.1';
export const accountError = (code, status=409) => new ManagementError(code,status);
const systemEnvironment = new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','SYSTEMDRIVE','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','OS','LANG','LC_ALL','TZ']);
export function accountEnvironment(environment,home) {
  const result=Object.fromEntries(Object.entries(environment).filter(([key])=>systemEnvironment.has(key.toUpperCase())));
  result.CODEX_HOME=home;
  return withApplicationCache({...result,...localCodexProxy(environment)},home);
}
export const accountConfig = `forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
model_provider = "openai"
sandbox_mode = "read-only"
approval_policy = "never"
web_search = "disabled"
allow_login_shell = false
[analytics]
enabled = false
[mcp_servers]
[features]
apps = false
plugins = false
hooks = false
multi_agent = false
browser_use = false
computer_use = false
image_generation = false
memories = false
remote_control = false
`;
export const accountArguments=Object.freeze(['app-server','--listen','stdio://',
  ...['forced_login_method="chatgpt"','cli_auth_credentials_store="file"','model_provider="openai"','mcp_servers={}','analytics.enabled=false','web_search="disabled"','allow_login_shell=false','sandbox_mode="read-only"','approval_policy="never"'].flatMap(value=>['-c',value]),
  ...['apps','plugins','hooks','multi_agent','browser_use','computer_use','image_generation','memories','remote_control'].flatMap(value=>['--disable',value])]);

// Checked again at the only wire writer. Nothing from an HTTP request supplies an RPC name.
export function checkAccountRpc(method,params) {
  const exact=(keys)=>params&&Object.getPrototypeOf(params)===Object.prototype&&Object.keys(params).length===keys.length&&keys.every(k=>Object.hasOwn(params,k));
  let valid=false;
  if(method==='initialize')valid=exact(['clientInfo','capabilities'])&&JSON.stringify(params)==='{"clientInfo":{"name":"qq_gateway_account_control","title":"QQ Gateway account control","version":"1.0.0"},"capabilities":{"experimentalApi":false}}';
  if(method==='config/read')valid=exact(['includeLayers'])&&params.includeLayers===false;
  if(method==='account/read')valid=exact(['refreshToken'])&&params.refreshToken===false;
  if(method==='account/login/start')valid=exact(['type'])&&['chatgpt','chatgptDeviceCode'].includes(params.type);
  if(method==='account/login/cancel')valid=exact(['loginId'])&&safeReference(params.loginId);
  if(method==='account/logout')valid=params===undefined;
  if(method==='model/list')valid=exact(['includeHidden','limit','cursor'])&&params.includeHidden===false&&params.limit===100&&(params.cursor===null||safeReference(params.cursor,2048));
  if(!valid)throw accountError('ACCOUNT_METHOD_OR_PARAMS_FORBIDDEN',400);
}
export const safeReference=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
export const safeModel=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export function loginHandoff(result,type) {
  if(!result||result.type!==type||!safeReference(result.loginId))throw accountError('ACCOUNT_LOGIN_RESPONSE_INVALID');
  const target=type==='chatgpt'?result.authUrl:result.verificationUrl;
  if(typeof target!=='string'||target.length>8192)throw accountError('ACCOUNT_LOGIN_URL_INVALID');
  let url;try{url=new URL(target);}catch{throw accountError('ACCOUNT_LOGIN_URL_INVALID');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!['auth.openai.com','auth0.openai.com','chatgpt.com','auth.chatgpt.com'].includes(url.hostname))throw accountError('ACCOUNT_LOGIN_URL_INVALID');
  if(type==='chatgptDeviceCode'&&(url.hostname!=='auth.openai.com'||url.pathname!=='/codex/device'||url.search||!/^[-A-Z0-9]{4,32}$/.test(result.userCode)))throw accountError('ACCOUNT_LOGIN_RESPONSE_INVALID');
  const redirect=url.searchParams.get('redirect_uri');
  if(redirect){let callback;try{callback=new URL(redirect);}catch{throw accountError('ACCOUNT_LOGIN_URL_INVALID');}if(callback.protocol!=='http:'||!['localhost','127.0.0.1'].includes(callback.hostname)||callback.pathname!=='/auth/callback'||callback.username||callback.password||callback.hash)throw accountError('ACCOUNT_LOGIN_URL_INVALID');}
  return {loginId:result.loginId,url:url.href,...(type==='chatgptDeviceCode'?{userCode:result.userCode}:{})};
}
export function checkAccountConfiguration(result) {
  const c=result?.config;
  if(c?.forced_login_method!=='chatgpt'||c?.cli_auth_credentials_store!=='file'||c?.model_provider!=='openai'||Object.keys(c.mcp_servers||{}).length)throw accountError('ACCOUNT_CONFIGURATION_REJECTED');
}
