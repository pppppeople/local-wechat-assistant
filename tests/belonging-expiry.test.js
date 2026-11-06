'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedLifeStore } = require('../src/shared-life-store');
const { parseSharedLifeCommand: parse } = require('../src/shared-life-commands');
const { readRecordState } = require('../src/record-state');





function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belonging-expiry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'life.json');
  if (initial) fs.writeFileSync(stateFile, JSON.stringify(initial));
  let clock = Date.parse('2026-10-31T16:30:00Z'); // Shanghai Nov 1, UTC Oct 31
  const reopen = () => createSharedLifeStore({ stateFile, now: () => clock });
  const store = reopen();
  return { dir, stateFile, store, reopen, setClock: value => { clock = Date.parse(value); },
    read: () => readRecordState(stateFile),
    run: (text, side = 'owner') => store.execute(side, parse(text, { now: clock })),
    add: (name, side = 'owner') => store.execute(side, { type: 'belonging_set', name, location: '冰箱' }),
  };
}



test('sets, updates, queries, clears and reopens classified expiry without losing other fields', t => {
  const f = fixture(t);
  f.add('牛奶');
  const before = f.read().belongings[0];
  assert.equal(f.run('设置保质期 牛奶 2026-11-20').wrote, true);
  assert.equal(f.read().belongings[0].expiresAt, '2026-11-20');
  assert.match(f.reopen().handle('owner', parse('保质期查询 牛奶')), /2026-11-20.*临期，剩 19 天/);
  assert.equal(f.run('设置保质期：牛奶 2026-12-10').wrote, true);
  assert.match(f.run('查询保质期 牛奶').reply, /未到期，剩 39 天/);
  assert.equal(f.run('清除保质期 牛奶').wrote, true);
  const { updatedAt, ...after } = f.read().belongings[0];
  const { updatedAt: oldTime, ...original } = before;
  assert.deepEqual(after, original);
  assert.equal(Object.hasOwn(f.read().belongings[0], 'expiresAt'), false);
  assert.match(f.run('保质期查询 牛奶').reply, /未设置保质期/);
  assert.equal(f.run('清除保质期 牛奶').wrote, false);
  assert.match(f.reopen().handle('owner', parse('保质期查询 牛奶')), /未设置保质期/);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile))._recordState.version, 1);
});

test('Shanghai list distinguishes expired and inclusive 0..30-day window; queries never write', t => {
  const f = fixture(t);
  for (const [name, date] of [['远期', '2026-12-02'], ['三十天', '2026-12-01'], ['今天', '2026-11-01'], ['昨天', '2026-10-31'], ['很久以前', '2024-02-29']]) {
    f.add(name); f.run(`设置保质期 ${name} ${date}`);
  }
  f.add('无日期');
  const snapshot = f.read();
  const index = fs.readFileSync(f.stateFile, 'utf8');
  const result = f.run('保质期列表');
  assert.equal(result.wrote, false);
  assert.deepEqual(result.reply.split('\n').slice(1).map(line => line.split('｜')[0]), ['很久以前', '昨天', '今天', '三十天']);
  assert.match(result.reply, /昨天｜2026-10-31｜已过期 1 天/);
  assert.match(result.reply, /今天｜2026-11-01｜临期，剩 0 天/);
  assert.match(result.reply, /三十天｜2026-12-01｜临期，剩 30 天/);
  assert.doesNotMatch(result.reply, /远期|无日期/);
  f.setClock('2026-11-01T15:59:59Z');
  assert.match(f.run('保质期查询 今天').reply, /剩 0 天/);
  f.setClock('2026-11-01T16:00:00Z');
  assert.match(f.run('保质期查询 今天').reply, /已过期 1 天/);
  assert.deepEqual(f.read(), snapshot);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
});

test('ambiguity refuses query/set/clear, lists candidates, and never changes first match', t => {
  const f = fixture(t);
  f.add('鲜牛奶'); f.add('酸牛奶');
  const before = f.read();
  for (const cmd of ['保质期查询 牛奶', '设置保质期 牛奶 2026-12-01', '清除保质期 牛奶']) {
    const result = f.run(cmd);
    assert.equal(result.continue, false);
    assert.equal(result.wrote, false);
    assert.match(result.reply, /相近记录.*鲜牛奶、酸牛奶/);
    assert.deepEqual(f.read(), before);
  }
  assert.equal(f.run('设置保质期 鲜牛奶 2026-12-01').wrote, true);
});

test('duplicate normalized exact names also refuse; unique exact name follows existing lookup', t => {
  const f = fixture(t, { belongings: [
    { id: 'A', ownerSide: 'owner', name: 'Ａ-B' }, { id: 'B', ownerSide: 'owner', name: 'a_b' },
  ] });
  for (const cmd of ['保质期查询 ab', '设置保质期 ab 2026-12-01', '清除保质期 ab']) {
    assert.match(f.run(cmd).reply, /2 条相近记录.*Ａ-B、a_b/);
  }
  const g = fixture(t);
  g.add('牛奶'); g.add('备用牛奶');
  assert.equal(g.run('设置保质期 牛奶 2026-12-01').wrote, true);
  assert.equal(g.read().belongings[1].expiresAt, undefined);
});

test('missing records and unset expiry are explicit, without fabricated dates or creation', t => {
  const f = fixture(t);
  for (const cmd of ['保质期查询 牛奶', '设置保质期 牛奶 2026-12-01', '清除保质期 牛奶']) {
    const result = f.run(cmd);
    assert.match(result.reply, /未找到/);
    assert.doesNotMatch(result.reply, /2026-12-01/);
    assert.equal(result.wrote, false);
    assert.equal(result.continue, false);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
  assert.match(f.run('保质期列表').reply, /暂无/);
  f.add('牛奶');
  assert.match(f.run('保质期查询 牛奶').reply, /未设置保质期/);
  assert.match(f.run('保质期列表').reply, /暂无/);
});

test('both sides are isolated for query/list/set/clear, even identical names', t => {
  const f = fixture(t);
  f.add('主人牛奶'); f.run('设置保质期 主人牛奶 2026-11-02');
  f.add('好友牛奶', 'friend'); f.run('设置保质期 好友牛奶 2026-11-03', 'friend');
  for (const [side, other] of [['owner', '好友牛奶'], ['friend', '主人牛奶']]) {
    const before = f.read();
    for (const cmd of [`保质期查询 ${other}`, `设置保质期 ${other} 2026-12-01`, `清除保质期 ${other}`]) assert.match(f.run(cmd, side).reply, /未找到/);
    assert.doesNotMatch(f.run('保质期列表', side).reply, new RegExp(other));
    assert.deepEqual(f.read(), before);
  }
  for (const side of ['owner', 'friend']) { f.add('同名奶', side); f.run(`设置保质期 同名奶 ${side === 'owner' ? '2026-11-05' : '2026-11-06'}`, side); }
  assert.match(f.run('保质期查询 同名奶').reply, /2026-11-05/);
  assert.match(f.run('保质期查询 同名奶', 'friend').reply, /2026-11-06/);
  assert.throws(() => f.run('保质期列表', 'other'), /invalid shared life side/);
});

test('purchase/warranty/location/inventory behavior remains independent in both directions', t => {
  const f = fixture(t);
  f.add('牛奶'); f.run('登记购买 牛奶 10元 保修1年 2025-11-01');
  f.run('纸巾没了');
  const warranty = f.run('保修查询 牛奶').reply;
  const warrantyList = f.run('哪些东西快过保了').reply;
  const location = f.run('牛奶放哪了').reply;
  const inventory = f.run('家里缺什么').reply;
  const purchase = f.read().belongings[0].purchase;
  f.run('设置保质期 牛奶 2026-10-31');
  assert.deepEqual(f.read().belongings[0].purchase, purchase);
  assert.equal(f.run('保修查询 牛奶').reply, warranty);
  assert.equal(f.run('哪些东西快过保了').reply, warrantyList);
  assert.equal(f.run('牛奶放哪了').reply, location);
  assert.equal(f.run('家里缺什么').reply, inventory);
  f.run('登记购买 牛奶 20元 保修2年 2026-11-01'); f.add('牛奶');
  assert.equal(f.read().belongings[0].expiresAt, '2026-10-31');
  assert.match(f.run('保修查询 牛奶').reply, /20元.*2028-11-01.*在保/);
  const newPurchase = f.read().belongings[0].purchase;
  f.run('清除保质期 牛奶');
  assert.deepEqual(f.read().belongings[0].purchase, newPurchase);
});
