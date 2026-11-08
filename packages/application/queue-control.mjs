export function queueSummary(store) {
  const counts = table => store.db.prepare('SELECT status,COUNT(*) count FROM ' + table + ' GROUP BY status').all();
  return { tasks: counts('tasks'), chat: counts('chat_turns'), outbox: counts('outbox'), attachments: counts('received_files'),nativeControl:counts('native_control_operations') };
}
export function resumeQueues(store) {
  return store.transaction(() => {
    const counts = {};
    for (const table of ['tasks', 'chat_turns', 'outbox', 'outbox_parts']) {
      counts[table] = store.db.prepare('UPDATE ' + table + " SET status=? WHERE status='held'").run(['tasks', 'chat_turns'].includes(table) ? 'queued' : 'pending').changes;
    }
    store.set('egressPaused', false); store.set('paused', false); return counts;
  });
}
