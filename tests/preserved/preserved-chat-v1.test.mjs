import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Store, ownerKey } from '../../packages/application/store.mjs';
import { Service } from '../../packages/application/service.mjs';
import { MockTransport, SendError } from '../../packages/application/delivery.mjs';
import { chatPreferences } from '../../packages/application/chat.mjs';
import { memoryState, saveCandidates, forgetMemories } from '../../packages/application/memory-store.mjs';
import { retrieveMemories } from '../../packages/application/memory-retrieval.mjs';
import { resolveEventDate, eventState } from '../../packages/application/memory-policy.mjs';
import { splitChatReply, chatOptions } from '../../packages/application/chat-options.mjs';
import { evaluateChatEvents } from '../../packages/application/chat-runner.mjs';
import { PROJECT_ROOT } from '../../packages/application/config.mjs';
import { DatabaseSync } from 'node:sqlite';
import { migrateChat } from '../../packages/application/chat-migration.mjs';

function fixture(t, chat = {}) {
  const directory = mkdtempSync(path.join(process.env.QQ_TEST_ROOT, 'chat-v1-test-'));
  const config = { stateDir: directory, chat: { batchInputs: false, ...chat }, fileReceive: { enabled: false }, projects: {}, executor: { enabled: true }, qq: { appId: '12345', minimumSendIntervalMs: 3200, passiveWindowSeconds: 300, maxPassiveReplies: 4, allowProactive: true } };
  const f = { store: new Store(directory), config, now: Date.parse('2026-10-22T12:00:00+08:00'), serial: 0, contexts: [], transport: new MockTransport(), calls: 0 };
  f.owner = ownerKey({ appId: '12345', scope: 'c2c', sender: 'owner' }); f.store.set('owner', f.owner);
  f.runner = { run: async (turn, { context }) => { f.calls++; f.contexts.push(context); return { status: 'succeeded', reply_text: '自然接话' + turn.id, memory_candidates: [], topic_update: null }; } };
  f.service = () => new Service(f.store, config, {}, f.transport, f.runner); f.worker = f.service();
  f.send = (content, { at = f.now, id, ...extra } = {}) => {
    const event = { appId: '12345', scope: 'c2c', sender: 'owner', target: 'owner', sentAt: at, id: id || 'v1-' + ++f.serial, content, ...extra };
    // Use Service.receive so cancellation is exercised, but use stable source time in event data.
    return f.worker.receive(event);
  };
  // Router authenticates timestamps against wall time; keep the fixture near now while date tests use explicit policy calls.
  f.now = Date.now();
  f.send('主菜单'); f.send('Codex 聊天'); f.send('开始新对话');
  f.session = () => f.store.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(chatPreferences(f.store, f.owner).sessionId);
  f.memories = () => f.store.db.prepare("SELECT * FROM chat_memories WHERE owner_key=? AND status='active'").all(f.owner);
  f.text = () => f.store.outbox().at(-1)?.content;
  f.clearMenus = () => f.store.db.prepare("UPDATE outbox SET status='sent' WHERE chat_turn_id IS NULL").run();
  f.generate = () => f.worker.runChatOnce(Date.now() + 2100);
  f.deliver = async () => { f.clearMenus(); const time = Math.max(Date.now(), f.store.get('lastSend', 0) + 4000); return f.worker.sendOnce(time); };
  f.reopen = () => { f.store.close(); f.store = new Store(directory); f.worker = f.service(); };
  t.after(() => f.store.close()); return f;
}

test('偏好有来源，跨新会话和进程重开召回，不相关问题不硬塞记忆', async t => {
  const f = fixture(t); f.send('记住我吐槽的时候先别急着给建议');
  assert.equal(f.memories().length, 1); const memory = f.memories()[0];
  const source = f.store.db.prepare('SELECT * FROM chat_memory_sources WHERE memory_id=?').get(memory.id);
  assert.match(source.excerpt, /先别急着给建议/); assert.ok(source.message_time);
  await f.generate(); await f.deliver(); f.send('开始新对话'); f.reopen();
  f.send('今天汇报又被打回来了，烦死了'); await f.generate();
  assert.ok(f.contexts.at(-1).memories.some(row => /先别急着给建议/.test(row.text)));
  f.send('开始新对话'); f.send('三角形内角和是多少？'); await f.generate();
  assert.deepEqual(f.contexts.at(-1).memories, []);
});

test('用户自己的记忆保存不依赖机器人生成或发送成功', async t => {
  const f = fixture(t); f.runner.run = async () => ({ status: 'failed', error: 'failure' });
  f.send('我不喝咖啡'); await f.generate();
  assert.equal(f.memories().length, 1); assert.match(f.memories()[0].content, /不喝咖啡/);
});

test('查看、解释来源、明确编号修订，并保留无正文的修订记录', async t => {
  const f = fixture(t); f.send('我周五答辩');
  const id = f.memories()[0].id; f.send('查看记忆'); assert.match(f.text(), /近期事情/);
  f.send(`为什么记得记忆 ${id}`); assert.match(f.text(), /你在.*说过：“我周五答辩”/);
  f.send(`修改记忆 ${id}：我周六答辩`);
  assert.match(f.text(), /改好了/); assert.equal(f.memories()[0].version, 2);
  assert.equal(f.memories()[0].content, '我周六答辩');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_memory_revisions WHERE memory_id=?').get(id).n, 2);
  f.send('开始新对话'); f.send('答辩什么时候？'); await f.generate();
  assert.match(f.contexts.at(-1).memories[0].text, /周六/); assert.doesNotMatch(JSON.stringify(f.contexts.at(-1)), /周五/);
});

test('遗忘清除内容、来源和词项，使摘要与历史上下文失效，并阻止旧任务复活', async t => {
  const f = fixture(t); f.send('我不喝咖啡');
  const row = f.memories()[0]; const source = f.store.db.prepare('SELECT * FROM chat_memory_sources WHERE memory_id=?').get(row.id);
  const oldRevision = memoryState(f.store, f.owner).revision;
  await f.generate(); await f.deliver();
  f.send('忘记我不喝咖啡这件事'); assert.match(f.text(), /已经忘掉/);
  const deleted = f.store.db.prepare('SELECT * FROM chat_memories WHERE id=?').get(row.id);
  assert.equal(deleted.content, ''); assert.equal(deleted.status, 'deleted');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_memory_terms WHERE memory_id=?').get(row.id).n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_memory_sources WHERE memory_id=?').get(row.id).n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_topics').get().n, 0);
  const stale = saveCandidates(f.store, f.owner, 'default', [{ source_message_id: source.message_id, source_quote: source.excerpt, content: source.excerpt }], { expectedRevision: oldRevision });
  assert.equal(stale.saved.length, 0);
  f.send('给我推荐一种饮料'); await f.generate();
  assert.doesNotMatch(JSON.stringify(f.contexts.at(-1)), /不喝咖啡/);
  f.send('我不喝咖啡'); assert.equal(f.memories().length, 1, 'fresh user statement can establish a new memory');
});

test('保留原聊天与显式一起删除是两个独立操作', t => {
  const f = fixture(t); f.send('我不喝咖啡'); const source = f.store.db.prepare('SELECT * FROM chat_messages ORDER BY id DESC LIMIT 1').get();
  f.send('以前记的“不喝咖啡”那条删掉吧'); assert.match(f.text(), /已经忘掉/);
  assert.equal(f.store.db.prepare('SELECT content FROM chat_messages WHERE id=?').get(source.id).content, '我不喝咖啡');
  f.send('同时删除对应聊天记录');
  assert.equal(f.store.db.prepare('SELECT content FROM chat_messages WHERE id=?').get(source.id).content, '[已由用户删除]');
});

test('暂停禁用保存和召回，恢复后生效；不带记忆的新会话仍独立', async t => {
  const f = fixture(t); f.send('我不喝咖啡'); f.send('暂停记忆'); f.send('我喜欢跑步');
  assert.equal(f.memories().length, 1); await f.generate(); assert.deepEqual(f.contexts.at(-1).memories, []);
  f.send('恢复记忆'); f.send('这次从零聊，不带以前的记忆');
  assert.equal(f.session().memory_enabled, 0); f.send('咖啡推荐？'); await f.generate(); assert.deepEqual(f.contexts.at(-1).memories, []);
  f.send('开始新对话'); assert.equal(f.session().memory_enabled, 1);
  f.send('咖啡推荐？'); await f.generate(); assert.match(f.contexts.at(-1).memories[0].text, /不喝咖啡/);
});

test('这段不要记阻止当前批次及后续提取，新会话恢复积累', t => {
  const f = fixture(t); f.send('我喜欢喝茶'); f.send('这段不要记');
  assert.equal(f.memories().length, 0); f.send('我喜欢跑步'); assert.equal(f.memories().length, 0);
  f.send('开始新对话'); f.send('我不吃香菜'); assert.equal(f.memories().length, 1);
});

test('身份、角色场景和通用偏好的范围不能由模型扩张', async t => {
  const f = fixture(t); f.send('更换人设卡'); f.send('新增自定义人设'); f.send('名称：一色彩羽\n性格：机灵');
  const persona = f.session().persona_id;
  f.send('记住彩羽以后少叫我前辈'); f.send('我不喝咖啡');
  assert.equal(f.memories().find(row => row.kind === 'persona').persona_id, persona);
  assert.equal(f.memories().find(row => /咖啡/.test(row.content)).persona_id, '');
  f.send('更换人设卡'); f.send('普通助手'); f.send('我希望怎么称呼？咖啡也可以聊'); await f.generate();
  assert.ok(f.contexts.at(-1).memories.every(row => row.scope === 'user'));
  assert.deepEqual(retrieveMemories(f.store, 'another-owner', persona, '前辈 咖啡'), []);
});

for (const text of ['如果我不喝咖啡会怎么样', '小说里我的专业是计算机', '朋友说我不喝咖啡', '他说：“我喜欢跑步”', '示例：我周五答辩', '我告诉你，他喜欢咖啡', '我是不是喜欢喝咖啡？', '我担心他周五答辩', '记住我的密码是 secret-123', '记住 api_key=sk-abcdef123456789']) {
  test('排除不可靠或密钥来源：' + text, t => { const f = fixture(t); f.send(text); assert.equal(f.memories().length, 0); });
}

test('健康和联系方式默认不提取，明确授权才保存', t => {
  const f = fixture(t); f.send('我对花生过敏'); assert.equal(f.memories().length, 0);
  f.send('记住我对花生过敏'); assert.equal(f.memories().length, 1);
});

test('模型不能伪造来源、使用其他批次或把近似改写当事实', async t => {
  const f = fixture(t); f.send('今天风很大'); const sourceId = f.store.db.prepare('SELECT MAX(id) id FROM chat_messages').get().id;
  f.runner.run = async () => ({ status: 'succeeded', reply_text: '风确实很大。', memory_candidates: [
    { source_message_id: sourceId, source_quote: '我喜欢咖啡', content: '我喜欢咖啡' },
    { source_message_id: sourceId + 100, source_quote: '今天风很大', content: '我学气象' },
    { source_message_id: sourceId, source_quote: '今天风很大', content: '我喜欢大风天' }
  ] });
  await f.generate(); assert.equal(f.memories().length, 0);
});

test('相对日期固定在来源的上海日期，计划、完成、取消和过期有区别', t => {
  assert.equal(resolveEventDate('明天答辩', Date.parse('2026-10-22T23:59:00+08:00')), '2026-10-23');
  assert.equal(resolveEventDate('下周一旅行', Date.parse('2026-10-22T08:00:00+08:00')), '2026-10-26');
  assert.equal(resolveEventDate('我周五答辩', Date.parse('2026-10-22T08:00:00+08:00')), '2026-10-23');
  assert.equal(resolveEventDate('2026-02-30答辩', Date.now()), null);
  assert.equal(eventState('目录还没改完'), 'planned'); assert.equal(eventState('目录已经改完了'), 'completed'); assert.equal(eventState('旅行取消了'), 'cancelled');
  const f = fixture(t); f.send('我今天答辩'); const row = f.memories()[0];
  assert.equal(retrieveMemories(f.store, f.owner, 'default', '答辩', { now: row.expires_at + 1 }).length, 0);
});

test('临时偏好不销毁稳定偏好', t => {
  const f = fixture(t); f.send('我喜欢喝咖啡'); f.send('我最近不喝咖啡');
  assert.equal(f.memories().length, 2); assert.ok(f.memories().some(row => row.expires_at === null)); assert.ok(f.memories().some(row => row.expires_at !== null));
});

test('用户主动接续昨天未确认的计划时可以召回，但不把过期计划继续当作待办', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T12:00:00+08:00') });
  const f = fixture(t); f.send('我今晚先把目录理好', { at: Date.now() - 23 * 3600000 });
  f.send('开始新对话'); f.send('我们接着弄昨天那个吧，还没弄完'); await f.generate();
  const memory = f.contexts.at(-1).memories.find(row => /目录/.test(row.text)); assert.ok(memory); assert.equal(memory.state, 'past_unconfirmed');
});

test('无法解析的相对时间保留原文，不自行变成完成事件', t => {
  const f = fixture(t); f.send('我下周准备去旅行');
  assert.equal(f.memories()[0].event_date, null); assert.equal(f.memories()[0].event_status, 'planned'); assert.match(f.memories()[0].content, /下周准备/);
});

test('三条连发静默后只生成一次，全部输入和最终限制都进入同一批', async t => {
  const f = fixture(t, { batchInputs: true });
  f.send('今天不想改论文'); f.send('不是不会改，就是累'); f.send('你别给我排计划啊');
  assert.equal(await f.worker.runChatOnce(), false); await f.generate();
  assert.equal(f.calls, 1); assert.match(f.contexts[0].messages.at(-1).content, /今天不想改论文\n不是不会改，就是累\n你别给我排计划啊/);
  assert.equal(f.store.outbox().filter(row => row.kind === 'chat').length, 1);
});

test('生成中改口取消旧草稿，最多重算一次，并使用最后表达', async t => {
  const f = fixture(t, { batchInputs: true }); let release, began;
  const ready = new Promise(resolve => { began = resolve; }); let calls = 0;
  f.runner.run = async (_turn, { signal, context }) => {
    f.contexts.push(context); calls++;
    if (calls === 1) return new Promise(resolve => { release = resolve; began(); signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }); });
    return { status: 'succeeded', reply_text: '好，那就周六。' };
  };
  f.send('我周五答辩'); const run = f.generate(); await ready;
  f.send('不对，答辩改到周六了'); release({ status: 'succeeded', reply_text: '周五加油！' }); await run;
  assert.equal(calls, 2); assert.match(f.contexts.at(-1).messages.at(-1).content, /周六/);
  assert.deepEqual(f.store.outbox().filter(row => row.kind === 'chat').map(row => row.content), ['好，那就周六。']);
});

test('重算期间再次改口不产生第三次调用，也不发送已知冲突的旧正文', async t => {
  const f = fixture(t, { batchInputs: true }); let calls = 0;
  f.runner.run = async () => { calls++; f.send(calls === 1 ? '不对，改到周六' : '等一下，其实改到周日'); return { status: 'succeeded', reply_text: '周五答辩加油。' }; };
  f.send('我周五答辩'); await f.generate(); assert.equal(calls, 2);
  assert.equal(f.store.outbox().filter(row => row.kind === 'chat').at(-1).content, '好，按你最后这句来。');
});

test('生成期间的新会话取消旧轮次且不补发旧正文', async t => {
  const f = fixture(t); let done, began; const ready = new Promise(resolve => { began = resolve; });
  f.runner.run = () => new Promise(resolve => { done = resolve; began(); });
  f.send('老话题'); const run = f.generate(); await ready; f.send('开始新对话'); done({ status: 'succeeded', reply_text: '过期正文' }); await run;
  assert.equal(f.store.outbox().filter(row => row.kind === 'chat').length, 0);
});

test('发送前改口废弃旧 outbox，重复事件不重复生成或入队', async t => {
  const f = fixture(t, { batchInputs: true }); f.send('帮我选蓝色'); await f.generate();
  const previous = f.store.outbox().find(row => row.kind === 'chat');
  f.send('不对，改成红色', { id: 'correction-once' }); f.send('不对，改成红色', { id: 'correction-once' });
  assert.equal(f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(previous.id).status, 'cancelled');
  await f.generate(); await f.deliver();
  assert.equal(f.transport.messages.length, 1); assert.equal(f.calls, 2);
});

test('遗忘可阻止已经生成的旧正文出站', async t => {
  const f = fixture(t); f.send('我不喝咖啡'); f.runner.run = async () => ({ status: 'succeeded', reply_text: '你不喝咖啡，那就喝茶吧。' });
  await f.generate(); const id = f.memories()[0].id; f.send(`忘记记忆 ${id}`); await f.deliver();
  assert.ok(f.transport.messages.every(row => !/不喝咖啡/.test(row.content)));
});

test('只有发送成功正文进入历史；未知不重发，用户未获答复仍保留', async t => {
  const f = fixture(t); f.send('第一句'); await f.generate();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_deliveries').get().n, 0);
  f.transport.send = async () => { throw new SendError('UNKNOWN', { uncertain: true }); }; await f.deliver();
  f.send('第二句'); await f.generate();
  const contents = f.contexts.at(-1).messages.map(row => row.content);
  assert.ok(contents.includes('第一句')); assert.ok(contents.includes('第二句')); assert.ok(contents.every(row => !row.startsWith('自然接话')));
  f.reopen(); f.store.recover(); assert.equal(f.store.outbox().find(row => row.kind === 'chat').status, 'unknown');
});

test('长回复按完整句子分段，部分确认只召回实际送出部分，间隔仍受控', async t => {
  const f = fixture(t, { partChars: 200 }); const body = ('第一部分说明。'.repeat(20)) + ('第二部分说明。'.repeat(20));
  f.runner.run = async (_turn, { context }) => { f.contexts.push(context); return { status: 'succeeded', reply_text: body }; }; f.send('详细说说'); await f.generate(); await f.deliver();
  const delivered = f.store.db.prepare('SELECT * FROM chat_deliveries').all(); assert.equal(delivered.length, 1); assert.notEqual(delivered[0].content, body);
  assert.equal(await f.worker.sendOnce(f.store.get('lastSend') + 100), null);
  f.transport.send = async () => { throw new SendError('UNKNOWN', { uncertain: true }); }; await f.deliver();
  f.send('刚才说到哪了'); await f.generate();
  const replies = f.contexts.at(-1).messages.filter(row => row.role === 'assistant');
  assert.deepEqual(replies.map(row => row.content), [delivered[0].content]);
});

test('Unicode 和完整后缀不被截断，超限明确失败而不是悄悄丢字', () => {
  const body = '🌸你好。'.repeat(100); const parts = splitChatReply(body, chatOptions({ chat: { partChars: 200 } }));
  assert.equal(parts.join(''), body); assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
  assert.throws(() => splitChatReply('字'.repeat(3401), chatOptions()), /TOO_LONG/);
  assert.throws(() => splitChatReply(' ', chatOptions()), /EMPTY/);
});

test('未知发送在重启后既不重发也不重新生成', async t => {
  const f = fixture(t); let sent = 0; f.transport.send = async () => { sent++; throw new SendError('UNKNOWN', { uncertain: true }); };
  f.send('一次就好'); await f.generate(); await f.deliver(); f.reopen(); f.store.recover();
  assert.equal(await f.worker.runChatOnce(), false); assert.equal(await f.worker.sendOnce(Date.now() + 10000), null);
  assert.equal(sent, 1); assert.equal(f.calls, 1);
});

test('模型自述与助手来源不能建立用户或关系记忆', t => {
  const f = fixture(t); const session = f.session();
  const row = f.store.db.prepare("INSERT INTO chat_messages(session_id,role,content,created_at,delivery_status) VALUES (?,'assistant','我答应每天提醒你',?,'generated')").run(session.id, Date.now());
  const result = saveCandidates(f.store, f.owner, session.persona_id, [{ source_message_id: Number(row.lastInsertRowid), source_quote: '我答应每天提醒你', content: '我答应每天提醒你' }]);
  assert.equal(result.saved.length, 0); assert.equal(f.memories().length, 0);
});

test('批次有消息数上限，持续输入不会形成无界上下文', t => {
  const f = fixture(t, { batchInputs: true, batchMessages: 3 });
  for (const text of ['甲', '乙', '丙', '丁', '戊']) f.send(text);
  const batches = f.store.db.prepare('SELECT batch_id,COUNT(*) n FROM chat_turns GROUP BY batch_id').all();
  assert.equal(batches.length, 2); assert.ok(batches.every(row => row.n <= 3));
});

test('迁移异常时回滚新增字段和表，保留迁移前快照', t => {
  const directory = mkdtempSync(path.join(process.env.QQ_TEST_ROOT, 'chat-migration-failure-'));
  const db = new DatabaseSync(path.join(directory, 'state.sqlite'));
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE chat_sessions(id TEXT PRIMARY KEY,owner_key TEXT);
    CREATE TABLE chat_messages(id INTEGER PRIMARY KEY); CREATE TABLE chat_turns(id INTEGER PRIMARY KEY);
    CREATE TABLE outbox(id INTEGER PRIMARY KEY); CREATE TABLE outbox_parts(id INTEGER PRIMARY KEY);`);
  const fake = { db, directory, get: Store.prototype.get, set: Store.prototype.set, transaction: Store.prototype.transaction };
  assert.throws(() => migrateChat(fake, { backup: true }));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='chat_memories'").get(), undefined);
  assert.ok(db.prepare('PRAGMA table_info(chat_sessions)').all().every(row => row.name !== 'input_version'));
  assert.equal(fake.get('chatSchemaVersion'), null); db.close();
  // A failed migration does not depend on an in-place reverse migration to recover the old database.
  assert.ok(existsSync(path.join(directory, 'backups')));
});

test('话题摘要只保留有来源的原话，不能把计划写成完成，遗忘使摘要失效', async t => {
  const f = fixture(t, { summaryAfter: 4 });
  for (const text of ['我今晚先把目录理好', '现在还没有改完', '章节先留着', '我还想接着看看目录']) { f.send(text); await f.generate(); await f.deliver(); }
  const summary = f.store.db.prepare('SELECT * FROM chat_summaries').get(); assert.ok(summary); assert.match(summary.content, /还没有改完/);
  f.send('忘记所有记忆'); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_summaries').get().n, 0);
});

test('历史导入是限范围的预览确认入口，不扫描工作记录，也不恢复遗忘来源', t => {
  const f = fixture(t, { memoryWrite: false }); f.send('我喜欢跑步'); assert.equal(f.memories().length, 0);
  f.config.chat.memoryWrite = true; f.send('预览历史记忆 最近7天'); assert.match(f.text(), /仅预览/);
  assert.equal(f.memories().length, 0); const id = f.text().match(/确认导入记忆 ([a-f0-9]{6})/)[1]; f.send('确认导入记忆 ' + id);
  assert.equal(f.memories().length, 1); f.send('忘记我喜欢跑步'); f.send('预览历史记忆 最近7天'); assert.match(f.text(), /没有可导入/);
});

test('独立开关禁用记忆读写、摘要及合并，不改变工作权限', async t => {
  const f = fixture(t, { memoryRead: false, memoryWrite: false, topicState: false, batchInputs: false });
  f.send('我不喝咖啡'); f.send('第二句'); await f.generate();
  assert.equal(f.memories().length, 0); assert.deepEqual(f.contexts[0].memories, []); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_topics').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE status='queued'").get().n, 1); assert.equal(f.store.tasks(f.owner).length, 0);
});

test('结构化结果校验拒绝旧格式、空正文和损坏结果，不沿用工作执行器的截断', () => {
  const events = output => [{ type: 'thread.started', thread_id: 'test' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed' }];
  assert.equal(evaluateChatEvents(events({ outcome: 'completed', summary: '旧格式' }), 0).status, 'failed');
  assert.equal(evaluateChatEvents(events({ outcome: 'completed', reply_text: ' ', memory_candidates: [], topic_update: null }), 0).status, 'failed');
  const reply = '字'.repeat(1200); assert.equal(evaluateChatEvents(events({ outcome: 'completed', reply_text: reply, memory_candidates: [], topic_update: null }), 0).reply_text, reply);
});
