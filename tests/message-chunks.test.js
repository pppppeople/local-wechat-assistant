'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { answerDeliveries, splitMessage } = require('../src/message-chunks');
const { createDeliveryOutbox } = require('../src/delivery-outbox');

test('single-chunk answers preserve identity and full history, and empty messages have no chunks', () => {
  const id = 'single-answer';
  const text = '短回复';
  const parts = answerDeliveries({ id, senderId: 'owner', text, userText: '查询', imageCount: 0 });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].id, id);
  assert.equal(parts[0].text, text);
  assert.equal(parts[0].clientId, `codex-wechat:${id}:1`);
  assert.equal(parts[0].metadata.recordHistory, true);
  assert.equal(parts[0].metadata.historyText, text);
  assert.equal(parts[0].initialDelayMs, 30000);
  assert.deepEqual(splitMessage(''), []);
});

test('long tool results have bounded chunks, stable client IDs and one transcript entry', () => {
  const text = `已经标记三个地点。\n\n${'天气推荐'.repeat(1000)}`;
  const parts = answerDeliveries({ id: 'answer', senderId: 'owner', text, userText: '标记并推荐', imageCount: 0 });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.text.length < 1750));
  assert.equal(parts.filter((part) => part.metadata.recordHistory).length, 1);
  assert.equal(new Set(parts.map((part) => part.clientId)).size, parts.length);
  assert.equal(parts.at(-1).metadata.historyText, text.slice(0, 1800));
  assert.deepEqual(parts, answerDeliveries({ id: 'answer', senderId: 'owner', text, userText: '标记并推荐', imageCount: 0 }));
  assert.deepEqual(splitMessage('短回复'), ['短回复']);
});

test('partial delivery retries only remaining chunks, preserving final history metadata across restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-chunks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'outbox.json');
  const parts = answerDeliveries({ id: 'answer', senderId: 'owner', text: '地点'.repeat(2000), userText: '查询', imageCount: 0 });
  const box = createDeliveryOutbox(file);
  parts.forEach((part) => box.enqueue(part));
  box.complete(parts[0].id);
  parts.forEach((part) => box.defer(part.id, Error('temporary'), 0));
  const resumed = createDeliveryOutbox(file);
  assert.equal(resumed.count(), parts.length - 1);
  let entry; let histories = 0;
  while ((entry = resumed.claim())) {
    assert.notEqual(entry.id, parts[0].id);
    if (entry.metadata.recordHistory) { histories++; assert.equal(entry.metadata.historyText.length, 1800); }
    resumed.complete(entry.id);
  }
  assert.equal(histories, 1);
});
