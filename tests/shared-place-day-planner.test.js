'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clockText,
  createDayPlan,
  estimateVisitMinutes,
  sameDayRegion,
  travelMinutes,
} = require('../src/shared-place-day-planner');

function entry(id, options = {}) {
  return {
    place: {
      id,
      name: options.name || id,
      province: options.province ?? '甲省域省',
      city: options.city ?? '甲城市',
      category: options.category ?? '商场',
      tags: options.tags ?? ['室内'],
      note: options.note ?? '30分钟',
    },
    rating: { score: options.score ?? 80 },
  };
}

function durationMatrix(size, minutes = 0) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => ({
    durationSeconds: minutes * 60,
  })));
}

test('clamps explicit visit durations and falls back to category defaults', () => {
  assert.equal(estimateVisitMinutes({ note: '0分钟' }), 30);
  assert.equal(estimateVisitMinutes({ note: '999分钟' }), 480);
  assert.equal(estimateVisitMinutes({ note: '1.5小时' }), 90);
  assert.equal(estimateVisitMinutes({ note: '9小时' }), 480);
  assert.equal(estimateVisitMinutes({ note: '半天' }), 240);
  assert.equal(estimateVisitMinutes({ name: '省级地名', category: '省级地名', tags: [] }), 480);
  assert.equal(estimateVisitMinutes({ name: '主题乐园', category: '', tags: [] }), 300);
  assert.equal(estimateVisitMinutes({ name: '没有分类的地方', category: '', tags: [] }), 120);
  assert.throws(() => estimateVisitMinutes(null), TypeError);
});

test('returns finite travel minutes only for finite durations and clamps sub-minute trips', () => {
  const matrix = [[
    { durationSeconds: 0 },
    { durationSeconds: 30 },
    { durationSeconds: 90 },
    { durationSeconds: '60' },
  ]];

  assert.equal(travelMinutes(matrix, 0, 0), 1);
  assert.equal(travelMinutes(matrix, 0, 1), 1);
  assert.equal(travelMinutes(matrix, 0, 2), 2);
  assert.equal(travelMinutes(matrix, 0, 3), Infinity);
  assert.equal(travelMinutes(undefined, 0, 1), Infinity);
  assert.equal(travelMinutes(matrix, 9, 0), Infinity);
});

test('normalizes regions by province first and falls back to matching cities', () => {
  assert.equal(sameDayRegion({ province: ' 甲省域省 ' }, { province: '甲省域市' }), true);
  assert.equal(sameDayRegion({ city: '甲城市' }, { city: '甲城' }), true);
  assert.equal(sameDayRegion({ province: '甲省域省', city: '丁城市' }, { province: '乙省域省', city: '丁城市' }), false);
  assert.equal(sameDayRegion({ province: '' }, { city: '甲城' }), false);
  assert.equal(sameDayRegion({}, {}), false);
});

test('rejects malformed plan inputs and reports a missing focus as unsatisfiable', () => {
  const one = [entry('one')];
  const validMatrix = durationMatrix(1);

  assert.equal(createDayPlan(null, validMatrix), null);
  assert.equal(createDayPlan([], []), null);
  assert.equal(createDayPlan(one, []), null);
  assert.equal(createDayPlan(one, validMatrix, { focusId: 'missing' }), null);
  assert.throws(() => createDayPlan(one, validMatrix, null), TypeError);
});

test('allows an exact ninety-minute leg and filters other provinces or longer legs', () => {
  const entries = [
    entry('same-a'),
    entry('same-b'),
    entry('other-province', { province: '湖南省', city: '戊城市' }),
  ];
  const matrix = durationMatrix(3, 90);

  const exact = createDayPlan(entries, matrix, { maxLegMinutes: 90 });
  assert.ok(exact);
  assert.equal(exact.entries.length, 2);
  assert.deepEqual(exact.entries.map(({ place }) => place.id).sort(), ['same-a', 'same-b']);

  const tooShort = createDayPlan(entries.slice(0, 2), matrix.slice(0, 2).map((row) => row.slice(0, 2)), {
    maxLegMinutes: 89,
  });
  assert.ok(tooShort);
  assert.equal(tooShort.entries.length, 1);
});

test('accepts a plan at exactly nine hours, charges meals at the 240-minute threshold, and caps at four stops', () => {
  const boundaryEntries = [entry('morning', { note: '3.5小时' }), entry('afternoon', { note: '3.5小时' })];
  const boundaryMatrix = [[{ durationSeconds: 0 }, { durationSeconds: 15 * 60 }], [{ durationSeconds: 15 * 60 }, { durationSeconds: 0 }]];
  const boundary = createDayPlan(boundaryEntries, boundaryMatrix);

  assert.ok(boundary);
  assert.equal(boundary.totals.visits, 420);
  assert.equal(boundary.totals.travel, 15);
  assert.equal(boundary.totals.meal, 60);
  assert.equal(boundary.totals.total, 540);

  const belowMeal = createDayPlan([entry('below', { note: '239分钟' })], [[{ durationSeconds: 0 }]]);
  const atMeal = createDayPlan([entry('at', { note: '240分钟' })], [[{ durationSeconds: 0 }]]);
  assert.equal(belowMeal.totals.meal, 0);
  assert.equal(atMeal.totals.meal, 60);

  assert.equal(createDayPlan([entry('too-long', { note: '7.5小时' })], [[{ durationSeconds: 0 }]]), null);

  const five = Array.from({ length: 5 }, (_, index) => entry(`stop-${index + 1}`));
  const capped = createDayPlan(five, durationMatrix(5));
  assert.ok(capped);
  assert.equal(capped.entries.length, 4);
  assert.equal(new Set(capped.matrixIndexes).size, 4);
});

test('formats itinerary clock boundaries from the ten o’clock start', () => {
  assert.equal(clockText(0), '10:00');
  assert.equal(clockText(45), '10:45');
  assert.equal(clockText(539), '18:59');
  assert.equal(clockText(540), '19:00');
});
