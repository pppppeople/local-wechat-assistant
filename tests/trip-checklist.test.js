'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTripChecklistCommand: parse } = require('../src/trip-checklist-commands');
const { createTripChecklistStore } = require('../src/trip-checklist-store');
const { createTripChecklistProvider } = require('../src/trip-checklist-provider');
const { readRecordState, writeRecordState } = require('../src/record-state');
const NOW = Date.parse('2026-10-31T00:00:00Z');

function fixture(t, generate = () => ['核对取件信息', '带充电宝', '带雨伞']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-checklist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'trip-checklist', 'state.json');
  const calls = [];
  const store = createTripChecklistStore({ stateFile, now: () => NOW,
    provider: { generate: async args => { calls.push(args); return generate(args); } } });
  return { root, stateFile, calls, store, read: () => readRecordState(stateFile),
    run: (text, side = 'owner') => store.execute(side, parse(text, { hasActive: store.hasActive(side) })) };
}



test('explicit commands and confusing todo phrases stay separate', () => {
  assert.deepEqual(parse('帮我准备出门清单：明天去香港取东西'), { type: 'generate', scenario: '明天去香港取东西' });
  assert.deepEqual(parse('出门清单:周六去机场接人'), { type: 'generate', scenario: '周六去机场接人' });
  assert.deepEqual(parse('清单第 2 项好了'), { type: 'check', number: 2 });
  assert.deepEqual(parse('清单第2项取消打勾'), { type: 'uncheck', number: 2 });
  assert.deepEqual(parse('清单加一项：纸巾'), { type: 'add', text: '纸巾' });
  assert.deepEqual(parse('清单删第2项'), { type: 'delete', number: 2 });
  const todo = require('../src/personal-todo-commands').parsePersonalTodoCommand;
  for (const value of ['记一下，准备出门清单', '记一下，出门清单：明天去香港取东西', '我的待办',
    '第1项完成', '完成第1项', '取消第1项', '清空已完成', '明天去机场接人', '帮我准备出门',
    '清单好了吗', '帮我看看清单']) {
    assert.equal(parse(value), null, value);
  }
  for (const value of ['记一下，准备出门清单', '记一下，出门清单：明天去香港取东西', '我的待办']) assert.ok(todo(value));
});

test('colloquial parsing is pure, active-only and splits reported names deterministically', () => {
  for (const [value, names] of [
    ['带了充电器、衣服', ['充电器', '衣服']],
    ['我已经带了充电器和雨伞', ['充电器', '雨伞']],
    ['都带了：A，B，C', ['A', 'B', 'C']],
    ['都带了:A, B、C和D。', ['A', 'B', 'C', 'D']],
    ['带了充电器、充电器', ['充电器']],
  ]) {
    assert.equal(parse(value), null);
    assert.deepEqual(parse(value, { hasActive: true }), { type: 'check-batch', names });
  }
  for (const value of ['还剩什么没带', '看看缺漏']) {
    assert.equal(parse(value), null);
    assert.deepEqual(parse(value, { hasActive: true }), { type: 'remaining' });
  }
  for (const value of ['带了', '带了、，和', '我没带充电器', '你带了充电器吗', '记一下，带了雨伞']) {
    assert.equal(parse(value, { hasActive: true }), null);
  }
});

test('batch checks exact then bidirectional containment and replies with only remaining items', async t => {
  const f = fixture(t, () => ['充电器', '备用充电器', '带衣服', '雨伞', '纸巾']);
  await f.run('出门清单：测试出门');
  const result = await f.run('我已经带了充电器和衣服、折叠雨伞');
  assert.equal(result.wrote, true);
  assert.match(result.reply, /已勾选：充电器、带衣服、雨伞\n仍未带：\n- 备用充电器\n- 纸巾/u);
  assert.deepEqual(f.read().checklists[0].items.map(item => item.checked), [true, false, true, true, false]);
  const before = f.read();
  const repeat = await f.run('带了充电器');
  assert.equal(repeat.wrote, false);
  assert.match(repeat.reply, /此前已勾选：充电器/u);
  assert.deepEqual(f.read(), before); // Must not fall through to 备用充电器.
  for (const query of ['还剩什么没带', '看看缺漏']) {
    const remaining = await f.run(query);
    assert.equal(remaining.wrote, false);
    assert.equal(remaining.reply, '仍未带：\n- 备用充电器\n- 纸巾');
  }
  assert.deepEqual(f.read(), before);
  assert.equal(f.calls.length, 1); // Reports and queries never use the model.
});

test('ambiguous and unmatched reports leave state and saved files untouched', async t => {
  const f = fixture(t, () => ['手机充电器', '电脑充电器', '雨伞']);
  await f.run('出门清单：测试出门');
  const before = f.read();
  const index = fs.readFileSync(f.stateFile, 'utf8');
  const bodyFile = path.join(path.dirname(f.stateFile), JSON.parse(index).checklists[0].file);
  const body = fs.readFileSync(bodyFile, 'utf8');
  const result = await f.run('带了充电器、衣服');
  assert.equal(result.wrote, false);
  assert.match(result.reply, /待确认（未自动勾选）：充电器（手机充电器、电脑充电器）/u);
  assert.match(result.reply, /未找到对应项：衣服/u);
  assert.deepEqual(f.read(), before);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.equal(fs.readFileSync(bodyFile, 'utf8'), body);
  const partial = await f.run('带了手机充电器、充电器、衣服');
  assert.equal(partial.wrote, true);
  assert.match(partial.reply, /待确认（未自动勾选）：充电器（手机充电器、电脑充电器）/u);
  assert.deepEqual(f.read().checklists[0].items.map(item => item.checked), [true, false, false]);
});

test('duplicate exact names are ambiguous; repeated reports are idempotent including all-packed lists', async t => {
  const duplicate = fixture(t, () => ['充电器', '充电器']);
  await duplicate.run('出门清单：测试');
  assert.equal((await duplicate.run('带了充电器')).wrote, false);
  assert.ok(duplicate.read().checklists[0].items.every(item => !item.checked));
  const f = fixture(t, () => ['充电器', '衣服']);
  await f.run('出门清单：测试');
  let result = await f.run('带了充电器、充电器、手机充电器');
  assert.equal(result.wrote, true);
  assert.match(result.reply, /^已勾选：充电器\n/u);
  const before = f.read();
  result = await f.run('带了充电器');
  assert.equal(result.wrote, false);
  assert.match(result.reply, /此前已勾选：充电器/u);
  assert.deepEqual(f.read(), before);
  result = await f.run('都带了：充电器，衣服');
  assert.equal(result.wrote, true);
  assert.match(result.reply, /已全部带齐/u);
  assert.equal((await f.run('带了充电器和衣服')).wrote, false);
  assert.equal((await f.run('看看缺漏')).reply, '已全部带齐。');
  assert.equal(f.read().checklists[0].status, 'active');
});

test('active admission is owner-only, never creates state and stops after archive', async t => {
  const f = fixture(t);
  assert.equal(f.store.hasActive('owner'), false);
  assert.equal(f.store.hasActive('friend'), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
  await f.run('出门清单：测试');
  assert.equal(f.store.hasActive('owner'), true);
  assert.equal(f.store.hasActive('friend'), false);
  await f.run('清单归档');
  assert.equal(f.store.hasActive('owner'), false);
  for (const value of ['带了雨伞', '还剩什么没带', '看看缺漏']) {
    assert.equal(parse(value, { hasActive: f.store.hasActive('owner') }), null);
  }
});

test('check, uncheck, add, delete, archive and regenerate follow latest displayed numbering', async t => {
  const f = fixture(t);
  await f.run('出门清单：机场接人');
  let result = await f.run('清单第1项好了');
  assert.match(result.reply, /1\. \[ \] 带充电宝\n2\. \[ \] 带雨伞\n3\. \[✓\] 已打勾 核对取件信息/u);
  result = await f.run('清单第3项取消打勾');
  assert.match(result.reply, /1\. \[ \] 核对取件信息/u);
  await f.run('清单第2项好了');
  result = await f.run('清单加一项：带纸巾');
  assert.match(result.reply, /3\. \[ \] 带纸巾\n4\. \[✓\] 已打勾 带充电宝/u);
  result = await f.run('清单删第4项');
  assert.doesNotMatch(result.reply, /带充电宝/u);
  assert.equal(f.read().checklists[0].items.length, 3);
  const before = f.read();
  for (const value of ['清单第0项好了', '清单第99项取消打勾', '清单删第9007199254740992项', '清单加一项：']) {
    assert.equal((await f.run(value)).wrote, false);
    assert.deepEqual(f.read(), before);
  }
  assert.equal((await f.run('清单归档')).wrote, true);
  assert.match((await f.run('出门清单')).reply, /暂无进行中/u);
  assert.match((await f.run('看归档清单')).reply, /归档清单：机场接人/u);
  for (const value of ['清单第1项好了', '清单第1项取消打勾', '清单加一项：x', '清单删第1项', '清单归档']) {
    assert.equal((await f.run(value)).wrote, false);
  }
  await f.run('出门清单：香港取东西');
  assert.doesNotMatch((await f.run('出门清单')).reply, /机场接人/u);
  assert.match((await f.run('看归档清单')).reply, /机场接人/u);
  await f.run('清单归档');
  assert.match((await f.run('看归档清单')).reply, /香港取东西/u);
  assert.equal(f.read().checklists.length, 2); // Keep archives, including equal-time archives in insertion order.
  assert.equal(f.calls.length, 2);
});

test('single active constraint includes all-checked and empty lists; concurrent generations call provider once', async t => {
  const f = fixture(t, () => ['证件']);
  const results = await Promise.all([f.run('出门清单：香港'), f.run('出门清单：机场')]);
  assert.deepEqual(results.map(result => result.wrote), [true, false]);
  assert.match(results[1].reply, /先.*归档.*继续/u);
  await f.run('清单第1项好了');
  assert.equal((await f.run('清单第1项好了')).wrote, false);
  assert.equal((await f.run('出门清单：机场')).wrote, false);
  await f.run('清单删第1项');
  assert.match((await f.run('出门清单')).reply, /暂无条目/u);
  assert.equal((await f.run('出门清单：机场')).wrote, false);
  assert.equal(f.calls.length, 1);
});

test('invalid model batches and exceptions discard whole generation without files', async t => {
  for (const generate of [() => undefined, () => ({}), () => [], () => ['证件', ' '],
    () => ['证件', 2], () => [{ text: '证件' }], () => Array(51).fill('证件'), () => { throw Error('offline'); }]) {
    const f = fixture(t, generate);
    const result = await f.run('出门清单：香港');
    assert.equal(result.wrote, false);
    assert.match(result.reply, /整次作废.*未保存/u);
    assert.deepEqual(fs.readdirSync(f.root), []);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(t);
  assert.equal((await f.run('出门清单：')).wrote, false);
  assert.equal(f.calls.length, 0);
});

test('50-item cap counts checked items; deleting frees capacity', async t => {
  const f = fixture(t, () => Array.from({ length: 50 }, (_, i) => `物品${i + 1}`));
  assert.equal((await f.run('出门清单：香港')).wrote, true);
  await f.run('清单第1项好了');
  const before = f.read();
  assert.match((await f.run('清单加一项：纸巾')).reply, /最多 50 项/u);
  assert.deepEqual(f.read(), before);
  await f.run('清单删第50项');
  assert.equal((await f.run('清单加一项：纸巾')).wrote, true);
  assert.equal(f.read().checklists[0].items.length, 50);
});

test('production provider uses one isolated schema call and rejects invalid envelope or items', async () => {
  let args;
  const provider = createTripChecklistProvider({ model: async (...input) => {
    args = input; return { ok: true, value: input[3].parse('{"items":["证件","充电器"]}') };
  } });
  assert.deepEqual(await provider.generate({ scenario: '香港' }), ['证件', '充电器']);
  assert.equal(args[1], ''); assert.deepEqual(args[2], []);
  assert.equal(args[3].stage, 'trip_checklist_generate');
  assert.equal(args[3].schema.additionalProperties, false);
  assert.equal(args[3].schema.properties.items.maxItems, 50);
  for (const value of [null, ['证件'], { items: [] }, { items: [' '] }, { items: ['证件'], extra: true }, { items: [true] }]) {
    assert.throws(() => args[3].parse(JSON.stringify(value)));
    const invalid = createTripChecklistProvider({ model: async () => ({ ok: true, value }) });
    await assert.rejects(invalid.generate({ scenario: '机场' }));
  }
  assert.throws(() => args[3].parse('not json'));
  await assert.rejects(createTripChecklistProvider({ model: async () => ({ ok: false }) }).generate({ scenario: '机场' }));
});

test('strict corruption quarantines index, preserves record original and never calls generation', async t => {
  for (const corrupt of ['json', 'body', 'missing-body', 'state', 'item']) {
    const f = fixture(t);
    await f.run('出门清单：香港');
    const index = JSON.parse(fs.readFileSync(f.stateFile));
    const bodyFile = path.join(path.dirname(f.stateFile), index.checklists[0].file);
    if (corrupt === 'json') fs.writeFileSync(f.stateFile, '{');
    if (corrupt === 'body') fs.writeFileSync(bodyFile, 'invalid body');
    if (corrupt === 'missing-body') fs.unlinkSync(bodyFile);
    if (corrupt === 'item') {
      const state = f.read();
      state.checklists[0].items[0].checked = 'yes';
      writeRecordState(f.stateFile, state, ['checklists']);
    }
    if (corrupt === 'state') {
      const state = f.read();
      state.checklists.push({ ...state.checklists[0], id: 'second-active' });
      writeRecordState(f.stateFile, state, ['checklists']);
    }
    await assert.rejects(f.run('出门清单：机场'), /损坏.*本次操作未执行/u);
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(file => file.includes('.corrupt-')));
    assert.equal(fs.existsSync(bodyFile), corrupt !== 'missing-body');
  }
});

test('friends refused before data read/model for every operation', async t => {
  const f = fixture(t);
  for (const value of ['出门清单：香港', '出门清单', '看归档清单', '清单归档', '清单第1项好了',
    '清单第1项取消打勾', '清单加一项：纸巾', '清单删第1项']) {
    assert.match((await f.run(value, 'friend')).reply, /只供已绑定的本人/u);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
