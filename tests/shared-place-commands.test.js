'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseSharedPlaceCommand,
  shanghaiDate,
  targetDate,
} = require('../src/shared-place-commands');

test('returns null for blank or conversational input while retaining bounded box commands', () => {
  for (const value of [null, undefined, '', '  \t\n', '我想去吃火锅']) {
    assert.equal(parseSharedPlaceCommand(value), null);
  }
  assert.deepEqual(parseSharedPlaceCommand('想去箱帮助'), { type: 'help' });
  assert.deepEqual(parseSharedPlaceCommand('双人想去箱状态'), { type: 'status' });
  assert.deepEqual(parseSharedPlaceCommand('我们的想去箱有什么？'), { type: 'list' });
  assert.deepEqual(parseSharedPlaceCommand('想去箱选三'), { type: 'select', index: 3 });
  assert.equal(parseSharedPlaceCommand('想去箱选四'), null);
});

test('normalizes place names and caps names and notes when adding a place', () => {
  const longName = '一'.repeat(130);
  const longNote = 'n'.repeat(240);
  const parsed = parseSharedPlaceCommand(`想去箱加入：一下${longName}！！！，备注：${longNote}`);

  assert.equal(parsed.type, 'add');
  assert.equal(parsed.name, '一'.repeat(120));
  assert.equal(parsed.name.length, 120);
  assert.equal(parsed.note, 'n'.repeat(200));
  assert.equal(parsed.note.length, 200);
  assert.equal(parseSharedPlaceCommand('想去箱加入：！！！'), null);
});

test('deduplicates valid batch indices and rejects an out-of-range batch member', () => {
  assert.deepEqual(
    parseSharedPlaceCommand('把想去箱里的8、8和30个全部标记为已去过'),
    { type: 'visited', indices: [8, 30] },
  );
  assert.deepEqual(parseSharedPlaceCommand('想去箱8 8 15 30都去过了'), {
    type: 'visited',
    indices: [8, 15, 30],
  });
  assert.equal(parseSharedPlaceCommand('想去箱8 31都去过了'), null);
  assert.deepEqual(parseSharedPlaceCommand('删除第30个'), { type: 'remove', index: 30 });
  assert.equal(parseSharedPlaceCommand('删除第31个'), null);
});

test('preserves ordered numbered suffixes in visited batches', () => {
  assert.deepEqual(parseSharedPlaceCommand('把想去箱里的8、5号地点全部标记为已去过'), {
    type: 'visited', indices: [8, 5],
  });
  assert.deepEqual(parseSharedPlaceCommand('把想去箱里的8、15、19号地点全部标记为已去过'), {
    type: 'visited', indices: [8, 15, 19],
  });
});

test('rejects out-of-range numbered visited references without falling back to a place name', () => {
  for (const text of [
    '把想去箱里的31号地点标记为已去过',
    '把想去箱里的第31个地点标记为已去过',
    '把想去箱里的三十一号地点标记为已去过',
  ]) {
    assert.equal(parseSharedPlaceCommand(text), null);
  }
  assert.deepEqual(parseSharedPlaceCommand('把想去箱里的30号地点标记为已去过'), { type: 'visited', index: 30 });
  assert.deepEqual(parseSharedPlaceCommand('把想去箱里的5号地点标记为已去过'), { type: 'visited', index: 5 });
  assert.equal(parseSharedPlaceCommand('把想去箱里的8、31号地点全部标记为已去过'), null);
  assert.deepEqual(parseSharedPlaceCommand('把西湖标记为已去过'), { type: 'visited', name: '西湖' });
});

test('maps relative dates at the Shanghai day boundary and rejects invalid explicit dates', () => {
  const beforeMidnight = Date.parse('2026-10-25T15:59:59.999Z');
  const afterMidnight = Date.parse('2026-10-25T16:00:00.000Z');

  assert.equal(shanghaiDate(beforeMidnight), '2026-10-25');
  assert.equal(shanghaiDate(afterMidnight), '2026-10-26');
  assert.deepEqual(targetDate('', beforeMidnight), { date: '2026-10-25', label: '今天' });
  assert.deepEqual(targetDate('明日', beforeMidnight), { date: '2026-10-26', label: '明天' });
  assert.deepEqual(targetDate('后天', beforeMidnight), { date: '2026-10-27', label: '后天' });
  assert.deepEqual(targetDate('下周末', beforeMidnight), { date: '2026-10-31', label: '下周末' });
  assert.deepEqual(targetDate('周日', beforeMidnight), { date: '2026-10-25', label: '周日' });
  assert.deepEqual(targetDate('2026-10-26', beforeMidnight), { date: '2026-10-26', label: '2026-10-26' });
  assert.throws(() => targetDate('2026-02-30', beforeMidnight), /日期无效，请写清要查询哪一天/u);
});

test('classifies recommendation energy, cleans focus, and limits the retained query length', () => {
  const low = parseSharedPlaceCommand('明天去哪，轻松一点', { now: Date.parse('2026-10-25T15:00:00Z') });
  const weatherproof = parseSharedPlaceCommand('周末去哪，雨天也想去室内的', { now: Date.parse('2026-10-25T15:00:00Z') });
  const longQuery = parseSharedPlaceCommand(`以一下示例园区为主，${'附近'.repeat(180)}推荐`, {
    now: Date.parse('2026-10-25T15:00:00Z'),
  });

  assert.equal(low.type, 'recommend');
  assert.equal(low.energy, 'low');
  assert.equal(low.date, '2026-10-26');
  assert.equal(weatherproof.energy, 'weatherproof');
  assert.equal(longQuery.type, 'recommend');
  assert.equal(longQuery.focus, '示例园区');
  assert.equal(longQuery.query.length, 300);
});
