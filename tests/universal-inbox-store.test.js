'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createUniversalInboxStore, DRAFT_TTL_MS, MAX_DRAFTS,
  eventTimestamp, ticketReminderSchedules,
} = require('../src/universal-inbox-store');

const START = Date.parse('2026-08-24T06:00:00.000Z');

function fixture(t, state) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  let current = START;
  const store = createUniversalInboxStore({ stateFile, now: () => current });
  return {
    store, stateFile,
    setNow: (value) => { current = value; },
    index: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    bytes: () => fs.readFileSync(stateFile, 'utf8'),
  };
}

test('normalizes legacy singleton drafts and drops invalid or expired draft entries', (t) => {
  const draft = { id: 'UI-OLD', kind: 'note', title: '旧草稿', createdAt: new Date(START).toISOString() };
  const f = fixture(t, {
    schemaVersion: 1, items: {}, views: null,
    drafts: {
      owner: draft,
      friend: [null, { ...draft, id: 'UI-BAD', createdAt: 'invalid' },
        { ...draft, id: 'UI-EXPIRED', createdAt: new Date(START - DRAFT_TTL_MS - 1).toISOString() }],
    },
  });
  assert.deepEqual(f.store.getDrafts('owner'), [draft]);
  assert.deepEqual(f.store.getDrafts('friend'), []);
  assert.equal(f.index().schemaVersion, 4);
  assert.deepEqual(f.index().drafts, { owner: [draft] });
  assert.deepEqual(f.index().views, {});
  assert.deepEqual(f.index().items, []);
});

test('keeps drafts and numbered views at their TTL boundary and expires them one millisecond later', (t) => {
  const f = fixture(t);
  f.store.stage('owner', { kind: 'ticket', title: '边界票', tripScope: 'self' });
  f.store.saveItem('owner', 'ticket');
  f.store.list('owner', 'ticket');
  f.store.stage('owner', { kind: 'note', title: '边界草稿' });
  f.setNow(START + 15 * 60 * 1000);
  assert.deepEqual(f.store.ticketViewStatus('owner'), { pending: true, count: 1 });
  f.setNow(START + 15 * 60 * 1000 + 1);
  assert.deepEqual(f.store.ticketViewStatus('owner'), { pending: false, count: 0 });
  assert.equal(f.index().views.owner, undefined);
  f.setNow(START + DRAFT_TTL_MS);
  assert.equal(f.store.draftCount('owner'), 1);
  f.setNow(START + DRAFT_TTL_MS + 1);
  assert.equal(f.store.hasDraft('owner'), false);
  assert.equal(f.index().drafts.owner, undefined);
});

test('staging filters before the five-candidate cap and replaces only the current side', (t) => {
  const f = fixture(t);
  f.store.stage('friend', { kind: 'note', title: '对方草稿' });
  const peer = f.store.getDrafts('friend');
  f.store.stage('owner', { kind: 'note', title: '被替换草稿' });
  f.store.stage('owner', [
    { kind: 'unknown', title: '无效类型' }, { kind: 'note', title: '  ' },
    { kind: 'note', title: '不安全', summary: 'token: synthetic-secret' },
    ...Array.from({ length: MAX_DRAFTS + 2 }, (_, i) => ({ kind: 'note', title: `候选${i + 1}` })),
  ]);
  assert.deepEqual(f.store.getDrafts('owner').map((draft) => draft.title), ['候选1', '候选2', '候选3', '候选4', '候选5']);
  assert.deepEqual(f.store.getDrafts('friend'), peer);
  const before = f.bytes();
  for (const input of [[], {}, { kind: 'note', title: '密码：synthetic-secret' }]) {
    assert.throws(() => f.store.stage('owner', input), /没有可安全保存/);
    assert.equal(f.bytes(), before);
  }
});

test('selected saves reject invalid indices atomically and deduplicate valid indices in requested order', (t) => {
  const f = fixture(t);
  f.store.stage('owner', ['甲', '乙', '丙'].map((title) => ({ kind: 'note', title })));
  const before = f.bytes();
  for (const indices of [[], [1, 4], [0], [-1], [1.5], ['1'], [NaN]]) {
    assert.throws(() => f.store.saveSelected('owner', 'collection', indices), /候选已经变化/);
    assert.equal(f.bytes(), before);
  }
  assert.throws(() => f.store.saveSelected('owner', 'ticket', [1, 2]), /明确.*行程人/);
  assert.equal(f.bytes(), before);
  const saved = f.store.saveSelected('owner', 'collection', [3, 1, 3]);
  assert.deepEqual(saved.map((item) => item.title), ['丙', '甲']);
  assert.equal(new Set(saved.map((item) => item.id)).size, 2);
  assert.deepEqual(f.store.getDrafts('owner').map((draft) => draft.title), ['乙']);
  assert.equal(f.index().items.length, 2);
});

test('saving all tickets with a missing trip scope preserves both drafts', (t) => {
  const f = fixture(t);
  f.store.stage('owner', [
    { kind: 'ticket', title: '本人票券', tripScope: 'self' },
    { kind: 'ticket', title: '未标明行程人的票券' },
  ]);
  assert.throws(() => f.store.saveAll('owner', 'ticket'), /没标明行程人/);
  assert.equal(f.store.getDrafts('owner').length, 2);
});

test('assigning an out-of-range ticket number refuses without writing', (t) => {
  const f = fixture(t);
  f.store.stage('owner', { kind: 'ticket', title: '本人票券', tripScope: 'self' });
  f.store.saveAll('owner', 'ticket');
  f.store.list('owner', 'ticket');
  const result = f.store.assignTicketsResult('owner', [9], 'self');
  assert.match(result.reply, /你说的票券编号不在刚才的列表里/);
  assert.equal(result.wrote, false);
});

test('removing one saved ticket with an expected count of two refuses without writing', (t) => {
  const f = fixture(t);
  f.store.stage('owner', { kind: 'ticket', title: '本人票券', tripScope: 'self' });
  const [ticket] = f.store.saveAll('owner', 'ticket');
  const result = f.store.removeItemsResult('owner', [ticket.id], { expectedCount: 2 });
  assert.match(result.reply, /当前能对应到 1 个项目，不是你说的 2 个/);
  assert.equal(result.wrote, false);
});

test('a friend cannot mark a gift saved by Owner as bought', (t) => {
  const f = fixture(t);
  f.store.stage('owner', { kind: 'gift', title: '共享礼物' });
  f.store.saveAll('owner', 'gift');
  f.store.list('friend', 'gift');
  const result = f.store.updateGiftResult('friend', 1, 'bought');
  assert.match(result.reply, /由Owner添加的/);
  assert.match(result.reply, /只有添加人可以修改或删除/);
  assert.equal(result.wrote, false);
});

test('ambiguous or missing draft selections do not consume candidates and final consumption cleans the side', (t) => {
  const f = fixture(t);
  f.store.stage('owner', [{ kind: 'note', title: '甲' }, { kind: 'note', title: '乙' }]);
  f.store.stage('friend', { kind: 'note', title: '对方草稿' });
  const before = f.bytes();
  assert.equal(f.store.getDraft('owner'), null);
  assert.equal(f.store.consumeDraft('owner'), null);
  assert.equal(f.store.saveItem('owner', 'collection'), null);
  assert.equal(f.store.consumeDraft('owner', 9), null);
  assert.equal(f.store.discard('owner', 9), 0);
  assert.equal(f.bytes(), before);
  assert.equal(f.store.discard('owner', 2), 1);
  assert.equal(f.store.consumeDraft('owner').title, '甲');
  assert.equal(f.index().drafts.owner, undefined);
  assert.equal(f.store.getDraft('friend').title, '对方草稿');
  assert.equal(f.store.discard('friend'), 1);
  assert.equal(f.store.discard('friend'), 0);
  assert.deepEqual(f.index().drafts, {});
});

test('invalid sides, saved kinds and gift actions reject without changing persisted state', (t) => {
  const f = fixture(t);
  f.store.stage('owner', { kind: 'note', title: '保留候选' });
  const gift = f.store.addGift('owner', '保留礼物');
  const before = f.bytes();
  for (const action of [
    () => f.store.stage('other', { kind: 'note', title: '无效用户' }),
    () => f.store.list('other', 'gift'),
    () => f.store.deleteSide('other'),
    () => f.store.addGift('other', '无效用户'),
  ]) assert.throws(action, /invalid inbox side/);
  for (const action of [
    () => f.store.saveItem('owner', 'note'),
    () => f.store.saveAll('owner', 'note'),
    () => f.store.saveSelected('owner', 'note', [1]),
  ]) assert.throws(action, /unsupported inbox item kind/);
  assert.throws(() => f.store.updateGiftById('owner', gift.id, 'unsupported'), /不支持的礼物箱操作/);
  assert.equal(f.bytes(), before);
  assert.equal(f.store.getDraft('owner').title, '保留候选');
  assert.equal(f.store.ticketIntentContext('owner').catalog.find((item) => item.id === gift.id).status, 'active');
});

test('reminders exclude the exact thirty-second threshold and interpret date-only tickets at Shanghai noon', () => {
  const eventAt = Date.parse('2026-08-26T04:00:00.000Z');
  const item = { eventTime: '2026-08-26' };
  assert.equal(eventTimestamp(item.eventTime), eventAt);
  for (const [key, lead] of [['day', 24 * 60 * 60 * 1000], ['two-hours', 2 * 60 * 60 * 1000]]) {
    const sendAt = eventAt - lead;
    const before = ticketReminderSchedules(item, sendAt - 30_001);
    assert.equal(before.find((entry) => entry.key === key).sendAt, sendAt);
    assert.equal(ticketReminderSchedules(item, sendAt - 30_000).some((entry) => entry.key === key), false);
  }
  for (const eventTime of ['', '明天', '2026-08-26T12:00:00Z', '2026-13-26']) {
    assert.ok(Number.isNaN(eventTimestamp(eventTime)));
    assert.deepEqual(ticketReminderSchedules({ eventTime }, START), []);
  }
});

test('tickets archive only after the event plus twenty-four hours boundary', (t) => {
  const f = fixture(t);
  f.store.stage('owner', [
    { kind: 'ticket', title: '有时间的票', eventTime: '2026-08-26 12:00', tripScope: 'self' },
    { kind: 'ticket', title: '待定时间的票', eventTime: '待定', tripScope: 'self' },
  ]);
  const [timed, undated] = f.store.saveAll('owner', 'ticket');
  const boundary = Date.parse('2026-08-27T04:00:00.000Z');
  f.setNow(boundary);
  assert.equal(f.store.ticketIntentContext('owner').catalog.find((item) => item.id === timed.id).status, 'active');
  f.setNow(boundary + 1);
  const statuses = new Map(f.store.ticketIntentContext('owner').catalog.map((item) => [item.id, item.status]));
  assert.equal(statuses.get(timed.id), 'archived');
  assert.equal(statuses.get(undated.id), 'active');
});

test('ticket windows include the start, exclude the end and reject invalid ranges without replacing the view', (t) => {
  const f = fixture(t);
  f.store.stage('owner', [
    { kind: 'ticket', title: '起点票', eventTime: '2026-08-26 12:00', tripScope: 'self' },
    { kind: 'ticket', title: '终点票', eventTime: '2026-08-26 13:00', tripScope: 'self' },
    { kind: 'ticket', title: '无时间票', tripScope: 'self' },
  ]);
  const [first] = f.store.saveAll('owner', 'ticket');
  const startAt = Date.parse('2026-08-26T04:00:00.000Z');
  const endAt = startAt + 60 * 60 * 1000;
  f.store.list('owner', 'ticket', { window: { startAt, endAt } });
  assert.deepEqual(f.index().views.owner.itemIds, [first.id]);
  const before = f.bytes();
  for (const window of [{ startAt, endAt: startAt }, { startAt: endAt, endAt: startAt },
    { startAt: NaN, endAt }, { startAt, endAt: Infinity }, { startAt }]) {
    assert.throws(() => f.store.list('owner', 'ticket', { window }), /查询时间范围无效/);
    assert.equal(f.bytes(), before);
  }
});

test('deleteSide removes every owned status, drafts and view while retaining the other side', (t) => {
  const createdAt = new Date(START).toISOString();
  const peerDraft = [{ id: 'UI-PEER', kind: 'note', title: '对方草稿', createdAt }];
  const peerView = { kind: 'gift', itemIds: ['GF-PEER'], createdAt };
  const f = fixture(t, {
    drafts: { owner: [{ id: 'UI-OWN', kind: 'note', title: '本人草稿', createdAt }], friend: peerDraft },
    views: { owner: { kind: 'collection', itemIds: ['CL-OWN'], createdAt }, friend: peerView },
    items: [
      { id: 'CL-OWN', kind: 'collection', title: '本人收藏', ownerSide: 'owner', status: 'active', createdAt },
      { id: 'TK-OWN', kind: 'ticket', title: '本人归档票', ownerSide: 'owner', status: 'archived', createdAt },
      { id: 'GF-OWN', kind: 'gift', title: '本人已删礼物', ownerSide: 'owner', status: 'removed', createdAt },
      { id: 'GF-PEER', kind: 'gift', title: '对方礼物', ownerSide: 'friend', status: 'active', createdAt },
    ],
  });
  assert.deepEqual(f.store.deleteSide('owner'), { removed: 3 });
  const state = f.index();
  assert.deepEqual(state.items.map((item) => item.id), ['GF-PEER']);
  assert.deepEqual(state.drafts, { friend: peerDraft });
  assert.deepEqual(state.views, { friend: peerView });
  assert.deepEqual(f.store.deleteSide('owner'), { removed: 0 });
  assert.equal(f.store.explain('owner', '本人收藏'), null);
  assert.equal(f.store.ticketIntentContext('friend').catalog[0].title, '对方礼物');
});

test('lists and intent catalogs cap at thirty items with the current view taking catalog priority', (t) => {
  const items = Array.from({ length: 31 }, (_, i) => ({
    id: `CL-${i + 1}`, kind: 'collection', title: `收藏${i + 1}`, ownerSide: 'owner', status: 'active',
    createdAt: new Date(START - i * 1000).toISOString(), updatedAt: new Date(START - i * 1000).toISOString(),
  }));
  const f = fixture(t, { items });
  const gift = f.store.addGift('owner', '最新礼物');
  const listing = f.store.list('owner', 'collection');
  const expected = items.slice(0, 30).map((item) => item.id);
  assert.equal(listing.split('\n').filter((line) => /^\d+\. /u.test(line)).length, 30);
  assert.deepEqual(f.index().views.owner.itemIds, expected);
  assert.deepEqual(f.store.ticketIntentContext('owner').catalog.map((item) => item.id), expected);
  f.store.list('owner', 'gift');
  assert.deepEqual(f.store.ticketIntentContext('owner').catalog.map((item) => item.id), [gift.id, ...expected.slice(0, 29)]);
});

test('draft write and rename failures propagate and leave the prior persisted candidates intact', (t) => {
  const f = fixture(t);
  f.store.stage('owner', { kind: 'note', title: '已保存草稿' });
  const before = f.bytes();
  const drafts = f.store.getDrafts('owner');
  // Keep the fault within this fixture; item-body transaction semantics belong to record-state.
  for (const method of ['writeFileSync', 'renameSync']) {
    const original = fs[method];
    const failure = Object.assign(new Error(`synthetic ${method} failure`), { code: 'EIO' });
    let attempts = 0;
    const mocked = t.mock.method(fs, method, function (...args) {
      const target = args[method === 'renameSync' ? 1 : 0];
      if (typeof target === 'string' && path.resolve(target).startsWith(`${path.dirname(f.stateFile)}${path.sep}`)) {
        attempts += 1;
        throw failure;
      }
      return original.apply(this, args);
    });
    try {
      assert.throws(() => f.store.stage('owner', { kind: 'note', title: '失败的替换' }), (error) => error.cause === failure);
      assert.ok(attempts > 0);
      assert.equal(f.bytes(), before);
    } finally {
      mocked.mock.restore();
    }
    const reopened = createUniversalInboxStore({ stateFile: f.stateFile, now: () => START });
    assert.deepEqual(reopened.getDrafts('owner'), drafts);
  }
});
