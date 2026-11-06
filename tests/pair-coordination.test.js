'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { readRecordState } = require('../src/record-state');
const { parsePairCoordinationCommand } = require('../src/pair-coordination-commands');
const { createPairCoordinationStore } = require('../src/pair-coordination-store');


const NOW = Date.UTC(2026, 8, 4, 4); // 2026-09-04 12:00 Asia/Shanghai, Friday

function tempStore(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-coordination-'));
  return {
    directory,
    store: createPairCoordinationStore({
      stateFile: path.join(directory, 'state.json'),
      now: () => NOW,
      ...options,
    }),
  };
}

function storeFixture(t, options = {}) {
  const fixture = tempStore(options);
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  return { ...fixture, stateFile: path.join(fixture.directory, 'state.json') };
}

const HOUR = 60 * 60 * 1000;
function availability(id, side, startAt = NOW, endAt = NOW + HOUR) {
  return { id, side, startAt, endAt, availability: 'available', label: '合成时间',
    createdAt: new Date(NOW).toISOString(), source: 'wechat_manual' };
}



test('parses natural availability, deletion, busy and scene commands', () => {
  const add = parsePairCoordinationCommand('我周六下午有空', { now: NOW });
  assert.equal(add.type, 'availability_add');
  assert.equal(add.availability, 'available');
  assert.equal(new Date(add.window.startAt).toISOString(), '2026-09-05T05:00:00.000Z');
  assert.equal(parsePairCoordinationCommand('我们周末什么时候都有空？', { now: NOW }).type, 'availability_match');
  const remove = parsePairCoordinationCommand('删除我周六下午的空闲记录', { now: NOW });
  assert.equal(remove.type, 'availability_remove');
  assert.ok(remove.window.endAt > remove.window.startAt);
  assert.equal(parsePairCoordinationCommand('我开会到晚上十点', { now: NOW }).type, 'busy_set');
  assert.deepEqual(parsePairCoordinationCommand('我忙完了', { now: NOW }), { type: 'busy_clear' });
  assert.equal(parsePairCoordinationCommand('今晚出行', { now: NOW }).type, 'scene_build');
});

test('returns only common availability and subtracts Owner calendar busy time', async () => {
  const { directory, store } = tempStore({
    calendarBusy: async () => [{
      startAt: Date.UTC(2026, 8, 5, 6), endAt: Date.UTC(2026, 8, 5, 7),
    }],
  });
  try {
    const owner = parsePairCoordinationCommand('我周六下午一点到五点有空', { now: NOW });
    const friend = parsePairCoordinationCommand('我周六下午两点到六点有空', { now: NOW });
    store.addAvailability('owner', owner);
    store.addAvailability('friend', friend);
    const result = await store.matchAvailability('owner', parsePairCoordinationCommand('我们周末什么时候都有空？', { now: NOW }).window);
    assert.match(result, /15:00.*17:00/u);
    assert.doesNotMatch(result, /13:00|18:00/u);
    assert.match(result, /只显示交集/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('natural deletion removes only the caller record', () => {
  const { directory, store } = tempStore();
  try {
    const command = parsePairCoordinationCommand('我周六下午有空', { now: NOW });
    store.addAvailability('owner', command);
    store.addAvailability('friend', command);
    const remove = parsePairCoordinationCommand('删除我周六下午的空闲记录', { now: NOW });
    assert.match(store.removeAvailability('owner', remove.query, remove.window), /已经删除/u);
    assert.match(store.listAvailability('owner'), /还没有/u);
    assert.doesNotMatch(store.listAvailability('friend'), /还没有/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('busy is a hint only and expires without blocking delivery', () => {
  const { directory, store } = tempStore();
  try {
    store.setBusy('friend', { endAt: NOW + 60 * 60 * 1000 });
    assert.match(store.peerBusyHint('owner'), /消息仍会照常发送，不会被拦住/u);
    assert.match(store.busyStatus('owner', 'peer'), /可能正忙/u);
    assert.equal(store.peerBusyHint('friend'), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('configured Apple Calendar failure is disclosed instead of silently ignored', async () => {
  const calendarBusy = async () => { throw new Error('calendar unavailable'); };
  calendarBusy.enabled = true;
  const { directory, store } = tempStore({ calendarBusy });
  try {
    const command = parsePairCoordinationCommand('我周六下午有空', { now: NOW });
    store.addAvailability('owner', command);
    store.addAvailability('friend', command);
    const result = await store.matchAvailability('friend', command.window);
    assert.match(result, /Apple 日历这次没有读到/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('next-week weekdays and explicit dates agree across coordination and map tools', () => {
  const { parseWindow } = require('../src/pair-coordination-commands');
  const { targetDate, shanghaiDate } = require('../src/shared-place-commands');
  for (const [period, date] of [['下周一', '2026-09-07'], ['下星期日', '2026-09-13'], ['下周末', '2026-09-12'], ['2026-09-18晚上', '2026-09-18']]) {
    assert.equal(targetDate(period, NOW).date, date);
    assert.equal(shanghaiDate(parseWindow(period, NOW).startAt), date);
  }
  assert.throws(() => targetDate('2026-02-30', NOW), /日期无效/);
  assert.throws(() => parseWindow('2026-02-30', NOW), /日期无效/);
});

test('unknown availability ID cannot delete a different record in the same time window', t => {
  const { directory, store } = tempStore();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = parsePairCoordinationCommand('我周六下午有空', { now: NOW });
  store.addAvailability('owner', command);
  const result = store.removeAvailabilityResult('owner', 'AV-NOTFOUND', command.window);
  assert.equal(result.wrote, false);
  assert.equal(result.continue, false);
  assert.match(store.listAvailability('owner'), /你报备的时间/);
});

test('scene links the same weekend window to tickets, reminders and route date', async t => {
  const { createPairSceneAdvisor } = require('../src/pair-scene-advisor');
  const { createUniversalInboxStore } = require('../src/universal-inbox-store');
  const { parseWindow } = require('../src/pair-coordination-commands');
  const { directory } = tempStore();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inbox = createUniversalInboxStore({ stateFile: path.join(directory, 'inbox.json'), now: () => NOW });
  inbox.stage('owner', [
    { kind: 'ticket', title: '周六合成票', eventTime: '2026-09-05 19:00', tripScope: 'pair' },
    { kind: 'ticket', title: '周日合成票', eventTime: '2026-09-06 19:00', tripScope: 'pair' },
    { kind: 'ticket', title: '今天合成票', eventTime: '2026-09-04 19:00', tripScope: 'pair' },
  ]);
  inbox.saveAll('owner', 'ticket');
  const window = parseWindow('周末', NOW);
  let mapCommand, commonWindow;
  const advisor = createPairSceneAdvisor({ universalInbox: inbox,
    sharedPlaceBox: { handle: async (_, command) => { mapCommand = command; return '合成路线'; } },
    coordination: { matchAvailability: async (_, range) => { commonWindow = range; return '合成交集'; }, busyStatus: () => '合成状态' },
    sharedLife: { handle: () => '合成清单' }, now: () => NOW,
    relayStore: { list: () => [
      { status: 'pending', text: '周末提醒', sendAt: Date.UTC(2026, 8, 6, 8) },
      { status: 'pending', text: '今天提醒', sendAt: NOW + 3600000 },
    ] },
  });
  const reply = await advisor.build('owner', { kind: 'trip', label: '周末出去玩', window, dayOffset: 0 });
  assert.match(reply, /周六合成票[\s\S]*周日合成票/);
  assert.match(reply, /周末提醒/);
  assert.doesNotMatch(reply, /今天合成票|今天提醒|明天的票券/);
  assert.deepEqual(commonWindow, window);
  assert.equal(mapCommand.date, '2026-09-05');
  assert.equal(mapCommand.label, '2026-09-05');
});

test('coordination migrates inline records and applies exact availability and busy expiry boundaries', t => {
  const { directory, stateFile, store } = storeFixture(t);
  const retained = availability('AV-RETAINED', 'owner', NOW - 2 * HOUR, NOW - HOUR + 1);
  const friendBusy = { endAt: NOW + 1, publicReason: '合成原因' };
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 0, availability: [
    availability('AV-EXPIRED', 'owner', NOW - 2 * HOUR, NOW - HOUR), retained,
  ], busy: { owner: { endAt: NOW }, friend: friendBusy } }));
  assert.match(store.listAvailability('owner'), /AV-RETAINED/);
  const state = readRecordState(stateFile);
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.availability, [retained]);
  assert.deepEqual(state.busy, { friend: friendBusy });
  const index = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(index._recordState.version, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, index.availability[0].file))), retained);
});

test('coordination rejects invalid sides, windows and busy deadlines without writing state', async t => {
  const { stateFile, store } = storeFixture(t);
  for (const invoke of [
    () => store.addAvailability('other', {}), () => store.listAvailability('other'),
    () => store.removeAvailabilityResult('other', 'AV-1'), () => store.setBusy('other', {}),
    () => store.clearBusy('other'), () => store.busyStatus('other'), () => store.deleteSide('other'),
  ]) assert.throws(invoke, /invalid coordination side/);
  await assert.rejects(store.matchAvailability('other'), /invalid coordination side/);
  for (const window of [{}, { startAt: NaN, endAt: NOW }, { startAt: NOW, endAt: Infinity },
    { startAt: String(NOW), endAt: NOW + HOUR }, { startAt: NOW, endAt: NOW },
    { startAt: NOW + 1, endAt: NOW }]) {
    assert.throws(() => store.addAvailability('owner', { window }), /没有看懂这段时间/);
  }
  assert.throws(() => store.addAvailability('owner', { window: { startAt: NOW, endAt: NOW + 31 * 24 * HOUR + 1 } }), /最多覆盖 31 天/);
  for (const endAt of [NOW, NOW - 1, NaN, Infinity, 'invalid']) {
    assert.throws(() => store.setBusy('owner', { endAt }), /忙碌结束时间需要在未来/);
  }
  assert.equal(fs.existsSync(stateFile), false);
  store.addAvailability('owner', { window: { startAt: NOW, endAt: NOW + 31 * 24 * HOUR, label: '长'.repeat(41) } });
  assert.equal(readRecordState(stateFile).availability[0].label.length, 40);
});

test('duplicate availability windows remain separate and require an ID for deletion', t => {
  const { stateFile, store } = storeFixture(t);
  const window = { startAt: NOW, endAt: NOW + HOUR, label: '合成时间' };
  store.addAvailability('owner', { window });
  store.addAvailability('owner', { window });
  const before = readRecordState(stateFile).availability;
  assert.equal(before.length, 2);
  assert.notEqual(before[0].id, before[1].id);
  assert.deepEqual(store.removeAvailabilityResult('owner', '合成时间'), {
    reply: '对应到多条时间，请带编号删除。', wrote: false, continue: false,
  });
  assert.deepEqual(readRecordState(stateFile).availability, before);
  const removed = store.removeAvailabilityResult('owner', ` #${before[0].id.toLowerCase()} `);
  assert.equal(removed.wrote, true);
  assert.deepEqual(readRecordState(stateFile).availability, [before[1]]);
});

test('availability lists keep only the latest twelve own entries in insertion order', t => {
  const { stateFile, store } = storeFixture(t);
  const entries = Array.from({ length: 14 }, (_, i) => availability(`AV-OWN-${i}`, 'owner', NOW + (14 - i) * HOUR, NOW + (15 - i) * HOUR));
  fs.writeFileSync(stateFile, JSON.stringify({ availability: [...entries, availability('AV-PEER', 'friend')] }));
  const ids = [...store.listAvailability('owner').matchAll(/#(AV-[A-Z0-9-]+)/gu)].map(match => match[1]);
  assert.deepEqual(ids, entries.slice(-12).map(entry => entry.id));
  assert.equal(readRecordState(stateFile).availability.length, 15);
});

test('matching sorts and limits common windows to eight without deleting stored availability', async t => {
  const { stateFile, store } = storeFixture(t);
  const starts = Array.from({ length: 9 }, (_, i) => NOW + i * 2 * HOUR);
  const entries = starts.slice().reverse().flatMap((startAt, i) => ['owner', 'friend'].map(side =>
    availability(`AV-${side}-${i}`, side, startAt, startAt + HOUR)));
  fs.writeFileSync(stateFile, JSON.stringify({ availability: entries }));
  const result = await store.matchAvailability('friend');
  const times = result.split('\n').filter(line => /^\d+\./u.test(line)).map(line => line.match(/\d{2}:\d{2}/u)[0]);
  assert.deepEqual(times, ['12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '00:00', '02:00']);
  assert.equal(readRecordState(stateFile).availability.length, 18);
});

test('busy replacement, clearing and exact expiry affect only the selected side', t => {
  let clock = NOW;
  const { stateFile, store } = storeFixture(t, { now: () => clock });
  store.setBusy('owner', { endAt: NOW + HOUR });
  store.setBusy('friend', { endAt: NOW + HOUR });
  store.setBusy('friend', { endAt: NOW + 2 * HOUR, publicReason: '原'.repeat(81) });
  assert.equal(readRecordState(stateFile).busy.friend.publicReason.length, 80);
  assert.match(store.busyStatus('friend', 'self'), /你可能正忙到/);
  store.clearBusy('owner');
  assert.match(store.busyStatus('owner', 'self'), /没有设置忙碌/);
  clock = NOW + 2 * HOUR - 1;
  assert.notEqual(store.peerBusyHint('owner'), '');
  clock += 1;
  assert.equal(store.peerBusyHint('owner'), '');
  assert.deepEqual(readRecordState(stateFile).busy, {});
});

test('coordination side deletion removes its bodies and busy state while preserving the peer', t => {
  const { directory, stateFile, store } = storeFixture(t);
  for (const side of ['owner', 'friend']) {
    store.addAvailability(side, { window: { startAt: NOW, endAt: NOW + HOUR } });
    store.setBusy(side, { endAt: NOW + HOUR });
  }
  const before = readRecordState(stateFile);
  const refs = JSON.parse(fs.readFileSync(stateFile)).availability;
  assert.deepEqual(store.deleteSide('owner'), { availability: 1, busy: true });
  const after = readRecordState(stateFile);
  assert.deepEqual(after.availability, before.availability.filter(entry => entry.side === 'friend'));
  assert.deepEqual(after.busy, { friend: before.busy.friend });
  assert.equal(fs.existsSync(path.join(directory, refs[0].file)), false);
  assert.equal(fs.existsSync(path.join(directory, refs[1].file)), true);
  assert.deepEqual(store.deleteSide('owner'), { availability: 0, busy: true });
});

test('coordination rejects generated ID collisions without overwriting the original record', t => {
  const { stateFile, store } = storeFixture(t);
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(crypto, 'randomBytes', () => Buffer.from('abcd', 'hex'));
  store.addAvailability('owner', { window: { startAt: NOW, endAt: NOW + HOUR } });
  const before = readRecordState(stateFile);
  assert.throws(() => store.addAvailability('friend', { window: { startAt: NOW, endAt: NOW + 2 * HOUR } }), /duplicate classified record identity/);
  assert.deepEqual(readRecordState(stateFile), before);
});
