'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMeetingSimulatorCommand: parse } = require('../src/meeting-simulator-commands');
const { createMeetingSimulatorStore } = require('../src/meeting-simulator-store');
const { createMeetingSimulatorProvider } = require('../src/meeting-simulator-provider');
const opening = { role: '专业系统 support specialist', question: 'Which IAS tenant are you using?', practice: '本轮练习说明问题背景。' };
const feedback = { question: 'Could you clarify your request?', advice: '可以说 “Could you confirm the login URL?”，请求更自然。' };
const summary = data => ({ issues: data.turns.length ? ['请求语气可以更委婉'] : [],
  comparisons: data.turns.map(turn => ({ original: turn.answer, suggested: 'Could you confirm the login URL?' })) });
function fixture(overrides = {}) {
  const calls = [];
  const provider = {
    open: async data => { calls.push(['open', data]); return { ...opening }; },
    turn: async data => { calls.push(['turn', data]); return { ...feedback, question: data.final ? '' : feedback.question }; },
    summarize: async data => { calls.push(['summary', data]); return summary(data); },
    ...overrides,
  };
  const store = createMeetingSimulatorStore({ provider });
  return { calls, store, run: (text, side = 'owner') => store.execute(side, parse(text, store.claimsAnswer(side))) };
}



test('opening requires a scene; both aliases and colon widths; no idle text capture', async () => {
  for (const text of ['模拟会议', '模拟会议：', '模拟英文会议', '模拟英文会议:  ']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /<场景>/u);
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.deepEqual(f.calls, []);
  }
  for (const text of ['模拟会议：询问登录地址', '模拟英文会议: 询问登录地址']) {
    const f = fixture();
    const result = await f.run(text);
    assert.match(result.reply, /对方角色：专业系统 support specialist/u);
    assert.ok(result.reply.includes(opening.question));
    assert.match(result.reply, /本轮练习：本轮练习说明问题背景/u);
    assert.deepEqual(f.calls, [['open', { scene: '询问登录地址' }]]);
    assert.equal(f.store.claimsAnswer('owner'), true);
  }
  assert.equal(parse('普通聊天'), null);
  assert.equal(parse('  ', true), null);
  assert.deepEqual(parse('  My tenant 是测试环境  ', true), { type: 'answer', text: '  My tenant 是测试环境  ' });
});

test('friend rejected for all operations and cannot end owner session', async () => {
  const f = fixture();
  for (const command of [{ type: 'start', scene: 'test' }, { type: 'answer', text: 'Hi' }, { type: 'end' }]) {
    assert.match((await f.store.execute('friend', command)).reply, /只供已绑定的本人/u);
  }
  assert.deepEqual(f.calls, []);
  await f.run('模拟会议：原场景');
  await f.run('结束模拟', 'friend');
  assert.equal(f.store.claimsAnswer('friend'), false);
  assert.equal(f.store.claimsAnswer('owner'), true);
});

test('five owner rounds carry role and history; fifth automatically summarizes without question and clears', async () => {
  const f = fixture();
  await f.run('模拟会议：询问 IAS 地址');
  for (let i = 1; i <= 5; i++) {
    const result = await f.run(`Answer ${i} 这是我的回答`);
    const call = f.calls.filter(item => item[0] === 'turn').at(-1)[1];
    assert.equal(call.role, opening.role);
    assert.equal(call.turns.length, i - 1);
    assert.equal(call.answer, `Answer ${i} 这是我的回答`);
    assert.equal(call.final, i === 5);
    if (i < 5) {
      assert.ok(result.reply.startsWith(feedback.question));
      assert.ok(result.reply.endsWith(feedback.advice));
      assert.equal(f.store.claimsAnswer('owner'), true);
    } else {
      assert.match(result.reply, /本场场景：询问 IAS 地址/u);
      assert.match(result.reply, /常见表达问题清单：\n- 请求语气/u);
      assert.match(result.reply, /建议说法对照（原句→建议句）：/u);
      assert.equal((result.reply.match(/ → /gu) || []).length, 5);
      assert.ok(!result.reply.includes(feedback.question));
      assert.equal(f.store.claimsAnswer('owner'), false);
    }
  }
  assert.equal(f.calls.at(-1)[1].turns.length, 5);
  assert.equal(parse('Sixth answer', f.store.claimsAnswer('owner')), null);
});

test('end summarizes early with original to suggestion and clears; empty session has empty summary', async () => {
  const f = fixture();
  await f.run('模拟会议：场景');
  await f.run('Give me URL');
  const result = await f.run('结束模拟');
  assert.match(result.reply, /Give me URL → Could you confirm/u);
  assert.match(result.reply, /临时状态已清除/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.match((await f.run('结束模拟')).reply, /没有进行中/u);
  await f.run('模拟会议：新场景');
  const empty = await f.run('结束模拟');
  assert.match(empty.reply, /常见表达问题清单：\n暂无/u);
  assert.match(empty.reply, /建议说法对照（原句→建议句）：\n暂无/u);
  assert.deepEqual(f.calls.at(-1)[1].turns, []);
  assert.equal(fixture().store.claimsAnswer('owner'), false);
});

test('duplicate opening blocked and concurrent starts serialize without overwriting scene', async () => {
  const f = fixture();
  const results = await Promise.all([f.run('模拟会议：原场景'), f.run('模拟英文会议：覆盖')]);
  assert.equal(results[0].wrote, true);
  assert.match(results[1].reply, /先发送“结束模拟”/u);
  await f.run('My answer');
  assert.match((await f.run('模拟会议：覆盖')).reply, /先发送“结束模拟”/u);
  assert.equal(f.calls.length, 2);
  assert.match((await f.run('结束模拟')).reply, /本场场景：原场景/u);
});

test('opening model failure retains scene for text retry or end, never invents a question', async () => {
  for (const fail of [() => { throw Error('offline'); }, () => undefined, () => ({ ...opening, question: '中文？' })]) {
    let first = true;
    const f = fixture({ open: async data => {
      assert.equal(data.scene, '场景');
      if (first) { first = false; return fail(); }
      return opening;
    } });
    assert.match((await f.run('模拟会议：场景')).reply, /模型开场失败.*保留/u);
    assert.equal(f.store.claimsAnswer('owner'), true);
    assert.match((await f.run('模拟会议：覆盖')).reply, /先发送/u);
    assert.ok((await f.run('重试')).reply.includes(opening.question));
    await f.run('结束模拟');
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
  const f = fixture({ open: async () => { throw Error('offline'); } });
  await f.run('模拟会议：场景');
  assert.match((await f.run('结束模拟')).reply, /本场场景：场景/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('turn model failure retains session and does not increment or insert invented dialogue', async () => {
  let failed = true;
  const f = fixture({ turn: async data => {
    if (failed) throw Error('offline');
    assert.equal(data.turns.length, 0);
    return feedback;
  } });
  await f.run('模拟会议：场景');
  assert.match((await f.run('My answer')).reply, /模型追问失败.*保留.*轮次未增加/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  failed = false;
  await f.run('My answer');
  await f.run('结束模拟');
  assert.equal(f.calls.at(-1)[1].turns.length, 1);
});

test('ending after a failed turn still summarizes the retained owner original', async () => {
  const f = fixture({ turn: async () => { throw Error('offline'); } });
  await f.run('模拟会议：场景');
  await f.run('My retained answer');
  const result = await f.run('结束模拟');
  assert.match(result.reply, /My retained answer →/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('summary failure retains all five rounds and retry cannot accept sixth answer or duplicate fifth', async () => {
  let failed = true;
  const received = [];
  const f = fixture({ summarize: async data => {
    received.push(data);
    if (failed) throw Error('offline');
    return summary(data);
  } });
  await f.run('模拟会议：场景');
  for (let i = 1; i < 5; i++) await f.run(`Answer ${i}`);
  assert.match((await f.run('Answer 5')).reply, /模型总结失败.*保留/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.match((await f.run('模拟会议：覆盖')).reply, /先发送/u);
  failed = false;
  assert.match((await f.run('结束模拟')).reply, /模拟已结束/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.deepEqual(received[1], received[0]);
  assert.equal(received[1].turns.length, 5);
  assert.equal(f.calls.filter(call => call[0] === 'turn').length, 5);
});

test('manual end failure retains active session for a second end', async () => {
  let failed = true;
  const f = fixture({ summarize: async data => {
    if (failed) throw Error('offline');
    return summary(data);
  } });
  await f.run('模拟会议：场景');
  assert.match((await f.run('结束模拟')).reply, /失败.*保留/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  failed = false;
  await f.run('结束模拟');
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('provider reuses fresh structured model channel with roleplay data, no images or ordinary session', async () => {
  const calls = [];
  const data = { scene: '场景', role: opening.role, turns: [{ question: opening.question, answer: 'URL please', advice: feedback.advice }] };
  const provider = createMeetingSimulatorProvider({ model: async (...args) => {
    calls.push(args);
    const stage = args[3].stage;
    return { ok: true, value: stage.endsWith('_open') ? opening : stage.endsWith('_turn') ? feedback : summary(data) };
  } });
  await provider.open({ scene: '场景' });
  await provider.turn({ ...data, answer: 'Please', final: false });
  await provider.summarize(data);
  for (const args of calls) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].schema.additionalProperties, false);
    assert.match(args[0], /仅为取材数据/u);
    assert.match(args[0], /不打分/u);
    assert.throws(() => args[3].parse('{}'));
  }
  assert.deepEqual(calls[0][3].parse(JSON.stringify(opening)), opening);
  assert.throws(() => calls[2][3].parse(JSON.stringify({ issues: [], comparisons: [{ original: 'invented', suggested: 'Please' }] })));
  assert.throws(() => calls[2][3].parse(JSON.stringify({ issues: [], comparisons: Array(6).fill({ original: 'URL please', suggested: 'Please' }) })));
  for (const value of [{ ok: false }, { ok: true }, { ok: true, value: { ...opening, extra: 'bad' } }]) {
    await assert.rejects(createMeetingSimulatorProvider({ model: async () => value }).open({ scene: '场景' }));
  }
});

test('malformed turn and summary output fail closed and retain session', async () => {
  const f = fixture({ turn: async () => ({ question: '中文问题？', advice: '建议' }) });
  await f.run('模拟会议：场景');
  assert.match((await f.run('Hello')).reply, /模型追问失败/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  const g = fixture({ summarize: async () => ({ issues: ['问题'], comparisons: [{ original: '编造', suggested: 'Please' }] }) });
  await g.run('模拟会议：场景'); await g.run('Hello');
  assert.match((await g.run('结束模拟')).reply, /模型总结失败/u);
  assert.equal(g.store.claimsAnswer('owner'), true);
});
