'use strict';
const { shanghaiDate } = require('./shared-place-commands');

function pendingReminderSummary(relayStore, side, range) {
  const jobs = relayStore.list(side).filter((job) => ['pending', 'sent', 'awaiting_confirmation'].includes(job.status)
    && (!range || job.sendAt >= range.startAt && job.sendAt < range.endAt)).slice(0, 5);
  if (!jobs.length) return '没有临近的未完成提醒。';
  return jobs.map((job) => `• ${job.text || job.body || job.mode}${job.sendAt ? `（${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(job.sendAt))}）` : ''}`).join('\n');
}

function createPairSceneAdvisor({ universalInbox, sharedPlaceBox, sharedLife, coordination, relayStore, now = () => Date.now() }) {
  async function build(side, command = {}) {
    const dayOffset = Number(command.dayOffset || 0);
    const startAt = now() + dayOffset * 86400000;
    const range = command.window || { startAt, endAt: startAt + 86400000, label: dayOffset ? shanghaiDate(startAt) : '今天' };
    if (!Number.isFinite(range.startAt) || !Number.isFinite(range.endAt) || range.endAt <= range.startAt) throw new Error('场景建议时间范围无效');
    const date = shanghaiDate(range.startAt);
    const pairScene = ['date', 'trip'].includes(command.kind);
    const sections = [`${command.label || '出门'}建议（只读，不会自动创建提醒）：`];
    if (pairScene) {
      sections.push(`\n【共同时间】\n${await coordination.matchAvailability(side, range)}`);
      sections.push(`\n【对方状态】\n${coordination.busyStatus(side, 'peer')}`);
    }
    sections.push(`\n【票券／预约】\n${universalInbox.list(side, 'ticket', { window: range })}`);
    sections.push(`\n【临近提醒】\n${pendingReminderSummary(relayStore, side, range)}`);
    if (pairScene) sections.push(`\n【共同约定】\n${sharedLife.handle(side, { type: 'commitment_list' })}`);
    sections.push(`\n【出门前可检查】\n${sharedLife.handle(side, { type: 'inventory_list', needsOnly: true })}`);
    if (pairScene) {
      try {
        sections.push(`\n【想去箱与路线（${date}）】\n${await sharedPlaceBox.handle(side, { type: 'recommend', date, label: date, energy: 'balanced' })}`);
      } catch (error) {
        sections.push(`\n【想去箱与路线】\n暂时没有生成路线：${error.message || '地点信息不足'}。`);
      }
    }
    sections.push('\n没有提供出发地时，我不会猜家或公司的位置；地图路线只比较候选地点之间的顺序。');
    return sections.join('\n');
  }
  return { build };
}

module.exports = { createPairSceneAdvisor, pendingReminderSummary };
