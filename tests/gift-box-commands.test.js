'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inferGiftCategory, parseGiftBoxCommand } = require('../src/gift-box-commands');

test('gift commands recognize help and list aliases and ignore unrelated input', () => {
  for (const input of ['惊喜模式帮助', '礼物箱说明', ' 礼物箱怎么用 ']) {
    assert.deepEqual(parseGiftBoxCommand(input), { type: 'help' });
  }
  for (const input of ['礼物箱', '打开我的惊喜清单？', '我的礼物线索。', '列出礼物列表?']) {
    assert.deepEqual(parseGiftBoxCommand(input), { type: 'list' });
  }
  for (const input of [undefined, null, '', '  ', '聊聊礼物', '礼物箱帮助后再看看']) {
    assert.equal(parseGiftBoxCommand(input), null);
  }
});

test('gift updates parse removal, delivery and sharing with positive indices only', () => {
  for (const [input, index, action] of [
    ['删除我的礼物箱里的第两个！', 2, 'remove'],
    ['惊喜箱第九个 移除。', 9, 'remove'],
    ['礼物箱第10个已经送出了', 10, 'given'],
    ['把礼物箱第1个改成双方可见～', 1, 'share'],
  ]) assert.deepEqual(parseGiftBoxCommand(input), { type: 'update', index, action });
  for (const index of ['0', '01', '-1', '1.5', '十']) {
    assert.equal(parseGiftBoxCommand(`删除礼物箱第${index}个`), null);
  }
});

test('gift additions support private suffixes, colon syntax and literal peer names', () => {
  assert.deepEqual(parseGiftBoxCommand('把周年相册私密放进我的礼物箱！'), {
    type: 'add', title: '周年相册', category: 'occasion', visibility: 'owner_only',
  });
  assert.deepEqual(parseGiftBoxCommand('礼物箱： 生日相册 '), {
    type: 'add', title: '生日相册', category: 'occasion', visibility: 'fixed_pair',
  });
  const peerNames = ['A+B.(朋友)[1]'];
  assert.deepEqual(parseGiftBoxCommand('先别告诉A+B.(朋友)[1]，我想送给她：相册', { peerNames }), {
    type: 'add', title: '相册', category: 'idea', visibility: 'owner_only',
  });
  assert.equal(parseGiftBoxCommand('先别告诉AAABx朋友1，我想送给她：相册', { peerNames }), null);
});

test('gift category inference prioritizes size over occasion over preference', () => {
  for (const [input, expected] of [
    ['生日喜欢的颜色和尺寸', 'size'], ['纪念日喜欢的口味', 'occasion'],
    ['忌口', 'preference'], ['鞋12345678号', 'size'], ['鞋123456789号', 'idea'],
    [undefined, 'idea'], [42, 'idea'],
  ]) assert.equal(inferGiftCategory(input), expected);
});
