'use strict';

const { shanghaiDay } = require('./personal-todo-commands');
const { refused, unchanged } = require('./feature-result');

function createDailyWrapup({ todos, worklogs, provider, now = () => Date.now() }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'summary') return refused('请发送“收工总结”查询。');
    try {
      const today = shanghaiDay(now());
      const logs = worklogs.readDailyEntries(side, today);
      const { completed, open } = todos.readDailyItems(side, today);
      if (!logs.length && !completed.length && !open.length) {
        return unchanged(`今日无工作日志且无今日已完成待办，也无未完成待办（${today}），暂无可整理内容。`);
      }
      return unchanged(await provider.generate({ today, logs, completed, open }));
    } catch {
      return refused('收工总结生成失败（读取记录或模型服务不可用），请稍后重试；未生成总结，未修改任何记录。');
    }
  } };
}

module.exports = { createDailyWrapup };
