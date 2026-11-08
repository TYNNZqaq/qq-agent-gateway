// Only the offline maintenance path calls resetTaskList, after taking a
// consistent SQLite backup and acquiring the service's exclusive lock.
const workTables = ['file_transfers', 'file_batches', 'received_files', 'task_guidance', 'desktop_questions', 'desktop_approvals', 'desktop_task_refs', 'desktop_completions', 'number_references', 'tasks'];
const sequences = ['tasks', 'desktop_approvals', 'desktop_questions', 'task_guidance', 'received_files', 'file_transfers'];

export function currentTaskSnapshot(store, snapshot) {
  const since = store.get('taskListResetAt', 0);
  return since ? { ...snapshot, threads: (snapshot.threads || []).filter(row => row.updatedAt >= since) } : snapshot;
}

export function resetTaskList(store, at = Date.now()) {
  if (!Number.isSafeInteger(at) || at <= Math.max(0, store.get('taskListResetAt', 0))) throw Error('RESET_TIME_INVALID');
  return store.transaction(() => {
    const busy = store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','running','waiting_files')").get().n
      + store.db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE status IN ('queued','running')").get().n
      + store.db.prepare("SELECT COUNT(*) n FROM task_guidance WHERE status IN ('queued','checking','sending')").get().n
      + store.db.prepare("SELECT COUNT(*) n FROM desktop_approvals WHERE status IN ('queued','sending')").get().n
      + store.db.prepare("SELECT COUNT(*) n FROM desktop_questions WHERE status IN ('queued','sending')").get().n
      + store.db.prepare("SELECT COUNT(*) n FROM received_files WHERE status IN ('queued','downloading')").get().n
      + store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE status IN ('pending','sending')").get().n;
    if (busy) throw Error('TASK_RESET_BUSY');
    const cleared = Object.fromEntries(workTables.map(name => [name, store.db.prepare('SELECT COUNT(*) n FROM ' + name).get().n]));
    // Sent messages and chat turns keep their original rows and text. Detach
    // old work IDs and namespace dedup keys before those IDs can be reused.
    store.db.prepare('UPDATE outbox SET task_id=NULL WHERE task_id IS NOT NULL').run();
    store.db.prepare("UPDATE outbox SET notification_key=?||notification_key WHERE notification_key IS NOT NULL").run('archive:' + at + ':');
    for (const table of workTables) store.db.exec('DELETE FROM ' + table);
    if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='desktop_watch'").get()) store.db.exec('DELETE FROM desktop_watch');
    for (const table of sequences) store.db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(table);
    for (const { key, value } of store.db.prepare('SELECT key,value FROM settings').all()) {
      if (/^(selectedWorkTask:|workTaskPicker:|questionReply:)/.test(key)) store.set(key, null);
      if (key.startsWith('interaction:')) {
        const current = JSON.parse(value);
        if (current?.mode === 'codex') store.set(key, { version: 1, mode: 'codex', screen: 'menu' });
      }
    }
    store.set('desktopNoticeSequence', 0);
    store.set('desktopNotificationsStartedAt', at);
    store.set('fileDeliveryStartedAt', at);
    store.set('taskListResetAt', at);
    const snapshot = store.get('desktopSnapshot');
    if (snapshot) store.set('desktopSnapshot', currentTaskSnapshot(store, snapshot));
    if (store.db.prepare('PRAGMA foreign_key_check').all().length) throw Error('RESET_FOREIGN_KEY_FAILED');
    return { resetAt: at, cleared };
  });
}
