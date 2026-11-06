'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePriceNoteCommand: parse } = require('../src/price-note-commands');
const { createPriceNoteStore: create } = require('../src/price-note-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'price-note-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-31T16:30:00Z');
  const stateFile = path.join(root, 'prices/state.json');
  const options = { stateFile, now: () => clock }, store = create(options);
  return { root, stateFile, options, store, read: () => readRecordState(stateFile),
    say: text => store.handle('owner', parse(text)), advance: () => { clock += 86400000; } };
}



test('friend and unknown sides refused before accessing storage for all commands', t => {
  const f = fixture(t);
  for (const side of ['friend', 'unknown']) {
    for (const text of ['记价格：牛奶 12', '比价：牛奶', '牛奶最低价', '删价格：牛奶 超市', '记价格：牛奶 abc']) {
      assert.match(f.store.handle(side, parse(text)), /仅主人/);
    }
  }
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('unsupported operation on an existing item preserves its price records', t => {
  const f = fixture(t);
  f.say('记价格：牛奶 12元 超市');
  const before = f.read(), index = fs.readFileSync(f.stateFile, 'utf8');
  assert.equal(f.store.handle('owner', { type: 'unsupported', name: '牛奶' }), '不支持这个价格操作。');
  assert.deepEqual(f.read(), before);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.match(f.say('比价：牛奶'), /超市｜12元/);
});

test('life-box normalization, exact before inclusion, unique inclusion and ambiguity never guesses or writes', t => {
  const f = fixture(t);
  f.say('记价格：蓝色牛奶 12元 超市'); f.say('记价格：红色牛奶 15元 超市');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const text of ['比价：牛奶', '牛奶最低价', '删价格：牛奶 超市', '记价格：牛奶 1元 超市']) {
    assert.match(f.say(text), /多个物品.*更具体/);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  }
  assert.match(f.say('比价：蓝色'), /蓝色牛奶.*\n超市｜12元/);
  f.say('记价格：牛奶 2元 超市'); // Still ambiguous; no new item.
  const g = create({ stateFile: path.join(f.root, 'exact/state.json') });
  g.handle('owner', parse('记价格：牛奶 3元 超市'));
  // Seed distinct supported records to verify exact matching even with a containing name.
  const { writeRecordState } = require('../src/record-state');
  const state = readRecordState(path.join(f.root, 'exact/state.json'));
  state.prices.push({ ...state.prices[0], id: 'extra', name: '备用牛奶', amount: 20 });
  writeRecordState(path.join(f.root, 'exact/state.json'), state, ['prices']);
  assert.match(g.handle('owner', parse('比价：牛奶')), /超市｜3元/);
  assert.doesNotMatch(g.handle('owner', parse('比价：牛奶')), /20元/);
  f.say('记价格：ＡＢＣ－奶 5元 商店');
  assert.match(f.say('比价：abc奶'), /商店｜5元/);
});

test('corrupt state fails closed and preserves evidence', t => {
  const f = fixture(t); f.say('记价格：牛奶 12');
  fs.writeFileSync(f.stateFile, '{broken');
  assert.throws(() => f.say('记价格：牛奶 13'), /隔离保全/);
  assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')));
});
