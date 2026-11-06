'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { confirmedWechatSend } = require('../src/wechat-send-result');

test('confirms a numeric ret of zero for every successful HTTP status', () => {
  for (const status of [200, 201, 204, 299]) {
    assert.equal(confirmedWechatSend(status, { ret: 0 }), true, String(status));
  }
});

test('rejects statuses outside 2xx before accepting an otherwise successful body', () => {
  for (const status of [undefined, null, NaN, 0, 199, 300, 500]) {
    assert.equal(confirmedWechatSend(status, { ret: 0 }), false, String(status));
  }
});

test('a numeric ret takes precedence over a message receipt', () => {
  for (const ret of [-2, 1, NaN, Infinity, -Infinity]) {
    assert.equal(confirmedWechatSend(200, { ret, message_id: 'receipt' }), false, String(ret));
  }
  assert.equal(confirmedWechatSend(200, { ret: 0, message_id: '' }), true);
});

test('message receipts are accepted only on HTTP 200 and with a valid id', () => {
  for (const message_id of ['receipt', '  receipt  ', 1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(confirmedWechatSend(200, { message_id }), true, String(message_id));
  }
  for (const status of [201, 204, 299, '200']) {
    assert.equal(confirmedWechatSend(status, { message_id: 'receipt' }), false, String(status));
  }
  for (const message_id of ['', '  \n', 0, -1, NaN, Infinity, -Infinity, false, {}]) {
    assert.equal(confirmedWechatSend(200, { message_id }), false, String(message_id));
  }
});

test('missing and non-object response bodies do not confirm delivery', () => {
  for (const body of [undefined, null, false, true, 0, 123, '"ret":0', [], [{ ret: 0 }]]) {
    assert.equal(confirmedWechatSend(200, body), false, JSON.stringify(body));
  }
});

test('non-numeric ret values fall back to message-id validation', () => {
  for (const ret of ['0', '1', null, false, {}, []]) {
    assert.equal(confirmedWechatSend(200, { ret, message_id: 'receipt' }), true, String(ret));
    assert.equal(confirmedWechatSend(200, { ret, message_id: ' ' }), false, String(ret));
  }
});

test('explicit errcode errors override ret zero and message IDs; errcode zero alone is not a receipt', () => {
  for (const errcode of [1, -2, '0', '5', null, false]) {
    assert.equal(confirmedWechatSend(200, { ret: 0, errcode }), false);
    assert.equal(confirmedWechatSend(200, { message_id: 'receipt', errcode }), false);
  }
  assert.equal(confirmedWechatSend(200, { ret: 0, errcode: 0 }), true);
  assert.equal(confirmedWechatSend(200, { message_id: 'receipt', errcode: 0 }), true);
  assert.equal(confirmedWechatSend(200, { ret: 1, errcode: 0, message_id: 'receipt' }), false);
  assert.equal(confirmedWechatSend(200, { errcode: 0 }), false);
});
