'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFastlaneProvider, fastlaneErrorFields } = require('../src/fastlane-provider');
const { startL2Draft } = require('../src/l2-draft');
const { createOrdinaryChat, laneTiming } = require('../src/ordinary-chat-lanes');
const { buildPublicMessages, createPublicModel } = require('../src/public-model');
const { FAST_ANSWER_SCHEMA } = require('../src/chat-lane-policy');

const env = () => ({ FASTLANE_MODEL_ENDPOINT: 'https://secondary.invalid/chat/completions',
  FASTLANE_MODEL_NAME: 'example-model', FASTLANE_MODEL_API_KEY: 'example-key-not-for-logging' });
const sensitive = 'example-request-response-exception-content';
const answer = { reply: 'Example answer', needs_tool: false };
const completion = (content = JSON.stringify(answer), finish_reason = 'stop', extra = {}) => ({ ok: true,
  json: async () => ({ choices: [{ finish_reason, message: { content, ...extra } }] }) });
const tick = () => new Promise(resolve => setImmediate(resolve));
const diagnosticKeys = ['draftProviderErrorCategory', 'draftProviderHttpStatus', 'draftCheckApproved',
  'draftCheckNeedsUser', 'draftCheckIssuesCount', 'draftCheckRejectReason'];
function safe(value) {
  const text = JSON.stringify(value);
  for (const marker of [sensitive, env().FASTLANE_MODEL_API_KEY, env().FASTLANE_MODEL_ENDPOINT, answer.reply]) {
    assert.ok(!text.includes(marker), `Unexpected body or configuration in diagnostics: ${marker}`);
  }
}
async function runProvider(fetchImpl, extra = {}) {
  const rows = [];
  const provider = createFastlaneProvider({ env: env(), now: () => 1000, fetchImpl, ...extra });
  const result = await provider(sensitive, { deadlineAt: 151000, isCurrent: () => true,
    onAttempt: () => {}, onTiming: row => rows.push(row) });
  return { result, rows };
}
function setupDraft(fetchImpl = async () => completion(), customProvider) {
  const timing = laneTiming(), rows = [];
  const provider = customProvider || createFastlaneProvider({ env: env(), now: () => 1000, fetchImpl });
  const draft = startL2Draft({ provider, text: sensitive, history: [], deadlineAt: 151000,
    isCurrent: () => true, onAttempt: () => {}, onTiming: row => rows.push(row), timing, now: () => 1000, env: env() });
  return { draft, timing, rows };
}
const take = draft => draft.take({ outcome: { ordinary: true, actions: [], results: [] }, isDispatched: () => false });
function admit(draft) {
  draft.observe('理解完整请求', { ok: true, value: { ordinary: true } });
  draft.observe('独立普通回答核对', { ok: true, value: { ordinary: true } });
}

test('error fields allow only fixed categories and integer HTTP status 100 through 599', () => {
  for (const category of ['http_status', 'network', 'timeout', 'cancelled', 'invalid_response', 'configuration', 'unknown']) {
    assert.deepEqual(fastlaneErrorFields({ providerErrorCategory: category, providerHttpStatus: 400, message: sensitive }),
      { providerErrorCategory: category, providerHttpStatus: category === 'http_status' ? 400 : null });
  }
  for (const category of [sensitive, null, {}, 400]) {
    assert.deepEqual(fastlaneErrorFields({ providerErrorCategory: category, providerHttpStatus: 400 }),
      { providerErrorCategory: 'unknown', providerHttpStatus: null });
  }
  for (const status of ['400', 99, 600, 400.5, NaN, Infinity, {}, sensitive, null]) {
    assert.equal(fastlaneErrorFields({ providerErrorCategory: 'http_status', providerHttpStatus: status }).providerHttpStatus, null);
  }
  assert.deepEqual(fastlaneErrorFields(), { providerErrorCategory: 'unknown', providerHttpStatus: null });
});

for (const status of [100, 400, 401, 429, 500, 599]) test(`HTTP ${status} retains two scalars without reading the upstream body`, async () => {
  let reads = 0;
  const { result, rows } = await runProvider(async () => ({ ok: false, status,
    json: async () => { reads++; throw Error(sensitive); }, text: async () => { reads++; return sensitive; } }));
  assert.deepEqual(result, { ok: false, failureReason: 'provider_error' });
  assert.equal(rows.length, 1); assert.equal(reads, 0);
  assert.equal(rows[0].providerErrorCategory, 'http_status'); assert.equal(rows[0].providerHttpStatus, status);
  assert.equal(rows[0].attempt, 1); assert.equal(rows[0].maxAttempts, 1); safe({ result, rows });
});

for (const status of ['401', 99, 600, 400.5]) test(`invalid HTTP status ${status} is omitted from real provider timing`, async () => {
  const { rows } = await runProvider(async () => ({ ok: false, status }));
  assert.equal(rows[0].providerErrorCategory, 'http_status'); assert.equal(rows[0].providerHttpStatus, null);
});

for (const [name, fetchImpl, category, failureReason] of [
  ['transport exception', async () => { throw Object.assign(Error(sensitive), { providerErrorCategory: sensitive, providerHttpStatus: 401 }); }, 'network', 'provider_error'],
  ['unreadable JSON envelope', async () => ({ ok: true, json: async () => { throw Error(sensitive); } }), 'invalid_response', 'provider_error'],
  ['empty choices', async () => ({ ok: true, json: async () => ({ choices: [] }) }), 'invalid_response', 'invalid_output'],
  ['truncated response', async () => completion(undefined, 'length'), 'invalid_response', 'invalid_output'],
  ['missing message', async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop' }] }) }), 'invalid_response', 'invalid_output'],
  ['null envelope', async () => ({ ok: true, json: async () => null }), 'invalid_response', 'invalid_output'],
]) test(`${name} has stage diagnostics and preserves the existing failure reason`, async () => {
  const { result, rows } = await runProvider(fetchImpl);
  assert.deepEqual(result, { ok: false, failureReason });
  assert.equal(rows[0].providerErrorCategory, category); assert.equal(rows[0].providerHttpStatus, null); safe({ result, rows });
});

test('configuration errors are classified before transport, without echoing configuration', async () => {
  for (const config of [...Object.keys(env()).map(key => ({ ...env(), [key]: '' })),
    { ...env(), FASTLANE_MODEL_ENDPOINT: sensitive }, { ...env(), FASTLANE_MODEL_ENDPOINT: 'http://secondary.invalid/chat' },
    { ...env(), FASTLANE_MODEL_ENDPOINT: 'https://user:password@secondary.invalid/chat' }]) {
    let calls = 0;
    const { result, rows } = await runProvider(async () => { calls++; return completion(); }, { env: config });
    assert.equal(calls, 0); assert.equal(result.failureReason, 'provider_error');
    assert.equal(rows[0].providerErrorCategory, 'configuration'); assert.equal(rows[0].providerHttpStatus, null); safe({ result, rows });
  }
});

test('unknown fastlane exceptions retain only fixed diagnostics', async () => {
  const rows = [], provider = createFastlaneProvider({ env: env(), now: () => 1000 });
  const result = await provider(sensitive, { deadlineAt: 151000, isCurrent: () => true,
    onAttempt: () => { throw Error(sensitive); }, onTiming: row => rows.push(row) });
  assert.equal(result.failureReason, 'provider_error'); assert.equal(rows[0].providerErrorCategory, 'unknown');
  assert.equal(rows[0].providerHttpStatus, null); safe({ result, rows });
});

test('success, local JSON/schema rejection and tool rejection stay distinct from provider failures', async () => {
  for (const [response, failureReason] of [[completion(), null], [completion(answer), null],
    [completion('{bad'), 'invalid_output'], [completion('{"reply":"Example answer"}'), 'invalid_output'],
    [completion(JSON.stringify({ ...answer, extra: sensitive })), 'invalid_output'],
    [completion(undefined, 'tool_calls'), 'unexpected_tool'], [completion(undefined, 'stop', { tool_calls: [{}] }), 'unexpected_tool']]) {
    const { result, rows } = await runProvider(async () => response);
    assert.equal(result.ok, failureReason === null); assert.equal(rows[0].failureReason, failureReason);
    assert.equal(rows[0].providerErrorCategory, null); assert.equal(rows[0].providerHttpStatus, null); safe(rows);
  }
});

test('budget timeout and external cancellation keep original results, timers and single-attempt limits', async () => {
  for (const cancelled of [false, true]) {
    let fire, signal, attempts = 0, cleared = 0;
    const controller = new AbortController(), rows = [];
    const provider = createFastlaneProvider({ env: env(), now: () => 1000,
      setTimer: (callback, ms) => { fire = callback; assert.equal(ms, 20000); return 11; },
      clearTimer: id => { assert.equal(id, 11); cleared++; },
      fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
    const pending = provider(sensitive, { deadlineAt: 151000, isCurrent: () => true, signal: controller.signal,
      onAttempt: () => attempts++, onTiming: row => rows.push(row) });
    if (cancelled) controller.abort(); else fire();
    assert.deepEqual(await pending, { ok: false, failureReason: cancelled ? 'stale_or_budget' : 'timeout' });
    assert.equal(signal.aborted, true); assert.equal(attempts, 1); assert.equal(cleared, 1);
    assert.equal(rows[0].providerErrorCategory, cancelled ? 'cancelled' : 'timeout'); assert.equal(rows[0].providerHttpStatus, null);
    assert.equal(rows[0].timeoutReason, cancelled ? null : 'fastlane_budget'); safe(rows);
  }
});

test('L2 disabled and unchecked snapshots initialize all added diagnostic fields to null', () => {
  const timing = laneTiming();
  for (const key of diagnosticKeys) assert.equal(timing[key], null);
  const draft = startL2Draft({ env: { WECHAT_L2_DRAFT: 'off' }, timing });
  assert.equal(draft, null); assert.equal(timing.draftOutcome, 'disabled');
});

for (const [value, ok, reason] of [[{ ordinary: true }, true, null], [{ ordinary: false }, true, 'not_approved'],
  [undefined, false, 'call_failed'], [{ ordinary: 'true' }, true, 'invalid_verdict'],
  [{ approved: true, needsUser: false, issues: [sensitive] }, true, 'invalid_verdict']]) {
  test(`public L2 verdict maps to safe diagnostics: ${reason || 'approved'}`, async () => {
    const { draft, timing, rows } = setupDraft();
    await tick(); assert.equal(rows.length, 0);
    draft.observe('理解完整请求', { ok: true, value: { ordinary: true } });
    draft.observe('独立普通回答核对', { ok, value });
    const result = await take(draft);
    assert.deepEqual(result, reason ? null : { reply: answer.reply });
    for (const snapshot of [timing, rows[0]]) {
      assert.equal(snapshot.draftCheckApproved, typeof value?.ordinary === 'boolean' ? value.ordinary : null);
      assert.equal(snapshot.draftCheckNeedsUser, null); assert.equal(snapshot.draftCheckIssuesCount, null);
      assert.equal(snapshot.draftCheckRejectReason, reason); assert.equal(snapshot.draftOutcome, reason ? 'discarded_check' : 'sent');
      safe(snapshot);
    }
    assert.equal(rows.length, 1);
  });
}

test('L2 HTTP error survives its deferred model row and final shared timing', async () => {
  const { draft, timing, rows } = setupDraft(async () => ({ ok: false, status: 400 }));
  admit(draft); assert.equal(await take(draft), null);
  assert.equal(rows.length, 1);
  for (const snapshot of [timing, rows[0]]) {
    assert.equal(snapshot.draftProviderErrorCategory, 'http_status'); assert.equal(snapshot.draftProviderHttpStatus, 400);
    assert.equal(snapshot.draftCheckApproved, true); assert.equal(snapshot.draftCheckRejectReason, null);
    assert.equal(snapshot.draftOutcome, 'discarded_error'); safe(snapshot);
  }
});

test('L2 unexpected provider throws are scalar-only, including unknown errors', async () => {
  for (const fields of [{}, { providerErrorCategory: 'http_status', providerHttpStatus: 503 },
    { providerErrorCategory: sensitive, providerHttpStatus: 400 }]) {
    const provider = Object.assign(async () => { throw Object.assign(Error(sensitive), fields); }, { available: () => true });
    const { draft, timing } = setupDraft(undefined, provider); admit(draft);
    assert.equal(await take(draft), null); assert.equal(timing.draftOutcome, 'discarded_error');
    assert.equal(timing.draftProviderErrorCategory, fields.providerErrorCategory === 'http_status' ? 'http_status' : 'unknown');
    assert.equal(timing.draftProviderHttpStatus, fields.providerErrorCategory === 'http_status' ? 503 : null); safe(timing);
  }
});

test('late independent verdict updates shared snapshots but never reopens an earlier discard or rewrites emitted rows', async () => {
  const { draft, timing, rows } = setupDraft(async () => new Promise(() => {}));
  draft.observe('理解完整请求', { ok: true, value: { ordinary: false } });
  await tick(); assert.equal(rows.length, 1); assert.equal(rows[0].draftCheckApproved, null);
  draft.observe('独立普通回答核对', { ok: true, value: { ordinary: false } });
  assert.equal(await take(draft), null); assert.equal(timing.draftOutcome, 'discarded_needs_pipeline');
  assert.equal(timing.draftCheckApproved, false); assert.equal(timing.draftCheckRejectReason, 'not_approved');
  assert.equal(timing.draftProviderErrorCategory, 'cancelled'); assert.equal(rows[0].draftCheckRejectReason, null); safe({ timing, rows });
});

test('real L2 path carries diagnostics into later primary rows and final chat timing without review exposure', async () => {
  const logs = [], calls = [];
  const run = createOrdinaryChat({ env: env(), log: line => logs.push(line),
    fastlaneOptions: { fetchImpl: async () => ({ ok: false, status: 400 }) },
    model: async (text, options) => { calls.push({ text, options }); return options.schema ? '{"ordinary":true}' : 'Original answer'; } });
  assert.equal(await run('Explain the shape of rain drops', { state: { known: true, history: [] } }), 'Original answer');
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(0, 2).every(call => !call.text.includes(answer.reply) && !call.options.tools));
  const rows = logs.map(line => JSON.parse(line.slice(line.indexOf('{'))));
  for (const row of [rows.find(row => row.stage === 'ordinary_answer' && row.provider === 'primary'), rows.at(-1)]) {
    assert.equal(row.draftProviderErrorCategory, 'http_status'); assert.equal(row.draftProviderHttpStatus, 400);
    assert.equal(row.draftCheckApproved, true); assert.equal(row.draftCheckNeedsUser, null);
    assert.equal(row.draftCheckIssuesCount, null); assert.equal(row.draftCheckRejectReason, null); assert.equal(row.draftOutcome, 'discarded_error');
  }
  safe(rows);
});

test('production-shaped shared prompt explicitly requests JSON independent of user/history and keeps both providers identical', async () => {
  const bodies = [], text = 'Explain a familiar idea', history = Array.from({ length: 15 }, (_, i) => ({ user: `Earlier question ${i}`, assistant: `Earlier answer ${i}` }));
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return completion(); };
  const provider = createFastlaneProvider({ env: env(), now: () => 1000, fetchImpl });
  const timing = laneTiming();
  const draft = startL2Draft({ provider, text, history, deadlineAt: 151000, isCurrent: () => true,
    onAttempt: () => {}, onTiming: () => {}, timing, now: () => 1000, env: env() });
  admit(draft); assert.deepEqual(await take(draft), { reply: answer.reply });
  const primary = createPublicModel({ endpoint: 'https://primary.invalid/chat', name: 'example-primary', apiKey: 'example-key', timeoutMs: 60000 }, { fetchImpl });
  await primary(text, { history, schema: FAST_ANSWER_SCHEMA, stage: 'ordinary_answer' });
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.deepEqual(bodies[0].messages, buildPublicMessages(text, { history, schema: FAST_ANSWER_SCHEMA }));
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[0].stream, false); assert.equal(bodies[0].tools, undefined); assert.equal(bodies[0].tool_choice, undefined);
  const instruction = bodies[0].messages[0].content;
  assert.match(instruction, /只输出 JSON：\{"reply":"回答","needs_tool":false\}/u);
  assert.equal(instruction.replace(' JSON：', ' '), buildPublicMessages(text)[0].content +
    ' 自然简洁地用中文回答；不确定的事实说不知道，不编造实时事实。只输出 {"reply":"回答","needs_tool":false}，需要工具或检索时 needs_tool=true 并将 reply 留空。');
  assert.ok(!/json/i.test(text + JSON.stringify(history)));
  assert.ok(bodies[0].messages[1].content.includes('Earlier question 3'));
  assert.ok(!bodies[0].messages[1].content.includes('Earlier question 2\n'));
  assert.equal(bodies[0].messages.at(-1).content, text); assert.equal(timing.draftOutcome, 'sent');
});
