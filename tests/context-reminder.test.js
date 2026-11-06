'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseContextReminderCommand: parse } = require('../src/context-reminder-commands');
const { createContextReminderStore } = require('../src/context-reminder-store');
const { createContextReminderTrigger } = require('../src/context-reminder-trigger');
const { createTripChecklistStore } = require('../src/trip-checklist-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-reminder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'context-reminder', 'state.json');
  const options = { stateFile, now: () => Date.parse('2026-10-31T01:00:00Z') };
  const store = createContextReminderStore(options);
  const sent = [], replies = [], logs = [];
  const dependencies = { store, loadAccount: () => ({ userId: 'owner' }),
    sendText: async (_account, sender, text, options) => sent.push({ sender, text, options }),
    sendLongText: async (_account, sender, text) => replies.push({ sender, text }),
    log: text => logs.push(text) };
  return { root, stateFile, store, sent, replies, logs, dependencies,
    adapter: createContextReminderTrigger(dependencies),
    say: text => store.handle('owner', parse(text)),
    read: () => readRecordState(stateFile),
    restart: () => createContextReminderStore(options) };
}



test('three exact setting forms preserve body and original keyword; unsupported forms show all recipes', t => {
  const f = fixture(t);
  for (const [input, expected] of [
    ['下次出门时提醒我带雨伞', { type: 'create', kind: 'outing', text: '带雨伞' }],
    ['下次开任务时提醒我检查工作区', { type: 'create', kind: 'task', text: '检查工作区' }],
    ['下次聊到香港提醒我查签注', { type: 'create', kind: 'keyword', keyword: '香港', text: '查签注' }],
    ['下次聊到临时提醒我确认', { type: 'create', kind: 'keyword', keyword: '临时', text: '确认' }],
    ['下次聊到专业系统提醒我原文\n第二行', { type: 'create', kind: 'keyword', keyword: '专业系统', text: '原文\n第二行' }],
  ]) assert.deepEqual(parse(input), expected);
  for (const input of ['下次出门提醒我带伞', '下次聊到提醒我喝水', '下次开任务时提醒我',
    '下次有空提醒我复盘', '取消情境提醒第零条', '情境提醒帮我安排一下']) {
    assert.deepEqual(parse(input), { type: 'invalid' });
    const reply = f.say(input);
    for (const form of ['下次出门时提醒我', '下次聊到<词>提醒我', '下次开任务时提醒我']) assert.ok(reply.includes(form));
  }
  assert.equal(parse('今天聊了香港'), null);
  assert.equal(parse('记一下，下次出门时提醒我带伞'), null);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('list and cancellation use current active order; cancel archives and frees capacity', async t => {
  const f = fixture(t);
  assert.match(f.say('我的情境提醒'), /暂无/);
  f.say('下次出门时提醒我带伞'); f.say('下次聊到香港提醒我查签注'); f.say('下次开任务时提醒我检查');
  assert.match(f.say('我的情境提醒'), /1\. 下次出门时：带伞\n2\. 下次聊到「香港」时：查签注\n3\. 下次开任务时：检查/);
  assert.match(f.say('取消情境提醒第4条'), /序号无效/);
  assert.match(f.say('取消情境提醒第2条'), /已取消/);
  assert.match(f.say('我的情境提醒'), /2\. 下次开任务时：检查/);
  assert.equal(f.read().reminders[1].reason, 'cancelled');
  await f.restart().trigger('owner', { type: 'message', text: '香港' }, async () => assert.fail('cancelled reminder sent'));
});

test('reject short keyword and cap only pending reminders at twenty', t => {
  const f = fixture(t);
  for (const input of ['下次聊到我提醒我喝水', '下次聊到😀提醒我喝水']) assert.match(f.say(input), /关键词至少 2 字/);
  assert.equal(fs.existsSync(f.stateFile), false);
  for (let i = 0; i < 20; i++) assert.match(f.say(`下次出门时提醒我条目${i}`), /已设置/);
  assert.match(f.say('下次开任务时提醒我超限'), /最多 20 条/);
  assert.equal(f.read().reminders.length, 20);
  f.say('取消情境提醒第1条');
  assert.match(f.say('下次开任务时提醒我新条目'), /已设置/);
  assert.equal(f.read().reminders.filter(item => item.status === 'active').length, 20);
});

test('one keyword event merges ALL matches in one send; case and original substring are deterministic', async t => {
  const f = fixture(t);
  f.say('下次聊到香港提醒我查签注'); f.say('下次聊到香港提醒我带通行证');
  f.say('下次聊到专业系统提醒我查工单'); f.say('下次出门时提醒我带雨伞');
  await f.adapter.message('owner', '去HK处理sap'); assert.equal(f.sent.length, 0);
  await f.adapter.message('owner', '去香港处理专业系统');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, '查签注\n场景：下次聊到「香港」时\n\n带通行证\n场景：下次聊到「香港」时\n\n查工单\n场景：下次聊到「专业系统」时');
  assert.equal(f.read().reminders.filter(item => item.status === 'active').length, 1);
  assert.equal(f.sent[0].sender, 'owner');
  assert.equal(f.sent[0].options.proactive, true);
  assert.equal(f.sent[0].options.record, false);
});

test('friend messages and operations never read or write owner storage or send', async t => {
  const f = fixture(t);
  assert.match(f.store.handle('friend', parse('下次聊到香港提醒我检查')), /仅主人/);
  assert.equal(await f.store.trigger('friend', { type: 'message', text: '香港' }, async () => assert.fail()), false);
  assert.equal(fs.existsSync(f.stateFile), false);
  f.say('下次聊到香港提醒我检查');
  for (const text of ['香港', '我的情境提醒', '取消情境提醒第1条', '下次开任务时提醒我做事']) {
    assert.equal(await f.adapter.message('friend', text), false);
  }
  assert.equal(f.sent.length, 0); assert.equal(f.replies.length, 0);
  assert.equal(f.read().reminders[0].status, 'active');
});

test('new setting cannot trigger itself; commands reply through owner channel; restart restores independent bodies', async t => {
  const f = fixture(t);
  await f.adapter.message('owner', '下次聊到香港提醒我查香港签注');
  assert.equal(f.sent.length, 0); assert.match(f.replies[0].text, /已设置/);
  const cold = f.restart();
  assert.match(cold.handle('owner', parse('我的情境提醒')), /查香港签注/);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match(index.reminders[0].file, /^records\/reminders\/keyword\/2026\/10\//);
  assert.ok(fs.existsSync(path.join(path.dirname(f.stateFile), index.reminders[0].file)));
  await cold.trigger('owner', { type: 'message', text: '香港' }, async () => {});
  assert.equal(f.restart().handle('owner', parse('我的情境提醒')), '暂无待触发的情境提醒。');
});

test('failed delivery logs once and cannot replay after restart; failed trigger never blocks caller', async t => {
  const f = fixture(t); f.say('下次开任务时提醒我检查');
  let attempts = 0;
  const adapter = createContextReminderTrigger({ ...f.dependencies,
    sendText: async () => { attempts++; throw Error('mock send failure'); } });
  assert.equal(await adapter.trigger('owner', { type: 'task' }), false);
  assert.match(f.logs[0], /context reminder trigger failed: mock send failure/);
  await f.restart().trigger('owner', { type: 'task' }, async () => assert.fail());
  await adapter.trigger('owner', { type: 'task' });
  assert.equal(attempts, 1); assert.equal(f.logs.length, 1);
});

test('keyword delivery failure does not block a setting command in the same owner message', async t => {
  const f = fixture(t); f.say('下次聊到香港提醒我查签注');
  const adapter = createContextReminderTrigger({ ...f.dependencies,
    sendText: async () => { throw Error('mock delivery failed'); } });
  assert.equal(await adapter.message('owner', '下次聊到香港提醒我带证件'), true);
  assert.match(f.replies[0].text, /已设置/);
  const reminders = f.read().reminders;
  assert.equal(reminders[0].status, 'archived');
  assert.equal(reminders[1].status, 'active');
  assert.match(f.logs[0], /mock delivery failed/);
});

test('command storage failure returns explicit failure rather than success', async t => {
  const f = fixture(t);
  const adapter = createContextReminderTrigger({ ...f.dependencies, store: {
    trigger: async () => false, handle() { throw Error('已保存的内容损坏，已隔离保全：mock'); },
  } });
  assert.equal(await adapter.message('owner', '我的情境提醒'), true);
  assert.match(f.replies[0].text, /本次未处理.*损坏.*已隔离保全/);
});

test('actual checklist open hook only fires for owner viewing an active list, and trigger failure leaves list usable', async t => {
  const f = fixture(t); f.say('下次出门时提醒我带雨伞');
  let opens = 0;
  const lists = createTripChecklistStore({ stateFile: path.join(f.root, 'checklist', 'state.json'),
    provider: { generate: async () => ['证件'] }, onOpen: async () => {
      opens++; await f.adapter.trigger('owner', { type: 'outing' });
    } });
  await lists.handle('owner', { type: 'list' }); assert.equal(opens, 0);
  await lists.handle('owner', { type: 'generate', scenario: '机场' }); assert.equal(opens, 0);
  await lists.handle('friend', { type: 'list' }); assert.equal(opens, 0);
  assert.match(await lists.handle('owner', { type: 'list' }), /出门清单：机场/);
  await lists.handle('owner', { type: 'list' });
  assert.equal(opens, 2); assert.equal(f.sent.length, 1);
  await lists.handle('owner', { type: 'archive' }); await lists.handle('owner', { type: 'archived' });
  await lists.handle('owner', { type: 'list' }); assert.equal(opens, 2);
  const broken = createTripChecklistStore({ stateFile: path.join(f.root, 'broken', 'state.json'),
    provider: { generate: async () => ['证件'] }, onOpen: () => createContextReminderTrigger({ ...f.dependencies,
      store: { trigger: async () => { throw Error('storage failed'); } } }).trigger('owner', { type: 'outing' }) });
  await broken.handle('owner', { type: 'generate', scenario: '机场' });
  assert.match(await broken.handle('owner', { type: 'list' }), /证件/);
  assert.match(f.logs.at(-1), /storage failed/);
});
