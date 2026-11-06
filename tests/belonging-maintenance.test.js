'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedLifeStore } = require('../src/shared-life-store');
const { parseSharedLifeCommand: parse } = require('../src/shared-life-commands');
const { maintenanceCycle } = require('../src/belonging-maintenance');
const { readRecordState } = require('../src/record-state');




function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belonging-maintenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'life.json');
  if (initial) fs.writeFileSync(stateFile, JSON.stringify(initial));
  let clock = Date.parse('2026-10-31T16:30:00Z'); // Shanghai Nov 1
  const reopen = () => createSharedLifeStore({ stateFile, now: () => clock });
  const store = reopen();
  const sent = [];
  const deliver = async (text, clientId) => { sent.push({ text, clientId }); };
  return { dir, stateFile, store, reopen, sent, deliver,
    setClock: value => { clock = Date.parse(value); }, read: () => readRecordState(stateFile),
    tick: () => store.maintenance.tick(deliver),
    run: (text, side = 'owner') => store.execute(side, parse(text, { now: clock })),
    add: (name, side = 'owner') => store.execute(side, { type: 'belonging_set', name, location: '储物柜' }),
  };
}



test('set/query/list/clear use Shanghai date and preserve warranty, expiry and location', async t => {
  const f = fixture(t);
  f.add('滤芯'); f.run('登记购买 滤芯 200元 保修2年 2026-01-01'); f.run('设置保质期 滤芯 2027-01-01');
  f.add('抹布');
  const before = f.read().belongings[0];
  const warranty = f.run('保修查询 滤芯').reply;
  const expiry = f.run('保质期查询 滤芯').reply;
  assert.equal(f.run('设置维护周期 滤芯 30天').wrote, true);
  assert.deepEqual(f.read().belongings[0].maintenance, {
    cycleDays: 30, lastMaintainedAt: '2026-11-01', nextDueAt: '2026-12-01', remindedDueAt: null, paused: false,
  });
  assert.match(f.run('维护查询 滤芯').reply, /周期 30 天.*上次维护 2026-11-01.*下次维护 2026-12-01.*未到期/);
  const snapshot = f.read();
  assert.equal(f.run('维护列表').wrote, false);
  assert.doesNotMatch(f.run('维护列表').reply, /抹布/);
  assert.deepEqual(f.read(), snapshot);
  const assertIndependent = () => {
    const item = f.read().belongings[0];
    assert.deepEqual(item.purchase, before.purchase);
    assert.equal(item.expiresAt, before.expiresAt);
    assert.equal(item.location, before.location);
  };
  assertIndependent();
  for (const cmd of ['暂停维护提醒 滤芯', '恢复维护提醒 滤芯', '完成维护 滤芯']) { f.run(cmd); assertIndependent(); }
  f.setClock('2026-12-01T00:00:00Z'); await f.tick(); assertIndependent();
  assert.equal(f.run('清除维护周期 滤芯').wrote, true);
  assert.match(f.run('清除维护周期 滤芯').reply, /未设置维护周期，无需清除/);
  assert.match(f.run('维护查询 滤芯').reply, /未设置维护周期/);
  const { updatedAt, ...after } = f.read().belongings[0];
  const { updatedAt: old, ...original } = before;
  assert.deepEqual(after, original);
  f.setClock('2026-10-31T16:30:00Z');
  assert.equal(f.run('保修查询 滤芯').reply, warranty);
  assert.equal(f.run('保质期查询 滤芯').reply, expiry);
  assert.match(f.run('维护列表').reply, /暂无/);
});

test('missing records never create; ambiguous including duplicate normalized names refuse all named operations', t => {
  const f = fixture(t);
  const commands = name => [`设置维护周期 ${name} 30天`, `维护查询 ${name}`, `清除维护周期 ${name}`, `完成维护 ${name}`, `暂停维护提醒 ${name}`, `恢复维护提醒 ${name}`];
  for (const text of commands('滤芯')) {
    const result = f.run(text);
    assert.equal(result.wrote, false); assert.equal(result.continue, false);
    assert.match(result.reply, /未找到/); assert.equal(fs.existsSync(f.stateFile), false);
  }
  f.add('厨房滤芯'); f.add('浴室滤芯');
  const before = f.read();
  for (const text of commands('滤芯')) {
    assert.match(f.run(text).reply, /相近记录.*厨房滤芯、浴室滤芯/);
    assert.deepEqual(f.read(), before);
  }
  const g = fixture(t, { belongings: [{ id: 'A', ownerSide: 'owner', name: 'Ａ-B' }, { id: 'B', ownerSide: 'owner', name: 'a_b' }] });
  for (const text of commands('ab')) assert.match(g.run(text).reply, /2 条相近记录.*Ａ-B、a_b/);
  f.add('滤芯'); f.run('设置维护周期 滤芯 1天'); // unique exact takes priority
  assert.equal(f.read().belongings.filter(item => item.maintenance).length, 1);
});

test('not due is silent, due today attempts once, restart retains cycle and reminder; complete enables next cycle', async t => {
  const f = fixture(t); f.add('滤芯'); f.run('设置维护周期 滤芯 1天');
  assert.equal(await f.tick(), false); assert.equal(f.sent.length, 0);
  f.setClock('2026-11-01T15:59:59Z'); await f.tick(); assert.equal(f.sent.length, 0);
  f.setClock('2026-11-01T16:00:00Z');
  assert.match(f.run('维护查询 滤芯').reply, /到期当天/);
  await Promise.all([f.tick(), f.tick()]); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /滤芯.*下次维护日 2026-11-02.*周期 1 天/);
  assert.doesNotMatch(f.sent[0].text, /该换|损坏/);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile))._recordState.version, 1);
  const reopened = f.reopen();
  assert.match(reopened.handle('owner', parse('维护查询 滤芯')), /周期 1 天.*2026-11-02/);
  await reopened.maintenance.tick(f.deliver); assert.equal(f.sent.length, 1);
  f.setClock('2026-11-04T00:00:00Z');
  assert.match(f.run('维护查询 滤芯').reply, /已超期 2 天/);
  await f.tick(); assert.equal(f.sent.length, 1);
  f.run('完成维护 滤芯');
  assert.deepEqual(f.read().belongings[0].maintenance, { cycleDays: 1, lastMaintainedAt: '2026-11-04', nextDueAt: '2026-11-05', remindedDueAt: null, paused: false });
  await f.tick(); assert.equal(f.sent.length, 1);
  f.setClock('2026-11-05T00:00:00Z'); await f.tick(); await f.tick();
  assert.equal(f.sent.length, 2); assert.notEqual(f.sent[0].clientId, f.sent[1].clientId);
});

test('overdue once, list sorted with statuses; due warranty/expiry alone never trigger maintenance', async t => {
  const f = fixture(t);
  for (const [name, date] of [['远期', '2026-11-10'], ['今天', '2026-10-31'], ['超期', '2026-10-28']]) {
    f.add(name); f.run(`设置维护周期 ${name} 1天 ${date}`);
  }
  f.add('仅保质期'); f.run('设置保质期 仅保质期 2026-11-01');
  f.run('登记购买 仅保修 100元 保修1年 2025-11-01');
  const list = f.run('维护列表').reply;
  assert.ok(list.indexOf('「超期」') < list.indexOf('「今天」') && list.indexOf('「今天」') < list.indexOf('「远期」'));
  assert.match(list, /已超期 3 天/); assert.match(list, /到期当天/); assert.match(list, /未到期/);
  assert.doesNotMatch(list, /仅保质期|仅保修/);
  await f.tick(); await f.tick(); assert.equal(f.sent.length, 2);
});

test('pause skips all missed scans, persists, resume overdue once without catch-up; reminded cycle stays reminded', async t => {
  const f = fixture(t); f.add('滤芯'); f.run('设置维护周期 滤芯 1天');
  f.run('暂停维护提醒 滤芯');
  for (const date of ['2026-11-02T00:00:00Z', '2026-11-20T00:00:00Z']) { f.setClock(date); await f.tick(); }
  await f.reopen().maintenance.tick(f.deliver); assert.equal(f.sent.length, 0);
  assert.match(f.run('维护查询 滤芯').reply, /已超期 18 天.*提醒已暂停/);
  f.run('恢复维护提醒 滤芯'); await f.tick(); await f.tick(); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /2026-11-02/);
  f.run('暂停维护提醒 滤芯'); f.run('恢复维护提醒 滤芯'); await f.tick(); assert.equal(f.sent.length, 1);
  f.run('暂停维护提醒 滤芯'); f.run('完成维护 滤芯'); await f.tick();
  assert.equal(f.read().belongings[0].maintenance.paused, true);
  f.run('恢复维护提醒 滤芯'); await f.tick(); assert.equal(f.sent.length, 1);
});

test('friend cannot use any maintenance action, spoof fields cannot expose owner data; scan only owner', async t => {
  const f = fixture(t); f.add('主人滤芯'); f.add('好友滤芯', 'friend');
  f.run('设置维护周期 主人滤芯 1天 2026-10-01');
  const before = f.read();
  for (const text of ['维护列表', '设置维护周期 好友滤芯 1天', '维护查询 主人滤芯', '清除维护周期 主人滤芯', '完成维护 主人滤芯', '暂停维护提醒 主人滤芯', '恢复维护提醒 主人滤芯']) {
    const command = { ...parse(text), side: 'owner', ownerSide: 'owner' };
    const result = f.store.execute('friend', command);
    assert.equal(result.wrote, false); assert.equal(result.continue, false); assert.match(result.reply, /仅主人/);
    assert.doesNotMatch(result.reply, /主人滤芯/);
  }
  assert.deepEqual(f.read(), before);
  assert.match(f.run('设置维护周期 好友滤芯 1天').reply, /未找到/);
  const g = fixture(t, { belongings: [{ id: 'FR', ownerSide: 'friend', name: '好友', maintenance: maintenanceCycle(1, '2026-01-01') }] });
  await g.tick(); assert.equal(g.sent.length, 0);
});

test('failed send stays marked to prevent duplicate attempts; commands during delivery are preserved', async t => {
  const f = fixture(t); f.add('滤芯'); f.run('设置维护周期 滤芯 1天 2026-10-01');
  await assert.rejects(f.store.maintenance.tick(async () => { throw new Error('synthetic send failure'); }), /synthetic/);
  await f.reopen().maintenance.tick(f.deliver); assert.equal(f.sent.length, 0);
  f.run('完成维护 滤芯'); f.setClock('2026-11-02T00:00:00Z');
  await f.store.maintenance.tick(async () => { f.run('清除维护周期 滤芯'); });
  assert.equal(f.read().belongings[0].maintenance, undefined);
});

test('completion recalculates across year and leap month; existing writers preserve maintenance', t => {
  const f = fixture(t); f.add('滤芯'); f.run('设置维护周期 滤芯 2天');
  for (const [clock, last, due] of [['2026-12-30T16:00:00Z', '2026-12-31', '2027-01-02'], ['2028-02-27T16:00:00Z', '2028-02-28', '2028-03-01']]) {
    f.setClock(clock); f.run('完成维护 滤芯');
    assert.equal(f.read().belongings[0].maintenance.lastMaintainedAt, last);
    assert.equal(f.read().belongings[0].maintenance.nextDueAt, due);
  }
  const maintenance = f.read().belongings[0].maintenance;
  f.run('登记购买 滤芯 50元 保修1年 2028-01-01');
  f.run('设置保质期 滤芯 2029-01-01'); f.run('清除保质期 滤芯'); f.add('滤芯');
  assert.deepEqual(f.read().belongings[0].maintenance, maintenance);
});
