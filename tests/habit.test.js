'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHabitStore } = require('../src/habit-store');
const { parseHabitCommand } = require('../src/habit-commands');
const { readRecordState } = require('../src/record-state');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-habit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'habits', 'state.json');
  let clock = Date.parse('2026-10-30T15:59:59Z');
  const now = () => clock;
  const store = createHabitStore({ stateFile, now });
  return { dir, stateFile, store, now, setTime: value => { clock = Date.parse(value); },
    run: text => store.execute('owner', parseHabitCommand(text)), read: () => readRecordState(stateFile, {}) };
}


test('explicit grammar preserves long-term custom names; excludes bingo/pair/natural inference', () => {
  assert.deepEqual(parseHabitCommand(' 创建习惯: 阅读 '), { type: 'create', name: '阅读' });
  for (const text of ['创建习惯', '习惯打卡：', '习惯统计：A\nB', '我的习惯顺便发给好友']) assert.equal(parseHabitCommand(text).type, 'invalid');
  for (const text of ['今日生活Bingo', '共同目标打卡', '我今天跑步了', '帮我养成阅读习惯']) assert.equal(parseHabitCommand(text), null);
});

test('every action refuses friend/unknown before accessing storage', t => {
  const f = fixture(t);
  for (const side of ['friend', '', undefined]) for (const type of ['create', 'check', 'uncheck', 'stats', 'list', 'archive']) {
    assert.equal(f.store.execute(side, { type, name: '阅读' }).wrote, false);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('create never completes; exact names, duplicates and invalid commands do not write', t => {
  const f = fixture(t);
  assert.equal(f.run('创建习惯：阅读').wrote, true);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const text of ['创建习惯：阅读', '习惯打卡：读', '习惯打卡：', '我的习惯']) assert.equal(f.run(text).wrote, false);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.deepEqual(f.read().habits[0].days, []);
});

test('Shanghai midnight, repeat idempotence, restart and stats', t => {
  const f = fixture(t);
  f.run('创建习惯：阅读');
  f.run('习惯打卡：阅读');
  assert.equal(f.run('习惯打卡：阅读').wrote, false);
  f.setTime('2026-10-30T16:00:00Z');
  assert.match(f.run('习惯统计：阅读').reply, /连续 1 天｜累计 1 天｜今天未打卡/u);
  f.run('习惯打卡：阅读');
  const reload = createHabitStore({ stateFile: f.stateFile, now: f.now });
  assert.match(reload.handle('owner', { type: 'stats', name: '阅读' }), /连续 2 天｜累计 2 天/u);
  assert.deepEqual(f.read().habits[0].days, ['2026-10-30', '2026-10-31']);
});

test('cancel only today, no previous-day deletion, gap resets streak but retains total', t => {
  const f = fixture(t);
  f.run('创建习惯：阅读'); f.run('习惯打卡：阅读');
  f.setTime('2026-10-30T16:00:00Z');
  assert.equal(f.run('取消习惯打卡：阅读').wrote, false);
  f.run('习惯打卡：阅读'); f.run('取消习惯打卡：阅读');
  assert.deepEqual(f.read().habits[0].days, ['2026-10-30']);
  f.run('习惯打卡：阅读');
  f.setTime('2026-11-02T00:00:00Z');
  assert.match(f.run('习惯统计：阅读').reply, /连续 0 天｜累计 2 天/u);
  f.run('习惯打卡：阅读');
  assert.match(f.run('习惯统计：阅读').reply, /连续 1 天｜累计 3 天/u);
});

test('month/year and leap day continuity uses calendar dates', t => {
  const f = fixture(t);
  for (const dates of [['2028-02-28', '2028-02-29', '2028-03-01'], ['2028-12-31', '2029-01-01']]) {
    f.setTime(`${dates[0]}T00:00:00Z`); f.run(`创建习惯：${dates[0]}`);
    for (const day of dates) { f.setTime(`${day}T00:00:00Z`); f.run(`习惯打卡：${dates[0]}`); }
    assert.match(f.run(`习惯统计：${dates[0]}`).reply, new RegExp(`连续 ${dates.length} 天｜累计 ${dates.length} 天`, 'u'));
  }
});

test('archive retains body and freezes stats; all later mutations refused', t => {
  const f = fixture(t);
  f.run('创建习惯：阅读'); f.run('习惯打卡：阅读'); f.run('归档习惯：阅读');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  f.setTime('2026-12-01T00:00:00Z');
  for (const text of ['创建习惯：阅读', '习惯打卡：阅读', '取消习惯打卡：阅读', '归档习惯：阅读']) assert.equal(f.run(text).wrote, false);
  assert.match(f.run('我的习惯').reply, /已归档｜连续 1 天｜累计 1 天/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  const index = JSON.parse(before);
  assert.equal(index.habits[0].name, undefined);
  assert.match(index.habits[0].file, /^records\/habits\/habits\/2026\/10\//u);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), index.habits[0].file)), true);
  assert.equal(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.tmp-')), false);
});

test('corrupt JSON, malformed body and missing body quarantine index and preserve available originals', t => {
  for (const corruption of ['json', 'shape', 'missing']) {
    const f = fixture(t); f.run('创建习惯：阅读');
    const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    const body = path.join(path.dirname(f.stateFile), index.habits[0].file);
    if (corruption === 'json') fs.writeFileSync(f.stateFile, '{broken');
    if (corruption === 'shape') { const item = JSON.parse(fs.readFileSync(body)); item.days = ['2026-02-30']; fs.writeFileSync(body, JSON.stringify(item)); }
    if (corruption === 'missing') fs.unlinkSync(body);
    assert.throws(() => f.run('我的习惯'), /隔离保全/u);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
    if (corruption !== 'missing') assert.equal(fs.existsSync(body), true);
  }
});
