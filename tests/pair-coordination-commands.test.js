'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  dateOffset,
  parsePairCoordinationCommand,
  parseWindow,
} = require('../src/pair-coordination-commands');

const NOW = Date.parse('2026-09-04T04:00:00Z'); // 2026-09-04 12:00 Asia/Shanghai, Friday

test('returns null for empty, nullish, and unsupported coordination input', () => {
  for (const input of [undefined, null, '', '   \t\n', 0, false, {}, [], '。！~', '帮我订餐', '我有空', '我没空']) {
    assert.equal(parsePairCoordinationCommand(input, { now: NOW }), null, String(input));
  }
});

test('recognizes controls and normalizes trailing command punctuation', () => {
  assert.deepEqual(parsePairCoordinationCommand('双人协调帮助！', { now: NOW }), { type: 'help' });
  assert.deepEqual(parsePairCoordinationCommand('查看我报备的空闲记录。', { now: NOW }), { type: 'availability_list' });
  assert.deepEqual(parsePairCoordinationCommand('好友现在忙不忙？', { now: NOW }), { type: 'busy_status', target: 'peer' });
  assert.deepEqual(parsePairCoordinationCommand('我忙完了!!!', { now: NOW }), { type: 'busy_clear' });
  assert.deepEqual(parsePairCoordinationCommand('我忙完了?', { now: NOW }), null);
});

test('parses available and unavailable windows with the same deterministic range', () => {
  const available = parsePairCoordinationCommand('我周六下午有空', { now: NOW });
  const unavailable = parsePairCoordinationCommand('我周六下午没空', { now: NOW });
  assert.equal(available.type, 'availability_add');
  assert.equal(available.availability, 'available');
  assert.equal(unavailable.type, 'availability_add');
  assert.equal(unavailable.availability, 'unavailable');
  assert.deepEqual(unavailable.window, available.window);
  assert.equal(new Date(available.window.startAt).toISOString(), '2026-09-05T05:00:00.000Z');
  assert.equal(new Date(available.window.endAt).toISOString(), '2026-09-05T10:00:00.000Z');
});

test('maps relative dates, next-week boundaries, and rejects impossible explicit dates', () => {
  assert.equal(dateOffset('2026-09-04', NOW), 0);
  assert.equal(dateOffset('2026-09-05', NOW), 1);
  assert.equal(dateOffset('这周日', NOW), 2);
  assert.equal(dateOffset('下周一', NOW), 3);
  assert.equal(dateOffset('下周五', NOW), 7);

  for (const [period, label, start, end] of [
    ['周末', '本周末', '2026-09-04T16:00:00Z', '2026-09-06T15:59:00Z'],
    ['下周', '下周', '2026-09-06T16:00:00Z', '2026-09-13T15:59:00Z'],
    ['下周末', '下周末', '2026-09-11T16:00:00Z', '2026-09-13T15:59:00Z'],
  ]) {
    assert.deepEqual(parseWindow(period, NOW), { startAt: Date.parse(start), endAt: Date.parse(end), label }, period);
  }
  for (const date of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-01-00']) {
    assert.throws(() => dateOffset(date, NOW), /日期无效，请写清要查询哪一天/u, date);
    assert.throws(() => parseWindow(date, NOW), /日期无效，请写清要查询哪一天/u, date);
    assert.throws(() => parsePairCoordinationCommand(`我${date}有空`, { now: NOW }), /日期无效/u, date);
  }
});

test('parses half-hour and afternoon clock ranges and rolls an overnight range forward', () => {
  const halfHour = parseWindow('今天十点半到十一点半', NOW);
  assert.equal(halfHour.startAt, Date.parse('2026-09-04T02:30:00Z'));
  assert.equal(halfHour.endAt, Date.parse('2026-09-04T03:30:00Z'));

  const afternoon = parseWindow('今天下午一点到两点', NOW);
  assert.equal(afternoon.startAt, Date.parse('2026-09-04T05:00:00Z'));
  assert.equal(afternoon.endAt, Date.parse('2026-09-04T06:00:00Z'));

  const overnight = parseWindow('今天23点到1点', NOW);
  assert.equal(overnight.startAt, Date.parse('2026-09-04T15:00:00Z'));
  assert.equal(overnight.endAt, Date.parse('2026-09-04T17:00:00Z'));
});

test('keeps evening overnight endpoints and same-day meridiem ranges correct', () => {
  const overnight = parseWindow('今天晚上十一点到一点', NOW);
  assert.equal(overnight.startAt, Date.parse('2026-09-04T15:00:00Z'));
  assert.equal(overnight.endAt, Date.parse('2026-09-04T17:00:00Z'));

  const evening = parseWindow('今天晚上八点到十点', NOW);
  assert.equal(evening.startAt, Date.parse('2026-09-04T12:00:00Z'));
  assert.equal(evening.endAt, Date.parse('2026-09-04T14:00:00Z'));

  const afternoon = parseWindow('今天下午一点到三点', NOW);
  assert.equal(afternoon.startAt, Date.parse('2026-09-04T05:00:00Z'));
  assert.equal(afternoon.endAt, Date.parse('2026-09-04T07:00:00Z'));
});

test('rolls an evening range ending after midnight into the next Shanghai day', () => {
  assert.deepEqual(parseWindow('今天晚上八点到一点', NOW), {
    startAt: Date.parse('2026-09-04T12:00:00Z'),
    endAt: Date.parse('2026-09-04T17:00:00Z'),
    label: '今天',
  });
});

test('keeps deletion query separate from its parsed window and preserves busy schedule details', () => {
  const removal = parsePairCoordinationCommand('删除我周六下午的空闲记录', { now: NOW });
  assert.deepEqual(removal, {
    type: 'availability_remove',
    query: '周六下午的',
    window: { startAt: Date.parse('2026-09-05T05:00:00Z'), endAt: Date.parse('2026-09-05T10:00:00Z'), label: '周六' },
  });

  const busy = parsePairCoordinationCommand('我开会到晚上十点', { now: NOW });
  assert.equal(busy.type, 'busy_set');
  assert.equal(busy.endAt, Date.parse('2026-09-04T14:00:00Z'));
  assert.equal(busy.description, '9/4周五 22:00');
});

test('returns scene metadata for date, trip, and default outing phrases', () => {
  assert.deepEqual(parsePairCoordinationCommand('今晚出行', { now: NOW }), {
    type: 'scene_build', kind: 'date', dayOffset: 0, label: '今晚出行',
    window: { startAt: Date.parse('2026-09-04T10:00:00Z'), endAt: Date.parse('2026-09-04T15:00:00Z'), label: '今天' },
  });
  assert.deepEqual(parsePairCoordinationCommand('明天旅游', { now: NOW }), {
    type: 'scene_build', kind: 'trip', dayOffset: 1, label: '明天旅游',
    window: { startAt: Date.parse('2026-09-05T01:00:00Z'), endAt: Date.parse('2026-09-05T14:00:00Z'), label: '明天' },
  });
  assert.deepEqual(parsePairCoordinationCommand('帮我们看看今天怎么安排', { now: NOW }), {
    type: 'scene_build', kind: 'outing', dayOffset: 0, label: '帮我们看看今天怎么安排',
    window: { startAt: Date.parse('2026-09-04T01:00:00Z'), endAt: Date.parse('2026-09-04T14:00:00Z'), label: '今天' },
  });
});

test('empty window input uses today while day parts retain their exact hour bounds', () => {
  for (const input of [undefined, null, '', '  ', 0]) {
    assert.deepEqual(parseWindow(input, NOW), {
      startAt: Date.parse('2026-09-04T01:00:00Z'), endAt: Date.parse('2026-09-04T14:00:00Z'), label: '今天',
    });
  }
  for (const [period, start, end] of [
    ['凌晨', '2026-09-03T16:00:00Z', '2026-09-03T22:00:00Z'],
    ['上午', '2026-09-04T00:00:00Z', '2026-09-04T04:00:00Z'],
    ['中午', '2026-09-04T03:00:00Z', '2026-09-04T06:00:00Z'],
    ['下午', '2026-09-04T05:00:00Z', '2026-09-04T10:00:00Z'],
    ['傍晚', '2026-09-04T09:00:00Z', '2026-09-04T12:00:00Z'],
    ['晚上', '2026-09-04T10:00:00Z', '2026-09-04T15:00:00Z'],
  ]) {
    assert.deepEqual(parseWindow(`今天${period}`, NOW), { startAt: Date.parse(start), endAt: Date.parse(end), label: '今天' }, period);
  }
});

test('relative days cross Shanghai midnight, year-end and leap-day boundaries', () => {
  const beforeMidnight = Date.parse('2026-12-31T15:59:59.999Z');
  const atMidnight = beforeMidnight + 1;
  assert.equal(dateOffset('2027-01-01', beforeMidnight), 1);
  assert.equal(dateOffset('2026-12-31', atMidnight), -1);
  assert.deepEqual(parseWindow('明天凌晨', beforeMidnight), {
    startAt: Date.parse('2026-12-31T16:00:00Z'), endAt: Date.parse('2026-12-31T22:00:00Z'), label: '明天',
  });
  assert.deepEqual(parseWindow('后天早上', beforeMidnight), {
    startAt: Date.parse('2027-01-02T00:00:00Z'), endAt: Date.parse('2027-01-02T04:00:00Z'), label: '后天',
  });
  const leapEve = Date.parse('2028-02-28T04:00:00Z');
  assert.equal(dateOffset('2028-02-29', leapEve), 1);
  assert.equal(dateOffset('2028-03-01', leapEve), 2);
  assert.deepEqual(parseWindow('2028-02-29中午', leapEve), {
    startAt: Date.parse('2028-02-29T03:00:00Z'), endAt: Date.parse('2028-02-29T06:00:00Z'), label: '2028-02-29',
  });
});

test('next-week weekdays follow Monday-based weeks on both sides of Sunday midnight', () => {
  const sunday = Date.parse('2026-09-06T15:59:59.999Z');
  const monday = sunday + 1;
  for (const [period, onSunday, onMonday] of [
    ['周日', 0, 6], ['星期天', 0, 6], ['周一', 1, 0],
    ['下周一', 1, 7], ['下星期天', 7, 13],
  ]) {
    assert.equal(dateOffset(period, sunday), onSunday, period);
    assert.equal(dateOffset(period, monday), onMonday, period);
  }
});

test('clock ranges accept minute boundaries and supported range separators', () => {
  for (const separator of ['到', '至', '-', '—', '~', '～']) {
    assert.deepEqual(parseWindow(`今天零点零分 ${separator} 二十三点五十九分`, NOW), {
      startAt: Date.parse('2026-09-03T16:00:00Z'), endAt: Date.parse('2026-09-04T15:59:00Z'), label: '今天',
    }, separator);
  }
  assert.deepEqual(parseWindow('今天9点到9点', NOW), {
    startAt: Date.parse('2026-09-04T01:00:00Z'), endAt: Date.parse('2026-09-05T01:00:00Z'), label: '今天',
  });
});

test('availability matching keeps an explicit tomorrow window and requires a supported question', () => {
  for (const text of ['我们俩明天什么时候能见面？', '查看双方明天共同有空?']) {
    assert.deepEqual(parsePairCoordinationCommand(text, { now: NOW }), {
      type: 'availability_match',
      window: { startAt: Date.parse('2026-09-05T01:00:00Z'), endAt: Date.parse('2026-09-05T14:00:00Z'), label: '明天' },
    }, text);
  }
  for (const text of ['他们明天有空', '查看双方明天共同有空吗', '他们什么时候有空？']) {
    assert.equal(parsePairCoordinationCommand(text, { now: NOW }), null, text);
  }
});

test('availability removal preserves a trimmed identifier for the store to resolve', () => {
  assert.deepEqual(parsePairCoordinationCommand('  删除我 #av-ab12 空闲记录！  ', { now: NOW }), {
    type: 'availability_remove', query: '#av-ab12',
    window: { startAt: Date.parse('2026-09-04T01:00:00Z'), endAt: Date.parse('2026-09-04T14:00:00Z'), label: '今天' },
  });
  assert.equal(parsePairCoordinationCommand('删除空闲记录', { now: NOW }), null);
});

test('busy shortcuts use exactly four hours even when the deadline crosses midnight', () => {
  const lateEvening = Date.parse('2026-09-04T15:30:00Z');
  for (const text of ['我现在有点忙', '今晚先别打扰我', '勿扰']) {
    assert.deepEqual(parsePairCoordinationCommand(text, { now: lateEvening }), {
      type: 'busy_set', endAt: Date.parse('2026-09-04T19:30:00Z'), description: '约四小时后',
    }, text);
  }
});

test('busy schedule errors propagate without silently falling back to four hours', () => {
  for (const [text, message] of [
    ['我忙到明天24点', /时间不合法/u],
    ['我忙到明天12点60分', /时间不合法/u],
    ['我忙到一会儿', /请写明时间/u],
    ['我忙到下下周一八点', /暂不认识这个日期/u],
    ['我忙到今天11点', /这个时间已经过去了/u],
  ]) assert.throws(() => parsePairCoordinationCommand(text, { now: NOW }), message, text);
});

test('busy schedules enforce the exact thirty-second future deadline', () => {
  const deadline = Date.parse('2026-09-04T05:00:00Z');
  assert.throws(() => parsePairCoordinationCommand('我忙到今天13点', { now: deadline - 30000 }), /这个时间已经过去了/u);
  assert.deepEqual(parsePairCoordinationCommand('我忙到今天13点', { now: deadline - 30001 }), {
    type: 'busy_set', endAt: deadline, description: '9/4周五 13:00',
  });
});
