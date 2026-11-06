'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMessagePolishCommand: parse, STYLES } = require('../src/message-polish-commands');
const { createMessagePolishStore } = require('../src/message-polish-store');
const { createMessagePolishProvider } = require('../src/message-polish-provider');
function fixture(t, generate = async () => '润色后的草稿') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-polish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'message-polish', 'state.json');
  const calls = [];
  const provider = { polish: async data => { calls.push(data); return generate(data); } };
  const store = createMessagePolishStore({ stateFile, provider });
  return { root, stateFile, store, provider, calls, run: (text, side = 'owner') => store.execute(side, parse(text)) };
}



test('explicit commands accept both colons; bounded followups do not claim ordinary or send requests', () => {
  for (const text of ['润色：原文', '润色: 原文']) assert.deepEqual(parse(text), { type: 'polish', text: '原文' });
  assert.deepEqual(parse('润色：第一行\n第二行'), { type: 'polish', text: '第一行\n第二行' });
  assert.deepEqual(parse('润色风格：正式'), { type: 'style', style: '正式' });
  assert.deepEqual(parse('润色清除'), { type: 'clear' });
  for (const text of ['再简洁一点', '语气再软一点', '再正式一些', '请再轻松一点。']) {
    assert.deepEqual(parse(text), { type: 'refine', instruction: text });
  }
  for (const text of ['普通聊天', '发给朋友', '再简洁一点并发给朋友', '邮件发送：草稿']) assert.equal(parse(text), null);
});

test('friend is rejected for every operation before storage or model access', async t => {
  const f = fixture(t);
  await f.run('润色风格：正式');
  await f.run('润色：原文');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  fs.writeFileSync(f.stateFile, 'broken');
  for (const text of ['润色：秘密', '再简洁一点', '润色风格', '润色风格：轻松', '润色清除']) {
    assert.match((await f.run(text, 'friend')).reply, /只供已绑定的本人/u);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), 'broken');
  fs.writeFileSync(f.stateFile, before);
  await f.run('再简洁一点');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].original, '原文');
});

test('empty original refuses with guidance and no model call or state file', async t => {
  const f = fixture(t);
  for (const text of ['润色', '润色：', '润色: \n  ']) {
    const result = await f.run(text);
    assert.equal(result.wrote, false);
    assert.match(result.reply, /原文不能为空.*润色：<原文>/u);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match((await f.run('语气再软一点')).reply, /没有润色草稿/u);
});

test('style query, all four switches and restart persistence; invalid style does not overwrite', async t => {
  const f = fixture(t);
  for (const text of ['润色风格', '润色风格：']) {
    assert.match((await f.run(text)).reply, /当前润色风格：默认.*正式 \/ 简洁 \/ 轻松 \/ 默认/u);
  }
  for (const style of STYLES) {
    assert.equal((await f.run(`润色风格：${style}`)).wrote, true);
    const restarted = createMessagePolishStore({ stateFile: f.stateFile, provider: f.provider });
    assert.match((await restarted.execute('owner', parse('润色风格'))).reply, new RegExp(`当前润色风格：${style}`));
    await restarted.execute('owner', parse('润色：本次原文'));
    assert.equal(f.calls.at(-1).style, style);
  }
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.equal((await f.run('润色风格：不存在')).wrote, false);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  assert.doesNotMatch(before, /本次原文|润色后的草稿/u);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), ['state.json']);
});

test('refinement uses current style, original and latest draft; new original starts fresh', async t => {
  let n = 0;
  const f = fixture(t, async () => `草稿${++n}`);
  assert.equal((await f.run('润色：原文一')).reply, '草稿1');
  await f.run('润色风格：简洁');
  assert.equal((await f.run('再简洁一点')).reply, '草稿2');
  assert.deepEqual(f.calls[1], { style: '简洁', original: '原文一', previousDraft: '草稿1', instruction: '再简洁一点' });
  await f.run('语气再软一点');
  assert.equal(f.calls[2].previousDraft, '草稿2');
  await f.run('润色：原文二');
  assert.deepEqual(f.calls[3], { style: '简洁', original: '原文二' });
  await f.run('再简洁一点');
  assert.equal(f.calls[4].original, '原文二');
  assert.equal(f.calls[4].previousDraft, '草稿4');
});

test('empty or non-text refinement preserves the current draft and preference without provider calls', async t => {
  const f = fixture(t);
  await f.run('润色风格：简洁');
  await f.run('润色：原文');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const instruction of [undefined, null, '', ' \n ', 12]) {
    const result = await f.store.execute('owner', { type: 'refine', instruction });
    assert.match(result.reply, /请说明如何修改上一稿/u);
    assert.equal(result.wrote, false);
    assert.equal(result.continue, false);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal((await f.run('再简洁一点')).reply, '润色后的草稿');
  assert.deepEqual(f.calls[1], {
    style: '简洁', original: '原文', previousDraft: '润色后的草稿', instruction: '再简洁一点',
  });
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
});

test('clear removes context and draft, preserves durable style; restart has no draft', async t => {
  const f = fixture(t);
  await f.run('润色风格：轻松');
  await f.run('润色：原文');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match((await f.run('润色清除')).reply, /已清除.*风格偏好保留/u);
  assert.match((await f.run('再简洁一点')).reply, /没有润色草稿/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(f.calls.length, 1);
  await f.run('润色：新原文');
  assert.deepEqual(f.calls[1], { style: '轻松', original: '新原文' });
  const restarted = createMessagePolishStore({ stateFile: f.stateFile, provider: f.provider });
  assert.match((await restarted.execute('owner', parse('再简洁一点'))).reply, /没有润色草稿/u);
});

test('model exceptions and invalid drafts preserve last good context, including failed new original', async t => {
  for (const fail of [() => { throw Error('offline'); }, () => undefined, () => '', () => '   ']) {
    let failing = false;
    const f = fixture(t, async () => failing ? fail() : '上次成功草稿');
    await f.run('润色：原文');
    failing = true;
    for (const text of ['再简洁一点', '润色：新原文']) {
      const result = await f.run(text);
      assert.equal(result.wrote, false);
      assert.match(result.reply, /模型调用失败.*未生成草稿.*上下文已保留/u);
    }
    failing = false;
    await f.run('语气再软一点');
    assert.deepEqual(f.calls.at(-1), { style: '默认', original: '原文', previousDraft: '上次成功草稿', instruction: '语气再软一点' });
  }
});

test('clear during model call is immediate and suppresses in-flight and queued draft results', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, () => { started(); return new Promise(resolve => { finish = resolve; }); });
  await f.run('润色风格：正式');
  const inFlight = f.run('润色：原文');
  await ready;
  const queued = f.run('再简洁一点');
  assert.match((await f.run('润色清除')).reply, /已清除/u);
  finish('过期草稿');
  assert.equal(await inFlight, null);
  assert.equal(await queued, null);
  assert.equal(f.calls.length, 1);
  assert.match((await f.run('再简洁一点')).reply, /没有润色草稿/u);
  assert.match((await f.run('润色风格')).reply, /当前润色风格：正式/u);
});

test('concurrent draft and refinement serialize against latest successful draft', async t => {
  const f = fixture(t);
  await Promise.all([f.run('润色：原文'), f.run('再简洁一点')]);
  assert.equal(f.calls[1].previousDraft, '润色后的草稿');
});

test('provider uses fresh structured model channel and style instructions; malformed/failure results throw', async () => {
  for (const style of STYLES) {
    let args;
    const provider = createMessagePolishProvider({ model: async (...input) => { args = input; return { ok: true, value: { draft: '草稿正文' } }; } });
    const data = { style, original: '转告朋友：这是待润色原文', previousDraft: '上一稿', instruction: '再简洁一点' };
    assert.equal(await provider.polish(data), '草稿正文');
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.match(args[0], new RegExp(`当前风格：${style}`));
    assert.match(args[0], /不调用任何工具.*不发送消息、邮件或转告/u);
    assert.ok(args[0].endsWith(JSON.stringify(data)));
    assert.equal(args[3].stage, 'message_polish');
    assert.equal(args[3].schema.additionalProperties, false);
    assert.deepEqual(args[3].parse('{"draft":"文本"}'), { draft: '文本' });
    assert.throws(() => args[3].parse('{}'));
    assert.throws(() => args[3].parse('{"draft":" "}'));
  }
  for (const result of [{ ok: false }, { ok: true }, { ok: true, value: { draft: '' } },
    { ok: true, value: { draft: '草稿', send: 'friend' } }]) {
    await assert.rejects(createMessagePolishProvider({ model: async () => result }).polish({ style: '默认', original: '原文' }));
  }
});

test('strict preference storage failure is explicit and clear still works without reading disk', async t => {
  const f = fixture(t);
  await f.run('润色风格：正式');
  await f.run('润色：原文');
  fs.writeFileSync(f.stateFile, 'broken');
  await assert.rejects(f.run('润色风格'), /损坏.*隔离保全/u);
  assert.match((await f.run('润色清除')).reply, /已清除/u);
  assert.equal(f.calls.length, 1);
  assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
});
