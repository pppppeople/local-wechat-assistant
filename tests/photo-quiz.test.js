'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePhotoQuizCommand: parse } = require('../src/photo-quiz-commands');
const { createPhotoQuizStore, normalizeAnswer, ROUND_TTL_MS, INPUT_TTL_MS } = require('../src/photo-quiz-store');
const { readRecordState } = require('../src/record-state');


function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-quiz-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'quiz/state.json'), source = path.join(root, 'source.png');
  fs.writeFileSync(source, Buffer.from('synthetic-private-image'));
  let time = Date.parse('2026-11-01T00:00:00Z'), binding = 'owner+friend';
  const sends = [];
  const settings = { stateFile, now: () => time, getBinding: () => binding,
    deliverImage: (side, filePath) => { sends.push({ side, filePath, content: fs.readFileSync(filePath, 'utf8') }); }, ...options };
  const game = createPhotoQuizStore(settings);
  return { root, stateFile, source, sends, settings, game, state: () => readRecordState(stateFile),
    advance: ms => { time += ms; }, rebind: () => { binding = 'replacement'; },
    say: (text, side = 'owner', images = []) => game.handle(side, parse(text, images)),
    start: (side = 'owner', answer = 'Ａ， B！') => game.handle(side, parse(`照片出题：${answer}`, [source])) };
}


test('deterministic normalization: miss, self-guess rejection, hit ends round and sends only to guesser', async t => {
  const f = fixture(t); await f.start();
  assert.equal(normalizeAnswer('　Ａ， b！'), 'ab');
  assert.match(await f.say('照片猜：ab'), /不能猜自己的题/);
  assert.match(await f.say('照片猜：ac', 'friend'), /没猜中/);
  assert.equal(f.state().rounds[0].status, 'active'); assert.equal(f.sends.length, 0);
  assert.match(await f.say('照片猜：a b', 'friend'), /猜对了.*答案：Ａ， B！/);
  assert.equal(f.state().rounds[0].status, 'matched');
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].side, 'friend');
  assert.match(await f.say('照片猜：ab', 'friend'), /已经结束/);
  assert.equal(f.sends.length, 1);
});

test('manual reveal by author only, reverse-side creation and owner send adapter supported', async t => {
  const f = fixture(t); await f.start('friend', '咖啡');
  assert.match(await f.say('揭晓照片'), /只有出题人/); assert.equal(f.sends.length, 0);
  assert.match(await f.say('揭晓照片', 'friend'), /已手动揭晓.*答案：咖啡/);
  assert.equal(f.state().rounds[0].status, 'revealed'); assert.equal(f.sends[0].side, 'owner');
});

test('expiry exact 24 hours archives across restart, guesses/reveals cannot send, next round allowed', async t => {
  const f = fixture(t); await f.start(); f.advance(ROUND_TTL_MS - 1);
  assert.match(await f.say('照片猜猜看状态', 'friend'), /已出题待猜/);
  f.advance(1); const restarted = createPhotoQuizStore(f.settings); restarted.expire();
  for (const [text, side] of [['照片猜：ab', 'friend'], ['揭晓照片', 'owner']]) {
    assert.match(await restarted.handle(side, parse(text)), /已过期/);
  }
  assert.equal(f.state().rounds[0].status, 'expired'); assert.equal(f.sends.length, 0);
  await f.start(); assert.equal(f.state().rounds.length, 2); assert.equal(f.state().rounds[1].status, 'active');
});

test('before reveal friend projections contain no answer/path/bytes and never open image files', async t => {
  const f = fixture(t); await f.start('owner', '秘密答案');
  const originalRead = fs.readFileSync, reads = [];
  fs.readFileSync = function(file, ...args) { reads.push(String(file)); return originalRead.call(this, file, ...args); };
  try {
    for (const text of ['照片猜猜看', '照片猜猜看状态', '照片猜：错误', '揭晓照片', '结束照片猜猜看']) {
      const reply = await f.say(text, 'friend');
      for (const secret of ['秘密答案', f.root, '.image', 'synthetic-private-image']) assert.ok(!reply.includes(secret));
    }
  } finally { fs.readFileSync = originalRead; }
  assert.ok(reads.every(file => !file.endsWith('.image'))); assert.equal(f.sends.length, 0);
  assert.match(await f.say('照片猜猜看状态'), /出题人：Owner.*剩余：1440 分钟.*是否已猜中：否/s);
});

test('unavailable/failing send is reported truthfully, never replayed; bound state cannot change recipients', async t => {
  for (const deliverImage of [null, () => false, () => { throw new Error('mock failure'); }]) {
    const f = fixture(t, { deliverImage }); await f.start();
    assert.match(await f.say('揭晓照片'), /未发送|未确认送达/);
    assert.ok(['unavailable', 'failed'].includes(f.state().rounds[0].delivery));
    assert.match(await createPhotoQuizStore(f.settings).handle('owner', parse('揭晓照片')), /已经结束/);
    f.rebind(); await assert.rejects(f.say('照片猜猜看'), /绑定已变化/);
  }
});

test('pending notices are sealed, terminal notices reveal only after completion; explicit delete clears copies', async t => {
  const notices = [], f = fixture(t, { onNotice: (side, text, key) => notices.push({ side, text, key }) });
  await f.start('owner', '秘密答案');
  assert.equal(notices[0].side, 'friend'); assert.match(notices[0].text, /已出题待猜/);
  assert.ok(!JSON.stringify(notices).includes('秘密答案'));
  await f.say('照片猜：错', 'friend'); assert.equal(notices.length, 1);
  await f.say('揭晓照片'); assert.match(notices[1].text, /答案：秘密答案/);
  assert.equal(notices[1].side, 'friend');
  const file = path.join(f.root, 'quiz/images', f.state().rounds[0].file);
  assert.equal(f.game.deleteSide('friend').removed, 1);
  assert.equal(f.state().rounds.length, 0); assert.equal(fs.existsSync(file), false);
});
