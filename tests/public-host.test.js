'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPublicConfig, validateWechatAccount } = require('../src/public-config');
const { createPublicAssistant } = require('../src/public-assistant');
const { createPublicWechat } = require('../src/public-wechat');
const { createPublicModel } = require('../src/public-model');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const account = { accountId: 'synthetic-account', userId: 'synthetic-owner', token: 'synthetic-token', baseUrl: 'https://synthetic.invalid/' };
function message(id = 'synthetic-1', extra = {}) {
  return { message_id: id, from_user_id: account.userId, to_user_id: account.accountId, context_token: 'synthetic-context',
    item_list: [{ type: 1, text_item: { text: '示例消息' } }], ...extra };
}
function response(body) { return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; }

test('runtime defaults use the supplied home and explicit environment; account fields have no live defaults', t => {
  const home = fixture(t);
  const config = loadPublicConfig({}, { home });
  assert.equal(config.runtime, path.join(home, '.local', 'share', 'wechat-assistant-framework', 'runtime'));
  assert.deepEqual(config.account, { accountId: '', userId: '', token: '', baseUrl: '' });
  assert.equal(fs.readdirSync(home).length, 0);
  assert.throws(() => validateWechatAccount(config.account), /Configure/);
  const override = loadPublicConfig({ WECHAT_ASSISTANT_HOME: 'private-runtime' }, { cwd: home, home });
  assert.equal(override.runtime, path.join(home, 'private-runtime'));
  assert.throws(() => validateWechatAccount({ ...account, baseUrl: 'http://synthetic.invalid' }), /HTTPS/);
});

test('default host actually persists features and reopens them without invoking the model', async t => {
  const runtime = fixture(t);
  let calls = 0;
  const options = { runtime, model: async () => { calls++; return '合成回答'; } };
  const assistant = createPublicAssistant(options);
  assert.match(await assistant.reply('记一下 示例待办'), /已|记/);
  assert.match(await createPublicAssistant(options).reply('我的待办'), /示例待办/);
  assert.match(await assistant.reply('记账 12元 餐饮 示例午餐'), /12/);
  assert.match(await assistant.reply('存临时信息 示例备忘'), /已|存/);
  assert.match(await assistant.reply('临时信息'), /示例备忘/);
  assert.match(await assistant.reply('创建习惯：散步'), /散步/);
  assert.equal(calls, 0);
  assert.equal(await assistant.reply('普通问题'), '合成回答');
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(path.join(runtime, 'state', 'features', 'todo', 'state.json')));
});

test('WeChat rejects unbound sender/account and duplicate message before assistant access', async t => {
  const runtime = fixture(t), sends = [], seen = [];
  const updates = [message('foreign-sender', { from_user_id: 'synthetic-stranger' }), message('foreign-account', { to_user_id: 'synthetic-other-account' }), message(), message()];
  const transport = createPublicWechat({ account, runtime, assistant: { reply: async text => { seen.push(text); return '合成结果'; } },
    fetchImpl: async (url, options) => {
      if (url.endsWith('getupdates')) return response({ msgs: updates, get_updates_buf: 'synthetic-cursor' });
      sends.push(JSON.parse(options.body)); return response({ ret: 0 });
    } });
  await transport.pollOnce(); await transport.pollOnce();
  assert.equal(seen.length, 1); assert.equal(sends.length, 1);
  assert.equal(sends[0].msg.to_user_id, account.userId);
});

test('uncertain sending is held across restart; feature operation is not replayed', async t => {
  const runtime = fixture(t); let calls = 0, sends = 0;
  const options = { account, runtime, assistant: { reply: async () => { calls++; return '合成结果'; } },
    fetchImpl: async url => {
      if (url.endsWith('getupdates')) return response({ msgs: [message()] });
      sends++; throw new Error('synthetic network failure after invocation');
    } };
  await assert.rejects(createPublicWechat(options).pollOnce(), /unconfirmed/);
  await assert.rejects(createPublicWechat(options).pollOnce(), /Uncertain/);
  assert.equal(calls, 1); assert.equal(sends, 1);
});

test('uncertain feature mutation is held without executing again and runtime cannot change binding', async t => {
  const runtime = fixture(t); let calls = 0;
  const options = { account, runtime, assistant: { reply: async () => { calls++; throw new Error('synthetic unknown mutation outcome'); } },
    fetchImpl: async () => response({ msgs: [message()] }) };
  await assert.rejects(createPublicWechat(options).pollOnce(), /synthetic unknown/);
  await assert.rejects(createPublicWechat(options).pollOnce(), /Uncertain/);
  assert.equal(calls, 1);
  assert.throws(() => createPublicWechat({ ...options, account: { ...account, userId: 'synthetic-other-owner' } }), /binding changed/);
});

test('ready output resumes at the unsent chunk using its saved client identity', async t => {
  const runtime = fixture(t), sent = [];
  const checkpoint = path.join(runtime, 'state', 'transport', 'checkpoint.json');
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
  fs.writeFileSync(checkpoint, JSON.stringify({ binding: JSON.stringify([account.accountId, account.userId, account.baseUrl]), cursor: '', processed: [],
    pending: { messageId: 'synthetic-1', deliveryId: 'synthetic-delivery', status: 'ready', context: 'synthetic-context', chunks: ['已确认的段落', '尚未发送的段落'], next: 1 } }));
  const transport = createPublicWechat({ account, runtime, assistant: { reply: () => assert.fail('must not reexecute') },
    fetchImpl: async (url, options) => {
      if (url.endsWith('getupdates')) return response({ msgs: [] });
      sent.push(JSON.parse(options.body).msg); return response({ ret: 0 });
    } });
  await transport.pollOnce();
  assert.equal(sent.length, 1); assert.equal(sent[0].client_id, 'synthetic-delivery:1');
  assert.equal(sent[0].item_list[0].text_item.text, '尚未发送的段落');
  assert.equal(JSON.parse(fs.readFileSync(checkpoint)).pending, null);
});

test('model adapter sends only current text and rejects failed or malformed responses without retry', async () => {
  const calls = [];
  const config = { endpoint: 'https://synthetic.invalid/chat', name: 'synthetic-model', apiKey: 'synthetic-placeholder', timeoutMs: 1000 };
  const model = createPublicModel(config, { fetchImpl: async (_url, request) => { calls.push(JSON.parse(request.body)); return response({ choices: [{ message: { content: '合成回答' } }] }); } });
  assert.equal(await model('本次问题'), '合成回答');
  assert.deepEqual(calls[0].messages.map(item => item.role), ['system', 'user']);
  assert.equal(calls[0].messages[1].content, '本次问题');
  assert.equal(calls[0].tools, undefined);
  await assert.rejects(createPublicModel(config, { fetchImpl: async () => ({ ok: false, status: 429 }) })('问题'), /429/);
  await assert.rejects(createPublicModel(config, { fetchImpl: async () => response({}) })('问题'), /no text/);
});
