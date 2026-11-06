'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDetectiveGameCommand: parse, REFUSAL } = require('../src/detective-game-commands');
const { createDetectiveGameProvider, validateCase } = require('../src/detective-game-provider');
const { createDetectiveGameStore, normalizeAnswer } = require('../src/detective-game-store');
const mystery = () => ({ background: '虚构展馆失窃。三名嫌疑人谁拿走了展品？只答代号。', answer: 'Agent A',
  clues: ['第一条证据', '第二条证据', '第三条证据', '第四条证据', '第五条证据'] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(generate = mystery) {
  let calls = 0;
  const store = createDetectiveGameStore({ provider: { generate: () => { calls++; return generate(); } } });
  return { store, calls: () => calls, run: text => store.execute('owner', parse(text)) };
}



test('opening hides secrets; cloned frozen truth and ordered clues never invoke model again, sixth investigation refuses', async () => {
  const output = mystery();
  const f = fixture(() => output);
  const opening = (await f.run('桌游主持')).reply;
  assert.match(opening, /虚构展馆失窃/);
  for (const secret of [output.answer, ...output.clues]) assert.ok(!opening.includes(secret));
  const expected = mystery();
  output.answer = 'changed'; output.clues.fill('changed'); output.clues.push('第六条');
  for (let i = 0; i < 5; i++) {
    const reply = (await f.run(i % 2 ? '问线索' : '调查')).reply;
    assert.match(reply, new RegExp(`线索 ${i + 1}/5：${expected.clues[i]}`));
    for (const later of expected.clues.slice(i + 1)) assert.ok(!reply.includes(later));
    assert.ok(!reply.includes(expected.answer));
  }
  const sixth = await f.run('调查');
  assert.equal(sixth.wrote, false); assert.equal(sixth.continue, false);
  assert.match(sixth.reply, /已无线索.*提交答案或.*结束桌游/);
  assert.match((await f.run('答案：agent a')).reply, /答对了.*冻结答案：Agent A/);
  assert.equal(f.calls(), 1);
});

test('deterministic normalization, correct and incorrect reveal frozen answer then clear', async () => {
  assert.equal(normalizeAnswer(' \nＡＧＥＮＴ　Ａ \n'), 'agent a');
  assert.notEqual(normalizeAnswer('agent  a'), normalizeAnswer('agent a'));
  assert.notEqual(normalizeAnswer('agent a。'), normalizeAnswer('agent a'));
  for (const [answer, result] of [[' ＡＧＥＮＴ　Ａ ', '答对了'], ['Agent B', '答错了']]) {
    const f = fixture(); await f.run('开始桌游');
    const reply = (await f.run(`答案：${answer}`)).reply;
    assert.match(reply, new RegExp(`${result}.*冻结答案：Agent A`));
    assert.match(reply, /已清除/); assert.equal(f.store.claimsAnswer('owner'), false);
    for (const text of ['调查', '答案：Agent A', '结束桌游']) assert.match((await f.run(text)).reply, /没有进行中/);
    assert.equal(f.calls(), 1);
  }
});

test('empty answer preserves game; early end clears without revealing answer or clues; new instance has no state', async () => {
  const f = fixture(); await f.run('开始桌游');
  assert.match((await f.run('答案：　')).reply, /填写推断/);
  assert.equal(f.store.claimsAnswer('owner'), true);
  const reply = (await f.run('结束桌游')).reply;
  assert.match(reply, /已结束.*已清除/);
  for (const secret of [mystery().answer, ...mystery().clues]) assert.ok(!reply.includes(secret));
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(fixture().store.claimsAnswer('owner'), false);
  for (const text of ['调查', '问线索', '答案：A', '结束桌游']) assert.match((await f.run(text)).reply, /没有进行中/);
});

test('single session refuses repeated and queued starts without another model call', async () => {
  const f = fixture(); const start = f.run('开始桌游');
  assert.match((await f.run('桌游主持')).reply, /先发送.*结束桌游.*答案/);
  await start;
  assert.match((await f.run('开始桌游')).reply, /不会覆盖/);
  assert.equal(f.calls(), 1);
  await f.run('结束桌游'); await f.run('开始桌游'); assert.equal(f.calls(), 2);
});

test('model errors and malformed cases fail atomically without half sessions; retry opens normally', async () => {
  for (const invalid of [null, {}, { ...mystery(), answer: '' }, { background: '背景', clues: ['线索'] },
    { ...mystery(), clues: [] }, { ...mystery(), clues: [' '] }, { ...mystery(), clues: Array(6).fill('线索') },
    { ...mystery(), extra: '字段' }, 'throw']) {
    let broken = true;
    const f = fixture(() => { if (!broken) return mystery(); if (invalid === 'throw') throw Error('offline'); return invalid; });
    assert.match((await f.run('开始桌游')).reply, /失败.*未建立会话/);
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.match((await f.run('调查')).reply, /没有进行中/);
    broken = false; await f.run('开始桌游'); assert.equal(f.store.claimsAnswer('owner'), true);
  }
});

test('one to five clues accepted and exhaustion does not invent further evidence', async () => {
  const f = fixture(() => ({ ...mystery(), clues: ['唯一线索'] })); await f.run('开始桌游');
  assert.match((await f.run('调查')).reply, /唯一线索.*\n线索已用完/);
  assert.match((await f.run('问线索')).reply, /已无线索/); assert.equal(f.calls(), 1);
});

test('end during generation cancels late output and queued actions; no resurrection', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const start = f.run('开始桌游'); await tick();
  const queued = f.run('调查');
  assert.match((await f.run('结束桌游')).reply, /已结束/);
  finish(mystery());
  assert.equal(await start, null); assert.equal(await queued, null);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('non-owner calls refuse before command/session access and never call model', async () => {
  const f = fixture();
  const poisoned = new Proxy({}, { get() { throw Error('must not inspect command'); } });
  for (const side of ['friend', 'outsider', undefined]) {
    for (const command of [poisoned, ...['开始桌游', '调查', '答案：A', '结束桌游'].map(parse)]) {
      assert.equal((await f.store.execute(side, command)).reply, REFUSAL);
    }
  }
  assert.equal(f.calls(), 0); assert.equal(f.store.claimsAnswer('owner'), false);
  await f.run('开始桌游'); await f.store.execute('friend', parse('结束桌游'));
  assert.equal(f.store.claimsAnswer('owner'), true); assert.equal(f.calls(), 1);
});

test('invalid owner operations never generate a case or consume an active game', async () => {
  const f = fixture();
  const invalid = [null, {}, { type: 'invalid' }, { type: 'answer' }, { type: 'answer', answer: 1 }];
  for (const active of [false, true]) {
    if (active) await f.run('开始桌游');
    for (const command of invalid) {
      const result = await f.store.execute('owner', command);
      assert.equal(result.wrote, false);
      assert.equal(result.continue, false);
      assert.match(result.reply, /请用.*开始桌游.*调查.*答案/);
      assert.equal(f.store.claimsAnswer('owner'), active);
      assert.equal(f.calls(), active ? 1 : 0);
    }
  }
  assert.match((await f.run('调查')).reply, /线索 1\/5：第一条证据/);
  assert.match((await f.run('答案：Agent A')).reply, /答对了.*冻结答案：Agent A/);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(f.calls(), 1);
});

test('provider uses a fresh structured call with no chat or tool data and validates results', async () => {
  const calls = [];
  const provider = createDetectiveGameProvider({ model: async (...args) => { calls.push(args); return { ok: true, value: mystery() }; } });
  assert.deepEqual(await provider.generate(), mystery());
  const [prompt, session, images, options] = calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []);
  assert.match(prompt, /不以真实聊天内容作剧情素材/); assert.match(prompt, /不读取历史、文件、邮件、专业系统、好友聊天/);
  assert.deepEqual(Object.keys(options.schema.properties).sort(), ['answer', 'background', 'clues']);
  assert.equal(options.schema.properties.clues.maxItems, 5);
  assert.deepEqual(options.parse(JSON.stringify(mystery())), mystery()); assert.throws(() => options.parse('{}'));
  for (const value of [null, { ...mystery(), answer: ' ' }, { ...mystery(), clues: [] }]) assert.throws(() => validateCase(value));
  for (const result of [{ ok: false }, { ok: true, value: {} }]) {
    await assert.rejects(createDetectiveGameProvider({ model: async () => result }).generate());
  }
});
