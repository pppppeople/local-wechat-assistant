'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInventoryImageCapture, parseInventoryImageCommand: parse } = require('../src/inventory-image-capture');
const { createInventoryImageProvider } = require('../src/inventory-image-provider');
const { createSharedLifeStore } = require('../src/shared-life-store');
const { readRecordState } = require('../src/record-state');
const NOW = Date.parse('2026-10-31T00:00:00Z');
const ITEMS = [
  { name: '洗衣液', quantity: '2瓶', category: '清洁用品' },
  { name: '纸巾', quantity: '', category: '' },
  { name: '牙刷', quantity: '3支', category: '洗护用品' },
];
function fixture(t, extract = () => structuredClone(ITEMS)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'inventory-image-capture', 'state.json');
  const inventoryFile = path.join(root, 'shared-life', 'state.json');
  let clock = NOW;
  const calls = [], writes = [];
  const inventory = createSharedLifeStore({ stateFile: inventoryFile, now: () => clock });
  const store = createInventoryImageCapture({ stateFile, now: () => clock,
    provider: { extract: async args => { calls.push(args); return extract(args); } },
    inventory: { execute: (side, command) => { writes.push({ side, command }); return inventory.execute(side, command); } },
  });
  return { root, stateFile, inventoryFile, calls, writes, inventory, store,
    advance: ms => { clock += ms; },
    run: (text, images = [], side = 'owner') => store.execute(side, parse(text, images, side)),
    preview: () => store.execute('owner', parse('识别一下，加入家里的库存', ['fixture.png'])),
    read: () => readRecordState(stateFile),
    saved: () => readRecordState(inventoryFile, { inventory: [] }).inventory,
  };
}



test('image trigger requires owner and explicit inventory phrase; ordinary pictures remain unclaimed', () => {
  for (const text of ['加入库存', '识别一下，加入家里的库存', '登记到库存', '登记到家庭库存']) {
    assert.equal(parse(text, ['photo.png']).type, 'extract');
    assert.equal(parse(text), null);
    assert.equal(parse(text, ['photo.png'], 'friend'), null);
  }
  for (const text of ['这是什么', '识别一下', '不要加入库存']) assert.equal(parse(text, ['photo.png']), null);
  assert.deepEqual(parse('加入第1、3、1项').numbers, [1, 3]);
  assert.equal(parse('都加入').type, 'confirm_all');
  assert.equal(parse('算了').type, 'discard');
  assert.equal(parse('都加入', [], 'friend'), null);
});

test('single-item preview has zero inventory writes, confirm reuses exact existing inventory fields', async t => {
  const f = fixture(t, () => [ITEMS[0]]);
  const preview = await f.preview();
  assert.match(preview.reply, /1\. 洗衣液｜2瓶｜清洁用品/u);
  assert.equal(fs.existsSync(f.inventoryFile), false);
  assert.equal(f.writes.length, 0);
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(index._recordState.version, 1);
  assert.match(index.pending[0].file, /^records\/pending\/pending\/2026\/10\//u);
  assert.doesNotMatch(JSON.stringify(f.read()), /fixture\.png/u);
  assert.match((await f.run('都加入')).reply, /实际登记了 1 项/u);
  assert.deepEqual(f.writes, [{ side: 'owner', command: { type: 'inventory_set', name: '洗衣液', state: 'stocked', quantity: '2瓶' } }]);
  const [item] = f.saved();
  assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'name', 'provenance', 'updatedAt', 'updates']);
  assert.deepEqual(item.updates, [{ side: 'owner', state: 'stocked', quantity: '2瓶', at: new Date(NOW).toISOString() }]);
  assert.equal(item.provenance.visibility, 'fixed_pair');
  assert.equal(item.createdAt, new Date(NOW).toISOString());
  assert.deepEqual(f.read().pending, []);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), index.pending[0].file)), false);
  await f.run('都加入');
  assert.equal(f.writes.length, 1);
  await f.preview(); await f.run('都加入');
  assert.equal(f.saved().length, 1, 'same name updates original stock record');
  assert.equal(f.saved()[0].updates.length, 2);
});

test('multiple items numbered; unknown quantity/category explicit; all selected items use original stock path', async t => {
  const f = fixture(t);
  const preview = await f.preview();
  assert.match(preview.reply, /2\. 纸巾｜数量待填｜未分类/u);
  assert.match(preview.reply, /3\. 牙刷｜3支｜洗护用品/u);
  assert.equal(f.writes.length, 0);
  const result = await f.run('都加入');
  assert.match(result.reply, /实际登记了 3 项/u);
  assert.equal(f.saved().find(item => item.name === '纸巾').updates[0].quantity, '数量待填');
});

test('selected items deduplicate, report invalid numbers and consume entire preview', async t => {
  const f = fixture(t);
  await f.preview();
  const reply = (await f.run('加入第1、3、1、0、9项')).reply;
  assert.match(reply, /实际登记了 2 项/u);
  assert.match(reply, /越界序号：0、9/u);
  assert.deepEqual(f.saved().map(item => item.name), ['洗衣液', '牙刷']);
  assert.equal(f.store.hasPending(), false);
  await f.run('加入第2项');
  assert.equal(f.writes.length, 2);
});

test('cancel and confirmations without pending never touch inventory', async t => {
  const f = fixture(t);
  for (const text of ['都加入', '加入第1项', '算了']) assert.match((await f.run(text)).reply, /没有待确认/u);
  assert.deepEqual(fs.readdirSync(f.root), []);
  await f.preview();
  assert.match((await f.run('算了')).reply, /取消.*没有写入/u);
  assert.equal(f.store.hasPending(), false);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(f.inventoryFile), false);
});

test('30-minute expiry refuses confirmation; admission is read-only, pending survives reopening', async t => {
  const f = fixture(t);
  await f.preview();
  const reopened = createInventoryImageCapture({ stateFile: f.stateFile, inventory: f.inventory, now: () => NOW });
  assert.equal(reopened.hasPending(), true);
  f.advance(30 * 60 * 1000 - 1);
  assert.equal(f.store.hasPending(), true);
  f.advance(1);
  const index = fs.readFileSync(f.stateFile, 'utf8');
  assert.equal(f.store.hasPending(), false);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.match((await f.run('都加入')).reply, /没有待确认.*过期/u);
  assert.deepEqual(f.read().pending, []);
  assert.equal(f.writes.length, 0);
});

test('friend is silent and unclaimed with no file/model/inventory access', async t => {
  const f = fixture(t);
  for (const type of ['extract', 'confirm_all', 'discard']) assert.equal(await f.store.execute('friend', { type, imagePaths: ['friend.png'] }), null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('unsupported inventory-image commands refuse before storage and preserve a confirmable preview', async t => {
  const f = fixture(t);
  await f.preview();
  const before = f.read();
  const original = fs.readFileSync(f.stateFile, 'utf8');
  const reads = t.mock.method(fs, 'readFileSync', () => { throw Error('unexpected state read'); });
  const writes = t.mock.method(fs, 'writeFileSync', () => { throw Error('unexpected state write'); });
  for (const command of [null, undefined, {}, { type: 'unsupported' }]) {
    assert.deepEqual(await f.store.execute('owner', command), {
      reply: '不支持这个库存图片操作。', wrote: false, continue: false,
    });
  }
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(writes.mock.callCount(), 0);
  reads.mock.restore(); writes.mock.restore();
  assert.equal(f.calls.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), original);
  assert.deepEqual(f.read(), before);
  assert.equal(fs.existsSync(f.inventoryFile), false);
  assert.match((await f.run('加入第1项')).reply, /实际登记了 1 项/u);
  assert.equal(f.writes.length, 1);
  assert.equal(f.saved().length, 1);
});

test('empty, failed, malformed recognition clears old preview without inventory writes', async t => {
  let output = ITEMS;
  const f = fixture(t, () => { if (output instanceof Error) throw output; return output; });
  for (const invalid of [[], Error('offline'), [{ name: '缺字段' }], [{ ...ITEMS[0], quantity: null }]]) {
    output = ITEMS; await f.preview();
    output = invalid;
    assert.match((await f.preview()).reply, /没识别到/u);
    assert.equal(f.store.hasPending(), false);
    await f.run('都加入');
    assert.equal(f.writes.length, 0);
  }
  const empty = fixture(t, () => []);
  await empty.preview();
  assert.deepEqual(fs.readdirSync(empty.root), []);
});

test('invalid saved preview is read-only during admission and quarantined on confirmation without inventory writes', async t => {
  const record = { id: 'preview-1', createdAt: new Date(NOW).toISOString(), items: ITEMS };
  const invalidStates = [
    { schemaVersion: 2, pending: [record] },
    { schemaVersion: 1, pending: {} },
    { schemaVersion: 1, pending: [record, { ...record, id: 'preview-2' }] },
    ...[{ id: '' }, { createdAt: 'invalid' }].map(override =>
      ({ schemaVersion: 1, pending: [{ ...record, ...override }] })),
  ];
  for (const state of invalidStates) {
    const f = fixture(t), dir = path.dirname(f.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const original = JSON.stringify(state);
    fs.writeFileSync(f.stateFile, original);
    assert.equal(f.store.hasPending(), false);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    await assert.rejects(f.run('都加入'), error => {
      assert.match(error.message, /已隔离保全.*本次操作未执行/u);
      assert.equal(error.cause.message, '库存图片待确认存储格式无效');
      return true;
    });
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('state.json.corrupt-'));
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), original);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(fs.existsSync(f.inventoryFile), false);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
  }
});

test('latest preview and concurrent confirmation serialize, failed inventory batch is never retried', async t => {
  let count = 0;
  const f = fixture(t, () => [{ ...ITEMS[0], name: `物品${++count}` }]);
  await f.preview();
  await Promise.all([f.preview(), f.run('都加入')]);
  assert.equal(f.saved()[0].name, '物品2');
  let writes = 0;
  const store = createInventoryImageCapture({ stateFile: f.stateFile,
    provider: { extract: async () => ITEMS },
    inventory: { execute: () => { writes++; throw Error('disk'); } }, now: () => NOW,
  });
  await store.execute('owner', parse('加入库存', ['image.png']));
  const reply = (await store.execute('owner', parse('都加入'))).reply;
  assert.match(reply, /实际登记了 0 项/u);
  assert.match(reply, /后续项未执行/u);
  await store.execute('owner', parse('都加入'));
  assert.equal(writes, 1);
});

test('production adapter reuses fresh structured image turn and rejects malformed output', async () => {
  let args;
  const provider = createInventoryImageProvider({ model: async (...input) => {
    args = input; return { ok: true, value: input[3].parse(JSON.stringify({ items: ITEMS })) };
  } });
  assert.deepEqual(await provider.extract({ text: '加入库存', imagePaths: ['a.png'] }), ITEMS);
  assert.equal(args[1], '');
  assert.deepEqual(args[2], ['a.png']);
  assert.equal(args[3].stage, 'inventory_image_extract');
  assert.equal(args[3].schema.additionalProperties, false);
  assert.match(args[0], /不能猜测/u);
  for (const text of ['bad', '{"items":[{}]}', '{"items":[],"extra":true}']) assert.throws(() => args[3].parse(text));
  for (const response of [{ ok: false }, { ok: true, value: { items: [{}] } }]) {
    await assert.rejects(createInventoryImageProvider({ model: async () => response }).extract({ text: '', imagePaths: ['a.png'] }));
  }
});
