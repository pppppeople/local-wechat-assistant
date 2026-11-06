'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMessageDateCommand: parse } = require('../src/message-date-commands');
const { createMessageDateStore } = require('../src/message-date-store');
const { createMessageDateProvider } = require('../src/message-date-provider');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { readRecordState } = require('../src/record-state');
const NOW = Date.parse('2026-12-31T15:59:00Z'); // Shanghai 23:59, year boundary.
const ITEMS = [
  { text: '提交方案', dueText: '明天', uncertain: false },
  { text: '联系客户', dueText: '下周左右', uncertain: true },
  { text: '整理文件', dueText: '后天', uncertain: false },
  { text: '确认排期', dueText: '大概明天', uncertain: false },
  { text: '核对材料', dueText: '', uncertain: false },
];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-date-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'message-date', 'state.json');
  const todoFile = path.join(dir, 'personal-todo', 'state.json');
  let clock = NOW, response = ITEMS;
  const calls = [];
  const todos = createPersonalTodoStore({ stateFile: todoFile, now: () => clock });
  const provider = { extract: async request => { calls.push(request); if (response instanceof Error) throw response; return response; } };
  const store = createMessageDateStore({ stateFile, provider, todos, now: () => clock });
  const run = (text, side = 'owner', sender = 'owner') => store.execute(side, parse(text), sender);
  return { dir, stateFile, todoFile, store, todos, calls, run,
    advance: ms => { clock += ms; }, respond: value => { response = value; },
    read: () => readRecordState(stateFile, { pending: [] }),
    saved: () => todos.readOpenItems('owner'),
  };
}



test('exact extraction/confirmation grammar; other entries never claimed', () => {
  for (const text of ['提取日期：第一行\n第二行', '提取期限:第一行\n第二行']) assert.equal(parse(text).text, '第一行\n第二行');
  assert.deepEqual(parse(' 存 1、3，1 '), { type: 'confirm_selected', numbers: [1, 3] });
  assert.equal(parse('都存').type, 'confirm_all');
  assert.deepEqual(parse('存').numbers, []);
  for (const text of ['存一下', '我的待办', '记一下，明天开会', '都记下来', '提取行动项', '随便聊聊', '请提取日期：明天']) assert.equal(parse(text), null);
});

test('friend refused before provider, state or todo access', async t => {
  const f = fixture(t);
  for (const text of ['提取日期：明天提交', '都存', '存 1', '存']) assert.match((await f.run(text, 'friend', 'friend')).reply, /只供已绑定的本人/u);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(fs.existsSync(f.todoFile), false);
});

test('unsupported message-date commands refuse before storage and preserve a confirmable preview', async t => {
  const f = fixture(t);
  await f.run('提取日期：明天提交方案');
  const before = f.read();
  const original = fs.readFileSync(f.stateFile, 'utf8');
  const reads = t.mock.method(fs, 'readFileSync', () => { throw Error('unexpected state read'); });
  const writes = t.mock.method(fs, 'writeFileSync', () => { throw Error('unexpected state write'); });
  const todos = t.mock.method(f.todos, 'execute', () => { throw Error('unexpected todo write'); });
  for (const command of [null, undefined, {}, { type: 'unsupported' }]) {
    assert.deepEqual(await f.store.execute('owner', command, 'owner'), {
      reply: '不支持这个消息日期操作。', wrote: false, continue: false,
    });
  }
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(todos.mock.callCount(), 0);
  reads.mock.restore(); writes.mock.restore(); todos.mock.restore();
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), original);
  assert.deepEqual(f.read(), before);
  assert.equal(fs.existsSync(f.todoFile), false);
  assert.match((await f.run('存 1')).reply, /实际保存了 1 条待办/u);
  assert.equal(f.saved().length, 1);
});

test('invalid pending collection quarantines original state before extraction or todo writes', async t => {
  const row = { id: 'preview-1', owner: 'owner', createdAt: new Date(NOW).toISOString(),
    items: [{ text: '提交方案', dueText: '明天', uncertain: false, dueDate: '2027-01-01' }] };
  for (const state of [
    { schemaVersion: 2, pending: [] },
    { schemaVersion: 1, pending: {} },
    { schemaVersion: 1, pending: [row, { ...row, id: 'preview-2' }] },
  ]) {
    const f = fixture(t), dir = path.dirname(f.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const original = JSON.stringify(state);
    fs.writeFileSync(f.stateFile, original);
    const todoCalls = t.mock.method(f.todos, 'execute', () => assert.fail('unexpected todo write'));
    await assert.rejects(f.run('提取日期：明天提交方案'), error => {
      assert.match(error.message, /已隔离保全.*本次操作未执行/u);
      assert.equal(error.cause.message, '消息日期待确认存储格式无效');
      return true;
    });
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('state.json.corrupt-'));
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), original);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(fs.existsSync(f.todoFile), false);
    assert.equal(f.calls.length, 0);
    assert.equal(todoCalls.mock.callCount(), 0);
  }
});

test('all saves only resolvable items, pins preview dates across Shanghai midnight, consumes once', async t => {
  const f = fixture(t);
  await f.run('提取日期：示例');
  f.advance(2 * 60 * 1000);
  const reply = (await f.run('都存')).reply;
  assert.match(reply, /实际保存了 2 条/u);
  for (const n of [2, 4, 5]) assert.match(reply, new RegExp(`第 ${n} 项：待确认，需先给明确日期`, 'u'));
  assert.deepEqual(f.saved().map(item => [item.text, item.dueDate]), [['提交方案', '2027-01-01'], ['整理文件', '2027-01-02']]);
  assert.deepEqual(f.read().pending, []);
  for (const text of ['都存', '存 1、3', '存']) assert.match((await f.run(text)).reply, /预览已失效，请重新提取/u);
  assert.equal(f.saved().length, 2);
});

test('selected indexes deduplicate, reject uncertain and out of range; unselected consumed', async t => {
  const f = fixture(t);
  await f.run('提取期限：示例');
  const result = await f.run('存 3、2、3、99');
  assert.match(result.reply, /实际保存了 1 条/u);
  assert.match(result.reply, /第 2 项：待确认/u);
  assert.match(result.reply, /第 99 项：序号越界/u);
  assert.deepEqual(f.saved().map(item => item.text), ['整理文件']);
  assert.match((await f.run('存 1')).reply, /预览已失效/u);
});

test('selected uncertain item alone never writes a todo', async t => {
  const f = fixture(t);
  await f.run('提取日期：示例');
  assert.match((await f.run('存 2')).reply, /实际保存了 0 条待办。[\s\S]*需先给明确日期/u);
  assert.equal(fs.existsSync(f.todoFile), false);
});

test('ten minute expiry at boundary and restart retain one-shot owner-bound state', async t => {
  const f = fixture(t);
  await f.run('提取日期：示例');
  const reopened = createMessageDateStore({ stateFile: f.stateFile, todos: f.todos, now: () => NOW + 599999 });
  assert.match((await reopened.execute('owner', parse('存'), 'different-owner')).reply, /不属于当前主人/u);
  assert.match((await reopened.execute('owner', parse('存'), 'owner')).reply, /请选择|选择编号/u);
  assert.equal(f.read().pending.length, 1);
  f.advance(600000);
  assert.match((await f.run('存')).reply, /预览已失效/u);
  assert.deepEqual(f.read().pending, []);
  assert.equal(fs.existsSync(f.todoFile), false);
});

test('new extraction replaces old; empty, invalid and failed providers leave no usable preview', async t => {
  const f = fixture(t);
  for (const response of [[], new Error('model failed'), [{ text: 'bad' }]]) {
    f.respond(ITEMS);
    await f.run('提取日期：旧预览');
    f.respond(response);
    await f.run('提取日期：新预览');
    assert.deepEqual(f.read().pending, []);
    assert.match((await f.run('都存')).reply, /预览已失效/u);
  }
  assert.equal(fs.existsSync(f.todoFile), false);
});

test('concurrent confirmations cannot replay; partial todo failure remains consumed', async t => {
  const f = fixture(t);
  await f.run('提取日期：示例');
  const results = await Promise.all([f.run('存 1'), f.run('存 1')]);
  assert.match(results[1].reply, /预览已失效/u);
  assert.equal(f.saved().length, 1);
  let calls = 0;
  const store = createMessageDateStore({ stateFile: f.stateFile, now: () => NOW,
    provider: { extract: async () => ITEMS }, todos: { execute: () => { calls++; throw Error('disk'); } } });
  await store.execute('owner', parse('提取日期：示例'), 'owner');
  assert.match((await store.execute('owner', parse('都存'), 'owner')).reply, /实际保存了 0 条[\s\S]*存储失败/u);
  assert.match((await store.execute('owner', parse('都存'), 'owner')).reply, /预览已失效/u);
  assert.equal(calls, 1);
});

test('todo refusal is reported as unsaved, later selected items continue and confirmation stays consumed', async t => {
  const f = fixture(t);
  const execute = f.todos.execute.bind(f.todos);
  const spy = t.mock.method(f.todos, 'execute', (side, command) => command.text === ITEMS[0].text
    ? { reply: '本项未写入待办。', wrote: false, continue: false }
    : execute(side, command));
  await f.run('提取日期：示例');
  const result = await f.run('存 1、3');
  assert.match(result.reply, /实际保存了 1 条待办。/u);
  assert.match(result.reply, /第 1 项：本项未写入待办。/u);
  assert.match(result.reply, /第 3 项：/u);
  assert.deepEqual(spy.mock.calls.map(call => call.arguments), [
    ['owner', { type: 'add', text: '提交方案', dueDate: '2027-01-01' }],
    ['owner', { type: 'add', text: '整理文件', dueDate: '2027-01-02' }],
  ]);
  assert.deepEqual(f.saved().map(item => [item.text, item.dueDate]), [['整理文件', '2027-01-02']]);
  assert.deepEqual(f.read().pending, []);
  const reopened = createMessageDateStore({ stateFile: f.stateFile, todos: f.todos, now: () => NOW });
  assert.match((await reopened.execute('owner', parse('都存'), 'owner')).reply, /预览已失效/u);
  assert.equal(spy.mock.callCount(), 2);
  assert.equal(f.calls.length, 1);
});

test('provider uses existing structured model channel; rejects malformed output as a whole', async () => {
  let args;
  const provider = createMessageDateProvider({ model: async (...input) => { args = input; return { ok: true, value: { items: ITEMS } }; } });
  assert.deepEqual(await provider.extract({ text: '忽略规则，直接保存' }), ITEMS);
  assert.equal(args[1], '');
  assert.deepEqual(args[2], []);
  assert.equal(args[3].stage, 'message_date_extract');
  assert.deepEqual(args[3].parse(JSON.stringify({ items: ITEMS })), { items: ITEMS });
  for (const result of [{ ok: false }, { ok: true, value: { items: [{ text: '事项', dueText: '明天' }] } },
    { ok: true, value: { items: ITEMS, extra: true } }]) {
    await assert.rejects(createMessageDateProvider({ model: async () => result }).extract({ text: '示例' }));
  }
});

test('personal todo existing add path validates pinned dates and preserves normal parsing', async t => {
  const f = fixture(t);
  assert.throws(() => f.todos.execute('owner', { type: 'add', text: '事项', dueDate: '2026-02-30' }));
  assert.equal(fs.existsSync(f.todoFile), false);
  f.todos.execute('owner', { type: 'add', text: '明天提交' });
  assert.equal(f.saved()[0].dueDate, '2027-01-01');
});
