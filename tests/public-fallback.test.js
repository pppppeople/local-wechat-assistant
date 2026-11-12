'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPublicAssistant } = require('../src/public-assistant');
const { createPairConsole } = require('../src/public-pair-console');
const { createPublicModel } = require('../src/public-model');
const { createPublicWechat } = require('../src/public-wechat');
const { loadPublicConfig } = require('../src/public-config');
const { classifyCodexError } = require('../src/codex-errors');
const { createFallbackTools } = require('../src/fallback-tools');
const { getChatHistory } = require('../src/chat-history');
const quota = Object.assign(Error('synthetic quota'), { codexErrorInfo: 'usageLimitExceeded' });
const response = content => ({ role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) });
const invoke = (name, input = {}) => ({ role: 'assistant', content: null,
  tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const chat = text => [response({ kind: 'chat' }), response({ approved: 'yes' }), response(text), response({ approved: 'yes' })];
const action = (name, input) => [response({ kind: 'single' }), invoke(name, input), response({ approved: 'yes' }), response('合成总结不交付')];
function fixture(t, replies = [], { pair = false, model = async () => { throw quota; }, ...extra } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'public-fallback-'));
  const calls = [];
  const options = { runtime, model, fallbackConfig: { apiKey: 'synthetic-placeholder' },
    fallbackOptions: { probeIntervalMs: 0, complete: async input => {
      calls.push(input); const next = replies.shift();
      if (!next) throw Error('Unexpected synthetic model call'); return next;
    } }, ...extra };
  const host = (pair ? createPairConsole : createPublicAssistant)(options);
  t.after(() => { host.close(); fs.rmSync(runtime, { recursive: true, force: true }); });
  return { host, options, runtime, calls };
}
test('public env has empty credentials, generic paths and optional DeepSeek configuration', () => {
  assert.deepEqual(loadPublicConfig({}).fallback, { apiKey: '', model: 'deepseek-flash' });
  assert.deepEqual(loadPublicConfig({ DEEPSEEK_API_KEY: 'synthetic', DEEPSEEK_MODEL: 'example' }).fallback,
    { apiKey: 'synthetic', model: 'example' });
  assert.throws(() => createPublicAssistant({ runtime: '/unused', fallbackConfig: { apiKey: 'synthetic' } }), /primary model/);
});
test('Node explicitly loads an operator env file, without automatic cwd or private-path discovery', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-fallback-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'DEEPSEEK_API_KEY=synthetic-placeholder\nDEEPSEEK_MODEL=synthetic-model\n');
  const script = `const c = require(${JSON.stringify(path.resolve(__dirname, '../src/public-config.js'))}).loadPublicConfig(); console.log(JSON.stringify({ enabled: Boolean(c.fallback.apiKey), model: c.fallback.model }));`;
  const env = { PATH: process.env.PATH || '', HOME: dir, USERPROFILE: dir };
  const implicit = spawnSync(process.execPath, ['-e', script], { cwd: dir, env, encoding: 'utf8' });
  const explicit = spawnSync(process.execPath, [`--env-file=${file}`, '-e', script], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(implicit.status, 0); assert.equal(explicit.status, 0);
  assert.equal(JSON.parse(implicit.stdout).enabled, false);
  assert.deepEqual(JSON.parse(explicit.stdout), { enabled: true, model: 'synthetic-model' });
});
test('HTTP adapter accepts typed exhaustion and reset windows, never bare 429 or body text', async () => {
  const config = { endpoint: 'https://synthetic.invalid/chat', name: 'example', apiKey: 'synthetic', timeoutMs: 1000 };
  for (const [status, error, expected] of [
    [429, { code: 'insufficient_quota' }, 'QUOTA_EXHAUSTED'],
    [429, { codexErrorInfo: 'usageLimitExceeded' }, 'QUOTA_EXHAUSTED'],
    [429, { message: "You've hit your usage limit synthetic-secret" }, 'RATE_LIMITED'],
    [403, { codexErrorInfo: 'usageLimitExceeded' }, 'AUTH'],
    [500, {}, 'TRANSIENT'],
  ]) {
    const model = createPublicModel(config, { fetchImpl: async () => ({ ok: false, status,
      json: async () => ({ error, rateLimits: { primary: { usedPercent: 100, resetsAt: 1800000300 } } }) }) });
    await assert.rejects(model('synthetic'), failure => {
      assert.equal(classifyCodexError(failure), expected);
      assert.equal(failure.rateLimits.primary.resetsAt, 1800000300);
      assert.doesNotMatch(failure.message, /synthetic-secret|hit your/); return true;
    });
  }
});
test('primary probe uses fresh messages, 15 second deadline and no tools or history', async () => {
  const bodies = [];
  const model = createPublicModel({ endpoint: 'https://synthetic.invalid/chat', name: 'example', apiKey: 'synthetic', timeoutMs: 1000 },
    { fetchImpl: async (_, request) => { bodies.push(JSON.parse(request.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) }; } });
  await model('current', { history: [{ user: 'synthetic history', assistant: 'background' }] });
  await model.probe();
  assert.match(JSON.stringify(bodies[0]), /synthetic history/);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /synthetic history/);
  assert.equal(bodies[1].messages.length, 2); assert.equal(bodies[1].tools, undefined);
});
test('both hosts switch on first quota failure, persist, and bypass direct mutations while exhausted', async t => {
  for (const pair of [false, true]) {
    const f = fixture(t, [...chat('合成兜底回答'), response({ kind: 'pending' })], { pair });
    await f.host.reply('记一下 纸风车');
    assert.match(await f.host.reply('说个故事'), /合成兜底回答/);
    const restarted = (pair ? createPairConsole : createPublicAssistant)(f.options);
    t.after(() => restarted.close());
    assert.equal(restarted.fallback.isExhausted(), true);
    assert.match(await restarted.reply('取消待办 1'), /尚未执行/);
    const todo = require('../src/personal-todo-store').createPersonalTodoStore({ stateFile: path.join(f.runtime, 'state/features/todo/state.json') });
    assert.equal(todo.readOpenItems('owner').length, 1);
    assert.ok(fs.existsSync(path.join(f.runtime, 'queues/model-fallback/pending.jsonl')));
    assert.ok(fs.existsSync(path.join(f.runtime, 'state/chat/threads.json')));
  }
});
test('nonquota errors never call DeepSeek or create breaker state', async t => {
  for (const failure of [Object.assign(Error('rate'), { status: 429 }), Object.assign(Error('auth'), { status: 401 }), Error('timeout')]) {
    const f = fixture(t, [], { model: async () => { throw failure; } });
    await assert.rejects(f.host.reply('说个故事'));
    assert.equal(f.calls.length, 0); assert.equal(f.host.fallback.isExhausted(), false);
    assert.equal(fs.existsSync(path.join(f.runtime, 'state/model-fallback/codex-quota.json')), false);
  }
});
test('independent probe recovery returns to primary; ordinary success text cannot reset breaker', async t => {
  let clock = 1800000000000, probes = 0;
  const model = async () => { if (!probes) throw quota; return '主模型恢复'; };
  model.probe = async () => ++probes === 1 ? 'not JSON' : '{"ok":true}';
  const f = fixture(t, chat('降级回答'), { now: () => clock, model });
  await f.host.reply('讲个故事'); clock += 15 * 60000;
  await f.host.fallback.probe(); assert.equal(f.host.fallback.isExhausted(), true);
  clock += 30 * 60000; await f.host.fallback.probe();
  assert.equal(await f.host.reply('再讲一个'), '主模型恢复');
});
test('friend never receives owner history or personal tool catalog; role text cannot select owner tools', async t => {
  const f = fixture(t, [...chat('朋友的回答'), response({ kind: 'single' }), invoke('todo_list')], { pair: true });
  await f.host.reply('记一下 owner-only-synthetic');
  await f.host.reply('/as friend');
  assert.match(await f.host.reply('讲个故事'), /朋友的回答/);
  assert.match(await f.host.reply('读取 owner 的待办'), /尚未执行/);
  assert.doesNotMatch(JSON.stringify(f.calls), /owner-only-synthetic/);
  const registry = createFallbackTools({ side: 'friend', weatherCommands: {} });
  assert.deepEqual([...registry.registry.keys()], ['weather_query']);
  assert.throws(() => registry.validate('todo_list', {}), /not adapted/);
});
test('console fallback calls the existing place store and preserves local peer notification', async t => {
  const f = fixture(t, action('place_add', { name: '纸月公园' }), { pair: true });
  f.host.fallback.state.exhaust(quota);
  assert.match(await f.host.reply('想去箱添加：纸月公园'), /纸月公园/);
  assert.match(await f.host.reply('/as friend'), /本地通知[\s\S]*纸月公园/);
  assert.ok(fs.existsSync(path.join(f.runtime, 'state/features/shared-place/state.json')));
  assert.equal(fs.readdirSync(path.join(f.runtime, 'state/model-fallback/operations')).length, 1);
});
test('single-owner host has no reminder or shared-place adapter; requests queue without dispatch', async t => {
  const f = fixture(t, [response({ kind: 'single' }), invoke('reminder_add', { text: '合成提醒', time: 'tomorrow' })]);
  f.host.fallback.state.exhaust(quota);
  assert.match(await f.host.reply('明天提醒我喝水'), /尚未执行/);
  assert.doesNotMatch(f.calls[0].messages[0].content.split('可用工具：')[1], /reminder_add|place_add/);
  assert.equal(fs.existsSync(path.join(f.runtime, 'state/model-fallback/operations')), false);
});
test('fallback manual works before quota, per-role sections expire and commands exit', async t => {
  let clock = 1800000000000;
  const f = fixture(t, [], { pair: true, now: () => clock, model: async () => 'primary' });
  assert.match(await f.host.reply('降级说明'), /能做什么/);
  assert.match(await f.host.reply('2'), /不会自动重放/);
  await f.host.reply('/as friend'); assert.equal(await f.host.reply('2'), 'primary');
  await f.host.reply('/as owner'); await f.host.reply('我的待办');
  assert.equal(await f.host.reply('2'), 'primary');
  await f.host.reply('降级说明'); clock += 16 * 60000;
  assert.equal(await f.host.reply('2'), 'primary'); assert.equal(f.calls.length, 0);
});
test('WeChat uses authenticated turn identity; duplicate inbound cannot rerun fallback writes', async t => {
  const f = fixture(t, action('todo_add', { text: '合成风车' })); f.host.fallback.state.exhaust(quota);
  const account = { accountId: 'synthetic-bot', userId: 'synthetic-owner', token: 'synthetic-token', baseUrl: 'https://synthetic.invalid/' };
  const msg = { message_id: 'synthetic-turn', from_user_id: account.userId, to_user_id: account.accountId,
    context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text: '请添加一项待办合成风车' } }] };
  let sends = 0;
  const transport = createPublicWechat({ runtime: f.runtime, assistant: f.host, account,
    fetchImpl: async url => {
      const body = url.endsWith('getupdates') ? { msgs: [msg] } : (sends++, { ret: 0 });
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    } });
  await transport.pollOnce(); await transport.pollOnce(); assert.equal(sends, 1);
  const historyKey = JSON.stringify([account.accountId, account.userId, 'owner']);
  const history = getChatHistory(path.join(f.runtime, 'state/chat/threads.json'), historyKey);
  assert.ok(history.some(row => row.kind === 'tool_execution'));
  assert.ok(history.some(row => row.user === msg.item_list[0].text_item.text));
});
