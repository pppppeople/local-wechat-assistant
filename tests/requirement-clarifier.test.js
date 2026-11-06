'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequirementClarifierCommand: parse } = require('../src/requirement-clarifier-commands');
const { createRequirementClarifierStore } = require('../src/requirement-clarifier-store');
const { QUESTIONS, SECTIONS, renderDocument, createRequirementClarifierProvider } = require('../src/requirement-clarifier-provider');
const empty = () => Object.fromEntries(SECTIONS.map(key => [key, []]));
const item = (source, quote, confirmed = true) => ({ source, quote, confirmed });
function fixture(summarize = async () => empty()) {
  const calls = [];
  const store = createRequirementClarifierStore({ provider: { summarize: async data => {
    calls.push(structuredClone(data)); return summarize(data);
  } } });
  return { store, calls, run: (text, side = 'owner') => store.execute(side, parse(text, store.claimsAnswer(side))) };
}
async function fill(f, answers = ['本人', '每天上班时', '展示当日待办', '不自动发送']) {
  await f.run('澄清需求：展示待办');
  let result;
  for (const answer of answers) result = await f.run(answer);
  return result;
}



test('start aliases need requirement; inactive ordinary messages and nonboolean active pass through', async () => {
  const f = fixture();
  for (const text of ['澄清需求：', '帮我澄清这个需求:', '澄清需求', '帮我澄清这个需求']) {
    assert.match((await f.run(text)).reply, /请发送/u);
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
  assert.deepEqual(parse('帮我澄清这个需求: 展示待办'), { type: 'start', requirement: '展示待办' });
  assert.equal(parse('普通聊天'), null);
  assert.equal(parse('跳过', { active: true }), null);
  assert.deepEqual(parse('  保留\n原文  ', true), { type: 'answer', answer: '  保留\n原文  ' });
  assert.equal(f.calls.length, 0);
});

test('friends refused before state or models, cannot end owner session', async () => {
  const f = fixture();
  for (const text of ['澄清需求：展示待办', '结束澄清', '跳过', '重试']) {
    assert.match((await f.run(text, 'friend')).reply, /只供已绑定的本人/u);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.claimsAnswer('friend'), false);
  await f.run('澄清需求：展示待办');
  await f.run('结束澄清', 'friend');
  assert.equal(f.store.claimsAnswer('owner'), true);
});

test('fixed four questions, skip pending, verbatim answer, one model only after final answer', async () => {
  const f = fixture();
  let response = await f.run('澄清需求：展示待办');
  const answers = ['  本人\n自己  ', '跳过', '展示当天未完成事项', '还不清楚'];
  for (let i = 0; i < 4; i++) {
    assert.match(response.reply, new RegExp(`第 ${i + 1}/4 问`, 'u'));
    assert.ok(response.reply.includes(QUESTIONS[i]));
    assert.equal(f.calls.length, 0);
    response = await f.run(answers[i]);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].requirement, '展示待办');
  assert.deepEqual(f.calls[0].questions, QUESTIONS);
  assert.deepEqual(f.calls[0].answers, [
    { status: 'answered', text: answers[0] }, { status: 'pending', text: '' },
    { status: 'answered', text: answers[2] }, { status: 'pending', text: answers[3] },
  ]);
  assert.deepEqual(response.reply.split('\n\n').map(section => section.split('\n')[0]), SECTIONS);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(await f.run('普通聊天'), null);
});

test('local six-section renderer fences mixed model content and fills empty sections', async () => {
  const f = fixture(() => ({ ...empty(),
    业务场景: [item(1, '本人')],
    前置条件: [item(2, '每天定时触发')], // Invented from skipped answer.
    操作流程: [item(3, '也许自动创建任务')], // Unclear original marked confirmed by model.
    异常情况: [item(4, '失败就重试'), item(4, '失败就重试', false)],
    验收标准: [item(0, '成功率百分之百')],
  }));
  const result = await fill(f, ['本人', '跳过', '也许自动创建任务', '失败就重试']);
  const [confirmed, pending] = result.reply.split('\n\n待确认\n');
  assert.match(confirmed, /业务场景\n- 目标用户是谁？："本人"/u);
  assert.match(confirmed, /前置条件\n待确认/u);
  assert.match(confirmed, /操作流程\n待确认/u);
  assert.match(confirmed, /异常情况\n待确认/u);
  assert.match(confirmed, /验收标准\n待确认/u);
  for (const value of ['每天定时触发', '也许自动创建任务', '失败就重试', '成功率百分之百']) {
    assert.ok(!confirmed.includes(value)); assert.ok(pending.includes(value));
  }
  assert.match(pending, /什么情况下触发\/使用？：待确认（已跳过）/u);
});

test('all skipped answers remain pending even if model omits pending section content', async () => {
  const f = fixture();
  const result = await fill(f, Array(4).fill('跳过'));
  const pending = result.reply.split('\n\n待确认\n')[1];
  for (const question of QUESTIONS) assert.ok(pending.includes(question));
  assert.equal((pending.match(/已跳过/gu) || []).length, 4);
});

test('confirmed original statements can populate the fixed sections without invented prose', async () => {
  const f = fixture(data => ({ ...empty(),
    业务场景: [item(0, data.requirement), item(1, data.answers[0].text)],
    前置条件: [item(2, data.answers[1].text)],
    操作流程: [item(3, data.answers[2].text)],
    异常情况: [item(4, data.answers[3].text)],
    验收标准: [item(3, data.answers[2].text)],
  }));
  const result = await fill(f);
  const sections = result.reply.split('\n\n');
  assert.deepEqual(sections.map(section => section.split('\n')[0]), SECTIONS);
  for (const section of sections.slice(0, 5)) assert.match(section, /\n- /u);
  assert.equal(sections[5], '待确认\n待确认');
});

test('unsupported partial quotations cannot strip uncertainty from original', () => {
  const data = { requirement: '可能展示待办', answers: Array.from({ length: 4 }, () => ({ status: 'pending', text: '' })) };
  const result = renderDocument({ ...empty(), 操作流程: [item(0, '展示待办')] }, data);
  assert.match(result, /操作流程\n待确认/u);
  assert.match(result, /待确认\n[\s\S]*模型整理未获原文支持/u);
});

test('end clears without document; repeated starts do not replace original, including concurrent start', async () => {
  const f = fixture();
  const first = f.run('澄清需求：原始需求');
  assert.equal(f.store.claimsAnswer('owner'), true);
  assert.match((await f.run('澄清需求：覆盖需求')).reply, /先「结束澄清」/u);
  await first;
  assert.match((await f.run('帮我澄清这个需求：另一个需求')).reply, /已有进行中/u);
  assert.match((await f.run('结束澄清')).reply, /状态已清除，未产出文档/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(f.calls.length, 0);
  await fill(f);
  assert.equal(f.calls[0].requirement, '展示待办');
});

test('empty answer repeats question; retry before completion cannot advance', async () => {
  const f = fixture();
  await f.run('澄清需求：展示待办');
  assert.match((await f.run('   ')).reply, /第 1\/4 问/u);
  assert.match((await f.run('重试')).reply, /第 1\/4 问/u);
  assert.equal(f.calls.length, 0);
});

test('model failure and malformed output keep exact session for explicit retry or end', async () => {
  for (const bad of [() => { throw Error('offline'); }, () => ({}), () => ({ ...empty(), 业务场景: '错误结构' })]) {
    let fail = true;
    const f = fixture(data => fail ? bad() : { ...empty(), 业务场景: [item(1, data.answers[0].text)] });
    const result = await fill(f);
    assert.match(result.reply, /生成失败.*会话已保留/u);
    assert.equal(f.store.claimsAnswer('owner'), true);
    assert.match((await f.run('不能当作第五问')).reply, /回复「重试」/u);
    assert.equal(f.calls.length, 1);
    fail = false;
    assert.match((await f.run('重试')).reply, /^业务场景\n/u);
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
  const f = fixture(() => { throw Error('offline'); });
  await fill(f);
  await f.run('结束澄清');
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('end immediately invalidates in-flight generation, queued answers and late document', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  await f.run('澄清需求：需求');
  for (let i = 0; i < 3; i++) await f.run('跳过');
  const generating = f.run('跳过');
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.run('执行：不要执行');
  assert.match((await f.run('结束澄清')).reply, /已结束澄清/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  release(empty());
  assert.equal(await generating, null);
  assert.equal(await queued, null);
  assert.match((await f.run('澄清需求：新需求')).reply, /第 1\/4 问/u);
});

test('end invalidates an admitted but not yet applied start immediately', async () => {
  const f = fixture();
  const first = f.run('澄清需求：旧需求');
  await f.run('结束澄清');
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(await first, null);
  assert.match((await f.run('澄清需求：新需求')).reply, /第 1\/4 问/u);
  assert.equal(f.calls.length, 0);
});
