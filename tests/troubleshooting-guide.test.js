'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTroubleshootingGuideCommand: parse } = require('../src/troubleshooting-guide-commands');
const { createTroubleshootingGuideStore } = require('../src/troubleshooting-guide-store');
const { createTroubleshootingGuideProvider, validateStep } = require('../src/troubleshooting-guide-provider');
const steps = [
  { check: '查看网络图标', question: '网络图标是什么状态？' },
  { check: '查看应用提示', question: '应用显示什么提示？' },
  { check: '观察另一设备', question: '另一设备能否连接？' },
  { check: '查看路由器指示灯', question: '路由器指示灯是什么颜色？' },
  { check: '查看服务状态页', question: '状态页显示什么状态？' },
];
const summary = { likelyCause: '可能是网络连接异常', unconfirmed: '仍需确认网络服务是否恢复' };
function fixture(overrides = {}) {
  const calls = [];
  let index = 0;
  const provider = {
    next: async data => { calls.push(['next', structuredClone(data)]); return steps[index++]; },
    summarize: async data => { calls.push(['summary', structuredClone(data)]); return summary; },
    ...overrides,
  };
  const store = createTroubleshootingGuideStore({ provider });
  return { store, calls, run: (text, side = 'owner') => store.execute(side, parse(text, store.claimsAnswer(side))) };
}



test('opening needs symptom, accepts both aliases/colons, idle text passes', async () => {
  for (const text of ['帮我排查', '帮我排查： ', '排查一下', '排查一下:']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /<现象>/u);
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.deepEqual(f.calls, []);
  }
  for (const text of ['帮我排查：断网', '帮我排查:断网', '排查一下：断网', '排查一下:断网']) {
    const f = fixture();
    assert.match((await f.run(text)).reply, /第 1\/5 步/u);
    assert.equal(f.calls[0][1].symptom, '断网');
  }
  assert.equal(parse('普通文字'), null);
  assert.equal(parse(' ', true), null);
  assert.equal(parse('普通文字', {}), null);
});

test('friend rejected for all operations without model or owner-state changes', async () => {
  const f = fixture();
  for (const command of [{ type: 'start', symptom: '断网' }, { type: 'answer', text: '观察' }, { type: 'end' }]) {
    assert.match((await f.store.execute('friend', command)).reply, /只供已绑定的本人/u);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.claimsAnswer('friend'), false);
  await f.run('帮我排查：断网');
  await f.run('结束排查', 'friend');
  assert.equal(f.store.claimsAnswer('owner'), true);
});

test('records steps and verbatim observations, blocks overwrite, renders summary and clears', async () => {
  const f = fixture();
  await f.run('帮我排查：断网');
  assert.match((await f.run('排查一下：别的')).reply, /先发送“结束排查”/u);
  const observation = '  图标灰色\n刚发现  ';
  assert.match((await f.run(observation)).reply, /第 2\/5 步/u);
  assert.deepEqual(f.calls[1][1].tried, [{ ...steps[0], result: observation }]);
  const end = await f.run('结束排查');
  for (const label of ['诊断摘要', '现象：断网', '排查过程', '目前最可能的原因（模型判断，仅为推测）', '仍需确认的事项', '尚未反馈']) assert.ok(end.reply.includes(label));
  assert.ok(end.reply.includes(observation));
  assert.ok(end.reply.includes(steps[0].check));
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(parse('普通文字', f.store.claimsAnswer('owner')), null);
  assert.match((await f.run('结束排查')).reply, /没有进行中/u);
  await f.run('帮我排查：新现象');
  assert.deepEqual(f.calls.at(-1)[1].tried, []);
});

test('local containment rejects duplicate and retries once with tried/rejected context', async () => {
  const outputs = [steps[0], { ...steps[0], check: `请${steps[0].check}。` }, steps[1]];
  const data = [];
  const f = fixture({ next: async args => { data.push(structuredClone(args)); return outputs.shift(); } });
  await f.run('帮我排查：断网');
  const result = await f.run('灰色');
  assert.ok(result.reply.includes(steps[1].check));
  assert.equal(data.length, 3);
  assert.deepEqual(data[2].tried, [{ ...steps[0], result: '灰色' }]);
  assert.equal(data[2].rejected.length, 1);
});

test('two duplicate suggestions skipped, not counted or presented, retry preserves observation', async () => {
  const outputs = [steps[0], steps[0], { check: '查看网络', question: '网络图标是什么状态？' }, steps[1]];
  const f = fixture({ next: async () => outputs.shift() });
  await f.run('帮我排查：断网');
  assert.match((await f.run('灰色')).reply, /拦截并跳过.*未增加步数/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.match((await f.run('重试')).reply, /第 2\/5 步/u);
  await f.run('结束排查');
  assert.deepEqual(f.calls[0][1].tried, [{ ...steps[0], result: '灰色' }]);
});

test('fifth observation automatically summarizes, never generates a sixth step', async () => {
  const f = fixture();
  await f.run('帮我排查：断网');
  for (let i = 0; i < 4; i++) assert.match((await f.run(`结果${i}`)).reply, new RegExp(`第 ${i + 2}/5 步`, 'u'));
  assert.match((await f.run('结果4')).reply, /诊断摘要/u);
  assert.equal(f.calls.filter(c => c[0] === 'next').length, 5);
  assert.equal(f.calls.at(-1)[1].tried.length, 5);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('step failure retains session and recorded observation; retries do not double-count', async () => {
  let count = 0;
  const f = fixture({ next: async () => {
    count++;
    if (count === 1 || count === 3) throw Error('offline');
    return count === 2 ? steps[0] : steps[1];
  } });
  assert.match((await f.run('帮我排查：断网')).reply, /失败.*保留/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.match((await f.run('重试')).reply, /第 1\/5 步/u);
  assert.match((await f.run('灰色')).reply, /失败.*保留/u);
  assert.match((await f.run('重试')).reply, /第 2\/5 步/u);
  await f.run('结束排查');
  assert.deepEqual(f.calls[0][1].tried, [{ ...steps[0], result: '灰色' }]);
});

test('summary failure at limit retains all five results and retries summary only', async () => {
  let fail = true;
  const f = fixture({ summarize: async data => {
    assert.equal(data.tried.length, 5);
    if (fail) { fail = false; throw Error('offline'); }
    return summary;
  } });
  await f.run('帮我排查：断网');
  for (let i = 0; i < 4; i++) await f.run('结果');
  assert.match((await f.run('第五步结果')).reply, /摘要生成失败.*保留/u);
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.match((await f.run('结束排查')).reply, /诊断摘要/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(f.calls.length, 5);
});

test('queued opening claims answers immediately, serializes starts and early end', async () => {
  const f = fixture();
  const a = f.run('帮我排查：断网');
  assert.equal(f.store.claimsAnswer('owner'), true);
  const b = f.run('排查一下：覆盖');
  const c = f.run('结束排查');
  assert.match((await a).reply, /第 1/u);
  assert.match((await b).reply, /不会覆盖/u);
  assert.match((await c).reply, /尚未反馈/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('provider uses isolated structured model, one check/question, rejects malformed/failing output', async () => {
  const calls = [];
  const p = createTroubleshootingGuideProvider({ model: async (...args) => {
    calls.push(args);
    return { ok: true, value: args[3].parse(JSON.stringify(calls.length === 1 ? steps[0] : summary)) };
  } });
  await p.next({ symptom: '断网', tried: [] }); await p.summarize({ symptom: '断网', tried: [] });
  for (const args of calls) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].schema.additionalProperties, false);
    assert.match(args[0], /绝不执行系统命令或调用工具/u);
    assert.throws(() => args[3].parse('{}'));
  }
  for (const step of [{ ...steps[0], question: '甲？乙？' }, { ...steps[0], check: '做什么？' }, { ...steps[0], question: '' }]) assert.throws(() => validateStep(step));
  for (const result of [{ ok: false }, { ok: true }, { ok: true, value: {} }]) await assert.rejects(createTroubleshootingGuideProvider({ model: async () => result }).next({}));
});
