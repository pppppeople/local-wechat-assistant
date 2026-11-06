'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parsePairWishCommand: parse } = require('../src/pair-wish-commands');
const { createPairWishStore } = require('../src/pair-wish-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-wish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  let time = Date.parse('2026-10-31T15:59:59Z');
  const options = { stateFile, now: () => time, random: () => 0 };
  const store = createPairWishStore(options);
  return { root, stateFile, store, options, advance: ms => { time += ms; },
    state: () => readRecordState(stateFile), say: (text, side = 'owner') => store.handle(side, parse(text)) };
}


test('exact commands reject quoted, negated and peer-list requests', () => {
  for (const text of ['他说存一个小心愿：喝茶', '不要心愿完成了', '对方的心愿', '我的心愿有哪些', '删掉我的第0个心愿', {}]) assert.equal(parse(text), null);
  assert.deepEqual(parse('存一个小心愿： 喝茶 '), { type: 'add', text: '喝茶' });
});

test('both namespaces are isolated; only drawn item is disclosed and marked; cold completion retains time', t => {
  const f = fixture(t);
  f.say('存一个小心愿：私人甲');
  f.say('存一个小心愿：秘密乙');
  f.say('存一个小心愿：好友丙', 'friend');
  assert.doesNotMatch(f.say('我的心愿'), /好友丙/);
  assert.doesNotMatch(f.say('我的心愿', 'friend'), /私人甲|秘密乙/);
  assert.match(f.say('我的心愿'), /未公开/);
  const drawn = f.say('抽一个对方的小心愿', 'friend');
  assert.match(drawn, /私人甲/);
  assert.doesNotMatch(drawn, /秘密乙/);
  assert.match(f.say('我的心愿'), /私人甲（已被对方抽中）/);
  assert.equal(f.say('抽一个对方的小心愿', 'friend').includes('秘密乙'), false);
  assert.match(f.say('心愿完成了'), /没有抽中/);
  assert.match(createPairWishStore(f.options).handle('friend', parse('心愿完成了')), /留下完成时间/);
  assert.match(f.say('我的心愿'), /私人甲（已完成，完成时间：2026-10-31T15:59:59.000Z）/);
  assert.match(f.say('抽一个对方的小心愿', 'friend'), /秘密乙/);
});

test('return cooldown persists across restart until next Shanghai date; unlimited returns', t => {
  const f = fixture(t);
  f.say('存一个小心愿：喝茶');
  for (let i = 0; i < 3; i++) {
    assert.match(f.say('抽一个对方的小心愿', 'friend'), /喝茶/);
    assert.match(f.say('换个心愿', 'friend'), /已放回/);
    assert.match(f.say('我的心愿'), /未公开/);
    assert.match(createPairWishStore(f.options).handle('friend', parse('抽一个对方的小心愿')), /没有可抽/);
    f.advance(i === 0 ? 1000 : 86400000);
  }
  assert.match(f.say('抽一个对方的小心愿', 'friend'), /喝茶/);
});

test('deletion removes body, invalidates held relationship and next operation explains without mutation', t => {
  for (const operation of ['心愿完成了', '换个心愿', '抽一个对方的小心愿', '存一个小心愿：不要写入']) {
    const f = fixture(t);
    f.say('存一个小心愿：删我');
    f.say('抽一个对方的小心愿', 'friend');
    const index = JSON.parse(fs.readFileSync(f.stateFile));
    const body = path.join(f.root, index.owner_wishes[0].file);
    f.say('删掉我的第1个心愿');
    assert.equal(fs.existsSync(body), false);
    assert.match(createPairWishStore(f.options).handle('friend', parse(operation)), /已被创建者删除.*失效/);
    assert.equal(f.state().friend_wishes.length, 0);
    assert.match(f.say('心愿完成了', 'friend'), /没有抽中/);
  }
});

test('independent unfinished cap; completed items free capacity; empty and oversized add refuse', t => {
  const f = fixture(t);
  assert.match(f.say('存一个小心愿：'), /1–500/);
  assert.match(f.say('存一个小心愿：' + '字'.repeat(501)), /1–500/);
  for (let i = 0; i < 20; i++) f.say(`存一个小心愿：第${i}条`);
  assert.match(f.say('存一个小心愿：满了'), /20 条上限/);
  assert.match(f.say('存一个小心愿：另一方', 'friend'), /已存下/);
  f.say('抽一个对方的小心愿', 'friend'); f.say('心愿完成了', 'friend');
  assert.match(f.say('存一个小心愿：新条目'), /已存下/);
  assert.equal(f.state().owner_wishes.length, 21);
  assert.throws(() => f.store.handle('outsider', { type: 'list' }), /invalid wish side/);
});

test('strict corruption quarantines index and preserves body; missing and invalid bodies fail visibly', t => {
  for (const kind of ['json', 'schema', 'body', 'invalid-body']) {
    const f = fixture(t);
    f.say('存一个小心愿：保全原件');
    const index = JSON.parse(fs.readFileSync(f.stateFile));
    const body = path.join(f.root, index.owner_wishes[0].file);
    if (kind === 'body') fs.rmSync(body);
    else if (kind === 'invalid-body') fs.writeFileSync(body, '{}');
    else fs.writeFileSync(f.stateFile, kind === 'json' ? '{' : '{}');
    assert.throws(() => f.say('我的心愿'), /损坏.*隔离保全/);
    assert.ok(fs.readdirSync(f.root).some(x => x.includes('.corrupt-')));
    if (kind !== 'body') assert.equal(fs.existsSync(body), true);
  }
});

test('deleteSide only deletes contributor wishes, invalidates peer hold and releases own hold', t => {
  const f = fixture(t);
  f.say('存一个小心愿：主人'); f.say('存一个小心愿：好友', 'friend');
  f.say('抽一个对方的小心愿'); f.say('抽一个对方的小心愿', 'friend');
  assert.deepEqual(f.store.deleteSide('friend'), { removed: 1 });
  assert.equal(f.state().owner_wishes[0].status, 'hidden');
  assert.match(f.say('心愿完成了'), /失效/);
  assert.match(f.say('我的心愿'), /主人/);
});
