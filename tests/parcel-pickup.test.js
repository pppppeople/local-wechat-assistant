'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readRecordState } = require('../src/record-state');
const { parseParcelPickupCommand: parse, extractParcelPickup: extract, extractDeadline,
  createParcelPickupProvider, REFUSAL } = require('../src/parcel-pickup-commands');
const { createParcelPickupStore } = require('../src/parcel-pickup-store');

const pasted = (code = 'AB1234', extra = '') => `【菜鸟快递】包裹已到幸福驿站，取件码：${code}${extra ? `，${extra}` : ''}`;
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-parcel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'parcel-pickup/state.json');
  let clock = Date.parse('2026-11-03T00:00:00Z');
  const store = createParcelPickupStore({ stateFile, now: () => clock, ...options });
  return { dir, stateFile, store, advance: ms => { clock += ms; },
    run: (text, key) => store.execute('owner', parse(text), key),
    read: () => readRecordState(stateFile, { schemaVersion: 1, parcels: [] }, true, { strict: true }) };
}



test('trimmed exact grammar and anchored triggers preserve existing commands', () => {
  assert.deepEqual(parse(' 登记取件： 内容 \n'), { type: 'add', text: '内容' });
  assert.deepEqual(parse(' 已取列表 '), { type: 'picked_list' });
  assert.deepEqual(parse(' 已取 123456 '), { type: 'picked', target: '123456' });
  assert.deepEqual(parse('删除取件 2'), { type: 'delete', target: '2' });
  assert.deepEqual(parse('查找取件 AB1234'), { type: 'find', target: 'AB1234' });
  for (const text of ['登记取件', '已取', '确认取件 1', '删除取件 -1 2', '取件列表：秘密']) assert.equal(parse(text).type, 'invalid');
  const { parsePersonalTodoCommand } = require('../src/personal-todo-commands');
  for (const text of ['记一下，登记取件：ABC123', '记一下，取件列表', '我的待办', '完成第1项']) {
    assert.equal(parse(text), null); assert.ok(parsePersonalTodoCommand(text));
  }
  const { parseLaterBoxCommand } = require('../src/later-box-commands');
  for (const text of ['稍后看：登记取件：ABC123', '稍后箱']) {
    assert.equal(parse(text), null); assert.ok(parseLaterBoxCommand(text, []));
  }
  for (const text of ['记账：快递 5元', '工作日志：登记取件', '发给好友：取件列表', '取件列表情报', '我已取 AB1234']) assert.equal(parse(text), null);
});

test('deterministic code, place and explicit deadlines; mixed codes without a label', () => {
  assert.deepEqual(extract(pasted('123456', '请于2026年11月5日前取件')),
    { code: '123456', location: '幸福驿站', deadline: '2026年11月5日' });
  assert.deepEqual(extract('快递到了，取件地点：南门快递柜，取货码 X9Y8Z7，截止日期：2026-11-05'),
    { code: 'X9Y8Z7', location: '南门快递柜', deadline: '2026-11-05' });
  assert.deepEqual(extract('包裹已到东门代收点，凭 AB123456 提货，11月5日前领取'),
    { code: 'AB123456', location: '东门代收点', deadline: '11月5日' });
  assert.equal(extract('快递取件码：ABC123\n取件地点：东门快递柜').location, '东门快递柜');
  assert.equal(extract(pasted('123456789012')).code, '123456789012');
});

test('never infer deadline/year or treat plain numbers/orders as pickup codes; same paragraph required', () => {
  for (const text of [pasted(), pasted('AB1234', '两天内领取'), pasted('AB1234', '入库时间：2026-11-03'),
    pasted('AB1234', '截止日期：2026-02-30'), pasted('AB1234', '截止2026-11-05，截止2026-11-06')]) {
    assert.equal(extract(text).deadline, null);
  }
  assert.equal(extractDeadline('请于2月29日前取件'), '2月29日');
  for (const text of ['订单号：123456789012，包裹已到幸福驿站', '包裹已到幸福驿站，123456',
    '包裹已到幸福驿站，运单号：XYZ12345', '取件码：123456\n\n包裹已到幸福驿站',
    '取件码：123456', pasted('1234567890123'), pasted('AB1234', '另一个取件码：CD5678')]) assert.equal(extract(text), null, text);
});

test('register/list/find/picked/delete persist separately; no deadline field inferred', async t => {
  const f = fixture(t, { provider: { extract: () => assert.fail('rules must bypass model') } });
  assert.match((await f.run(`登记取件：${pasted()}`)).reply, /已登记/u);
  assert.equal(f.read().parcels[0].deadline, null);
  assert.match((await f.run('取件列表')).reply, /1\. 取件码 AB1234.*未提供截止日期/u);
  assert.match((await f.run('查找取件 AB1234')).reply, /幸福驿站/u);
  assert.match((await f.run('查找取件 AB123')).reply, /未找到/u);
  assert.match((await f.run('查找取件 ab1234')).reply, /未找到/u);
  assert.equal((await f.run('已取 1')).wrote, true);
  assert.match((await f.run('取件列表')).reply, /暂无待取/u);
  assert.match((await f.run('已取列表')).reply, /1\. 取件码 AB1234.*已取/u);
  assert.match((await f.run('查找取件 AB1234')).reply, /已取/u);
  assert.equal((await f.run('已取 AB1234')).wrote, false);
  const record = JSON.parse(fs.readFileSync(f.stateFile)).parcels[0].file;
  assert.match(record, /^records\/parcels\/parcels\/2026\/11\/.+\.json$/u);
  assert.equal((await f.run('删除取件 1')).wrote, true);
  assert.equal(f.read().parcels.length, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), record)), false);
});

test('30 pending cap refuses without eviction; picked frees space and duplicates include picked records', async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 30 }, (_, i) => f.run(`登记取件：${pasted(`AB${String(i).padStart(4, '0')}`)}`)));
  assert.equal(f.read().parcels.length, 30);
  assert.equal((await f.run('取件列表')).reply.split('\n').filter(line => /^\d+\./u.test(line)).length, 30);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match((await f.run(`登记取件：${pasted('CD0000')}`)).reply, /已满 30 条/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  const duplicate = await f.run(`登记取件：${pasted('AB0000')}`);
  assert.equal(duplicate.wrote, false); assert.match(duplicate.reply, /重复登记.*\n取件码 AB0000｜幸福驿站/u);
  await f.run('已取 AB0000');
  assert.match((await f.run(`登记取件：${pasted('AB0000')}`)).reply, /已有条目：[\s\S]*已取/u);
  assert.equal((await f.run(`登记取件：${pasted('CD0000')}`)).wrote, true);
  assert.equal(f.read().parcels.length, 31);
  assert.equal(f.read().parcels.filter(item => item.status === 'pending').length, 30);
});

test('numbers require the actual displayed view; bounds, invalidated views and exact numeric codes', async t => {
  const f = fixture(t);
  await f.run(`登记取件：${pasted('123456')}`);
  await f.run(`登记取件：${pasted('AB1234')}`);
  assert.match((await f.run('已取 1')).reply, /先查看取件列表/u);
  await f.run('取件列表');
  for (const target of ['0', '-1', '1.5', '3', '99999999999999999999']) {
    for (const action of ['已取', '删除取件']) assert.match((await f.run(`${action} ${target}`)).reply, /序号越界/u);
  }
  assert.equal((await f.run('已取 123456')).wrote, true);
  assert.match((await f.run('删除取件 1')).reply, /先查看取件列表/u);
  await f.run('取件列表', 'account-A');
  assert.match((await f.run('已取 1', 'account-B')).reply, /先查看取件列表/u);
  await f.run('取件列表', 'account-A');
  assert.equal((await f.run('删除取件 AB1234', 'account-B')).wrote, true);
  assert.match((await f.run('已取 1', 'account-A')).reply, /先查看取件列表/u);
});

test('explicit deadlines persist through rule registration and model confirmation; fallback duplicates refuse even at capacity', async t => {
  const f = fixture(t, { provider: { extract: async () => ({ code: '1234', location: '北门柜' }) } });
  await f.run(`登记取件：${pasted('AB1234', '截止日期：2026-11-05')}`);
  assert.equal(f.read().parcels[0].deadline, '2026-11-05');
  await f.run('登记取件：北门柜取件凭证1234，11月5日前领取');
  assert.equal(f.read().parcels.length, 1);
  await f.run('确认取件');
  assert.equal(f.read().parcels[1].deadline, '11月5日');
  for (let i = 0; i < 28; i++) await f.run(`登记取件：${pasted(`CD${String(i).padStart(4, '0')}`)}`);
  const result = await f.run('登记取件：北门柜取件凭证1234');
  assert.equal(result.wrote, false);
  assert.match(result.reply, /重复登记[\s\S]*已有条目：[\s\S]*取件码 1234｜北门柜/u);
  assert.equal(f.read().parcels.length, 30);
});

test('candidate replacement, expiry, restart, invalid/model failure and cap recheck never silently register', async t => {
  let candidate = { code: '1234', location: '北门柜' };
  const f = fixture(t, { provider: { extract: async () => candidate } });
  await f.run('登记取件：北门柜取件凭证1234，截止日期：2026/11/05');
  f.advance(10 * 60 * 1000);
  assert.equal((await f.run('确认取件')).wrote, false);
  await f.run('登记取件：北门柜取件凭证1234');
  assert.equal((await createParcelPickupStore({ stateFile: f.stateFile }).execute('owner', parse('确认取件'))).wrote, false);
  await f.run('登记取件： ');
  assert.equal((await f.run('确认取件')).wrote, false);
  for (candidate of [{ code: 'invented', location: '北门柜' }, { code: '1234', location: '不存在' }, { code: '', location: '' }]) {
    assert.equal((await f.run('登记取件：北门柜1234')).wrote, false);
    assert.equal((await f.run('确认取件')).wrote, false);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  candidate = { code: '1234', location: '北门柜' };
  await f.run('登记取件：北门柜取件凭证1234，截止日期：2026/11/05', 'draft-owner');
  for (let i = 0; i < 30; i++) await f.run(`登记取件：${pasted(`AB${String(i).padStart(4, '0')}`)}`, 'other-session');
  assert.match((await f.run('确认取件', 'draft-owner')).reply, /已满 30 条/u);
  assert.equal(f.read().parcels.length, 30);
  const broken = fixture(t, { provider: { extract: async () => { throw new Error('synthetic failure'); } } });
  assert.equal((await broken.run('登记取件：未知格式')).continue, false);
  assert.equal(fs.existsSync(broken.stateFile), false);
});

test('friend refuses every command before any storage or model call', async () => {
  const store = createParcelPickupStore({ stateFile: '/must-not-read',
    readState: () => assert.fail('friend read'), provider: { extract: () => assert.fail('friend model') } });
  for (const sender of ['friend', 'stranger', undefined]) {
    for (const text of ['登记取件：秘密', '确认取件', '取件列表', '已取列表', '已取 1', '删除取件 1', '查找取件 ABC123', '登记取件']) {
      const result = await store.execute(sender, parse(text));
      assert.equal(result.reply, REFUSAL); assert.equal(result.wrote, false);
    }
  }
});

test('strict record-state quarantine preserves damaged originals and fails visibly', async t => {
  const f = fixture(t);
  await f.run(`登记取件：${pasted()}`);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  const body = path.join(path.dirname(f.stateFile), index.parcels[0].file);
  fs.writeFileSync(body, '{broken');
  assert.equal((await f.run('取件列表')).continue, false);
  assert.equal(fs.readFileSync(body, 'utf8'), '{broken');
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(fs.readdirSync(path.dirname(f.stateFile)).filter(name => name.startsWith('state.json.corrupt-')).length, 1);
  fs.writeFileSync(f.stateFile, '{bad-index');
  assert.equal((await f.run(`登记取件：${pasted('CD1234')}`)).wrote, false);
  assert.equal(fs.readdirSync(path.dirname(f.stateFile)).filter(name => name.startsWith('state.json.corrupt-')).length, 2);
});

test('provider uses existing structured no-history channel, validates shape and failures', async () => {
  const provider = createParcelPickupProvider({ model: async (prompt, session, images, options) => {
    assert.equal(session, ''); assert.deepEqual(images, []);
    assert.equal(options.stage, 'parcel_pickup_candidate'); assert.ok(options.schema);
    assert.match(prompt, /不把订单号\/运单号当取件码/u);
    assert.deepEqual(options.parse('{"code":"1234","location":"北门柜"}'), { code: '1234', location: '北门柜' });
    assert.throws(() => options.parse('{"code":"1234","location":"北门柜","extra":true}'));
    return { ok: true, value: { code: '1234', location: '北门柜' } };
  } });
  assert.equal((await provider.extract('北门柜1234')).code, '1234');
  await assert.rejects(createParcelPickupProvider({ model: async () => ({ ok: false }) }).extract('text'));
});
