'use strict';

const HELP = '用“工作日志：内容”追加；“今日工作日志”查看；“整理今日工作日志”汇总；“删除工作日志第 N 条”删除当日指定条目。';

function parseWorklogCommand(input) {
  const text = String(input || '');
  const control = text.trim();
  if (control === '今日工作日志') return { type: 'list' };
  if (control === '整理今日工作日志') return { type: 'summary' };
  const add = text.match(/^\s*工作日志[：:]([\s\S]*)$/u);
  if (add) return { type: 'add', text: add[1] };
  const remove = control.match(/^删除工作日志第\s*(\d+)\s*条$/u);
  if (remove) return { type: 'delete', number: Number(remove[1]) };
  if (/^(?:工作日志|今日工作日志|整理今日工作日志|删除工作日志)/u.test(control)) return { type: 'invalid' };
  return null;
}

module.exports = { parseWorklogCommand, HELP };
