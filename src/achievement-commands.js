'use strict';

const { addDays, shanghaiDay } = require('./personal-todo-commands');
const { expectedFollowUpDate } = require('./follow-up-commands');

const HELP = '用“记录成就：成就名｜日期｜分类或备注”收藏（日期默认今天）；“我的成就”查看；“随机回顾一个成就”回顾；“删成就：成就名｜日期”删除（日期可省略）。';

function achievementDate(phrase, now) {
  if (phrase === '昨天' || phrase === '前天') return addDays(shanghaiDay(now), phrase === '昨天' ? -1 : -2);
  return expectedFollowUpDate(phrase, now);
}

function parseAchievementCommand(input) {
  const text = String(input || '').trim();
  if (text === '我的成就' || text === '打开成就博物馆') return { type: 'list' };
  if (text === '随机回顾一个成就') return { type: 'recall' };
  const match = text.match(/^(记录成就|删成就)[：:]([\s\S]*)$/u);
  if (!match) return /^(?:记录成就|删成就|我的成就|打开成就博物馆|随机回顾一个成就)/u.test(text) ? { type: 'invalid' } : null;
  const parts = match[2].split(/[｜|]/u).map(part => part.trim());
  const type = match[1] === '记录成就' ? 'add' : 'delete';
  if (!parts[0] || parts.length > (type === 'add' ? 3 : 2)) return { type: 'invalid' };
  return { type, name: parts[0], date: parts[1] || null, note: parts[2] || '' };
}

module.exports = { parseAchievementCommand, achievementDate, HELP };
