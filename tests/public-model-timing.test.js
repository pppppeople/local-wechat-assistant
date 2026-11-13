'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicModel } = require('../src/public-model');
const { createOrdinaryChat } = require('../src/ordinary-chat-lanes');
const config = { endpoint: 'https://synthetic.invalid/chat', name: 'synthetic-model', apiKey: 'synthetic-placeholder', timeoutMs: 30000 };

test('non-streaming HTTP adapter keeps full stage budget and records no observable first output', async t => {
  const timeouts = [], timings = [], bodies = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  const model = createPublicModel(config, { fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '合成回答' } }] }) };
  } });
  assert.equal(await model('合成问题', { stage: 'ordinary_answer', timeoutMs: 60000, firstOutputTimeoutMs: 15000,
    onTiming: record => timings.push(record) }), '合成回答');
  assert.deepEqual(timeouts, [60000]); assert.equal(bodies[0].stream, undefined);
  assert.deepEqual(timings, [{ timeoutReason: null, firstOutputWatchdog: false, firstOutputMs: null }]);
});

test('stage abort before headers or during JSON body is never labelled a first-output watchdog', async t => {
  for (const phase of ['headers', 'body']) {
    const controller = new AbortController(), timings = [];
    const mock = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    let calls = 0;
    const abort = () => { controller.abort(); throw controller.signal.reason; };
    const model = createPublicModel(config, { fetchImpl: async () => {
      calls++;
      if (phase === 'headers') abort();
      return { ok: true, json: async () => abort() };
    } });
    await assert.rejects(model('合成问题', { firstOutputTimeoutMs: 15000, onTiming: record => timings.push(record) }),
      error => error.errorKind === 'TRANSIENT' && error.timeoutReason === 'stage_budget');
    assert.equal(calls, 1);
    assert.deepEqual(timings, [{ timeoutReason: 'stage_budget', firstOutputWatchdog: false, firstOutputMs: null }]);
    mock.mock.restore();
  }
});

test('stock adapter stage timeout discards a draft without watchdog retry and writes countable body-free logs', async t => {
  let calls = 0;
  const logs = [], timeouts = [], controllers = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms); const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  const model = createPublicModel(config, { fetchImpl: async (_url, options) => {
    if (++calls === 1) {
      controllers[0].abort(); throw options.signal.reason;
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '基线回答' } }] }) };
  } });
  assert.equal(await createOrdinaryChat({ model, log: line => logs.push(line) })('你好', { state: { known: true } }), '基线回答');
  assert.equal(calls, 2); assert.deepEqual(timeouts, [60000, 60000]);
  const rows = logs.filter(line => line.startsWith('model timing ')).map(line => JSON.parse(line.slice(13)));
  assert.equal(rows[0].timeoutReason, 'stage_budget');
  assert.ok(rows.every(r => r.firstOutputWatchdog === false && r.firstOutputMs === null));
  assert.ok(logs.every(line => !line.includes('合成问题') && !line.includes('synthetic-placeholder') && !line.includes('基线回答')));
});


test('HTTP auth remains terminal when its error body reaches the stage timeout', async t => {
  const controller = new AbortController(), logs = [];
  let calls = 0;
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const model = createPublicModel(config, { fetchImpl: async () => {
    calls++;
    return { ok: false, status: 401, json: async () => { controller.abort(); throw controller.signal.reason; } };
  } });
  await assert.rejects(createOrdinaryChat({ model, log: line => logs.push(line) })('你好', { state: { known: true } }),
    error => error.status === 401);
  assert.equal(calls, 1);
  const row = JSON.parse(logs.find(line => line.startsWith('model timing ')).slice(13));
  assert.equal(row.errorKind, 'AUTH'); assert.equal(row.timeoutReason, 'stage_budget');
  assert.equal(row.firstOutputWatchdog, false);
});
