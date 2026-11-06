'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseUniversalInboxCommand } = require('../src/universal-inbox-commands');

test('returns null for empty, whitespace, non-text, and unknown commands', () => {
  assert.equal(parseUniversalInboxCommand(''), null);
  assert.equal(parseUniversalInboxCommand('   \n\t'), null);
  assert.equal(parseUniversalInboxCommand(null), null);
  assert.equal(parseUniversalInboxCommand(undefined), null);
  assert.equal(parseUniversalInboxCommand('这不是收件箱命令'), null);
});

test('recognizes help aliases and keeps help independent of draft state', () => {
  assert.deepEqual(parseUniversalInboxCommand('万能收件箱说明'), { type: 'help' });
  assert.deepEqual(parseUniversalInboxCommand('收件箱怎么玩', { hasDraft: false }), { type: 'help' });
});

test('lists collection, gift, and date-scoped ticket views', () => {
  assert.deepEqual(parseUniversalInboxCommand('打开收藏列表'), { type: 'list', kind: 'collection' });
  assert.deepEqual(parseUniversalInboxCommand('列出我的惊喜箱'), { type: 'list', kind: 'gift' });
  assert.deepEqual(parseUniversalInboxCommand('查看今天的我的行程', { side: 'owner' }), {
    type: 'list', kind: 'ticket', dayOffset: 0, tripScope: 'self',
  });
  assert.deepEqual(parseUniversalInboxCommand('明天对方的票券', { side: 'friend' }), {
    type: 'list', kind: 'ticket', dayOffset: 1, tripScope: 'peer',
  });
});

test('parses bulk and numbered assignment boundaries', () => {
  assert.deepEqual(parseUniversalInboxCommand('上面两张都是我们的票券'), {
    type: 'assign_tickets', indices: [], expectedCount: 2, tripScope: 'pair',
  });
  assert.deepEqual(parseUniversalInboxCommand('第5个改为对方的行程'), {
    type: 'assign_ticket', index: 5, tripScope: 'peer',
  });
  assert.deepEqual(parseUniversalInboxCommand('第6个改为我的行程'), {
    type: 'assign_ticket', index: 6, tripScope: 'self',
  });
  assert.deepEqual(parseUniversalInboxCommand('第一个和第二个都是我的票券', { side: 'friend' }), {
    type: 'assign_tickets', indices: [1, 2], expectedCount: 0, tripScope: 'self',
  });
});

test('parses place, relay, and discard actions with explicit indexes', () => {
  assert.deepEqual(parseUniversalInboxCommand('加入我们的想去箱', { hasDraft: true }), {
    type: 'resolve', action: 'place', index: 0,
  });
  assert.deepEqual(parseUniversalInboxCommand('1发给对方', { hasDraft: true }), {
    type: 'resolve', action: 'relay', index: 1,
  });
  assert.deepEqual(parseUniversalInboxCommand('5取消', { hasDraft: true }), {
    type: 'resolve', action: 'discard', index: 5,
  });
});

test('parses a valid reminder and preserves its resolved schedule', () => {
  const result = parseUniversalInboxCommand('明天18:30提醒我处理这个', {
    hasDraft: true,
    now: new Date('2026-10-26T00:00:00Z'),
  });
  assert.equal(result.type, 'resolve');
  assert.equal(result.action, 'reminder');
  assert.equal(result.index, 0);
  assert.equal(result.schedule.description, '10/27周二 18:30');
  assert.equal(result.schedule.recurrence, null);
});

test('rejects malformed reminder time as an input error', () => {
  assert.throws(
    () => parseUniversalInboxCommand('稍后提醒我处理这个', { hasDraft: true }),
    /请写明时间/,
  );
});

test('does not treat an overlong numbered prefix as a valid item index', () => {
  assert.equal(parseUniversalInboxCommand('99收藏', { hasDraft: true }), null);
  assert.equal(parseUniversalInboxCommand('第六个收藏', { hasDraft: true }), null);
});
