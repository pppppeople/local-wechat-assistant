'use strict';

const { shanghaiDay } = require('./personal-todo-commands');

// The store validates dependencies before this projection. readOpenItems also
// works as input: absent completed prerequisites cannot block an open item.
function selectDailyTopThree(todos, today) {
  const byId = new Map(todos.map(item => [item.id, item]));
  const group = item => !item.dueDate ? 3 : item.dueDate < today ? 0 : item.dueDate === today ? 1 : 2;
  return todos.filter(item => item.status === 'open'
    && !(item.dependencyIds || []).some(id => byId.get(id)?.status === 'open'))
    .sort((a, b) => group(a) - group(b)
      || (a.dueDate || '9999').localeCompare(b.dueDate || '9999')
      || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, 3);
}

function dueLabel(dueDate, today) {
  if (!dueDate) return '无到期日';
  if (dueDate < today) return '逾期';
  if (dueDate === today) return '今天到期';
  return `${Number(dueDate.slice(5, 7))}月${Number(dueDate.slice(8, 10))}日`;
}

function dailyTopThreeReply(side, todos, now = Date.now()) {
  // Admission precedes even the read-only store call.
  if (side !== 'owner') return '这个私人助手只供已绑定的本人使用。';
  const today = shanghaiDay(now);
  const items = selectDailyTopThree(todos.readOpenItems(side), today);
  if (!items.length) return `每日三件事（${today}）：暂无可开始的待办。`;
  return `每日三件事（${today}）：\n`
    + items.map((item, index) => `${index + 1}. ${item.text}（到期：${dueLabel(item.dueDate, today)}）`).join('\n')
    + (items.length < 3 ? `\n可开始的待办不足三项，仅列出实际 ${items.length} 项。` : '');
}

module.exports = { selectDailyTopThree, dailyTopThreeReply };
