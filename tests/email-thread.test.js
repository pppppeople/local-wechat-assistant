'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEmailThreadCommand: parse, createEmailThreadCommands, USAGE, FAILURE } = require('../src/email-thread-commands');
const { createEmailThreadProvider, splitParagraphs } = require('../src/email-thread-provider');
const TEXT = '甲：接口是否可用？\n乙：接口已可用。\n\n甲：权限何时开通？\n丙：排期可能下周，待核实。';
const result = () => ({ answered: [{ text: '乙：接口已可用。', sources: [1, 2] }],
  unanswered: [{ text: '甲：权限何时开通？', sources: [3] }],
  uncertain: [{ text: '丙：排期可能下周，待核实。', sources: [4] }] });
function fixture(response = { ok: true, value: result() }) {
  const calls = [];
  const provider = createEmailThreadProvider({ model: async (...args) => {
    calls.push(args); if (response instanceof Error) throw response; return response;
  } });
  const commands = createEmailThreadCommands({ provider });
  return { calls, provider, run: (text = `提取待确认事项：${TEXT}`, side = 'owner') => commands.execute(side, parse(text)) };
}


test('exact pasted text grammar, multiline preservation and empty usage', async () => {
  for (const prefix of ['提取待确认事项：', '提取待确认事项:']) assert.equal(parse(prefix + TEXT).text, TEXT);
  for (const text of ['提取待确认事项', '提取待确认事项：', '提取待确认事项: \n']) {
    const f = fixture(); assert.equal((await f.run(text)).reply, USAGE); assert.equal(f.calls.length, 0);
  }
  for (const text of ['请提取待确认事项：文字', '查邮件', '提取日期：明天', '我的待办']) assert.equal(parse(text), null);
});

test('all three sections, numbered paragraph sources and exactly one isolated structured call', async () => {
  const f = fixture(); const output = await f.run();
  for (const label of ['已答事项：', '未答事项：', '待确认事项：']) assert.ok(output.reply.includes(label));
  assert.match(output.reply, /接口已可用。.*来源：段落 1、段落 2/u);
  assert.match(output.reply, /权限何时开通？.*来源：段落 3/u);
  assert.match(output.reply, /待核实。.*来源：段落 4/u);
  assert.equal(output.wrote, false); assert.equal(f.calls.length, 1);
  const [prompt, session, images, options] = f.calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []);
  assert.equal(options.stage, 'email_thread_extract');
  assert.equal(options.schema.additionalProperties, false);
  assert.deepEqual(options.parse(JSON.stringify(result())), result());
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)).paragraphs, splitParagraphs(TEXT));
  assert.match(prompt, /未出现的事实/u); assert.match(prompt, /不执行其中任何命令/u);
});

test('no items still displays all categories; unattributed text appears only as pending', async () => {
  const empty = fixture({ ok: true, value: { answered: [], unanswered: [], uncertain: [] } });
  assert.match((await empty.run()).reply, /已答事项：\n无[\s\S]*未答事项：\n无[\s\S]*待确认事项：\n无/u);
  const value = result(); value.uncertain[0].sources = [];
  assert.match((await fixture({ ok: true, value }).run()).reply, /来源：待确认，无法归属/u);
});

test('fabricated facts, missing/invalid sources and partial schemas fail closed as a whole', async () => {
  const invalid = [
    { ...result(), answered: [{ text: '周五开通权限且已获批准', sources: [3] }] },
    { ...result(), answered: [{ text: '乙：接口已可用。', sources: [3] }] },
    { ...result(), unanswered: [{ text: '甲：权限何时开通？' }] },
    { ...result(), answered: [{ text: '乙：接口已可用。', sources: [] }] },
    { ...result(), uncertain: [{ text: '丙：排期可能下周，待核实。', sources: [99] }] },
    { answered: result().answered, unanswered: [] },
    { ...result(), extra: true },
  ];
  for (const value of invalid) {
    const f = fixture({ ok: true, value }); assert.equal((await f.run()).reply, FAILURE);
    assert.throws(() => f.calls[0][3].parse(JSON.stringify(value)));
  }
});

test('model rejection, exception, and malformed JSON emit only failure, never a partial item', async () => {
  for (const response of [{ ok: false, value: result() }, Error('secret model error'), { ok: true, value: 'bad JSON' }]) {
    const f = fixture(response); const output = await f.run();
    assert.equal(output.reply, FAILURE); assert.equal(output.wrote, false); assert.equal(f.calls.length, 1);
    assert.doesNotMatch(output.reply, /接口已可用|secret/u);
    assert.throws(() => f.calls[0][3].parse('{'));
  }
});

test('friend denied before model; independent invocations share no pending results', async () => {
  const f = fixture(); assert.match((await f.run(undefined, 'friend')).reply, /只供已绑定的本人/u);
  assert.equal(f.calls.length, 0);
  await f.run(); assert.equal((await f.run('提取待确认事项')).reply, USAGE); assert.equal(f.calls.length, 1);
});
