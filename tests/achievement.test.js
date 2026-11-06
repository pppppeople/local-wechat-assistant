'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAchievementStore } = require('../src/achievement-store');
const { parseAchievementCommand } = require('../src/achievement-commands');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-achievement-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'achievements', 'state.json');
  let clock = Date.parse('2026-10-30T16:00:00Z');
  let roll = 0;
  const store = createAchievementStore({ stateFile, now: () => clock, random: () => roll });
  return { dir, stateFile, store, setTime: value => { clock = Date.parse(value); }, setRandom: value => { roll = value; },
    run: text => store.execute('owner', parseAchievementCommand(text)), read: () => readRecordState(stateFile, {}) };
}



test('explicit commands only; malformed input and delimiters', () => {
  for (const text of ['我的成就', '打开成就博物馆']) assert.equal(parseAchievementCommand(text).type, 'list');
  assert.equal(parseAchievementCommand('随机回顾一个成就').type, 'recall');
  assert.deepEqual(parseAchievementCommand('记录成就: 学会游泳 | 昨天 | 运动 '), { type: 'add', name: '学会游泳', date: '昨天', note: '运动' });
  for (const text of ['记录成就', '记录成就： ', '记录成就：A｜今天｜备注｜多余', '删成就：']) assert.equal(parseAchievementCommand(text).type, 'invalid');
  for (const text of ['今天完成了交付', '从我的待办总结成就', '我想记录成就']) assert.equal(parseAchievementCommand(text), null);
});

test('owner only: every operation refused before storage access', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, '{broken');
  for (const type of ['add', 'list', 'recall', 'delete']) {
    const result = f.store.execute('friend', { type, name: '秘密' });
    assert.equal(result.wrote, false);
    assert.match(result.reply, /只供已绑定的本人/u);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken');
  assert.throws(() => f.run('我的成就'), /隔离保全/u);
  assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
});

test('parseable invalid achievement rows are quarantined without replacing their originals', t => {
  const row = { id: 'achievement-1', name: '完成合成练习', date: '2026-10-31', note: '练习',
    createdAt: '2026-10-30T16:00:00Z' };
  const invalidRows = [
    [{ ...row, date: '2026-02-30' }], [{ ...row, name: '  ' }],
    [{ ...row, note: null }], [{ ...row, createdAt: 'invalid' }],
    [row, { ...row, name: '另一项成就' }],
    [row, { ...row, id: 'achievement-2', note: '同名同日的另一条' }],
  ];
  for (const entries of invalidRows) {
    const f = fixture(t), dir = path.dirname(f.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({ schemaVersion: 1, entries });
    fs.writeFileSync(f.stateFile, original);
    assert.throws(() => f.run('我的成就'), error => {
      assert.match(error.message, /已隔离保全.*本次操作未执行/u);
      assert.equal(error.cause.message, '成就博物馆存储格式无效');
      return true;
    });
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('state.json.corrupt-'));
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), original);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
});

test('Shanghai date default and midnight; explicit past dates and notes survive classified reload', t => {
  const f = fixture(t);
  f.setTime('2026-10-30T15:59:59Z');
  f.run('记录成就：完成交付');
  f.setTime('2026-10-30T16:00:00Z');
  f.run('记录成就：完成交付');
  f.run('记录成就：学会游泳｜2025-02-01｜运动');
  f.run('记录成就：演讲｜10月1日｜工作');
  f.run('记录成就：跑步｜昨天');
  f.run('记录成就：读书｜前天');
  assert.deepEqual(f.read().entries.map(item => item.date), ['2026-10-30', '2026-10-31', '2025-02-01', '2026-10-01', '2026-10-30', '2026-10-29']);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(index.entries[0].name, undefined);
  assert.match(index.entries[0].file, /^records\/entries\/entries\/2026\/10\//u);
  const reload = createAchievementStore({ stateFile: f.stateFile });
  assert.match(reload.handle('owner', { type: 'list' }), /学会游泳｜2025-02-01｜运动/u);
});

test('same name and day deduplicates without overwriting note or writing', t => {
  const f = fixture(t);
  f.run('记录成就：跑步｜今天｜运动');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const result = f.run('记录成就：跑步｜2026-10-31｜不同备注');
  assert.equal(result.wrote, false);
  assert.match(result.reply, /已存在/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(f.read().entries[0].note, '运动');
});

test('list sorts by achievement date descending and caps at 20 with total', t => {
  const f = fixture(t);
  for (let day = 1; day <= 23; day++) f.run(`记录成就：成就${day}｜2026-10-${String(day).padStart(2, '0')}`);
  const reply = f.run('我的成就').reply;
  assert.match(reply, /共 23 条，先列最近 20 条/u);
  assert.match(reply, /1\. 成就23｜2026-10-23/u);
  assert.match(reply, /20\. 成就4｜2026-10-04/u);
  assert.equal(reply.split('\n').length, 21);
  assert.doesNotMatch(reply, /成就3｜/u);
});

test('random review selects different entries and computes Shanghai calendar days including today', t => {
  const f = fixture(t);
  f.run('记录成就：过去成就｜2026-08-06｜工作');
  f.run('记录成就：今日成就');
  assert.match(f.run('随机回顾一个成就').reply, /今日成就｜2026-10-31\n这是今天的事/u);
  f.setRandom(0.999);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('随机回顾一个成就').reply, /过去成就｜2026-08-06｜工作\n这是 86 天前的事/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
});

test('empty and invalid requests do not create storage', t => {
  const f = fixture(t);
  for (const text of ['我的成就', '随机回顾一个成就']) assert.match(f.run(text).reply, /暂无成就/u);
  for (const text of ['记录成就：', '记录成就：A｜2026-02-30', '记录成就：A｜明天', '删成就：不存在', '记录成就：A｜乱码']) assert.equal(f.run(text).wrote, false);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('delete chooses latest same name, supports date, refuses ambiguity and missing names; removes body', t => {
  const f = fixture(t);
  f.run('记录成就：交付｜2026-10-20');
  f.run('记录成就：交付｜2026-10-01');
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match(f.run('删成就：交付').reply, /同名最近一条：交付｜2026-10-20/u);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), index.entries[0].file)), false);
  f.run('记录成就：交付客户A');
  f.run('记录成就：交付客户B');
  assert.equal(f.run('删成就：交付客户').wrote, false);
  assert.match(f.run('删成就：交付客户').reply, /带日期说得更具体/u);
  assert.equal(f.run('删成就：交付｜2026-10-01').wrote, true);
  assert.match(f.run('删成就：不存在').reply, /没有找到/u);
  assert.equal(f.read().entries.length, 2);
});
