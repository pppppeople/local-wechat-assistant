'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ordinaryBatchDelay } = require('../src/ordinary-batch');
const { createPublicWechat } = require('../src/public-wechat');
const account = { accountId: 'synthetic-account', userId: 'synthetic-owner', token: 'synthetic-token', baseUrl: 'https://synthetic.invalid/' };
const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
async function turns() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function fixture(t, options = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'public-batch-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  let clock = 10000, sequence = 0, messages = [], sends = [];
  const timers = new Map(), calls = [];
  const config = { runtime, account, now: () => clock,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
    assistant: { canBatch: text => !text.startsWith('记一下'), reply: async (text, side, metadata) => {
      calls.push({ text, side, metadata, at: clock }); return '合成回复';
    } },
    fetchImpl: async (url, request) => {
      if (url.endsWith('getupdates')) { const value = messages; messages = []; return response({ msgs: value, get_updates_buf: 'synthetic-cursor' }); }
      sends.push(JSON.parse(request.body)); return response({ ret: 0 });
    }, ...options };
  let transport = createPublicWechat(config);
  async function poll(text, id, extra = {}) {
    if (text) messages.push({ message_id: id, from_user_id: account.userId, to_user_id: account.accountId,
      context_token: `synthetic-context-${id}`, item_list: [{ type: 1, text_item: { text } }], ...extra });
    await transport.pollOnce({ waitForIdle: false }); await turns();
  }
  async function advance(ms) {
    const target = clock + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      clock = next[1].at; timers.delete(next[0]); next[1].callback(); await turns();
    }
    clock = target; await turns();
  }
  return { runtime, calls, sends, poll, advance, timers, config,
    restart() { for (const id of timers.keys()) config.clearTimer(id); transport = createPublicWechat(config); return transport; },
    read: () => JSON.parse(fs.readFileSync(path.join(runtime, 'state/transport/checkpoint.json'))),
    idle: () => transport.idle() };
}
test('real ingress persists immediately, resets one-second quiet and keeps first arrival and all IDs', async t => {
  const f = fixture(t);
  await f.poll('你好', 'a');
  assert.equal(f.read().queue[0].status, 'buffering');
  await f.advance(700); await f.poll('谢谢', 'b');
  await f.advance(999); assert.equal(f.calls.length, 0);
  await f.advance(1); await f.idle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].text, '你好\n谢谢');
  assert.equal(f.calls[0].metadata.receivedAt, 10000); assert.equal(f.calls[0].at, 11700);
  assert.equal(f.calls[0].metadata.fragments, 2);
  assert.deepEqual(f.read().processed, ['a', 'b']);
  assert.equal(f.sends[0].msg.context_token, 'synthetic-context-b');
  await f.poll('你好', 'a'); await f.advance(1000); assert.equal(f.calls.length, 1);
});
test('continuous arrivals flush by 3.5 seconds, independent of polling cadence', async t => {
  const f = fixture(t); await f.poll('片段', 'a');
  for (let i = 1; i <= 4; i++) { await f.advance(800); await f.poll('片段', `part-${i}`); }
  await f.advance(299); assert.equal(f.calls.length, 0);
  await f.advance(1); await f.idle(); assert.equal(f.calls[0].at, 13500);
  assert.equal(f.calls[0].metadata.fragments, 5);
  assert.equal(ordinaryBatchDelay(1000, 4500), 0);
});
test('all text items and attachment provenance survive acceptance and buffered recovery', async t => {
  const f = fixture(t);
  await f.poll('unused', 'multi', { item_list: [
    { type: 1, text_item: { text: '第一段合成文字' } }, { type: 2 },
    { type: 1, text_item: { text: '   ' } }, { type: 1, text_item: {} },
    { type: 1, text_item: { text: '第二段合成文字' } },
  ] });
  assert.deepEqual(f.read().queue[0].texts, ['第一段合成文字\n第二段合成文字']);
  assert.deepEqual(f.read().queue[0].messageIds, ['multi']);
  f.restart(); await f.poll(); await f.idle();
  assert.equal(f.calls[0].text, '第一段合成文字\n第二段合成文字');
  assert.equal(f.calls[0].metadata.hasAttachment, true);
  assert.equal(f.calls[0].metadata.recovery, true);
  assert.deepEqual(f.read().processed, ['multi']);
});
test('attachment provenance survives batching and restart; legacy queued provenance is unknown', async t => {
  const f = fixture(t);
  await f.poll('你好', 'media', { item_list: [{ type: 1, text_item: { text: '你好' } }, { type: 2 }] });
  assert.equal(f.read().queue[0].hasAttachment, true);
  f.restart(); await f.poll(); await f.idle();
  assert.equal(f.calls[0].metadata.hasAttachment, true); assert.equal(f.calls[0].metadata.recovery, true);
  assert.equal(f.calls[0].metadata.receivedAt, 10000);
});
test('known commands flush the prior batch and stay separate; no feature or sending replay on failure', async t => {
  const f = fixture(t); await f.poll('你好', 'chat'); await f.advance(100);
  await f.poll('记一下 纸船', 'feature'); await f.idle();
  assert.deepEqual(f.calls.map(c => c.text), ['你好', '记一下 纸船']);
  assert.equal(f.calls[1].metadata.fragments, 1);
});
test('arrivals during an active model turn stay queued and do not execute concurrently', async t => {
  let finish; let active = 0; const started = [];
  const f = fixture(t, { assistant: { canBatch: () => true, reply: async text => {
    assert.equal(active++, 0); started.push(text);
    if (started.length === 1) await new Promise(resolve => { finish = resolve; });
    active--; return '合成回复';
  } } });
  await f.poll('第一批', 'a'); await f.advance(1000);
  await f.poll('第二批', 'b'); await f.advance(1000);
  assert.equal(started.length, 1); assert.equal(f.read().queue.length, 1);
  finish(); await turns(); await f.idle();
  assert.deepEqual(started, ['第一批', '第二批']); assert.deepEqual(f.read().processed, ['a', 'b']);
});
test('model/dispatch expiry does not discard an in-flight result or its stable delivery identity', async t => {
  let finish; const f = fixture(t, { assistant: { canBatch: () => true, reply: () => new Promise(resolve => { finish = resolve; }) } });
  await f.poll('纯文字', 'a'); await f.advance(1000);
  await f.poll('排队文字', 'b'); await f.advance(150000);
  finish('真实已完成结果'); await turns(); await f.idle();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].msg.item_list[0].text_item.text, '真实已完成结果');
  assert.match(f.sends[1].msg.item_list[0].text_item.text, /时间已达上限/);
});
