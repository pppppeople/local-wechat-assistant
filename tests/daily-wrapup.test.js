'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDailyWrapup } = require('../src/daily-wrapup');
const { createDailyWrapupProvider } = require('../src/daily-wrapup-provider');
const { parseDailyWrapupCommand } = require('../src/daily-wrapup-commands');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { createWorklogStore } = require('../src/worklog-store');

const SUMMARY = {
  今天做了什么: '完成待办：交付；日志：完成：核对资料',
  还有什么没做: '提交方案（2026-11-02）；无日期任务；阻塞：等待采购确认',
  明天优先处理什么: '提交方案（依据到期日 2026-11-02）；等待采购确认（依据日志“阻塞：等待采购确认”）；无日期任务无明确优先级依据',
};
function fixture(t, model = async () => ({ ok: true, value: SUMMARY })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-daily-wrapup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-01T15:59:59Z');
  let calls = 0;
  const inputs = [];
  const now = () => clock;
  const todoFile = path.join(dir, 'todos', 'state.json');
  const logFile = path.join(dir, 'worklog', 'state.json');
  const todos = createPersonalTodoStore({ stateFile: todoFile, now });
  const worklogs = createWorklogStore({ stateFile: logFile, now });
  const provider = createDailyWrapupProvider({ model: async (...args) => {
    calls++; inputs.push(args); return model(...args);
  } });
  const assistant = createDailyWrapup({ todos, worklogs, provider, now });
  return { dir, todoFile, logFile, todos, worklogs, assistant, inputs,
    calls: () => calls, setTime: text => { clock = Date.parse(text); },
    run: (side = 'owner') => assistant.execute(side, parseDailyWrapupCommand('收工总结')) };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}
function seed(f) {
  f.todos.execute('owner', { type: 'add', text: '交付' });
  f.todos.execute('owner', { type: 'complete', number: 1 });
  f.todos.execute('owner', { type: 'add', text: '无日期任务' });
  f.todos.execute('owner', { type: 'add', text: '提交方案', dueDate: '2026-11-02' });
  f.worklogs.execute('owner', { type: 'add', text: '完成：核对资料' });
  f.worklogs.execute('owner', { type: 'add', text: '阻塞：等待采购确认' });
}



test('friend refused before data reads or model call', async () => {
  const fail = () => assert.fail('friend must not reach dependencies');
  const assistant = createDailyWrapup({ todos: { readDailyItems: fail }, worklogs: { readDailyEntries: fail }, provider: { generate: fail }, now: fail });
  const result = await assistant.execute('friend', { type: 'summary' });
  assert.match(result.reply, /只供已绑定的本人/u);
  assert.equal(result.wrote, false);
});

test('normal three sections include completed, open, blockers; one isolated model call and zero storage changes', async t => {
  const f = fixture(t); seed(f);
  const before = snapshot(f.dir);
  const result = await f.run();
  assert.equal(result.reply, Object.entries(SUMMARY).map(([title, body]) => `${title}\n${body}`).join('\n\n'));
  assert.equal(result.wrote, false);
  assert.equal(f.calls(), 1);
  const [prompt, session, images, options] = f.inputs[0];
  assert.equal(session, ''); assert.deepEqual(images, []);
  assert.equal(options.stage, 'daily_wrapup_generate');
  assert.deepEqual(options.parse(JSON.stringify(SUMMARY)), SUMMARY);
  assert.match(prompt, /无显式依据.*不得判断优先级/u);
  assert.match(prompt, /不得编造进展/u);
  const data = JSON.parse(prompt.split('\n').at(-1));
  assert.deepEqual(data.completed.map(x => x.text), ['交付']);
  assert.deepEqual(data.open.map(x => x.text), ['提交方案', '无日期任务']);
  assert.deepEqual(data.logs.map(x => x.text), ['完成：核对资料', '阻塞：等待采购确认']);
  assert.deepEqual(snapshot(f.dir), before);
});

test('Shanghai midnight: yesterday completions and logs excluded; today completion included by completedAt even if created yesterday', async t => {
  const f = fixture(t);
  f.todos.execute('owner', { type: 'add', text: '昨日完成' });
  f.todos.execute('owner', { type: 'complete', number: 1 });
  f.todos.execute('owner', { type: 'add', text: '今日完成' });
  f.worklogs.execute('owner', { type: 'add', text: '昨日私有日志' });
  f.setTime('2026-11-01T16:00:00Z');
  f.todos.execute('owner', { type: 'complete', number: 1 });
  f.worklogs.execute('owner', { type: 'add', text: '今日记录' });
  const before = snapshot(f.dir);
  await f.run();
  const data = JSON.parse(f.inputs[0][0].split('\n').at(-1));
  assert.equal(data.today, '2026-11-02');
  assert.deepEqual(data.completed.map(x => x.text), ['今日完成']);
  assert.deepEqual(data.logs, [{ text: '今日记录' }]);
  assert.deepEqual(snapshot(f.dir), before);
});

test('empty data and yesterday-only data give explicit no-content reply without calling model or writing', async t => {
  const f = fixture(t);
  assert.match((await f.run()).reply, /今日无工作日志.*暂无可整理内容/u);
  assert.deepEqual(snapshot(f.dir), []);
  seed(f);
  f.todos.execute('owner', { type: 'cancel', number: 1 });
  f.todos.execute('owner', { type: 'cancel', number: 1 });
  f.setTime('2026-11-01T16:00:00Z');
  const before = snapshot(f.dir);
  assert.match((await f.run()).reply, /暂无可整理内容/u);
  assert.equal(f.calls(), 0);
  assert.deepEqual(snapshot(f.dir), before);
});

test('open-only data still generates a summary', async t => {
  const f = fixture(t);
  f.todos.execute('owner', { type: 'add', text: '尚未完成' });
  await f.run();
  assert.equal(f.calls(), 1);
  assert.deepEqual(JSON.parse(f.inputs[0][0].split('\n').at(-1)).open, [{ text: '尚未完成', dueDate: null }]);
});

test('corrupt index or missing body fails without quarantine or modifying either store', async t => {
  for (const kind of ['todo-index', 'log-index', 'missing-body']) {
    const f = fixture(t); seed(f);
    if (kind === 'missing-body') {
      const index = JSON.parse(fs.readFileSync(f.logFile));
      fs.unlinkSync(path.join(path.dirname(f.logFile), index.entries[0].file));
    } else fs.writeFileSync(kind === 'todo-index' ? f.todoFile : f.logFile, '{broken');
    const before = snapshot(f.dir);
    assert.match((await f.run()).reply, /生成失败/u);
    assert.equal(f.calls(), 0);
    assert.deepEqual(snapshot(f.dir), before);
  }
});
