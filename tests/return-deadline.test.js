'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedLifeStore } = require('../src/shared-life-store');
const { readRecordState } = require('../src/record-state');
const { parseSharedLifeCommand: life } = require('../src/shared-life-commands');
const { REFUSAL, parseReturnDeadlineCommand: parse, createReturnDeadlineHandler } = require('../src/return-deadline');


function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'return-deadline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'life.json');
  if (initial) fs.writeFileSync(stateFile, JSON.stringify(initial));
  let clock = Date.parse('2026-11-02T16:30:00Z'); // Shanghai Nov 3, UTC Nov 2
  const reopen = () => createSharedLifeStore({ stateFile, now: () => clock });
  const store = reopen();
  return { dir, stateFile, store, reopen, setClock: value => { clock = Date.parse(value); },
    read: () => readRecordState(stateFile), run: (text, side = 'owner') => store.execute(side, parse(text)),
    add: (name, side = 'owner') => store.execute(side, { type: 'belonging_set', name, location: '储物柜' }),
  };
}



test('set by name and BL id, reopen, update and clear preserve existing fields and record identity', t => {
  const f = fixture(t); f.add('耳机');
  f.store.execute('owner', life('登记购买 耳机 299元 保修1年 2026-11-01'));
  f.store.execute('owner', life('设置保质期 耳机 2028-01-01'));
  f.store.execute('owner', life('设置维护周期 耳机 30天 2026-11-01'));
  const before = f.read().belongings[0];
  assert.match(before.id, /^BL-/u);
  assert.equal(f.run(' 设置退货期限 耳机 2026-11-10 \n').wrote, true);
  assert.equal(f.read().belongings[0].returnDeadline, '2026-11-10');
  assert.match(f.reopen().handle('owner', parse(`退货期限 #${before.id}`)), /2026-11-10.*剩余 7 天/u);
  assert.equal(f.run(`设置退货期限 ${before.id.toLowerCase()} 2026-11-11`).wrote, true);
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  const bodyPath = path.join(f.dir, index.belongings[0].file);
  assert.equal(JSON.parse(fs.readFileSync(bodyPath)).returnDeadline, '2026-11-11');
  assert.deepEqual(Object.keys(index).sort(), ['_recordState', 'belongings', 'commitments', 'inventory', 'schemaVersion']);
  const { returnDeadline, updatedAt, ...after } = f.read().belongings[0];
  const { updatedAt: originalTime, ...original } = before;
  assert.deepEqual(after, original);
  // Existing writers must retain the explicitly supplied deadline.
  f.add('耳机'); f.store.execute('owner', life('登记购买 耳机 300元 保修2年 2026-11-02'));
  assert.equal(f.read().belongings[0].returnDeadline, '2026-11-11');
  const latest = f.read().belongings[0];
  assert.equal(f.run(`清除退货期限 ${before.id}`).wrote, true);
  assert.doesNotMatch(f.run('退货期限查询').reply, /耳机/u);
  assert.match(f.run('退货期限 耳机').reply, /未设置/u);
  assert.equal(f.run('清除退货期限 耳机').wrote, false);
  const { updatedAt: latestTime, returnDeadline: removed, ...expected } = latest;
  const { updatedAt: clearedTime, ...cleared } = f.read().belongings[0];
  assert.deepEqual(cleared, expected);
  assert.equal(JSON.parse(fs.readFileSync(bodyPath)).returnDeadline, undefined);
  f.run('设置退货期限 耳机 2026-11-12');
  assert.equal(f.run('清除退货期限 耳机').wrote, true);
  assert.match(f.reopen().handle('owner', parse('退货期限查询')), /暂无/u);
});

test('invalid dates refused without writing; real leap day accepted, no purchase-based inference', t => {
  const f = fixture(t); f.add('衣服');
  f.store.execute('owner', life('登记购买 衣服 200元 保修1年 2026-11-01'));
  assert.match(f.run('退货期限 衣服').reply, /未设置/u);
  const before = f.read();
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-11-00', '2026-1-03', '11月3日', '明天', '2026-11-03T00:00:00Z']) {
    assert.throws(() => f.run(`设置退货期限 衣服 ${date}`), /退货期限/u);
  }
  for (const date of ['', null, undefined, 20261103, {}, true]) {
    assert.throws(() => f.store.execute('owner', { type: 'belonging_return_deadline_set', name: '衣服', returnDeadline: date }), /退货期限/u);
  }
  for (const text of ['设置退货期限', '设置退货期限 衣服', '退货期限', '清除退货期限']) assert.equal(f.run(text).wrote, false);
  assert.deepEqual(f.read(), before);
  f.run('设置退货期限 衣服 2028-02-29');
  assert.equal(f.read().belongings[0].returnDeadline, '2028-02-29');
});

test('name normalization/exact-first and ambiguity including identical names; ids never fall back to names', t => {
  const f = fixture(t); f.add('厨房耳机'); f.add('卧室耳机');
  const commands = name => [`设置退货期限 ${name} 2026-11-10`, `退货期限 ${name}`, `清除退货期限 ${name}`];
  const before = f.read();
  for (const text of commands('耳机')) {
    const result = f.run(text);
    assert.equal(result.wrote, false); assert.equal(result.continue, false);
    assert.match(result.reply, /厨房耳机.*卧室耳机/u);
  }
  assert.deepEqual(f.read(), before);
  const g = fixture(t, { belongings: [
    { id: 'BL-A', ownerSide: 'owner', name: '耳机' }, { id: 'BL-B', ownerSide: 'owner', name: '耳机' },
    { id: 'BL-C', ownerSide: 'friend', name: '好友秘密' },
  ] });
  for (const text of commands('耳机')) assert.match(g.run(text).reply, /耳机（#BL-A）.*耳机（#BL-B）/u);
  assert.equal(g.run('设置退货期限 BL-A 2026-11-10').wrote, true);
  assert.equal(g.read().belongings[1].returnDeadline, undefined);
  for (const text of commands('BL-NOTFOUND')) assert.match(g.run(text).reply, /未找到/u);
  for (const text of commands('BL-C')) assert.doesNotMatch(g.run(text).reply, /好友秘密/u);
  for (const id of ['#IV-A', 'IV-A', 'BL-', '#BL', 'BL-A_B']) for (const text of commands(id)) assert.match(g.run(text).reply, /编号无效/u);
  f.add('Ａ-B'); f.add('a_b备用');
  assert.equal(f.run('设置退货期限 a b 2026-11-12').wrote, true);
  assert.equal(f.read().belongings.filter(item => item.returnDeadline).length, 1);
  const h = fixture(t);
  assert.match(h.run('设置退货期限 不存在 2026-11-10').reply, /未找到/u);
  assert.equal(fs.existsSync(h.stateFile), false);
});

test('all explicit deadlines sorted ascending; Shanghai days, expiration, no default/renewal or query writes', async t => {
  const f = fixture(t);
  for (const name of ['远期', '今天', '昨天', '无期限']) f.add(name);
  f.add('好友秘密', 'friend');
  f.run('设置退货期限 远期 2027-01-01'); f.run('设置退货期限 今天 2026-11-03'); f.run('设置退货期限 昨天 2026-11-02');
  const before = f.read();
  const reply = f.run('退货期限查询').reply;
  assert.ok(reply.indexOf('昨天') < reply.indexOf('今天') && reply.indexOf('今天') < reply.indexOf('远期'));
  assert.match(reply, /昨天.*已过期 1 天/u); assert.match(reply, /今天.*剩余 0 天/u); assert.match(reply, /远期.*剩余 59 天/u);
  assert.doesNotMatch(reply, /无期限|好友秘密/u);
  assert.deepEqual(f.read(), before);
  f.setClock('2026-11-03T16:00:00Z');
  assert.match(f.run('退货期限 今天').reply, /已过期 1 天/u);
  assert.deepEqual(f.read(), before);
  let sent = 0;
  await f.store.maintenance.tick(async () => { sent++; });
  assert.equal(sent, 0); // A return deadline adds no due producer.
  assert.equal(f.read().belongings.find(item => item.name === '今天').returnDeadline, '2026-11-03');
});

test('friend refused before any loader/writer call, including malformed commands and spoofed owner', t => {
  const handle = createReturnDeadlineHandler({ load: () => { throw Error('must not read'); }, save: () => { throw Error('must not write'); } });
  const f = fixture(t); fs.writeFileSync(f.stateFile, 'broken');
  const originalRead = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', function(file, ...args) {
    assert.ok(!String(file).startsWith(f.dir), 'friend must not read life storage');
    return originalRead.call(this, file, ...args);
  });
  for (const text of ['退货期限查询', '退货期限 秘密', '设置退货期限 秘密 2026-11-10', '设置退货期限 秘密 明天', '清除退货期限 秘密', '设置退货期限']) {
    const command = { ...parse(text), side: 'owner', ownerSide: 'owner' };
    assert.equal(handle('friend', command).reply, REFUSAL);
    const result = f.store.execute('friend', command);
    assert.equal(result.reply, REFUSAL); assert.equal(result.wrote, false);
  }
  spy.mock.restore();
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), 'broken');
});

test('corrupt deadline fails visibly and quarantines index preserving originals, inline and classified', t => {
  for (const value of [null, '', 20261103, '2026-02-29', 'tomorrow']) for (const classified of [false, true]) {
    const f = fixture(t); f.add('耳机');
    const state = f.read(); state.belongings[0].returnDeadline = value;
    if (classified) {
      const index = JSON.parse(fs.readFileSync(f.stateFile));
      fs.writeFileSync(path.join(f.dir, index.belongings[0].file), JSON.stringify(state.belongings[0]));
    } else fs.writeFileSync(f.stateFile, JSON.stringify(state));
    const original = fs.readFileSync(f.stateFile, 'utf8');
    assert.throws(() => f.run('退货期限查询'), /已保存的内容损坏，已隔离保全.*本次操作未执行/u);
    const quarantined = fs.readdirSync(f.dir).find(name => name.startsWith('life.json.corrupt-'));
    assert.ok(quarantined); assert.equal(fs.readFileSync(path.join(f.dir, quarantined), 'utf8'), original);
    assert.equal(fs.existsSync(f.stateFile), false);
    if (classified) assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, JSON.parse(original).belongings[0].file))).returnDeadline, value);
  }
  for (const command of ['设置退货期限 耳机 2026-11-10', '清除退货期限 耳机']) {
    const f = fixture(t, { belongings: [{ id: 'BL-A', name: '耳机', ownerSide: 'owner', returnDeadline: 'invalid' }] });
    assert.throws(() => f.run(command), /隔离保全/u); // Never overwrite or clear away damage silently.
  }
});
