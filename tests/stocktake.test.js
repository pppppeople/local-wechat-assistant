'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStocktake, parseStocktakeCommand: parse, REFUSAL } = require('../src/stocktake-commands');
const { createSharedLifeStore } = require('../src/shared-life-store');
const { readRecordState } = require('../src/record-state');

function fixture(t, initial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stocktake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'shared-life', 'state.json');
  if (initial) { fs.mkdirSync(path.dirname(stateFile)); fs.writeFileSync(stateFile, JSON.stringify({ inventory: initial })); }
  const store = createSharedLifeStore({ stateFile });
  const calls = [];
  let reads = 0;
  const inventory = {
    readInventory: side => { reads++; return store.readInventory(side); },
    execute: (side, command) => { calls.push({ side, command }); return store.execute(side, command); },
  };
  const stocktake = createStocktake({ inventory });
  return { root, store, inventory, stocktake, calls, reads: () => reads,
    run: text => stocktake.execute('owner', parse(text)),
    add: (name, state = 'stocked', quantity = '') => store.execute('owner', { type: 'inventory_set', name, state, quantity }),
    saved: () => readRecordState(stateFile, { inventory: [] }).inventory,
  };
}



test('preview preserves raw status and free quantity; no writes, sums, categories or conversion', async t => {
  const f = fixture(t);
  f.add('牛奶', 'low', '半盒 + 两小瓶'); f.add('纸巾', 'needed', ''); f.add('洗衣液', 'stocked', '约一桶');
  const before = f.saved();
  const result = await f.run('物品盘点');
  assert.equal(result.wrote, false); assert.equal(f.calls.length, 0);
  for (const text of ['牛奶｜状态：low｜数量：半盒 + 两小瓶', '纸巾｜状态：needed｜数量：\n', '洗衣液｜状态：stocked｜数量：约一桶']) assert.ok(result.reply.includes(text));
  assert.doesNotMatch(result.reply, /分类|总计|合计|0盒|0瓶|默认/);
  assert.deepEqual(f.saved(), before);
  const selected = await f.run('开始盘点：洗衣液、牛奶');
  assert.ok(selected.reply.indexOf('洗衣液') < selected.reply.indexOf('牛奶'));
  assert.doesNotMatch(selected.reply, /纸巾/);
});

test('explicit confirmation writes each selected existing item through inventory_set once; reports remaining items', async t => {
  const f = fixture(t); f.add('牛奶', 'low', '半盒'); f.add('纸巾', 'needed'); f.add('洗衣液', 'stocked', '两桶');
  const ids = f.saved().map(row => row.id);
  await f.run('物品盘点');
  const result = await f.run('确认盘点 1、3');
  assert.equal(result.wrote, true);
  assert.deepEqual(f.calls, [
    { side: 'owner', command: { type: 'inventory_set', name: '牛奶', state: 'low', quantity: '半盒' } },
    { side: 'owner', command: { type: 'inventory_set', name: '洗衣液', state: 'stocked', quantity: '两桶' } },
  ]);
  assert.match(result.reply, /已确认：牛奶、洗衣液\n未确认：纸巾/);
  assert.deepEqual(f.saved().map(row => row.id), ids);
  assert.match((await f.run('确认盘点')).reply, /已完成或已处理/);
  assert.equal(f.calls.length, 2);
});

test('confirm all, cancellation and invalid selection have precise zero-write behavior', async t => {
  const f = fixture(t); f.add('牛奶'); f.add('纸巾');
  await f.run('物品盘点');
  assert.equal((await f.run('确认盘点 0')).wrote, false);
  assert.equal((await f.run('确认盘点 9')).wrote, false);
  await f.run('取消盘点'); await f.run('确认盘点');
  assert.equal(f.calls.length, 0);
  await f.run('开始盘点');
  assert.match((await f.run('确认盘点')).reply, /已确认：牛奶、纸巾\n未确认：无/);
  assert.equal(f.calls.length, 2);
});

test('missing names and normalized duplicate names reject whole preview and list collisions', async t => {
  const update = { side: 'owner', state: 'stocked', quantity: '两盒', at: '2026-11-01T00:00:00Z' };
  const f = fixture(t, [{ id: 'IV-1', name: '牛奶', updates: [update] }, { id: 'IV-2', name: '牛 奶', updates: [update] }]);
  for (const text of ['物品盘点：牛奶', '开始盘点']) {
    const result = await f.run(text);
    assert.match(result.reply, /同名.*歧义/); assert.match(result.reply, /牛奶（IV-1）/); assert.match(result.reply, /牛 奶（IV-2）/);
    await f.run('确认盘点');
  }
  assert.match((await f.run('物品盘点：不存在')).reply, /没有.*未新建/);
  assert.equal(f.calls.length, 0);
});

test('friend rejects every command without storage reads; no inventory disclosure', async () => {
  const inventory = { readInventory: () => { throw Error('must not read'); }, execute: () => { throw Error('must not write'); } };
  const s = createStocktake({ inventory });
  for (const text of ['物品盘点', '物品盘点：秘密物品', '开始盘点', '确认盘点', '确认盘点 1', '取消盘点']) {
    const result = await s.execute('friend', parse(text));
    assert.equal(result.reply, REFUSAL); assert.equal(result.wrote, false);
  }
});

test('new instance discards in-memory pending batch; preview creates no persistence', async t => {
  const f = fixture(t); f.add('牛奶');
  const files = () => fs.readdirSync(f.root, { recursive: true }).sort();
  const before = files(); await f.run('物品盘点');
  const reopened = createStocktake({ inventory: f.inventory });
  assert.match((await reopened.execute('owner', parse('确认盘点'))).reply, /没有待确认/);
  assert.deepEqual(files(), before); assert.equal(f.calls.length, 0);
});

test('deleted or changed inventory never gets recreated or overwritten; failed partial batch is not retried', async t => {
  const f = fixture(t); f.add('牛奶'); f.add('纸巾');
  await f.run('物品盘点');
  f.store.execute('owner', { type: 'inventory_delete', name: '牛奶' }); f.add('纸巾', 'low', '半包');
  assert.match((await f.run('确认盘点')).reply, /未确认：牛奶、纸巾/);
  assert.equal(f.calls.length, 0); assert.equal(f.saved().length, 1);
  f.add('牛奶');
  const partial = createStocktake({ inventory: { readInventory: f.inventory.readInventory, execute: (side, command) => {
    if (command.name === '牛奶') throw Error('synthetic write failure'); return f.inventory.execute(side, command);
  } } });
  await partial.execute('owner', parse('物品盘点'));
  assert.match((await partial.execute('owner', parse('确认盘点'))).reply, /已确认：纸巾\n未确认：牛奶/);
  await partial.execute('owner', parse('确认盘点'));
  assert.equal(f.calls.length, 1);
});
