'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parsePurchaseCooldownCommand: parse } = require('../src/purchase-cooldown-commands');
const { createPurchaseCooldownStore: create } = require('../src/purchase-cooldown-store');
const { readRecordState } = require('../src/record-state');
const DAY = 86400000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-cooldown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-31T15:30:00Z');
  const stateFile = path.join(root, 'purchase-cooldown/state.json');
  const lifeFile = path.join(root, 'life/state.json'), priceFile = path.join(root, 'prices/state.json');
  const sharedLife = require('../src/shared-life-store').createSharedLifeStore({ stateFile: lifeFile, now: () => clock });
  const priceNotes = require('../src/price-note-store').createPriceNoteStore({ stateFile: priceFile, now: () => clock });
  const options = { stateFile, now: () => clock, sharedLife, priceNotes };
  const store = create(options), sent = [];
  return { root, stateFile, lifeFile, priceFile, sharedLife, priceNotes, store, sent, options, read: () => readRecordState(stateFile),
    say: text => store.handle('owner', parse(text)), advance: ms => { clock += ms; },
    restart: () => create(options), deliver: async (text, id) => { sent.push({ text, id }); } };
}



test('parse explicit registrations, required amount, default days, decisions and ordinary negatives', () => {
  assert.deepEqual(parse('想买键盘 399 元，先冷静 3 天'), { type: 'create', item: '键盘', amount: 399, days: 3 });
  assert.deepEqual(parse('冷静期：耳机 899元'), { type: 'create', item: '耳机', amount: 899, days: 3 });
  assert.deepEqual(parse('冷静期：键盘 399.90元，先冷静 5 天'), { type: 'create', item: '键盘', amount: 399.9, days: 5 });
  for (const text of ['冷静期：耳机', '想买键盘，先冷静 3 天', '冷静期：键盘 很贵元',
    '冷静期：耳机 0元', '冷静期：耳机 -3元', '冷静期：耳机 3.999元', '想买键盘 399元，先冷静 0 天',
    '想买键盘 399元，先冷静 半天', '冷静期：键盘 399元，先冷静 1.5 天']) assert.equal(parse(text).type, 'invalid', text);
  for (const text of ['想买键盘 399元', '我买了', '他说放弃', '再想想吧', '登记购买 键盘 399元 保修1年',
    '登记购买 冷静期耳机 899元 保修1年', '他说“冷静期：键盘 399元”']) assert.equal(parse(text), null, text);
  assert.deepEqual(parse('第 12 个再想想'), { type: 'decide', number: 12, decision: 'extend' });
});

test('due attempt once, concurrent scans, restart catch-up and durable mark before mock dispatch', async t => {
  const f = fixture(t); f.say('冷静期：耳机 899元');
  f.advance(3 * DAY - 1); assert.equal(await f.restart().tick(f.deliver), false);
  f.advance(1);
  await Promise.all([f.restart().tick(async (...args) => {
    assert.equal(f.read().items[0].asked, true); await f.deliver(...args);
  }), f.store.tick(f.deliver)]);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /第 1 个 耳机.*899.00/);
  assert.match(f.sent[0].id, /^purchase-cooldown-.*-0$/);
  assert.equal(f.store.hasPending(), true);
});

test('multiple pending require stable number; all outcomes, extension duration and stats; no warranty writes', async t => {
  const f = fixture(t);
  for (const text of ['冷静期：键盘 399元', '冷静期：耳机 899元', '想买鼠标 100.10元，先冷静 2 天']) f.say(text);
  assert.equal(f.store.hasPending(), false);
  assert.match(f.say('买了'), /没有已到期/);
  f.advance(4 * DAY); await f.store.tick(f.deliver);
  assert.equal(f.sent.length, 3);
  assert.match(f.say('买了'), /多个.*编号/);
  assert.match(f.say('第 99 个放弃'), /该编号没有/);
  assert.match(f.say('第 1 个买了'), /记录买了.*不会自动登记.*是否顺手登记保修、记价格、两者都要或都不要/);
  assert.match(f.say('第 2 个放弃'), /899.00 元计入/);
  assert.match(f.say('再想想'), /顺延 2 天.*第 1 次/);
  let item = f.read().items[2];
  assert.equal(item.extensions, 1); assert.equal(item.asked, false);
  assert.equal(Date.parse(item.dueAt) - Date.parse(item.decidedAt), 2 * DAY);
  assert.equal(f.store.hasPending(), false);
  assert.match(f.say('冷静期战绩'), /放弃 1 次，放弃总金额 899.00 元；买了 1 次/);
  f.advance(2 * DAY); await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 4); assert.notEqual(f.sent[2].id, f.sent[3].id);
  f.say('再想想'); assert.equal(f.read().items[2].extensions, 2);
  f.advance(2 * DAY); f.say('放弃');
  assert.match(f.say('冷静期战绩'), /放弃 2 次，放弃总金额 999.10 元；买了 1 次/);
  assert.match(f.say('冷静期清单'), /为空/);
  assert.deepEqual(fs.readdirSync(f.root), ['purchase-cooldown']);
});

test('failure never replays; later pending item survives and catches up', async t => {
  const f = fixture(t); f.say('冷静期：耳机 899元'); f.say('冷静期：键盘 399元'); f.advance(3 * DAY);
  let attempts = 0;
  await assert.rejects(f.store.tick(async () => { attempts++; throw Error('mock failure'); }), /mock/);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /第 2 个/);
});

test('readonly guard leaves corruption untouched; explicit operation quarantines JSON/schema/body corruption', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('冷静期：耳机 899元'); f.advance(3 * DAY);
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.items[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : JSON.stringify({ schemaVersion: 1, items: [{}] }));
    assert.equal(f.store.hasPending(), false); assert.ok(fs.existsSync(f.stateFile));
    await assert.rejects(f.store.tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0); assert.equal(fs.existsSync(f.stateFile), false);
  }
});

test('bought offers linkage exactly once; selection and restart never reoffer or write targets', async t => {
  const f = fixture(t);
  assert.equal((bought(f).match(/是否顺手/g) || []).length, 1);
  assert.doesNotMatch(f.say('第 1 个买了'), /是否顺手/);
  assert.match(f.say('第 1 个联动两者都要'), /分别.*一次只写一种/);
  assert.doesNotMatch(f.say('第 1 个联动两者都要'), /是否顺手/);
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 0);
  assert.equal(f.read().items[0].link.answered, true);
  assert.equal(fs.existsSync(f.lifeFile), false); assert.equal(fs.existsSync(f.priceFile), false);
});

test('warranty requires duration, missing item requires separate explicit creation consent; confirm can amend all fields', t => {
  const f = fixture(t); bought(f);
  assert.match(f.say('第 1 个联动保修'), /显式提供保修时长/);
  assert.match(f.say('第 1 个确认联动保修'), /显式提供保修时长/);
  assert.equal(fs.existsSync(f.lifeFile), false);
  assert.match(f.say('第 1 个联动保修 2 年'), /生活箱不存在.*确认新建联动保修/);
  assert.equal(fs.existsSync(f.lifeFile), false);
  assert.match(f.say('第 1 个确认联动保修'), /生活箱不存在/);
  assert.equal(fs.existsSync(f.lifeFile), false);
  assert.match(f.say('第 1 个确认新建联动保修 799元 2026-10-30 保修6个月'), /已登记.*799元.*6个月/);
  const state = readRecordState(f.lifeFile);
  assert.deepEqual(state.belongings[0].purchase, { amount: 799, purchaseDate: '2026-10-30', warrantyMonths: 6 });
  assert.equal(f.read().items[0].amountCents, 89900);
  assert.equal(f.read().items[0].status, 'bought');
  const before = fs.readFileSync(f.lifeFile, 'utf8');
  assert.match(f.restart().handle('owner', parse('第 1 个确认新建联动保修')), /已登记保修.*不会重复/);
  assert.equal(fs.readFileSync(f.lifeFile, 'utf8'), before);
});

test('malformed linkage fields preserve previews and never register warranty or price', t => {
  const f = fixture(t); bought(f);
  f.say('第 1 个联动保修 2年');
  f.say('第 1 个联动价格');
  const before = f.read();
  for (const text of [
    '第 1 个联动保修 2年 不明字段',
    '第 1 个确认新建联动保修 2年 3年',
    '第 1 个确认新建联动保修 2026-11-01 2026-11-02',
    '第 1 个联动价格 399元 400元',
    '第 1 个确认联动价格 2年',
  ]) {
    assert.match(f.say(text), /^格式无法解析/u, text);
    assert.deepEqual(f.read(), before);
    assert.equal(fs.existsSync(f.lifeFile), false);
    assert.equal(fs.existsSync(f.priceFile), false);
  }
  const reopened = f.restart();
  assert.match(reopened.handle('owner', parse('第 1 个确认联动价格')), /已记录价格/);
  assert.equal(readRecordState(f.priceFile).prices[0].amount, 899);
  assert.match(reopened.handle('owner', parse('第 1 个确认新建联动保修')), /已登记/);
  assert.deepEqual(readRecordState(f.lifeFile).belongings[0].purchase,
    { amount: 899, purchaseDate: '2026-11-03', warrantyMonths: 24 });
});

test('existing unique belonging uses original purchase path, preserves identity and defaults Shanghai date and amount', t => {
  const f = fixture(t); bought(f);
  f.sharedLife.handle('owner', { type: 'belonging_set', name: '耳机', location: '抽屉' });
  const old = readRecordState(f.lifeFile).belongings[0];
  assert.match(f.say('第 1 个联动保修 2年'), /预览.*899元.*2026-11-03/);
  assert.equal(readRecordState(f.lifeFile).belongings[0].purchase, undefined);
  assert.match(f.say('第 1 个确认联动保修'), /已登记/);
  const saved = readRecordState(f.lifeFile).belongings[0];
  assert.equal(saved.id, old.id); assert.equal(saved.location, '抽屉');
  assert.deepEqual(saved.purchase, { amount: 899, purchaseDate: '2026-11-03', warrantyMonths: 24 });
});

test('each cancellation makes zero target writes, does not undo bought or the other completed linkage', t => {
  for (const kind of ['保修', '价格']) {
    const f = fixture(t); bought(f); f.say('第 1 个联动两者都要');
    f.say(kind === '保修' ? '第 1 个联动保修 2年' : '第 1 个联动价格');
    assert.match(f.say(`第 1 个取消联动${kind}`), /已取消.*未写入.*买了决定保留/);
    assert.match(f.say(`第 1 个确认联动${kind}`), /已取消/);
    assert.equal(fs.existsSync(f.lifeFile), false); assert.equal(fs.existsSync(f.priceFile), false);
    assert.equal(f.read().items[0].status, 'bought');
  }
  const f = fixture(t); bought(f); f.say('第 1 个联动价格'); f.say('第 1 个确认联动价格');
  const price = readRecordState(f.priceFile);
  f.say('第 1 个取消联动保修'); assert.deepEqual(readRecordState(f.priceFile), price);
  const g = fixture(t); bought(g); assert.match(g.say('第 1 个联动都不要'), /两种均未写入/);
  assert.equal(g.read().items[0].status, 'bought');
  assert.equal(fs.existsSync(g.lifeFile), false); assert.equal(fs.existsSync(g.priceFile), false);
});

test('same-name and inclusion ambiguities refuse; confirmation rechecks current life box', t => {
  for (const names of [['耳机', '耳机'], ['耳机左', '耳机右']]) {
    const f = fixture(t); bought(f);
    fs.mkdirSync(path.dirname(f.lifeFile), { recursive: true });
    fs.writeFileSync(f.lifeFile, JSON.stringify({ schemaVersion: 1, belongings: names.map((name, i) => ({ id: `BL-${i}`, name, ownerSide: 'owner' })), inventory: [], commitments: [] }));
    const before = fs.readFileSync(f.lifeFile, 'utf8');
    assert.match(f.say('第 1 个联动保修 2年'), /多个候选.*歧义/);
    assert.equal(fs.readFileSync(f.lifeFile, 'utf8'), before);
    assert.equal(f.read().items[0].status, 'bought');
  }
  const f = fixture(t); bought(f); f.say('第 1 个联动保修 2年');
  for (const name of ['耳机左', '耳机右']) f.sharedLife.handle('owner', { type: 'belonging_set', name, location: '柜子' });
  assert.match(f.say('第 1 个确认新建联动保修'), /多个候选/);
  assert.ok(readRecordState(f.lifeFile).belongings.every(item => !item.purchase));
});

test('target receipt survives failure to save cooldown completion and prevents replay across dates', t => {
  for (const kind of ['保修', '价格']) {
    const f = fixture(t); bought(f);
    f.say(kind === '保修' ? '第 1 个联动保修 2年' : '第 1 个联动价格');
    const pending = f.read();
    f.say(kind === '保修' ? '第 1 个确认新建联动保修' : '第 1 个确认联动价格');
    const target = kind === '保修' ? f.lifeFile : f.priceFile;
    const before = readRecordState(target);
    require('../src/record-state').writeRecordState(f.stateFile, pending, ['items']);
    f.advance(DAY);
    assert.match(f.restart().handle('owner', parse(`第 1 个确认联动${kind}`)), /已登记.*不会重复/);
    assert.deepEqual(readRecordState(target), before);
  }
});

test('both kinds require independent explicit confirmations and keep independent amounts', t => {
  const f = fixture(t); bought(f); f.say('第 1 个联动两者都要');
  f.say('第 1 个联动保修 2年'); f.say('第 1 个联动价格');
  assert.match(f.say('第 1 个确认联动两者都要'), /一次确认.*只处理一种/);
  assert.equal(fs.existsSync(f.lifeFile), false); assert.equal(fs.existsSync(f.priceFile), false);
  f.say('第 1 个确认新建联动保修 800元');
  assert.equal(readRecordState(f.lifeFile).belongings[0].purchase.amount, 800);
  assert.equal(fs.existsSync(f.priceFile), false);
  f.say('第 1 个确认联动价格 799元');
  assert.equal(readRecordState(f.priceFile).prices[0].amount, 799);
  assert.equal(readRecordState(f.lifeFile).belongings[0].purchase.amount, 800);
  assert.equal(f.read().items[0].status, 'bought');
});

test('unsupported long life-box name cannot truncate into a different existing item', t => {
  const f = fixture(t), name = '甲'.repeat(80);
  f.sharedLife.handle('owner', { type: 'belonging_set', name, location: '柜子' });
  f.say(`冷静期：${name}乙 899元`); f.advance(3 * DAY); f.say('买了');
  assert.match(f.say('第 1 个联动保修 2年'), /名称要求/);
  assert.equal(readRecordState(f.lifeFile).belongings[0].purchase, undefined);
});

function bought(f) {
  f.say('冷静期：耳机 899元'); f.advance(3 * DAY);
  return f.say('第 1 个买了');
}
