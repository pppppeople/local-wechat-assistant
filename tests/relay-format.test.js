'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FORMATS,
  formatRelayMessage,
  validateRelayFormat,
} = require('../src/relay-format');

test('accepts every supported format and defaults an empty format to plain', () => {
  assert.deepEqual(FORMATS, ['plain', 'email', 'letter', 'postcard', 'bulletin', 'news']);
  for (const format of FORMATS) {
    assert.equal(validateRelayFormat(format, 'relay'), format);
  }
  assert.equal(validateRelayFormat(undefined, 'relay'), 'plain');
  assert.equal(validateRelayFormat('', 'not-a-relay'), 'plain');
});

test('rejects unknown formats and non-relay use of decorated formats', () => {
  assert.throws(
    () => validateRelayFormat('telegram', 'relay'),
    /不支持这个传话格式/,
  );
  assert.throws(
    () => validateRelayFormat('email'),
    /传话格式只用于固定对象的微信转告/,
  );
  assert.throws(
    () => validateRelayFormat('news', 'reminder'),
    /传话格式只用于固定对象的微信转告/,
  );
});

test('renders each relay format and keeps plain messages unchanged', () => {
  const details = { sender: '成员乙', recipient: '小李', body: '今晚八点见' };
  const expected = {
    plain: '今晚八点见',
    email: '【微信邮件】\n主题：来自成员乙的消息\n发件人：成员乙\n收件人：小李\n\n小李：\n今晚八点见\n\n成员乙',
    letter: '致小李：\n\n今晚八点见\n\n——成员乙',
    postcard: '【文字明信片】\n寄给：小李\n\n今晚八点见\n\n寄信人：成员乙',
    bulletin: '【日常公告】\n发布人：成员乙\n接收人：小李\n\n今晚八点见',
    news: '【生活新闻播报】\n本条消息来自成员乙，送给小李：\n\n今晚八点见\n\n本条播报结束。',
  };

  for (const format of FORMATS) {
    assert.equal(formatRelayMessage(format, details), expected[format]);
  }
  assert.equal(formatRelayMessage(undefined, { sender: '', recipient: '', body: '' }), '');
});

test('preserves a missing plain message body as undefined', () => {
  assert.equal(formatRelayMessage('plain', { sender: '成员乙', recipient: '小李' }), undefined);
});
