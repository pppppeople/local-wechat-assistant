'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHabitCalendar, parseHabitCalendarCommand: parse, summarizeHabitCalendar, REFUSAL } = require('../src/habit-calendar-commands');
const { createHabitStore } = require('../src/habit-store');
const { writeRecordState } = require('../src/record-state');
const { addDays } = require('../src/personal-todo-commands');

function habit(days = [], extra = {}) {
  return { id: 'reading', name: '阅读', status: 'active', createdAt: '2026-01-01T00:00:00Z', archivedAt: null, days, ...extra };
}
function fixture(t, habits = [], time = '2026-11-03T00:00:00Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-habit-calendar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'habits', 'state.json');
  writeRecordState(stateFile, { schemaVersion: 1, habits }, ['habits']);
  let clock = Date.parse(time);
  const now = () => clock;
  const calendar = createHabitCalendar({ stateFile, now });
  return { dir, stateFile, now, calendar, setTime: time => { clock = Date.parse(time); },
    run: text => calendar.execute('owner', parse(text)) };
}
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)).map(([name, text]) => [`${entry.name}/${name}`, text])
      : [[entry.name, fs.readFileSync(file, 'utf8')]];
  }));
}
function assertRow(reply, count, size, rate, longest, chars) {
  assert.ok(reply.startsWith('图例：■ 已打卡，· 未打卡'));
  assert.ok(reply.includes(`完成 ${count}/${size} 天｜完成率 ${rate}%｜最长连续打卡 ${longest} 天`), reply);
  assert.ok(reply.split('\n').includes(chars), reply);
  assert.equal([...chars].length, size);
}



test('grammar trims, defaults to 30 and combines a window with an exact name', () => {
  assert.deepEqual(parse(' 习惯热力图 '), { type: 'calendar', windowDays: 30, name: null });
  assert.deepEqual(parse('习惯热力图： 阅读 '), { type: 'calendar', windowDays: 30, name: '阅读' });
  for (const windowDays of [7, 14, 30]) {
    assert.deepEqual(parse(` 习惯热力图 ${windowDays}天 `), { type: 'calendar', windowDays, name: null });
    assert.deepEqual(parse(`习惯热力图 ${windowDays} 天: 阅读`), { type: 'calendar', windowDays, name: '阅读' });
  }
});

test('7/14/30 count actual inclusive calendar days, exclude outside dates and round rates', t => {
  const f = fixture(t, [habit(['2026-10-04', '2026-10-05', '2026-10-20', '2026-10-21', '2026-10-28', '2026-10-29',
    '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'])]);
  const before = snapshot(f.dir);
  const samples = [
    [7, 6, 85.7, '2026-10-28', '■■·■■■■'],
    [14, 7, 50, '2026-10-21', '■······■■·■■■■'],
    [30, 9, 30, '2026-10-05', '■' + '·'.repeat(14) + '■■' + '·'.repeat(6) + '■■·■■■■'],
  ];
  for (const [size, count, rate, first, chars] of samples) {
    const result = f.run(`习惯热力图 ${size}天`);
    assert.equal(result.wrote, false);
    assert.ok(result.reply.includes(`${first} 至 2026-11-03（含今天，共 ${size} 天）`));
    assertRow(result.reply, count, size, rate, 4, chars);
  }
  assert.equal(f.run('习惯热力图').reply, f.run('习惯热力图 30天').reply);
  assert.deepEqual(snapshot(f.dir), before);
});

test('gaps reset streak, longest stays within window, duplicate/unsorted dates count once', t => {
  const f = fixture(t, [habit(['2026-11-03', '2026-10-30', '2026-10-28', '2026-10-28', '2026-10-29', '2026-11-01',
    '2026-10-27', '2026-10-26', '2026-10-25'])]);
  assertRow(f.run('习惯热力图 7天').reply, 5, 7, 71.4, 3, '■■■·■·■');
  const days = Array.from({ length: 7 }, (_, i) => addDays('2026-10-28', i));
  assert.deepEqual(summarizeHabitCalendar(habit(days), days), { completed: 7, rate: 100, longest: 7, calendar: '■■■■■■■' });
});

test('month/year boundaries and leap February 29 retain one character per calendar day', t => {
  const leap = fixture(t, [habit(['2028-02-28', '2028-02-29', '2028-03-01'])], '2028-03-01T00:00:00Z');
  assertRow(leap.run('习惯热力图 7天').reply, 3, 7, 42.9, 3, '····■■■');
  assert.match(leap.run('习惯热力图 7天').reply, /2028-02-24 至 2028-03-01/u);
  const year = fixture(t, [habit(['2028-12-31', '2029-01-01', '2029-01-02'])], '2029-01-02T00:00:00Z');
  assertRow(year.run('习惯热力图 7天').reply, 3, 7, 42.9, 3, '····■■■');
  assert.match(year.run('习惯热力图 7天').reply, /2028-12-27 至 2029-01-02/u);
});

test('window ends at Shanghai today, crossing UTC 16:00 exactly', t => {
  const f = fixture(t, [habit(['2026-10-31', '2026-11-01'])], '2026-10-31T15:59:59Z');
  assertRow(f.run('习惯热力图 7天').reply, 1, 7, 14.3, 1, '······■');
  assert.match(f.run('习惯热力图 7天').reply, /至 2026-10-31/u);
  f.setTime('2026-10-31T16:00:00Z');
  assertRow(f.run('习惯热力图 7天').reply, 2, 7, 28.6, 2, '·····■■');
  assert.match(f.run('习惯热力图 7天').reply, /至 2026-11-01/u);
});

test('empty records and records outside window explicitly say no data and keep full denominator', t => {
  for (const days of [[], ['2026-01-01']]) {
    const f = fixture(t, [habit(days, { createdAt: '2026-11-03T00:00:00Z' })]);
    assertRow(f.run('习惯热力图 7天').reply, 0, 7, 0, 0, '·······');
    assert.match(f.run('习惯热力图 7天').reply, /本窗口无打卡记录，无数据/u);
  }
});

test('no habits, missing storage and unknown exact name return no data without creating files', t => {
  const f = fixture(t);
  assert.match(f.run('习惯热力图').reply, /暂无进行中的习惯，无数据/u);
  assert.match(f.run('习惯热力图：读').reply, /未找到这个习惯，无数据/u);
  const before = snapshot(f.dir);
  const missing = createHabitCalendar({ stateFile: path.join(f.dir, 'missing/state.json'), now: f.now });
  assert.match(missing.execute('owner', parse('习惯热力图')).reply, /无数据/u);
  assert.deepEqual(snapshot(f.dir), before);
});

test('default includes every active habit; archived history is explicit only and frozen stats stay unchanged', t => {
  const f = fixture(t, [habit(['2026-11-01', '2026-11-02'], { status: 'archived', archivedAt: '2026-11-02T00:00:00Z' }),
    habit([], { id: 'running', name: '跑步' }), habit(['2026-11-03'], { id: 'water', name: '喝水' })]);
  const store = createHabitStore({ stateFile: f.stateFile, now: f.now });
  const stats = store.execute('owner', { type: 'stats', name: '阅读' }).reply;
  const before = snapshot(f.dir);
  const all = f.run('习惯热力图').reply;
  assert.doesNotMatch(all, /阅读/u); assert.match(all, /跑步/u); assert.match(all, /喝水/u);
  const archived = f.run('习惯热力图 7天：阅读').reply;
  assert.match(archived, /阅读（已归档，历史只读）/u);
  assert.doesNotMatch(archived, /跑步|喝水/u);
  assertRow(archived, 2, 7, 28.6, 2, '····■■·');
  assert.equal(store.execute('owner', { type: 'stats', name: '阅读' }).reply, stats);
  assert.deepEqual(snapshot(f.dir), before);
  const onlyArchived = fixture(t, [habit(['2026-11-01'], { status: 'archived', archivedAt: '2026-11-01T00:00:00Z' })]);
  assert.match(onlyArchived.run('习惯热力图').reply, /暂无进行中的习惯，无数据/u);
  assert.match(onlyArchived.run('习惯热力图：阅读').reply, /已归档/u);
  const dates = ['2026-11-01', '2026-11-02', '2026-11-03'];
  assert.equal(summarizeHabitCalendar(habit(dates, { status: 'archived', archivedAt: '2026-11-01T00:00:00Z' }), dates).completed, 1);
});

test('invalid windows/grammar refuse before reading storage and list all supported windows', () => {
  const calendar = createHabitCalendar({ readState: () => assert.fail('invalid command must not read') });
  for (const text of ['习惯热力图 60天', '习惯热力图 60 天', '习惯热力图 0天', '习惯热力图 -7天', '习惯热力图 7.5天',
    '习惯热力图 七天', '习惯热力图：', '习惯热力图：A\nB']) {
    assert.equal(parse(text).type, 'invalid', text);
    const result = calendar.execute('owner', parse(text));
    assert.equal(result.wrote, false); assert.equal(result.continue, false);
    assert.match(result.reply, /7\/14\/30/u);
  }
});

test('friend and unknown sides explicitly refuse valid and invalid queries before any storage access', () => {
  const calendar = createHabitCalendar({ readState: () => assert.fail('unauthorized storage read') });
  for (const side of ['friend', 'stranger', '', undefined]) for (const text of ['习惯热力图', '习惯热力图：秘密', '习惯热力图 60天']) {
    assert.deepEqual(calendar.execute(side, parse(text)), { reply: REFUSAL, wrote: false, continue: false });
  }
});

test('corrupt or missing bodies fail explicitly, with no writes or quarantine', t => {
  for (const corruption of ['json', 'date', 'missing', 'shape']) {
    const f = fixture(t, [habit()]);
    const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    const body = path.join(path.dirname(f.stateFile), index.habits[0].file);
    if (corruption === 'json') fs.writeFileSync(f.stateFile, '{broken');
    if (corruption === 'date') fs.writeFileSync(body, JSON.stringify(habit(['2026-02-30'])));
    if (corruption === 'missing') fs.unlinkSync(body);
    if (corruption === 'shape') fs.writeFileSync(f.stateFile, '{}');
    const before = snapshot(f.dir);
    const result = f.run('习惯热力图');
    assert.equal(result.continue, false); assert.match(result.reply, /读取未完成/u);
    assert.deepEqual(snapshot(f.dir), before);
  }
});
