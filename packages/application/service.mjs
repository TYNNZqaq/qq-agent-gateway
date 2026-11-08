import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { route } from './router.mjs';
import { deliverOne } from './delivery.mjs';
import { draftState, retryChatBatch } from './chat-batcher.mjs';
import { memoryState } from './memory-store.mjs';

export function serviceLock(stateDir) {
  const lock = new DatabaseSync(path.join(stateDir, 'service-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS mutex (id INTEGER); BEGIN IMMEDIATE');
  } catch {
    lock.close(); throw new Error('已有服务正在运行，或服务锁无法获取。');
  }
  // SQLite owns the OS file lock and releases it on process termination.
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}

export class Service {
  constructor(store, config, runner, transport, chatRunner = null) { Object.assign(this, { store, config, runner, transport, chatRunner }); store.configureChat(config); this.active = null; this.working = false; this.sending = false; this.chatActive = null; this.chatWorking = false; }
  receive(event) {
    if (this.stopped) return { ignored: true, reason: 'service_stopped' };
    const result = route(this.store, this.config, event);
    if (result.cancelId && this.active?.task.id === result.cancelId) this.active.controller.abort();
    if (this.chatActive && draftState(this.store, this.chatActive.turn) !== 'current') this.chatActive.controller.abort();
    return result;
  }
  async runOnce() {
    if (this.stopped || this.working || this.config.executor.enabled !== true) return false;
    this.working = true;
    try {
      const task = this.store.nextTask(); if (!task) return false;
      const controller = new AbortController(); this.active = { task, controller };
      let result;
      try { result = await this.runner.run(task, { signal: controller.signal, previous: task.parent_id ? this.store.task(task.parent_id) : null, onProgress: stage => this.store.progress(task.id, stage) }); }
      catch { result = { status: 'failed', summary: '执行器异常，详请在本机检查。' }; }
      if (controller.signal.aborted && task.execution_backend === 'app-server' && !['cancelled','succeeded','failed','unknown'].includes(result.status)) result = { status: 'unknown', summary: '取消请求已发出，原任务终态待核对。' };
      if (!result.deferred) this.store.finish(task.id, result.status, result.summary, result.error || null, result.threadId || null);
      return true;
    } finally { this.active = null; this.working = false; }
  }
  async sendOnce(now = Date.now()) {
    if (this.stopped || this.sending) return null;
    this.sending = true;
    try { return await deliverOne(this.store, this.config, this.transport, now); }
    finally { this.sending = false; }
  }
  async runChatOnce(now = Date.now()) {
    if (this.stopped || this.chatWorking || !this.chatRunner) return false;
    this.chatWorking = true;
    try {
      let turn = this.store.nextChatTurn(now); if (!turn) return false;
      if (this.config.policyVersion >= 2 && turn.owner_key !== this.store.get('owner')) { this.store.db.prepare("UPDATE chat_turns SET status='held' WHERE id=?").run(turn.id); return false; }
      let generationMs = 0;
      for (;;) {
        const controller = new AbortController(); this.chatActive = { turn, controller };
        const began = performance.now(); let result;
        try { result = await this.chatRunner.run(turn, { signal: controller.signal, context: this.store.chatContext(turn, now) }); }
        catch (error) { result = { status: 'failed', summary: '聊天执行器异常。', error: error.message === 'CHAT_CONTEXT_TOO_LARGE' ? error.message : 'CHAT_EXECUTOR_ERROR' }; }
        generationMs += performance.now() - began;
        const state = draftState(this.store, turn);
        if (state === 'cancelled') break;
        if (state === 'stale') {
          const retry = retryChatBatch(this.store, turn);
          if (retry) { turn = retry; continue; }
          // A continuous stream of corrections cannot cause unbounded model calls or release a known-stale answer.
          turn = this.store.db.prepare('SELECT * FROM chat_turns WHERE id=?').get(turn.id);
          this.store.db.prepare('UPDATE chat_turns SET memory_revision=? WHERE id=?').run(memoryState(this.store, turn.owner_key).revision, turn.id);
          result = { status: 'succeeded', reply_text: '好，按你最后这句来。' };
        } else if (controller.signal.aborted) result = { status: 'interrupted' };
        this.store.db.prepare("UPDATE chat_turns SET timings=json_set(timings,'$.generation_ms',?) WHERE id=?").run(Number(generationMs.toFixed(3)), turn.id);
        this.store.finishChat(turn.id, result);
        break;
      }
      return true;
    } finally { this.chatActive = null; this.chatWorking = false; }
  }
}
