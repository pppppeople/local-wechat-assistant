'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyCodexError, quotaResetAt } = require('../src/codex-errors');
const { createCodexQuotaState } = require('../src/codex-quota-state');
const { createDeepSeekClient } = require('../src/deepseek-client');
const { createFallbackTools, validateSchema } = require('../src/fallback-tools');
const { createFallbackJournal } = require('../src/fallback-journal');
const { createDeepSeekFallback, hasExecutionClaim } = require('../src/deepseek-fallback');
const { getChatHistory, formatChatHistory } = require('../src/chat-history');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { createExpenseLedgerStore } = require('../src/expense-ledger-store');
const quota = { message: 'Limit', codexErrorInfo: 'usageLimitExceeded' };
const MIN = 60000;
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-fallback-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function journal(t) {
  const root = temp(t), historyFile = path.join(root, 'chat', 'threads.json'), pendingFile = path.join(root, 'queues', 'pending.jsonl');
  const options = { operationDir: path.join(root, 'state', 'operations'), pendingFile, historyFile };
  return { root, historyFile, pendingFile, options, ...createFallbackJournal(options) };
}
const request = { accountId: 'synthetic-account', senderId: 'owner', side: 'owner', historyKey: 'synthetic-history', id: 'turn-1', text: '请记待办买苹果', imagePaths: [] };
const response = content => ({ role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) });
const invoke = (name, input = {}) => ({ role: 'assistant', content: null,
  tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: typeof input === 'string' ? input : JSON.stringify(input) } }] });
function setup(t, replies) {
  const j = journal(t), calls = [], executions = [];
  const todos = createPersonalTodoStore({ stateFile: path.join(j.root, 'todo', 'state.json') });
  const ledger = createExpenseLedgerStore({ stateFile: path.join(j.root, 'expense', 'state.json') });
  const tools = createFallbackTools({ side: 'owner', personalTodos: todos, expenseLedger: ledger,
    weatherCommands: { handle: async (...args) => { executions.push(args); return { reply: '天气数据', ok: true }; } } });
  let personaLoads = 0;
  const f = createDeepSeekFallback({ tools, journal: j, loadPersona: () => { personaLoads++; return { style: 'synthetic-persona' }; },
    getContext: () => ({ captured: {}, todos: todos.readOpenItems('owner') }),
    complete: async input => { calls.push(input); const next = replies.shift(); if (next instanceof Error) throw next; if (!next) throw Error('Unexpected model call'); return next; },
  });
  return { ...f, j, tools, todos, ledger, calls, executions, personaLoads: () => personaLoads };
}

test('real protocol variants distinguish usage exhaustion, rate limits, auth, network and unknown', () => {
  for (const [input, expected] of [
    [quota, 'QUOTA_EXHAUSTED'], [{ params: { turn: { error: quota } } }, 'QUOTA_EXHAUSTED'],
    [{ codexErrorInfo: 'rateLimitExceeded', message: 'usage limit exceeded' }, 'RATE_LIMITED'],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }, 'RATE_LIMITED'],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } }, 'AUTH'],
    [{ codexErrorInfo: 'unauthorized' }, 'AUTH'], [{ status: 401 }, 'AUTH'],
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }, 'TRANSIENT'],
    [{ message: 'Codex app-server disconnected', exitCode: 1 }, 'TRANSIENT'],
    [{ message: 'Codex turn timed out' }, 'TRANSIENT'], [{ message: '429 Too many requests' }, 'RATE_LIMITED'],
    [{ message: "You've hit your usage limit. Try again later." }, 'QUOTA_EXHAUSTED'],
    [{ codexErrorInfo: 'sessionBudgetExceeded' }, 'UNKNOWN'], [{ message: 'quota information unavailable' }, 'UNKNOWN'],
    [{ rpcCode: -32000, message: 'Internal error' }, 'UNKNOWN'],
  ]) assert.equal(classifyCodexError(input), expected);
});
test('structured reset uses exhausted windows, ignores healthy/expired windows, falls back five hours', () => {
  const at = 1800000000000;
  assert.equal(quotaResetAt({}, at), at + 300 * MIN);
  assert.equal(quotaResetAt({ rateLimits: { primary: { usedPercent: 100, resetsAt: at / 1000 + 60 }, secondary: { usedPercent: 100, resetsAt: at / 1000 + 120 } } }, at), at + 2 * MIN);
  assert.equal(quotaResetAt({ rateLimits: { primary: { usedPercent: 99, resetsAt: at / 1000 + 60 } } }, at), at + 300 * MIN);
});
test('breaker persistence, nonblocking single probe, backoff, reset boundary and recovery', async t => {
  let clock = 1800000000000; const file = path.join(temp(t), 'state', 'quota.json');
  let state = createCodexQuotaState({ file, now: () => clock });
  assert.equal(state.exhaust({ status: 429 }), false); assert.equal(fs.existsSync(file), false);
  state.exhaust(quota); state = createCodexQuotaState({ file, now: () => clock });
  assert.equal(state.isExhausted(), true); assert.equal(state.maybeProbe(() => { throw Error('early'); }), null);
  clock += 15 * MIN; let release, count = 0;
  const probe = state.maybeProbe(() => { count++; return new Promise(resolve => { release = resolve; }); });
  assert.equal(state.isExhausted(), true); assert.equal(state.maybeProbe(() => { throw Error('duplicate'); }), probe);
  await Promise.resolve(); assert.equal(count, 1); release({ ok: false }); await probe;
  assert.equal(state.snapshot().next_probe_at, clock + 30 * MIN);
  clock += 30 * MIN; await state.maybeProbe(async () => ({ ok: false }));
  assert.equal(state.snapshot().next_probe_at, clock + 60 * MIN);
  clock = state.snapshot().reset_at; await state.maybeProbe(async () => ({ ok: true }));
  assert.equal(state.isExhausted(), false);
  state.exhaust(quota); assert.equal(state.snapshot().exhausted_at, clock);
  assert.equal(state.snapshot().next_probe_at, clock + 15 * MIN);
});
test('stale successful probe cannot clear newer exhaustion; failed reset probe extends reset', async t => {
  let clock = 1800000000000;
  const state = createCodexQuotaState({ file: path.join(temp(t), 'q.json'), now: () => clock });
  state.exhaust(quota); clock += 15 * MIN;
  let finish; const probe = state.maybeProbe(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); state.exhaust(quota); finish({ ok: true }); await probe;
  assert.equal(state.isExhausted(), true);
  clock = state.snapshot().reset_at; await state.maybeProbe(async () => ({ ok: false, failure: quota }));
  assert.equal(state.snapshot().reset_at, clock + 300 * MIN);
});
test('DeepSeek HTTP contract, default/override model, function calling and safe errors', async () => {
  let received;
  const complete = createDeepSeekClient({ env: { DEEPSEEK_API_KEY: 'synthetic-secret' }, fetchImpl: async (url, init) => {
    received = { url, ...init }; return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: invoke('todo_list') }] }) };
  } });
  await complete({ messages: [response('x')], tools: [{ type: 'function' }] });
  assert.equal(received.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(received.body).model, 'deepseek-flash');
  assert.equal(JSON.parse(received.body).stream, false); assert.equal(received.headers.Authorization, 'Bearer synthetic-secret');
  const custom = createDeepSeekClient({ env: { DEEPSEEK_API_KEY: 'synthetic-secret', DEEPSEEK_MODEL: 'override' }, fetchImpl: async (_, init) => {
    assert.equal(JSON.parse(init.body).model, 'override'); throw Error('leaked synthetic-secret');
  } });
  await assert.rejects(custom({ messages: [] }), error => error.message === 'DeepSeek request failed');
  const http = createDeepSeekClient({ env: { DEEPSEEK_API_KEY: 'synthetic' }, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(http({ messages: [] }), /DeepSeek HTTP 401/);
  await assert.rejects(createDeepSeekClient({ env: {} })({ messages: [] }), /key is unavailable/);
});
test('DeepSeek timeout aborts fetch and truncation is not accepted', async () => {
  const timed = createDeepSeekClient({ env: { DEEPSEEK_API_KEY: 'synthetic' }, timeoutMs: 5,
    fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) });
  await assert.rejects(timed({ messages: [] }), /timed out/);
  const truncated = createDeepSeekClient({ env: { DEEPSEEK_API_KEY: 'synthetic' }, fetchImpl: async () => ({ ok: true,
    json: async () => ({ choices: [{ finish_reason: 'length', message: response('{') }] }) }) });
  await assert.rejects(truncated({ messages: [] }), /invalid response/);
});
test('registry validates closed schemas and forwards existing implementations', async t => {
  const f = setup(t, []);
  assert.equal(f.tools.catalog().length, 5);
  for (const [name, args] of [['expense_add', { amountCents: 1.5, category: '餐饮', note: '' }],
    ['todo_add', { text: 'ok', side: 'friend' }], ['weather_query', { city: '示例市' }], ['place_remove', {}]]) {
    assert.throws(() => f.tools.validate(name, args));
  }
  assert.throws(() => validateSchema({ type: 'string', pattern: 'x' }, 'x'), /Unsupported/);
  const tool = f.tools.validate('weather_query', { days: [0] });
  await tool.execute({ days: [0] });
  assert.equal(f.executions[0][0], 'owner');
});
test('durable operation ID dedupes concurrent/restarted execution; changed ID payload and uncertain dispatch refuse', async t => {
  const j = journal(t); let count = 0;
  const spec = { operationId: j.operationId(request, 0), name: 'todo_add', input: { text: '苹果' } };
  const execute = async () => { count++; return { reply: '已添加', wrote: true }; };
  const [a, b] = await Promise.all([j.execute(request, spec, execute), j.execute(request, spec, execute)]);
  assert.deepEqual(a, b); assert.equal(count, 1);
  const restarted = createFallbackJournal(j.options);
  await restarted.execute(request, spec, execute); assert.equal(count, 1);
  await assert.rejects(restarted.execute(request, { ...spec, name: 'expense_add' }, execute), /conflict/);
  assert.match(formatChatHistory(getChatHistory(j.historyFile, request.historyKey)), /todo_add/);
  const unknown = { ...spec, operationId: j.operationId(request, 1) };
  await assert.rejects(j.execute(request, unknown, async () => { throw Error('crash after dispatch'); }));
  await assert.rejects(restarted.execute(request, unknown, execute), /uncertain/); assert.equal(count, 1);
});
test('fallback ordinary chat reuses persona, recent history/time, and audits answer without tools', async t => {
  const f = setup(t, [response({ kind: 'chat' }), response({ approved: 'yes' }), response('听起来今天挺累的。'), response({ approved: 'yes' })]);
  const result = await f.run({ ...request, text: '今天累了' }, [{ user: '刚散步', assistant: '好呀', at: new Date().toISOString() }]);
  assert.match(result, /今天挺累/); assert.equal(f.personaLoads(), 1);
  assert.equal(f.calls[0].messages[0].content.includes('synthetic-persona'), false);
  assert.match(f.calls[2].messages[0].content, /synthetic-persona/);
  assert.match(f.calls[2].messages[1].content, /刚散步/); assert.match(f.calls[2].messages[1].content, /Asia\/Shanghai/);
});
test('single tool loop uses actual result, never fabricated extra success; replay executes once', async t => {
  const f = setup(t, [response({ kind: 'single' }), invoke('todo_add', { text: '买苹果' }), response({ approved: 'yes' }), response('已发邮件，已添加待办。')]);
  const result = await f.run(request);
  assert.match(result, /已记下：买苹果/); assert.doesNotMatch(result, /已发邮件/);
  assert.equal(f.todos.readOpenItems('owner').length, 1); assert.equal(f.personaLoads(), 0);
  assert.equal(f.calls[3].messages.at(-1).role, 'tool');
  await f.run(request); assert.equal(f.todos.readOpenItems('owner').length, 1);
});
test('invalid schema never executes; repair loop has at most six model calls', async t => {
  const f = setup(t, [response({ kind: 'single' }), ...Array.from({ length: 8 }, () => invoke('todo_add', { text: 'x', unexpected: true }))]);
  const result = await f.run(request); assert.equal(f.calls.length, 6);
  assert.equal(f.todos.readOpenItems('owner').length, 0); assert.match(result, /尚未执行/);
});
test('delete/multi-step/unadapted proposals and authority rejection queue once, no dispatch', async t => {
  for (const replies of [
    [response({ kind: 'pending' })],
    [response({ kind: 'single' }), invoke('delete_everything')],
    [response({ kind: 'single' }), { ...invoke('todo_add', { text: 'x' }), tool_calls: [...invoke('todo_add', { text: 'x' }).tool_calls, ...invoke('expense_add').tool_calls] }],
    [response({ kind: 'single' }), invoke('todo_add', { text: 'x' }), response({ approved: 'no' })],
  ]) {
    const f = setup(t, replies); const result = await f.run({ ...request, text: '删除待办，然后发邮件' });
    assert.match(result, /已记为待办/); assert.equal(f.todos.readOpenItems('owner').length, 0);
    f.j.pending({ ...request, text: '删除待办，然后发邮件' }, 'again');
    assert.equal(fs.readFileSync(f.j.pendingFile, 'utf8').trim().split('\n').length, 1);
  }
});
test('unsupported execution claim and semantic invented live fact are replaced with truthful pending receipt', async t => {
  assert.equal(hasExecutionClaim('已经帮你建好并保存提醒'), true);
  for (const replies of [
    [response({ kind: 'chat' }), response({ approved: 'yes' }), response('已经帮你保存提醒。')],
    [response({ kind: 'chat' }), response({ approved: 'yes' }), response('现在你那里正在下雨。'), response({ approved: 'no' })],
  ]) { const f = setup(t, replies); assert.match(await f.run(request), /尚未执行/); assert.equal(f.todos.readOpenItems('owner').length, 0); }
});
test('Prior partial completion and uncertain jobs block fallback tool duplication', async t => {
  const f = setup(t, []);
  await f.j.execute(request, { operationId: f.j.operationId(request, 0), name: 'todo_add', input: {} }, async () => ({ reply: '待办已创建 #synthetic', wrote: true }));
  assert.match(await f.run(request), /待办已创建/); assert.equal(f.calls.length, 0);
  const second = { ...request, id: 'turn-2' };
  assert.match(await f.run(second, [], { inFlight: true }), /结果不明/); assert.equal(f.calls.length, 0);
});
test('completion rechecks todo identity against current list and real ledger writes cents', async t => {
  const f = setup(t, []);
  f.todos.execute('owner', { type: 'add', text: 'first' }); f.todos.execute('owner', { type: 'add', text: 'second' });
  const context = { todos: f.todos.readOpenItems('owner') };
  f.todos.execute('owner', { type: 'complete', number: 1 });
  const result = await f.tools.registry.get('todo_complete').execute({ number: 1 }, context);
  assert.equal(result.wrote, false); assert.equal(f.todos.readOpenItems('owner').length, 1);
  const entry = await f.tools.registry.get('expense_add').execute({ amountCents: 1234, category: '餐饮', note: '合成' });
  assert.equal(entry.wrote, true); assert.match(f.ledger.execute('owner', { type: 'today' }).reply, /12.34元/);
});
test('manual, missing key failure and media refuse without an unsafe tool attempt', async t => {
  const f = setup(t, [Error('provider unavailable')]);
  assert.match(await f.run({ ...request, text: '降级说明' }), /能做什么/);
  assert.match(await f.run({ ...request, text: '2' }), /不会自动重放/);
  assert.match(await f.run(request), /暂时没有完成/);
  assert.match(await f.run({ ...request, id: 'media', imagePaths: ['/synthetic'] }), /尚未执行/);
});

