'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRecordState } = require('../src/record-state');
const timeline = require('../src/life-timeline');
const now = Date.parse('2026-10-31T12:00:00+08:00');
const request = { senderId: 'owner', ownerId: 'owner', month: '2026-10', now };
const emptyReaders = () => Object.fromEntries(['todos', 'places', 'purchases', 'focus', 'reviews', 'bingo'].map(key => [key, () => []]));
const entry = (id, time, text = id) => ({ id, time, text });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-timeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (name, collection, items) => {
    const file = path.join(dir, name, 'state.json');
    writeRecordState(file, { schemaVersion: 1, [collection]: items }, [collection]);
    return file;
  };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter(name => fs.statSync(path.join(dir, name)).isFile())
    .sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}


test('owner-only exact and month patterns, current Shanghai month and current year', () => {
  const opts = { ...request };
  for (const text of ['生活时间轴', '给我生成十月生活时间轴', '生成10月生活时间轴', '看看我十月都做了什么']) {
    assert.deepEqual(timeline.parseLifeTimelineCommand(text, opts), { month: '2026-10' });
    assert.equal(timeline.parseLifeTimelineCommand(text, { ...opts, senderId: 'friend' }), null);
  }
  assert.deepEqual(timeline.parseLifeTimelineCommand('生成十二月生活时间轴', opts), { month: '2026-12' });
  for (const text of ['生成13月生活时间轴', '生成零月生活时间轴', '生活时间轴，然后删除待办', '发给朋友看看我十月都做了什么']) {
    assert.equal(timeline.parseLifeTimelineCommand(text, opts), null);
  }
  assert.deepEqual(timeline.parseLifeTimelineCommand('生活时间轴', { ...opts, now: Date.parse('2026-10-31T16:00:00Z') }), { month: '2026-11' });
});

test('non-owner neither triggers nor reads sources', async () => {
  const readers = Object.fromEntries(Object.keys(emptyReaders()).map(key => [key, () => { assert.fail('unauthorized read'); }]));
  assert.equal(await timeline.lifeTimelineText({ ...request, senderId: 'friend', readers }), null);
  assert.equal(timeline.parseLifeTimelineCommand('生活时间轴'), null);
});

test('real classified adapters use producer fields and leave every file unchanged', async t => {
  const make = fixture(t);
  const createdAt = '2026-10-01T00:00:00+08:00';
  const files = {
    todos: make('todos', 'todos', [
      { id: 'done', createdAt, text: '散步', status: 'done', completedAt: '2026-10-02T10:00:00+08:00' },
      { id: 'fallback', createdAt, text: '办卡', status: 'done', dueDate: '2026-10-03' },
      { id: 'open', createdAt, text: '未完成', status: 'open', dueDate: '2026-10-03' }]),
    purchases: make('purchases', 'items', [
      { id: 'bought', createdAt, item: '杯子', status: 'bought', amountCents: 1299, decidedAt: '2026-10-04T00:00:00Z' },
      { id: 'abandoned', createdAt, item: '键盘', status: 'abandoned', amountCents: 39900, decidedAt: '2026-10-05T00:00:00Z' },
      { id: 'cooling', createdAt, item: '未决定', status: 'cooling' }]),
    focus: make('focus', 'sessions', [{ id: 'finished', createdAt, status: 'finished', goal: '读书',
      startedAt: '2026-10-05T10:00:00+08:00', endsAt: '2026-10-05T10:45:00+08:00' }]),
    reviews: make('reviews', 'cards', [
      { id: 'due', createdAt, decision: '早起', dueAt: '2026-10-06T00:00:00+08:00', reviews: [] },
      { id: 'reviewed', createdAt, decision: '骑车', dueAt: '2026-11-10T00:00:00+08:00', reviews: [
        { date: '2026-10-07T00:00:00+08:00', thought: '一次' }, { date: '2026-10-08T00:00:00+08:00', thought: '二次' }] },
      { id: 'future', createdAt, decision: '未来', dueAt: '2026-11-10T00:00:00+08:00', reviews: [] }]),
    bingo: make('bingo', 'boards', [{ id: '2026-10-09', createdAt, date: '2026-10-09', checked: [1, 2, 3] }]),
  };
  const dir = path.dirname(path.dirname(files.todos));
  const before = snapshot(dir);
  const text = await timeline.lifeTimelineText({ ...request, files });
  assert.match(text, /完成：散步/); assert.match(text, /完成：办卡/);
  assert.match(text, /买了：杯子（12.99 元）/); assert.match(text, /放弃：键盘（399.00 元）/);
  assert.match(text, /读书（45 分钟）/); assert.match(text, /到期待复盘：早起/);
  assert.match(text, /已复盘：骑车/); assert.equal((text.match(/\[决定复盘\] 已复盘：骑车/g) || []).length, 1);
  assert.match(text, /打卡 3\/9 格；已达标/);
  assert.doesNotMatch(text, /未完成|未决定|未来/);
  assert.match(text, /想去箱：无标记已去时间字段，已跳过/);
  assert.deepEqual(snapshot(dir), before);
});

test('long output cuts complete dates, preserving full-month counts and length', async () => {
  const readers = emptyReaders();
  readers.todos = () => [entry('a', '2026-10-01', '第一天'), ...Array.from({ length: 30 }, (_, i) => entry(`b${i}`, '2026-10-02', '很长的记录'.repeat(30)))];
  const text = await timeline.lifeTimelineText({ ...request, readers });
  assert.ok(text.length <= 1700);
  assert.match(text, /2026-10-01\n\[待办\] 第一天/);
  assert.doesNotMatch(text, /2026-10-02/);
  assert.match(text, /按日期截断/);
  assert.match(text, /待办 31；/);
});
