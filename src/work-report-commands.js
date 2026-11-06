'use strict';

const { shanghaiDay } = require('./personal-todo-commands');
const { refused, unchanged } = require('./feature-result');

function parseWorkReportCommand(text) {
  return /^(?:工作日报|生成工作日报)$/u.test(String(text || '').trim()) ? { type: 'report' } : null;
}

function createWorkReport({ todos, worklogs, provider, now = () => Date.now() }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('工作日报仅主人可用，好友不能读取工作日志或个人待办。');
    if (command?.type !== 'report') return refused('请发送“工作日报”或“生成工作日报”。');
    try {
      const today = shanghaiDay(now());
      const logs = worklogs.readDailyEntries(side, today);
      const { completed, open } = todos.readDailyItems(side, today);
      return unchanged(await provider.generate({ today, logs, completed, open }));
    } catch {
      return refused('工作日报生成失败，请稍后重试。');
    }
  } };
}

module.exports = { parseWorkReportCommand, createWorkReport };
