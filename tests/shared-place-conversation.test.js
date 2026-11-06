'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractSharedPlaceSuggestion,
  mightResolveSharedPlaceSuggestion,
  suggestionDecision,
} = require('../src/shared-place-conversation');

test('extracts only a valid trailing shared-place suggestion marker', () => {
  assert.deepEqual(extractSharedPlaceSuggestion('听起来挺适合周末去。\n[[SHARED_PLACE_SUGGEST:{"name":"示例街区","reason":"明确表达了想去"}]]'), {
    reply: '听起来挺适合周末去。',
    suggestion: { name: '示例街区', reason: '明确表达了想去' },
  });
  assert.deepEqual(extractSharedPlaceSuggestion('普通回答'), { reply: '普通回答', suggestion: null });
  assert.equal(extractSharedPlaceSuggestion('回答\n[[SHARED_PLACE_SUGGEST:{bad json}]]').suggestion, null);
  assert.equal(extractSharedPlaceSuggestion('回答\n[[SHARED_PLACE_SUGGEST:{"name":"这个地方"}]]').suggestion, null);
  assert.equal(extractSharedPlaceSuggestion('前面[[SHARED_PLACE_SUGGEST:{"name":"示例街区"}]]后面').reply, '前面后面');
});

test('recognizes short confirmation only for an existing pending suggestion flow', () => {
  assert.equal(suggestionDecision('加吧'), 'accept');
  assert.equal(suggestionDecision('不用了'), 'decline');
  assert.equal(mightResolveSharedPlaceSuggestion('好啊'), true);
  assert.equal(mightResolveSharedPlaceSuggestion('这个方案挺好的'), false);
});
