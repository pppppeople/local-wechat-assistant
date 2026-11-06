'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parsePhotoVaultCommand: parse } = require('../src/photo-vault-commands');
const { createPhotoVaultStore, MAX_BYTES } = require('../src/photo-vault-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-vault-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T01:00:00Z');
  const stateFile = path.join(root, 'vault/state.json');
  const options = { stateFile, now: () => time };
  const store = createPhotoVaultStore(options);
  const image = path.join(root, 'inbound.png'); fs.writeFileSync(image, 'synthetic photo');
  const sent = [];
  return { root, stateFile, options, store, image, sent,
    read: () => readRecordState(stateFile), advance: ms => { time += ms; },
    say: (text, images = []) => store.handle('owner', parse(text, images, { now: time })),
    restart: () => createPhotoVaultStore(options), deliver: async (...args) => sent.push(args) };
}



test('entrust copies photo, survives original cleanup and restart; list/retrieve/delete use stable numbers', t => {
  const f = fixture(t);
  assert.match(f.say('我的照片'), /还没有/);
  assert.match(f.say('存这张照片：海边日落', [f.image]), /第 1 张.*副本已保管.*未设定时/);
  const item = f.read().photos[0];
  const copy = f.store.handle('owner', parse('发回第 1 张')).imagePath;
  assert.notEqual(copy, f.image); assert.match(path.basename(copy), /^[a-f0-9-]+\.png$/);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'synthetic photo');
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(item).includes(f.image), false);
  fs.rmSync(f.image);
  assert.equal(f.restart().handle('owner', parse('发回第 1 张')).imagePath, copy);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'synthetic photo');
  assert.match(f.say('我的照片'), /第 1 张：海边日落\n存入：10\/31.*未设定时/s);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(index._recordState.version, 1);
  assert.match(index.photos[0].file, /^records\/photos\/photos\/2026\/10\//);
  const body = path.join(path.dirname(f.stateFile), index.photos[0].file);
  assert.match(f.say('删第 1 张照片'), /已删除.*副本/);
  assert.equal(fs.existsSync(copy), false); assert.equal(fs.existsSync(body), false);
  assert.match(f.say('发回第 1 张'), /没有这个/);
  fs.writeFileSync(f.image, 'another');
  assert.match(f.say('存这张照片', [f.image]), /第 2 张/);
});

test('Chinese times reuse parser; next month day-only defaults to explicit Shanghai 09:00; invalid only stores', t => {
  const f = fixture(t), now = f.options.now();
  for (const [caption, expected] of [
    ['这张照片下个月 1 号发回给我', '2026-11-01T01:00:00.000Z'],
    ['明早 9 点把这张照片发回', '2026-11-01T01:00:00.000Z'],
    ['这张照片今天下午三点半发回给我', '2026-10-31T07:30:00.000Z'],
    ['这张照片下个月二十号晚上八点发回给我', '2026-11-20T12:00:00.000Z'],
  ]) {
    const command = parse(caption, [f.image], { now });
    assert.equal(command.resendAt, expected, caption);
    assert.match(f.store.handle('owner', command), /定时回送：.*Asia\/Shanghai/);
  }
  assert.match(f.say('我的照片'), /定时回送：11\/1.*09:00/);
  assert.equal(parse('这张照片下个月1号发回给我', [f.image], { now: Date.parse('2026-12-31T01:00Z') }).resendAt,
    '2027-01-01T01:00:00.000Z');
  for (const expression of ['有空时', '今天8点', '明天25:00', '明早9:99', '下个月31号', '下个月十十号', '每天九点']) {
    const command = parse(`这张照片${expression}发回给我：备注`, [f.image], { now });
    assert.equal(command.resendAt, null, expression); assert.equal(command.timeUnparsed, true);
    assert.match(f.store.handle('owner', command), /时间未能解析.*只存照片.*未设定时/);
    assert.equal(f.read().photos.at(-1).timeText, expression);
    assert.equal(f.read().photos.at(-1).note, '备注');
  }
});

test('due scan marks on disk before dispatch, overlapping scans and restarts never duplicate, photo retained', async t => {
  const f = fixture(t); f.say('这张照片今天10点发回给我', [f.image]);
  const copy = f.say('发回第 1 张').imagePath;
  assert.ok(f.read().photos[0].resendAt); // manual retrieval does not cancel the timer
  fs.rmSync(f.image);
  f.advance(3600000 - 1); assert.equal(await f.restart().tick(f.deliver), false);
  f.advance(1);
  await Promise.all([f.restart().tick(async (...args) => {
    assert.equal(f.read().photos[0].resendAt, null);
    assert.equal(fs.readFileSync(args[0], 'utf8'), 'synthetic photo');
    await f.deliver(...args);
  }), f.store.tick(f.deliver)]);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], copy);
  assert.match(f.sent[0][1], /^photo-vault-/);
  assert.ok(fs.existsSync(copy)); assert.equal(f.read().photos.length, 1);
  assert.match(f.say('我的照片'), /未设定时回送/);
});

test('cold overdue recovery one per scan; dispatch failure never retries; delete cancels pending', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.say('这张照片今天10点发回给我', [f.image]);
  f.say('删第 3 张照片');
  f.advance(3600000);
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 1);
  let attempts = 0;
  await assert.rejects(f.restart().tick(async () => { attempts++; throw new Error('mock failure'); }), /mock failure/);
  await f.restart().tick(f.deliver); await f.store.tick(f.deliver);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.read().photos.length, 2);
});

test('100 photo and aggregate 200MB caps refuse without evicting, deletion releases capacity', t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.say('存这张照片', [f.image]);
  assert.match(f.say('存这张照片', [f.image]), /100 张上限/);
  assert.equal(f.read().photos.length, 100);
  const dir = path.join(path.dirname(f.stateFile), 'images');
  assert.equal(fs.readdirSync(dir).length, 100);
  f.say('删第 1 张照片'); assert.match(f.say('存这张照片', [f.image]), /第 101 张/);
  f.say('删第 2 张照片');
  // A sparse residual copy tests aggregate accounting without allocating 200MB.
  const residual = path.join(dir, 'recovery.image'); fs.writeFileSync(residual, ''); fs.truncateSync(residual, MAX_BYTES - 1);
  assert.match(f.say('存这张照片', [f.image]), /200MB 上限/);
  assert.equal(f.read().photos.length, 99); assert.equal(fs.readdirSync(dir).length, 100);
});

test('strict index/schema/body corruption quarantines and does not send; managed copies preserved', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('这张照片今天10点发回给我', [f.image]);
    const copy = f.say('发回第 1 张').imagePath;
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.photos[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : JSON.stringify({ schemaVersion: 1, nextNumber: 2, photos: [{}] }));
    f.advance(3600000);
    await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0); assert.ok(fs.existsSync(copy));
    assert.equal(fs.existsSync(f.stateFile), false);
  }
});

test('explicit captions only; friend cannot claim images or access state; missing/multiple attachments refuse', t => {
  const f = fixture(t);
  for (const caption of ['普通图片', '我的照片', '发回第1张', '删第1张照片', '他说存这张照片', '存这张照片是什么意思']) {
    assert.equal(parse(caption, [f.image]), null, caption);
  }
  for (const caption of ['存这张照片', '这张照片明早9点发回给我']) {
    assert.equal(parse(caption, [f.image], { side: 'friend' }), null);
    assert.match(f.say(caption), /请附上一张/);
    assert.match(f.say(caption, [f.image, f.image]), /每次只存一张/);
  }
  for (const text of ['我的照片', '发回第1张', '删第1张照片', '存这张照片']) {
    assert.match(f.store.handle('friend', parse(text, text === '存这张照片' ? [f.image] : [])), /仅主人/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
});
