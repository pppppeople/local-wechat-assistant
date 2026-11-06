'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseNaturalChoice, parseOpenDecision, parsePairDecisionCommand, splitOptions } = require('../src/pair-decision-commands');

test('decision control commands normalize IDs and require explicit submission signals', () => {
  assert.deepEqual(parsePairDecisionCommand(' 双人私密投票怎么用 '), { type: 'help' });
  assert.deepEqual(parsePairDecisionCommand('查看我们的双人私密决策列表？'), { type: 'list' });
  assert.deepEqual(parsePairDecisionCommand('取消私密投票 ＃pd-ab12！'), { type: 'cancel', id: 'PD-AB12' });
  assert.deepEqual(parsePairDecisionCommand('决策 #pd-a1： 2＞1 '), {
    type: 'submit', id: 'PD-A1', preferenceText: '2＞1',
  });
  assert.deepEqual(parsePairDecisionCommand('投票：都行'), { type: 'submit', id: '', preferenceText: '都行' });
  for (const input of [undefined, null, '', ' ', '取消决策 #pd_a', '投票：天气晴朗']) {
    assert.equal(parsePairDecisionCommand(input), null);
  }
  for (const hasPending of [1, 'true']) {
    assert.equal(parsePairDecisionCommand('预算两百', { hasPending }), null);
  }
});

test('explicit decision options clean bullets, enforce minimum count and bound lengths', () => {
  assert.deepEqual(splitOptions('1. 甲|2) 乙｜3） 丙/• 丁，- 戊,己；庚;辛\n壬'),
    ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']);
  assert.deepEqual(splitOptions(null), []);
  assert.deepEqual(splitOptions(' , ; \n '), []);
  assert.deepEqual(splitOptions(`${'长'.repeat(81)}、乙`), ['长'.repeat(80), '乙']);
  for (const candidates of ['甲', '甲、 、', '、，；']) {
    assert.throws(() => parsePairDecisionCommand(`决策：问题；候选：${candidates}`), /请至少给两个候选/);
  }
  assert.deepEqual(parsePairDecisionCommand(`我们一起决定 ${'题'.repeat(121)}，方案有：甲/乙`), {
    type: 'create', title: '题'.repeat(120), options: ['甲', '乙'],
  });
});

test('natural choices deduplicate, cap options and distinguish questions from preferences', () => {
  assert.deepEqual(parseNaturalChoice('去甲还是甲还是乙'), {
    type: 'create', title: '去什么', options: ['甲', '乙'],
  });
  assert.deepEqual(parseNaturalChoice('看甲，乙哪个好？'), {
    type: 'create', title: '看什么', options: ['甲', '乙'],
  });
  const choices = Array.from({ length: 9 }, (_, i) => `地点${i}`);
  assert.deepEqual(parseNaturalChoice(`去${choices.join('还是')}`).options, choices.slice(0, 8));
  for (const input of ['', '去甲还是甲', '看甲，乙', '去甲？', '首选去甲还是乙', '不要买甲还是乙']) {
    assert.equal(parseNaturalChoice(input), null);
  }
});

test('open decisions accept supported prompts and enforce the captured title boundary', () => {
  assert.deepEqual(parseOpenDecision(' 我们俩明天去哪？! '), {
    type: 'create', title: '我们俩明天去哪', options: [], mode: 'constraints',
  });
  for (const length of [2, 120]) {
    const title = '题'.repeat(length);
    assert.deepEqual(parseOpenDecision(`请帮我们俩一起规划：${title}。`), {
      type: 'create', title, options: [], mode: 'constraints',
    });
  }
  for (const input of ['帮我们甲', `帮我们${'题'.repeat(121)}`, '他们明天去哪', '我们明天几点回来']) {
    assert.equal(parseOpenDecision(input), null);
  }
});
