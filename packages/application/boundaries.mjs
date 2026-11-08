import path from 'node:path';
import os from 'node:os';
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export function noLinks(value, { create = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || /^[/\\]{2}/.test(value)) throw Error('UNSAFE_PATH');
  const absolute = path.resolve(value), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    if (process.platform === 'win32' && /[:*?"<>|]|[. ]$/.test(part)) throw Error('UNSAFE_PATH');
    current = path.join(current, part);
    if (!existsSync(current)) {
      if (!create) throw Error('PATH_MISSING');
      mkdirSync(current);
    }
    if (lstatSync(current).isSymbolicLink()) throw Error('SYMLINK_FORBIDDEN');
  }
  return realpathSync.native(absolute).replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
}
export function projectBoundary(directory, code, state) {
  const project = noLinks(directory);
  if (!lstatSync(project).isDirectory() || project === path.parse(project).root) throw Error('INVALID_PROJECT');
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (const forbidden of [code, state, home]) {
    const absolute = existsSync(forbidden) ? noLinks(forbidden) : path.resolve(forbidden);
    if (inside(project, absolute) || inside(absolute, project)) throw Error('CONTROL_DIRECTORY_OVERLAP');
  }
  return project;
}
export function atomicJson(file, value) {
  noLinks(path.dirname(file), { create: true });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw Error('SYMLINK_FORBIDDEN');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function secretText(value) {
  const text = String(value || '');
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:password|passwd|pwd|app.?secret|client.?secret|access.?token|refresh.?token|api.?key|authorization|token)\s*["']?\s*[:=]\s*["']?[^\s"',;}\]]{3,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^@\s]+:[^@\s]+@|\bsk-[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b/i.test(text);
}
export function privateFilename(file) {
  const name = path.basename(file);
  return name.startsWith('.') || /(?:passw(?:or)?ds?|credentials?|secrets?|auth(?:entication)?|tokens?|id_rsa|id_ed25519)|\.(?:sqlite(?:-wal|-shm)?|db|pem|key|pfx|p12|kdbx|secret|env)$/i.test(name);
}
export function freezeQueues(store, reason = 'LOCAL_STOP') {
  return store.transaction(() => {
    store.set('egressPaused', true);
    store.set('paused', true);
    store.db.prepare("UPDATE outbox SET status='held',error=? WHERE status='pending'").run(reason);
    store.db.prepare("UPDATE outbox_parts SET status='held',error=? WHERE status='pending'").run(reason);
    store.db.prepare("UPDATE outbox SET status='unknown',error='STOP_DURING_IO' WHERE status='sending'").run();
    store.db.prepare("UPDATE outbox_parts SET status='unknown',error='STOP_DURING_IO' WHERE status='sending'").run();
  });
}
