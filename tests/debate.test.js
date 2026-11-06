'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDebateCommand: parse } = require('../src/debate-commands');
const { createDebateProvider, debateReply } = require('../src/debate-provider');
const valid = () => ({ support: '候选一可能更灵活。', opposition: '候选二可能更稳妥。',
  leaning: '若更看重稳定，暂倾向候选二。', reconsider: '缺少合同期限；若候选二仅为短期合同，会重新评估。' });



test('recognizes explicit prefix/suffix, separators and optional preference without guessing', () => {
  for (const [text, options, preference = ''] of [
    ['辩论一下：买 A 还是 B', ['买 A', 'B']],
    ['纠结买车还是租房，辩论一下', ['买车', '租房']],
    ['辩论赛：去大厂 还是 去小公司，我更看重稳定', ['去大厂', '去小公司'], '稳定'],
    ['辩论一下: 买车或者租房', ['买车', '租房']],
    ['辩论赛：A VS B 我更看重时间。', ['A', 'B'], '时间'],
    ['A vs B，辩论一下', ['A', 'B']],
  ]) assert.deepEqual(parse(text), { type: 'debate', options, preference }, text);
  for (const text of ['辩论一下', '辩论赛：', '辩论一下：买车', '纠结买车，辩论一下',
    '辩论一下：A还是', '辩论赛：还是B', '辩论赛：A还是B或者C', '辩论赛：A还是A',
    '辩论赛：A还是B，我更看重']) assert.deepEqual(parse(text), { type: 'invalid' }, text);
  for (const text of ['买车还是租房', '今天的辩论赛很有趣', '请解释辩论一下是什么意思', 'A或者B']) {
    assert.equal(parse(text), null, text);
  }
});

test('provider performs exactly one fresh schema-constrained model call and validates the transport parser', async () => {
  const calls = [];
  const provider = createDebateProvider({ model: async (...args) => {
    calls.push(args);
    return { ok: true, value: args[3].parse(JSON.stringify(valid())) };
  } });
  assert.deepEqual(await provider.generate({ options: ['大厂', '小公司'], preference: '稳定' }), valid());
  assert.equal(calls.length, 1);
  const [prompt, session, images, config] = calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []);
  assert.match(prompt, /稳定/u); assert.match(prompt, /缺.*关键条件/u);
  assert.equal(config.stage, 'debate_generate');
  assert.equal(config.schema.additionalProperties, false);
  assert.deepEqual(config.schema.required, ['support', 'opposition', 'leaning', 'reconsider']);
  for (const text of ['not JSON', '```json\n{}\n```', '{}', JSON.stringify({ ...valid(), reconsider: '' })]) {
    assert.throws(() => config.parse(text));
  }
});

test('provider rejects missing, blank, wrongly typed and extra sections even when an injected model bypasses parser', async () => {
  const missing = valid(); delete missing.reconsider;
  for (const value of [undefined, null, 'not JSON', [], {}, missing,
    ...Object.keys(valid()).map(key => ({ ...valid(), [key]: '  \n' })),
    { ...valid(), leaning: [] }, { ...valid(), extra: 'extra' }]) {
    let calls = 0;
    const provider = createDebateProvider({ model: async () => { calls++; return { ok: true, value }; } });
    await assert.rejects(provider.generate({ options: ['A', 'B'], preference: '' }));
    assert.equal(calls, 1);
  }
  await assert.rejects(createDebateProvider({ model: async () => ({ ok: false }) })
    .generate({ options: ['A', 'B'], preference: '' }));
});

test('reply assembles four sections with candidate labels and AI caveat using mock provider; malformed output is wholly discarded', async () => {
  const command = parse('辩论赛：大厂还是小公司，我更看重稳定');
  let calls = 0;
  const reply = await debateReply(command, { generate: async args => {
    calls++; assert.deepEqual(args, { options: ['大厂', '小公司'], preference: '稳定' }); return valid();
  } });
  assert.equal(calls, 1);
  assert.match(reply, /支持方理由（大厂）/u); assert.match(reply, /反对方理由（小公司）/u);
  assert.match(reply, /按偏好给出的倾向/u); assert.match(reply, /缺什么条件会改判/u);
  assert.match(reply, /观点整理，不是事实断言/u);
  assert.match(reply, /由模型归纳.*倾向仅供参考.*决定在你本人/u);
  for (const generate of [async () => ({ support: '残缺内容' }), async () => { throw Error('offline'); }]) {
    const failure = await debateReply(command, { generate });
    assert.match(failure, /整次作废/u); assert.doesNotMatch(failure, /残缺内容|支持方理由/u);
  }
  const clarification = await debateReply(parse('辩论一下：只有一个'), { generate: () => assert.fail('must not call model') });
  assert.match(clarification, /X 还是 Y/u);
});
