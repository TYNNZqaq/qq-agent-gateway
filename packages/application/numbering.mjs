import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { completionText } from './completion.mjs';
import {nativeCatalogSnapshot} from './native-desktop-scope.mjs';

const normalizeName = value => completionText(String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80) || '杂项';
export const referenceLabel = reference => `${reference.project_name} ${reference.kind}${reference.local_number}`;
export const desktopEntity = (thread, turn) => thread + ':' + turn;
const misc = { project_key: 'misc', project_name: '杂项' };
const projectKey = project => 'project:' + (project.key || ('p_' + project.desktopId.replace(/-/g, '')));

// Project selection in QQ does not reclassify an unrelated desktop task.
// Prefer the recorded source project; projectless tasks share the misc scope.
export function sourceProject(store, config = {}, hints = {}) {
  if (hints.scope) return { project_key: hints.scope.project_key, project_name: normalizeName(hints.scope.project_name) };
  if(hints.threadId&&!hints.task?.project){
    const native=nativeCatalogSnapshot(store,config),thread=native?.threads.find(t=>t.id===hints.threadId),project=native?.projects.find(p=>p.key===thread?.project);
    if(project)return {project_key:project.project_key,project_name:normalizeName(project.project_name)};
  }
  const snapshot = store.get('desktopSnapshot') || {}, projects = snapshot.projects || [], task = hints.task;
  if (task?.project) {
    const known = projects.find(project => project.key === task.project);
    if (known) return { project_key: projectKey(known), project_name: normalizeName(known.name) };
    const configured = config.projects?.[task.project];
    if (configured?.desktopId) return { project_key: 'project:p_' + configured.desktopId.replace(/-/g, ''), project_name: normalizeName(configured.label || task.project_name || task.project) };
    return { project_key: 'project:' + task.project, project_name: normalizeName(configured?.label || task.project_name || task.project) };
  }
  if (hints.projectId) {
    const known = projects.find(project => project.desktopId === hints.projectId);
    if (known) return { project_key: projectKey(known), project_name: normalizeName(known.name) };
  }
  let authoritative = false;
  if (hints.threadId && config.desktop?.enabled === true) {
    const home = config.desktop.home || process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
    let database;
    try {
      database = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      const row = database.prepare('SELECT t.project_id,p.name FROM threads t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(hints.threadId);
      if (row) {
        authoritative = true;
        if (row.project_id && row.name) return { project_key: 'project:p_' + row.project_id.replace(/-/g, ''), project_name: normalizeName(row.name) };
        if (!row.project_id) {
          try {
            const file = path.join(home, '.codex-global-state.json');
            if (statSync(file).size <= 8000000) {
              const state = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
              const assigned = state['thread-project-assignments']?.[hints.threadId]?.projectId;
              const legacy = assigned && projects.find(project => project.legacyId === assigned || project.desktopId === assigned);
              if (legacy) return { project_key: projectKey(legacy), project_name: normalizeName(legacy.name) };
            }
          } catch { /* No explicit legacy assignment means this is projectless. */ }
        }
      }
    } catch { /* A recent public project snapshot is the read-only fallback. */ }
    finally { database?.close(); }
  }
  const recorded = (snapshot.threads || []).find(thread => thread.id === hints.threadId);
  const known = projects.find(project => project.key === recorded?.project);
  // Older desktop builds store project assignment outside the thread row;
  // the monitor already resolves those assignments to a real project ID.
  if (known && !authoritative) return { project_key: projectKey(known), project_name: normalizeName(known.name) };
  return misc;
}

export function ensureReference(store, config, kind, entity, hints = {}) {
  if (!['A', 'D', 'T'].includes(kind)) throw Error('NUMBER_KIND_INVALID');
  const owner = hints.owner || store.get('owner'); if (!owner) throw Error('NUMBER_OWNER_MISSING');
  const entityKey = String(entity);
  return store.transaction(() => {
    const existing = store.db.prepare('SELECT * FROM number_references WHERE owner_key=? AND kind=? AND entity_key=?').get(owner, kind, entityKey);
    if (existing) return existing;
    const scope = sourceProject(store, config, hints);
    const next = store.db.prepare('SELECT COALESCE(MAX(local_number),0)+1 n FROM number_references WHERE owner_key=? AND project_key=? AND kind=?').get(owner, scope.project_key, kind).n;
    store.db.prepare('INSERT INTO number_references(owner_key,project_key,project_name,kind,local_number,entity_key,created_at) VALUES (?,?,?,?,?,?,?)').run(owner, scope.project_key, scope.project_name, kind, next, entityKey, hints.at || Date.now());
    return store.db.prepare('SELECT * FROM number_references WHERE owner_key=? AND kind=? AND entity_key=?').get(owner, kind, entityKey);
  });
}

export function parseReference(value) {
  const match = /^(.*?)\s+([ADT])\s*([1-9]\d{0,11})$/i.exec(String(value).trim());
  if (!match || !match[1].trim()) return null;
  return { project_name: normalizeName(match[1]), kind: match[2].toUpperCase(), local_number: Number(match[3]) };
}

export function findReference(store, owner, value, expectedKind = null) {
  const parsed = parseReference(value); if (!parsed || (expectedKind && parsed.kind !== expectedKind)) return null;
  const rows = store.db.prepare('SELECT * FROM number_references WHERE owner_key=? AND project_name=? AND kind=? AND local_number=?').all(owner, parsed.project_name, parsed.kind, parsed.local_number);
  // Identically named projects never cause an approval in another project.
  return rows.length === 1 ? rows[0] : null;
}

export function resolveTaskNumber(store, owner, value) {
  const text = String(value).trim();
  if (/^T\d{1,12}$/i.test(text)) return Number(text.slice(1));
  const reference = findReference(store, owner, text, 'T'); return reference ? Number(reference.entity_key) : null;
}

export function migrateReferences(store, config = {}) {
  store.transaction(() => {
    for (const task of store.db.prepare('SELECT * FROM tasks ORDER BY id').all()) ensureReference(store, config, 'T', task.id, { task, owner: task.owner_key, at: task.created_at });
    const desktop = new Map();
    for (const row of store.db.prepare('SELECT * FROM desktop_task_refs ORDER BY notice_number').all()) desktop.set(desktopEntity(row.thread_id, row.turn_id), row);
    for (const row of store.db.prepare('SELECT * FROM desktop_completions ORDER BY COALESCE(notice_number,completed_at)').all()) {
      const key = desktopEntity(row.thread_id, row.turn_id); if (!desktop.has(key)) desktop.set(key, row);
    }
    for (const [entity, row] of desktop) {
      const owner = row.owner_key || store.get('owner'); if (!owner) continue;
      ensureReference(store, config, 'D', entity, { owner, threadId: row.thread_id, at: row.completed_at });
    }
    for (const row of store.db.prepare('SELECT * FROM desktop_approvals ORDER BY id').all()) {
      const task = store.db.prepare("SELECT * FROM tasks WHERE owner_key=? AND thread_id=? AND desktop_turn_id=? AND execution_backend='desktop' ORDER BY id DESC LIMIT 1").get(row.owner_key, row.thread_id, row.turn_id);
      ensureReference(store, config, 'A', row.id, { owner: row.owner_key, task, threadId: row.thread_id, at: row.created_at });
    }
    store.set('projectNumberingVersion', 1);
  });
}
