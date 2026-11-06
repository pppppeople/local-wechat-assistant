'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { compactError, createWechatLinkHealth } = require('../src/wechat-link-health');

test('records poll recovery and send failures without storing a stack', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-link-health-'));
  const file = path.join(dir, 'health.json');
  let timestamp = Date.parse('2026-07-29T01:00:00Z');
  const health = createWechatLinkHealth(file, { now: () => new Date(timestamp) });

  health.recordPollFailure(new TypeError('fetch failed'));
  timestamp += 1000;
  health.recordPollFailure(new Error('network down'));
  let state = health.read();
  assert.equal(state.status, 'degraded');
  assert.equal(state.consecutivePollFailures, 2);
  assert.equal(state.lastPollError, 'Error: network down');

  timestamp += 1000;
  health.recordPollSuccess({ messageCount: 3 });
  state = health.read();
  assert.equal(state.status, 'healthy');
  assert.equal(state.consecutivePollFailures, 0);
  assert.equal(state.lastPollMessageCount, 3);
  assert.equal(state.lastPollError, null);

  timestamp += 1000;
  health.recordSendFailure(new Error('delivery failed\nwith stack-like detail'));
  state = health.read();
  assert.equal(state.consecutiveSendFailures, 1);
  assert.equal(state.lastSendError, 'Error: delivery failed with stack-like detail');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('records send success after failure while preserving the failure timestamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-link-health-'));
  const file = path.join(dir, 'health.json');
  let timestamp = Date.parse('2026-07-29T01:00:00Z');
  const health = createWechatLinkHealth(file, { now: () => new Date(timestamp) });

  try {
    health.recordSendFailure(new Error('delivery failed'));
    const failureTime = new Date(timestamp).toISOString();
    timestamp += 1000;
    health.recordSendSuccess();
    const state = health.read();
    assert.equal(state.consecutiveSendFailures, 0);
    assert.equal(state.lastSendError, null);
    assert.equal(state.lastSendSuccessAt, new Date(timestamp).toISOString());
    assert.equal(state.lastSendFailureAt, failureTime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('records send success in a fresh health file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-link-health-'));
  const file = path.join(dir, 'health.json');
  const timestamp = Date.parse('2026-07-29T01:00:00Z');
  const health = createWechatLinkHealth(file, { now: () => new Date(timestamp) });

  try {
    health.recordSendSuccess();
    const state = health.read();
    assert.equal(state.lastSendSuccessAt, new Date(timestamp).toISOString());
    assert.equal(state.consecutiveSendFailures, 0);
    assert.equal(state.lastSendError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compacts long errors before writing operational state', () => {
  const message = compactError(new Error('x'.repeat(500)));
  assert.ok(message.length <= 307);
  assert.match(message, /^Error: x+$/);
  assert.equal(
    compactError(new Error('Authorization: Bearer abc123 token=secret-value')),
    'Error: Authorization: [REDACTED] token=[REDACTED]',
  );
});
