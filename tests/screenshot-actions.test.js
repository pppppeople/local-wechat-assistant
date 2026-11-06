'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScreenshotActionCommand: parse } = require('../src/screenshot-action-commands');
const { createScreenshotActionStore } = require('../src/screenshot-action-store');
const { createScreenshotActionProvider } = require('../src/screenshot-action-provider');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { readRecordState } = require('../src/record-state');
const NOW = Date.parse('2026-10-30T00:00:00Z');
const ITEMS = [
  { text: '提交方案', dueText: '明天', uncertain: false },
  { text: '联系客户', dueText: '下个月找时间', uncertain: false },
  { text: '核对附件', dueText: '', uncertain: true },
];
function fixture(t, extract) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state', 'screenshot-actions', 'state.json');
  const todoFile = path.join(root, 'personal-todo', 'state.json');
  let clock = NOW;
  const calls = [], adds = [];
  const todos = createPersonalTodoStore({ stateFile: todoFile, now: () => clock });
  const provider = { extract: async args => {
    calls.push(args);
    return extract ? extract(args) : structuredClone(ITEMS);
  } };
  const store = createScreenshotActionStore({ stateFile, provider, now: () => clock,
    todos: { execute: (side, command) => { adds.push({ side, command }); return todos.execute(side, command); } } });
  return { root, stateFile, todoFile, provider, store, calls, adds, todos,
    advance: ms => { clock += ms; }, read: () => readRecordState(stateFile),
    run: (text, images = [], side = 'owner') => store.execute(side, parse(text, images)),
    extract: () => store.execute('owner', parse('提取行动项', ['fixture.png'])),
  };
}



test('image trigger requires exact prefix, confirmation commands parse without images', () => {
  for (const text of ['提取行动项', '提取行动项：只看这几张']) {
    assert.equal(parse(text, ['a.png']).type, 'extract');
    assert.equal(parse(text), null);
  }
  for (const text of ['帮我提取行动项', ' 提取行动项', '普通聊天']) assert.equal(parse(text, ['a.png']), null);
  assert.deepEqual(parse('加入第1、3项'), { type: 'confirm_selected', numbers: [1, 3] });
  assert.deepEqual(parse('加入第1，3,1项').numbers, [1, 3]);
  assert.equal(parse('都加入待办').type, 'confirm_all');
  assert.equal(parse('算了').type, 'discard');
});

test('unsupported type and null commands are rejected without creating state', async t => {
  const f = fixture(t);
  for (const command of [{ type: 'bogus' }, null]) {
    assert.deepEqual(await f.store.execute('owner', command), {
      reply: '不支持这个行动项操作。', wrote: false, continue: false,
    });
    assert.equal(fs.existsSync(f.stateFile), false);
  }
});

test('confirm all calls existing todo add; dates parsed there and unknown phrases preserved', async t => {
  const f = fixture(t);
  await f.extract();
  const bodyFile = JSON.parse(fs.readFileSync(f.stateFile)).pending[0].file;
  const reply = (await f.run('都加入待办')).reply;
  assert.match(reply, /实际加入了 3 条待办/u);
  for (const item of ITEMS) assert.ok(reply.includes(item.text));
  assert.deepEqual(f.adds, ITEMS.map(item => ({ side: 'owner', command: { type: 'add',
    text: item.text + (item.dueText ? ` ${item.dueText}` : '') } })));
  const saved = f.todos.readOpenItems('owner');
  assert.equal(saved.find(item => item.text.startsWith('提交方案')).dueDate, '2026-10-31');
  assert.equal(saved.find(item => item.text === '联系客户 下个月找时间').dueDate, null);
  assert.equal(saved.find(item => item.text === '核对附件').dueDate, null);
  assert.deepEqual(f.read().pending, []);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), bodyFile)), false);
  assert.match((await f.run('都加入待办')).reply, /没有待确认/u);
  assert.equal(f.adds.length, 3);
});

test('selected indices add once with dueDate, invalid indices are reported and ignored', async t => {
  const f = fixture(t);
  await f.extract();
  const reply = (await f.run('加入第1、3、1、0、8项')).reply;
  assert.match(reply, /实际加入了 2 条/u);
  assert.match(reply, /越界序号：0、8/u);
  assert.equal(f.adds.length, 2);
  const saved = f.todos.readOpenItems('owner');
  assert.equal(saved[0].dueDate, '2026-10-31');
  assert.equal(saved[1].text, '核对附件');
  assert.deepEqual(f.read().pending, []);
  await f.extract();
  assert.match((await f.run('加入第99项')).reply, /实际加入了 0 条.*\n已忽略越界序号：99/su);
  assert.deepEqual(f.read().pending, []);
});

test('discard consumes preview; all three commands without pending explicitly refuse confirmation', async t => {
  const f = fixture(t);
  for (const text of ['都加入待办', '加入第1、3项', '算了']) assert.match((await f.run(text)).reply, /没有待确认/u);
  assert.equal(fs.existsSync(f.stateFile), false);
  await f.extract();
  assert.match((await f.run('算了')).reply, /已丢弃/u);
  assert.deepEqual(f.read().pending, []);
  assert.equal(f.adds.length, 0);
});

test('20 minute expiry is lazy and refuses late confirmations without adding', async t => {
  const f = fixture(t);
  await f.extract();
  f.advance(20 * 60 * 1000);
  assert.equal(f.read().pending.length, 1);
  assert.match((await f.run('都加入待办')).reply, /没有待确认.*过期/u);
  assert.deepEqual(f.read().pending, []);
  assert.equal(f.adds.length, 0);
});

test('hasPending is synchronous, fresh until TTL, and never clears expired state', async t => {
  const f = fixture(t);
  await f.extract();
  assert.equal(f.store.hasPending(), true);
  const index = fs.readFileSync(f.stateFile, 'utf8');
  const body = path.join(path.dirname(f.stateFile), JSON.parse(index).pending[0].file);
  const originalBody = fs.readFileSync(body, 'utf8');
  f.advance(20 * 60 * 1000 - 1);
  assert.equal(f.store.hasPending(), true);
  f.advance(1);
  assert.equal(f.store.hasPending(), false);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.equal(fs.readFileSync(body, 'utf8'), originalBody);
});

test('hasPending returns false for missing state, empty items and consumed previews', async t => {
  const missing = fixture(t);
  assert.equal(missing.store.hasPending(), false);
  assert.deepEqual(fs.readdirSync(missing.root), []);
  const empty = fixture(t, () => []);
  await empty.extract();
  assert.equal(empty.store.hasPending(), false);
  const consumed = fixture(t);
  await consumed.extract();
  await consumed.run('算了');
  assert.equal(consumed.store.hasPending(), false);
});

test('hasPending silently rejects corrupt or invalid state without quarantine or rewrite', async t => {
  for (const damage of ['json', 'schema', 'body', 'missing']) {
    const f = fixture(t);
    await f.extract();
    const body = path.join(path.dirname(f.stateFile), JSON.parse(fs.readFileSync(f.stateFile)).pending[0].file);
    if (damage === 'json') fs.writeFileSync(f.stateFile, '{');
    if (damage === 'schema') fs.writeFileSync(f.stateFile, '{"schemaVersion":1,"pending":{}}');
    if (damage === 'body') fs.writeFileSync(body, '{}');
    if (damage === 'missing') fs.rmSync(body);
    const before = fs.readFileSync(f.stateFile, 'utf8');
    const originalBody = damage === 'missing' ? null : fs.readFileSync(body, 'utf8');
    assert.equal(f.store.hasPending(), false);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
    assert.equal(fs.existsSync(body), damage !== 'missing');
    if (originalBody !== null) assert.equal(fs.readFileSync(body, 'utf8'), originalBody);
    assert.equal(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')), false);
    await assert.rejects(f.extract(), /损坏，已隔离保全/u);
    assert.equal(f.calls.length, 1, 'strict extraction fails before provider access');
  }
});

test('new extraction replaces old, confirmation during generation serializes behind latest preview', async t => {
  let count = 0;
  const f = fixture(t, async () => [{ text: `事项${++count}`, dueText: '', uncertain: false }]);
  await f.extract();
  const [preview, confirmation] = await Promise.all([f.extract(), f.run('都加入待办')]);
  assert.match(preview.reply, /1. 事项2/u);
  assert.doesNotMatch(preview.reply, /事项1|覆盖|旧/u);
  assert.match(confirmation.reply, /实际加入了 1 条/u);
  assert.equal(f.todos.readOpenItems('owner')[0].text, '事项2');
});

test('malformed provider batch or model failure fails whole round, clearing previous preview too', async t => {
  for (const invalid of [undefined, null, {}, [ITEMS[0], { text: '缺字段' }],
    [{ ...ITEMS[0], uncertain: 'false' }], [{ ...ITEMS[0], dueText: null }],
    [{ ...ITEMS[0], text: ' ' }], [{ ...ITEMS[0], extra: true }]]) {
    let output = ITEMS;
    const f = fixture(t, () => output);
    await f.extract();
    output = invalid;
    assert.match((await f.extract()).reply, /没提取成功/u);
    assert.deepEqual(f.read().pending, []);
    assert.match((await f.run('都加入待办')).reply, /没有待确认/u);
    assert.equal(f.adds.length, 0);
  }
  const f = fixture(t, () => { throw new Error('model offline'); });
  assert.match((await f.extract()).reply, /没提取成功/u);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('valid empty extraction invents no items or todos', async t => {
  const f = fixture(t, () => []);
  assert.match((await f.extract()).reply, /未提取到行动项/u);
  assert.match((await f.run('都加入待办')).reply, /实际加入了 0 条/u);
  assert.equal(f.adds.length, 0);
});

test('partial todo capacity refusal reports actual added count and clears pending', async t => {
  const f = fixture(t);
  for (let i = 0; i < 199; i++) f.todos.execute('owner', { type: 'add', text: `已有事项${i}` });
  await f.extract();
  const reply = (await f.run('都加入待办')).reply;
  assert.match(reply, /实际加入了 1 条/u);
  assert.match(reply, /第2项：.*最多 200 条/u);
  assert.match(reply, /第3项：.*最多 200 条/u);
  assert.deepEqual(f.read().pending, []);
});

test('todo throw on second item stops later attempts, preserves first add and consumes pending', async t => {
  const f = fixture(t);
  await f.extract();
  const bodyFile = path.join(path.dirname(f.stateFile), JSON.parse(fs.readFileSync(f.stateFile)).pending[0].file);
  const attempts = [], addedReplies = [];
  const store = createScreenshotActionStore({ stateFile: f.stateFile, now: () => NOW,
    todos: { execute: (side, command) => {
      attempts.push({ side, command });
      assert.deepEqual(f.read().pending, [], 'preview is consumed before any todo attempt');
      if (attempts.length === 2) throw Error('injected todo storage failure');
      const result = f.todos.execute(side, command);
      addedReplies.push(result.reply);
      return result;
    } } });
  const result = await store.execute('owner', parse('都加入待办'));
  assert.deepEqual(result, { reply: ['实际加入了 1 条待办。', ...addedReplies,
    '第2项：待办存储失败，请检查待办后再操作。'].join('\n'), wrote: true, continue: true });
  assert.deepEqual(attempts, ITEMS.slice(0, 2).map(item => ({ side: 'owner', command: {
    type: 'add', text: `${item.text} ${item.dueText}`,
  } })));
  const saved = f.todos.readOpenItems('owner');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, '提交方案 ');
  assert.equal(saved[0].dueDate, '2026-10-31');
  assert.deepEqual(f.read().pending, []);
  assert.equal(fs.existsSync(bodyFile), false);
  assert.equal(store.hasPending(), false);
  assert.match((await store.execute('owner', parse('都加入待办'))).reply, /当前没有待确认的行动项/u);
  assert.equal(attempts.length, 2);
  assert.deepEqual(f.todos.readOpenItems('owner'), saved);
});

test('owner-only store refuses friend before provider or file access', async t => {
  const f = fixture(t);
  for (const [text, images] of [['提取行动项', ['a.png']], ['都加入待办', []], ['加入第1项', []], ['算了', []]]) {
    assert.match((await f.run(text, images, 'friend')).reply, /只供已绑定的本人/u);
  }
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.calls.length, 0);
});

test('corrupt state is quarantined and fails closed without provider/todo calls', async t => {
  for (const damage of ['json', 'schema', 'body', 'missing']) {
    const f = fixture(t);
    await f.extract();
    const index = JSON.parse(fs.readFileSync(f.stateFile));
    const body = path.join(path.dirname(f.stateFile), index.pending[0].file);
    if (damage === 'json') fs.writeFileSync(f.stateFile, '{');
    if (damage === 'schema') fs.writeFileSync(f.stateFile, '{"schemaVersion":1,"pending":{}}');
    if (damage === 'body') fs.writeFileSync(body, '{}');
    if (damage === 'missing') fs.rmSync(body);
    await assert.rejects(f.run('都加入待办'), /损坏，已隔离保全/u);
    assert.equal(f.calls.length, 1);
    assert.equal(f.adds.length, 0);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
  }
});

test('production provider passes images to fresh shared runner with schema and strict parse', async () => {
  let args;
  const provider = createScreenshotActionProvider({ model: async (...input) => {
    args = input;
    return { ok: true, value: input[3].parse(JSON.stringify({ items: ITEMS })) };
  } });
  assert.deepEqual(await provider.extract({ text: '提取行动项', imagePaths: ['one.png', 'two.png'] }), ITEMS);
  assert.equal(args[1], '');
  assert.deepEqual(args[2], ['one.png', 'two.png']);
  assert.equal(args[3].schema.additionalProperties, false);
  assert.equal(args[3].schema.properties.items.items.additionalProperties, false);
  assert.equal(args[3].stage, 'screenshot_action_extract');
  for (const text of ['not json', '{"items":[{}]}', '{"items":[],"extra":1}']) assert.throws(() => args[3].parse(text));
  for (const response of [{ ok: false }, { ok: true, value: { items: [{}] } }]) {
    await assert.rejects(createScreenshotActionProvider({ model: async () => response })
      .extract({ text: '提取行动项', imagePaths: ['one.png'] }));
  }
});
