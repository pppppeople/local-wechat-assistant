'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTripChecklistCommand: parse } = require('../src/trip-checklist-commands');
const { createTripChecklistStore } = require('../src/trip-checklist-store');
const { readRecordState, writeRecordState } = require('../src/record-state');

const commands = ['把这份出门清单存为模板：出差', '出门清单模板列表',
  '用模板创建清单：出差', '删除出门清单模板：出差'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-checklist-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'trip-checklist', 'state.json');
  let calls = 0;
  const options = { stateFile, provider: { generate: async () => { calls++; return ['证件', '充电器']; } } };
  const store = createTripChecklistStore(options);
  return { root, stateFile, store, options, calls: () => calls, read: () => readRecordState(stateFile),
    run: (value, side = 'owner') => store.execute(side, parse(value, { hasActive: store.hasActive(side) })) };
}
async function seed(f) {
  await f.run('出门清单：出差');
  await f.run('清单第1项好了');
  await f.run(commands[0]);
}



test('template parser trims names, terminal punctuation and keeps existing phrases first', () => {
  for (const [value, type] of [[commands[0], 'template-save'], [commands[2], 'template-create'],
    [commands[3], 'template-delete']]) {
    const prefix = value.split('：')[0];
    assert.deepEqual(parse(`${prefix}:  出差 。！？;，,  `), { type, name: '出差' });
    assert.deepEqual(parse(`${prefix}： 。！？ `), { type, name: '' });
  }
  assert.deepEqual(parse(commands[1]), { type: 'template-list' });
  for (const [value, expected] of [
    ['出门清单', { type: 'list' }], ['看归档清单', { type: 'archived' }], ['清单归档', { type: 'archive' }],
    ['出门清单：用模板创建清单：出差', { type: 'generate', scenario: '用模板创建清单：出差' }],
    ['清单加一项：出门清单模板列表', { type: 'add', text: '出门清单模板列表' }],
    ['清单第1项好了', { type: 'check', number: 1 }],
    ['清单第1项取消打勾', { type: 'uncheck', number: 1 }],
    ['清单删第1项', { type: 'delete', number: 1 }],
    ['带了出门清单模板列表', { type: 'check-batch', names: ['出门清单模板列表'] }],
  ]) assert.deepEqual(parse(value, { hasActive: true }), expected, value);
  assert.equal(parse('记一下，出门清单模板列表'), null);
});

test('saving copies only original item texts, rejects duplicates and persists a separate classified collection', async t => {
  const f = fixture(t);
  await seed(f);
  const template = f.read().templates[0];
  assert.equal(template.name, '出差');
  assert.deepEqual(template.items, ['证件', '充电器']);
  assert.equal(template.items.some(item => typeof item !== 'string'), false);
  const before = f.read();
  assert.match((await f.run('把这份出门清单存为模板： 出差！')).reply, /同名.*不会覆盖/u);
  assert.deepEqual(f.read(), before);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.deepEqual(index._recordState.collections, ['checklists', 'templates']);
  assert.match(index.templates[0].file, /^records\/templates\/templates\/\d{4}\/\d{2}\//u);
  assert.doesNotMatch(JSON.stringify(index.templates), /证件|充电器|出差/u);
  assert.ok(fs.existsSync(path.join(path.dirname(f.stateFile), index.templates[0].file)));
  const reopened = createTripChecklistStore(f.options);
  assert.match(await reopened.handle('owner', parse(commands[1])), /出差（2 项）/u);
  await f.run('清单加一项：雨伞');
  assert.deepEqual(f.read().templates[0], template);
});

test('save requires an active list; empty names and missing templates refuse without writes', async t => {
  const f = fixture(t);
  assert.match((await f.run(commands[1])).reply, /暂无.*模板/u);
  assert.match((await f.run(commands[0])).reply, /暂无进行中.*不能保存/u);
  for (const value of [commands[0], commands[2], commands[3]]) {
    assert.match((await f.run(`${value.split('：')[0]}： 。！ `)).reply, /名字不能为空/u);
  }
  for (const value of [commands[2], commands[3]]) assert.match((await f.run(value)).reply, /未找到/u);
  assert.equal(f.calls(), 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
  await seed(f);
  await f.run('清单归档');
  assert.match((await f.run('把这份出门清单存为模板：新名')).reply, /暂无进行中.*不能保存/u);
  assert.equal(f.read().templates.length, 1);
});

test('20-template limit refuses the 21st without overwriting and deletion frees capacity', async t => {
  const f = fixture(t);
  await f.run('出门清单：出差');
  for (let i = 1; i <= 20; i++) assert.equal((await f.run(`把这份出门清单存为模板：模板${i}`)).wrote, true);
  const before = f.read();
  assert.match((await f.run('把这份出门清单存为模板：模板21')).reply, /最多 20 份/u);
  assert.deepEqual(f.read(), before);
  assert.equal((await f.run('删除出门清单模板：模板1')).wrote, true);
  assert.equal((await f.run('把这份出门清单存为模板：模板21')).wrote, true);
  assert.equal(f.read().templates.length, 20);
});

test('template creation never calls generation, resets checks and isolates subsequent list changes', async t => {
  const f = fixture(t);
  await seed(f);
  const before = f.read();
  assert.match((await f.run(commands[2])).reply, /已有.*进行中.*先.*清单归档/u);
  assert.deepEqual(f.read(), before);
  await f.run('清单归档');
  let generationCalls = 0;
  const reopened = createTripChecklistStore({ stateFile: f.stateFile,
    provider: { generate: async () => { generationCalls++; throw Error('must not generate'); } } });
  const result = await reopened.execute('owner', parse(commands[2]));
  assert.equal(result.wrote, true);
  assert.match(result.reply, /来自模板：出差/u);
  assert.doesNotMatch(result.reply, /模型|生成/u);
  const created = f.read().checklists.find(list => list.status === 'active');
  assert.deepEqual(created.items.map(item => [item.text, item.checked]), [['证件', false], ['充电器', false]]);
  assert.ok(created.items.every(item => !before.checklists[0].items.some(original => original.id === item.id)));
  for (const value of ['清单第1项好了', '清单加一项：雨伞', '清单删第1项']) {
    await reopened.execute('owner', parse(value));
  }
  assert.deepEqual(f.read().templates, before.templates);
  assert.equal(generationCalls, 0);
});

test('deletion uses exact normalized name, preserves checklist and removes only its record body', async t => {
  const f = fixture(t);
  await seed(f);
  await f.run('把这份出门清单存为模板：出差备用');
  const before = f.read();
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match((await f.run('删除出门清单模板：出')).reply, /未找到/u);
  assert.deepEqual(f.read(), before);
  assert.equal((await f.run('删除出门清单模板： 出差。')).wrote, true);
  assert.deepEqual(f.read().templates.map(template => template.name), ['出差备用']);
  assert.deepEqual(f.read().checklists, before.checklists);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), index.templates[0].file)), false);
  assert.match((await f.run(commands[3])).reply, /未找到/u);
});

test('empty active lists may be saved and recreated without model generation', async t => {
  const f = fixture(t);
  await f.run('出门清单：出差');
  await f.run('清单删第1项');
  await f.run('清单删第1项');
  await f.run(commands[0]);
  await f.run('清单归档');
  assert.equal((await f.run(commands[2])).wrote, true);
  assert.deepEqual(f.read().checklists.at(-1).items, []);
  assert.equal(f.calls(), 1);
});

test('legacy checklist-only state remains readable when templates are first saved', async t => {
  const f = fixture(t);
  await f.run('出门清单：出差');
  const state = f.read();
  delete state.templates;
  writeRecordState(f.stateFile, state, ['checklists']);
  assert.equal(f.store.hasActive('owner'), true);
  assert.equal((await f.run(commands[0])).wrote, true);
  assert.equal(f.read().templates.length, 1);
});

test('friends are refused before storage reads or generation for every template operation', async t => {
  const f = fixture(t);
  // An unreadable index would quarantine/throw if friend admission reached load().
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, '{');
  for (const value of commands) assert.match((await f.run(value, 'friend')).reply, /只供已绑定的本人/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{');
  assert.equal(f.calls(), 0);
});

test('invalid parsed templates quarantine original state before every template operation', async t => {
  for (const damage of [{ id: '' }, { name: ' ' }, { items: Array(51).fill('证件') }]) {
    for (const value of commands) {
      const f = fixture(t);
      const template = { id: 'template-1', name: '出差', createdAt: '2026-10-31T00:00:00Z', items: ['证件'], ...damage };
      const original = JSON.stringify({ schemaVersion: 1, checklists: [], templates: [template] });
      fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
      fs.writeFileSync(f.stateFile, original);
      await assert.rejects(f.run(value), error => {
        assert.match(error.message, /^已保存的内容损坏，已隔离保全：.*。本次操作未执行。$/u);
        assert.equal(error.cause.message, '出门清单模板存储格式无效');
        return true;
      });
      assert.equal(fs.existsSync(f.stateFile), false);
      const files = fs.readdirSync(path.dirname(f.stateFile));
      assert.equal(files.length, 1);
      assert.ok(files[0].startsWith('state.json.corrupt-'));
      assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), files[0]), 'utf8'), original);
      assert.equal(f.calls(), 0);
    }
  }
});

test('unsupported owner operation refuses without creating or changing checklists and templates', async t => {
  const f = fixture(t);
  const command = { type: 'unsupported', number: 1, text: '不得改动' };
  const refusal = { reply: '不支持这个出门清单操作。', wrote: false, continue: false };
  assert.deepEqual(await f.store.execute('owner', command), refusal);
  assert.deepEqual(fs.readdirSync(f.root), []);
  await seed(f);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const index = JSON.parse(before);
  const bodies = [...index.checklists, ...index.templates].map(record => {
    const file = path.join(path.dirname(f.stateFile), record.file);
    return { file, content: fs.readFileSync(file, 'utf8') };
  });
  assert.deepEqual(await f.store.execute('owner', command), refusal);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  for (const body of bodies) assert.equal(fs.readFileSync(body.file, 'utf8'), body.content);
  assert.equal(f.calls(), 1);
});
