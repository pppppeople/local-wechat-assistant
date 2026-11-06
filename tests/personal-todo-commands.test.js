'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractDueDate, parsePersonalTodoCommand } = require('../src/personal-todo-commands');
const { parseSharedLifeCommand } = require('../src/shared-life-commands');
const NOW = Date.parse('2026-10-30T16:30:00Z'); // Shanghai Saturday, Oct 31.



test('shared life claims prefixed commitments and belonging locations', () => {
  assert.deepEqual(parseSharedLifeCommand('记一下，我们约定周六去爬山'), {
    type: 'commitment_add', text: '我们约定周六去爬山',
  });
  assert.deepEqual(parseSharedLifeCommand('记一下，我把护照放在抽屉里'), {
    type: 'belonging_set', name: '护照', location: '抽屉里',
  });
});

test('personal todo handles notes unclaimed by shared life', () => {
  const text = '记一下，买牛奶';
  assert.equal(parseSharedLifeCommand(text), null);
  assert.deepEqual(parsePersonalTodoCommand(text), { type: 'add', text: '买牛奶' });
});

test('personal todo note resolves Monday to next Monday with a fixed clock', () => {
  const command = parsePersonalTodoCommand('记一下，周一找 Louis 确认 DEV 环境');
  assert.deepEqual(command, { type: 'add', text: '周一找 Louis 确认 DEV 环境' });
  assert.deepEqual(extractDueDate(command.text, NOW), {
    text: '找 Louis 确认 DEV 环境', dueDate: '2026-11-02',
  });
});

test('parses the specified commands without rewriting the body', () => {
  for (const text of ['记一下，买牛奶。', '记一下 买牛奶。', '记一下,买牛奶。']) {
    assert.deepEqual(parsePersonalTodoCommand(text), { type: 'add', text: '买牛奶。' });
  }
  assert.deepEqual(parsePersonalTodoCommand('记一下 甲，  乙\n丙！ '), { type: 'add', text: '甲，  乙\n丙！ ' });
  assert.deepEqual(parsePersonalTodoCommand('我的待办'), { type: 'list' });
  assert.deepEqual(parsePersonalTodoCommand('清空已完成'), { type: 'clear_completed' });
  for (const text of ['第12项完成', '完成第12项']) {
    assert.deepEqual(parsePersonalTodoCommand(text), { type: 'complete', number: 12 });
  }
  assert.deepEqual(parsePersonalTodoCommand('取消第2项'), { type: 'cancel', number: 2 });
  assert.deepEqual(parsePersonalTodoCommand('记一下，'), { type: 'add', text: '' });
  for (const text of ['', '记一下买牛奶', '查看约定', '第1项完成再转告好友', '取消第1项和第2项']) {
    assert.equal(parsePersonalTodoCommand(text), null);
  }
});

test('extracts boundary dates using Shanghai day, weekdays and natural next week', () => {
  const cases = [
    ['明天买牛奶', '买牛奶', '2026-11-01'],
    ['买牛奶后天', '买牛奶', '2026-11-02'],
    ['周一开会', '开会', '2026-11-02'],
    ['下周一开会', '开会', '2026-11-02'],
    ['周六整理', '整理', '2026-10-31'],
    ['下周六整理', '整理', '2026-11-07'],
    ['周日整理', '整理', '2026-11-01'],
    ['周天整理', '整理', '2026-11-01'],
    ['下周日整理', '整理', '2026-11-08'],
    ['11月3日交材料', '交材料', '2026-11-03'],
    ['交材料1月1日', '交材料', '2026-01-01'],
    ['明天，  甲！\n乙。', '，  甲！\n乙。', '2026-11-01'],
    ['甲， 乙！ 明天', '甲， 乙！ ', '2026-11-01'],
    ['明天整理后天', '整理后天', '2026-11-01'],
  ];
  for (const [input, text, dueDate] of cases) assert.deepEqual(extractDueDate(input, NOW), { text, dueDate }, input);
  // On Monday, this Monday is today; next Monday is seven days away.
  const monday = Date.parse('2026-11-02T02:00:00Z');
  assert.equal(extractDueDate('周一开会', monday).dueDate, '2026-11-02');
  assert.equal(extractDueDate('下周一开会', monday).dueDate, '2026-11-09');
  assert.equal(extractDueDate('明天跨年', Date.parse('2026-12-31T15:00:00Z')).dueDate, '2027-01-01');
  assert.equal(extractDueDate('2月29日检查', Date.parse('2028-01-01T00:00:00Z')).dueDate, '2028-02-29');
});

test('does not guess vague dates, invalid dates or extract dates in the middle', () => {
  for (const text of ['过阵子买牛奶', '买牛奶过阵子', '安排明天买牛奶', '买11月3日的票',
    '2月30日交材料', '13月1日交材料', '0月1日交材料', '2月29日交材料', '明年买牛奶']) {
    assert.deepEqual(extractDueDate(text, NOW), { text, dueDate: null });
  }
});
