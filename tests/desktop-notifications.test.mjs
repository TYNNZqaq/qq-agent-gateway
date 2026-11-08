import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../packages/application/store.mjs';
import { DesktopNotifications } from '../packages/application/desktop-notifications.mjs';
import { NativeDesktopReader, DESKTOP_PROTOCOL_VERSION } from '../packages/host-control/native-desktop-reader.mjs';
import { deliverOne, SendError } from '../packages/application/delivery.mjs';
import { recordDesktopNotify } from '../packages/application/desktop-notify.mjs';

function fixture() {
  const root = mkdtempSync(path.join(process.env.QQ_TEST_ROOT, 'desktop-notice-')), home = path.join(root, 'desktop'), project = path.join(root, 'project'), stateDir = path.join(root, 'business');
  for (const dir of [home, path.join(home, 'sessions'), project, stateDir]) mkdirSync(dir, { recursive: true });
  const thread = randomUUID(), turn = randomUUID(), now = Date.now(), file = path.join(home, 'sessions', 'rollout-synthetic-' + thread + '.jsonl');
  const config = { instanceId: randomUUID(), hostId: randomUUID(), stateDir, binding: { botId: randomUUID(), agentId: randomUUID(), bindingId: randomUUID(), bindingVersion: 1 }, qq: { appId: '12345', minimumSendIntervalMs: 0, passiveWindowSeconds: 1, maxPassiveReplies: 4, allowProactive: true }, desktopNotifications: { enabled: true, home, since: now - 10000, projects: [{ id: 'authorized-project', label: '合成项目', path: project }] } };
  const meta = { type: 'session_meta', payload: { id: thread, source: 'vscode', originator: 'Codex Desktop', cwd: project, cli_version: DESKTOP_PROTOCOL_VERSION } };
  writeFileSync(file, JSON.stringify(meta) + '\n');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,source TEXT,originator TEXT,cwd TEXT,cli_version TEXT,title TEXT,updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(thread, file, 'vscode', 'Codex Desktop', project, DESKTOP_PROTOCOL_VERSION, 'Synthetic desktop task', Math.floor(now / 1000)); db.close();
  let store = new Store(stateDir, { numberingConfig: config });
  const owner = JSON.stringify(['12345', 'c2c', 'paired-person']); store.set('owner', owner);
  store.ingest({ appId: '12345', scope: 'c2c', sender: 'paired-person', target: 'paired-person', id: 'real-shaped-synthetic-inbox', sentAt: now }, () => ({}));
  writeFileSync(path.join(stateDir, 'config.local.json'), JSON.stringify(config));
  const event = (type, values = {}) => ({ timestamp: new Date(now + (type === 'task_started' ? -1000 : 0)).toISOString(), type: 'event_msg', payload: { type, turn_id: turn, root_turn_id: turn, ...values } });
  const append = value => appendFileSync(file, JSON.stringify(value) + '\n');
  const complete = (text = 'synthetic desktop final') => { append(event('task_started')); append(event('task_complete', { last_agent_message: text })); };
  return { root, home, project, stateDir, file, thread, turn, now, owner, config, meta, event, append, complete, get store() { return store; }, observer: () => new DesktopNotifications(store, config), reopen() { store.close(); store = new Store(stateDir, { numberingConfig: config }); }, close() { store.close(); } };
}
test('true desktop terminal creates one durable proactive notice with exact source evidence and a platform receipt', async () => {
  const f = fixture(); try { f.complete(); const observer = f.observer(); observer.refresh(); observer.refresh();
    const rows = f.store.db.prepare('SELECT * FROM desktop_observations').all(); assert.equal(rows.length, 1); assert.equal(rows[0].thread_id, f.thread); assert.equal(rows[0].turn_id, f.turn); assert.equal(JSON.parse(rows[0].evidence).protocol, DESKTOP_PROTOCOL_VERSION);
    const sent = []; assert.equal((await deliverOne(f.store, f.config, { send: async m => { sent.push(m); return { id: 'synthetic-platform-receipt' }; } })).status, 'sent');
    assert.equal(sent.length, 1); assert.equal(sent[0].target, 'paired-person'); assert.equal(sent[0].msgId, undefined); assert.match(sent[0].content, /【桌面 Codex】合成项目 D1/); assert.equal(observer.snapshot().recent[0].receipt, 'synthetic-platform-receipt');
  } finally { f.close(); }
});
test('desktop observation and queued notice recover after restart without creating or sending duplicates', async () => {
  const f = fixture(); try { f.complete(); f.observer().refresh(); f.reopen(); f.store.recover(); f.observer().refresh(); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1);
    let calls = 0; await deliverOne(f.store, f.config, { send: async () => { calls++; return { id: 'synthetic-recovered-receipt' }; } }); f.reopen(); f.store.recover(); f.observer().refresh(); await deliverOne(f.store, f.config, { send: async () => { calls++; return { id: 'must-not-send' }; } }); assert.equal(calls, 1);
  } finally { f.close(); }
});
test('a partial native record is retained until its newline arrives and never advances the durable cursor early', () => {
  const f = fixture(); try { f.append(f.event('task_started')); const line = JSON.stringify(f.event('task_complete', { last_agent_message: '完整最终答复' })); appendFileSync(f.file, line.slice(0, -2)); const o = f.observer(); o.refresh(); assert.equal(f.store.outbox().length, 0); appendFileSync(f.file, line.slice(-2) + '\n'); o.refresh(); assert.equal(f.store.outbox().length, 1); o.refresh(); assert.equal(f.store.outbox().length, 1); } finally { f.close(); }
});
test('assistant text and item completion without the exact terminal marker do not notify', () => {
  const f = fixture(); try { f.append(f.event('task_started')); f.append({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'looks completed' }] } }); f.append(f.event('item_completed')); f.observer().refresh(); assert.equal(f.store.outbox().length, 0); } finally { f.close(); }
});
test('terminal markers without a matching started turn or with a different root turn are ignored', () => {
  const f = fixture(); try { f.append(f.event('task_complete', { last_agent_message: 'unbound' })); f.append(f.event('task_started')); f.append(f.event('task_complete', { root_turn_id: randomUUID(), last_agent_message: 'wrong root' })); f.observer().refresh(); assert.equal(f.store.outbox().length, 0); } finally { f.close(); }
});
test('a native failure is reported as failure while an empty final remains explicitly unverifiable to the human', () => {
  for (const failed of [true, false]) { const f = fixture(); try { f.append(f.event('task_started')); f.append(f.event('task_complete', { last_agent_message: null, ...(failed ? { error: { message: 'synthetic failure' } } : {}) })); f.observer().refresh(); const item = f.store.outbox()[0]; assert.match(item.content, failed ? /回合失败/ : /没有可用的最终答复/); } finally { f.close(); } }
});
test('interrupted desktop turns use their exact terminal identity', () => {
  const f = fixture(); try { f.append(f.event('task_started')); f.append(f.event('turn_aborted')); f.observer().refresh(); assert.equal(f.store.db.prepare('SELECT status FROM desktop_observations').get().status, 'interrupted'); } finally { f.close(); }
});
test('QQ-owned sessions never produce a second desktop completion notice', () => {
  const f = fixture(); try { f.complete(); f.store.set('bridgeThread:' + f.thread, { owner: f.owner }); f.observer().refresh(); assert.equal(f.store.outbox().length, 0); } finally { f.close(); }
});
test('completion predating the explicit observation cutoff is not replayed', () => {
  const f = fixture(); try { f.complete(); f.config.desktopNotifications.since = f.now + 1; f.observer().refresh(); assert.equal(f.store.outbox().length, 0); } finally { f.close(); }
});
test('ungranted desktop projects and non-desktop originators remain outside notification scope', () => {
  for (const change of ['project', 'source']) { const f = fixture(); try { f.complete(); const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite')); if (change === 'project') db.prepare('UPDATE threads SET cwd=?').run(f.root); else db.prepare('UPDATE threads SET originator=?').run('qq_agent_business'); db.close(); f.observer().refresh(); assert.equal(f.store.outbox().length, 0); } finally { f.close(); } }
});
test('protocol drift remains visible without advancing or sending', () => {
  const f = fixture(); try { f.complete(); const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite')); db.prepare('UPDATE threads SET cli_version=?').run('future-unverified'); db.close(); const o = f.observer(); o.refresh(); assert.equal(o.snapshot().error, 'DESKTOP_PROTOCOL_UNVERIFIED'); assert.equal(f.store.outbox().length, 0); } finally { f.close(); }
});

test('reviewed 0.166 desktop transcripts retain exact event provenance and reject version substitution', () => {
  for (const mismatch of [false, true]) {
    const f = fixture();
    try {
      const version='0.166.0-alpha.5.1',meta={...f.meta,payload:{...f.meta.payload,cli_version:mismatch?DESKTOP_PROTOCOL_VERSION:version}};
      writeFileSync(f.file,JSON.stringify(meta)+'\n');
      const db=new DatabaseSync(path.join(f.home,'state_5.sqlite'));
      db.prepare('UPDATE threads SET cli_version=?').run(version);db.close();
      f.complete();const o=f.observer();o.refresh();
      assert.equal(f.store.outbox().length,mismatch?0:1);
      if(mismatch)assert.equal(o.snapshot().error,'DESKTOP_SOURCE_MISMATCH');
      else assert.equal(JSON.parse(f.store.db.prepare('SELECT evidence FROM desktop_observations').get().evidence).protocol,version);
    } finally { f.close(); }
  }
});
test('native metadata mismatch and transcript substitution fail closed', () => {
  for (const mode of ['mismatch', 'substitute']) { const f = fixture(); try { const o = f.observer(); if (mode === 'substitute') { f.append(f.event('task_started')); o.refresh(); } writeFileSync(f.file, JSON.stringify({ ...f.meta, payload: { ...f.meta.payload, ...(mode === 'mismatch' ? { id: randomUUID() } : { extra: 'replacement' }) } }) + '\n'); f.complete(); o.refresh(); assert.equal(f.store.outbox().length, 0); assert.ok(o.snapshot().error); } finally { f.close(); } }
});
test('the native adapter rejects transcript paths outside the session tree', () => {
  const f = fixture(); try { const outside = path.join(f.root, 'other-' + f.thread + '.jsonl'); writeFileSync(outside, readFileSync(f.file)); const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite')); db.prepare('UPDATE threads SET rollout_path=?').run(outside); db.close(); const o = f.observer(); o.refresh(); assert.equal(o.snapshot().error, 'DESKTOP_TRANSCRIPT_REFERENCE_INVALID'); } finally { f.close(); }
});
test('sender or binding revocation blocks an already queued desktop notice immediately before delivery', async () => {
  for (const change of ['owner', 'binding', 'project', 'disabled']) { const f = fixture(); try { f.complete(); f.observer().refresh(); if (change === 'owner') f.store.set('owner', JSON.stringify(['12345', 'c2c', 'another-person'])); if (change === 'binding') f.config.binding.bindingVersion++; if (change === 'project') f.config.desktopNotifications.projects[0].id = 'different-project'; if (change === 'disabled') f.config.desktopNotifications.enabled = false; let calls = 0; const r = await deliverOne(f.store, f.config, { send: async () => { calls++; return { id: 'must-not-send' }; } }); assert.equal(r.status, 'blocked'); assert.equal(calls, 0); } finally { f.close(); } }
});
test('unknown QQ receipt and crash-during-send remain unknown across recovery without automatic resend', async () => {
  for (const crash of [false, true]) { const f = fixture(); try { f.complete(); f.observer().refresh(); let calls = 0; if (crash) { f.store.db.prepare("UPDATE outbox SET status='sending'").run(); f.store.db.prepare("UPDATE outbox_parts SET status='sending'").run(); } else await deliverOne(f.store, f.config, { send: async () => { calls++; throw new SendError('SYNTHETIC_TIMEOUT', { uncertain: true }); } }); f.reopen(); f.store.recover(); f.observer().refresh(); await deliverOne(f.store, f.config, { send: async () => { calls++; return { id: 'must-not-resend' }; } }); assert.equal(calls, crash ? 0 : 1); assert.equal(f.store.outbox()[0].status, 'unknown'); } finally { f.close(); } }
});
test('long desktop results retain all paragraphs after credential masking and can split into confirmed parts', async () => {
  const f = fixture(); try { f.complete('synthetic api_key=sk-ABCDEFGHIJKLMNOPQRST\n' + '段落内容\n'.repeat(400)); const o = f.observer(); o.refresh(); const body = f.store.outbox()[0].content; assert.ok(!body.includes('sk-ABCDEFGHIJKLMNOPQRST')); assert.match(body, /已隐藏/); assert.equal((body.match(/段落内容/g) || []).length, 400); const parts = f.store.db.prepare('SELECT * FROM outbox_parts').all(); assert.ok(parts.length > 1); for (let i = 0; i < parts.length; i++) await deliverOne(f.store, f.config, { send: async () => ({ id: 'synthetic-part-' + i }) }); assert.equal(f.store.outbox()[0].status, 'sent'); assert.equal(o.snapshot().deliveries[0].status, 'sent'); } finally { f.close(); }
});
test('documented notify hints are durable and deduplicated but cannot fabricate a desktop terminal', () => {
  const f = fixture(); try { const settings = path.join(f.root, 'notify-settings.json'); writeFileSync(settings, JSON.stringify({ schemaVersion: 1, businessDirectory: f.stateDir, instanceId: f.config.instanceId, binding: f.config.binding })); const input = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': f.thread, 'turn-id': f.turn, cwd: f.project, 'last-assistant-message': 'synthetic hint only' }); assert.equal(recordDesktopNotify(settings, input, {}).recorded, true); assert.equal(recordDesktopNotify(settings, input, {}).duplicate, true); f.observer().refresh(); assert.equal(f.store.outbox().length, 0); assert.equal(recordDesktopNotify(settings, input, { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'qq_agent_business' }).recorded, false); } finally { f.close(); }
});
test('desktop observer reads the native database without changing its bytes', () => {
  const f = fixture(); try { f.complete(); const before = readFileSync(path.join(f.home, 'state_5.sqlite')); const reader = new NativeDesktopReader(f.home); reader.read(reader.list(f.config.desktopNotifications.projects)[0]); assert.deepEqual(readFileSync(path.join(f.home, 'state_5.sqlite')), before); } finally { f.close(); }
});

test('compressed desktop history preserves a raw-file cursor and never repeats a delivered terminal',()=>{
  const f=fixture();try{
    const observer=f.observer();f.append(f.event('task_started'));observer.refresh();
    f.append(f.event('task_complete',{last_agent_message:'compressed completion'}));
    const compressed=zstdCompressSync(readFileSync(f.file));writeFileSync(f.file+'.zst',compressed);unlinkSync(f.file);
    observer.refresh();observer.refresh();assert.equal(f.store.outbox().length,1);
    assert.match(f.store.outbox()[0].content,/compressed completion/);
    assert.deepEqual(readFileSync(f.file+'.zst'),compressed);assert.equal(observer.snapshot().error,null);
  }finally{f.close();}
});

test('damaged compressed history and mismatched archived identity cannot create a notification',()=>{
  for(const damaged of [true,false]){const f=fixture();try{
    f.complete();const bytes=damaged?Buffer.from('invalid archive'):zstdCompressSync(Buffer.from(JSON.stringify({...f.meta,payload:{...f.meta.payload,id:randomUUID()}})+'\n'));
    writeFileSync(f.file+'.zst',bytes);unlinkSync(f.file);const observer=f.observer();observer.refresh();
    assert.equal(f.store.outbox().length,0);assert.equal(observer.snapshot().error,damaged?'DESKTOP_ARCHIVE_INVALID':'DESKTOP_SOURCE_MISMATCH');
  }finally{f.close();}}
});
