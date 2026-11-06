'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseTextPuzzleCommand: parse } = require('../src/text-puzzle-commands');
const { QUESTIONS, normalizeAnswer, createTextPuzzleStore } = require('../src/text-puzzle-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-puzzle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'text-puzzle/state.json');
  const options = { stateFile, now: () => Date.parse('2026-10-31T00:00:00Z') };
  const store = createTextPuzzleStore(options);
  return { root, stateFile, store, options, say: text => store.handle('owner', parse(text)),
    read: () => readRecordState(stateFile), restart: () => createTextPuzzleStore(options) };
}



test('handwritten pool contains at least 15 distinct fixed questions, answers and hints', () => {
  assert.ok(QUESTIONS.length >= 15);
  assert.equal(new Set(QUESTIONS.map(item => item.id)).size, QUESTIONS.length);
  assert.equal(new Set(QUESTIONS.map(item => item.text)).size, QUESTIONS.length);
  assert.ok(Object.isFrozen(QUESTIONS));
  for (const item of QUESTIONS) {
    assert.ok(Object.isFrozen(item));
    for (const key of ['text', 'answer', 'hint']) assert.ok(typeof item[key] === 'string' && item[key].trim());
    assert.ok(normalizeAnswer(item.answer));
  }
  assert.deepEqual(QUESTIONS.map(item => item.answer), ['明', '禾', '林', '众', '问', '白', '旧', '书', '盐', '冻', '3', '3', '2', '2', '3']);
});

test('friend and unknown side refused before reading or writing state', t => {
  const f = fixture(t);
  for (const side of ['friend', 'outsider']) for (const type of ['start', 'answer', 'hint', 'skip', 'stats']) {
    assert.match(f.store.handle(side, { type, answer: '明' }), /仅主人可用/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('start resumes the current question across messages and restart without advancing', t => {
  const f = fixture(t);
  const first = f.say('解谜');
  assert.match(first, /1\/15/);
  assert.equal(f.say('来个谜题'), first);
  assert.equal(f.restart().handle('owner', parse('解谜')), first);
  assert.equal(f.read().next, 1);
  assert.match(f.say('解谜战绩'), /已答对 0 题／已尝试 0 题/);
});

test('correct answer is normalized, scores once and automatically advances', t => {
  const f = fixture(t); f.say('解谜');
  assert.match(f.say('猜： 「明」！'), /答对了.*累计 1 分[\s\S]*2\/15/);
  assert.match(f.say('解谜战绩'), /已答对 1 题／已尝试 1 题/);
  assert.match(f.say('猜：明'), /答错.*1 次/);
  assert.equal(f.read().correct, 1);
  assert.equal(f.read().current.index, 1);
});

test('wrong guesses count, hint is limited once and persists; attempted counts questions', t => {
  const f = fixture(t); f.say('解谜');
  assert.match(f.say('猜：错'), /猜错 1 次.*提示/);
  assert.match(f.say('猜：错'), /猜错 2 次/);
  assert.match(f.say('提示'), new RegExp(QUESTIONS[0].hint));
  assert.match(f.restart().handle('owner', parse('提示')), /已经用过/);
  assert.match(f.say('猜：错'), /猜错 3 次.*提示已用过/);
  assert.match(f.say('解谜战绩'), /已答对 0 题／已尝试 1 题/);
  assert.match(f.say('猜：明'), /答对了/);
  assert.equal(f.read().current.wrongGuesses, 0);
  assert.match(f.say('提示'), new RegExp(QUESTIONS[1].hint));
  assert.match(f.say('解谜战绩'), /已答对 1 题／已尝试 1 题/);
});

test('skip reveals answer without score and rotates a full round without clearing stats', t => {
  const f = fixture(t); f.say('解谜');
  assert.match(f.say('放弃这题'), /答案：明。不计分。[\s\S]*2\/15/);
  assert.match(f.say('解谜战绩'), /已答对 0 题／已尝试 1 题/);
  for (let index = 1; index < QUESTIONS.length; index++) assert.match(f.say(`猜：${QUESTIONS[index].answer}`), /答对了/);
  assert.equal(f.read().current.index, 0);
  assert.match(f.say('解谜战绩'), /已答对 14 题／已尝试 15 题/);
  f.say('猜：错'); f.say('放弃这题');
  assert.match(f.say('解谜战绩'), /已答对 14 题／已尝试 16 题/);
});

test('no active question and empty guesses do not add attempts or leak an answer', t => {
  const f = fixture(t);
  for (const text of ['猜：明', '提示', '放弃这题']) assert.match(f.say(text), /没有进行中/);
  assert.equal(fs.existsSync(f.stateFile), false);
  f.say('解谜');
  for (const text of ['猜：', '猜： 。！']) assert.match(f.say(text), /填写答案/);
  assert.equal(f.read().attempted, 0);
});
