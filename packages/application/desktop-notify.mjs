import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { noLinks, atomicJson, sha256 } from './boundaries.mjs';
import { completionText } from './completion.mjs';
import {spawn} from 'node:child_process';

// The documented notify event is a hint. Only the independently reconciled
// desktop terminal record can create a QQ notification.
export function recordDesktopNotify(settingsFile, input, environment = process.env) {
  const file = noLinks(settingsFile);
  if (lstatSync(file).nlink !== 1 || lstatSync(file).size > 16000) throw Error('DESKTOP_NOTIFY_SETTINGS_INVALID');
  const settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (settings.schemaVersion !== 1 || !path.isAbsolute(settings.businessDirectory)) throw Error('DESKTOP_NOTIFY_SETTINGS_INVALID');
  if (environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE && environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== 'Codex Desktop') return { recorded: false };
  if (typeof input !== 'string' || Buffer.byteLength(input) > 1024 * 1024) throw Error('DESKTOP_NOTIFY_EVENT_INVALID');
  const event = JSON.parse(input);
  if (event.type !== 'agent-turn-complete') return { recorded: false };
  if (![event['thread-id'], event['turn-id']].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)) || typeof event.cwd !== 'string') throw Error('DESKTOP_NOTIFY_EVENT_INVALID');
  const directory = noLinks(settings.businessDirectory), config = JSON.parse(readFileSync(path.join(directory, 'config.local.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (config.instanceId !== settings.instanceId || JSON.stringify(config.binding) !== JSON.stringify(settings.binding) || config.desktopNotifications?.enabled !== true) throw Error('DESKTOP_NOTIFY_OWNER_CHANGED');
  const spool = noLinks(path.join(directory, 'desktop-notify'), { create: true }), id = sha256(event['thread-id'] + ':' + event['turn-id']), target = path.join(spool, id + '.json');
  if (existsSync(target)) return { recorded: false, duplicate: true };
  const hint = { schemaVersion: 1, threadId: event['thread-id'], turnId: event['turn-id'], cwd: event.cwd, receivedAt: Date.now(), summary: completionText(event['last-assistant-message'] ?? '').slice(0, 250000) };
  try { writeFileSync(target, JSON.stringify(hint), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return { recorded: false, duplicate: true }; throw error; }
  atomicJson(path.join(spool, 'last-received.json'), { threadId: hint.threadId, turnId: hint.turnId, receivedAt: hint.receivedAt });
  return { recorded: true };
}
export async function forwardDesktopNotifier(settingsFile,input){
  const settings=JSON.parse(readFileSync(noLinks(settingsFile),'utf8').replace(/^\uFEFF/,'')),previous=settings.previousNotify;
  if(!Array.isArray(previous)||!previous.length)return;
  if(previous.length>32||previous.some(value=>typeof value!=='string'||value.length>8192)||!path.isAbsolute(previous[0]))throw Error('DESKTOP_PREVIOUS_NOTIFIER_INVALID');
  await new Promise(resolve=>{let done=false,timer;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};const child=spawn(previous[0],[...previous.slice(1),input],{windowsHide:true,shell:false,stdio:'ignore'});child.once('error',finish);child.once('exit',finish);child.unref();timer=setTimeout(finish,3000);});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input=process.argv[3]==='--base64'?Buffer.from(process.argv[4]||'','base64').toString('utf8'):process.argv[3];
  try { recordDesktopNotify(process.argv[2],input); }
  catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'DESKTOP_NOTIFY_FAILED'); process.exitCode = 1; }
  finally {try{await forwardDesktopNotifier(process.argv[2],input);}catch{}}
}
