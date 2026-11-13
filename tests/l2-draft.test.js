'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startL2Draft } = require('../src/l2-draft');
const { createFastlaneProvider } = require('../src/fastlane-provider');
const { createOrdinaryChat, laneTiming } = require('../src/ordinary-chat-lanes');
const { createPublicAssistant } = require('../src/public-assistant');
const { createPairConsole } = require('../src/public-pair-console');
const { createPublicWechat } = require('../src/public-wechat');
const { buildPublicMessages } = require('../src/public-model');
const { FAST_ANSWER_SCHEMA } = require('../src/chat-lane-policy');
const config = () => ({ FASTLANE_MODEL_ENDPOINT: 'https://secondary.invalid/chat',
  FASTLANE_MODEL_NAME: 'synthetic-model', FASTLANE_MODEL_API_KEY: 'synthetic-placeholder' });
const good = '{"reply":"独立合成草稿","needs_tool":false}';
const admission = '{"ordinary":true}';
const known = { known: true, history: [] };
const complete = (content = good, extra = {}, finish_reason = 'stop') => ({ ok: true,
  json: async () => ({ choices: [{ finish_reason, message: { content, ...extra } }] }) });
const tick = () => new Promise(resolve => setImmediate(resolve));
const rows = logs => logs.map(line => JSON.parse(line.slice(line.indexOf('{'))));
function runtime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-l2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function setup({ fetchImpl = async () => complete(), env = config(), now = () => 1000, ...options } = {}) {
  const timing = laneTiming(), logs = [];
  const provider = createFastlaneProvider({ env, now, fetchImpl, ...options });
  const draft = startL2Draft({ provider, text: '合成的独立文字请求', history: [], deadlineAt: 151000,
    isCurrent: () => true, onAttempt: () => {}, onTiming: row => logs.push(row), timing, now, env,
    ...options });
  return { draft, timing, logs };
}
function approve(draft) {
  for (const stage of ['理解完整请求', '独立普通回答核对']) draft.observe(stage, { ok: true, value: { ordinary: true } });
}
const outcome = () => ({ ordinary: true, actions: [], results: [], budget: { deadlineAt: 151000 } });
const take = (draft, extra = {}) => draft.take({ outcome: outcome(), isDispatched: () => false, ...extra });

test('all five conditions adopt exactly once; buffered model timing reports final decision and real duration', async () => {
  let clock = 1000;
  const { draft, timing, logs } = setup({ now: () => clock, fetchImpl: async () => { clock += 37; return complete(); } });
  await tick(); assert.equal(logs.length, 0); assert.equal(timing.draftOutcome, 'pending');
  approve(draft);
  assert.deepEqual(await take(draft), { reply: '独立合成草稿' });
  assert.equal(await take(draft), null);
  assert.deepEqual([timing.draftProvider, timing.draftMs, timing.draftOutcome], ['secondary', 37, 'sent']);
  assert.equal(logs.length, 1); assert.equal(logs[0].totalMs, 37); assert.equal(logs[0].draftOutcome, 'sent');
  assert.deepEqual([logs[0].attempt, logs[0].maxAttempts, logs[0].timeoutMs], [1, 1, 20000]);
});

for (const [name, stage, response, expected] of [
  ['no understanding', null, null, 'discarded_check'],
  ['understanding rejects', '理解完整请求', { ok: true, value: { ordinary: false } }, 'discarded_needs_pipeline'],
  ['check rejects', '独立普通回答核对', { ok: true, value: { ordinary: false } }, 'discarded_check'],
  ['check fails', '独立普通回答核对', { ok: false }, 'discarded_check'],
  ['check has extra fields', '独立普通回答核对', { ok: false }, 'discarded_check'],
  ['planning exit', '根据真实结果规划下一步', { ok: true }, 'discarded_needs_pipeline'],
]) test(`condition 1: ${name} cannot adopt and aborts an unresponsive provider`, async () => {
  let signal;
  const { draft, timing, logs } = setup({ fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  if (stage) draft.observe(stage, response);
  assert.equal(await take(draft), null); await tick();
  assert.equal(timing.draftOutcome, expected); assert.equal(signal.aborted, true);
  assert.equal(logs.length, 1); assert.equal(logs[0].draftOutcome, expected);
});

for (const [name, response, expected] of [
  ['empty', () => complete('{"reply":"","needs_tool":false}'), 'discarded_gate'],
  ['format', () => complete('{"reply":"```json","needs_tool":false}'), 'discarded_gate'],
  ['local execution claim', () => complete('{"reply":"已保存待办","needs_tool":false}'), 'discarded_gate'],
  ['exit completion claim', () => complete('{"reply":"安排好了","needs_tool":false}'), 'discarded_gate'],
  ['needs_tool', () => complete('{"reply":"","needs_tool":true}'), 'discarded_gate'],
  ['extra fields', () => complete('{"reply":"伪造","needs_tool":false,"actions":[]}'), 'discarded_error'],
  ['missing needs_tool', () => complete('{"reply":"伪造"}'), 'discarded_error'],
  ['bad JSON', () => complete('not JSON'), 'discarded_error'],
  ['tool calls', () => complete(good, { tool_calls: [{}] }), 'discarded_error'],
  ['function calls', () => complete(good, { function_call: {} }), 'discarded_error'],
  ['tool finish', () => complete(good, {}, 'tool_calls'), 'discarded_error'],
  ['truncated', () => complete(good, {}, 'length'), 'discarded_error'],
  ['provider error', () => { throw Error('sensitive upstream body'); }, 'discarded_error'],
  ['provider auth', () => ({ ok: false, status: 401 }), 'discarded_error'],
  ['provider quota', () => ({ ok: false, status: 429 }), 'discarded_error'],
]) test(`conditions 2/3/4: ${name} discards and returns the original primary answer`, async () => {
  const logs = [], calls = []; let fetches = 0;
  const run = createOrdinaryChat({ env: config(), log: line => logs.push(line),
    fastlaneOptions: { fetchImpl: async () => { fetches++; return response(); } },
    model: async (text, options) => { calls.push({ text, options }); return options.schema ? admission : '原L2回答'; } });
  assert.equal(await run('讲讲雨滴的形状', { state: known }), '原L2回答');
  assert.equal(fetches, 1); assert.equal(calls.length, 3); assert.equal(calls.at(-1).options.schema, undefined);
  assert.equal(rows(logs).at(-1).draftOutcome, expected);
  assert.ok(logs.every(line => !/独立合成草稿|原L2回答|sensitive|synthetic-|https:/u.test(line)));
});

for (const [name, overrides] of [
  ['non ordinary', { ordinary: false }], ['actions', { actions: [{}] }], ['results', { results: [{}] }],
]) test(`condition 5: ${name} exit cannot adopt`, async () => {
  const { draft, timing } = setup(); approve(draft);
  assert.equal(await take(draft, { outcome: { ...outcome(), ...overrides } }), null);
  assert.equal(timing.draftOutcome, 'discarded_needs_pipeline');
});

for (const when of ['before', 'during']) test(`condition 5: dispatch ${when} waiting blocks adoption`, async () => {
  let resolve, dispatched = when === 'before';
  const { draft, timing } = setup({ fetchImpl: () => new Promise(done => { resolve = done; }) });
  approve(draft); const result = take(draft, { isDispatched: () => dispatched });
  dispatched = true; resolve(complete());
  assert.equal(await result, null); assert.equal(timing.draftOutcome, 'discarded_needs_pipeline');
});

for (const stop of ['cancel', 'deadline', 'outcome deadline']) test(`condition 5: ${stop} during waiting rejects a late result`, async () => {
  let resolve, current = true, clock = 1000;
  const { draft, timing } = setup({ now: () => clock, isCurrent: () => current,
    fetchImpl: () => new Promise(done => { resolve = done; }) });
  approve(draft); const result = take(draft, { outcome: { ...outcome(), budget: { deadlineAt: stop === 'outcome deadline' ? 2000 : 151000 } } });
  if (stop === 'cancel') current = false;
  else clock = stop === 'deadline' ? 151000 : 2000;
  resolve(complete()); assert.equal(await result, null); assert.equal(timing.draftOutcome, 'discarded_timeout');
});

test('one attempt is min(20s, remaining), aborts despite ignored signal, and never waits for transport', async () => {
  for (const remaining of [150000, 7000]) {
    let timer, signal, clock = 1000, fetches = 0, cleared = 0;
    const { draft, timing } = setup({ now: () => clock, deadlineAt: 1000 + remaining,
      setTimer: (callback, ms) => { timer = { callback, ms }; return 19; }, clearTimer: () => cleared++,
      fetchImpl: async (_url, options) => { fetches++; signal = options.signal; return new Promise(() => {}); } });
    approve(draft); const promise = take(draft);
    assert.equal(timer.ms, Math.min(20000, remaining)); clock += timer.ms; timer.callback();
    assert.equal(await promise, null); assert.equal(timing.draftOutcome, 'discarded_timeout');
    assert.equal(signal.aborted, true); assert.equal(fetches, 1); assert.equal(cleared, 1);
  }
});

test('per-request switches and missing config disable L2 without adding primary review calls', async () => {
  const env = config(); let fetches = 0, calls = 0, final;
  const run = createOrdinaryChat({ env, model: async () => { calls++; return '原回答'; },
    fastlaneOptions: { fetchImpl: async () => { fetches++; return complete(); } } });
  for (const mode of ['off', 'false', '0', 'OFF']) {
    env.WECHAT_L2_DRAFT = mode;
    assert.equal(await run('独立文字请求', { state: known, onTiming: r => { final = r; } }), '原回答');
    assert.equal(final.draftOutcome, 'disabled');
  }
  delete env.WECHAT_L2_DRAFT;
  env.WECHAT_FASTLANE_PROVIDER = 'PRIMARY'; await run('独立文字请求', { state: known });
  delete env.WECHAT_FASTLANE_PROVIDER;
  for (const key of Object.keys(config())) {
    const value = env[key]; delete env[key]; await run('独立文字请求', { state: known }); env[key] = value;
  }
  env.WECHAT_CHAT_LANES = 'off'; await run('独立文字请求', { state: known });
  assert.equal(fetches, 0); assert.equal(calls, 9);
});

test('entry starts draft with understanding and independent check; neither sees draft, and adoption waits for both', async () => {
  const pending = [], calls = [], bodies = [], logs = [];
  let resolveDraft, settled = false;
  const history = Array.from({ length: 15 }, (_, i) => ({ user: `合成历史${i}`, assistant: `合成回复${i}` }));
  const run = createOrdinaryChat({ env: config(), log: line => logs.push(line),
    model: (text, options) => { calls.push({ text, options }); return new Promise(resolve => pending.push(resolve)); },
    fastlaneOptions: { fetchImpl: (_url, options) => { bodies.push(JSON.parse(options.body)); return new Promise(resolve => { resolveDraft = resolve; }); } } });
  const result = run('讲讲雨滴的形状', { state: known, history }).then(value => { settled = true; return value; });
  assert.equal(bodies.length, 1); assert.equal(pending.length, 2);
  assert.deepEqual(bodies[0].messages, buildPublicMessages('讲讲雨滴的形状', { history, schema: FAST_ANSWER_SCHEMA }));
  assert.ok(calls.every(c => !/独立合成草稿|规划|工具结果/u.test(c.text) && !c.options.tools));
  resolveDraft(complete()); pending[0](admission); await tick(); assert.equal(settled, false);
  pending[1](admission); assert.equal(await result, '独立合成草稿');
  assert.equal(rows(logs).at(-1).modelAttempts, 3); assert.equal(rows(logs).at(-1).draftOutcome, 'sent');
  assert.equal(rows(logs).filter(row => row.stage && row.provider === 'secondary')[0].draftOutcome, 'sent');
});

test('L1 and L2 actual provider messages are byte-identical for the same text/history; review prompts are unchanged', async () => {
  const bodies = [], calls = [], history = [{ user: '合成背景', assistant: '背景回复' }];
  const run = createOrdinaryChat({ env: config(), model: async (text, options) => { calls.push([text, options.history]); return admission; },
    fastlaneOptions: { fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return complete(); } } });
  // fragments=2 chooses initial L2 without changing text or prompt construction.
  await run('什么是惯性？', { state: known, history });
  await run('什么是惯性？', { state: known, history, fragments: 2 });
  assert.equal(JSON.stringify(bodies[0].messages), JSON.stringify(bodies[1].messages));
  assert.deepEqual(calls.slice(0, 2), calls.slice(2));
});

test('upstream rejection immediately aborts; other reviewer and original L2 continue, with no quota handoff from new checks', async () => {
  for (const stage of ['理解完整请求', '独立普通回答核对']) for (const raw of ['{"ordinary":false}', 'bad JSON', '{"ordinary":true,"extra":1}', 'quota']) {
    let signal; const logs = [];
    const run = createOrdinaryChat({ env: config(), log: line => logs.push(line),
      fastlaneOptions: { fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } },
      model: async (_text, options) => {
        if (options.stage === stage) {
          if (raw === 'quota') throw Object.assign(Error('synthetic-quota'), { errorKind: 'QUOTA_EXHAUSTED' });
          return raw;
        }
        return options.schema ? admission : '原回答';
      } });
    assert.equal(await run('讲讲雨滴的形状', { state: known }), '原回答'); assert.equal(signal.aborted, true);
    assert.equal(rows(logs).at(-1).draftOutcome, stage === '理解完整请求' ? 'discarded_needs_pipeline' : 'discarded_check');
  }
});

test('unknown/pending/recovery/media keep their baseline exit and never adopt even with permissive model', async () => {
  for (const options of [{ state: { known: false } }, { state: { known: true, pending: true } },
    { state: { known: true, recovery: true } }, { hasAttachment: true },
    { state: { known: true, history: [{ assistant: '请回复确认' }] } }]) {
    let final, calls = 0;
    const run = createOrdinaryChat({ env: config(), fastlaneOptions: { fetchImpl: async () => complete() },
      model: async () => { calls++; return '原回答'; } });
    assert.equal(await run('讲讲雨滴的形状', { state: known, ...options, onTiming: row => { final = row; } }), '原回答');
    assert.equal(calls, 1); assert.equal(final.draftOutcome, 'discarded_needs_pipeline');
  }
});

test('already blocked/dispatched/expired/cancelled do not start draft; fallback opening while waiting prevents adoption', async () => {
  for (const options of [{ isDraftBlocked: () => true }, { isDispatched: () => true },
    { deadlineAt: 1000 }, { isCurrent: () => false }]) {
    let fetches = 0;
    const run = createOrdinaryChat({ now: () => 1000, env: config(), model: async () => '原回答',
      fastlaneOptions: { fetchImpl: async () => { fetches++; return complete(); } } });
    try { await run('讲讲雨滴的形状', { state: known, receivedAt: 1000, ...options }); } catch (error) { assert.equal(error.errorKind, 'BUDGET'); }
    assert.equal(fetches, 0);
  }
  let blocked = false, resolve, final;
  const run = createOrdinaryChat({ env: config(), model: async (_text, options) => options.schema ? admission : '原回答',
    fastlaneOptions: { fetchImpl: () => new Promise(done => { resolve = done; }) } });
  const promise = run('讲讲雨滴的形状', { state: known, isDraftBlocked: () => blocked, onTiming: r => { final = r; } });
  await tick(); blocked = true; resolve(complete());
  assert.equal(await promise, '原回答'); assert.equal(final.draftOutcome, 'discarded_needs_pipeline');
});

test('both real hosts preserve same-side history and breaker state, with zero draft on exhausted fallback', async t => {
  for (const factory of [createPublicAssistant, createPairConsole]) for (const scenario of ['success', 'secondary_error', 'exhausted', 'primary_quota']) {
    let fetches = 0, fallbackCalls = 0; const bodies = [];
    const host = factory({ runtime: runtime(t), env: config(),
      model: async (_text, options) => {
        if (options?.probe) return '{"ok":false}';
        if (scenario === 'primary_quota' && !options.schema) throw Object.assign(Error('synthetic-quota'), { codexErrorInfo: 'usageLimitExceeded' });
        return options.schema ? (scenario === 'primary_quota' ? '{"ordinary":false}' : admission) : '原回答';
      }, fastlaneOptions: { fetchImpl: async (_url, options) => {
        fetches++; bodies.push(JSON.parse(options.body));
        if (scenario === 'secondary_error') throw Error('synthetic-secondary');
        return complete();
      } }, fallbackConfig: { apiKey: 'synthetic-placeholder' }, fallbackOptions: { probeIntervalMs: 0,
        complete: async () => { fallbackCalls++; return { content: '{"kind":"pending"}' }; } } });
    const before = JSON.stringify(host.fallback.state.snapshot());
    if (scenario === 'exhausted') host.fallback.state.exhaust({ codexErrorInfo: 'usageLimitExceeded' });
    const result = await host.reply('讲讲雨滴的形状');
    if (['exhausted', 'primary_quota'].includes(scenario)) {
      assert.match(result, /尚未执行/); assert.equal(fallbackCalls, 1);
      assert.equal(fetches, scenario === 'exhausted' ? 0 : 1);
    } else {
      assert.equal(result, scenario === 'success' ? '独立合成草稿' : '原回答');
      assert.equal(JSON.stringify(host.fallback.state.snapshot()), before); assert.equal(fallbackCalls, 0);
      await host.reply('讲讲雨滴的形状'); assert.ok(bodies[1].messages[1].content.includes(result));
      if (factory === createPairConsole) await host.reply('切换 小周');
      await host.reply('讲讲雨滴的形状', 'friend'); assert.equal(bodies.at(-1).messages.length, 2);
    }
    host.close();
  }
});

for (const confirmed of [true, false]) test(`real transport carries L2 draft timing; acceptance=${confirmed} retains existing delivery lifecycle`, async t => {
  const dir = runtime(t), logs = [], sends = [];
  const account = { accountId: 'synthetic-account', userId: 'synthetic-owner', token: 'synthetic-token', baseUrl: 'https://transport.invalid/' };
  const host = createPublicAssistant({ runtime: dir, env: config(),
    model: async () => admission, fastlaneOptions: { fetchImpl: async () => complete() } });
  const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const transport = createPublicWechat({ runtime: dir, account, assistant: host,
    setTimer: callback => setImmediate(callback), clearTimer: clearImmediate, log: line => logs.push(line),
    fetchImpl: async (url, request) => {
      if (url.endsWith('getupdates')) return response({ msgs: [{ message_id: 'synthetic-message',
        from_user_id: account.userId, to_user_id: account.accountId, context_token: 'synthetic-context',
        item_list: [{ type: 1, text_item: { text: '讲讲雨滴的形状' } }] }], get_updates_buf: 'synthetic-cursor' });
      sends.push(JSON.parse(request.body)); return response({ ret: confirmed ? 0 : 7 });
    } });
  if (confirmed) await transport.pollOnce();
  else await assert.rejects(transport.pollOnce(), /Send unconfirmed/);
  assert.equal(sends.length, 1); assert.equal(sends[0].msg.item_list[0].text_item.text, '独立合成草稿');
  const final = rows(logs).at(-1);
  assert.equal(final.draftProvider, 'secondary'); assert.equal(final.draftOutcome, 'sent');
  assert.equal(final.delivered, confirmed); assert.ok(Number.isFinite(final.draftMs));
  const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'state/transport/checkpoint.json')));
  assert.equal(checkpoint.pending?.status ?? null, confirmed ? null : 'sending');
  if (!confirmed) {
    const restarted = createPublicWechat({ runtime: dir, account, assistant: host,
      fetchImpl: async () => { throw Error('must not replay'); } });
    await assert.rejects(restarted.pollOnce(), /Uncertain prior operation/);
  }
});
