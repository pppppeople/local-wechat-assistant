'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectDailyTopThree, dailyTopThreeReply } = require('../src/daily-top-three');
const { parsePersonalTodoCommand } = require('../src/personal-todo-commands');
const { createPersonalTodoStore } = require('../src/personal-todo-store');

const TODAY = '2026-11-01';
const NOW = Date.parse('2026-10-31T16:00:00Z');
const item = (id, dueDate = null, extra = {}) => ({
  id, text: `事项${id}`, dueDate, status: 'open', createdAt: '2026-10-01T00:00:00Z', ...extra,
});
const ids = todos => selectDailyTopThree(todos, TODAY).map(x => x.id);



test('overdue precedes today, today precedes future, and only the first three are selected', () => {
  assert.deepEqual(ids([item('future', '2026-11-02'), item('today', TODAY),
    item('late', '2026-10-30'), item('none')]), ['late', 'today', 'future']);
});

test('nearest deadline precedes later deadlines and undated items regardless of creation time', () => {
  assert.deepEqual(ids([item('none'), item('later', '2026-11-08'), item('near', '2026-11-03')]),
    ['near', 'later', 'none']);
});

test('same group uses due date then creation time; exact ties preserve input order deterministically without mutation', () => {
  const todos = [item('last', '2026-10-30'), item('first', '2026-10-29'),
    item('older', '2026-10-30', { createdAt: '2026-09-01T00:00:00Z' }), item('tie', '2026-10-30')];
  const before = structuredClone(todos);
  for (const todo of todos) Object.freeze(todo);
  Object.freeze(todos);
  assert.deepEqual(ids(todos), ['first', 'older', 'last']);
  assert.deepEqual(ids(todos), ids(todos));
  assert.deepEqual(ids(todos.slice(0, 1).concat(todos.slice(3))), ['last', 'tie']);
  assert.deepEqual(todos, before);
  assert.deepEqual(ids([item('new'), item('old', null, { createdAt: '2026-09-01T00:00:00Z' })]), ['old', 'new']);
});

test('done and cancelled excluded; any open prerequisite blocks; completed prerequisite does not', () => {
  assert.deepEqual(ids([item('done', null, { status: 'done' }), item('cancelled', null, { status: 'cancelled' }),
    item('blocked', '2026-10-01', { dependencyIds: ['done', 'prerequisite'] }),
    item('ready', TODAY, { dependencyIds: ['done'] }), item('prerequisite')]), ['ready', 'prerequisite']);
});

test('fewer than three show actual count and original text, with due labels and explicit empty state', () => {
  const reply = todos => dailyTopThreeReply('owner', { readOpenItems: () => todos }, NOW);
  assert.equal(reply([]), '每日三件事（2026-11-01）：暂无可开始的待办。');
  assert.match(reply([item('only')]), /1\. 事项only（到期：无到期日）\n.*实际 1 项/u);
  assert.doesNotMatch(reply([item('only')]), /2\./u);
  assert.match(reply([item('late', '2026-10-31'), item('today', TODAY)]),
    /事项late（到期：逾期）\n2\. 事项today（到期：今天到期）\n.*实际 2 项/u);
  assert.match(reply([item('future', '2026-11-02', { text: '原文，空格 保留！' })]),
    /原文，空格 保留！（到期：11月2日）/u);
  assert.match(reply([item('done', null, { status: 'done' })]), /暂无可开始/u);
});

test('friend refused before reading private items', () => {
  const result = dailyTopThreeReply('friend', { readOpenItems: () => assert.fail('private read') }, NOW);
  assert.equal(result, '这个私人助手只供已绑定的本人使用。');
});

test('real store reads remain byte-for-byte unchanged, including missing store and legacy state', t => {
  const f = fixture(t);
  assert.match(dailyTopThreeReply('owner', f.store, NOW), /暂无可开始/u);
  assert.deepEqual(snapshot(f.dir), []);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, JSON.stringify({ schemaVersion: 1, todos: [
    item('done', null, { status: 'done', completedAt: '2026-10-31T00:00:00Z' }),
    item('ready', TODAY, { dependencyIds: ['done'] }),
    item('blocked', '2026-10-01', { dependencyIds: ['ready'] }),
  ] }));
  const before = snapshot(f.dir);
  const reply = dailyTopThreeReply('owner', f.store, NOW);
  assert.match(reply, /事项ready/u);
  assert.doesNotMatch(reply, /事项done|事项blocked/u);
  assert.deepEqual(snapshot(f.dir), before);
});

test('broken indexes, missing bodies, dangling dependencies and cycles fail visibly without repairs or quarantine', async t => {
  for (const kind of ['index', 'body', 'dangling', 'cycle']) {
    const f = fixture(t);
    f.store.execute('owner', { type: 'add', text: '不得泄露半成品' });
    if (kind === 'index') fs.writeFileSync(f.stateFile, '{broken');
    else if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile));
      fs.unlinkSync(path.join(path.dirname(f.stateFile), index.todos[0].file));
    } else fs.writeFileSync(f.stateFile, JSON.stringify({ schemaVersion: 1, todos: [
      item('a', null, { dependencyIds: [kind === 'cycle' ? 'a' : 'absent'] }),
    ] }));
    const before = snapshot(f.dir);
    assert.throws(() => dailyTopThreeReply('owner', f.store, NOW));
    assert.deepEqual(snapshot(f.dir), before);
  }
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-top-three-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'todos', 'state.json');
  const store = createPersonalTodoStore({ stateFile, now: () => NOW });
  return { dir, stateFile, store };
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}
