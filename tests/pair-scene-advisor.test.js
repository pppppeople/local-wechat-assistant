'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPairSceneAdvisor, pendingReminderSummary } = require('../src/pair-scene-advisor');

const NOW = Date.UTC(2026, 8, 4, 4);
const DAY = 86400000;

function dependencies(overrides = {}) {
  return {
    universalInbox: { list: () => '合成票券' },
    sharedPlaceBox: { handle: async () => '合成路线' },
    sharedLife: { handle: () => '合成清单' },
    coordination: { matchAvailability: async () => '合成交集', busyStatus: () => '合成状态' },
    relayStore: { list: () => [] },
    now: () => NOW,
    ...overrides,
  };
}

test('reminder summary filters statuses and half-open bounds before limiting to five', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-scene-advisor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'reminders.json');
  const jobs = [
    { status: 'completed', text: '已完成', sendAt: NOW },
    { status: 'cancelled', text: '已取消', sendAt: NOW },
    { status: 'pending', text: '太早', sendAt: NOW - 1 },
    { status: 'pending', text: '开始', body: '不用正文', sendAt: NOW },
    { status: 'sent', body: '正文', sendAt: NOW + 60000 },
    { status: 'awaiting_confirmation', mode: '模式', sendAt: NOW + 120000 },
    { status: 'pending', text: '结束前', sendAt: NOW + DAY - 1 },
    { status: 'pending', text: '第五', sendAt: NOW + 180000 },
    { status: 'pending', text: '第六', sendAt: NOW + 240000 },
    { status: 'pending', text: '结束', sendAt: NOW + DAY },
  ];
  fs.writeFileSync(file, JSON.stringify(jobs));
  const before = fs.readFileSync(file, 'utf8');
  const relayStore = { list: side => { assert.equal(side, 'friend'); return JSON.parse(fs.readFileSync(file, 'utf8')); } };
  const summary = pendingReminderSummary(relayStore, 'friend', { startAt: NOW, endAt: NOW + DAY });
  assert.deepEqual(summary.split('\n').map(line => line.split('（')[0]),
    ['• 开始', '• 正文', '• 模式', '• 结束前', '• 第五']);
  assert.match(summary, /9\/4.*12:00/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(pendingReminderSummary({ list: () => [{ status: 'sent', body: '无时间' }] }, 'owner'), '• 无时间');
  assert.equal(pendingReminderSummary({ list: () => jobs.slice(0, 2) }, 'owner'), '没有临近的未完成提醒。');
});

test('scene rejects invalid ranges before consulting any dependency', async () => {
  const advisor = createPairSceneAdvisor({ now: () => NOW });
  for (const window of [{}, { startAt: NaN, endAt: NOW }, { startAt: NOW, endAt: Infinity },
    { startAt: String(NOW), endAt: NOW + DAY }, { startAt: NOW, endAt: NOW },
    { startAt: NOW + 1, endAt: NOW }]) {
    await assert.rejects(advisor.build('owner', { kind: 'date', window }), /场景建议时间范围无效/);
  }
  await assert.rejects(advisor.build('owner', { dayOffset: 'invalid' }), /场景建议时间范围无效/);
});

test('solo scene uses fixed-clock default windows without invoking pair services', async () => {
  for (const [dayOffset, expectedLabel] of [[undefined, '今天'], ['1', '2026-09-05'], [-1, '2026-09-03']]) {
    const calls = [];
    const forbidden = () => { assert.fail('solo scene must not consult pair services'); };
    const advisor = createPairSceneAdvisor(dependencies({
      coordination: { matchAvailability: forbidden, busyStatus: forbidden },
      sharedPlaceBox: { handle: forbidden },
      universalInbox: { list: (...args) => { calls.push(args); return '合成票券'; } },
      sharedLife: { handle: (side, command) => {
        assert.equal(side, 'friend');
        assert.deepEqual(command, { type: 'inventory_list', needsOnly: true });
        return '待检查';
      } },
    }));
    const reply = dayOffset === undefined ? await advisor.build('friend') : await advisor.build('friend', { dayOffset });
    const startAt = NOW + Number(dayOffset || 0) * DAY;
    assert.deepEqual(calls, [['friend', 'ticket', { window: { startAt, endAt: startAt + DAY, label: expectedLabel } }]]);
    assert.match(reply, /^出门建议（只读，不会自动创建提醒）：/);
    assert.match(reply, /待检查/);
    assert.doesNotMatch(reply, /【共同时间】|【对方状态】|【共同约定】|【想去箱/);
  }
});

test('pair scene degrades route failures but propagates failures from earlier services', async () => {
  for (const [kind, error, message] of [['date', new Error('合成路线失败'), '合成路线失败'], ['trip', {}, '地点信息不足']]) {
    const advisor = createPairSceneAdvisor(dependencies({
      sharedPlaceBox: { handle: async () => { throw error; } },
    }));
    const reply = await advisor.build('owner', { kind, label: '合成出游' });
    assert.match(reply, /^合成出游建议/);
    assert.ok(reply.includes(`暂时没有生成路线：${message}。`));
    assert.match(reply, /没有提供出发地时/);
  }
  const failure = new Error('合成上游失败');
  for (const overrides of [
    { coordination: { matchAvailability: async () => { throw failure; } } },
    { universalInbox: { list: () => { throw failure; } } },
    { relayStore: { list: () => { throw failure; } } },
    { sharedLife: { handle: () => { throw failure; } } },
  ]) {
    await assert.rejects(createPairSceneAdvisor(dependencies(overrides)).build('owner', { kind: 'date' }),
      error => error === failure);
  }
});
