import { chunkedUpload } from './chunked-upload.mjs';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { spawn } from 'node:child_process';
import {readFileSync} from 'node:fs';
import {noLinks} from './boundaries.mjs';
import path from 'node:path';
import { SendError } from './delivery.mjs';
import {qqMessageReceipt,rememberQQClock} from './approval-clock.mjs';
import {createQQCredentialProtector} from '../host-control/qq-credential-process.mjs';


const ROUTE_REASONS = new Set(['unsupported_scope', 'invalid_identity', 'invalid_timestamp', 'content_too_long', 'binding_format', 'binding_rejected']);

// Extract only the event name from the pinned SDK's debug line. The remainder
// can contain a binding code or message text and must never be persisted.
export function gatewayEventType(line) {
  if (typeof line !== 'string') return null;
  return /^\[[^\]\r\n]{1,128}\] Dispatch event: t=([A-Z][A-Z0-9_]{0,63}) payload=/.exec(line)?.[1] || null;
}
export const validQQSecretText=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\r\n\x00]/.test(value);
export async function readSecret(config,{protector=createQQCredentialProtector()}={}) {
 if(config.qq.credentialFormat==='dpapi-qq-owner-v1'){
  try{const cipher=readFileSync(noLinks(config.qq.credentialFile),'utf8').trim(),plain=JSON.parse(await protector.open(cipher));
   const expected={botId:config.binding.botId,agentId:config.binding.agentId,bindingId:config.binding.bindingId,bindingVersion:config.binding.bindingVersion,accountConnectionId:config.accountConnectionId};
   if(JSON.stringify(plain.owner)!==JSON.stringify(expected)||plain.appId!==config.qq.appId||!validQQSecretText(plain.appSecret))throw Error('QQ_CREDENTIAL_OWNER_MISMATCH');return plain.appSecret;
  }catch{throw Error('QQ_CREDENTIAL_UNAVAILABLE');}
 }
 if(process.platform!=='win32')throw Error('QQ_WINDOWS_CREDENTIAL_REQUIRED');
 const root=process.env.SystemRoot||process.env.SYSTEMROOT;
 if(!root||!path.isAbsolute(root))throw Error('QQ_OS_HELPER_REQUIRED');
 const executable=noLinks(path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'));
 const encrypted=readFileSync(noLinks(config.qq.credentialFile),'utf8').trim();
 if(!encrypted||encrypted.length>16384)throw Error('QQ_CREDENTIAL_INVALID');
 const script="$ErrorActionPreference='Stop';try{$s=ConvertTo-SecureString ([Console]::In.ReadToEnd());$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}}catch{[Environment]::Exit(1)}";
 return new Promise((resolve,reject)=>{
  const allowed=new Set(['SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','TMPDIR','XDG_CACHE_HOME','PSMODULEANALYSISCACHEPATH','USERPROFILE','LOCALAPPDATA','APPDATA','OS','PROCESSOR_ARCHITECTURE']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k.toUpperCase())));
  const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,env,stdio:['pipe','pipe','pipe']});
  let output='',failed=false;const timer=setTimeout(()=>{failed=true;child.kill();},10000);
  child.on('error',()=>{failed=true;});child.stdin.on('error',()=>{failed=true;});child.stderr.on('data',()=>{});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>8192){failed=true;child.kill();}});
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0||!output||!/^[A-Za-z0-9+/=]+$/.test(output)){reject(Error('QQ_CREDENTIAL_UNAVAILABLE'));return;}
   const bytes=Buffer.from(output,'base64');try{const secret=bytes.toString('utf8');if(!validQQSecretText(secret))throw Error('QQ_CREDENTIAL_INVALID');resolve(secret);}catch{reject(Error('QQ_CREDENTIAL_INVALID'));}finally{bytes.fill(0);}
  });child.stdin.end(encrypted);
 });
}

export function normalizeMessage(appId, message) {
  return {
    appId, scope: message.kind, sender: message.senderId,
    target: message.replyTarget?.targetId, id: message.messageId,
    content: message.content, sentAt: Date.parse(message.timestamp),
    ...(Array.isArray(message.attachments) && message.attachments.length ? { attachments: message.attachments.map(item => ({ url: item.url, filename: item.filename, content_type: item.content_type, size: item.size })) } : {})
  };
}

export class QQTransport {
  constructor(config, secret, store, onState = () => {}, fetchImpl = fetch) {
    this.stopped = false; this.controller = new AbortController();
    this.config = config; this.store = store; this.fetch = fetchImpl; this.onState = onState;
    this.bot = new QQBot({ appId: config.qq.appId, appSecret: secret,
      baseUrl: 'https://api.bot.qq.com', tokenBaseUrl: 'https://api.bot.qq.com',
      markdownSupport: false, transport: 'websocket', intents: 1 << 25,
      reconnect: { maxAttempts: 20 },
      // Never forward SDK logs: payload previews can contain pairing codes.
      logger: { info() {}, warn() {},
        debug: line => {
          const eventType = gatewayEventType(line);
          if (eventType) this.record('dispatch', { lastDispatchType: eventType });
        },
        error: line => this.record(typeof line === 'string' && line.includes('Message parse error:') ? 'parse_error' : 'sdk_error')
      },
      sessionPersistence: {
        load: () => store.get(`session:${config.qq.appId}`),
        save: session => store.set(`session:${config.qq.appId}`, session),
        clear: () => store.set(`session:${config.qq.appId}`, null)
      }
    });
    this.bot.on('ready', data => {
      store.set('qqReadyAt', Date.now());
      if (typeof data?.user?.username === 'string') store.set('qqBotName', data.user.username.slice(0, 100));
      this.record('ready', { connection: 'ready', connectionAt: Date.now() });
      onState('QQ 长连接已就绪');
    });
    this.bot.on('resumed', () => { this.record('resumed', { connection: 'resumed', connectionAt: Date.now() }); onState('QQ 会话已恢复'); });
    this.bot.on('disconnected', () => { this.record('disconnected', { connection: 'disconnected', connectionAt: Date.now() }); onState('QQ 连接中断，正在恢复'); });
    this.bot.on('error', () => { this.record('connection_error'); onState('QQ 接入异常，请检查本机状态'); });
  }
  record(kind, detail = {}) {
    if (this.stopped) return;
    const diagnostic = this.store.get('qqDiagnostics', { counts: {} });
    diagnostic.counts[kind] = (diagnostic.counts[kind] || 0) + 1;
    Object.assign(diagnostic, detail, { updatedAt: Date.now() });
    this.store.set('qqDiagnostics', diagnostic);
  }
  recordRoute(result) {
    const outcome = result.paired ? 'paired' : result.accepted ? 'accepted' : result.duplicate ? 'duplicate' : 'ignored';
    this.record('route', { lastRoute: { outcome, reason: ROUTE_REASONS.has(result.reason) ? result.reason : null, at: Date.now() } });
  }
  onMessage(callback) {
    this.bot.on('message', (_context, message) => {
      this.record(message.kind === 'c2c' ? 'message_c2c' : 'message_other');
      if (!this.stopped && message.kind === 'c2c' && !message.senderIsBot) callback(normalizeMessage(this.config.qq.appId, message));
    });
  }
  start(signal) {
    this.record('start', { startedAt: Date.now(), pid: process.pid, connection: 'connecting', proactiveEnabled: this.config.qq.allowProactive === true, desktopProjectsEnabled: this.config.desktop?.enabled === true });
    return this.bot.start(signal);
  }
  stop() { if (this.stopped) return; this.stopped = true; this.controller.abort(); const pending = this.bot.stop(); pending?.catch?.(() => {}); }
  async uploadFile(message, bytes, filename) {
    if (this.stopped || this.config.runtimeStopping) throw new SendError('EGRESS_STOPPED');
    if (message.scope !== 'c2c') throw new SendError('MVP_GROUP_DISABLED');
    const check = () => {
      if (this.stopped || this.config.runtimeStopping || this.store.get('egressPaused') || this.config.sending?.enabled === false
        || this.config.fileDelivery?.enabled === false || this.config.fileDelivery?.sendEnabled === false) throw new SendError('EGRESS_STOPPED');
    };
    check();
    if (bytes.length >= 5 * 1024 * 1024) {
      try {
        return await chunkedUpload(bytes, filename, { check,
          request: async (suffix, body) => {
            check(); const token = await this.bot.api.getToken(); check();
            const response = await this.fetch('https://api.bot.qq.com/v2/users/' + encodeURIComponent(message.target) + '/' + suffix, {
              method: 'POST', headers: { Authorization: 'QQBot ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)])
            });
            check(); const result = await response.json();
            if (!response.ok || Number(result.err_code || result.code || 0)) throw Error('CHUNK_API_FAILED');
            return result;
          },
          put: async (url, data) => {
            check();
            const response = await this.fetch(url, { method: 'PUT', headers: { 'Content-Length': String(data.length) }, body: data,
              redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]) });
            await response.body?.cancel();
            check(); if (!response.ok) throw Error('CHUNK_PUT_FAILED');
          }
        });
      } catch (error) {
        if (this.stopped || this.config.runtimeStopping || error.code === 'EGRESS_STOPPED') throw new SendError('EGRESS_STOPPED');
        throw new SendError('FILE_UPLOAD_FAILED', { retryable: !/INVALID$/.test(error.message) });
      }
    }
    let token;
    try { token = await this.bot.api.getToken(); }
    catch { throw new SendError('TOKEN_UNAVAILABLE', { retryable: true }); }
    check();
    let response, result;
    try {
      response = await this.fetch(`https://api.bot.qq.com/v2/users/${encodeURIComponent(message.target)}/files`, {
        method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_type: 4, file_data: bytes.toString('base64'), file_name: filename, srv_send_msg: false }), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)])
      });
      result = await response.json();
    } catch { throw new SendError('FILE_UPLOAD_UNAVAILABLE', { retryable: true }); }
    const code = Number(result.err_code || result.code || 0);
    if (!response.ok || code) throw new SendError('FILE_UPLOAD_' + (code || response.status), { retryable: response.status === 429 || response.status >= 500 });
    if (typeof result.file_info !== 'string' || !result.file_info) throw new SendError('FILE_UPLOAD_INVALID_RESPONSE', { retryable: true });
    return { fileInfo: result.file_info, ttl: Number(result.ttl) || 300 };
  }
  async send(message) {
    if (this.stopped || this.config.runtimeStopping) throw new SendError('EGRESS_STOPPED');
    if (message.scope !== 'c2c') throw new SendError('MVP_GROUP_DISABLED');
    let token;
    try { token = await this.bot.api.getToken(); }
    catch { throw new SendError('TOKEN_UNAVAILABLE', { retryable: true }); }
    const body = message.fileInfo ? { msg_type: 7, content: message.content || ' ', media: { file_info: message.fileInfo } } : { msg_type: 0, content: message.content };
    if (message.msgId) { body.msg_id = message.msgId; body.msg_seq = message.seq; }
    if (this.stopped || this.config.runtimeStopping) throw new SendError('EGRESS_STOPPED');
    let response;
    try {
      response = await this.fetch(`https://api.bot.qq.com/v2/users/${encodeURIComponent(message.target)}/messages`, {
        method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)])
      });
    } catch { throw new SendError('NETWORK_RESULT_UNKNOWN', { uncertain: true }); }
    let result;
    try { result = await response.json(); }
    catch { throw new SendError('INVALID_RESPONSE', { uncertain: true }); }
    const code = Number(result.err_code || result.code || 0);
    if (!response.ok || code) {
      throw new SendError(code || response.status, { retryable: response.status === 429, uncertain: response.status >= 500 });
    }
    if (!result.id) throw new SendError('MISSING_MESSAGE_ID', { uncertain: true });
    this.store.set('qqLiveSendAt', Date.now());
    const receipt=qqMessageReceipt(result.id,result,response.headers);
    rememberQQClock(this.store,receipt,Date.now());
    return receipt;
  }
}
