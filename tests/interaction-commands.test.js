'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseExperienceCommand } = require('../src/interaction-commands');

test('parses cancellation, reset and retry commands', () => {
  assert.deepEqual(parseExperienceCommand('助手，取消回答'), { type: 'cancel' });
  assert.deepEqual(parseExperienceCommand('换个话题'), { type: 'reset' });
  assert.deepEqual(parseExperienceCommand('重试刚才的问题'), { type: 'retry' });
});

test('parses route corrections without matching normal questions', () => {
  assert.deepEqual(parseExperienceCommand('改用专业系统'), { type: 'switch', route: 'specialist' });
  assert.deepEqual(parseExperienceCommand('改用 知识库'), { type: 'switch', route: 'knowledge' });
  assert.deepEqual(parseExperienceCommand('改用普通回答'), { type: 'switch', route: 'ordinary' });
  assert.equal(parseExperienceCommand('怎么改用 专业系统 Business Rules？'), null);
});

test('opens the secondary help menu', () => {
  assert.deepEqual(parseExperienceCommand('更多功能'), { type: 'more-help' });
  assert.deepEqual(parseExperienceCommand('助手运维状态'), { type: 'ops-status' });
});
