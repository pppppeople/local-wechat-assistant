'use strict';

const HELP = '用“创建习惯：名称”创建；“习惯打卡：名称”打卡；“取消习惯打卡：名称”取消当天打卡；“习惯统计：名称”查看；“我的习惯”列出全部；“归档习惯：名称”归档。';
const ACTIONS = { '创建习惯': 'create', '习惯打卡': 'check', '取消习惯打卡': 'uncheck', '习惯统计': 'stats', '归档习惯': 'archive' };
function parseHabitCommand(input) {
  const text = String(input || '').trim();
  if (text === '我的习惯') return { type: 'list' };
  const match = text.match(/^(创建习惯|习惯打卡|取消习惯打卡|习惯统计|归档习惯)[：:]([^\r\n]+)$/u);
  if (match && match[2].trim()) return { type: ACTIONS[match[1]], name: match[2].trim() };
  return /^(?:创建习惯|习惯打卡|取消习惯打卡|习惯统计|归档习惯|我的习惯)/u.test(text) ? { type: 'invalid' } : null;
}
module.exports = { parseHabitCommand, HELP };
