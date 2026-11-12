'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrdinaryChat } = require('../src/ordinary-chat-lanes');
const { classifyChatLane, parseFastAnswer } = require('../src/chat-lane-policy');
const { captureChatLaneState } = require('../src/chat-lane-state');
const { createPublicAssistant } = require('../src/public-assistant');
const { createPairConsole } = require('../src/public-pair-console');
const { createPublicModel } = require('../src/public-model');
const { createPublicAssistant: baseline } = require('./public-assistant-baseline.cjs');
const { cases } = require('./chat-lanes-cases.json');
const known = { known: true, history: [] };
const answer = JSON.stringify({ reply: '合成文字回答', needs_tool: false });
const admit = JSON.stringify({ ordinary: true });
function runtime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-lanes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
for (const c of cases) test(`synthetic lane: ${c.id}`, async () => {
  const calls = [], logs = [];
  const text = c.fragments?.join('\n') || c.text;
  const state = { ...known, known: !c.unknownState, pending: Boolean(c.pending), history: c.history || [], recovery: c.recovery };
  const decision = classifyChatLane({ text, state, fragments: c.fragments?.length || 1, imagePaths: c.imagePaths, hasAttachment: c.hasAttachment });
  assert.equal(decision.lane, c.lane);
  const model = async (input, options) => { calls.push(options); return options.schema?.properties.needs_tool ? answer : options.schema ? admit : '基线文字'; };
  await createOrdinaryChat({ model, log: line => logs.push(line) })(text, { state,
    fragments: c.fragments?.length || 1, hasAttachment: Boolean(c.hasAttachment || c.imagePaths?.length) });
  assert.equal(calls.length, c.lane === 'L1' ? 3 : 1);
  assert.ok(calls.every(call => !call.tools && !call.execute));
  assert.ok(c.allowedTools.every(tool => ['todo_add', 'expense_add', 'weather_query', 'place_add'].includes(tool)));
  assert.equal(typeof c.mustNotExecute, 'boolean');
  assert.ok(logs.every(line => !line.includes(text)));
});
test('evaluation has 40–60 cases and pending traps; structured answers reject extra fields', () => {
  assert.ok(cases.length >= 40 && cases.length <= 60);
  assert.ok(cases.filter(c => c.category === 'pending_trap').length >= 5);
  for (const raw of ['null', '[]', '{"reply":"a","needs_tool":false,"actions":[]}', '{"reply":"a"}']) assert.throws(() => parseFastAnswer(raw));
});
test('L1 starts three turns concurrently and waits for both independent gates', async () => {
  const pending = [], calls = [];
  let settled = false;
  const run = createOrdinaryChat({ model: (text, options) => {
    calls.push({ text, options }); return new Promise(resolve => pending.push(resolve));
  } });
  const promise = run('什么是光合作用？', { state: known }).then(value => { settled = true; return value; });
  assert.equal(pending.length, 3);
  pending[0](answer); pending[1](admit); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(calls.slice(1).every(call => !call.text.includes('合成文字回答') && !call.text.includes('人设')));
  pending[2](admit); assert.equal(await promise, '合成文字回答');
  assert.deepEqual(calls.map(c => c.options.timeoutMs), [60000, 40000, 40000]);
});
test('failed eligibility, needs_tool, schema errors and unsupported completion claims discard draft into L2', async () => {
  for (const [draft, approved, reason] of [
    [answer, false, 'check_fail'],
    [JSON.stringify({ reply: '', needs_tool: true }), true, 'needs_tool'],
    ['not JSON', true, 'invalid_output'],
    [JSON.stringify({ reply: '已保存待办', needs_tool: false }), true, 'execution_claim'],
    [JSON.stringify({ reply: '', needs_tool: false }), true, 'empty'],
    [JSON.stringify({ reply: '```json', needs_tool: false }), true, 'format'],
  ]) {
    const calls = [], logs = [];
    const run = createOrdinaryChat({ log: line => logs.push(line), model: async (_text, options) => {
      calls.push(options);
      return options.schema?.properties.needs_tool ? draft : options.schema ? JSON.stringify({ ordinary: approved }) : '最终基线回答';
    } });
    assert.equal(await run('什么是光合作用？', { state: known }), '最终基线回答');
    assert.equal(calls.length, 4); assert.equal(calls.at(-1).schema, undefined);
    const timing = JSON.parse(logs.at(-1).slice('chat timing '.length));
    assert.equal(timing.effective_lane, 'L2'); assert.equal(timing.fastlane_fallback, reason === 'check_fail' ? reason : `primary_${reason}`);
    assert.equal(timing.l1_gate_reject, approved ? 'local_gate_fail' : 'check_fail');
  }
});
test('fallback and retries share the original remaining deadline, with no speculation retry for malformed output', async () => {
  let clock = 140000;
  const calls = [];
  const run = createOrdinaryChat({ now: () => clock, model: async (_text, options) => {
    calls.push(options); clock += 6000;
    if (options.schema) return 'bad JSON';
    throw Error('timeout');
  } });
  await assert.rejects(run('你好', { state: known, receivedAt: 0 }), /deadline/);
  assert.deepEqual(calls.map(c => c.timeoutMs), [10000, 4000]);
  assert.equal(calls[0].maxAttempts, 2);
  assert.ok(calls.every(c => c.deadlineAt === 150000));
});
test('unknown or failed probes close admission without exposing state bodies', () => {
  for (const probes of [[], [['bad', () => { throw Error('secret-state'); }]], [['bad', () => undefined]]]) {
    const state = captureChatLaneState({ probes, item: { hasAttachment: false } });
    assert.deepEqual(state, { known: false });
    assert.equal(classifyChatLane({ text: '你好', state }).lane, 'L2');
  }
  const state = captureChatLaneState({ probes: [['city', () => true]], item: { hasAttachment: false } });
  assert.equal(state.pending, true); assert.deepEqual(state.pendingReasons, ['city']);
  assert.equal(captureChatLaneState({ probes: [['city', () => false]], item: {} }).recovery, true);
});
test('actual HTTP adapter disables tools, passes strict schema and refuses unexpected tools without replay', async () => {
  const bodies = [];
  const config = { endpoint: 'https://synthetic.invalid/chat', name: 'synthetic-model', apiKey: 'synthetic-placeholder', timeoutMs: 1000 };
  const model = createPublicModel(config, { fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  } });
  assert.equal(await createOrdinaryChat({ model })('你好', { state: known }), '合成文字回答');
  assert.equal(bodies[0].tool_choice, 'none'); assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].response_format.json_schema.strict, true);
  let count = 0;
  const bad = createPublicModel(config, { fetchImpl: async () => { count++; return { ok: true, json: async () => ({ choices: [{ message: { content: '伪造结果', tool_calls: [{}] } }] }) }; } });
  await assert.rejects(createOrdinaryChat({ model: bad })('未匹配普通请求', { state: known }), /Unexpected/);
  assert.equal(count, 1);
});
test('enabled host probes cover only active weather/pair state and preserve role isolation', async t => {
  const logs = [], options = { runtime: runtime(t), log: line => logs.push(line),
    model: async (_text, response) => response.schema?.properties.needs_tool ? answer : response.schema ? admit : '基线文字' };
  const host = createPairConsole(options);
  await host.reply('每日一问'); await host.reply('你好');
  assert.equal(JSON.parse(logs.at(-1).slice(12)).lane, 'L2');
  const singleLogs = [];
  const single = createPublicAssistant({ ...options, runtime: runtime(t), log: line => singleLogs.push(line) });
  await single.reply('你好'); assert.equal(JSON.parse(singleLogs.at(-1).slice(12)).lane, 'L0');
  // Weather pending survives refresh-consumption and restart, forcing L2 for a
  // greeting that bypasses the pending city using the host refresh marker.
  await single.reply('天气');
  const restarted = createPublicAssistant({ ...options, runtime: options.runtime, log: line => singleLogs.push(line) });
  await restarted.reply('天气'); await restarted.reply('你好', 'owner', { refreshReply: true });
  assert.equal(JSON.parse(singleLogs.at(-1).slice(12)).lane, 'L2');
});
test('switch off skips even throwing probes; public baseline differential preserves routes and primary/fallback results', async t => {
  for (const mode of ['off', 'false', '0', 'OFF']) {
    const events = [[], []], hosts = [baseline, createPublicAssistant].map((factory, index) => factory({ runtime: runtime(t),
      env: { WECHAT_CHAT_LANES: mode }, laneProbes: () => { throw Error('must not probe'); },
      model: async (text, options) => { events[index].push([text, options?.history || []]); return '基线文字'; } }));
    for (const text of ['你好', '什么是光合作用？', '记一下 合成纸船', '我的待办', '存临时信息 合成内容', '临时信息', '完全未知的请求']) {
      const normalize = value => value.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gu, '<generated-id>');
      assert.equal(normalize(await hosts[0].reply(text)), normalize(await hosts[1].reply(text)));
    }
    assert.deepEqual(events[0], events[1]);
  }
});
test('enabled L2 and lanes-off use the same baseline failure and quota handoff, without retrying quota/auth', async t => {
  for (const enabled of [true, false]) for (const kind of ['AUTH', 'QUOTA_EXHAUSTED', 'TRANSIENT']) {
    const calls = [], completions = [];
    const host = createPublicAssistant({ runtime: runtime(t), env: { WECHAT_CHAT_LANES: enabled ? 'on' : 'off' },
      model: async () => { calls.push(1); throw Object.assign(Error('synthetic failure'), { errorKind: kind,
        codexErrorInfo: kind === 'QUOTA_EXHAUSTED' ? 'usageLimitExceeded' : kind === 'AUTH' ? 'unauthorized' : 'serverOverloaded' }); },
      fallbackConfig: { apiKey: 'synthetic-placeholder' }, fallbackOptions: { probeIntervalMs: 0,
        complete: async () => { completions.push(1); return { content: JSON.stringify({ kind: 'pending' }) }; } } });
    if (kind === 'QUOTA_EXHAUSTED') assert.match(await host.reply('未匹配请求'), /尚未执行/);
    else await assert.rejects(host.reply('未匹配请求'));
    assert.equal(calls.length, kind === 'TRANSIENT' ? 2 : 1);
    assert.equal(completions.length, kind === 'QUOTA_EXHAUSTED' ? 1 : 0); host.close();
  }
});
test('enabled L2 matches the frozen public baseline for text, actual feature writes and both quota entry paths', async t => {
  for (const scenario of ['text', 'todo', 'quota_on_failure', 'already_exhausted']) {
    const events = [[], []];
    const hosts = [baseline, createPublicAssistant].map((factory, index) => {
      const model = async text => {
        events[index].push(['primary', text]);
        if (scenario === 'quota_on_failure') throw Object.assign(Error('synthetic quota'), { codexErrorInfo: 'usageLimitExceeded' });
        return '最终文字';
      };
      return factory({ runtime: runtime(t), model, fallbackConfig: { apiKey: 'synthetic-placeholder' },
        fallbackOptions: { probeIntervalMs: 0, complete: async () => {
          events[index].push(['fallback']); return { content: '{"kind":"pending"}' };
        } } });
    });
    if (scenario === 'already_exhausted') hosts.forEach(host => host.fallback.state.exhaust({ codexErrorInfo: 'usageLimitExceeded' }));
    const text = scenario === 'todo' ? '记一下 合成纸船' : '没有快道匹配的请求';
    const normalize = value => value.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gu, '<generated-id>');
    assert.equal(normalize(await hosts[0].reply(text)), normalize(await hosts[1].reply(text)));
    if (scenario === 'todo') assert.equal(await hosts[0].reply('我的待办'), await hosts[1].reply('我的待办'));
    assert.deepEqual(events[0], events[1]); hosts.forEach(host => host.close());
  }
});

for (const text of ['你好', '什么是光合作用？']) test(`watchdog-only draft retry keeps fast admission and bounded timing: ${text}`, async () => {
  const calls = [], logs = [];
  let clock = 1000, drafts = 0;
  const run = createOrdinaryChat({ now: () => clock, log: line => logs.push(line), model: async (_text, options) => {
    calls.push(options);
    if (!options.schema?.properties.needs_tool) return admit;
    if (++drafts === 1) {
      clock += 20000;
      throw Object.assign(Error('synthetic timeout with private detail'), { errorKind: 'TRANSIENT', timeoutReason: 'first_output_watchdog' });
    }
    options.onTiming({ firstOutputMs: 120, prompt: 'must not be logged', timeoutReason: 'untrusted detail' });
    return answer;
  } });
  let final;
  assert.equal(await run(text, { state: known, receivedAt: 1000, onTiming: record => { final = record; } }), '合成文字回答');
  const draftCalls = calls.filter(c => c.schema?.properties.needs_tool);
  assert.deepEqual(draftCalls.map(c => [c.attempt, c.maxAttempts, c.firstOutputTimeoutMs]), [[1, 2, 20000], [2, 2, 20000]]);
  assert.equal(draftCalls[1].retryReason, 'TRANSIENT');
  assert.ok(calls.every(c => c.deadlineAt === 151000));
  assert.equal(final.fastlane_fallback, false); assert.equal(final.modelAttempts, text === '你好' ? 2 : 4);
  const rows = logs.filter(line => line.startsWith('model timing ')).map(line => JSON.parse(line.slice(13)));
  const timeout = rows.find(r => r.firstOutputWatchdog);
  assert.equal(timeout.timeoutReason, 'first_output_watchdog'); assert.equal(timeout.firstOutputMs, null);
  const success = rows.find(r => r.firstOutputMs === 120);
  assert.equal(success.timeoutReason, null); assert.equal(success.firstOutputWatchdog, false);
  assert.ok(logs.every(line => !line.includes('private detail') && !line.includes('must not be logged') && !line.includes('untrusted detail')));
});

test('ordinary stage timeout, network failure and parse failure do not retry fast drafts', async () => {
  for (const failure of [Object.assign(Error('synthetic timeout'), { timeoutReason: 'stage_budget' }), Error('synthetic network failure'), null]) {
    const calls = [];
    const run = createOrdinaryChat({ model: async (_text, options) => {
      calls.push(options);
      if (options.schema?.properties.needs_tool) { if (failure) throw failure; return 'not JSON'; }
      return '最终基线回答';
    } });
    assert.equal(await run('你好', { state: known }), '最终基线回答');
    assert.deepEqual(calls.map(c => Boolean(c.schema)), [true, false]);
  }
});

test('a second watchdog timeout falls back without a third draft attempt', async () => {
  const calls = [];
  const run = createOrdinaryChat({ model: async (_text, options) => {
    calls.push(options);
    if (options.schema) throw Object.assign(Error('synthetic timeout'), { timeoutReason: 'first_output_watchdog' });
    return '基线文字';
  } });
  assert.equal(await run('你好', { state: known }), '基线文字');
  assert.deepEqual(calls.map(c => [Boolean(c.schema), c.attempt]), [[true, 1], [true, 2], [false, 1]]);
});

for (const stop of ['cancel', 'deadline']) test(`watchdog draft cannot retry after ${stop}`, async () => {
  let current = true, clock = 1000, calls = 0;
  const run = createOrdinaryChat({ now: () => clock, model: async () => {
    calls++;
    if (stop === 'cancel') current = false;
    else clock = 151000;
    throw Object.assign(Error('synthetic timeout'), { timeoutReason: 'first_output_watchdog' });
  } });
  await assert.rejects(run('你好', { state: known, receivedAt: 1000, isCurrent: () => current }));
  assert.equal(calls, 1);
});
