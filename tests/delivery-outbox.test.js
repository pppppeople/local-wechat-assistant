'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createDeliveryOutbox } = require('../src/delivery-outbox');

test('missing outbox returns an empty state without creating a file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json');
  const outbox = createDeliveryOutbox(file);
  assert.deepEqual(outbox.read(), { schemaVersion: 1, deliveries: [] });
  assert.equal(outbox.count(), 0);
  assert.equal(fs.existsSync(file), false);
});

test('directory outbox path throws EISDIR and leaves the directory intact', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => createDeliveryOutbox(dir).count(), { code: 'EISDIR' });
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test('corrupt JSON is quarantined intact and subsequent operations use a fresh outbox', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json');
  const original = Buffer.from('{"deliveries": [\n损坏\n');
  const outbox = createDeliveryOutbox(file, { now: () => new Date('2026-10-29T01:02:03.456Z') });
  const quarantine = `${file}.corrupt-2026-10-29T01-02-03-456Z`;
  fs.writeFileSync(file, original);
  assert.throws(() => outbox.count(), (error) => {
    assert.match(error.message, /delivery outbox file is corrupt/i);
    assert.ok(error.message.includes(quarantine));
    return true;
  });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readFileSync(quarantine), original);
  assert.equal(outbox.enqueue({ id: 'fresh', senderId: 'u1', text: 'fresh' }), true);
  assert.equal(outbox.count(), 1);
  assert.equal(outbox.claim().id, 'fresh');
  assert.equal(outbox.recover(), 1);
  assert.equal(outbox.claim().attempts, 2);
  outbox.complete('fresh');
  assert.equal(outbox.count(), 0);
  assert.deepEqual(fs.readFileSync(quarantine), original);

  // A second corruption with the same injected clock must preserve both files.
  fs.writeFileSync(file, 'another broken journal');
  assert.throws(() => outbox.enqueue({ id: 'blocked', senderId: 'u1' }), /is corrupt/);
  assert.deepEqual(fs.readFileSync(quarantine), original);
  assert.equal(fs.readFileSync(`${quarantine}-1`, 'utf8'), 'another broken journal');
});

test('wrong-shape JSON is quarantined instead of being treated as empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [index, content] of ['{"x":1}', 'null', '[]', '{"deliveries":{}}'].entries()) {
    const file = path.join(dir, `outbox-${index}.json`);
    fs.writeFileSync(file, content);
    const outbox = createDeliveryOutbox(file, { now: () => new Date('2026-10-29T00:00:00Z') });
    const quarantine = `${file}.corrupt-2026-10-29T00-00-00-000Z`;
    assert.throws(() => outbox.read(), (error) => {
      assert.match(error.message, /delivery outbox file is corrupt/i);
      assert.ok(error.message.includes(quarantine));
      return true;
    });
    assert.equal(fs.readFileSync(quarantine, 'utf8'), content);
    assert.deepEqual(outbox.read(), { schemaVersion: 1, deliveries: [] });
  }
});

test('quarantine rename failure reports corruption and leaves the original untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json');
  fs.writeFileSync(file, 'broken');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('rename denied'); });
  assert.throws(() => createDeliveryOutbox(file).enqueue({ id: 'blocked' }),
    /Delivery outbox file is corrupt:.*failed to quarantine.*rename denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  rename.mock.restore();
});

test('persists, defers, recovers and completes an ordinary answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  const file = path.join(dir, 'outbox.json');
  let timestamp = Date.parse('2026-07-29T12:00:00Z');
  const outbox = createDeliveryOutbox(file, { now: () => new Date(timestamp) });

  assert.equal(outbox.enqueue({
    id: 'answer-1',
    clientId: 'stable-client-id',
    senderId: 'u1',
    text: '完整回答',
    kind: 'ordinary-answer',
    metadata: { userText: '原问题', imageCount: 0 },
  }), true);
  assert.equal(outbox.enqueue({ id: 'answer-1', senderId: 'u1', text: '重复' }), false);
  assert.equal(outbox.count(), 1);

  const claimed = outbox.claim();
  assert.equal(claimed.clientId, 'stable-client-id');
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.metadata.userText, '原问题');

  outbox.defer('answer-1', new Error('fetch failed'), 15000);
  assert.equal(outbox.claim(), null);
  timestamp += 15000;
  assert.equal(outbox.claim().attempts, 2);
  assert.equal(outbox.recover(), 1);
  assert.equal(outbox.claim().attempts, 3);
  outbox.complete('answer-1');
  assert.equal(outbox.count(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cancels only pending deliveries for the selected sender', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  const outbox = createDeliveryOutbox(path.join(dir, 'outbox.json'));
  outbox.enqueue({ id: 'u1-pending', senderId: 'u1', text: 'a' });
  outbox.enqueue({ id: 'u2-pending', senderId: 'u2', text: 'b' });
  assert.deepEqual(outbox.cancelPending('u1').map((item) => item.id), ['u1-pending']);
  assert.equal(outbox.count(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an initial delivery grace period prevents the retry worker racing the foreground send', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-grace-'));
  let timestamp = Date.parse('2026-09-04T12:00:00Z');
  const outbox = createDeliveryOutbox(path.join(dir, 'outbox.json'), { now: () => new Date(timestamp) });
  outbox.enqueue({ id: 'answer-race', senderId: 'u1', text: '只应发送一次', initialDelayMs: 15000 });
  assert.equal(outbox.claim(), null);
  assert.equal(outbox.nextAttemptDelay(), 15000);
  timestamp += 15000;
  assert.equal(outbox.claim().id, 'answer-race');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('context-blocked deliveries wait without consuming retries and resume on inbound context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-outbox-'));
  let timestamp = Date.parse('2026-08-25T00:00:00Z');
  const outbox = createDeliveryOutbox(path.join(dir, 'outbox.json'), { now: () => new Date(timestamp) });
  outbox.enqueue({ id: 'completion', senderId: 'owner', text: '完成了', kind: 'task-completion' });
  const first = outbox.claim();
  outbox.waitForContext(first.id, new Error('context refresh required'));
  timestamp += 24 * 60 * 60 * 1000;
  assert.equal(outbox.claim(), null);
  assert.equal(outbox.nextAttemptDelay(), null);
  assert.equal(outbox.refreshContext('owner'), 1);
  const resumed = outbox.claim();
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.attempts, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
