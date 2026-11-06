'use strict';

const { addDays, shanghaiDay } = require('./personal-todo-commands');
const { refused, unchanged, resultText } = require('./feature-result');

// Sources return read-only projections. This module owns no filesystem or clock.
async function buildDailyBrief({ now, sources }) {
  const today = shanghaiDay(now);
  const date = new Date(`${today}T00:00:00Z`);
  const sections = [];
  let todoTotal;
  async function section(title, read, render, inline = false) {
    try {
      const body = render(await read());
      if (body) sections.push(inline ? body : `${title}\n${body}`);
    } catch {
      sections.push(`${title}（暂时读取失败）`);
    }
  }
  await section('个人待办', sources.todos, (items) => {
    todoTotal = items.length;
    // Select the latest three undated items without changing list order/numbers.
    const undated = items.filter((item) => !item.dueDate);
    const recent = new Set(undated.slice(-3).map((item) => item.number));
    const rows = items.filter((item) => item.dueDate || recent.has(item.number)).map((item) => {
      const label = !item.dueDate ? '无到期日' : item.dueDate < today ? `逾期 ${item.dueDate}`
        : item.dueDate === today ? '今天到期' : `到期 ${item.dueDate}`;
      return `${item.number}. ${item.text}（${label}）`;
    });
    if (undated.length > 3) rows.push(`无到期日待办还有 ${undated.length - 3} 条。`);
    return rows.join('\n');
  });
  await section('共享生活箱', sources.life, ({ commitments, inventory }) => {
    const due = commitments.filter((item) => /^\d{4}-\d{2}-\d{2}$/u.test(item.dueDate || '')
      && item.dueDate <= addDays(today, 7))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return [...due.map((item) => `约定：${item.text}（${item.dueDate < today ? '逾期 ' : '到期 '}${item.dueDate}）`),
      ...(inventory.length ? [`需要补货：${inventory.join('、')}`] : [])].join('\n');
  });
  await section('任务状态', sources.tasks, ({ durableOrdinaryJobs: depth, heldOrdinaryJobs: held }) =>
    depth ? `未结束任务 ${depth} 个（其中绑定暂停 ${held} 个）。` : '');
  await section('想去箱', sources.places, (count) => count ? `想去箱还有 ${count} 个没去的地方` : '', true);
  if (!sections.length) return `今天没有需要特别关注的事。\n待办总数：${todoTotal} 条未完成。`;
  return [`今日简报（${date.getUTCMonth() + 1}月${date.getUTCDate()}日，星期${'日一二三四五六'[date.getUTCDay()]}）。`,
    ...sections].join('\n\n');
}

async function executeDailyBrief(side, command, options) {
  if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
  if (command?.type !== 'brief') return refused('不支持这个每日简报操作。');
  return unchanged(await buildDailyBrief(options));
}
async function dailyBriefText(side, command, options) {
  return resultText(await executeDailyBrief(side, command, options));
}

module.exports = { buildDailyBrief, executeDailyBrief, dailyBriefText };
