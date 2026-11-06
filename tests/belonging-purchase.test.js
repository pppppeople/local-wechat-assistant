'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseSharedLifeCommand } = require('../src/shared-life-commands');
const { createSharedLifeStore } = require('../src/shared-life-store');
const { warrantyExpiry } = require('../src/belonging-purchase');
const { readRecordState } = require('../src/record-state');



// Shanghai has already entered October 30, while UTC is still October 29.
const epoch = Date.parse('2026-10-29T16:30:00Z');

function fixture(t, state) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'belonging-purchase-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'life.json');
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  let clock = epoch;
  const reopen = () => createSharedLifeStore({ stateFile, now: () => clock });
  const store = reopen();
  return {
    store, stateFile, reopen, setClock: (value) => { clock = Date.parse(value); },
    read: () => readRecordState(stateFile),
    run: (text, side = 'owner') => store.execute(side, parseSharedLifeCommand(text, { now: clock })),
  };
}



test('parses exact commands, positive decimal amounts, warranty months and Shanghai dates', () => {
  for (const [duration, months] of [['1年', 12], ['2年', 24], ['6个月', 6], ['18个月', 18]]) {
    assert.deepEqual(parseSharedLifeCommand(`登记购买 耳机 299.90元 保修${duration}`, { now: epoch }), {
      type: 'belonging_purchase_set', name: '耳机', amount: 299.9, warrantyMonths: months, purchaseDate: '2026-10-30',
    });
  }
  for (const date of ['2026-10-30', '10月30日']) {
    assert.equal(parseSharedLifeCommand(`登记购买 耳机 0.01元 保修1年 ${date}`, { now: epoch }).purchaseDate, '2026-10-30');
  }
  assert.deepEqual(parseSharedLifeCommand('保修查询 耳机'), { type: 'belonging_warranty_query', name: '耳机' });
  assert.deepEqual(parseSharedLifeCommand('哪些东西快过保了'), { type: 'belonging_warranty_list' });
  assert.equal(parseSharedLifeCommand('有哪些东西快过保了'), null);
});

test('rejects malformed amounts, durations, dates and empty names', () => {
  for (const amount of ['0', '-1', '+1', '1e2', 'NaN', 'Infinity', '1.2.3', '.5', '1.', '9'.repeat(310)]) {
    assert.throws(() => parseSharedLifeCommand(`登记购买 耳机 ${amount}元 保修1年`, { now: epoch }));
  }
  for (const duration of ['0年', '-1年', '1.5年', '0个月', '一年', '1月', '1天', '9007199254740992个月']) {
    assert.throws(() => parseSharedLifeCommand(`登记购买 耳机 1元 保修${duration}`, { now: epoch }));
  }
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2月29日', '2026-1-01', '明天', '2026-10-30 多余内容']) {
    assert.throws(() => parseSharedLifeCommand(`登记购买 耳机 1元 保修1年 ${date}`, { now: epoch }));
  }
  assert.throws(() => parseSharedLifeCommand('登记购买  1元 保修1年', { now: epoch }));
  assert.throws(() => parseSharedLifeCommand('保修查询'));
});

test('clamps natural months at month ends and leap-year boundaries', () => {
  for (const [date, months, expiry] of [
    ['2026-01-31', 1, '2026-02-28'], ['2024-01-31', 1, '2024-02-29'],
    ['2024-02-29', 12, '2025-02-28'], ['2023-08-31', 6, '2024-02-29'],
    ['2026-12-31', 2, '2027-02-28'], ['2026-10-30', 18, '2028-04-30'],
    ['2026-01-31', 2, '2026-03-31'],
  ]) assert.equal(warrantyExpiry(date, months), expiry);
});

test('creates and updates purchases using the original normalized owner lookup and preserves location', (t) => {
  const f = fixture(t);
  const result = f.run('登记购买 Ａ-B 299.90元 保修1年');
  assert.equal(result.wrote, true);
  assert.match(result.reply, /2027-10-30/);
  let item = f.read().belongings[0];
  assert.equal(item.location, '');
  assert.equal(item.ownerSide, 'owner');
  assert.match(f.store.handle('owner', { type: 'belonging_query', name: 'ab' }), /未记录位置/);
  f.store.handle('owner', { type: 'belonging_set', name: 'a b', location: '原抽屉' });
  item = f.read().belongings[0];
  const { purchase, updatedAt, ...unchanged } = item;
  f.run('登记购买 a_b 50元 保修6个月 1月31日');
  const saved = f.read().belongings;
  assert.equal(saved.length, 1);
  const { purchase: next, updatedAt: nextTime, ...rest } = saved[0];
  assert.deepEqual(rest, unchanged);
  assert.deepEqual(next, { amount: 50, warrantyMonths: 6, purchaseDate: '2026-01-31' });
  assert.match(f.reopen().handle('owner', { type: 'belonging_warranty_query', name: 'ab' }), /50元.*2026-07-31.*已过保/);
  assert.equal(f.reopen().handle('owner', { type: 'belonging_query', name: 'ab' }), 'Ａ-B在原抽屉。');
  assert.equal(purchase.amount, 299.9);
});

test('expiry day remains covered through Shanghai midnight; queries disambiguate and do not write', (t) => {
  const f = fixture(t);
  f.run('登记购买 耳机 100元 保修1年 2025-10-30');
  f.run('登记购买 耳机备用 200元 保修2年 2025-10-30');
  const before = f.read();
  assert.match(f.run('保修查询 耳机').reply, /购买日期 2025-10-30.*金额 100元.*保修到期日 2026-10-30.*在保/);
  assert.match(f.run('保修查询 耳').reply, /2 条相近记录/);
  assert.equal(f.run('保修查询 耳机').wrote, false);
  f.setClock('2026-10-30T15:59:59Z');
  assert.match(f.run('保修查询 耳机').reply, /在保$/);
  f.setClock('2026-10-30T16:00:00Z');
  assert.match(f.run('保修查询 耳机').reply, /已过保$/);
  assert.match(f.run('哪些东西快过保了').reply, /已过保 1 天/);
  assert.deepEqual(f.read(), before);
});

test('lists all expired and days 0 through 30 inclusive, sorts by expiry, excludes unregistered and peer items', (t) => {
  const f = fixture(t);
  for (const [name, date] of [
    ['远期', '2025-11-30'], ['三十天', '2025-11-29'], ['今天', '2025-10-30'],
    ['昨天', '2025-10-29'], ['很久以前', '2023-01-01'], ['明天', '2025-10-31'],
  ]) f.run(`登记购买 ${name} 100元 保修1年 ${date}`);
  f.store.handle('owner', { type: 'belonging_set', name: '无购买信息', location: '柜子' });
  f.run('登记购买 邻侧耳机 20元 保修1年 2025-10-01', 'friend');
  const list = f.run('哪些东西快过保了').reply;
  assert.deepEqual(list.split('\n').slice(1).map((line) => line.split('｜')[0]), ['很久以前', '昨天', '今天', '明天', '三十天']);
  for (const text of ['昨天｜2026-10-29｜已过保 1 天', '今天｜2026-10-30｜剩 0 天', '三十天｜2026-11-29｜剩 30 天']) assert.ok(list.includes(text));
  assert.doesNotMatch(list, /远期|无购买信息|邻侧耳机/);
  assert.match(f.run('保修查询 无购买信息').reply, /未登记购买信息/);
  assert.match(f.run('保修查询 不存在').reply, /未登记购买信息/);
});

test('returns an explicit empty list with no registered or qualifying purchases', (t) => {
  const f = fixture(t);
  assert.match(f.run('哪些东西快过保了').reply, /暂无/);
  f.store.handle('owner', { type: 'belonging_set', name: '钥匙', location: '柜子' });
  f.run('登记购买 远期 1元 保修2年');
  assert.match(f.run('哪些东西快过保了').reply, /暂无/);
});

test('legacy inline state survives load, classified save and reopen without losing fields', (t) => {
  const old = {
    schemaVersion: 1, extra: { keep: true },
    belongings: [{ id: 'BL-OLD', ownerSide: 'owner', name: '旧钥匙', location: '旧位置', createdAt: '2026-01-01T00:00:00Z', custom: { keep: 'yes' } }],
    commitments: [{ id: 'CM-OLD', text: '周末修耳机', createdBy: 'owner', status: 'open' }],
    inventory: [{ id: 'IV-OLD', name: '纸巾', updates: [] }],
  };
  const f = fixture(t, old);
  assert.match(f.run('保修查询 旧钥匙').reply, /未登记购买信息/);
  assert.equal(f.store.handle('owner', { type: 'belonging_query', name: '旧钥匙' }), '旧钥匙在旧位置。');
  f.run('登记购买 新物品 20元 保修1年');
  const saved = f.read();
  assert.deepEqual(saved.belongings[0], old.belongings[0]);
  assert.deepEqual(saved.commitments, old.commitments);
  assert.deepEqual(saved.inventory, old.inventory);
  assert.deepEqual(saved.extra, old.extra);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile))._recordState.version, 1);
  f.reopen().handle('owner', { type: 'belonging_set', name: '新物品', location: '新位置' });
  assert.equal(f.read().belongings[1].purchase.amount, 20);
  f.run('登记购买 旧钥匙 30元 保修2年');
  const { purchase, updatedAt, ...preserved } = f.read().belongings[0];
  assert.deepEqual(preserved, old.belongings[0]);
  assert.equal(purchase.amount, 30);
});

test('each side can only read and update its own purchase, including same-name creation', (t) => {
  const f = fixture(t);
  f.run('登记购买 耳机 999元 保修2年');
  const owner = f.read().belongings[0];
  assert.match(f.run('保修查询 耳机', 'friend').reply, /未登记购买信息/);
  assert.match(f.run('哪些东西快过保了', 'friend').reply, /暂无/);
  f.run('登记购买 耳机 1元 保修6个月', 'friend');
  const items = f.read().belongings;
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], owner);
  assert.equal(items[1].ownerSide, 'friend');
  assert.equal(items[1].purchase.amount, 1);
  assert.doesNotMatch(f.run('保修查询 耳机', 'friend').reply, /999元/);
  assert.match(f.run('保修查询 耳机').reply, /999元/);
  assert.throws(() => f.run('登记购买 耳机 2元 保修1年', 'other'), /invalid shared life side/);
});

test('purchase creation shares the existing per-side 100-item cap but updates are allowed at capacity', (t) => {
  const belongings = Array.from({ length: 100 }, (_, i) => ({ id: `BL-${i}`, ownerSide: 'owner', name: `物品${i}`, location: '原位置' }));
  const f = fixture(t, { belongings });
  assert.throws(() => f.run('登记购买 新物品 1元 保修1年'), /最多保存一百条/);
  assert.equal(f.read().belongings.length, 100);
  f.run('登记购买 物品0 1元 保修1年');
  f.run('登记购买 新物品 1元 保修1年', 'friend');
  assert.equal(f.read().belongings.length, 101);
  assert.equal(f.read().belongings[0].location, '原位置');
});
