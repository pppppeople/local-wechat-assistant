'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseSurpriseCountdownCommand: parse } = require('../src/surprise-countdown-commands');
const { createSurpriseCountdownStore } = require('../src/surprise-countdown-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surprise-countdown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T15:59:00Z'); // Shanghai 23:59, independent of host timezone.
  const stateFile = path.join(root, 'surprise-countdown/state.json');
  const options = { stateFile, now: () => time };
  const store = createSurpriseCountdownStore(options), sent = [];
  return { root, stateFile, options, store, sent, now: () => time, advance: ms => { time += ms; },
    say: text => store.handle('owner', parse(text, { now: time })), read: () => readRecordState(stateFile),
    restart: () => createSurpriseCountdownStore(options), deliver: async (...args) => sent.push(args) };
}



test('only explicit commands; dates reuse Shanghai todo semantics and ISO validation', t => {
  const f = fixture(t);
  for (const [phrase, date] of [['2026-12-24', '2026-12-24'], ['12月24日', '2026-12-24'],
    ['今天', '2026-10-31'], ['明天', '2026-11-01'], ['后天', '2026-11-02'],
    ['周五', '2026-11-06'], ['下周五', '2026-11-06']]) {
    assert.deepEqual(parse(`倒计时：一起 去看展 ${phrase}`, { now: f.now() }),
      { type: 'create', name: '一起 去看展', date });
  }
  for (const text of ['圣诞是12月24日', '帮我倒计时到明天', '他说倒计时：出游 明天',
    '每年12月24日提醒我', '邮件里说12月24日', '日历有个生日']) assert.equal(parse(text), null, text);
  f.advance(60000);
  assert.equal(parse('倒计时:出游 明天', { now: f.now() }).date, '2026-11-02');
  assert.equal(parse('倒计时：周五 下周五', { now: Date.parse('2026-11-02T01:00:00Z') }).date, '2026-11-13');
});

test('invalid and past dates explicitly refused with examples; today accepted', t => {
  const f = fixture(t);
  for (const text of ['倒计时：出游 不知道', '倒计时：出游 2026-02-30', '倒计时：出游 2月30日',
    '倒计时：出游 2026-13-01', '倒计时：出游 每周五', '倒计时：', '删除倒计时：']) {
    assert.match(f.say(text), /无法解析.*例如/);
  }
  for (const phrase of ['2026-10-30', '10月30日', '2025-12-24']) {
    assert.match(f.say(`倒计时：出游 ${phrase}`), /日期已过.*例如/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match(f.say('倒计时：见面 今天'), /已创建/);
  assert.equal(f.read().events[0].date, '2026-10-31');
});

test('duplicate active names refused without overwriting; expired or archived names can be reused', async t => {
  const f = fixture(t);
  f.say('倒计时：旅行 明天');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.say('倒计时：旅行 2026-12-24'), /已有未到期.*2026-11-01/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  f.say('倒计时：见面 今天');
  assert.match(f.say('倒计时：见面 今天'), /已有未到期/);
  await f.store.tick(f.deliver);
  assert.match(f.say('倒计时：见面 明天'), /已创建/);
  f.advance(2 * 86400000);
  assert.match(f.say('倒计时：旅行 明天'), /已创建/);
});

test('list sorts ascending with today, tomorrow, multiple days and midnight remaining days', t => {
  const f = fixture(t);
  assert.equal(f.say('我的倒计时'), '暂无未到期倒计时。');
  f.say('倒计时：平安夜 2026-12-24'); f.say('倒计时：旅行 后天');
  f.say('倒计时：见面 今天'); f.say('倒计时：散步 明天');
  assert.equal(f.say('我的倒计时'), '我的倒计时：\n见面，2026-10-31，就是今天\n散步，2026-11-01，还剩 1 天\n旅行，2026-11-02，还剩 2 天\n平安夜，2026-12-24，还剩 54 天');
  f.advance(60000);
  assert.equal(f.say('我的倒计时'), '我的倒计时：\n散步，2026-11-01，就是今天\n旅行，2026-11-02，还剩 1 天\n平安夜，2026-12-24，还剩 53 天');
});

test('delete by exact name, missing response, classified body removed and reminder cancelled', async t => {
  const f = fixture(t);
  f.say('倒计时：见面 今天'); f.say('倒计时：见面后散步 明天');
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  const body = path.join(path.dirname(f.stateFile), index.events[0].file);
  assert.match(body, /records\/events\/events\/2026\/10\/.+\.json$/u);
  assert.ok(fs.existsSync(body));
  assert.match(f.say('删除倒计时：见'), /不存在/);
  assert.match(f.say('删除倒计时:见面'), /已删除/);
  assert.equal(fs.existsSync(body), false);
  assert.match(f.say('删除倒计时：见面'), /不存在/);
  assert.match(f.say('我的倒计时'), /见面后散步/);
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 0);
});

test('friend parsers and stores refuse all commands without state access', t => {
  const f = fixture(t);
  for (const text of ['倒计时：见面 今天', '我的倒计时', '删除倒计时：见面']) {
    assert.equal(parse(text, { side: 'friend' }), null);
    assert.match(f.store.handle('friend', parse(text, { now: f.now() })), /仅主人/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('same-day reminder persists before dispatch; overlapping scans and restart send exactly once, then archive', async t => {
  const f = fixture(t);
  f.say('倒计时：出游 明天');
  assert.equal(await f.store.tick(f.deliver), false);
  f.advance(60000);
  await Promise.all([f.store.tick(async (...args) => {
    assert.equal(f.read().events[0].reminded, true);
    assert.equal(f.say('我的倒计时'), '暂无未到期倒计时。');
    await f.deliver(...args);
  }), f.restart().tick(f.deliver)]);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], '今天就是出游的日子！');
  assert.match(f.sent[0][1], /^surprise-countdown-/);
  f.advance(86400000); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1); assert.equal(f.read().events.length, 1);
});

test('failed dispatch is never retried and next due event remains available; missed days never catch up', async t => {
  const f = fixture(t);
  f.say('倒计时：见面 今天'); f.say('倒计时：散步 今天');
  let attempts = 0;
  await assert.rejects(f.store.tick(async () => { attempts++; throw new Error('mock failure'); }), /mock failure/);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], '今天就是散步的日子！');
  assert.equal(f.say('我的倒计时'), '暂无未到期倒计时。');
  f.say('倒计时：旅行 明天'); f.advance(2 * 86400000);
  assert.equal(await f.restart().tick(f.deliver), false);
  assert.equal(f.say('我的倒计时'), '暂无未到期倒计时。');
  assert.equal(f.read().events[2].reminded, false);
});

test('strict corruption preserves evidence and dispatches nothing', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('倒计时：见面 今天');
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.events[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : '{"schemaVersion":1,"events":[{}]}');
    await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
  }
});
