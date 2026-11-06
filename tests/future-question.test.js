'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseFutureQuestionCommand: parse } = require('../src/future-question-commands');
const { createFutureQuestionStore } = require('../src/future-question-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-question-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T15:59:00Z'); // Shanghai 23:59, independent of host timezone.
  const stateFile = path.join(root, 'future-question/state.json');
  const options = { stateFile, now: () => time };
  const store = createFutureQuestionStore(options), sent = [];
  return { root, stateFile, options, store, sent, now: () => time, advance: ms => { time += ms; },
    say: text => store.handle('owner', parse(text, { now: time })), read: () => readRecordState(stateFile),
    restart: () => createFutureQuestionStore(options), deliver: async (...args) => sent.push(args) };
}




test('explicit syntax, both separators and existing Shanghai date phrases', t => {
  const f = fixture(t);
  for (const [phrase, date] of [['明天', '2026-11-01'], ['后天', '2026-11-02'], ['周五', '2026-11-06'],
    ['下周五', '2026-11-06'], ['12月24日', '2026-12-24'], ['2026-12-24', '2026-12-24']]) {
    for (const separator of ['｜', '|']) assert.deepEqual(parse(`给未来的我出题: 问题 ${separator} 我的答案: 秘密 ${separator} ${phrase}`, { now: f.now() }),
      { type: 'create', question: '问题', answer: '秘密', date });
  }
  for (const text of ['普通聊天', '他说给未来的我出题：问题｜我的答案：秘密｜明天']) assert.equal(parse(text), null);
  f.advance(60000);
  assert.equal(parse('给未来的我出题：问题｜我的答案：秘密｜明天', { now: f.now() }).date, '2026-11-02');
});

test('past, today, malformed and missing fields rejected with example and no writes', t => {
  const f = fixture(t);
  for (const date of ['今天', '2026-10-31', '2026-10-30', '10月30日', '2026-02-30', '2月30日', '随便', '明天晚上']) {
    assert.match(f.say(`给未来的我出题：问题｜我的答案：秘密｜${date}`), /没有.*将来.*例如/);
  }
  for (const text of ['给未来的我出题：', '给未来的我出题： ｜我的答案：秘密｜明天',
    '给未来的我出题：问题｜我的答案： ｜明天', '给未来的我出题：问题｜明天', '未来题回答：', '取消未来题：']) {
    assert.match(f.say(text), /没有执行.*例如/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('sealed answer never appears in acknowledgements/list/cancellation; cancel one or refuse ambiguous', t => {
  const f = fixture(t);
  assert.match(f.say('未来的题'), /暂无未到期/);
  const secret = '绝不提前泄漏的答案';
  assert.doesNotMatch(f.say(`给未来的我出题：工作心情｜我的答案：${secret}｜后天`), new RegExp(secret));
  f.say(`给未来的我出题：工作目标｜我的答案：${secret}｜明天`);
  assert.equal(f.say('未来的题'), '未来的题：\n工作目标，2026-11-01\n工作心情，2026-11-02');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.say('取消未来题：工作'), /多道.*更具体/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.match(f.say('取消未来题：无此题'), /没有找到/);
  const index = JSON.parse(before), body = path.join(path.dirname(f.stateFile), index.questions[0].file);
  assert.equal(f.say('取消未来题：心情'), '已取消未来题：工作心情。');
  assert.equal(fs.existsSync(body), false);
  assert.equal(f.read().questions.length, 1);
});

test('friend denied without state reads or writes; no pending answer explicitly reported', t => {
  const f = fixture(t);
  for (const text of ['给未来的我出题：问题｜我的答案：秘密｜明天', '未来的题', '取消未来题：问题', '未来题回答：现在']) {
    assert.equal(parse(text, { side: 'friend' }), null);
    assert.match(f.store.handle('friend', parse(text, { now: f.now() })), /仅主人/);
  }
  assert.equal(f.say('未来题回答：现在'), '暂无待回答的未来题。');
  f.say('给未来的我出题：问题｜我的答案：秘密｜明天');
  assert.equal(f.say('未来题回答：提前回答'), '暂无待回答的未来题。');
  assert.equal(f.read().questions[0].status, 'sealed');
});

test('due scan persists before exactly one dispatch across overlaps/restarts; reveal then close/archive', async t => {
  const f = fixture(t);
  f.say('给未来的我出题：在意什么？｜我的答案：休息｜明天');
  assert.equal(await f.store.tick(f.deliver), false);
  f.advance(60000);
  await Promise.all([f.store.tick(async (...args) => {
    assert.equal(f.read().questions[0].status, 'pending');
    assert.equal(f.say('未来的题'), '暂无未到期的未来题。');
    assert.match(f.say('取消未来题：在意'), /没有找到/);
    await f.deliver(...args);
  }), f.restart().tick(f.deliver)]);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], '今天可以回答这道题了：在意什么？（请回复「未来题回答：<你的答案>」）');
  assert.match(f.sent[0][1], /^future-question-/);
  assert.equal(f.restart().handle('owner', parse('未来题回答：健康')), '未来题揭晓：在意什么？\n当初封存的答案：休息\n今天的答案：健康\n请你自己看看，这段时间有哪些变化。');
  assert.equal(f.read().questions[0].status, 'closed');
  assert.equal(f.read().questions[0].todayAnswer, '健康');
  assert.equal(f.say('未来题回答：第二次'), '暂无待回答的未来题。');
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 1);
});

test('failed send never retries, multiple pending answered FIFO, missed dates not delivered', async t => {
  const f = fixture(t);
  for (const question of ['第一题', '第二题']) f.say(`给未来的我出题：${question}｜我的答案：旧答案｜明天`);
  f.advance(60000);
  let attempts = 0;
  await assert.rejects(f.store.tick(async () => { attempts++; throw new Error('mock failure'); }), /mock failure/);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 1);
  assert.match(f.say('未来题回答：一'), /第一题/);
  assert.match(f.say('未来题回答：二'), /第二题/);
  f.say('给未来的我出题：错过｜我的答案：旧答案｜明天'); f.advance(2 * 86400000);
  assert.equal(await f.restart().tick(f.deliver), false);
  assert.match(f.say('未来的题'), /暂无/);
});

test('strict corruption quarantines evidence and prevents dispatch', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('给未来的我出题：问题｜我的答案：秘密｜明天');
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.questions[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : '{"schemaVersion":1,"questions":[{}]}');
    await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0);
  }
});
