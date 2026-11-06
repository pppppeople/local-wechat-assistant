'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { parseRandomDrawCommand: parse, splitDrawOptions } = require('../src/random-draw-commands');
const { createRandomDraw } = require('../src/random-draw');
const { createSharedPlaceBox } = require('../src/shared-place-box');
const { writeRecordState } = require('../src/record-state');


const draw = (game, text, side = 'owner') => game.handle(side, parse(text));
function fixture(t, places = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'random-draw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  writeRecordState(stateFile, { schemaVersion: 1, places, views: {} }, ['places']);
  const box = createSharedPlaceBox({ stateFile, provider: {} });
  const snapshot = () => fs.readdirSync(root, { recursive: true }).sort()
    .filter((relative) => fs.statSync(path.join(root, relative)).isFile())
    .map((relative) => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]);
  return { box, stateFile, snapshot };
}



test('parses every prefix, separators including 还是/或, whitespace and duplicate options', () => {
  assert.deepEqual(splitDrawOptions(' 火锅 、 烧烤，寿司, 火锅 还是 面 或 粥 、 ,'), ['火锅', '烧烤', '寿司', '面', '粥']);
  for (const prefix of ['抽签', '帮我抽一个', '抽一个']) {
    for (const colon of ['：', ':']) assert.deepEqual(parse(`${prefix}${colon} 火锅还是烧烤`), { type: 'draw', options: ['火锅', '烧烤'] });
  }
  assert.deepEqual(parse('再抽一次'), { type: 'redraw' });
  for (const text of ['从想去箱抽一个', '想去箱随机选一个']) assert.deepEqual(parse(text), { type: 'place' });
  for (const text of ['', null, '抽签', '不要再抽一次', '他说“抽签：甲、乙”']) assert.equal(parse(text), null);
});

test('rejects unsupported, null and undefined draw commands', () => {
  const game = createRandomDraw({ random: () => 0 });
  for (const command of [{ type: 'bogus' }, null, undefined]) {
    assert.throws(() => game.handle('owner', command), /不支持这个抽签操作/);
  }
});

test('refuses fewer than two unique options without drawing or replacing the previous pool', () => {
  let calls = 0;
  const game = createRandomDraw({ random: () => { calls++; return 0; } });
  for (const text of ['抽签：', '抽一个：甲', '抽签：甲、甲， 甲']) assert.match(draw(game, text), /选项不够/);
  assert.equal(calls, 0);
  assert.match(draw(game, '再抽一次'), /还没有可重抽/);
  assert.equal(draw(game, '抽签：甲、乙'), '抽到了：甲');
  assert.match(draw(game, '抽签：丙'), /选项不够/);
  assert.equal(draw(game, '再抽一次'), '抽到了：乙');
});

test('injected random selects within the pool and redraw excludes only the last winner', () => {
  for (const random of [0, 0.49, 0.999999]) {
    const game = createRandomDraw({ random: () => random });
    assert.ok(['抽到了：甲', '抽到了：乙', '抽到了：丙'].includes(draw(game, '抽签：甲、乙、丙')));
  }
  const game = createRandomDraw({ random: () => 0 });
  assert.equal(draw(game, '抽签：甲、乙'), '抽到了：甲');
  assert.equal(draw(game, '再抽一次'), '抽到了：乙');
  assert.equal(draw(game, '再抽一次'), '抽到了：甲');
});

test('sender pools are separate, clearable and disappear with a fresh instance', () => {
  const game = createRandomDraw({ random: () => 0 });
  draw(game, '抽签：甲、乙');
  assert.match(draw(game, '再抽一次', 'friend'), /还没有可重抽/);
  assert.equal(draw(game, '抽签：丙、丁', 'friend'), '抽到了：丙');
  assert.equal(draw(game, '再抽一次'), '抽到了：乙');
  assert.equal(draw(game, '再抽一次', 'friend'), '抽到了：丁');
  game.clear('friend');
  assert.match(draw(game, '再抽一次', 'friend'), /还没有可重抽/);
  assert.match(draw(createRandomDraw(), '再抽一次'), /还没有可重抽/);
  game.handle('owner', parse('抽签：甲、乙'), 'old-owner');
  assert.match(game.handle('owner', parse('再抽一次'), 'new-owner'), /还没有可重抽/);
  assert.throws(() => draw(game, '抽签：甲、乙', 'stranger'), /invalid/);
});

test('place draws use read-only minimal projections and never pick visited/removed/archived places', (t) => {
  const f = fixture(t, ['visited', 'removed', 'archived', 'active', 'active'].map((status, i) => ({
    id: `p${i}`, name: `地点${i}`, status, address: '不导出地址', createdBy: 'owner',
  })));
  const before = f.snapshot();
  assert.deepEqual(f.box.readDrawPlaces('friend'), [
    { name: '地点0', status: 'visited' }, { name: '地点3', status: 'active' }, { name: '地点4', status: 'active' },
  ]);
  for (const side of ['owner', 'friend']) {
    for (const random of [0, 0.999999]) {
      const game = createRandomDraw({ sharedPlaceBox: f.box, random: () => random });
      assert.equal(draw(game, '从想去箱抽一个', side), random === 0 ? '抽到了：地点3' : '抽到了：地点4');
      assert.equal(draw(game, '再抽一次', side), random === 0 ? '抽到了：地点4' : '抽到了：地点3');
    }
  }
  assert.deepEqual(f.snapshot(), before);
});

test('empty active box and one-place redraw have explicit responses', (t) => {
  const empty = fixture(t, [{ id: 'v', name: '已去', status: 'visited' }]);
  assert.match(draw(createRandomDraw({ sharedPlaceBox: empty.box }), '想去箱随机选一个'), /没有未去/);
  const one = fixture(t, [{ id: 'a', name: '公园', status: 'active' }]);
  const game = createRandomDraw({ sharedPlaceBox: one.box, random: () => 0 });
  assert.equal(draw(game, '想去箱随机选一个'), '抽到了：公园');
  assert.match(draw(game, '再抽一次'), /只剩一个.*没法再排除/);
  // A new place draw rereads the current box rather than a saved list view.
  writeRecordState(one.stateFile, { schemaVersion: 1, places: [{ id: 'a', name: '公园', status: 'visited' }] }, ['places']);
  assert.match(draw(game, '从想去箱抽一个'), /没有未去/);
});

test('missing or corrupt place sources are read-only and failures do not fabricate a result', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.stateFile, '{broken');
  const before = f.snapshot();
  assert.throws(() => draw(createRandomDraw({ sharedPlaceBox: f.box }), '从想去箱抽一个'));
  assert.deepEqual(f.snapshot(), before);
  const missing = createSharedPlaceBox({ stateFile: path.join(path.dirname(f.stateFile), 'missing', 'state.json'), provider: {} });
  assert.match(draw(createRandomDraw({ sharedPlaceBox: missing }), '从想去箱抽一个'), /没有未去/);
  assert.deepEqual(f.snapshot(), before);
});
