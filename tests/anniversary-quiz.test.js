'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAnniversaryQuizCommand: parse, normalizeDate } = require('../src/anniversary-quiz-commands');
const { createAnniversaryQuizStore, anniversaryStats, ROUND_TTL_MS } = require('../src/anniversary-quiz-store');
const { readRecordState } = require('../src/record-state');


function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anniversary-quiz-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-11-01T00:00:00+08:00'), binding = 'owner+bound-friend';
  const stateFile = path.join(root, 'state/quiz.json');
  const settings = { stateFile, now: () => time, getBinding: () => binding };
  const game = createAnniversaryQuizStore(settings);
  return { root, stateFile, game, settings, advance: ms => { time += ms; }, rebind: () => { binding = 'new-pair'; },
    state: () => readRecordState(stateFile), say: (text, side = 'owner') => game.handle(side, parse(text)),
    add: () => game.handle('owner', parse('登记纪念日：相识｜2020-02-29')),
    start: (side = 'owner') => game.handle(side, parse('纪念日问答：相识')) };
}


test('owner registration, listing, duplicate, invalid real dates and hard limit never overwrite/write refused inputs', t => {
  const f = fixture(t);
  for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '0000-01-01', '2020年2月29日', '2020-2-29']) {
    assert.match(f.say(`登记纪念日：相识｜${date}`), /日期无效/);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
  assert.match(f.add(), /已登记/);
  const original = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.say('登记纪念日：相识｜2021-01-01'), /同名.*不会覆盖/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), original);
  assert.match(f.say('纪念日列表'), /相识｜2020-02-29/);
  for (let n = 1; n < 20; n++) f.say(`登记纪念日：事件${n}｜2020-01-01`);
  const full = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.say('登记纪念日：溢出｜2020-01-01'), /20.*上限/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), full);
  assert.equal(f.state().anniversaries.length, 20);
  assert.equal(f.state().anniversaries[0].date, '2020-02-29');
});

test('friend cannot manage registrations; direct invalid side refused', t => {
  const f = fixture(t);
  for (const cmd of ['登记纪念日：相识｜2020-02-29', '纪念日列表', '删除纪念日：相识']) assert.match(f.say(cmd, 'friend'), /仅主人/);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.throws(() => f.say('纪念日列表', 'stranger'), /invalid.*side/);
});

test('missing anniversary and single round limit, both sides may start, owner cannot delete active anniversary', t => {
  const f = fixture(t);
  assert.match(f.start(), /不存在/); assert.equal(fs.existsSync(f.stateFile), false);
  f.add(); assert.match(f.start('friend'), /该纪念日的日期是哪一天/);
  const index = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.start(), /已有进行中.*同时仅一题/);
  assert.match(f.say('删除纪念日：相识'), /先揭晓或放弃/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.equal(f.state().rounds.length, 1);
  f.say('纪念日放弃', 'friend'); assert.match(f.say('删除纪念日：相识'), /已删除/);
  assert.match(f.say('删除纪念日：相识'), /不存在/);
});

test('sealed answer projections never disclose peer answers, repeated submission cannot replace', t => {
  for (const first of ['owner', 'friend']) {
    const f = fixture(t); f.add(); const prompt = f.start();
    assert.ok(!prompt.includes('2020-02-29'));
    const other = first === 'owner' ? 'friend' : 'owner';
    const initial = f.say('纪念日回答：1999-12-31', first);
    const repeat = f.say('纪念日回答：2020-02-29', first);
    const peer = f.start(other);
    for (const reply of [initial, repeat, peer]) assert.ok(!reply.includes('1999-12-31'));
    assert.match(initial, /已密封/); assert.match(repeat, /不能重复/);
    assert.equal(f.state().rounds[0].answers[first], '1999-12-31');
    assert.equal(f.state().rounds[0].answers[other], undefined);
  }
});

test('date normalization accepts both forms, invalid answer does not consume an attempt; auto reveal and persisted result', t => {
  assert.equal(normalizeDate('2020年2月29日'), '2020-02-29');
  assert.equal(normalizeDate('2020-02-29'), '2020-02-29');
  const f = fixture(t); f.add(); f.start();
  for (const date of ['2025-02-29', '2020/02/29', '2020-2-29', '2020年13月1日', '0000年1月1日', '2020-02-29T00:00:00Z']) {
    assert.match(f.say(`纪念日回答：${date}`, 'friend'), /日期无效.*未记为作答/);
    assert.deepEqual(f.state().rounds[0].answers, {});
  }
  f.say('纪念日回答：2020年2月29日');
  const revealed = f.say('纪念日回答：2020-02-29', 'friend');
  assert.match(revealed, /登记日期：2020-02-29.*Owner：正确.*好友：正确.*完整周年数 6 年/s);
  assert.equal(f.state().rounds[0].status, 'revealed');
  f.advance(86400000);
  const restart = createAnniversaryQuizStore(f.settings);
  assert.equal(restart.handle('owner', parse('纪念日揭晓')), revealed);
  assert.match(restart.handle('friend', parse('纪念日回答：2000-01-01')), /没有进行中/);
});

test('either side manual reveal marks wrong/unanswered; cancellation is terminal without reveal', t => {
  for (const side of ['owner', 'friend']) {
    const f = fixture(t); f.add(); f.start(); f.say('纪念日回答：2020-02-28');
    const result = f.say('纪念日揭晓', side);
    assert.match(result, /Owner：错误.*好友：未作答/s);
    assert.equal(f.state().rounds[0].status, 'revealed');
    assert.match(f.start(), /该纪念日/);
    assert.match(f.say('纪念日放弃', side), /已放弃.*未揭晓/);
    assert.equal(f.state().rounds[1].status, 'cancelled');
    assert.match(f.say('纪念日揭晓'), /没有进行中/);
  }
});

test('exact 24 hour expiry through scan and lazy command survives restart, archives without reveal', t => {
  const f = fixture(t); f.add(); f.start(); f.say('纪念日回答：2020-02-29');
  f.advance(ROUND_TTL_MS - 1); f.game.expire(); assert.equal(f.state().rounds[0].status, 'active');
  f.advance(1); createAnniversaryQuizStore(f.settings).expire();
  assert.equal(f.state().rounds[0].status, 'expired');
  assert.match(f.say('纪念日揭晓', 'friend'), /已过期并归档/);
  assert.match(f.say('纪念日回答：2020-02-29', 'friend'), /已过期/);
  assert.match(f.say('删除纪念日：相识'), /已删除/);
  f.add(); f.start(); f.advance(ROUND_TTL_MS);
  assert.match(f.say('纪念日揭晓'), /已过期/);
  f.start(); assert.equal(f.state().rounds.length, 3);
});

test('complete anniversaries, leap day in common/century years, Shanghai midnight days and future dates', () => {
  const stats = (date, day) => anniversaryStats(date, Date.parse(day));
  assert.equal(stats('2020-11-01', '2026-10-31T23:59:59+08:00').years, 5);
  assert.equal(stats('2020-11-01', '2026-11-01T00:00:00+08:00').years, 6);
  assert.equal(stats('2020-02-29', '2021-02-27T23:59:59+08:00').years, 0);
  assert.equal(stats('2020-02-29', '2021-02-28T00:00:00+08:00').years, 1);
  assert.equal(stats('2020-02-29', '2024-02-28T12:00:00+08:00').years, 3);
  assert.equal(stats('2020-02-29', '2024-02-29T00:00:00+08:00').years, 4);
  assert.equal(stats('2000-02-29', '2100-02-28T00:00:00+08:00').years, 100);
  assert.equal(stats('2026-11-01', '2026-11-01T15:59:59Z').days, 0);
  assert.equal(stats('2026-11-01', '2026-11-01T16:00:00Z').days, 1);
  assert.deepEqual(stats('2026-11-02', '2026-11-01T12:00:00+08:00'), { today: '2026-11-01', years: 0, days: -1 });
});

test('bound storage refuses new pairing; classified records and corrupt restart fail closed', t => {
  const f = fixture(t); f.add(); f.start();
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.match(index.rounds[0].file, /^records\/rounds\/rounds\/2026\/10\//); // creation timestamp is UTC
  assert.match(index.anniversaries[0].file, /^records\/anniversaries\/anniversaries\//);
  f.rebind(); assert.throws(() => f.say('纪念日揭晓'), /绑定已变化/);
  const g = fixture(t); g.add(); g.start(); fs.writeFileSync(g.stateFile, '{broken');
  assert.throws(() => g.say('纪念日揭晓'), /损坏.*隔离/);
  assert.throws(() => createAnniversaryQuizStore(g.settings).handle('owner', parse('纪念日列表')), /已隔离/);
});
