'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLifeCombo, parseLifeComboCommand: parse } = require('../src/life-combo-commands');
const { createLifeComboProvider } = require('../src/life-combo-provider');
const { writeRecordState, readRecordState } = require('../src/record-state');
const fail = () => assert.fail('dependency must not be called');
function fixture(t, counts = [2, 2, 2], model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-life-combo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['todos', 'places', 'habits'].map(name => path.join(dir, name, 'state.json'));
  const createdAt = '2026-11-01T00:00:00Z';
  const rows = counts.map((count, n) => Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`, createdAt, status: n === 0 ? 'open' : 'active',
    ...(n === 0 ? { text: `待办${i}`, dueDate: null } : n === 1 ? { name: `地点${i}`, addedBy: 'owner' }
      : { name: `习惯${i}`, archivedAt: null, days: [] }),
  })));
  // These records must not enter the candidate pool.
  rows[0].push({ id: 'done', text: '排除完成待办', status: 'done', dueDate: null, createdAt, completedAt: createdAt });
  rows[1].push({ id: 'peer', name: '排除好友地点', addedBy: 'friend', status: 'active' },
    { id: 'visited', name: '排除已去地点', addedBy: 'owner', status: 'visited' });
  rows[2].push({ id: 'archived', name: '排除归档习惯', createdAt, archivedAt: createdAt, status: 'archived', days: ['2026-11-01'] });
  ['todos', 'places', 'habits'].forEach((key, n) => writeRecordState(files[n], { schemaVersion: 1, [key]: rows[n] }, [key]));
  const todos = require('../src/personal-todo-store').createPersonalTodoStore({ stateFile: files[0] });
  const places = require('../src/shared-place-box').createSharedPlaceBox({ stateFile: files[1] });
  const habits = require('../src/habit-store').createHabitStore({ stateFile: files[2] });
  const inputs = []; let numbers = [0, 0];
  const provider = createLifeComboProvider({ model: async (...args) => {
    inputs.push(args);
    return model ? model(...args) : { ok: true, value: { compatible: true, reverse: false, mode: '依次进行' } };
  } });
  const combo = createLifeCombo({ todos, places, habits, provider, random: () => numbers.shift() ?? 0 });
  return { dir, files, rows, todos, places, habits, inputs, combo,
    random: values => { numbers = values; }, run: (text = '合成任务', session) => combo.execute('owner', parse(text), session) };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter(name => fs.statSync(path.join(dir, name)).isFile())
    .sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}


test('0 and 1 candidates never call model; missing stores never created', async t => {
  for (const count of [0, 1]) {
    const f = fixture(t, [count, 0, 0]), before = snapshot(f.dir);
    const result = await f.run();
    assert.match(result.reply, count ? /仅有 1 项，仅展示该条/u : /暂无可组合内容，请先添加/u);
    assert.equal(f.inputs.length, 0); assert.deepEqual(snapshot(f.dir), before);
  }
  const f = fixture(t, [0, 0, 0]);
  const store = require('../src/habit-store').createHabitStore({ stateFile: path.join(f.dir, 'missing/state.json') });
  assert.deepEqual(store.readActiveItems('owner'), []);
  assert.equal(fs.existsSync(path.join(f.dir, 'missing')), false);
});

test('incompatible pair explicitly refuses combination and shows two original points', async t => {
  const f = fixture(t, [1, 0, 1], async () => ({ ok: true, value: { compatible: false, reverse: false, mode: '依次进行' } }));
  const result = await f.run();
  assert.match(result.reply, /这两项暂不适合合成/u); assert.match(result.reply, /待办0/u); assert.match(result.reply, /习惯0/u);
  assert.doesNotMatch(result.reply, /组合建议/u);
});
