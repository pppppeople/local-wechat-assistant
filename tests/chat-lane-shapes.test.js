'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChatLane } = require('../src/chat-lane-policy');

// Generic paraphrases only, never production message fixtures.
const shapes = [
  { reason: 'short_acknowledgement', lane: 'L0', texts: ['行吧。', '了解啦！'] },
  { reason: 'short_confirmation', lane: 'L0', texts: ['可以呀！', '没错哦！'] },
  { reason: 'repeated_laughter', lane: 'L0', texts: ['嘻嘻嘻嘻！', '嘿嘿嘿嘿嘿！'] },
  { reason: 'short_personal_state', lane: 'L0', texts: ['我有些疲惫了。', '我特别幸福呀！'] },
  { reason: 'identity_question', lane: 'L1', texts: ['该怎么称呼你呢？', '你的称呼是什么呀？'] },
];

for (const shape of shapes) for (const text of shape.texts) {
  test(`new short shape paraphrase: ${shape.reason}/${shape.texts.indexOf(text)}`, () => {
    assert.deepEqual(classifyChatLane({ text, state: { known: true } }), { lane: shape.lane, reasonCodes: [shape.reason] });
  });
  const traps = {
    tool: { text: `${text}邮件` },
    execution: { text: `${text}保存` },
    digit: { text: `${text}7` },
    amount: { text: `${text}五元` },
    date: { text: `${text}明天` },
    pending: { state: { known: true, pending: true } },
    pending_reason: { state: { known: true, pendingReasons: ['choice'] } },
    unknown: { state: { known: false } },
    link: { text: `${text}https://example.invalid` },
    attachment: { hasAttachment: true },
    image: { imagePaths: ['/synthetic/image.png'] },
    multi_intent: { text: `${text}另外晚安` },
    fragments: { fragments: 2 },
    reference: { text: `${text}那个` },
    followup: { state: { known: true, history: [{ kind: 'chat', assistant: '请回复确认' }] } },
  };
  for (const [name, trap] of Object.entries(traps)) test(`short shape stays L2: ${shape.reason}/${shape.texts.indexOf(text)}/${name}`, () => {
    assert.equal(classifyChatLane({ text, state: { known: true }, ...trap }).lane, 'L2');
  });
}

test('unmatched fragments, contextual questions and requests remain uncertain', () => {
  for (const text of ['怎么称呼', '称呼呢？', '你叫什么名字并且聊聊音乐', '我很困怎么办', '冷不冷', '噢那就这样', '可以继续吗', '我想躺着等你', '我特别幸福吗？', '对吧', '明白吧'])
    assert.equal(classifyChatLane({ text, state: { known: true } }).lane, 'L2');
});

test('all offline cases still force L2 under pending, unknown, attachment and batch-fragment hard gates', () => {
  const cases = require('./chat-lanes-cases.json').cases;
  for (const c of cases) for (const trap of [
    { state: { known: true, pending: true } }, { state: { known: false } }, { hasAttachment: true }, { fragments: 2 },
  ]) assert.equal(classifyChatLane({ text: c.text || c.fragments.join('\n'), state: { known: true }, ...trap }).lane, 'L2', c.id);
});

test('multiple independent clauses retain explicit fragment reason; comma alone does not grant admission', () => {
  for (const text of ['讲讲押韵，说说反讽', '什么是惯性，怎样缓解紧张', '你喜欢阅读吗，给我推荐书目', '我特别困。你喜欢阅读吗？', '我有些疲惫…聊聊音乐'])
    assert.deepEqual(classifyChatLane({ text, state: { known: true } }), { lane: 'L2', reasonCodes: ['multiple_or_fragments'] });
  for (const text of ['我想散步，陪着我聊会儿', '嗨呀，解释比喻', '我，觉得外星生物很有趣'])
    assert.equal(classifyChatLane({ text, state: { known: true } }).lane, 'L2');
  // Existing precedence stays intact even when the fragment predicate also matches.
  for (const [text, reason] of [['查询天气，另外聊聊', 'feature_or_execution'], ['那个，然后聊聊', 'ambiguous_reference'], ['https://example.invalid，聊聊', 'media_or_link']])
    assert.deepEqual(classifyChatLane({ text, state: { known: true } }), { lane: 'L2', reasonCodes: [reason] });
});
