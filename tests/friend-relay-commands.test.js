'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeTimestamp,
  nextOccurrence,
  parseRelayCommand,
  parseTimeExpression,
  relayModeAction,
  relayModeLabel,
  relaySpeechAct,
  shanghaiParts,
} = require('../src/friend-relay-commands');

const NOW = Date.parse('2026-10-25T00:00:00.000Z');
const TOMORROW_8 = Date.parse('2026-10-26T00:00:00.000Z');
const PEERS = { peerNames: ['好友', 'A.B'] };

function scheduleAt(expression, now = NOW) {
  return parseTimeExpression(expression, now);
}

test('returns null for empty, nullish, and unsupported relay inputs', () => {
  assert.equal(parseRelayCommand(null), null);
  assert.equal(parseRelayCommand(undefined), null);
  assert.equal(parseRelayCommand('   '), null);
  assert.equal(parseRelayCommand(0), null);
  assert.equal(parseRelayCommand('随便说一句', PEERS), null);
});

test('parses management commands and their punctuation variants', () => {
  assert.deepEqual(parseRelayCommand('转告帮助'), { type: 'help' });
  assert.deepEqual(parseRelayCommand('我还有哪些提醒？'), { type: 'list' });
  assert.deepEqual(parseRelayCommand('恢复转告'), { type: 'enable' });
  assert.deepEqual(parseRelayCommand('暂停转告'), { type: 'disable' });
  assert.deepEqual(parseRelayCommand('清除我的转告记录'), { type: 'delete' });
  assert.deepEqual(parseRelayCommand('查看当前的定时任务列表。'), { type: 'list' });
});

test('keeps bare reminder responses gated while accepting explicit reminder responses', () => {
  assert.deepEqual(parseRelayCommand('提醒已收到！'), { type: 'confirm' });
  assert.deepEqual(parseRelayCommand('提醒搞定了'), { type: 'complete' });
  assert.equal(parseRelayCommand('收到'), null);
  assert.equal(parseRelayCommand('完成'), null);
  assert.deepEqual(parseRelayCommand('收到', { acceptBareReminderResponse: true }), { type: 'confirm' });
  assert.deepEqual(parseRelayCommand('完成', { acceptBareReminderResponse: true }), { type: 'complete' });
});

test('normalizes tracking and cancellation identifiers at the command boundary', () => {
  assert.deepEqual(parseRelayCommand('提醒状态 #ab-12'), { type: 'tracking_status', id: 'AB-12' });
  assert.deepEqual(parseRelayCommand('对方已经确认刚才那个提醒了吗'), { type: 'tracking_status', id: '' });
  assert.deepEqual(parseRelayCommand('取消提醒 ＃ab-12！'), { type: 'cancel', id: 'AB-12' });
  assert.deepEqual(parseRelayCommand('把任务 xy9 删除'), { type: 'cancel', id: 'XY9' });
});

test('escapes configured peer names and does not match a different name', () => {
  const command = parseRelayCommand('告诉A.B：你好', PEERS);
  assert.deepEqual(command, {
    type: 'create', mode: 'relay', speechAct: 'statement', text: '你好', schedule: null,
  });
  assert.equal(parseRelayCommand('告诉A0B：你好', PEERS), null);
});

test('distinguishes explicit questions, rhetorical questions, and replies', () => {
  assert.deepEqual(parseRelayCommand('问A.B：几点到？', PEERS), {
    type: 'create', mode: 'relay', speechAct: 'question', text: '几点到？', schedule: null,
  });
  assert.equal(parseRelayCommand('问A.B：会怎么样？', PEERS), null);
  assert.deepEqual(parseRelayCommand('回复A.B：我到了', PEERS), {
    type: 'create', mode: 'relay', speechAct: 'statement', text: '我到了',
    replyToPrevious: true, schedule: null,
  });
});

test('wraps relay messages in a requested format and rejects a non-relay body', () => {
  assert.deepEqual(parseRelayCommand('请用邮件的格式发给A.B：稍后见', PEERS), {
    type: 'create', mode: 'relay', speechAct: 'statement', text: '稍后见', schedule: null,
    format: 'email',
  });
  assert.deepEqual(parseRelayCommand('以新闻播报形式告诉A.B：台风已过境', PEERS), {
    type: 'create', mode: 'relay', speechAct: 'statement', text: '台风已过境', schedule: null,
    format: 'news',
  });
  assert.throws(
    () => parseRelayCommand('用邮件格式写给A.B：稍后见', PEERS),
    /请明确转告对象和正文；格式只用于微信转告/,
  );
});

test('extracts confirmation requirements and clamps follow-up delays', () => {
  const oneMinute = parseRelayCommand('告诉A.B：喝水，需要确认，1分钟内没确认就再提醒一次', PEERS);
  assert.equal(oneMinute.requiresConfirmation, true);
  assert.equal(oneMinute.confirmationFollowUpAfterMs, 5 * 60_000);
  assert.equal(oneMinute.text, '喝水');

  const twoDays = parseRelayCommand('告诉A.B：喝水，需要确认，如果两天内没确认就再提醒一次', PEERS);
  assert.equal(twoDays.requiresConfirmation, true);
  assert.equal(twoDays.confirmationFollowUpAfterMs, 24 * 60 * 60_000);

  const hour = parseRelayCommand('告诉A.B：喝水，需要确认，如果一小时内没确认就再提醒一次', PEERS);
  assert.equal(hour.confirmationFollowUpAfterMs, 60 * 60_000);
});

test('rejects malformed clocks, unknown dates, and empty scheduled peer bodies', () => {
  assert.throws(() => parseTimeExpression(null), /请写明时间/);
  assert.throws(() => parseTimeExpression('明天 24:00', NOW), /时间不合法/);
  assert.throws(() => parseTimeExpression('明天 12:60', NOW), /时间不合法/);
  assert.throws(() => parseTimeExpression('下下周一八点', NOW), /暂不认识这个日期/);
  assert.throws(
    () => parseRelayCommand('明天八点提醒A.B：到点就直接提醒A.B', { ...PEERS, now: NOW }),
    /提醒内容不能为空/,
  );
});

test('enforces the thirty-second future boundary exactly', () => {
  const exactlyThirtySecondsBefore = Date.parse('2026-10-24T23:59:30.000Z');
  const justOverThirtySecondsBefore = Date.parse('2026-10-24T23:59:29.999Z');

  assert.throws(
    () => scheduleAt('08:00', exactlyThirtySecondsBefore),
    /请设置至少一分钟后的时间/,
  );
  assert.equal(scheduleAt('08:00', justOverThirtySecondsBefore).sendAt, Date.parse('2026-10-25T00:00:00.000Z'));
  assert.equal(scheduleAt('08:00', NOW).sendAt, Date.parse('2026-10-26T00:00:00.000Z'));
});

test('handles Chinese-number clocks, periods, and midnight rollover', () => {
  const recurring = scheduleAt('每天二十三点五十九分', NOW);
  assert.deepEqual(recurring.recurrence, { type: 'daily', hour: 23, minute: 59 });
  assert.equal(recurring.sendAt, Date.parse('2026-10-25T15:59:00.000Z'));

  const halfPast = scheduleAt('今晚八点半', NOW);
  assert.equal(halfPast.sendAt, Date.parse('2026-10-25T12:30:00.000Z'));

  const midnight = scheduleAt('今晚十二点', NOW);
  assert.equal(midnight.sendAt, Date.parse('2026-10-25T16:00:00.000Z'));

  const nextMorning = scheduleAt('明晚凌晨一点', NOW);
  assert.equal(nextMorning.sendAt, Date.parse('2026-10-26T17:00:00.000Z'));
});

test('parses 后天下午三点 as the afternoon two days later', () => {
  const now = Date.parse('2026-09-04T12:00:00+08:00');
  assert.equal(describeTimestamp(scheduleAt('后天下午三点', now).sendAt), '9/6周日 15:00');
});

test('parses 后晚八点 as the evening two days later', () => {
  const now = Date.parse('2026-09-04T12:00:00+08:00');
  assert.equal(describeTimestamp(scheduleAt('后晚八点', now).sendAt), '9/6周日 20:00');
});

test('rolls 后晚凌晨一点 into the morning three days later', () => {
  const now = Date.parse('2026-09-04T12:00:00+08:00');
  assert.equal(describeTimestamp(scheduleAt('后晚凌晨一点', now).sendAt), '9/7周一 01:00');
});

test('parses 后早八点 as the morning two days later', () => {
  const now = Date.parse('2026-09-04T12:00:00+08:00');
  assert.equal(describeTimestamp(scheduleAt('后早八点', now).sendAt), '9/6周日 08:00');
});

test('parses 后天十点半 as half past ten two days later', () => {
  const now = Date.parse('2026-09-04T12:00:00+08:00');
  assert.equal(describeTimestamp(scheduleAt('后天十点半', now).sendAt), '9/6周日 10:30');
});

test('parses the unambiguous leading Chinese half-hour peer reminder', () => {
  const command = parseRelayCommand('十点半提醒好友洗衣服', { peerNames: ['好友'], now: NOW });
  assert.equal(command.mode, 'peer_reminder');
  assert.equal(command.text, '洗衣服');
  assert.equal(command.schedule.sendAt, Date.parse('2026-10-25T02:30:00.000Z'));
});

test('keeps the complete leading clock term before a peer reminder body', () => {
  const options = { peerNames: ['好友'], now: NOW };
  const halfPast = parseRelayCommand('提醒好友十点半洗衣服', options);
  assert.equal(halfPast.text, '洗衣服');
  assert.equal(halfPast.schedule.sendAt, Date.parse('2026-10-25T02:30:00.000Z'));

  const exactHour = parseRelayCommand('提醒好友十点洗衣服', options);
  assert.equal(exactHour.text, '洗衣服');
  assert.equal(exactHour.schedule.sendAt, Date.parse('2026-10-25T02:00:00.000Z'));

  const quarterPast = parseRelayCommand('提醒好友十点十五分洗衣服', options);
  assert.equal(quarterPast.text, '洗衣服');
  assert.equal(quarterPast.schedule.sendAt, Date.parse('2026-10-25T02:15:00.000Z'));
});

test('parses a half-hour shared reminder with the peer named after me', () => {
  const command = parseRelayCommand('提醒我和好友十点半洗衣服', { peerNames: ['好友'], now: NOW });
  assert.equal(command.mode, 'shared_reminder');
  assert.equal(command.text, '洗衣服');
  assert.equal(command.schedule.sendAt, Date.parse('2026-10-25T02:30:00.000Z'));
});

test('rejects explicit relay bodies that contain only punctuation or whitespace', () => {
  const options = { peerNames: ['好友'] };
  assert.throws(() => parseRelayCommand('告诉好友：', options), /转告内容不能为空/);
  assert.throws(() => parseRelayCommand('告诉好友：！！！', options), /转告内容不能为空/);
});

test('rejects impossible calendar dates and accepts leap-day dates', () => {
  for (const expression of [
    '2027-02-29 08:00',
    '2027-02-31 08:00',
    '2027-13-01 08:00',
    '2027-00-00 08:00',
    '2月31日 08:00',
  ]) {
    assert.throws(() => scheduleAt(expression), /日期不合法/, expression);
  }
  assert.equal(scheduleAt('2028-02-29 08:00').sendAt, Date.parse('2028-02-29T00:00:00.000Z'));
});

test('maps Chinese weekdays and skips the current occurrence at its exact time', () => {
  const weeklySunday = scheduleAt('每周天九点', NOW);
  assert.deepEqual(weeklySunday.recurrence, { type: 'weekly', weekday: 0, hour: 9, minute: 0 });
  assert.equal(weeklySunday.sendAt, Date.parse('2026-10-25T01:00:00.000Z'));

  const sunday = scheduleAt('周日 08:00', NOW);
  assert.equal(sunday.sendAt, Date.parse('2026-11-01T00:00:00.000Z'));

  const monday = scheduleAt('周一 08:00', NOW);
  assert.equal(monday.sendAt, TOMORROW_8);
});

test('computes next daily and weekly occurrences and rejects an impossible weekday', () => {
  assert.equal(nextOccurrence({ type: 'daily', hour: 8, minute: 0 }, NOW), TOMORROW_8);
  assert.equal(nextOccurrence({ type: 'weekly', weekday: 1, hour: 8, minute: 0 }, NOW), TOMORROW_8);
  assert.equal(nextOccurrence({ type: 'weekly', weekday: 0, hour: 8, minute: 0 }, NOW), Date.parse('2026-11-01T00:00:00.000Z'));
  assert.throws(
    () => nextOccurrence({ type: 'weekly', weekday: 99, hour: 8, minute: 0 }, NOW),
    /无法计算下一次发送时间/,
  );
});

test('parses self, shared, peer, and default-opponent scheduled reminders', () => {
  const self = parseRelayCommand('明天八点提醒我：出门', { now: NOW });
  assert.equal(self.mode, 'self_reminder');
  assert.equal(self.text, '出门');
  assert.equal(self.schedule.sendAt, TOMORROW_8);

  const shared = parseRelayCommand('提醒我和A.B：明天八点出门', { ...PEERS, now: NOW });
  assert.equal(shared.mode, 'shared_reminder');
  assert.equal(shared.text, '出门');
  assert.equal(shared.schedule.sendAt, TOMORROW_8);

  const peer = parseRelayCommand('明天八点提醒A.B喝水', { ...PEERS, now: NOW });
  assert.equal(peer.mode, 'peer_reminder');
  assert.equal(peer.text, '喝水');
  assert.equal(peer.schedule.sendAt, TOMORROW_8);

  const opponent = parseRelayCommand('明天八点提醒对方喝水', { now: NOW });
  assert.equal(opponent.mode, 'peer_reminder');
  assert.equal(opponent.text, '喝水');
});

test('strips the explicit scheduled-reminder suffix and preserves recurring schedules', () => {
  const command = parseRelayCommand('每周一 08:00提醒A.B：开会，到点就直接提醒A.B', { ...PEERS, now: NOW });
  assert.equal(command.mode, 'peer_reminder');
  assert.equal(command.text, '开会');
  assert.deepEqual(command.schedule.recurrence, { type: 'weekly', weekday: 1, hour: 8, minute: 0 });
});

test('parses rescheduling and propagates invalid reschedule time errors', () => {
  const command = parseRelayCommand('改期提醒 ab-2 改成 明天八点', { now: NOW });
  assert.equal(command.type, 'reschedule');
  assert.equal(command.id, 'AB-2');
  assert.equal(command.schedule.sendAt, TOMORROW_8);

  assert.throws(
    () => parseRelayCommand('修改提醒 AB-2 到 下下周一八点', { now: NOW }),
    /暂不认识这个日期/,
  );
});

test('covers relay syntax variants and keeps the sending act explicit', () => {
  for (const input of ['跟A.B说：你好', '给A.B带句话：你好', '让A.B知道：你好']) {
    const command = parseRelayCommand(input, PEERS);
    assert.equal(command.type, 'create');
    assert.equal(command.mode, 'relay');
    assert.equal(command.speechAct, 'statement');
    assert.equal(command.text, '你好');
  }
  assert.deepEqual(parseRelayCommand('询问A.B：几点出发', PEERS), {
    type: 'create', mode: 'relay', speechAct: 'question', text: '几点出发', schedule: null,
  });
});

test('returns stable mode labels and action descriptions for every relay mode', () => {
  assert.equal(relayModeLabel('self_reminder', 'A.B'), '提醒自己');
  assert.equal(relayModeLabel('shared_reminder', 'A.B'), '双人提醒（你和A.B）');
  assert.equal(relayModeLabel('peer_reminder', 'A.B'), '提醒A.B');
  assert.equal(relayModeLabel('reminder', 'A.B'), '提醒你转告A.B');
  assert.equal(relayModeLabel('relay', 'A.B'), '自动转告A.B');

  assert.equal(relayModeAction('self_reminder', 'A.B'), '提醒你自己');
  assert.equal(relayModeAction('shared_reminder', 'A.B'), '同时提醒你和A.B');
  assert.equal(relayModeAction('peer_reminder', 'A.B'), '直接提醒A.B');
  assert.equal(relayModeAction('reminder', 'A.B'), '提醒你转告A.B');
  assert.equal(relayModeAction('relay', 'A.B'), '自动转告A.B');
});

test('reports Shanghai-local parts and keeps speech-act selection independent of body text', () => {
  assert.deepEqual(shanghaiParts(NOW), {
    year: 2026, month: 10, day: 25, hour: 8, minute: 0, weekday: 0,
  });
  assert.equal(describeTimestamp(TOMORROW_8), '10/26周一 08:00');
  assert.equal(relaySpeechAct('这句话包含问号？'), 'statement');
  assert.equal(relaySpeechAct('这句话像问题？', 'question'), 'question');
  assert.equal(relaySpeechAct('仍然是陈述', 'other'), 'statement');
});
