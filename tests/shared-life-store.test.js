'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createSharedLifeStore } = require('../src/shared-life-store');

const epoch = Date.parse('2026-08-24T12:00:00.000Z');
const iso = (offset = 0) => new Date(epoch + offset).toISOString();

function fixture(t, state, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-life-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'life.json');
  if (state !== undefined) fs.writeFileSync(stateFile, JSON.stringify(state));
  const reopen = () => createSharedLifeStore({ stateFile, now: () => epoch, ...options });
  return { directory, stateFile, store: reopen(), reopen };
}

function snapshot(directory) {
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else files.push([name, fs.readFileSync(path.join(directory, name), 'utf8')]);
    }
  }
  visit('');
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function lists(store, side = 'owner') {
  return ['belonging_list', 'commitment_list', 'inventory_list'].map((type) => store.handle(side, { type }));
}

test('help describes all four lightweight shared life features', (t) => {
  const { store } = fixture(t);
  const reply = store.handle('owner', { type: 'help' });
  for (const text of ['生活箱现在有四个轻量功能', '物品位置', '双人约定', '共享库存', '文字时间胶囊']) {
    assert.ok(reply.includes(text));
  }
});

test('capsule_list returns the scheduler response for the requesting side', (t) => {
  const { store } = fixture(t, undefined, {
    capsuleScheduler: {
      listTimeCapsules: (side) => `时间胶囊列表：${side}`,
    },
  });
  assert.equal(store.handle('owner', { type: 'capsule_list' }), '时间胶囊列表：owner');
});

test('capsule_cancel returns the scheduler response for the requested id', (t) => {
  const { store } = fixture(t, undefined, {
    capsuleScheduler: {
      cancelTimeCapsule: (side, id) => `已取消时间胶囊：${id}`,
    },
  });
  assert.equal(store.handle('owner', { type: 'capsule_cancel', id: 7 }), '已取消时间胶囊：7');
});

test('rejects invalid sides, commands, fields and secrets without changing saved state', (t) => {
  const { store, directory } = fixture(t);
  store.handle('owner', { type: 'belonging_set', name: '原物品', location: '原位置' });
  const before = snapshot(directory);
  for (const operation of [
    () => store.handle('stranger', { type: 'help' }),
    () => store.execute('stranger', { type: 'help' }),
    () => store.explain('stranger', '原物品'),
    () => store.deleteSide('stranger'),
  ]) assert.throws(operation, /invalid shared life side/);
  for (const command of [null, undefined, 'help', 1]) {
    assert.throws(() => store.handle('owner', command), /生活箱指令无效/);
  }
  for (const command of [{}, { type: 'unknown' }]) {
    assert.throws(() => store.execute('owner', command), /不支持这个生活箱操作/);
  }
  const cases = [
    [{ type: 'belonging_set', name: ' ', location: '书桌' }, /请同时说清楚/],
    [{ type: 'belonging_set', name: '钥匙', location: '。！!~～' }, /请同时说清楚/],
    [{ type: 'commitment_add', text: ' ' }, /约定内容不能为空/],
    [{ type: 'inventory_set', name: '', state: 'needed' }, /请说清楚/],
    [{ type: 'inventory_set', name: '纸巾', state: 'unknown' }, /库存状态不支持/],
    [{ type: 'belonging_set', name: 'token=example', location: '书桌' }, /疑似包含/],
    [{ type: 'belonging_set', name: '钥匙', location: '密码：example' }, /疑似包含/],
    [{ type: 'commitment_add', text: 'cookie: example' }, /疑似包含/],
    [{ type: 'inventory_set', name: 'api-key=example', state: 'needed' }, /疑似包含/],
    [{ type: 'inventory_set', name: '纸巾', state: 'low', quantity: 'secret=example' }, /疑似包含/],
  ];
  for (const [command, expected] of cases) assert.throws(() => store.handle('owner', command), expected);
  for (const type of ['capsule_create', 'capsule_list', 'capsule_cancel']) {
    assert.throws(() => store.handle('owner', { type }), /时间胶囊调度尚未启用/);
  }
  assert.deepEqual(snapshot(directory), before);
});

test('normalizes invalid collections and preserves legacy inline records across a save', (t) => {
  const empty = fixture(t, { schemaVersion: 0, belongings: {}, commitments: null, inventory: 'old' });
  assert.match(lists(empty.store)[0], /还没记录/);
  assert.match(lists(empty.store)[1], /没有记录双人约定/);
  assert.match(lists(empty.store)[2], /还是空的/);
  empty.store.handle('owner', { type: 'inventory_set', name: '纸巾', state: 'needed' });
  assert.match(lists(empty.reopen())[2], /纸巾/);

  const legacy = fixture(t, {
    belongings: [{ id: 'BL-OLD', ownerSide: 'owner', name: '旧钥匙', location: '旧抽屉', updatedAt: iso() }],
    commitments: [{ id: 'CM-OLD', text: '旧约定', createdBy: 'friend', status: 'open', createdAt: iso(), updatedAt: iso() }],
    inventory: [{ id: 'IV-OLD', name: '旧库存', updates: [{ side: 'friend', state: 'low', quantity: '一份', at: iso() }] }],
  });
  const before = lists(legacy.store);
  legacy.store.handle('owner', { type: 'belonging_set', name: '新钥匙', location: '新抽屉' });
  const reopened = lists(legacy.reopen());
  assert.match(reopened[0], /旧钥匙｜旧抽屉/);
  assert.match(reopened[0], /新钥匙｜新抽屉/);
  assert.deepEqual(reopened.slice(1), before.slice(1));
});

test('normalizes belonging duplicates and prefers exact matches over ambiguous partial matches', (t) => {
  const { store, directory, reopen } = fixture(t);
  store.handle('owner', { type: 'belonging_set', name: 'Ａ-B', location: '旧位置' });
  store.handle('owner', { type: 'belonging_set', name: ' a b！ ', location: '新位置。！~' });
  assert.equal(store.handle('owner', { type: 'belonging_list' }).split('\n').length, 2);
  assert.equal(store.handle('owner', { type: 'belonging_query', name: 'ab' }), 'Ａ-B在新位置。');
  store.handle('owner', { type: 'belonging_set', name: 'AB备用', location: '备用位置' });
  assert.equal(store.handle('owner', { type: 'belonging_query', name: 'ab' }), 'Ａ-B在新位置。');
  const before = snapshot(directory);
  assert.match(store.handle('owner', { type: 'belonging_query', name: 'a' }), /2 条相近记录/);
  assert.match(store.handle('owner', { type: 'belonging_delete', name: 'a' }), /2 条相近位置记录/);
  assert.match(store.handle('owner', { type: 'belonging_delete', name: '不存在' }), /什么都没删/);
  assert.match(store.handle('owner', { type: 'belonging_query', name: '！' }), /还没记录/);
  assert.deepEqual(snapshot(directory), before);
  store.handle('owner', { type: 'belonging_delete', name: 'ab' });
  const remaining = reopen().handle('owner', { type: 'belonging_list' });
  assert.match(remaining, /AB备用/);
  assert.doesNotMatch(remaining, /Ａ-B｜/);
});

test('trims and truncates stored text at the implemented field boundaries', (t) => {
  const { store, reopen } = fixture(t);
  const name = '物'.repeat(80);
  const location = '位'.repeat(160);
  store.handle('owner', { type: 'belonging_set', name: ` ${name}尾 `, location: ` ${location}尾 ` });
  assert.equal(store.handle('owner', { type: 'belonging_query', name }), `${name}在${location}。`);
  const text = '约'.repeat(240);
  store.handle('owner', { type: 'commitment_add', text: ` ${text}尾 ` });
  const quantity = '量'.repeat(50);
  store.handle('owner', { type: 'inventory_set', name: ` ${name}尾 `, state: 'low', quantity: ` ${quantity}尾 ` });
  const saved = lists(reopen());
  assert.ok(saved[1].includes(`｜${text}｜`));
  assert.ok(saved[2].includes(`${name}｜只剩${quantity}｜`));
  assert.ok(saved.every((value) => !value.includes('尾')));
});

test('deduplicates open commitments across sides and refuses ambiguous or unauthorized changes', (t) => {
  const { store, directory, reopen } = fixture(t, {
    commitments: [
      { id: 'CM-FIRST', text: '周末看展', createdBy: 'owner', status: 'open', createdAt: iso(), updatedAt: iso() },
      { id: 'CM-SECOND', text: '周末看电影', createdBy: 'friend', status: 'open', createdAt: iso(), updatedAt: iso() },
    ],
  });
  const before = snapshot(directory);
  assert.match(store.handle('friend', { type: 'commitment_add', text: ' 周末，看展！ ' }), /已经在约定里了：#CM-FIRST/);
  for (const type of ['commitment_complete', 'commitment_delete']) {
    assert.match(store.handle('owner', { type, query: '周末' }), /2 条相近约定/);
    assert.match(store.handle('owner', { type, query: '不存在' }), /没有找到/);
  }
  assert.match(store.handle('friend', { type: 'commitment_delete', query: '#cm-first' }), /只能由记录者删除/);
  assert.deepEqual(snapshot(directory), before);
  assert.match(store.handle('friend', { type: 'commitment_complete', query: '#cm-first' }), /标记完成/);
  assert.match(store.handle('owner', { type: 'commitment_complete', query: 'CM-FIRST' }), /没有找到/);
  assert.match(store.handle('friend', { type: 'commitment_add', text: '周末看展' }), /已经记进/);
  assert.match(store.handle('owner', { type: 'commitment_delete', query: '#cm-first' }), /已经删除/);
  assert.doesNotMatch(reopen().handle('owner', { type: 'commitment_list' }), /CM-FIRST/);
  assert.match(store.handle('owner', { type: 'commitment_delete', query: '#cm-first' }), /没有找到/);
});

test('enforces 100 belongings per owner, 50 open commitments and 100 inventory items at their boundaries', (t) => {
  const { store, directory } = fixture(t, {
    belongings: ['owner', 'friend'].flatMap((ownerSide) => Array.from({ length: ownerSide === 'owner' ? 99 : 100 }, (_, index) => ({
      id: `BL-${ownerSide}-${index}`, ownerSide, name: `物品${index}`, location: '原位', updatedAt: iso(),
    }))),
    commitments: Array.from({ length: 55 }, (_, index) => ({
      id: `CM-${index}`, text: `约定${index}`, createdBy: 'owner', status: index < 49 ? 'open' : 'done', updatedAt: iso(),
    })),
    inventory: Array.from({ length: 99 }, (_, index) => ({
      id: `IV-${index}`, name: `库存${index}`, updates: [{ side: 'owner', state: 'needed', at: iso() }],
    })),
  });
  store.handle('owner', { type: 'belonging_set', name: '最后物品', location: '新位' });
  store.handle('friend', { type: 'commitment_add', text: '最后约定' });
  store.handle('friend', { type: 'inventory_set', name: '最后库存', state: 'needed' });
  const full = snapshot(directory);
  for (const side of ['owner', 'friend']) {
    assert.throws(() => store.handle(side, { type: 'belonging_set', name: '超额物品', location: '新位' }), /最多保存一百条/);
  }
  assert.throws(() => store.handle('owner', { type: 'commitment_add', text: '超额约定' }), /最多保存五十条/);
  assert.throws(() => store.handle('owner', { type: 'inventory_set', name: '超额库存', state: 'needed' }), /最多保存一百项/);
  assert.deepEqual(snapshot(directory), full);
  assert.match(store.handle('owner', { type: 'belonging_set', name: '物品0', location: '更新位置' }), /更新位置/);
  assert.match(store.handle('owner', { type: 'commitment_add', text: '最后约定' }), /已经在约定里/);
  assert.match(store.handle('owner', { type: 'inventory_set', name: '库存0', state: 'stocked' }), /已经补好/);
  store.handle('owner', { type: 'belonging_delete', name: '最后物品' });
  store.handle('owner', { type: 'commitment_complete', query: 'CM-0' });
  store.handle('owner', { type: 'inventory_delete', name: '最后库存' });
  assert.match(store.handle('owner', { type: 'belonging_set', name: '释放后物品', location: '新位' }), /记住了/);
  assert.match(store.handle('owner', { type: 'commitment_add', text: '释放后约定' }), /已经记进/);
  assert.match(store.handle('owner', { type: 'inventory_set', name: '释放后库存', state: 'needed' }), /已更新/);
});

test('lists only the latest five completed commitments and orders inventory by update time', (t) => {
  const { store } = fixture(t, {
    commitments: [
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `CM-DONE-${index}`, text: `完成事项${index}`, createdBy: 'owner', status: 'done', updatedAt: iso(index),
      })),
      { id: 'CM-DELETED', text: '已删事项', createdBy: 'owner', status: 'deleted', updatedAt: iso(100) },
    ],
    inventory: [
      { id: 'IV-EMPTY', name: '没有更新' },
      { id: 'IV-A', name: '茶叶', updates: [
        { side: 'friend', state: 'low', quantity: '一盒', at: iso(3) },
        { side: 'owner', state: 'needed', at: iso(1) },
      ] },
      { id: 'IV-B', name: '咖啡', updates: [{ side: 'owner', state: 'stocked', at: iso(2) }] },
    ],
  });
  const commitments = store.handle('owner', { type: 'commitment_list' });
  assert.deepEqual(commitments.split('\n').filter((line) => line.startsWith('✓')).map((line) => line.split('｜')[1]),
    ['完成事项6', '完成事项5', '完成事项4', '完成事项3', '完成事项2']);
  assert.doesNotMatch(commitments, /已删事项/);
  assert.match(commitments, /没有未完成/);
  const inventory = store.handle('owner', { type: 'inventory_list' });
  assert.match(inventory, /1\. 茶叶｜只剩一盒/);
  assert.match(inventory, /2\. 咖啡｜已补好/);
  assert.doesNotMatch(inventory, /没有更新|茶叶｜要买/);
  assert.match(store.explain('owner', '茶叶'), /好友.*明确更新/);
  assert.equal(store.explain('owner', '没有更新'), null);
});

test('merges normalized inventory names and retains exactly the last twenty updates', (t) => {
  let time = epoch;
  const { store, directory } = fixture(t, undefined, { now: () => time });
  store.handle('friend', { type: 'inventory_set', name: 'ＳＯＡＰ', state: 'needed' });
  for (let index = 1; index <= 20; index += 1) {
    time += 1000;
    store.handle('owner', { type: 'inventory_set', name: ' soap! ', state: 'low', quantity: `${index}块` });
  }
  const inventory = store.handle('owner', { type: 'inventory_list' });
  assert.equal(inventory.split('\n').length, 2);
  assert.match(inventory, /soap!｜只剩20块/);
  const before = snapshot(directory);
  assert.match(store.handle('owner', { type: 'inventory_delete', name: '不存在' }), /什么都没删/);
  assert.deepEqual(snapshot(directory), before);
  assert.equal(store.deleteSide('friend').inventoryUpdates, 0, 'the oldest update must have been discarded');
  assert.match(store.handle('owner', { type: 'inventory_list' }), /只剩20块/);
  assert.equal(store.deleteSide('owner').inventoryUpdates, 20);
  assert.match(store.handle('owner', { type: 'inventory_list' }), /还是空的/);
});

test('deleteSide reopens peer commitments, restores surviving inventory updates and removes orphan items', (t) => {
  const calls = [];
  const { store, reopen } = fixture(t, {
    belongings: [
      { id: 'BL-OWN', ownerSide: 'owner', name: '自有物品', location: '自有位置', updatedAt: iso() },
      { id: 'BL-PEER', ownerSide: 'friend', name: '对方物品', location: '对方位置', updatedAt: iso() },
    ],
    commitments: [
      { id: 'CM-OWN', text: '自有约定', createdBy: 'owner', status: 'open', updatedAt: iso() },
      { id: 'CM-PEER', text: '对方约定', createdBy: 'friend', status: 'done', completedBy: 'owner', completedAt: iso(), updatedAt: iso() },
    ],
    inventory: [
      { id: 'IV-SHARED', name: '混合库存', updates: [
        { side: 'friend', state: 'low', quantity: '旧数量', at: iso() },
        { side: 'owner', state: 'stocked', quantity: '新数量', at: iso(1) },
      ] },
      { id: 'IV-OWN', name: '自有库存', updates: [{ side: 'owner', state: 'needed', at: iso() }] },
      { id: 'IV-EMPTY', name: '空历史库存' },
    ],
  }, { capsuleScheduler: { deleteTimeCapsules(side) { calls.push(side); return calls.length === 1 ? 2 : 0; } } });
  assert.deepEqual(store.deleteSide('owner'), { belongings: 1, commitments: 1, inventoryUpdates: 2, capsules: 2 });
  const saved = reopen();
  assert.match(saved.handle('owner', { type: 'belonging_list' }), /还没记录/);
  assert.match(saved.handle('friend', { type: 'belonging_list' }), /对方物品｜对方位置/);
  const commitments = saved.handle('friend', { type: 'commitment_list' });
  assert.match(commitments, /我们还说过要做：[\s\S]*CM-PEER/);
  assert.doesNotMatch(commitments, /CM-OWN|最近完成/);
  const inventory = saved.handle('friend', { type: 'inventory_list', needsOnly: true });
  assert.match(inventory, /混合库存｜只剩旧数量/);
  assert.doesNotMatch(inventory, /新数量|自有库存|空历史库存/);
  assert.deepEqual(saved.deleteSide('owner'), { belongings: 0, commitments: 0, inventoryUpdates: 0, capsules: 0 });
  assert.deepEqual(calls, ['owner', 'owner']);
});

test('failed writes and renames propagate errors while prior saved state stays readable', (t) => {
  for (const method of ['writeFileSync', 'renameSync']) {
    const { store, stateFile, reopen } = fixture(t);
    store.handle('owner', { type: 'belonging_set', name: '保留物品', location: '原位置' });
    const before = lists(store);
    const indexBefore = fs.readFileSync(stateFile, 'utf8');
    const failure = Object.assign(new Error(`injected ${method} failure`), { code: 'EIO' });
    const mock = t.mock.method(fs, method, () => { throw failure; });
    try {
      assert.throws(() => store.handle('owner', { type: 'belonging_set', name: '保留物品', location: '未写入位置' }),
        (error) => error.cause === failure && /暂时无法确认完成/.test(error.message));
      assert.equal(mock.mock.callCount(), 1);
    } finally { mock.mock.restore(); }
    assert.equal(fs.readFileSync(stateFile, 'utf8'), indexBefore);
    assert.deepEqual(lists(reopen()), before);
  }
});
