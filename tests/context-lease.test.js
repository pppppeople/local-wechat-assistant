'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REFRESH_REPLY_TTL_MS,
  consumeContextRefreshReply,
  CONTEXT_WARNING_AGE_MS,
  CONTEXT_WARNING_SENDS,
  MAX_CONTEXT_AGE_MS,
  MAX_PROACTIVE_SENDS,
  contextRefreshError,
  contextLeaseStatus,
  contextLeaseWarningStatus,
  invalidateContextLease,
  isContextRefreshFailure,
  recordContextLeaseWarning,
  recordProactiveSend,
  refreshContextLease,
} = require('../src/context-lease');

test('warning reply is role-local, survives inbound refresh, and is consumed once within 24 hours', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  let leases = refreshContextLease({}, { senderId: 'owner', token: 'demo-old', now });
  const unmarked = consumeContextRefreshReply(leases, { senderId: 'owner', now });
  assert.equal(unmarked.consumed, false);
  leases = recordContextLeaseWarning(leases, { senderId: 'owner', token: 'demo-old', now });
  assert.equal(recordContextLeaseWarning(leases, { senderId: 'owner', token: 'demo-old', now: now + 1 }), leases);
  assert.equal(consumeContextRefreshReply(leases, { senderId: 'friend', now }).consumed, false);
  const refreshed = refreshContextLease(leases, { senderId: 'owner', token: 'demo-new', now: now + 1 });
  const reply = consumeContextRefreshReply(refreshed, { senderId: 'owner', now: now + REFRESH_REPLY_TTL_MS - 1 });
  assert.equal(reply.consumed, true);
  assert.equal(consumeContextRefreshReply(reply.leases, { senderId: 'owner', now: now + 2 }).consumed, false);
  assert.equal(refreshed.owner.refreshReplyExpiresAt, now + REFRESH_REPLY_TTL_MS);
  const expired = consumeContextRefreshReply(refreshed, { senderId: 'owner', now: now + REFRESH_REPLY_TTL_MS });
  assert.equal(expired.consumed, false);
  assert.equal(expired.leases.owner.refreshReplyExpiresAt, undefined);
});

test('identifies context refresh failures across supported inputs', () => {
  assert.equal(isContextRefreshFailure(new Error('send ret=-2')), true);
  assert.equal(isContextRefreshFailure('Prepare Failed'), true);
  assert.equal(isContextRefreshFailure(new Error('Context Refresh Required')), true);
  assert.equal(isContextRefreshFailure(new Error('other error')), false);
  assert.equal(isContextRefreshFailure(''), false);
  assert.equal(isContextRefreshFailure(null), false);
  assert.equal(isContextRefreshFailure(42), false);
});

test('creates context refresh errors with explicit and default reasons', () => {
  const expired = contextRefreshError('token expired');
  assert.ok(expired instanceof Error);
  assert.equal(expired.message, 'context refresh required: token expired');
  assert.equal(expired.code, 'WECHAT_CONTEXT_REFRESH_REQUIRED');

  const unavailable = contextRefreshError();
  assert.ok(unavailable instanceof Error);
  assert.equal(unavailable.message, 'context refresh required: unavailable');
  assert.equal(unavailable.code, 'WECHAT_CONTEXT_REFRESH_REQUIRED');
});

test('proactive context closes before the platform age and message limits', () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  let leases = refreshContextLease({}, { senderId: 'owner', token: 'fresh', now });
  assert.deepEqual(contextLeaseStatus(leases, { senderId: 'owner', token: 'fresh', now }), {
    available: true, reason: 'fresh',
  });
  assert.equal(contextLeaseStatus(leases, {
    senderId: 'owner', token: 'fresh', now: now + MAX_CONTEXT_AGE_MS,
  }).reason, 'expired');
  for (let index = 0; index < MAX_PROACTIVE_SENDS; index += 1) {
    leases = recordProactiveSend(leases, { senderId: 'owner', token: 'fresh', now: now + index + 1 });
  }
  assert.equal(contextLeaseStatus(leases, { senderId: 'owner', token: 'fresh', now: now + 10 }).reason, 'budget');
});

test('warns once before age or proactive-send limits and resets on inbound', () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  let leases = refreshContextLease({}, { senderId: 'owner', token: 'fresh', now });
  assert.deepEqual(contextLeaseWarningStatus(leases, {
    senderId: 'owner', token: 'fresh', now: now + CONTEXT_WARNING_AGE_MS - 1,
  }), { due: false, reason: 'fresh' });
  assert.deepEqual(contextLeaseWarningStatus(leases, {
    senderId: 'owner', token: 'fresh', now: now + CONTEXT_WARNING_AGE_MS,
  }), { due: true, reason: 'age' });

  leases = recordContextLeaseWarning(leases, { senderId: 'owner', token: 'fresh', now: now + 1 });
  assert.equal(contextLeaseWarningStatus(leases, {
    senderId: 'owner', token: 'fresh', now: now + CONTEXT_WARNING_AGE_MS,
  }).reason, 'already_sent');

  leases = refreshContextLease(leases, { senderId: 'owner', token: 'new', now: now + 2 });
  for (let index = 0; index < CONTEXT_WARNING_SENDS; index += 1) {
    leases = recordProactiveSend(leases, { senderId: 'owner', token: 'new', now: now + 3 + index });
  }
  assert.deepEqual(contextLeaseWarningStatus(leases, {
    senderId: 'owner', token: 'new', now: now + 10,
  }), { due: true, reason: 'budget' });
});

test('a new inbound context resets invalidation and the proactive budget', () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const first = refreshContextLease({}, { senderId: 'owner', token: 'old', now });
  const invalid = invalidateContextLease(first, { senderId: 'owner', token: 'old', now: now + 1 });
  assert.equal(contextLeaseStatus(invalid, { senderId: 'owner', token: 'old', now: now + 2 }).reason, 'invalidated');
  const refreshed = refreshContextLease(invalid, { senderId: 'owner', token: 'new', now: now + 3 });
  assert.equal(contextLeaseStatus(refreshed, { senderId: 'owner', token: 'new', now: now + 4 }).available, true);
  assert.equal(refreshed.owner.proactiveSends, 0);
  assert.equal(invalidateContextLease(refreshed, { senderId: 'owner', token: 'old', now: now + 5 }), refreshed);
});
