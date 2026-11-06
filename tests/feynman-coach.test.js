'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeynmanCoachCommand: parse } = require('../src/feynman-coach-commands');
const { createFeynmanCoachStore } = require('../src/feynman-coach-store');
const { createFeynmanCoachProvider } = require('../src/feynman-coach-provider');
const feedback = { clear: '讲出了能量转换', uncertain: '效率的含义还不清楚', example: '可用水车作类比', question: '能量损失到哪里去了？' };
const summary = { mastery: '已理解基本转换，但效率还需巩固', nextStep: '用一个生活实例再解释一次' };
function fixture(overrides = {}) {
  const calls = [];
  const provider = {
    feedback: async data => { calls.push(['feedback', data]); return { ...feedback }; },
    summarize: async data => { calls.push(['summary', data]); return { ...summary }; },
    ...overrides,
  };
  const store = createFeynmanCoachStore({ provider });
  return { store, calls, run: (text, side = 'owner') => store.execute(side, parse(text, store.claimsAnswer(side))) };
}



test('requires topic, accepts both entries and colon widths; idle text is not claimed', async () => {
  for (const text of ['费曼', '费曼：', '费曼模式', '费曼模式:  ']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /<主题>/u);
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.deepEqual(f.calls, []);
  }
  for (const text of ['费曼：能量', '费曼: 能量', '费曼模式：能量', '费曼模式:能量']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /自己的话.*能量.*不用术语/u);
    assert.equal(f.store.claimsAnswer('owner'), true);
    assert.deepEqual(f.calls, []);
  }
  assert.equal(parse('普通聊天'), null);
  assert.equal(parse('  ', true), null);
  assert.deepEqual(parse('  讲解原文  ', true), { type: 'answer', text: '  讲解原文  ' });
});

test('explanation → structured feedback + exactly one question → one closing summary and clear', async () => {
  const f = fixture();
  await f.run('费曼：能量');
  const result = await f.run('  原文：能量可以转换  ');
  assert.match(result.reply, /讲清楚了什么：.*\n含糊或可能有误的地方：.*\n一个类比或例子建议：/u);
  assert.equal((result.reply.match(/[?？]/gu) || []).length, 1);
  assert.deepEqual(f.calls, [['feedback', { topic: '能量', explanation: '  原文：能量可以转换  ' }]]);
  assert.equal(f.store.claimsAnswer('owner'), true);
  const end = await f.run('变成了热');
  assert.equal(end.reply, `${summary.mastery}；建议下一步：${summary.nextStep}`);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.deepEqual(f.calls[1], ['summary', { topic: '能量', explanation: '  原文：能量可以转换  ', answer: '变成了热' }]);
  await f.run('费曼：新主题');
  await f.run('新讲解');
  assert.deepEqual(f.calls[2], ['feedback', { topic: '新主题', explanation: '新讲解' }]);
});

test('duplicate opening blocked at both stages; explicit end clears and reopening starts fresh', async () => {
  const f = fixture();
  await f.run('费曼：原主题');
  assert.match((await f.run('费曼模式：覆盖')).reply, /先发送“结束费曼”/u);
  await f.run('讲解');
  assert.match((await f.run('费曼：覆盖')).reply, /先发送“结束费曼”/u);
  assert.equal(f.calls.length, 1);
  assert.match((await f.run('结束费曼')).reply, /临时状态已清除/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.match((await f.run('结束费曼')).reply, /没有进行中/u);
  await f.run('费曼：下一场');
  await f.run('下一场讲解');
  assert.equal(f.calls[1][1].topic, '下一场');
});

test('friend rejected for all operations without model use or changing owner session', async () => {
  const f = fixture();
  for (const command of [{ type: 'start', topic: '能量' }, { type: 'answer', text: '讲解' }, { type: 'end' }]) {
    assert.match((await f.store.execute('friend', command)).reply, /只供已绑定的本人/u);
  }
  assert.equal(f.store.claimsAnswer('friend'), false);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.deepEqual(f.calls, []);
  await f.run('费曼：能量');
  await f.store.execute('friend', { type: 'end' });
  assert.equal(f.store.claimsAnswer('owner'), true);
});

test('unsupported operations leave idle, explanation and followup stages intact without provider calls', async () => {
  const f = fixture();
  const rejectInvalid = async active => {
    const before = structuredClone(f.calls);
    for (const command of [null, {}, { type: 'unknown' }]) {
      const result = await f.store.execute('owner', command);
      assert.match(result.reply, /不支持这个费曼操作/u);
      assert.equal(result.wrote, false);
      assert.equal(result.continue, false);
      assert.equal(f.store.claimsAnswer('owner'), active);
    }
    assert.deepEqual(f.calls, before);
  };
  await rejectInvalid(false);
  await f.run('费曼：能量');
  await rejectInvalid(true);
  assert.match((await f.run('原始讲解')).reply, /追问：/u);
  await rejectInvalid(true);
  assert.match((await f.run('回答')).reply, /建议下一步/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.deepEqual(f.calls, [
    ['feedback', { topic: '能量', explanation: '原始讲解' }],
    ['summary', { topic: '能量', explanation: '原始讲解', answer: '回答' }],
  ]);
});

test('model exceptions and malformed feedback retain explanation stage; retry succeeds', async () => {
  for (const fail of [() => { throw Error('offline'); }, () => undefined,
    () => ({ ...feedback, clear: '' }), () => ({ ...feedback, question: '甲？乙？' }),
    () => ({ ...feedback, clear: '还有什么？' }), () => ({ ...feedback, extra: 'bad' })]) {
    let first = true;
    const f = fixture({ feedback: async () => { if (first) { first = false; return fail(); } return feedback; } });
    await f.run('费曼：能量');
    assert.match((await f.run('讲解')).reply, /模型反馈失败.*保留/u);
    assert.equal(f.store.claimsAnswer('owner'), true);
    assert.match((await f.run('重发讲解')).reply, /追问：/u);
    assert.match((await f.run('回答')).reply, /建议下一步/u);
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
});

test('closing model failure preserves followup stage and original explanation for retry', async () => {
  let first = true;
  const f = fixture({ summarize: async data => {
    assert.deepEqual(data, { topic: '能量', explanation: '原始讲解', answer: '回答' });
    if (first) { first = false; throw Error('offline'); }
    return summary;
  } });
  await f.run('费曼：能量'); await f.run('原始讲解');
  assert.match((await f.run('回答')).reply, /模型收尾失败.*保留/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.match((await f.run('回答')).reply, /建议下一步/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('end during model call clears immediately, cancels queued answers and suppresses stale results', async () => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ feedback: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  await f.run('费曼：能量');
  const inFlight = f.run('讲解');
  await ready;
  const queued = f.run('提前回答');
  assert.match((await f.run('结束费曼')).reply, /已结束/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  finish(feedback);
  assert.equal(await inFlight, null);
  assert.equal(await queued, null);
});

test('concurrent starts serialize; new store has no retained session', async () => {
  const f = fixture();
  const results = await Promise.all([f.run('费曼：能量'), f.run('费曼：数学')]);
  assert.equal(results[0].wrote, true);
  assert.equal(results[1].wrote, false);
  assert.equal(fixture().store.claimsAnswer('owner'), false);
});

test('production provider uses existing fresh structured model channel; missing and invalid output fail closed', async () => {
  const calls = [];
  const provider = createFeynmanCoachProvider({ model: async (...args) => {
    calls.push(args);
    return { ok: true, value: args[3].stage === 'feynman_coach_feedback' ? feedback : summary };
  } });
  await provider.feedback({ topic: '能量', explanation: '原文' });
  await provider.summarize({ topic: '能量', explanation: '原文', answer: '回答' });
  for (const args of calls) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].schema.additionalProperties, false);
    assert.throws(() => args[3].parse('{}'));
    assert.match(args[0], /仅为取材数据/u);
  }
  assert.deepEqual(calls[0][3].parse(JSON.stringify(feedback)), feedback);
  for (const result of [{ ok: false }, { ok: true }, { ok: true, value: { ...feedback, question: '无问号' } }]) {
    await assert.rejects(createFeynmanCoachProvider({ model: async () => result }).feedback({ topic: '主题' }));
  }
});
