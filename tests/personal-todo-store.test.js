'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { parsePersonalTodoCommand } = require('../src/personal-todo-commands');
const { parseSharedLifeCommand } = require('../src/shared-life-commands');
const { readRecordState, writeRecordState } = require('../src/record-state');

const NOW = Date.parse('2026-10-30T16:30:00Z');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-todo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'personal-todo', 'state.json');
  let clock = NOW;
  const store = createPersonalTodoStore({ stateFile, now: () => clock });
  return { root, stateFile, store, tick: () => { clock += 1000; },
    run: (text, side = 'owner') => store.execute(side, parsePersonalTodoCommand(text)) };
}
function seed(stateFile, todos) { writeRecordState(stateFile, { schemaVersion: 1, todos }, ['todos']); }
function item(id, status = 'open', offset = 0) {
  return { id: `TD-${id}`, text: `任务${id}`, dueDate: null, status,
    createdAt: new Date(NOW + offset).toISOString(),
    ...(status === 'done' ? { completedAt: new Date(NOW + offset).toISOString() } : {}) };
}



test('sets, queries, replaces and removes UUID dependencies without rewriting queries', t => {
  const { stateFile, run, tick } = fixture(t);
  for (const name of ['甲', '乙', '丙']) { run(`记一下 ${name}`); tick(); }
  const [a, b, c] = readRecordState(stateFile).todos;
  assert.match(a.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
  assert.equal(run('第3项前置：第1项、第2项、第1项').wrote, true);
  assert.deepEqual(readRecordState(stateFile).todos.find(x => x.id === c.id).dependencyIds, [a.id, b.id]);
  const index = fs.readFileSync(stateFile, 'utf8');
  const files = JSON.parse(index).todos.map(x => path.join(path.dirname(stateFile), x.file));
  const bodies = files.map(file => fs.readFileSync(file, 'utf8'));
  const query = run('查看第3项依赖');
  assert.equal(query.wrote, false);
  assert.match(query.reply, /第1项：甲（未完成，阻塞）\n第2项：乙（未完成，阻塞）/u);
  run('可开始的待办');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), index);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), bodies);
  assert.equal(run('移除第3项依赖：第1项').wrote, true);
  assert.deepEqual(readRecordState(stateFile).todos[2].dependencyIds, [b.id]);
  assert.equal(run('移除第3项依赖：第1项').wrote, false);
  run('第3项前置：第1项');
  assert.deepEqual(readRecordState(stateFile).todos[2].dependencyIds, [a.id]);
  const reopened = createPersonalTodoStore({ stateFile, now: () => NOW });
  assert.match(reopened.handle('owner', { type: 'dependencies', number: 3 }), /第1项：甲/u);
  run('移除第3项依赖：第1项');
  assert.match(run('查看第3项依赖').reply, /无。$/u);
});

test('ready uses only prerequisite completion, preserves list numbers and does not auto-start', t => {
  const { stateFile, run, tick } = fixture(t);
  assert.equal(run('可开始的待办').reply, '暂无可开始的待办。');
  for (const name of ['甲', '乙', '丙', '丁']) { run(`记一下 ${name}`); tick(); }
  run('第1项前置：第2项、第3项');
  run('第4项前置：第1项');
  assert.equal(run('可开始的待办').reply, '可开始的待办：\n2. 乙\n3. 丙');
  run('第2项完成');
  assert.equal(run('可开始的待办').reply, '可开始的待办：\n2. 丙');
  const done = readRecordState(stateFile).todos.find(x => x.status === 'done');
  assert.match(run('查看第1项依赖').reply, /乙（已完成，不阻塞；id：/u);
  assert.equal(run(`移除第1项依赖：${done.id}`).wrote, true);
  run('取消第2项'); // Cancel deletes the other prerequisite.
  assert.deepEqual(readRecordState(stateFile).todos.find(x => x.text === '甲').dependencyIds, []);
  assert.equal(run('可开始的待办').reply, '可开始的待办：\n1. 甲');
  assert.equal(readRecordState(stateFile).todos.find(x => x.text === '甲').status, 'open');
  run('第1项完成');
  assert.equal(run('可开始的待办').reply, '可开始的待办：\n1. 丁');
});

test('self, direct and indirect cycles and invalid numbers refuse atomically', t => {
  const { stateFile, run, tick } = fixture(t);
  for (const name of ['甲', '乙', '丙']) { run(`记一下 ${name}`); tick(); }
  run('第1项前置：第2项');
  let before = readRecordState(stateFile);
  assert.match(run('第2项前置：第1项').reply, /循环依赖/u);
  assert.deepEqual(readRecordState(stateFile), before);
  run('第2项前置：第3项');
  before = readRecordState(stateFile);
  for (const [text, message] of [
    ['第3项前置：第3项', /依赖自身/u], ['第3项前置：第1项', /循环依赖/u],
    ['第3项前置：第1项、第3项', /依赖自身/u],
    ['第3项前置：第1项、第9项', /有效序号/u], ['第3项前置：第0项', /有效序号/u],
    ['第3项前置：第9007199254740993项', /有效序号/u], ['第3项前置：', /有效序号/u],
    ['查看第0项依赖', /序号越界/u], ['移除第3项依赖：第9项', /序号越界/u],
  ]) {
    const result = run(text);
    assert.equal(result.wrote, false, text);
    assert.equal(result.continue, false, text);
    assert.match(result.reply, message);
    assert.deepEqual(readRecordState(stateFile), before);
  }
});

test('UUID links survive date and completion reordering; deleting prerequisites cleans references and bodies', t => {
  const { stateFile, run, tick } = fixture(t);
  for (const name of ['甲', '乙', '丙']) { run(`记一下 ${name}`); tick(); }
  const [a, b, c] = readRecordState(stateFile).todos;
  run('第3项前置：第2项');
  run('记一下 1月1日新排首位');
  assert.match(run('查看第4项依赖').reply, /第3项：乙/u);
  run('第2项完成'); // Complete a, renumber b to 2, c to 3.
  assert.match(run('查看第3项依赖').reply, /第2项：乙/u);
  assert.deepEqual(readRecordState(stateFile).todos.find(x => x.id === c.id).dependencyIds, [b.id]);
  assert.equal(readRecordState(stateFile).todos.find(x => x.id === a.id).status, 'done');
  const body = JSON.parse(fs.readFileSync(stateFile)).todos.find(x => x.id === b.id).file;
  run('取消第2项');
  assert.deepEqual(readRecordState(stateFile).todos.find(x => x.id === c.id).dependencyIds, []);
  assert.equal(fs.existsSync(path.join(path.dirname(stateFile), body)), false);
  assert.match(run('可开始的待办').reply, /2\. 丙/u);
});

test('completed prerequisites unblock and references are cleaned on clear and history pruning', t => {
  const { stateFile, run } = fixture(t);
  run('记一下 甲'); run('记一下 乙');
  run('第2项前置：第1项'); run('第1项完成');
  assert.equal(run('可开始的待办').reply, '可开始的待办：\n1. 乙');
  run('清空已完成');
  assert.deepEqual(readRecordState(stateFile).todos[0].dependencyIds, []);
  const old = item('old', 'done', -1000);
  seed(stateFile, [old, ...Array.from({ length: 99 }, (_, i) => item(i, 'done', i - 200)),
    item('new'), { ...item('dependent'), dependencyIds: [old.id] }]);
  run('第1项完成');
  const state = readRecordState(stateFile);
  assert.equal(state.todos.some(x => x.id === old.id), false);
  assert.deepEqual(state.todos.find(x => x.id === 'TD-dependent').dependencyIds, []);
});

test('dependency commands reject non-owner before reading private state', t => {
  const { root, run } = fixture(t);
  for (const text of ['第3项前置：第1项、第2项', '查看第1项依赖', '移除第1项依赖：第2项', '可开始的待办']) {
    assert.deepEqual(run(text, 'friend'), {
      reply: '这个私人助手只供已绑定的本人使用。', wrote: false, continue: false,
    });
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('list sorts dates then creation time, marks overdue, and numbered mutations use that list', (t) => {
  const { stateFile, run, tick } = fixture(t);
  run('记一下 无日期'); tick();
  run('记一下 后天较晚'); tick();
  run('记一下 明天同日较早'); tick();
  run('记一下 1月1日已逾期'); tick();
  run('记一下 明天同日较晚');
  assert.equal(run('我的待办').reply, [
    '1. 已逾期（到期：逾期）', '2. 同日较早（到期：明天）', '3. 同日较晚（到期：明天）',
    '4. 较晚（到期：11月2日）', '5. 无日期（到期：无到期日）',
  ].join('\n'));
  const before = readRecordState(stateFile);
  for (const text of ['第0项完成', '完成第6项', '取消第999项', '取消第9007199254740993项']) {
    assert.deepEqual({ wrote: run(text).wrote, continue: run(text).continue }, { wrote: false, continue: false });
    assert.deepEqual(readRecordState(stateFile), before);
  }
  assert.match(run('完成第2项').reply, /已完成：同日较早/u);
  assert.doesNotMatch(run('我的待办').reply, /同日较早/u);
  assert.match(run('取消第2项').reply, /已取消：同日较晚/u);
  assert.equal(readRecordState(stateFile).todos.some((entry) => entry.text === '同日较晚'), false);
  assert.match(run('第1项完成').reply, /已完成：已逾期/u);
  assert.equal(readRecordState(stateFile).todos.filter((entry) => entry.status === 'done').length, 2);
  assert.match(run('清空已完成').reply, /已清空 2 条/u);
  assert.equal(readRecordState(stateFile).todos.length, 2);
  assert.equal(run('清空已完成').wrote, false);
});

test('empty lists and invalid numbers refuse without writes; completion summary is bounded', (t) => {
  const { stateFile, run } = fixture(t);
  assert.equal(run('我的待办').reply, '暂无待办。');
  assert.equal(run('第1项完成').continue, false);
  assert.equal(run('取消第1项').wrote, false);
  assert.equal(fs.existsSync(stateFile), false);
  run(`记一下 ${'事'.repeat(100)}`);
  assert.equal(run('第1项完成').reply, `已完成：${'事'.repeat(80)}…。`);
  assert.equal(run('我的待办').reply, '暂无待办。');
});

test('bogus and null commands are refused without creating state', (t) => {
  const { stateFile, store } = fixture(t);
  for (const command of [{ type: 'bogus' }, null]) {
    assert.deepEqual(store.execute('owner', command), {
      reply: '不支持这个个人待办操作。', wrote: false, continue: false,
    });
    assert.equal(fs.existsSync(stateFile), false);
  }
});

test('friend is refused for all commands before any owner storage access', (t) => {
  const { root, stateFile, run } = fixture(t);
  for (const text of ['记一下 私人事项', '我的待办', '第1项完成', '取消第1项', '清空已完成']) {
    assert.deepEqual(run(text, 'friend'), {
      reply: '这个私人助手只供已绑定的本人使用。', wrote: false, continue: false,
    });
  }
  assert.deepEqual(fs.readdirSync(root), []);
  run('记一下 主人事项');
  const before = readRecordState(stateFile);
  assert.equal(run('取消第1项', 'friend').wrote, false);
  assert.deepEqual(readRecordState(stateFile), before);
});

test('corrupt index/schema/body or missing body is quarantined and explicitly fails without mutation', (t) => {
  for (const damage of ['json', 'schema', 'body', 'missing']) {
    const { stateFile, run } = fixture(t);
    run('记一下 保留原件');
    const index = JSON.parse(fs.readFileSync(stateFile));
    const body = path.join(path.dirname(stateFile), index.todos[0].file);
    if (damage === 'json') fs.writeFileSync(stateFile, '{broken');
    if (damage === 'schema') fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, todos: 'broken' }));
    if (damage === 'body') fs.writeFileSync(body, '{broken body');
    if (damage === 'missing') fs.rmSync(body);
    const original = fs.readFileSync(stateFile, 'utf8');
    assert.throws(() => run('记一下 不应新增'), /损坏，已隔离保全.*本次操作未执行/u);
    const files = fs.readdirSync(path.dirname(stateFile));
    const quarantined = files.find((name) => name.startsWith('state.json.corrupt-'));
    assert.ok(quarantined);
    assert.equal(fs.readFileSync(path.join(path.dirname(stateFile), quarantined), 'utf8'), original);
    assert.equal(fs.existsSync(stateFile), false);
    if (damage === 'body') assert.equal(fs.readFileSync(body, 'utf8'), '{broken body');
    if (damage !== 'missing') assert.ok(fs.existsSync(body));
  }
});

test('refuses the 201st open item, retains the latest 100 completions, clears physical bodies', (t) => {
  const { stateFile, run } = fixture(t);
  seed(stateFile, Array.from({ length: 200 }, (_, i) => item(i, 'open', i)));
  assert.match(run('记一下 超限').reply, /最多 200 条/u);
  assert.equal(run('记一下 超限').continue, false);
  assert.equal(readRecordState(stateFile).todos.length, 200);
  run('第1项完成');
  assert.equal(run('记一下 腾出一条').wrote, true);
  const history = Array.from({ length: 100 }, (_, i) => item(i, 'done', i - 200));
  seed(stateFile, [...history, item('new')]);
  const oldBody = JSON.parse(fs.readFileSync(stateFile)).todos[0].file;
  run('第1项完成');
  const state = readRecordState(stateFile);
  assert.equal(state.todos.length, 100);
  assert.ok(state.todos.some((entry) => entry.id === 'TD-new'));
  assert.ok(!state.todos.some((entry) => entry.id === 'TD-0'));
  assert.equal(fs.existsSync(path.join(path.dirname(stateFile), oldBody)), false);
  const bodies = JSON.parse(fs.readFileSync(stateFile)).todos.map((entry) => entry.file);
  run('清空已完成');
  assert.equal(readRecordState(stateFile).todos.length, 0);
  assert.ok(bodies.every((file) => !fs.existsSync(path.join(path.dirname(stateFile), file))));
});

test('legacy inline and classified records remain optional and unchanged on queries', t => {
  const { root, stateFile, store, run } = fixture(t);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const original = { ...item('old'), legacyField: 'preserve' };
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, todos: [original] }));
  const before = fs.readFileSync(stateFile, 'utf8');
  run('我的待办'); run('待办预算：30'); run('可开始的待办'); run('查看第1项依赖'); store.readOpenItems('owner');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'personal-todo', 'records')), false);
  run('记一下 新待办');
  assert.deepEqual(readRecordState(stateFile).todos[0], original);
  assert.ok(readRecordState(stateFile).todos.every(x => !Object.hasOwn(x, 'estimatedMinutes')));
  run('第1项估时：15'); run('第1项估时：20');
  assert.deepEqual(readRecordState(stateFile).todos[0], { ...original, estimatedMinutes: 20 });
  assert.equal(Object.hasOwn(readRecordState(stateFile).todos[1], 'estimatedMinutes'), false);
  const indexBefore = fs.readFileSync(stateFile, 'utf8');
  const bodyFiles = JSON.parse(indexBefore).todos.map(x => path.join(path.dirname(stateFile), x.file));
  const bodiesBefore = bodyFiles.map(x => fs.readFileSync(x, 'utf8'));
  run('待办预算：20');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), indexBefore);
  assert.deepEqual(bodyFiles.map(x => fs.readFileSync(x, 'utf8')), bodiesBefore);
});

test('budget selects complete items deterministically, uses original numbering, separates unknowns', t => {
  const { stateFile, run } = fixture(t);
  seed(stateFile, [
    { ...item(1), estimatedMinutes: 40 }, { ...item(2), estimatedMinutes: 20 },
    item(3), { ...item(4), estimatedMinutes: 10 }, { ...item(5), estimatedMinutes: 1 },
    { ...item(6, 'done'), estimatedMinutes: 1 },
  ]);
  const result = run('待办预算：30分钟');
  assert.equal(result.wrote, false);
  assert.equal(result.reply, run('待办预算：30分钟').reply);
  assert.match(result.reply, /总预计耗时：30分钟/u);
  assert.match(result.reply, /2\. 任务2（20分钟）\n4\. 任务4（10分钟）/u);
  assert.match(result.reply, /未估算（未纳入预算）：\n3\. 任务3$/u);
  assert.doesNotMatch(result.reply, /任务1|任务5|任务6/u);
  assert.match(run('待办预算：1').reply, /总预计耗时：1分钟/u);
  for (let budget = 1; budget <= 100; budget++) {
    const reply = run(`待办预算：${budget}`).reply;
    const parts = [...reply.matchAll(/（(\d+)分钟）/gu)].map(x => Number(x[1]));
    const total = Number(reply.match(/总预计耗时：(\d+)分钟/u)[1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(total <= budget);
  }
});

test('invalid estimates/budgets and non-owner queries refuse before storage access', t => {
  const { root, run, store } = fixture(t);
  for (const value of ['0', '-1', '1.5', 'abc', '9007199254740993', '', '30分钟然后发给好友']) {
    for (const text of [`待办预算：${value}`, `第1项估时：${value}`]) {
      const result = run(text);
      assert.equal(result.wrote, false);
      assert.equal(result.continue, false);
      assert.match(result.reply, /整数/u);
    }
  }
  assert.match(run('待办预算：1441').reply, /超限不会截断/u);
  for (const text of ['待办预算：30', '第1项估时：15']) {
    assert.match(run(text, 'friend').reply, /只供已绑定/u);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  assert.match(run('待办预算：30').reply, /没有可纳入预算/u);
  run('记一下 未估算');
  assert.match(run('待办预算：30').reply, /总预计耗时：0分钟[\s\S]*没有可纳入预算[\s\S]*未估算（未纳入预算）：\n1\. 未估算/u);
  for (const number of [0, 2, NaN]) assert.equal(store.execute('owner', { type: 'estimate', number, estimatedMinutes: 5 }).continue, false);
  assert.equal(store.execute('owner', { type: 'add', text: '坏值', estimatedMinutes: null }).continue, false);
  store.execute('owner', { type: 'add', text: '显式估时', estimatedMinutes: 50 });
  assert.match(run('待办预算：30').reply, /没有可纳入预算/u);
  assert.match(run('我的待办').reply, /预估：50分钟/u);
});
