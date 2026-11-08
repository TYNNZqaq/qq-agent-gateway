import path from 'node:path';
import { completionText } from './completion.mjs';
import { noLinks, inside, sha256 } from './boundaries.mjs';
import { ensureReference, referenceLabel } from './numbering.mjs';
import { NativeDesktopReader } from '../host-control/native-desktop-reader.mjs';
import {NativeGlobalNotifications,nativeGlobalEnabled,nativeGlobalNoticeValid} from './native-global-notifications.mjs';

export function notificationProjects(config) {
  const feature = config.desktopNotifications;
  if (feature?.enabled !== true) return [];
  if(feature.scope==='all-local'){
    if(!Number.isSafeInteger(feature.since)||feature.since<1||feature.since>Date.now()+30000||typeof feature.home!=='string')throw Error('DESKTOP_NOTIFICATION_CONFIGURATION_INVALID');
    noLinks(feature.home);return [];
  }
  if (!Number.isSafeInteger(feature.since) || feature.since < 1 || !Array.isArray(feature.projects) || !feature.projects.length || feature.projects.length > 32) throw Error('DESKTOP_NOTIFICATION_CONFIGURATION_INVALID');
  const ids = new Set();
  return feature.projects.map(project => {
    if (typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(project.id) || ids.has(project.id) || typeof project.label !== 'string' || !project.label.trim() || project.label.length > 80) throw Error('DESKTOP_NOTIFICATION_PROJECT_INVALID');
    ids.add(project.id); const directory = noLinks(project.path);
    if (directory === path.parse(directory).root) throw Error('DESKTOP_NOTIFICATION_PROJECT_INVALID');
    return { id: project.id, label: project.label, path: directory };
  });
}
function scopeFor(config, owner, project) {
  if (!owner || !config.binding?.botId || !config.binding?.agentId || !config.binding?.bindingId || !Number.isInteger(config.binding.bindingVersion)) throw Error('DESKTOP_NOTIFICATION_OWNER_REQUIRED');
  return { schemaVersion: 1, instanceId: config.instanceId, hostId: config.hostId || config.instanceId,dataDirectory:config.runtimeRoot||config.stateDir, ...config.binding, appId: config.qq.appId, owner, project };
}
export function desktopNoticeValid(store, config, item) {
  if (item.kind !== 'desktop_final') return true;
  const observation = store.db.prepare('SELECT * FROM desktop_observations WHERE outbox_id=?').get(item.id);
  if (!observation) return true; // Retained legacy records keep their prior delivery rules.
  if(JSON.parse(observation.scope_json).schemaVersion===2)return nativeGlobalNoticeValid(store,config,observation);
  try {
    const prior = JSON.parse(observation.scope_json), project = notificationProjects(config).find(p => p.id === prior.project.id);
    return !!project && sha256(JSON.stringify(scopeFor(config, store.get('owner'), project))) === observation.scope_key;
  } catch { return false; }
}
export class DesktopNotifications {
  constructor(store, config, { reader, now = () => Date.now() } = {}) {
    Object.assign(this, { store, config, now }); this.projects = notificationProjects(config);
    this.global=nativeGlobalEnabled(config)?new NativeGlobalNotifications(store,config,{reader,now}):null;
    this.owner = store.get('owner'); this.reader = this.projects.length ? reader || new NativeDesktopReader(config.desktopNotifications.home) : null;
  }
  refresh() {
    if(this.global)return this.global.refresh();
    if (!this.reader) return;
    const errors = [];
    try {
      this.config.runtimeGuard?.();
      if (this.owner !== this.store.get('owner')) throw Error('DESKTOP_NOTIFICATION_OWNER_CHANGED');
      for (const row of this.reader.list(this.projects, this.config.desktopNotifications.since)) {
        try { this.observe(row); }
        catch (error) { errors.push({ threadId: row.id, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'DESKTOP_OBSERVATION_FAILED' }); }
      }
    } catch (error) { errors.push({ error: /^[A-Z_]+$/.test(error.message) ? error.message : 'DESKTOP_OBSERVER_UNAVAILABLE' }); }
    this.store.set('desktopObserverStatus', { enabled: true, checkedAt: this.now(), error: errors[0]?.error || null, errors: errors.slice(0, 12), source: 'codex-desktop-notify-and-native-reconciliation' });
  }
  observe(row) {
    const project = this.projects.filter(p => inside(p.path, row.cwd)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!project) return;
    const scope = scopeFor(this.config, this.owner, project), scopeKey = sha256(JSON.stringify(scope)), key = 'desktopCursor:' + scopeKey + ':' + row.id;
    const batch = this.reader.read(row, this.store.get(key)), pending = { ...batch.cursor.pending };
    this.store.transaction(() => {
      for (const event of batch.events) {
        if (event.type === 'task_started') { pending[event.turnId] = { timestamp: event.timestamp, rootTurnId: event.rootTurnId }; continue; }
        const started = pending[event.turnId];
        if (!started || event.timestamp < started.timestamp || event.rootTurnId !== started.rootTurnId) continue;
        delete pending[event.turnId];
        if (event.timestamp < this.config.desktopNotifications.since) continue;
        // A QQ-owned session is never reclassified as a desktop task.
        if (this.store.get('bridgeThread:' + row.id) || this.store.db.prepare('SELECT id FROM tasks WHERE thread_id=?').get(row.id)) continue;
        const legacy = this.store.db.prepare('SELECT owner_key FROM desktop_completions WHERE thread_id=? AND turn_id=?').get(row.id, event.turnId);
        if (legacy && legacy.owner_key !== this.owner) throw Error('DESKTOP_COMPLETION_OWNER_CHANGED');
        const notificationKey = 'desktop:' + row.id + ':' + event.turnId;
        if (this.store.db.prepare('SELECT id FROM desktop_observations WHERE thread_id=? AND turn_id=?').get(row.id, event.turnId)) continue;
        const status = event.type === 'turn_aborted' ? 'interrupted' : event.failed ? 'failed' : 'completed';
        const body = completionText(event.body || (status === 'failed' ? '桌面回合失败，请在原对话查看错误。' : status === 'interrupted' ? '桌面回合已中断。' : '桌面回合已结束，没有可用的最终答复，请在原对话核对结果。'));
        const observationId = sha256(scopeKey + ':' + row.id + ':' + event.turnId);
        this.store.db.prepare('INSERT INTO desktop_observations(id,scope_key,scope_json,thread_id,turn_id,project_root,status,completed_at,summary,evidence,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(observationId, scopeKey, JSON.stringify(scope), row.id, event.turnId, row.cwd, status, event.timestamp, body, JSON.stringify(event.evidence), this.now());
        this.store.db.prepare('INSERT OR IGNORE INTO desktop_completions(thread_id,turn_id,completed_at,title,status,owner_key,rollout_path,project_root) VALUES(?,?,?,?,?,?,?,?)')
          .run(row.id, event.turnId, event.timestamp, completionText(row.title || project.label), status, this.owner, event.evidence.file, row.cwd);
        this.store.desktopNoticeNumber(row.id, event.turnId);
        const reference = ensureReference(this.store, this.config, 'D', row.id + ':' + event.turnId, { owner: this.owner, scope: { project_key: 'desktop:' + project.id, project_name: project.label }, at: event.timestamp });
        const label = { completed: '回合已完成', failed: '回合失败', interrupted: '回合已中断' }[status];
        const outbox = this.store.ownerNotice(notificationKey, body, this.config.qq.appId, this.now(), '【桌面 Codex】' + referenceLabel(reference) + ' · ' + label);
        if (!outbox) throw Error('DESKTOP_NOTIFICATION_RECIPIENT_MISSING');
        this.store.db.prepare('UPDATE desktop_observations SET outbox_id=? WHERE id=?').run(outbox, observationId);
      }
      if (Object.keys(pending).length > 64) throw Error('DESKTOP_OPEN_TURN_LIMIT');
      this.store.set(key, { ...batch.cursor, pending });
    });
  }
  snapshot() {
    if (!this.reader&&!this.global) return { enabled: false };
    const status = this.store.get('desktopObserverStatus', { enabled: true, checkedAt: null, error: null });
    const deliveries = this.store.db.prepare('SELECT o.status,COUNT(*) count FROM desktop_observations d JOIN outbox o ON o.id=d.outbox_id GROUP BY o.status').all();
    const recent = this.store.db.prepare('SELECT d.thread_id threadId,d.turn_id turnId,d.status terminalStatus,o.status deliveryStatus,o.error,o.provider_id receipt FROM desktop_observations d JOIN outbox o ON o.id=d.outbox_id ORDER BY d.observed_at DESC LIMIT 5').all();
    return { ...status, deliveries, recent };
  }
}
