'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFollowupDrillCommand: parse, REFUSAL } = require('../src/followup-drill-commands');
const { createFollowupDrillStore } = require('../src/followup-drill-store');
const { createFollowupDrillProvider } = require('../src/followup-drill-provider');
const { parseMeetingSimulatorCommand } = require('../src/meeting-simulator-commands');
const evaluation = { clarity: '请求清楚，但缺少环境背景。', unanswered: '尚未说明期望的登录流程。',
  recommended: 'Could you confirm which login flow we should use?' };
const question = round => ({ question: `Could you clarify point ${round}?` });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const calls = [];
  const store = createFollowupDrillStore({ provider: {
    next: async data => { calls.push(['next', data]); return question(data.round); },
    evaluate: async data => { calls.push(['evaluate', data]); return { ...evaluation }; },
    ...overrides,
  } });
  return { store, calls, run: (text, side = 'owner') => store.execute(side, parse(text, store.claimsAnswer(side))) };
}



test('trimmed triggers, multiline scene, empty-scene refusal and no idle capture', async () => {
  for (const text of ['追问训练', ' 追问训练： \n ', '追问训练: ']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /场景不能为空/);
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.deepEqual(f.calls, []);
  }
  for (const text of [' 追问训练： IAS 登录\n说明期望流程  ', '追问训练: IAS 登录\n说明期望流程']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /第 1\/3 轮追问/);
    assert.deepEqual(f.calls, [['next', { scene: 'IAS 登录\n说明期望流程', turns: [], round: 1 }]]);
    assert.equal(f.store.claimsAnswer('owner'), true);
  }
  assert.equal(parse('Hello'), null);
  assert.equal(parse('   ', true), null);
  assert.deepEqual(parse(' Answer  ', true), { type: 'answer', text: 'Answer' });
  assert.deepEqual(parse('  结束追问 \n'), { type: 'end' });
});

test('three questions, then three-section evaluation with only this session and no fourth question', async () => {
  const f = fixture();
  await f.run('追问训练：Clarify the login flow');
  for (let round = 1; round <= 2; round++) {
    const result = await f.run(`Answer ${round}`);
    assert.match(result.reply, new RegExp(`第 ${round + 1}/3 轮追问`));
    assert.equal(f.store.claimsAnswer('owner'), true);
  }
  const result = await f.run('Answer 3');
  assert.match(result.reply, /^表达清晰度：\n.+\n\n未回应问题：\n.+\n\n推荐表达：\n/su);
  assert.doesNotMatch(result.reply, /轮追问/);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['next', 'next', 'next', 'evaluate']);
  assert.deepEqual(f.calls[3][1], { scene: 'Clarify the login flow', turns: [1, 2, 3].map(round => ({
    question: question(round).question, answer: `Answer ${round}`,
  })) });
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.match((await f.store.execute('owner', { type: 'answer', text: 'Fourth' })).reply, /没有追问训练/);
  assert.equal(f.calls.length, 4);
  await f.run('追问训练：New scene');
  assert.deepEqual(f.calls.at(-1)[1], { scene: 'New scene', turns: [], round: 1 });
});

test('early end clears without evaluation; idle end explicit; repeated start refuses and preserves scene', async () => {
  const f = fixture();
  assert.match((await f.run('结束追问')).reply, /没有追问训练在进行/);
  await f.run('追问训练：Original');
  assert.match((await f.run('追问训练：Replacement')).reply, /先发送“结束追问”/);
  assert.equal(f.calls.length, 1);
  await f.run('First answer');
  assert.equal(f.calls.at(-1)[1].scene, 'Original');
  assert.match((await f.run('结束追问')).reply, /已结束.*已清除/);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(f.calls.some(([kind]) => kind === 'evaluate'), false);
  await f.run('追问训练：Replacement');
  assert.deepEqual(f.calls.at(-1)[1], { scene: 'Replacement', turns: [], round: 1 });
});

test('failed first question retains scene and retries without consuming the retry text as an answer', async () => {
  let broken = true;
  const calls = [];
  const f = fixture({ next: async data => {
    calls.push(data);
    if (broken) throw Error('offline');
    return question(data.round);
  } });
  assert.match((await f.run('追问训练：Scene')).reply, /模型追问失败.*会话已保留/);
  assert.equal(f.store.claimsAnswer('owner'), true);
  broken = false;
  assert.match((await f.run('重试首轮')).reply, /第 1\/3/);
  assert.deepEqual(calls[0], calls[1]);
});

test('failed followup retains current question and does not advance round or duplicate answers on retry', async () => {
  let broken = false;
  const calls = [];
  const f = fixture({ next: async data => {
    calls.push(data);
    if (broken) throw Error('offline');
    return question(data.round);
  } });
  await f.run('追问训练：Scene');
  broken = true;
  assert.match((await f.run('First answer')).reply, /模型追问失败.*会话已保留.*轮次未增加/);
  assert.equal(f.store.claimsAnswer('owner'), true);
  broken = false;
  assert.match((await f.run('First answer')).reply, /第 2\/3/);
  assert.deepEqual(calls[1], calls[2]);
  await f.run('Second answer');
  await f.run('Third answer');
  assert.equal(f.calls[0][1].turns.length, 3);
});

test('failed or incomplete evaluation always ends and clears, returns no partial evaluation', async () => {
  for (const evaluate of [async () => { throw Error('offline'); }, async () => ({ clarity: 'Partial' }),
    async () => ({ ...evaluation, recommended: '' })]) {
    const f = fixture({ evaluate });
    await f.run('追问训练：Scene'); await f.run('One'); await f.run('Two');
    const result = await f.run('Three');
    assert.match(result.reply, /模型终局评价失败.*已结束.*已清除/);
    assert.doesNotMatch(result.reply, /表达清晰度：|Partial/);
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.match((await f.run('结束追问')).reply, /没有追问训练/);
    await f.run('追问训练：Fresh');
    assert.deepEqual(f.calls.at(-1)[1], { scene: 'Fresh', turns: [], round: 1 });
  }
});

test('malformed questions never produce invented output and keep session for retry', async () => {
  for (const value of [{ question: '请说明？' }, { question: 'Why? Which?' }, { question: 'Why?', extra: 'bad' }]) {
    const f = fixture({ next: async () => value });
    const result = await f.run('追问训练：Scene');
    assert.match(result.reply, /模型追问失败/);
    assert.equal(f.store.claimsAnswer('owner'), true);
  }
});

test('friend admission occurs before reading even command fields and cannot touch owner session', async () => {
  const f = fixture();
  const poison = new Proxy({}, { get: () => assert.fail('friend command must not be read') });
  assert.equal((await f.store.execute('friend', poison)).reply, REFUSAL);
  assert.deepEqual(f.calls, []);
  await f.run('追问训练：Owner scene');
  for (const command of [{ type: 'end' }, { type: 'start', scene: 'Friend' }, { type: 'answer', text: 'Friend' }]) {
    assert.equal((await f.store.execute('friend', command)).reply, REFUSAL);
  }
  assert.equal(f.store.claimsAnswer('friend'), false);
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.equal(f.calls.length, 1);
});

test('end during question/evaluation discards late results and queued answers', async () => {
  for (const stage of ['next', 'evaluate']) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const f = fixture(stage === 'next' ? { next: async () => held } : { evaluate: async () => held });
    let running;
    if (stage === 'next') running = f.run('追问训练：Scene');
    else {
      await f.run('追问训练：Scene'); await f.run('One'); await f.run('Two');
      running = f.run('Three');
    }
    await flush();
    const queued = f.run('Queued answer');
    assert.match((await f.run('结束追问')).reply, /已结束/);
    assert.equal(f.store.claimsAnswer('owner'), false);
    release(stage === 'next' ? question(1) : evaluation);
    assert.equal(await running, null);
    assert.equal(await queued, null);
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
});

test('provider uses independent structured calls with no images, history session or external inputs', async () => {
  const calls = [];
  const provider = createFollowupDrillProvider({ model: async (...args) => {
    calls.push(args);
    return { ok: true, value: args[3].stage === 'followup_drill_question' ? question(1) : evaluation };
  } });
  const data = { scene: 'Synthetic scene', turns: [{ question: question(1).question, answer: 'My answer' }] };
  await provider.next({ ...data, round: 2 }); await provider.evaluate(data);
  for (const args of calls) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].schema.additionalProperties, false);
    assert.match(args[0], /仅为取材数据/);
    assert.match(args[0], /不检索 专业系统 资料、邮件、聊天记录或表达收藏夹/);
    assert.throws(() => args[3].parse('{}'));
  }
  assert.deepEqual(calls[1][3].parse(JSON.stringify(evaluation)), evaluation);
  for (const value of [{ ok: false }, { ok: true }, { ok: true, value: { question: '' } }]) {
    await assert.rejects(createFollowupDrillProvider({ model: async () => value }).next({ scene: 'Scene' }));
  }
});
