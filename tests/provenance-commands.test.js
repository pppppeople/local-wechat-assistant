'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseProvenanceQuestion } = require('../src/provenance-commands');

test('parses why-known questions and trims their query', () => {
  for (const [input, query] of [
    ['你为什么知道这个：订单已保存？', '订单已保存'],
    ['为什么会知道这件事，订单已保存。', '订单已保存'],
    ['为什么知道这些:订单', '订单'],
    ['  为什么知道：  这条记录  ？  ', '这条记录'],
  ]) {
    assert.deepEqual(parseProvenanceQuestion(input), {
      type: 'explain_provenance',
      query,
    });
  }
});

test('parses source questions with and without an explicit subject', () => {
  for (const input of [
    '哪里知道的',
    '这个是从哪里知道的？',
    '这件事从哪儿知道的。',
    '这个来源是什么？',
    '这条信息的来源是什么？',
  ]) {
    assert.deepEqual(parseProvenanceQuestion(input), {
      type: 'explain_provenance',
      query: '',
    });
  }
  assert.deepEqual(parseProvenanceQuestion('为什么知道？'), {
    type: 'explain_provenance',
    query: '',
  });
});

test('returns null for empty, coerced, malformed, and unrelated input', () => {
  for (const input of [undefined, null, '', '   ', 0, false, true, {}, [], '来源是什么？', '你从哪里知道订单？']) {
    assert.equal(parseProvenanceQuestion(input), null, String(input));
  }
});
