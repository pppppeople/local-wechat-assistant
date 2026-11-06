'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseLaterBoxCommand: parse } = require('../src/later-box-commands');
const { createLaterBoxStore } = require('../src/later-box-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'later-box-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T01:00:00Z');
  const stateFile = path.join(root, 'later-box', 'state.json');
  const options = { stateFile, now: () => time, random: () => 0.5 };
  const store = createLaterBoxStore(options), sent = [];
  const image = path.join(root, 'inbound.png'); fs.writeFileSync(image, 'synthetic image');
  return { root, stateFile, options, store, sent, image,
    read: () => readRecordState(stateFile), advance: ms => { time += ms; },
    say: (text, images = []) => store.handle('owner', parse(text, images, { now: time })),
    restart: () => createLaterBoxStore(options), deliver: async (text, id) => { sent.push({ text, id }); } };
}



test('text/link save, note, unread/all lists, deterministic search, random, stable numbers and deletion', t => {
  const f = fixture(t);
  assert.match(f.say('稍后箱'), /没有符合/);
  assert.match(f.say('稍后看：https://example.com/a，备注：资料'), /第 1 条.*未设提醒/);
  f.say('存一下：待阅读文字'); f.say('稍后看：第三条');
  const original = f.read().items;
  assert.equal(original[0].kind, 'link'); assert.equal(original[1].kind, 'text');
  assert.equal(original[0].note, '资料'); assert.equal(original[0].createdAt, '2026-10-31T01:00:00.000Z');
  assert.match(f.say('稍后第 1 条已看'), /已标记已读/);
  assert.doesNotMatch(f.say('稍后箱'), /第 1 条/);
  assert.match(f.say('稍后箱 全部'), /第 1 条（已读）/);
  assert.match(f.say('稍后搜 资料'), /第 1 条/);
  assert.match(f.say('稍后搜 待阅读'), /第 2 条/);
  assert.match(f.say('稍后搜 不存在'), /没有符合/);
  assert.match(f.say('稍后随机'), /第 3 条（未读）/);
  assert.equal(f.read().items[2].read, false);
  f.say('稍后第 2 条删掉'); assert.match(f.say('存一下：新增'), /第 4 条/);
  assert.match(f.say('稍后第 2 条已看'), /没有这个/);
  assert.deepEqual(f.restart().handle('owner', parse('稍后箱 全部')), f.say('稍后箱 全部'));
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(index._recordState.version, 1);
  assert.match(index.items[0].file, /^records\/items\/link\/2026\/10\//);
});

test('managed image survives inbound removal and restart; deletion removes copy and record body', t => {
  const f = fixture(t);
  assert.match(f.say('存一下：图示，备注：流程', [f.image]), /第 1 条/);
  const item = f.read().items[0];
  const copy = path.join(path.dirname(f.stateFile), 'images', item.file);
  assert.notEqual(copy, f.image); assert.equal(fs.readFileSync(copy, 'utf8'), 'synthetic image');
  assert.equal(JSON.stringify(item).includes(f.image), false);
  fs.rmSync(f.image);
  assert.match(f.restart().handle('owner', parse('稍后箱')), /图片已存.*图示/);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  const body = path.join(path.dirname(f.stateFile), index.items[0].file);
  assert.match(f.say('稍后第 1 条删掉'), /图片副本/);
  assert.equal(fs.existsSync(copy), false); assert.equal(fs.existsSync(body), false);
});

test('Shanghai today/tomorrow clock parser and invalid time fallback preserve reminder as note', t => {
  const f = fixture(t); const now = f.options.now();
  for (const [expression, expected] of [
    ['今天 10:30', '2026-10-31T02:30:00.000Z'], ['今天下午三点半', '2026-10-31T07:30:00.000Z'],
    ['明天 9 点', '2026-11-01T01:00:00.000Z'], ['明早九点', '2026-11-01T01:00:00.000Z'],
  ]) {
    const command = parse(`稍后看：正文，${expression}提醒我`, [], { now });
    assert.equal(command.resendAt, expected, expression); assert.equal(command.content, '正文');
  }
  for (const expression of ['今天八点', '明天25:00', '明天9:99', '下周一九点', '过一会', '每天九点', '']) {
    const command = parse(`存一下：正文，${expression}提醒我`, [], { now });
    assert.equal(command.resendAt, null, expression); assert.equal(command.timeUnparsed, true);
    assert.match(f.store.handle('owner', command), /未设提醒/);
    assert.match(f.read().items.at(-1).note, /提醒我/);
  }
  assert.equal(parse('存一下：正文', [], { now }).resendAt, null);
  assert.deepEqual(parse('稍后看：'), { type: 'invalid' });
});

test('due scan claims before mock delivery, marks read, concurrent scans and cold restart never duplicate', async t => {
  const f = fixture(t);
  f.say('稍后看：待看内容，今天10点提醒我');
  f.advance(3600000 - 1); assert.equal(await f.store.tick(f.deliver), false);
  f.advance(1);
  await Promise.all([f.store.tick(async (...args) => {
    assert.equal(f.read().items[0].reminded, true); assert.equal(f.read().items[0].read, true);
    await f.deliver(...args);
  }), f.store.tick(f.deliver)]);
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /第 1 条.*待看内容/); assert.match(f.sent[0].id, /^later-box-/);
  assert.doesNotMatch(f.say('稍后箱'), /待看内容/); assert.match(f.say('稍后箱 全部'), /待看内容/);
});

test('restart recovers pending due text and image once each; failed send is never retried', async t => {
  const f = fixture(t);
  f.say('稍后看：正文，今天10点提醒我');
  f.say('稍后再看，今天10点提醒我', [f.image]);
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 0);
  f.advance(3600000);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 2); assert.match(f.sent[1].text, /第 2 条.*图片已存/);
  f.say('存一下：失败用例，今天11点提醒我'); f.advance(3600000);
  let attempts = 0;
  await assert.rejects(f.store.tick(async () => { attempts++; throw new Error('mock failure'); }), /mock/);
  await f.restart().tick(f.deliver); assert.equal(attempts, 1); assert.equal(f.sent.length, 2);
});

test('parser guards, friend refuses before read/write, invalid and multi-image saves do not write', t => {
  const f = fixture(t);
  for (const value of ['他说稍后看：正文', '稍后箱是什么', '稍后再看', '存一下', '记一下，稍后看：正文']) assert.equal(parse(value), null);
  for (const caption of ['普通图片', '稍后箱', '稍后看：正文', '请存一下', '存一下子']) assert.equal(parse(caption, [f.image]), null);
  assert.equal(parse('存一下', [f.image], { side: 'friend' }), null);
  for (const value of ['存一下：正文', '稍后箱', '稍后第 1 条删掉']) assert.match(f.store.handle('friend', parse(value)), /仅主人/);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match(f.say('稍后看：'), /未存入/);
  assert.match(f.say('存一下', [f.image, f.image]), /每次只存一张/);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('limits include read records; 200 total and 50 copies refuse without replacement; deleted capacity reusable', t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) f.say('存一下', [f.image]);
  assert.match(f.say('存一下', [f.image]), /50 个上限/);
  assert.equal(fs.readdirSync(path.join(path.dirname(f.stateFile), 'images')).length, 50);
  for (let i = 0; i < 150; i++) f.say(`存一下：记录${i}`);
  f.say('稍后第 1 条已看'); assert.match(f.say('存一下：超限'), /200 条上限/);
  assert.equal(f.read().items.length, 200);
  f.say('稍后第 1 条删掉'); assert.match(f.say('存一下', [f.image]), /第 201 条/);
});

test('strict corrupt index/schema/missing body quarantines without mock dispatch', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('稍后看：正文，今天10点提醒我');
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.items[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : JSON.stringify({ schemaVersion: 1, nextNumber: 1, items: [{}] }));
    f.advance(3600000); await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0); assert.equal(fs.existsSync(f.stateFile), false);
  }
});
