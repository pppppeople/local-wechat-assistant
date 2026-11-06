'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildTicketIntentInstruction, extractTicketIntent, mightBeNaturalTicketIntent,
} = require('../src/ticket-intent-conversation');

const marker = (payload) => `[[TICKET_INTENT:${JSON.stringify(payload)}]]`;

test('disables instruction and detection without enabled context or usable text', () => {
  assert.equal(buildTicketIntentInstruction(), '');
  assert.equal(buildTicketIntentInstruction({ enabled: false }), '');
  assert.equal(mightBeNaturalTicketIntent('我们一起去'), false);
  assert.equal(mightBeNaturalTicketIntent('我们一起去', { enabled: false }), false);
  for (const value of [undefined, null, '', ' \r\n ', 0]) {
    assert.equal(mightBeNaturalTicketIntent(value, { enabled: true }), false);
  }
});

test('bounds and cleans every projected context collection and text field', () => {
  const item = {
    index: '2', title: ` \r\n${'t'.repeat(121)} `, eventTime: 'e'.repeat(41),
    placeName: 'p'.repeat(161), participantLabel: 'l'.repeat(91),
    kind: 'k'.repeat(21), status: 's'.repeat(21),
  };
  const projected = JSON.parse(buildTicketIntentInstruction({
    enabled: true, selfName: ` ${'a'.repeat(41)} `, peerName: '  B\r\nC  ',
    drafts: Array(6).fill(item), tickets: Array(31).fill(item),
    currentView: { kind: 'v'.repeat(21), items: Array(31).fill(item) },
    catalog: Array(31).fill(item),
  }).split('\n')[1]);
  assert.equal(projected.selfName, 'a'.repeat(40));
  assert.equal(projected.peerName, 'B C');
  assert.equal(projected.currentItemView.kind, 'v'.repeat(20));
  for (const [items, length] of [
    [projected.pendingTicketDrafts, 5], [projected.recentTicketView, 30],
    [projected.currentItemView.items, 30], [projected.deletionCatalog, 30],
  ]) {
    assert.equal(items.length, length);
    assert.equal(items[0].index, 2);
    assert.equal(items[0].title, 't'.repeat(120));
    assert.equal(items[0].eventTime, 'e'.repeat(40));
    assert.equal(items[0].placeName, 'p'.repeat(160));
  }
  assert.equal(projected.recentTicketView[0].participantLabel, 'l'.repeat(90));
  assert.equal(projected.deletionCatalog[0].kind, 'k'.repeat(20));
  assert.equal(projected.deletionCatalog[0].status, 's'.repeat(20));
  const empty = JSON.parse(buildTicketIntentInstruction({ enabled: true }).split('\n')[1]);
  assert.deepEqual(empty, {
    selfName: '', peerName: '', pendingTicketDrafts: [], recentTicketView: [],
    currentItemView: { kind: '', items: [] }, deletionCatalog: [],
  });
});

test('coerces and deduplicates indices with action-specific bounds and a five-item cap', () => {
  for (const [action, limit] of [['save_pending', 5], ['assign_saved', 30], ['remove_saved', 30]]) {
    const intent = extractTicketIntent(marker({
      action, tripScope: 'peer', indices: [0, -1, 1.5, 'bad', '1', 1, limit, limit + 1, 2, 3, 4, 5, 6],
      expectedCount: String(limit),
    })).intent;
    assert.deepEqual(intent, {
      action, indices: [1, limit, 2, 3, 4], all: false,
      ...(action === 'remove_saved' ? {} : { tripScope: 'peer' }), expectedCount: limit,
    });
    for (const expectedCount of [0, -1, 1.5, limit + 1, 'bad']) {
      const result = extractTicketIntent(marker({ action, indices: [1], tripScope: 'peer', expectedCount })).intent;
      assert.equal(Object.hasOwn(result, 'expectedCount'), false);
    }
    assert.equal(extractTicketIntent(marker({ action, indices: [limit + 1], tripScope: 'peer' })).intent, null);
  }
});

test('rejects invalid intent payloads and accepts only boolean all with valid assignment scope', () => {
  for (const payload of [
    null, [], 42, {}, { action: 'unknown', indices: [1] },
    { action: 'save_pending', indices: [1] },
    { action: 'assign_saved', indices: [1], tripScope: 'unknown' },
    { action: 'save_pending', indices: '1', tripScope: 'self' },
    { action: 'assign_saved', indices: [], tripScope: 'self', all: 'true' },
  ]) assert.equal(extractTicketIntent(marker(payload)).intent, null, JSON.stringify(payload));
  for (const action of ['save_pending', 'assign_saved']) {
    assert.deepEqual(extractTicketIntent(marker({ action, all: true, indices: [2], tripScope: 'pair' })).intent, {
      action, all: true, indices: [], tripScope: 'pair',
    });
  }
});

test('handles malformed, misplaced and length-limited ticket markers without throwing', () => {
  assert.deepEqual(extractTicketIntent(null), { reply: '', intent: null });
  assert.deepEqual(extractTicketIntent(123), { reply: '123', intent: null });
  assert.deepEqual(extractTicketIntent('  普通文本  '), { reply: '普通文本', intent: null });
  for (const raw of ['{bad}', 'null', '[]']) {
    assert.deepEqual(extractTicketIntent(`答复\n[[TICKET_INTENT:${raw}]]`), { reply: '答复', intent: null });
  }
  const payload = JSON.stringify({ action: 'save_pending', indices: [1], tripScope: 'self' });
  assert.deepEqual(extractTicketIntent(`前${marker(JSON.parse(payload))}后`), { reply: '前后', intent: null });
  assert.ok(extractTicketIntent(`[[TICKET_INTENT:${payload.padEnd(1800)}]] \n`).intent);
  const oversized = `[[TICKET_INTENT:${payload.padEnd(1801)}]]`;
  assert.deepEqual(extractTicketIntent(oversized), { reply: oversized, intent: null });
  const multiline = '[[TICKET_INTENT:{\n"action":"save_pending"}]]';
  assert.deepEqual(extractTicketIntent(multiline), { reply: multiline, intent: null });
});

test('detects catalog references and natural hints within the implemented text boundaries', () => {
  for (const collection of ['drafts', 'tickets', 'catalog']) {
    for (const field of ['title', 'placeName']) {
      assert.equal(mightBeNaturalTicketIntent('cafe不要了', {
        enabled: true, [collection]: [{ [field]: ' CAFE ' }],
      }), true);
    }
  }
  assert.equal(mightBeNaturalTicketIntent('甲不要了', { enabled: true, catalog: [{ title: '甲' }] }), false);
  assert.equal(mightBeNaturalTicketIntent('移除那个收藏', { enabled: true }), true);
  assert.equal(mightBeNaturalTicketIntent(`这${'甲'.repeat(12)}趟`, { enabled: true }), true);
  assert.equal(mightBeNaturalTicketIntent(`这${'甲'.repeat(13)}趟`, { enabled: true }), false);
  assert.equal(mightBeNaturalTicketIntent(`${'甲'.repeat(497)}一起去`, { enabled: true }), true);
  assert.equal(mightBeNaturalTicketIntent(`${'甲'.repeat(498)}一起去`, { enabled: true }), false);
});
