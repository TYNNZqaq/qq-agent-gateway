import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Store, ownerKey } from '../../packages/application/store.mjs';
import { route } from '../../packages/application/router.mjs';
import { PROJECT_ROOT } from '../../packages/application/config.mjs';
import { interaction } from '../../packages/application/menus.mjs';
import { chatPreferences, currentPersona, personas } from '../../packages/application/chat.mjs';
import { Service } from '../../packages/application/service.mjs';
import { MockTransport } from '../../packages/application/delivery.mjs';

const work = process.env.QQ_TEST_ROOT;
mkdirSync(work, { recursive: true });
function fixture(t, { selected = true } = {}) {
  const stateDir = mkdtempSync(path.join(work, 'qq-modes-'));
  const config = { stateDir, qq: { appId: '12345', passiveWindowSeconds: 300, maxPassiveReplies: 4, minimumSendIntervalMs: 3200, allowProactive: true }, executor: { enabled: true, dailyTaskLimit: 20, maxQueuedTasks: 10 }, projects: { demo: { path: path.join(PROJECT_ROOT, 'demo-workspace'), label: '演示项目' }, other: { path: stateDir, label: '另一项目' } } };
  const f = { config, store: new Store(stateDir), serial: 0 };
  f.event = (content, id = 'message-' + ++f.serial, extra = {}) => ({ appId: '12345', scope: 'c2c', sender: 'owner', target: 'owner', sentAt: Date.now(), id, content, ...extra });
  f.owner = ownerKey(f.event(''));
  f.store.set('owner', f.owner);
  if (selected) f.store.set('selectedProject:' + f.owner, 'demo');
  f.send = (text, id) => route(f.store, config, f.event(text, id));
  f.text = () => f.store.outbox().at(-1).content;
  f.tasks = () => f.store.tasks(f.owner, 100);
  f.messages = () => f.store.db.prepare('SELECT * FROM chat_messages ORDER BY id').all();
  f.sessions = () => f.store.db.prepare('SELECT * FROM chat_sessions ORDER BY created_at,rowid').all();
  f.reopen = () => { f.store.close(); f.store = new Store(stateDir); };
  f.codex = () => { f.send('主菜单'); f.send('Codex 工作'); };
  f.chat = () => { f.send('主菜单'); f.send('Codex 聊天'); };
  f.newPersona = (name, body = '身份背景：星际领航员\n性格：沉稳\n说话方式：简洁\n互动关系：同行伙伴') => { f.send('更换人设卡'); f.send('新增自定义人设'); f.send(`名称：${name}\n${body}`); };
  t.after(() => f.store.close());
  return f;
}

test('已有本人首次看到逐行主菜单，项目选择及历史任务不被重置', t => {
  const f = fixture(t);
  f.send('菜单');
  assert.match(f.text(), /^当前模式：主菜单\n1．Codex 聊天\n2．Codex 工作\n/);
  assert.equal(f.store.get('selectedProject:' + f.owner), 'demo');
  assert.equal(f.tasks().length, 0);
  f.send('新任务 demo：主菜单不能接单');
  assert.equal(f.tasks().length, 0);
  assert.match(f.text(), /主菜单/);
});

test('编号与选项名称都能进入两级菜单，每个选项独占一行', t => {
  const f = fixture(t);
  f.send('1');
  assert.match(f.text(), /当前人设：普通助手/);
  assert.deepEqual(f.text().split('\n').filter(line => /^\d+．/.test(line)), ['1．开始新对话', '2．更换人设卡', '0．返回上一级']);
  f.send('0'); f.send('2');
  const lines = f.text().split('\n').filter(line => /^\d+．/.test(line));
  assert.deepEqual(lines, ['1．项目管理', '2．任务管理', '3．文件与图片', '4．审批与问答', '5．模型与推理设置', '6．接单设置', '0．返回上一级']);
  assert.match(f.text(), /当前项目：演示项目（只读）/);
  f.send('返回上一级'); f.send('ChatGPT 聊天'); assert.equal(interaction(f.store, f.owner).mode, 'chatgpt');
  f.send('主菜单'); f.send('Codex 工作'); assert.equal(interaction(f.store, f.owner).mode, 'codex');
  assert.equal(f.tasks().length, 0);
});

test('工作菜单六类入口浏览不创建任务，原文字指令仍收集参数', t => {
  const f = fixture(t); f.codex();
  for (let option = 1; option <= 6; option++) {
    f.send('菜单'); f.send(String(option));
    assert.equal(f.tasks().length, 0, 'option ' + option);
    assert.notEqual(interaction(f.store, f.owner).screen, 'prompt');
  }
  assert.equal(f.store.get('paused', false), false);
  f.send('菜单'); f.send('选择项目'); f.send('2');
  assert.equal(f.store.get('selectedProject:' + f.owner), 'other');
  assert.equal(f.tasks().length, 0);
});

test('新建任务分步收集要求，数字在要求输入状态按正文处理，重复投递只建一次', t => {
  const f = fixture(t); f.codex();
  f.send('任务管理'); f.send('1'); assert.equal(f.tasks().length, 0);
  const event = f.event('1', 'numeric-requirement');
  const first = route(f.store, f.config, event);
  assert.equal(first.task.prompt, '1'); assert.equal(first.task.project, 'demo');
  assert.equal(route(f.store, f.config, event).duplicate, true);
  assert.equal(f.tasks().length, 1);
  assert.match(f.text(), /只读执行/);
});

test('未选择项目时，新建任务先收集项目再收集要求', t => {
  const f = fixture(t, { selected: false }); f.codex();
  f.send('新建任务'); assert.equal(f.tasks().length, 0);
  f.send('1'); assert.equal(f.tasks().length, 0); assert.match(f.text(), /请在下一条消息输入具体任务要求/);
  f.send('分析当前说明'); assert.equal(f.tasks().length, 1); assert.equal(f.tasks()[0].project, 'demo');
});

test('查询状态与结果的参数菜单保留 needs_input，不将已有任务改写完成', t => {
  const f = fixture(t); f.codex();
  for (let index = 1; index <= 5; index++) {
    f.send('新任务 demo：分析'); f.store.nextTask();
    f.store.finish(index, index === 5 ? 'needs_input' : 'succeeded', '需要补充当前资料', null, 'saved-thread');
  }
  const before = f.store.task(5);
  for (const option of ['查询任务状态', '查看任务结果']) {
    f.send(option); assert.match(f.text(), /输入完整任务编号/);
    f.send('T000005'); assert.match(f.text(), /演示项目 T5 等待补充/);
    assert.deepEqual(f.store.task(5), before);
  }
});

test('继续任务分两步输入，始终绑定原任务项目与明确会话', t => {
  const f = fixture(t); f.codex(); f.send('新任务 demo：分析'); f.store.nextTask();
  f.store.finish(1, 'needs_input', '需要补充', null, 'fixed-thread');
  f.send('选择项目 另一项目'); f.send('继续任务'); f.send('T000001');
  assert.equal(f.tasks().length, 1); assert.match(f.text(), /补充要求/);
  f.send('2');
  const child = f.store.task(2);
  assert.equal(child.prompt, '2'); assert.equal(child.parent_id, 1); assert.equal(child.thread_id, 'fixed-thread'); assert.equal(child.project, 'demo');
  assert.equal(f.store.task(1).status, 'needs_input');
});

test('取消与补发菜单只有收到有效本人任务编号后才操作', t => {
  const f = fixture(t); f.codex(); f.send('新任务 demo：分析');
  f.send('取消任务'); assert.equal(f.store.task(1).status, 'queued');
  f.send('T999999'); assert.equal(f.store.task(1).status, 'queued');
  f.send('T000001'); assert.equal(f.store.task(1).status, 'cancelled');
  f.store.db.prepare("UPDATE outbox SET status='blocked' WHERE kind='final'").run();
  f.send('补发通知'); assert.equal(f.store.outbox().find(item => item.kind === 'final').status, 'blocked');
  f.send('T000001'); assert.equal(f.store.outbox().find(item => item.kind === 'final').status, 'pending');
  assert.equal(f.tasks().length, 1);
});

test('菜单、主菜单与返回操作清除未提交参数，切换后不会意外创建任务', t => {
  const f = fixture(t); f.codex(); f.send('新建任务'); f.send('菜单');
  assert.equal(interaction(f.store, f.owner).screen, 'menu');
  f.send('0'); assert.equal(interaction(f.store, f.owner).mode, 'main');
  f.send('1'); f.send('2'); f.send('新增自定义人设'); f.send('返回上一级');
  assert.equal(interaction(f.store, f.owner).mode, 'main'); assert.equal(personas(f.store, f.owner).length, 1);
  f.send('Codex 工作'); f.send('查询任务状态'); f.send('主菜单'); f.send('2'); f.send('T000001');
  assert.equal(f.tasks().length, 0); assert.equal(interaction(f.store, f.owner).screen, 'menu');
});

test('Codex 聊天仅进入独立聊天队列，数字与工作指令不会创建工作任务', async t => {
  const f = fixture(t); let calls = 0;
  const service = new Service(f.store, f.config, { run: async () => { calls++; throw new Error('must not run'); } }, new MockTransport());
  f.chat(); f.send('开始新对话');
  const repliesBeforeChat = f.store.outbox().length;
  for (const content of ['0', '1', '2', '6', '14', '新任务 demo：分析', '继续 T000001：工作', '取消 T000001', '项目列表', '停止接单']) {
    const result = f.send(content); assert.ok(result.chatTurn); assert.equal(f.store.outbox().length, repliesBeforeChat);
  }
  assert.equal(await service.runOnce(), false); assert.equal(calls, 0);
  assert.equal(f.tasks().length, 0); assert.equal(f.store.get('paused', false), false);
  assert.equal(f.messages().length, 10); assert.ok(f.messages().every(item => item.role === 'user' && item.delivery_status === 'queued'));
  assert.deepEqual(f.messages().slice(0, 5).map(item => item.content), ['0', '1', '2', '6', '14']);
  assert.equal(interaction(f.store, f.owner).screen, 'conversation');
});

test('聊天、人设和聊天菜单路由不访问项目配置或执行器配置', t => {
  const f = fixture(t);
  Object.defineProperty(f.config, 'projects', { get() { throw new Error('project access in chat'); } });
  Object.defineProperty(f.config, 'executor', { get() { throw new Error('executor access in chat'); } });
  f.chat(); f.send('1'); f.send('新任务 demo：不能执行'); f.send('2');
  f.send('菜单'); f.newPersona('星遥'); f.send('0'); f.send('菜单');
  assert.equal(f.tasks().length, 0); assert.deepEqual(f.messages().map(item => item.content), ['新任务 demo：不能执行', '2', '0']);
});

test('自定义人设保存完整字段，自动开始独立新对话，并可切换已保存人设', t => {
  const f = fixture(t); f.chat(); f.newPersona('星遥');
  const card = currentPersona(f.store, f.owner);
  assert.equal(card.name, '星遥'); assert.equal(card.background, '星际领航员'); assert.equal(card.personality, '沉稳'); assert.equal(card.speech, '简洁'); assert.equal(card.relationship, '同行伙伴');
  const first = chatPreferences(f.store, f.owner).sessionId;
  f.send('你好'); f.send('更换人设卡'); f.send('普通助手');
  assert.equal(currentPersona(f.store, f.owner).id, 'default'); assert.match(f.text(), /当前人设：普通助手/);
  f.send('更换人设卡'); f.send('星遥');
  assert.equal(currentPersona(f.store, f.owner).name, '星遥'); assert.notEqual(chatPreferences(f.store, f.owner).sessionId, first);
  assert.equal(f.sessions().length, 3); assert.equal(f.messages().length, 1);
});

test('新对话不带入旧正文，保留人设与历史记录；同名编辑不改变历史快照', t => {
  const f = fixture(t); f.chat(); f.newPersona('星遥'); f.send('上一段的秘密故事');
  const oldSession = f.sessions()[0];
  f.send('菜单'); f.send('1');
  const current = chatPreferences(f.store, f.owner).sessionId;
  assert.notEqual(current, oldSession.id); assert.equal(currentPersona(f.store, f.owner).name, '星遥');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE session_id=?').get(current).n, 0);
  assert.equal(f.store.db.prepare('SELECT content FROM chat_messages WHERE session_id=?').get(oldSession.id).content, '上一段的秘密故事');
  f.newPersona('星遥', '性格：活泼\n说话方式：俏皮');
  assert.equal(personas(f.store, f.owner).length, 2);
  assert.equal(JSON.parse(f.sessions()[0].persona_snapshot).personality, '沉稳');
  assert.equal(JSON.parse(f.sessions().at(-1).persona_snapshot).personality, '活泼');
});

test('人设编号分页不会截断菜单，名称也能选择，错误输入不破坏已有卡', t => {
  const f = fixture(t); f.chat();
  for (let index = 0; index < 10; index++) f.newPersona('人设' + index);
  f.send('更换人设卡'); assert.match(f.text(), /下一页/); assert.ok(f.text().length < 900);
  f.send('下一页'); assert.match(f.text(), /第 2 页/); f.send('11'); assert.equal(currentPersona(f.store, f.owner).name, '人设8');
  f.send('更换人设卡'); f.send('新增自定义人设'); f.send('名称：普通助手\n覆盖默认');
  assert.match(f.text(), /不能覆盖/); assert.equal(personas(f.store, f.owner).length, 11);
  f.send('名称：没有内容'); assert.match(f.text(), /名称下一行/); assert.equal(personas(f.store, f.owner).length, 11);
  f.send('主菜单'); assert.equal(interaction(f.store, f.owner).mode, 'main');
});

test('重复投递不重复建立会话、保存人设或追加聊天文字', t => {
  const f = fixture(t); f.chat();
  f.send('1', 'start'); f.send('1', 'start'); assert.equal(f.sessions().length, 1);
  f.send('42', 'body'); f.send('42', 'body'); assert.equal(f.messages().length, 1);
  f.send('更换人设卡'); f.send('新增自定义人设');
  f.send('名称：星遥\n性格：沉稳', 'card'); f.send('名称：星遥\n性格：沉稳', 'card');
  assert.equal(personas(f.store, f.owner).length, 2); assert.equal(f.sessions().length, 2);
});

test('重启恢复聊天模式、人设、当前会话和正文；返回菜单保留历史', t => {
  const f = fixture(t); f.chat(); f.newPersona('星遥'); f.send('重启前的对话');
  const before = chatPreferences(f.store, f.owner); f.reopen(); f.store.recover();
  assert.equal(interaction(f.store, f.owner).mode, 'chatgpt'); assert.equal(interaction(f.store, f.owner).screen, 'conversation');
  assert.deepEqual(chatPreferences(f.store, f.owner), before); assert.equal(currentPersona(f.store, f.owner).name, '星遥');
  f.send('2'); assert.equal(f.messages().at(-1).content, '2');
  f.send('菜单'); assert.equal(interaction(f.store, f.owner).screen, 'menu');
  f.send('主菜单'); assert.equal(f.messages().length, 2); assert.equal(f.sessions().length, 1);
  assert.equal(f.store.get('selectedProject:' + f.owner), 'demo');
});

test('重启恢复尚未提交的工作参数，并继续沿用本人绑定、选中项目和原有额度', t => {
  const f = fixture(t); f.codex(); f.send('选择项目 另一项目'); f.send('新建任务'); f.reopen();
  assert.equal(f.store.get('owner'), f.owner); assert.equal(interaction(f.store, f.owner).mode, 'codex');
  assert.equal(f.store.get('selectedProject:' + f.owner), 'other'); assert.equal(f.tasks().length, 0);
  f.send('重启后才提交要求'); assert.equal(f.store.task(1).project, 'other'); assert.equal(f.store.task(1).prompt, '重启后才提交要求');
});

test('大量聊天和菜单浏览不增加本地工作次数，原每日上限仍然生效', t => {
  const f = fixture(t); f.config.executor.dailyTaskLimit = 1;
  f.chat(); f.send('1');
  for (let index = 0; index < 30; index++) f.send(String(index));
  assert.equal(f.tasks().length, 0);
  f.codex(); f.send('新任务 demo：第一项'); assert.equal(f.tasks().length, 1);
  f.send('新任务 demo：第二项'); assert.equal(f.tasks().length, 1); assert.match(f.text(), /每日任务上限/);
});

test('切换聊天与菜单不取消运行任务，完成通知仍送出且不混入聊天上下文', async t => {
  const f = fixture(t); f.codex(); f.send('新任务 demo：分析');
  let complete; let began;
  const started = new Promise(resolve => { began = resolve; });
  const runner = { run: () => new Promise(resolve => { complete = resolve; began(); }) };
  const transport = new MockTransport(); const service = new Service(f.store, f.config, runner, transport);
  const execution = service.runOnce(); await started;
  f.chat(); f.newPersona('星遥'); f.send('聊天正文'); f.send('主菜单');
  assert.equal(f.store.task(1).status, 'running'); assert.equal(service.active.controller.signal.aborted, false);
  complete({ status: 'needs_input', summary: '请补充当前资料', threadId: 'codex-thread' }); await execution;
  assert.equal(f.store.task(1).status, 'needs_input');
  const final = f.store.outbox().find(item => item.kind === 'final');
  assert.match(final.content, /【Codex】演示项目 T1\n\n/);
  for (let index = 0; index < f.store.outbox().length; index++) await service.sendOnce(Date.now() + index * 4000);
  assert.equal(f.store.outbox().find(item => item.kind === 'final').status, 'sent');
  assert.ok(transport.messages.some(item => item.content === final.content));
  assert.deepEqual(f.messages().map(item => item.content), ['聊天正文']);
});

test('陌生人、其他机器人和非单聊不能查询人设或污染会话', t => {
  const f = fixture(t); f.chat(); f.newPersona('星遥');
  const before = { sessions: f.sessions(), cards: personas(f.store, f.owner), messages: f.messages(), replies: f.store.outbox().length };
  for (const extra of [{ sender: 'stranger', target: 'stranger' }, { appId: 'other' }, { scope: 'group' }]) {
    for (const text of ['菜单', '更换人设卡', '星遥', '新任务 demo：不能执行']) route(f.store, f.config, f.event(text, undefined, extra));
  }
  assert.deepEqual(f.sessions(), before.sessions); assert.deepEqual(personas(f.store, f.owner), before.cards); assert.deepEqual(f.messages(), before.messages); assert.equal(f.store.outbox().length, before.replies);
});
