'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseDecisionReviewCommand: parse } = require('../src/decision-review-commands');
const { createDecisionReviewStore } = require('../src/decision-review-store');
const { readRecordState } = require('../src/record-state');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T01:00:00Z');
  const stateFile = path.join(root, 'decision-review/state.json');
  const options = { stateFile, now: () => time };
  const store = createDecisionReviewStore(options), sent = [];
  return { root, store, sent, stateFile, options, now: () => time, advance: ms => { time += ms; },
    read: () => readRecordState(stateFile), say: text => store.handle('owner', parse(text, { now: time })),
    restart: () => createDecisionReviewStore(options), deliver: async (...args) => sent.push(args) };
}


test('create parses decision, optional reason and dates, confirms defaults; classified write', t => {
  const f = fixture(t);
  assert.match(f.say('记决定：先做直达再补联程，因为改签风险低，下个月 15 号复盘'), /第 1 张.*\n原因：改签风险低/);
  assert.equal(f.read().cards[0].dueAt, '2026-11-15T01:00:00.000Z');
  assert.equal(f.read().cards[0].decision, '先做直达再补联程');
  assert.match(f.say('记决定：先做原型'), /未记原因.*\n未指定复盘日期，默认 30 天后/);
  assert.equal(f.read().cards[1].dueAt, '2026-11-30T01:00:00.000Z');
  f.say('记决定：等反馈，因为节省返工');
  assert.equal(f.read().cards[2].reason, '节省返工');
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(index._recordState.version, 1);
  assert.ok(fs.existsSync(path.join(path.dirname(f.stateFile), index.cards[0].file)));
  for (const text of ['记决定：', '记决定：先试，因为', '记决定：先试，2026-02-30复盘', '复盘卡第 1 张改到昨天']) {
    assert.equal(parse(text, { now: f.now() }).type, 'invalid', text);
  }
  assert.equal(parse('他说记决定：先做原型'), null);
});

test('reschedule, list and full history; explicit multiple reviews and next month clamp', t => {
  const f = fixture(t); f.say('记决定：先做原型');
  assert.match(f.say('我的复盘卡'), /第 1 张：先做原型.*复盘日/);
  assert.match(f.say('复盘卡第 1 张改到明天'), /已改期/);
  assert.equal(f.read().cards[0].dueAt, '2026-11-01T01:00:00.000Z');
  assert.match(f.say('复盘第 1 张：想法没变，再过一个月看'), /已追加.*下次复盘日/);
  assert.equal(f.read().cards[0].dueAt, '2026-11-30T01:00:00.000Z');
  assert.match(f.say('复盘第 1 张：增加测试'), /已追加/);
  assert.equal(f.read().cards[0].reviews.length, 2);
  assert.equal(f.store.hasPending(), false);
  assert.match(f.say('我的复盘卡'), /暂无待复盘/);
  assert.match(f.say('复盘卡第 1 张'), /先做原型[\s\S]*未记原因[\s\S]*想法没变[\s\S]*增加测试/);
});

test('due scan persists before mock dispatch, overlapping ticks and restarts attempt once', async t => {
  const f = fixture(t); f.say('记决定：先做原型，因为节省时间');
  f.advance(30 * 86400000 - 1); assert.equal(await f.store.tick(f.deliver), false);
  f.advance(1);
  await Promise.all([f.store.tick(async (...args) => {
    assert.equal(f.read().cards[0].asked, true); await f.deliver(...args);
  }), f.restart().tick(f.deliver)]);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0][0], /原决定：先做原型\n原因：节省时间/);
  assert.match(f.sent[0][1], /^decision-review-/);
  assert.equal(f.store.hasPending(), true);
});

test('restart catches unasked overdue card, failed send never retried, later round asks once', async t => {
  const f = fixture(t); f.say('记决定：先做原型');
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 0);
  f.advance(31 * 86400000);
  let attempts = 0;
  await assert.rejects(f.restart().tick(async () => { attempts++; throw new Error('mock failure'); }), /mock/);
  await f.restart().tick(f.deliver); assert.equal(attempts, 1); assert.equal(f.sent.length, 0);
  f.say('想法变了：加点测试，再过一个月看');
  f.advance(31 * 86400000);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1); assert.equal(f.read().cards[0].reviews.length, 1);
});

test('short guard is read-only, exactly one overdue unreviewed card; review closes pending round', async t => {
  const f = fixture(t); assert.equal(f.store.hasPending(), false); assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(parse('想法没变').number, null);
  f.say('记决定：先做原型'); assert.equal(f.store.hasPending(), false);
  f.advance(30 * 86400000); assert.equal(f.store.hasPending(), true);
  f.say('想法没变'); assert.equal(f.store.hasPending(), false);
  await f.store.tick(f.deliver); assert.equal(f.sent.length, 0);
  f.say('复盘卡第 1 张改到明天'); f.say('记决定：多收反馈');
  f.advance(31 * 86400000); assert.equal(f.store.hasPending(), false);
  assert.match(f.say('想法没变'), /指定编号/);
  assert.equal(f.read().cards[0].reviews.length, 1);
  fs.writeFileSync(f.stateFile, '{bad');
  assert.equal(f.store.hasPending(), false); assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{bad');
});

test('closing prevents future asks; friends cannot parse or touch owner state; limit includes closed', async t => {
  const f = fixture(t);
  for (const text of ['记决定：先做原型', '我的复盘卡', '复盘第 1 张：想法没变', '想法没变']) {
    assert.equal(parse(text, { side: 'friend' }), null);
    assert.match(f.store.handle('friend', parse(text)), /仅主人/);
  }
  assert.equal(f.store.hasPending('friend'), false); assert.equal(fs.existsSync(f.stateFile), false);
  f.say('记决定：先做原型'); f.say('复盘第 1 张：决定维持，复盘完了');
  f.advance(60 * 86400000); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 0); assert.match(f.say('复盘卡第 1 张改到明天'), /已关闭/);
  for (let i = 1; i < 100; i++) f.say(`记决定：方案${i}`);
  assert.match(f.say('记决定：超限'), /100 张上限/); assert.equal(f.read().cards.length, 100);
});

test('strict corruption quarantines bad JSON, invalid schema and missing body; no sends', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('记决定：先做原型');
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.cards[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : '{"schemaVersion":1,"cards":[{}]}');
    f.advance(31 * 86400000);
    await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0); assert.equal(fs.existsSync(f.stateFile), false);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
  }
});

test('cold overdue scan catches up once; close cancels pending ask', async t => {
  const f = fixture(t); f.say('记决定：先试方案');
  f.advance(31 * 86400000);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1);
  f.say('复盘第 1 张：保持，再过一个月看');
  f.advance(31 * 86400000);
  assert.equal(f.store.hasPending(), true);
  f.say('复盘第 1 张：复盘完了');
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 1);
  assert.equal(f.read().cards[0].reviews.length, 2);
});
