'use strict';

const { CATEGORIES, AMOUNT_ERROR, parseAmountCents } = require('./expense-ledger-commands');
const HELP = '请发送“设置预算 <分类> <金额>元”、“预算查询”或“删除预算 <分类>”。';
const REFUSAL = '消费预算仅供主人使用，好友不能设置或查看预算与流水。';
const CATEGORY_ERROR = `分类只支持：${CATEGORIES.join('、')}。`;
function parseExpenseBudgetCommand(text) {
  const value = String(text || '').trim();
  if (value === '预算查询') return { type: 'query' };
  if (/^设置预算(?:\s|$)/u.test(value)) {
    const match = value.match(/^设置预算\s+(\S+)\s+(\S+?)元$/u);
    if (!match) return { type: 'invalid', reply: HELP };
    if (!CATEGORIES.includes(match[1])) return { type: 'invalid', reply: CATEGORY_ERROR };
    const amountCents = parseAmountCents(match[2]);
    return amountCents === null ? { type: 'invalid', reply: AMOUNT_ERROR }
      : { type: 'set', category: match[1], amountCents };
  }
  if (/^删除预算(?:\s|$)/u.test(value)) {
    const match = value.match(/^删除预算\s+(\S+)$/u);
    if (!match) return { type: 'invalid', reply: HELP };
    return CATEGORIES.includes(match[1]) ? { type: 'delete', category: match[1] }
      : { type: 'invalid', reply: CATEGORY_ERROR };
  }
  return null;
}
module.exports = { parseExpenseBudgetCommand, HELP, REFUSAL, CATEGORY_ERROR };
