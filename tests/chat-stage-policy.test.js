'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatStageRunner } = require('../src/chat-stage-policy');
const failed = { ok: false, errorKind: 'TRANSIENT', failureReason: 'timeout', error: 'synthetic timeout' };

test('stage budgets and attempt metadata are applied to the existing runner', async () => {
  const calls = [];
  const run = createChatStageRunner({ run: async (...args) => { calls.push(args); return { ok: true }; } });
  for (const stage of ['理解完整请求', '独立普通回答核对', '独立语义核对', 'ordinary_answer', '根据真实结果规划下一步', 'unknown']) {
    await run('synthetic', '', [], { stage });
  }
  assert.deepEqual(calls.map(call => call[3].timeoutMs), [40000, 40000, 40000, 60000, 120000, 120000]);
  assert.ok(calls.every(call => call[3].attempt === 1 && call[3].maxAttempts === 1));
});

test('pure text retries once on a fresh thread with a rebuilt bounded prompt', async () => {
  const calls = [];
  let at = 0, counted = 0;
  const run = createChatStageRunner({ now: () => at, run: async (...args) => {
    calls.push(args); at += 60000; return calls.length === 1 ? failed : { ok: true, plan: { reply: 'synthetic' } };
  } });
  const result = await run('continuation', 'existing', [], { stage: 'ordinary_answer', retrySafe: true,
    budget: { remainingMs: 150000 }, rebuildPrompt: () => 'bounded originals', onAttempt: () => counted++ });
  assert.equal(result.ok, true); assert.equal(result.attempts, 2); assert.equal(counted, 2);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['continuation', 'existing'], ['bounded originals', '']]);
  assert.deepEqual(calls.map(call => call[3].budget.remainingMs), [150000, 90000]);
  assert.equal(calls[1][3].retryReason, 'timeout');
});

test('failure cannot cause a third attempt or replay tool-planning rounds', async () => {
  for (const response of [{ stage: 'ordinary_answer', retrySafe: true },
    { stage: 'ordinary_answer', retrySafe: false }, { stage: '根据真实结果规划下一步', retrySafe: true }]) {
    let calls = 0;
    const run = createChatStageRunner({ run: async () => { calls++; return failed; } });
    const result = await run('synthetic', '', [], response);
    assert.equal(calls, response.retrySafe && response.stage === 'ordinary_answer' ? 2 : 1);
    assert.equal(result.attempts, calls);
  }
});

test('parallel admission cannot retry once any feature dispatch has started', async () => {
  let dispatched = false, calls = 0;
  const run = createChatStageRunner({ run: async () => { calls++; dispatched = true; return failed; } });
  const result = await run('synthetic', '', [], { stage: '独立普通回答核对', retrySafe: true, isRetrySafe: () => !dispatched });
  assert.equal(result.attempts, 1); assert.equal(calls, 1);
});

test('auth, quota and unexpected tool failures never retry, even in a pure stage', async () => {
  for (const failure of [{ ...failed, errorKind: 'AUTH' }, { ...failed, errorKind: 'QUOTA_EXHAUSTED' },
    { ...failed, authFailed: true }, { ...failed, failureReason: 'unexpected_tool' }]) {
    let calls = 0;
    const run = createChatStageRunner({ run: async () => { calls++; return failure; } });
    await run('synthetic', '', [], { retrySafe: true }); assert.equal(calls, 1);
  }
});

test('the absolute request deadline includes earlier waiting and cannot renew on retry', async () => {
  let at = 140000, calls = 0;
  const run = createChatStageRunner({ now: () => at, run: async (_, __, ___, response) => {
    calls++; assert.equal(response.budget.remainingMs, 10000); at = 150001; return failed;
  } });
  const result = await run('synthetic', '', [], { retrySafe: true, budget: { deadlineAt: 150000, remainingMs: 150000 } });
  assert.equal(result.errorKind, 'BUDGET'); assert.equal(result.attempts, 1); assert.equal(calls, 1);
  const next = await run('synthetic', '', [], { retrySafe: true, budget: { deadlineAt: 150000 } });
  assert.equal(next.attempts, 0); assert.equal(calls, 1);
});
