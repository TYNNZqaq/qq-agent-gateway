import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Store, ownerKey } from '../../packages/application/store.mjs';
import { route } from '../../packages/application/router.mjs';
import { interaction, WORK_OPTIONS, WORK_SECTIONS } from '../../packages/application/menus.mjs';
import { PROJECT_ROOT } from '../../packages/application/config.mjs';

function fixture(t) {
  const work = process.env.QQ_TEST_ROOT; mkdirSync(work, { recursive: true });
  const stateDir = mkdtempSync(path.join(work, 'qq-consolidation-'));
  const store = new Store(stateDir);
  const config = { stateDir, executor: { enabled: true, maxQueuedTasks: 10, dailyTaskLimit: 30 },
    qq: { appId: '12345', passiveWindowSeconds: 300, maxPassiveReplies: 4 },
    desktopTasks: { enabled: true }, projects: { demo: { path: stateDir, label: '演示' } } };
  let id = 0;
  const event = content => ({ appId: '12345', scope: 'c2c', sender: 'owner', target: 'owner', id: 'e' + ++id, sentAt: Date.now(), content });
  const owner = ownerKey(event('')); store.set('owner', owner); store.set('selectedProject:' + owner, 'demo');
  store.set('interaction:' + owner, { version: 1, mode: 'codex', screen: 'menu' });
  t.after(() => store.close());
  return { store, config, owner, send: content => route(store, config, event(content)),
    text: () => store.outbox().at(-1).content, state: () => interaction(store, owner) };
}

test('六类工作菜单的每个编号都有入口且浏览不会执行任务或暂停接单', t => {
  const f = fixture(t);
  for (const [index, section] of WORK_SECTIONS.entries()) {
    f.send('菜单'); f.send(String(index + 1)); assert.equal(f.state().screen, section.screen);
    assert.match(f.text(), new RegExp(section.screen === 'model_settings' ? '工作模型' : section.name));
    f.send('0'); assert.equal(f.state().screen, 'menu');
  }
  assert.equal(f.store.tasks(f.owner).length, 0); assert.equal(f.store.get('paused', false), false);
  f.send('项目管理'); f.send('返回上一级'); assert.equal(f.state().screen, 'menu');
  f.send('0'); assert.equal(f.state().mode, 'main');
});

test('项目列表与选择归为一个入口，项目数字和任务数字按显示页解析', t => {
  const f = fixture(t); f.send('1'); f.send('1'); assert.equal(f.state().pending.action, 'select_project');
  f.send('1'); assert.equal(f.store.get('selectedProject:' + f.owner), 'demo');
  assert.equal(f.state().screen, 'menu'); // An empty project has no task numbers to select.
  f.send('菜单'); f.send('2'); f.send('1');
  const result = f.send('只读检查'); assert.equal(result.task.prompt, '只读检查');
  f.send('任务管理'); f.send('2'); assert.equal(f.state().screen, 'task_picker');
  f.send('1'); assert.equal(f.state().screen, 'task_conversation');
  f.send('请保留结果'); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_guidance').get().n, 1);
  f.send('项目管理'); assert.equal(f.state().screen, 'work_projects');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_guidance').get().n, 1);
});

test('状态和结果合为一项，旧别名仍可查完整结果，取消与补发保持原边界', t => {
  const f = fixture(t), task = f.send('新任务：检查').task;
  for (const command of ['查询任务状态', '查看任务结果', '查看状态与结果']) {
    f.send('菜单'); if (command === '查看状态与结果') f.send('任务管理');
    f.send(command); assert.equal(f.state().pending.command, command === '查看任务结果' ? '结果' : '状态');
    f.send(task.display_id); assert.match(f.text(), /演示 T1 排队中/);
  }
  f.send('任务管理'); f.send('6'); assert.equal(f.store.task(task.id).status, 'queued');
  f.send(task.display_id); assert.equal(f.store.task(task.id).status, 'cancelled');
  assert.equal(f.store.tasks(f.owner).length, 1);
});

test('文件和审批问答菜单实际连接到现有处理器，填写一次后返回所属分类', t => {
  const f = fixture(t);
  f.send('3'); f.send('1'); assert.match(f.text(), /QQ 图片/);
  f.send('2'); assert.match(f.text(), /尚无文件接收记录/);
  f.send('6'); assert.equal(f.state().pending.command, '文件状态');
  f.send('演示 T1'); assert.match(f.text(), /尚无该任务的文件发送记录/); assert.equal(f.state().screen, 'work_files');
  f.send('7'); f.send('补发文件 演示 T1'); assert.equal(f.state().screen, 'work_files');
  f.send('审批与问答'); f.send('1'); assert.match(f.text(), /手机审批尚未启用/);
  f.send('2'); f.send('演示 A1'); assert.match(f.text(), /手机审批尚未启用/); assert.equal(f.state().screen, 'work_review');
  f.send('3'); assert.match(f.text(), /问答尚未启用/);
  for (const choice of ['4', '5']) { f.send(choice); f.send('Q1'); assert.match(f.text(), /问答尚未启用/); assert.equal(f.state().screen, 'work_review'); }
});

test('暂停与恢复归在接单设置，进入分类不改变状态，选择动作后才变更', t => {
  const f = fixture(t); f.send('6'); assert.equal(f.store.get('paused', false), false);
  f.send('1'); assert.equal(f.store.get('paused'), true);
  f.send('2'); assert.equal(f.store.get('paused'), false);
  f.send('99'); assert.equal(f.state().screen, 'work_intake'); assert.match(f.text(), /正常接单/);
});

test('原十五项文字入口保持可达，不会把旧任务操作误当新任务', t => {
  const f = fixture(t);
  for (const [name] of WORK_OPTIONS) {
    f.send('菜单'); f.send(name);
    assert.equal(f.store.tasks(f.owner).length, 0, name);
    if (['选择项目', '新建任务', '查询任务状态', '查看任务结果', '继续任务', '取消任务', '补发通知'].includes(name)) assert.equal(f.state().screen, 'prompt', name);
  }
});
