'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSharedPlaceIntentInstruction,
  extractSharedPlaceIntent,
  mightBeNaturalSharedPlaceIntent,
} = require('../src/shared-place-intent-conversation');

test('grounds natural place follow-ups in only the recent place-box context', () => {
  const context = {
    enabled: true,
    places: [{ index: 5, name: '示例学院(示例校区校区)', status: 'active', area: '丁城区区', addedBy: '好友' }],
    pending: [{ index: 1, name: '蛇岭', address: '香港特别行政区北区' }],
  };
  const prompt = buildSharedPlaceIntentInstruction(context);
  assert.match(prompt, /示例学院/);
  assert.match(prompt, /蛇岭/);
  assert.match(prompt, /SHARED_PLACE_INTENT/);
  assert.match(prompt, /只能用于理解当前用户的指代/);
  assert.equal(mightBeNaturalSharedPlaceIntent('大学那个我们已经去过啦', context), true);
  assert.equal(mightBeNaturalSharedPlaceIntent('普通聊一下大学生活', context), false);
  assert.equal(mightBeNaturalSharedPlaceIntent('大学那个我们已经去过啦', { enabled: false }), false);
});

test('extracts one bounded place-box action and strips malformed markers', () => {
  assert.deepEqual(extractSharedPlaceIntent('[[SHARED_PLACE_INTENT:{"action":"visited","index":5}]]'), {
    reply: '', intent: { action: 'visited', index: 5 },
  });
  assert.deepEqual(extractSharedPlaceIntent('[[SHARED_PLACE_INTENT:{"action":"recommend"}]]'), {
    reply: '', intent: { action: 'recommend' },
  });
  assert.deepEqual(extractSharedPlaceIntent('先改吧\n[[SHARED_PLACE_INTENT:{"action":"remove","index":99}]]'), {
    reply: '先改吧', intent: null,
  });
});

test('extracts all visited indices in one bounded batch', () => {
  assert.deepEqual(extractSharedPlaceIntent('[[SHARED_PLACE_INTENT:{"action":"visited","indices":[8,15,19,8]}]]').intent,
    { action: 'visited', indices: [8, 15, 19] });
  for (const indices of [[], [8, 31], [8, '15']]) {
    assert.equal(extractSharedPlaceIntent(`[[SHARED_PLACE_INTENT:${JSON.stringify({ action: 'visited', indices })}]]`).intent, null);
  }
});

test('rejects invalid actions, malformed JSON and array payloads', () => {
  assert.deepEqual(extractSharedPlaceIntent('先改吧\n[[SHARED_PLACE_INTENT:{"action":"bogus"}]]'), {
    reply: '先改吧', intent: null,
  });
  assert.deepEqual(extractSharedPlaceIntent('[[SHARED_PLACE_INTENT:{"action":}]]'), {
    reply: '', intent: null,
  });
  assert.equal(extractSharedPlaceIntent('[[SHARED_PLACE_INTENT:[{"action":"list"}]]]').intent, null);
});
