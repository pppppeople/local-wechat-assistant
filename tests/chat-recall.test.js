'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseChatRecallCommand: parse } = require('../src/chat-recall-commands');
const { searchChatRecall: search, formatChatRecall: format, recallChat } = require('../src/chat-recall');



test('recall recognition and keyword extraction stay narrow', () => {
  for (const [text, keyword] of [
    ['找回：签证材料', '签证材料'], ['找回预算', '预算'], ['找回: IAS 登录', 'IAS 登录'],
    ['我上次说的那个 IAS 登录问题是什么来着', 'IAS 登录问题'],
    ['我之前说的签证材料是什么？', '签证材料'], ['我上次提过的预算是什么来着？', '预算'],
    ['我之前提过预算的事吗', '预算'], ['上次那个签证材料是什么', '签证材料'],
    ['之前那个登录问题是什么来着？', '登录问题'], ['找回：', ''], ['我之前说的是什么', ''],
  ]) assert.deepEqual(parse(text), { type: 'recall', keyword }, text);
  for (const text of ['IAS 登录是什么', '我之前说的预算不对', '你记得我吗', '我上次说的方案怎么配置',
    '记一下，我之前提过预算的事吗', '把我上次说的预算记成待办', '找回密码怎么操作',
    '我上次提过预算，帮我发邮件', '找回：预算；再记成待办', '他说我之前提过预算的事吗',
    '我上次说的那个 IAS 登录问题是什么原因', '我之前提过预算的事吗，顺便查邮件']) assert.equal(parse(text), null, text);
});

test('ranking: full phrase, distinct token hits, recency, stable turn and role ties; cap and no repeated message', () => {
  const turns = [
    { at: '2026-10-01T00:00:00Z', user: 'IAS 登录完整', assistant: '' },
    { at: '2026-10-30T00:00:00Z', user: '登录和 ias 分开', assistant: '' },
    { at: '2026-10-31T00:00:00Z', user: 'IAS IAS IAS', assistant: '' },
    { at: '2026-10-02T00:00:00Z', user: 'IAS 登录较新', assistant: 'IAS 登录建议' },
    { at: '2026-10-03T00:00:00Z', user: 'IAS 登录最新', assistant: '' },
  ];
  const rows = search(turns, 'IAS 登录');
  assert.deepEqual(rows.map(r => r.text), ['IAS 登录最新', 'IAS 登录较新', 'IAS 登录建议', 'IAS 登录完整', '登录和 ias 分开']);
  assert.equal(new Set(rows.map(r => `${r.index}:${r.speaker}`)).size, 5);
  assert.equal(search(turns, 'IAS IAS')[0].hits, 1);
  assert.deepEqual(search(turns, ''), []);
  assert.deepEqual(search(turns, '签证'), []);
});

test('quotes retain original text, mark Shanghai time and speaker, truncate and handle missing times', () => {
  const reply = format(search([{ at: '2026-10-30T20:05:06Z', user: '签证 原文\n第二行', assistant: '签证建议' }], '签证'));
  assert.match(reply, /2026-10-31 04:05:06｜主人\n「签证 原文\n第二行」/u);
  assert.match(reply, /｜助手\n「签证建议」/u);
  assert.match(format(search([{ user: '签证' + '长'.repeat(300) }], '签证')), /时间未知｜主人\n「签证长+…」/u);
  assert.match(format([]), /没找到/u);
});

test('only bound owner reader is invoked, blank keywords do not read', () => {
  const calls = [];
  const deps = { getChatHistory: (...args) => { calls.push(args); return []; } };
  const input = { file: 'synthetic-history.json', ownerId: 'owner', senderId: 'owner', keyword: '预算' };
  assert.equal(recallChat({ ...input, senderId: 'friend' }, deps), null);
  assert.equal(recallChat({ ...input, ownerId: '' }, deps), null);
  assert.match(recallChat({ ...input, keyword: '' }, deps), /关键词/u);
  assert.equal(calls.length, 0);
  assert.match(recallChat(input, deps), /没找到/u);
  assert.deepEqual(calls, [['synthetic-history.json', 'owner']]);
});
