'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrdinaryChat } = require('../src/ordinary-chat-lanes');
const { createFastlaneProvider } = require('../src/fastlane-provider');
const { createPublicModel } = require('../src/public-model');
const { createPublicAssistant } = require('../src/public-assistant');
const { createPairConsole } = require('../src/public-pair-console');
const { cases } = require('./chat-lanes-cases.json');
const known = { known: true, history: [] };
const draft = '{"reply":"合成草稿","needs_tool":false}';
const envConfig = () => ({ FASTLANE_MODEL_ENDPOINT: 'https://secondary.invalid/chat/completions',
  FASTLANE_MODEL_NAME: 'synthetic-secondary', FASTLANE_MODEL_API_KEY: 'synthetic-placeholder' });
const completion = (content = draft, extra = {}, finish_reason = 'stop') => ({ ok: true,
  json: async () => ({ choices: [{ finish_reason, message: { role: 'assistant', content, ...extra } }] }) });
const rows = logs => logs.map(line => JSON.parse(line.slice(line.indexOf('{'))));
function runtime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('primary and secondary HTTP generation receive identical prompts/persona and the same last 12 history entries', async () => {
  const env = envConfig(), bodies = [], logs = [];
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return completion(); };
  const model = createPublicModel({ endpoint: 'https://primary.invalid/chat', name: 'synthetic-primary',
    apiKey: 'synthetic-primary-placeholder' }, { fetchImpl });
  const run = createOrdinaryChat({ env, model, fastlaneOptions: { fetchImpl }, log: line => logs.push(line) });
  const history = Array.from({ length: 15 }, (_, i) => ({ user: `合成输入${i}`, assistant: `合成回复${i}` }));
  assert.equal(await run('你好', { state: known, history }), '合成草稿');
  env.WECHAT_FASTLANE_PROVIDER = 'PRIMARY';
  assert.equal(await run('你好', { state: known, history }), '合成草稿');
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.equal(bodies[0].tools, undefined); assert.equal(bodies[0].tool_choice, undefined);
  assert.equal(bodies[0].response_format.type, 'json_object');
  assert.equal(bodies[1].response_format.json_schema.strict, true);
  assert.ok(!bodies[0].messages[1].content.includes('合成输入2\n'));
  assert.ok(bodies[0].messages[1].content.includes('合成输入3'));
  assert.deepEqual(rows(logs).filter(r => r.stage).map(r => r.provider), ['secondary', 'primary']);
  assert.ok(logs.every(line => !/合成输入|合成回复|合成草稿|synthetic-|https:/u.test(line)));
});

test('missing secondary configuration selects primary; provider switch and total lane switch are read per request', async () => {
  const env = envConfig(); let primaryDrafts = 0, secondaryCalls = 0, baselineCalls = 0;
  const run = createOrdinaryChat({ env, model: async (_text, options) => {
    if (options.schema) { primaryDrafts++; return draft; } baselineCalls++; return '基线回答';
  }, fastlaneOptions: { fetchImpl: async () => { secondaryCalls++; return completion(); } } });
  for (const name of ['FASTLANE_MODEL_API_KEY', 'FASTLANE_MODEL_NAME', 'FASTLANE_MODEL_ENDPOINT']) {
    const value = env[name]; delete env[name];
    assert.equal(await run('你好', { state: known }), '合成草稿'); env[name] = value;
  }
  await run('你好', { state: known });
  env.WECHAT_FASTLANE_PROVIDER = 'primary'; await run('你好', { state: known });
  env.WECHAT_FASTLANE_PROVIDER = 'secondary'; await run('你好', { state: known });
  for (const mode of ['off', 'false', '0', 'OFF']) {
    env.WECHAT_CHAT_LANES = mode; assert.equal(await run('你好', { state: known }), '基线回答');
  }
  assert.deepEqual([primaryDrafts, secondaryCalls, baselineCalls], [4, 2, 4]);
});

test('L1 secondary draft and two primary checks start together; checks never read the draft', async () => {
  const pending = [], calls = [], logs = [];
  let resolveDraft, settled = false;
  const run = createOrdinaryChat({ env: envConfig(), log: line => logs.push(line),
    model: (text, options) => { calls.push({ text, options }); return new Promise(resolve => pending.push(resolve)); },
    fastlaneOptions: { fetchImpl: () => new Promise(resolve => { resolveDraft = resolve; }) } });
  const result = run('什么是光合作用？', { state: known }).then(value => { settled = true; return value; });
  assert.equal(pending.length, 2); assert.equal(typeof resolveDraft, 'function');
  assert.deepEqual(calls.map(c => c.options.stage), ['理解完整请求', '独立普通回答核对']);
  assert.ok(calls.every(c => !c.text.includes('合成草稿') && !c.text.includes('人设') && !c.options.tools));
  resolveDraft(completion()); pending[0]('{"ordinary":true}');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  pending[1]('{"ordinary":true}'); assert.equal(await result, '合成草稿');
  assert.equal(rows(logs).at(-1).modelAttempts, 3);
  assert.equal(rows(logs).filter(r => r.stage && r.provider === 'primary').length, 2);
});

for (const laneText of ['你好', '什么是光合作用？']) test(`secondary failures discard the whole draft into L2, without a primary replacement draft: ${laneText}`, async () => {
  for (const [response, reason] of [
    [() => completion('bad JSON'), 'invalid_output'],
    [() => completion('{"reply":"合成草稿","needs_tool":false,"extra":1}'), 'invalid_output'],
    [() => completion('{"reply":"","needs_tool":true}'), 'needs_tool'],
    [() => completion(draft, { tool_calls: [{}] }), 'unexpected_tool'],
    [() => completion(draft, { function_call: { name: 'fake' } }), 'unexpected_tool'],
    [() => completion(draft, {}, 'tool_calls'), 'unexpected_tool'],
    [() => completion(draft, {}, 'length'), 'invalid_output'],
    [() => completion('{"reply":"安排好了","needs_tool":false}'), 'execution_claim'],
    [() => completion('{"reply":"已保存待办","needs_tool":false}'), 'execution_claim'],
    [() => completion('{"reply":"```json","needs_tool":false}'), 'format'],
    [() => { throw Object.assign(Error('private-provider-body'), { codexErrorInfo: 'usageLimitExceeded' }); }, 'provider_error'],
    [() => ({ ok: false, status: 401 }), 'provider_error'],
  ]) {
    let count = 0; const calls = [], logs = [];
    const run = createOrdinaryChat({ env: envConfig(), log: line => logs.push(line),
      model: async (_text, options) => { calls.push(options); return options.schema ? '{"ordinary":true}' : 'L2回答'; },
      fastlaneOptions: { fetchImpl: async () => { count++; return response(); } } });
    assert.equal(await run(laneText, { state: known }), 'L2回答'); assert.equal(count, 1);
    assert.ok(calls.every(c => !c.schema?.properties?.needs_tool));
    assert.equal(calls.at(-1).schema, undefined);
    const timing = rows(logs).at(-1);
    assert.equal(timing.fastlane_fallback, `secondary_${reason}`); assert.equal(timing.effective_lane, 'L2');
    assert.equal(timing.modelAttempts, laneText === '你好' ? 2 : 4);
    assert.ok(logs.every(line => !line.includes('private-provider-body')));
  }
});

test('secondary has one hard 20s attempt, clipped to the ingress deadline, even if fetch ignores abort', async () => {
  for (const remainingMs of [150000, 7000]) {
    let timeout, abortSignal, cleared, attempts = 0, calls = 0; const timings = [];
    const run = createFastlaneProvider({ env: envConfig(), now: () => 1000,
      setTimer: (callback, ms) => { timeout = { callback, ms }; return 17; }, clearTimer: id => { cleared = id; },
      fetchImpl: async (_url, options) => { calls++; abortSignal = options.signal; return new Promise(() => {}); } });
    const promise = run('你好', { deadlineAt: 1000 + remainingMs, isCurrent: () => true,
      onAttempt: () => { attempts++; }, onTiming: row => timings.push(row) });
    assert.equal(timeout.ms, Math.min(20000, remainingMs)); timeout.callback();
    assert.deepEqual(await promise, { ok: false, failureReason: 'timeout' });
    assert.equal(abortSignal.aborted, true); assert.equal(cleared, 17);
    assert.equal(attempts, 1); assert.equal(calls, 1);
    assert.equal(timings[0].timeoutReason, 'fastlane_budget'); assert.equal(timings[0].maxAttempts, 1);
  }
});

test('secondary timeout returns L0/L1 to L2 with original deadline and no replacement draft', async () => {
  for (const text of ['你好', '什么是光合作用？']) {
    let clock = 1000, timeout, signal, fetches = 0;
    const calls = [], logs = [];
    const run = createOrdinaryChat({ env: envConfig(), now: () => clock, log: line => logs.push(line),
      model: async (_text, options) => { calls.push(options); return options.schema ? '{"ordinary":true}' : '超时后L2回答'; },
      fastlaneOptions: { setTimer: (callback, ms) => { timeout = { callback, ms }; return 1; }, clearTimer: () => {},
        fetchImpl: async (_url, options) => { fetches++; signal = options.signal; return new Promise(() => {}); } } });
    const promise = run(text, { state: known, receivedAt: 1000 });
    clock += timeout.ms; timeout.callback();
    assert.equal(await promise, '超时后L2回答'); assert.equal(fetches, 1); assert.equal(signal.aborted, true);
    assert.ok(calls.every(c => c.deadlineAt === 151000 && !c.schema?.properties?.needs_tool));
    assert.equal(calls.at(-1).timeoutMs, 60000);
    const timing = rows(logs).at(-1);
    assert.equal(timing.fastlane_fallback, 'secondary_timeout'); assert.equal(timing.effective_lane, 'L2');
    assert.equal(timing.modelAttempts, text === '你好' ? 2 : 4);
  }
});

test('expired/cancelled secondary never calls fetch; late result is rejected; successful calls clear timer', async () => {
  let fetches = 0, timers = 0, cleared = 0, clock = 1000, current = true;
  const run = createFastlaneProvider({ env: envConfig(), now: () => clock,
    setTimer: () => ++timers, clearTimer: () => cleared++, fetchImpl: async () => { fetches++; current = false; return completion(); } });
  const options = { deadlineAt: 1000, isCurrent: () => current, onAttempt: () => {}, onTiming: () => {} };
  assert.equal((await run('你好', options)).failureReason, 'stale_or_budget');
  options.deadlineAt = 10000; current = false;
  assert.equal((await run('你好', options)).failureReason, 'stale_or_budget'); assert.equal(fetches, 0);
  current = true; assert.equal((await run('你好', options)).failureReason, 'stale_or_budget');
  assert.equal(fetches, 1); assert.equal(cleared, 1);
});

test('failed primary eligibility rejects a valid secondary draft; primary auth/quota stay terminal', async () => {
  for (const kind of ['reject', 'AUTH', 'QUOTA_EXHAUSTED']) {
    const calls = [], logs = [];
    const run = createOrdinaryChat({ env: envConfig(), log: line => logs.push(line), fastlaneOptions: { fetchImpl: async () => completion() },
      model: async (_text, options) => {
        calls.push(options);
        if (options.schema && kind !== 'reject') throw Object.assign(Error('synthetic-terminal'), { errorKind: kind });
        return options.schema ? '{"ordinary":false}' : 'L2回答';
      } });
    if (kind === 'reject') {
      assert.equal(await run('什么是光合作用？', { state: known }), 'L2回答');
      assert.equal(rows(logs).at(-1).fastlane_fallback, 'check_fail'); assert.equal(calls.length, 3);
    } else {
      await assert.rejects(run('什么是光合作用？', { state: known }), /synthetic-terminal/);
      assert.equal(calls.length, 2);
    }
  }
});

test('all existing L2 fixtures and lanes-off avoid secondary even when fully configured', async () => {
  let secondaryCalls = 0;
  const env = envConfig();
  const run = createOrdinaryChat({ env, model: async () => '基线回答',
    fastlaneOptions: { fetchImpl: async () => { secondaryCalls++; return completion(); } } });
  for (const c of cases.filter(c => c.lane === 'L2')) {
    await run(c.fragments?.join('\n') || c.text, { state: { ...known, known: !c.unknownState,
      pending: Boolean(c.pending), history: c.history || [], recovery: c.recovery },
    fragments: c.fragments?.length || 1, imagePaths: c.imagePaths, hasAttachment: c.hasAttachment });
  }
  env.WECHAT_CHAT_LANES = 'off'; await run('你好', { state: known }); assert.equal(secondaryCalls, 0);
});

test('actual hosts wire secondary, preserve same-role history and remember only final L2 output', async t => {
  for (const factory of [createPublicAssistant, createPairConsole]) {
    const bodies = []; let count = 0;
    const host = factory({ runtime: runtime(t), env: envConfig(), model: async () => '最终L2回答',
      fastlaneOptions: { fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body)); return completion(++count === 1 ? 'bad JSON' : draft);
      } } });
    assert.equal(await host.reply('你好'), '最终L2回答');
    assert.equal(await host.reply('你好'), '合成草稿');
    assert.ok(bodies[1].messages[1].content.includes('最终L2回答'));
    if (factory === createPairConsole) { await host.reply('切换 小周'); }
    await host.reply('你好', 'friend');
    assert.equal(bodies.at(-1).messages.length, 2); host.close();
  }
});

test('quota breaker bypass/probes are unchanged; secondary failures do not exhaust primary quota state', async t => {
  for (const scenario of ['exhausted', 'secondary_error', 'primary_quota']) {
    let secondaryCalls = 0, fallbackCalls = 0, primaryCalls = 0;
    const host = createPublicAssistant({ runtime: runtime(t), env: envConfig(),
      model: async (_text, options) => {
        primaryCalls++;
        if (scenario === 'primary_quota') throw Object.assign(Error('synthetic-quota'), { codexErrorInfo: 'usageLimitExceeded' });
        return options?.probe ? '{"ok":false}' : '基线回答';
      }, fastlaneOptions: { fetchImpl: async () => { secondaryCalls++; throw Error('synthetic-secondary'); } },
      fallbackConfig: { apiKey: 'synthetic-placeholder' }, fallbackOptions: { probeIntervalMs: 0,
        complete: async () => { fallbackCalls++; return { content: '{"kind":"pending"}' }; } } });
    if (scenario === 'exhausted') host.fallback.state.exhaust({ codexErrorInfo: 'usageLimitExceeded' });
    const result = await host.reply('你好');
    if (scenario === 'secondary_error') {
      assert.equal(result, '基线回答'); assert.equal(fallbackCalls, 0); assert.equal(host.fallback.isExhausted(), false);
      assert.equal(primaryCalls, 1);
    } else { assert.match(result, /尚未执行/); assert.equal(fallbackCalls, 1); assert.equal(host.fallback.isExhausted(), true); }
    assert.equal(secondaryCalls, scenario === 'exhausted' ? 0 : 1); host.close();
  }
});
