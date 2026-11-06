'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCapsuleTime, parseSharedLifeCommand, validName } = require('../src/shared-life-commands');

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

test('validName trims command wording and rejects non-item concepts', () => {
  assert.equal(validName('  请帮我记一下我的 备用钥匙 这个东西！  '), '备用钥匙');
  assert.equal(validName('家里的纸巾'), '纸巾');
  assert.equal(validName('  '), '');
  assert.equal(validName('我'), '');
  assert.equal(validName('库存'), '');
  assert.equal(validName('耐心'), '');
  assert.equal(validName('a'.repeat(81)), 'a'.repeat(80));
});

test('parses help, capsule listing and cancellation commands', () => {
  assert.deepEqual(parseSharedLifeCommand('生活箱'), { type: 'help' });
  assert.deepEqual(parseSharedLifeCommand('共享生活助手怎么用'), { type: 'help' });
  assert.deepEqual(parseSharedLifeCommand('列出我们的时间胶囊列表'), { type: 'capsule_list' });
  assert.deepEqual(parseSharedLifeCommand('取消时间胶囊 #tc-ab12'), { type: 'capsule_cancel', id: 'TC-AB12' });
  assert.deepEqual(parseSharedLifeCommand('取消时间胶囊＃a-9'), { type: 'capsule_cancel', id: 'A-9' });
});

test('dispatches commitment list, add, complete and delete variants', () => {
  assert.deepEqual(parseSharedLifeCommand('我们约定列表'), { type: 'commitment_list' });
  assert.deepEqual(parseSharedLifeCommand('约定'), { type: 'commitment_list' });
  assert.deepEqual(parseSharedLifeCommand('我们约好下周末去看展'), { type: 'commitment_add', text: '我们约好下周末去看展' });
  assert.deepEqual(parseSharedLifeCommand('我答应Owner周末修耳机'), { type: 'commitment_add', text: '我答应Owner周末修耳机' });
  assert.deepEqual(parseSharedLifeCommand('把周末修耳机这个承诺做完了'), { type: 'commitment_complete', query: '周末修耳机' });
  assert.deepEqual(parseSharedLifeCommand('删除周末修耳机这个承诺'), { type: 'commitment_delete', query: '周末修耳机' });
  assert.deepEqual(parseSharedLifeCommand('把周末修耳机这个约定删掉'), { type: 'commitment_delete', query: '周末修耳机' });
});

test('dispatches inventory list, delete, needed, low and stocked commands', () => {
  assert.deepEqual(parseSharedLifeCommand('查看家里库存列表'), { type: 'inventory_list', needsOnly: false });
  assert.deepEqual(parseSharedLifeCommand('家里缺什么？'), { type: 'inventory_list', needsOnly: true });
  assert.deepEqual(parseSharedLifeCommand('从购物清单里移除洗衣液'), { type: 'inventory_delete', name: '洗衣液' });
  assert.deepEqual(parseSharedLifeCommand('采购清单加上电池'), { type: 'inventory_set', name: '电池', state: 'needed', quantity: '' });
  assert.deepEqual(parseSharedLifeCommand('把牛奶加入购物清单'), { type: 'inventory_set', name: '牛奶', state: 'needed', quantity: '' });
  assert.deepEqual(parseSharedLifeCommand('洗衣液只剩半瓶'), { type: 'inventory_set', name: '洗衣液', state: 'low', quantity: '半瓶' });
  assert.deepEqual(parseSharedLifeCommand('矿泉水还有两瓶'), { type: 'inventory_set', name: '矿泉水', state: 'stocked', quantity: '两瓶' });
  assert.deepEqual(parseSharedLifeCommand('咖啡买好了'), { type: 'inventory_set', name: '咖啡', state: 'stocked', quantity: '' });
});

test('dispatches belonging list, query, delete, set and borrow variants with protected boxes excluded', () => {
  assert.deepEqual(parseSharedLifeCommand('查看物品位置'), { type: 'belonging_list' });
  assert.deepEqual(parseSharedLifeCommand('把备用钥匙的位置记录删除'), { type: 'belonging_delete', name: '备用钥匙' });
  assert.deepEqual(parseSharedLifeCommand('钥匙现在放哪儿了？'), { type: 'belonging_query', name: '钥匙' });
  assert.deepEqual(parseSharedLifeCommand('我把药品收在书桌抽屉'), { type: 'belonging_set', name: '药品', location: '书桌抽屉' });
  assert.deepEqual(parseSharedLifeCommand('把雨伞借给对方用了'), { type: 'belonging_set', name: '雨伞', location: '借给对方' });
  assert.equal(parseSharedLifeCommand('把限定手办放进双人想去箱'), null);
  assert.equal(parseSharedLifeCommand('把礼物放进收藏箱'), null);
});

test('parses relative, clamped-month, annual and clock capsule schedules', () => {
  assert.equal(parseCapsuleTime('两小时后', NOW).sendAt, NOW + 2 * 60 * 60 * 1000);
  assert.equal(parseCapsuleTime('三周后', NOW).sendAt, NOW + 3 * 7 * 24 * 60 * 60 * 1000);
  const januaryEnd = Date.parse('2026-01-31T12:00:00.000Z');
  assert.equal(parseCapsuleTime('一个月后', januaryEnd).sendAt, Date.parse('2026-02-28T12:00:00.000Z'));
  assert.equal(parseCapsuleTime('明年今天', NOW).sendAt, Date.parse('2027-08-24T12:00:00.000Z'));
  assert.equal(parseCapsuleTime('在明天 18:30', NOW).sendAt, Date.parse('2026-08-25T10:30:00.000Z'));
});

test('rejects capsule schedules and bodies that are empty, past, too near or too far', () => {
  assert.throws(() => parseCapsuleTime('零天后', NOW), /请写明时间/);
  assert.throws(() => parseCapsuleTime('今天 11点', NOW), /时间胶囊需要设置未来时间|已经过去/);
  assert.throws(() => parseCapsuleTime('六年后', NOW), /最多保存五年/);
  assert.equal(parseSharedLifeCommand('一个月后把这句话发给我们俩：'), null);
  assert.throws(() => parseSharedLifeCommand('昨天把这句话发给我们俩：旧消息', { now: NOW }), /请写明时间/);
});

test('returns null for empty, malformed and unrelated input', () => {
  assert.equal(parseSharedLifeCommand(''), null);
  assert.equal(parseSharedLifeCommand('   ！！！'), null);
  assert.equal(parseSharedLifeCommand(null), null);
  assert.equal(parseSharedLifeCommand('只是随便说说'), null);
  assert.equal(parseSharedLifeCommand('耐心还有两瓶'), null);
  assert.equal(parseSharedLifeCommand('我把东西放在书桌'), null);
});
