'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpinionChallengeCommand: parse } = require('../src/opinion-challenge-commands');
const { createOpinionChallengeProvider, opinionChallengeReply } = require('../src/opinion-challenge-provider');

const valid = () => ({ restatement: '远程办公总能提高效率。', counterexample: '假设跨时区协作导致等待时间增加。',
  evidenceWeakness: '未提供支持证据，尚不能判断样本是否有代表性。', verification: '试行一周，比较任务交付时间；缩短支持该观点，延长则削弱。' });



test('provider makes exactly one fresh schema-constrained model call with bounded instructions', async () => {
  const calls = [];
  const provider = createOpinionChallengeProvider({ model: async (...args) => {
    calls.push(args); return { ok: true, value: args[3].parse(JSON.stringify(valid())) };
  } });
  assert.deepEqual(await provider.generate({ opinion: '远程办公总能提高效率' }), valid());
  assert.equal(calls.length, 1);
  const [prompt, session, images, config] = calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []);
  assert.equal(config.stage, 'opinion_challenge_generate');
  assert.equal(config.schema.additionalProperties, false);
  assert.deepEqual(config.schema.required, Object.keys(valid()));
  for (const pattern of [/单个观点/u, /不做开放式多轮追问/u, /不替主人下结论说观点一定错/u, /未提供证据须明说/u, /不调用工具/u]) assert.match(prompt, pattern);
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)), { opinion: '远程办公总能提高效率' });
  for (const text of ['not JSON', '```json\n{}\n```', '{}', JSON.stringify({ ...valid(), verification: '' })]) assert.throws(() => config.parse(text));
});

test('provider rejects missing, blank, wrongly typed and extra sections even if transport bypasses parser', async () => {
  const missing = valid(); delete missing.verification;
  for (const value of [undefined, null, 'not JSON', [], {}, missing,
    ...Object.keys(valid()).map(key => ({ ...valid(), [key]: ' \n' })),
    { ...valid(), verification: [] }, { ...valid(), extra: 'extra' }]) {
    let calls = 0;
    const provider = createOpinionChallengeProvider({ model: async () => { calls++; return { ok: true, value }; } });
    await assert.rejects(provider.generate({ opinion: '观点' })); assert.equal(calls, 1);
  }
});

test('reply has four fixed ordered sections and does not declare the opinion wrong', async () => {
  let calls = 0;
  const reply = await opinionChallengeReply(parse('挑战一下这个观点：远程办公总能提高效率'), { generate: async args => {
    calls++; assert.deepEqual(args, { opinion: '远程办公总能提高效率' }); return valid();
  } });
  assert.equal(calls, 1);
  const titles = ['观点重述', '最强反例', '支持证据的薄弱点', '低成本验证法'];
  let previous = -1;
  for (const title of titles) { const index = reply.indexOf(title + '\n'); assert.ok(index > previous); previous = index; }
  for (const content of Object.values(valid())) assert.ok(reply.includes(content));
  assert.match(reply, /并不代表原观点一定错/u);
});

test('model failure and partial output produce only explicit failure without retry or draft', async () => {
  for (const model of [async () => { throw Error('private diagnostic'); },
    async () => ({ ok: false, value: valid() }), async () => ({ ok: true, value: { restatement: '残缺观点正文' } })]) {
    let calls = 0;
    const provider = createOpinionChallengeProvider({ model: async (...args) => { calls++; return model(...args); } });
    const reply = await opinionChallengeReply(parse('挑战一下这个观点：观点'), provider);
    assert.equal(calls, 1); assert.match(reply, /生成失败.*整次作废/u);
    assert.doesNotMatch(reply, /残缺观点正文|private diagnostic|观点重述|最强反例/u);
  }
  const reply = await opinionChallengeReply(parse('挑战一下这个观点：观点'), { generate: async () => ({ restatement: '残缺观点正文' }) });
  assert.match(reply, /生成失败/u); assert.doesNotMatch(reply, /残缺观点正文/u);
});
