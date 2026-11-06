'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readRecordState } = require('../src/record-state');
const { createPairCoordinationStore, merge, subtract } = require('../src/pair-coordination-store');

const NOW = Date.UTC(2026, 8, 4, 4); // 2026-09-04 12:00 Asia/Shanghai
const HOUR = 60 * 60 * 1000;

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-coordination-store-'));
  const stateFile = path.join(directory, 'state.json');
  const store = createPairCoordinationStore({ stateFile, now: () => NOW, ...options });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, stateFile, store };
}

test('merge combines overlapping windows and subtract keeps only usable fragments', () => {
  const windows = [
    { startAt: NOW + 2 * HOUR, endAt: NOW + 3 * HOUR },
    { startAt: NOW, endAt: NOW + HOUR },
    { startAt: NOW + HOUR, endAt: NOW + 2 * HOUR },
  ];
  assert.deepEqual(merge(windows), [{ startAt: NOW, endAt: NOW + 3 * HOUR }]);
  assert.deepEqual(windows[0], { startAt: NOW + 2 * HOUR, endAt: NOW + 3 * HOUR });
  assert.deepEqual(subtract([{ startAt: NOW, endAt: NOW + 3 * HOUR }], [
    { startAt: NOW + HOUR, endAt: NOW + 90 * 60 * 1000 },
  ]), [
    { startAt: NOW, endAt: NOW + HOUR },
    { startAt: NOW + 90 * 60 * 1000, endAt: NOW + 3 * HOUR },
  ]);
  assert.deepEqual(subtract([{ startAt: NOW, endAt: NOW + HOUR }], [
    { startAt: NOW, endAt: NOW + 31 * 60 * 1000 },
  ]), []);
});

test('availability creation, listing and reopening preserve classified records', t => {
  const { directory, stateFile, store } = fixture(t);
  const created = store.addAvailability('owner', {
    availability: 'unavailable',
    window: { startAt: NOW + HOUR, endAt: NOW + 2 * HOUR, label: '长'.repeat(50) },
  });
  const entry = readRecordState(stateFile).availability[0];
  assert.match(created, /记下了：.*不方便。编号 #AV-[A-Z0-9]+/u);
  assert.equal(entry.side, 'owner');
  assert.equal(entry.availability, 'unavailable');
  assert.equal(entry.label.length, 40);
  const index = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(index._recordState.version, 1);
  assert.equal(fs.existsSync(path.join(directory, index.availability[0].file)), true);

  const reopened = createPairCoordinationStore({ stateFile, now: () => NOW });
  assert.match(reopened.listAvailability('owner'), new RegExp(`#${entry.id}.*不方便`, 'u'));
  assert.equal(reopened.listAvailability('friend'), '你还没有报备空闲时间。');
});

test('availability removal distinguishes ambiguous matches and deletes by normalized ID', t => {
  const { stateFile, store } = fixture(t);
  const window = { startAt: NOW, endAt: NOW + HOUR, label: '同一时间' };
  store.addAvailability('owner', { window });
  store.addAvailability('owner', { window });
  store.addAvailability('friend', { window });
  const before = readRecordState(stateFile);
  assert.deepEqual(store.removeAvailabilityResult('owner', '同一时间'), {
    reply: '对应到多条时间，请带编号删除。', wrote: false, continue: false,
  });
  assert.deepEqual(readRecordState(stateFile), before);

  const removedId = before.availability.find((entry) => entry.side === 'owner').id;
  assert.match(store.removeAvailability('owner', ` #${removedId.toLowerCase()} `), /已经删除/u);
  const after = readRecordState(stateFile);
  assert.deepEqual(after.availability.map((entry) => entry.id),
    before.availability.filter((entry) => entry.id !== removedId).map((entry) => entry.id));
  assert.match(store.removeAvailability('owner', 'AV-NOT-FOUND'), /没有找到/u);
  assert.match(store.listAvailability('friend'), /同一时间|有空/u);
});

test('matching clips both sides, subtracts calendar busy time and reports missing data', async t => {
  const calls = [];
  const calendarBusy = async (startAt, endAt) => {
    calls.push([startAt, endAt]);
    return [{ startAt: NOW + 2 * HOUR, endAt: NOW + 3 * HOUR }];
  };
  const { store } = fixture(t, { calendarBusy });
  const range = { startAt: NOW, endAt: NOW + 6 * HOUR, label: '今天下午' };
  store.addAvailability('owner', { window: { startAt: NOW, endAt: NOW + 5 * HOUR } });
  assert.match(await store.matchAvailability('owner', range), /还需要好友报备/u);
  store.addAvailability('friend', { window: { startAt: NOW + HOUR, endAt: NOW + 6 * HOUR } });
  const result = await store.matchAvailability('friend', range);
  assert.match(result, /今天下午你们共同有空/u);
  assert.match(result, /13:00.*14:00/u);
  assert.match(result, /15:00.*17:00/u);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [NOW, NOW + 6 * HOUR]);
});

test('busy state updates, reads, clears and expires at the exact deadline', t => {
  let clock = NOW;
  const { stateFile, store } = fixture(t, { now: () => clock });
  store.setBusy('owner', { endAt: NOW + HOUR, publicReason: '开会' });
  store.setBusy('friend', { endAt: NOW + 2 * HOUR, publicReason: '忙'.repeat(100) });
  assert.equal(readRecordState(stateFile).busy.friend.publicReason.length, 80);
  assert.match(store.busyStatus('owner', 'self'), /你可能正忙到/u);
  assert.match(store.busyStatus('owner', 'peer'), /好友可能正忙到/u);
  assert.match(store.peerBusyHint('owner'), /消息仍会照常发送/u);

  const reopened = createPairCoordinationStore({ stateFile, now: () => clock });
  assert.match(reopened.busyStatus('friend', 'peer'), /Owner可能正忙到/u);
  assert.equal(store.clearBusy('friend'), '忙碌状态已经解除。');
  assert.match(store.busyStatus('friend', 'self'), /没有设置忙碌/u);
  clock = NOW + HOUR;
  assert.equal(store.peerBusyHint('friend'), '');
  assert.deepEqual(readRecordState(stateFile).busy, {});
});

test('deleting one side removes its availability bodies and busy state only', t => {
  const { directory, stateFile, store } = fixture(t);
  for (const side of ['owner', 'friend']) {
    store.addAvailability(side, { window: { startAt: NOW, endAt: NOW + HOUR } });
    store.setBusy(side, { endAt: NOW + HOUR });
  }
  const beforeIndex = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const bySide = Object.fromEntries(readRecordState(stateFile).availability.map((entry, index) => [
    entry.side, beforeIndex.availability[index].file,
  ]));
  assert.deepEqual(store.deleteSide('owner'), { availability: 1, busy: true });
  assert.equal(fs.existsSync(path.join(directory, bySide.owner)), false);
  assert.equal(fs.existsSync(path.join(directory, bySide.friend)), true);
  const remaining = readRecordState(stateFile);
  assert.equal(remaining.busy.friend.endAt, NOW + HOUR);
  assert.equal(remaining.availability[0].side, 'friend');
  assert.deepEqual(store.deleteSide('owner'), { availability: 0, busy: true });
});

test('invalid sides, windows and busy deadlines fail before creating state', async t => {
  const { stateFile, store } = fixture(t);
  for (const invoke of [
    () => store.addAvailability('other', {}),
    () => store.listAvailability('other'),
    () => store.removeAvailabilityResult('other', 'AV-1'),
    () => store.setBusy('other', {}),
    () => store.clearBusy('other'),
    () => store.busyStatus('other'),
    () => store.deleteSide('other'),
  ]) assert.throws(invoke, /invalid coordination side/u);
  await assert.rejects(store.matchAvailability('other'), /invalid coordination side/u);
  for (const window of [
    {},
    { startAt: NaN, endAt: NOW + HOUR },
    { startAt: NOW, endAt: NOW },
    { startAt: NOW + 1, endAt: NOW },
    { startAt: NOW, endAt: NOW + 31 * 24 * HOUR + 1 },
  ]) assert.throws(() => store.addAvailability('owner', { window }), /没有看懂这段时间|最多覆盖 31 天/u);
  for (const endAt of [NOW - 1, NOW, NaN, Infinity, 'invalid']) {
    assert.throws(() => store.setBusy('owner', { endAt }), /忙碌结束时间需要在未来/u);
  }
  assert.equal(fs.existsSync(stateFile), false);
});
