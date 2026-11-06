'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseFocusStashCommand: parse, createFocusStashCommands } = require('../src/focus-stash-commands');
const { parseFocusSessionCommand: focusParse } = require('../src/focus-session-commands');
const { createFocusSessionStore } = require('../src/focus-session-store');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-stash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-03T01:00:00Z');
  const now = () => clock;
  const stateFile = path.join(root, 'focus/state.json');
  const todoFile = path.join(root, 'todos/state.json');
  const todos = createPersonalTodoStore({ stateFile: todoFile, now });
  const options = { stateFile, now, todos };
  const store = createFocusSessionStore(options);
  return { store, root, stateFile, todoFile, todos,
    say: text => store.handleStash('owner', parse(text)),
    focus: text => store.handle('owner', focusParse(text)),
    read: () => readRecordState(stateFile),
    advance: ms => { clock += ms; }, restart: () => createFocusSessionStore(options) };
}



test('trimmed exact parser never claims existing focus commands or quoted todo content', () => {
  assert.deepEqual(parse(' \n 暂存：  想法 \n '), { type: 'add', text: '想法' });
  assert.deepEqual(parse(' 暂存: '), { type: 'add', text: '' });
  assert.deepEqual(parse(' 暂存列表 '), { type: 'list' });
  assert.deepEqual(parse(' 暂存转待办 '), { type: 'transfer' });
  assert.deepEqual(parse(' 删除暂存第 2 条 '), { type: 'delete', number: 2 });
  for (const text of ['专注 45 分钟', '专心工作 1 小时', '专注状态', '结束专注', '专注半小时',
    '记一下，暂存：想法', '请查看暂存列表', '暂存列表是什么', '他说“暂存：想法”']) assert.equal(parse(text), null, text);
});

test('no session refuses, blank refuses, stores trimmed Shanghai timestamps with a 10 item bound', t => {
  const f = fixture(t);
  for (const text of ['暂存：想法', '暂存列表', '删除暂存第1条', '暂存转待办']) {
    assert.match(f.say(text), /没有进行中的专注.*请先开始专注/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  f.focus('专注 45 分钟');
  const initial = f.read();
  assert.match(f.say('暂存： \n '), /不能为空/);
  assert.deepEqual(f.read(), initial);
  assert.match(f.say('暂存列表'), /暂无暂存/);
  for (let n = 1; n <= 10; n++) assert.match(f.say(`暂存：  想法${n}  `), /已暂存/);
  const full = f.read();
  assert.equal(full.sessions[0].stash.length, 10);
  assert.equal(full.sessions[0].stash[0].text, '想法1');
  assert.equal(full.sessions[0].stash[0].createdAt, '2026-11-03T09:00:00.000+08:00');
  assert.match(f.say('暂存：不应淘汰'), /最多 10 条/);
  assert.deepEqual(f.read(), full);
  assert.match(f.say('暂存列表'), /1\. 想法1[\s\S]*10\. 想法10/);
  for (const n of ['0', '11', '999999999999999999999']) assert.match(f.say(`删除暂存第${n}条`), /越界/);
  assert.deepEqual(f.read(), full);
  assert.match(f.say('删除暂存第2条'), /已删除/);
  assert.equal(f.read().sessions[0].stash.length, 9);
  assert.match(f.say('暂存列表'), /2\. 想法3/);
  assert.equal(fs.existsSync(f.todoFile), false);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match(index.sessions[0].file, /^records\/sessions\/sessions\/2026\/11\//);
  assert.equal(fs.readdirSync(f.root).length, 1); // No second state system for stash.
});

test('natural finish includes stash exactly once, clears before send, overlaps and failure never replay', async t => {
  for (const fail of [false, true]) {
    const f = fixture(t); f.focus('专注 1 分钟，结束提醒我喝水'); f.say('暂存：检查草稿');
    f.advance(60000);
    const sent = [];
    const deliver = async (text, id) => {
      const item = f.read().sessions[0];
      assert.equal(item.reminded, true); assert.equal(item.status, 'finished');
      assert.equal(item.stash, undefined);
      sent.push({ text, id });
      if (fail) throw new Error('mock send failed');
    };
    const outcomes = await Promise.allSettled([f.store.tick(deliver), f.store.tick(deliver)]);
    assert.equal(outcomes.filter(x => x.status === 'rejected').length, fail ? 1 : 0);
    await f.store.tick(deliver); await f.restart().tick(deliver);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /专注已结束。结束提醒你：喝水[\s\S]*1\. 检查草稿[\s\S]*暂存已随专注结束清除/);
    assert.match(sent[0].id, /^focus-session-/);
    assert.match(f.say('暂存列表'), /没有进行中/);
    assert.equal(fs.existsSync(f.todoFile), false);
  }
});

test('transfer requires exact explicit choice, writes each once, marks entries, does not infer dates', t => {
  const f = fixture(t); f.focus('专注 1 小时');
  f.say('暂存：明天检查草稿'); f.say('暂存：休息'); f.say('暂存列表');
  assert.equal(fs.existsSync(f.todoFile), false);
  assert.equal(parse('确认'), null);
  assert.match(f.say('暂存转待办'), /已将 2 条/);
  assert.equal(f.todos.readOpenItems('owner').length, 2);
  assert.ok(f.todos.readOpenItems('owner').every(item => item.dueDate === null));
  assert.ok(f.read().sessions[0].stash.every(item => item.transferred));
  assert.match(f.say('暂存列表'), /已转待办/);
  assert.match(f.say('暂存转待办'), /未重复写入/);
  f.say('暂存：第三个想法');
  assert.match(f.say('暂存转待办'), /已将 1 条/);
  assert.equal(f.todos.readOpenItems('owner').length, 3);
});

test('transfer is idempotent if todo write succeeds but stash mark save fails', t => {
  const f = fixture(t);
  let state = { sessions: [{ status: 'active', endsAt: '2026-11-04T00:00:00Z', stash: [
    { id: 'synthetic-1', text: '想法', createdAt: '2026-11-03T09:00:00+08:00', transferred: false },
  ] }] };
  let fail = true;
  const run = createFocusStashCommands({ load: () => structuredClone(state),
    save: next => { if (fail) throw new Error('mock disk failure'); state = next; },
    now: () => Date.parse('2026-11-03T01:00:00Z'), todos: f.todos });
  assert.throws(() => run('owner', parse('暂存转待办')), /mock disk/);
  assert.equal(f.todos.readOpenItems('owner').length, 1);
  fail = false;
  assert.match(run('owner', parse('暂存转待办')), /已将 1 条/);
  assert.equal(f.todos.readOpenItems('owner').length, 1);
  assert.equal(state.sessions[0].stash[0].transferred, true);
});

test('partial transfer stops on todo capacity, retains successful marks and retries remaining items', t => {
  const f = fixture(t);
  for (let n = 0; n < 199; n++) f.todos.execute('owner', { type: 'add', text: `待办${n}`, dueDate: null });
  f.focus('专注 1 小时'); f.say('暂存：甲'); f.say('暂存：乙');
  assert.match(f.say('暂存转待办'), /已转 1 条.*其余未转/);
  assert.deepEqual(f.read().sessions[0].stash.map(item => item.transferred), [true, false]);
  f.todos.execute('owner', { type: 'cancel', number: 1 });
  assert.match(f.say('暂存转待办'), /已将 1 条/);
  const titles = f.todos.readOpenItems('owner').map(item => item.text);
  assert.equal(titles.filter(text => text === '甲').length, 1);
  assert.equal(titles.filter(text => text === '乙').length, 1);
});

test('restart discards stash while preserving focus clock, goal and reminder markers', async t => {
  const f = fixture(t); f.focus('专注 1 分钟，结束提醒我喝水'); f.say('暂存：临时想法');
  const before = f.read().sessions[0];
  const cold = f.restart();
  assert.match(cold.handleStash('owner', parse('暂存列表')), /暂无暂存/);
  const { stash, ...expected } = before;
  assert.deepEqual(f.read().sessions[0], expected);
  cold.handleStash('owner', parse('暂存：新想法'));
  assert.match(cold.handleStash('owner', parse('暂存列表')), /新想法/);
  f.advance(60000);
  assert.match(cold.handleStash('owner', parse('暂存：到期后')), /没有进行中/);
  const sent = [];
  await cold.tick(text => sent.push(text));
  assert.equal(sent.length, 1); assert.match(sent[0], /新想法/); assert.doesNotMatch(sent[0], /临时想法/);
  assert.match(cold.handle('owner', focusParse('专注 1 分钟')), /已开始/);
  assert.match(cold.handleStash('owner', parse('暂存列表')), /暂无暂存/);
});

test('corrupt persisted stash is quarantined before restart cleanup and never transferred', t => {
  const corruptions = [
    items => Array.from({ length: 11 }, (_, i) => ({ ...items[0], id: `entry-${i}` })),
    items => [items[0], { ...items[0] }],
    items => [{ ...items[0], text: ' 未修剪 ' }],
    items => [{ ...items[0], createdAt: '2026-11-03T01:00:00Z' }],
    items => [{ ...items[0], transferred: 'false' }],
  ];
  for (const corrupt of corruptions) {
    const f = fixture(t); f.focus('专注 1 小时'); f.say('暂存：检查草稿');
    const index = fs.readFileSync(f.stateFile, 'utf8');
    const reference = JSON.parse(index).sessions[0];
    const bodyFile = path.join(path.dirname(f.stateFile), reference.file);
    const body = JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
    body.stash = corrupt(body.stash);
    const damaged = JSON.stringify(body);
    fs.writeFileSync(bodyFile, damaged);
    assert.throws(() => f.restart().handleStash('owner', parse('暂存转待办')), error => {
      assert.match(error.message, /损坏.*隔离/);
      assert.equal(error.cause.message, '专注暂存格式无效');
      return true;
    });
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(fs.readFileSync(bodyFile, 'utf8'), damaged);
    const quarantined = fs.readdirSync(path.dirname(f.stateFile)).filter(name => name.startsWith('state.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), quarantined[0]), 'utf8'), index);
    assert.equal(fs.existsSync(f.todoFile), false);
  }
});

test('friend rejects every stash action before reading or writing any storage', t => {
  const f = fixture(t);
  const run = createFocusStashCommands({ load: () => assert.fail('must not read'),
    save: () => assert.fail('must not write'), now: () => assert.fail('must not inspect clock'),
    todos: { execute: () => assert.fail('must not access todos') } });
  for (const text of ['暂存：私密', '暂存：', '暂存列表', '删除暂存第1条', '暂存转待办']) {
    assert.match(run('friend', parse(text)), /仅主人/);
    assert.match(f.store.handleStash('friend', parse(text)), /仅主人/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  f.focus('专注 1 小时'); f.say('暂存：主人内容');
  const index = fs.readFileSync(f.stateFile, 'utf8'), before = f.read();
  // Even the first access after restart must not perform stash cleanup for a friend.
  const cold = f.restart();
  assert.match(cold.handleStash('friend', parse('暂存列表')), /仅主人/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.deepEqual(f.read(), before);
});
