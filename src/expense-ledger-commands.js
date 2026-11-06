'use strict';

const CATEGORIES = Object.freeze(['餐饮', '交通', '购物', '娱乐', '其他']);
const HELP = '请发送“记账 <金额>元 <分类> <备注可选>”、“今日账单”、“本月账单”或“删除支出 <编号>”。';
const AMOUNT_ERROR = '金额须大于 0，最多两位小数，且不能超过安全整数分范围。';
function parseAmountCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(value)) return null;
  const [yuan, fraction = ''] = value.split('.');
  const cents = Number(yuan + fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
function parseExpenseLedgerCommand(text) {
  const value = String(text || '').trim();
  if (value === '今日账单') return { type: 'today' };
  if (value === '本月账单') return { type: 'month' };
  if (/^记账(?:\s|$)/u.test(value)) {
    const match = value.match(/^记账\s+(\S+?)元\s+(\S+)(?:\s+([^\r\n]+))?$/u);
    if (!match) return { type: 'invalid', reply: `${AMOUNT_ERROR}\n${HELP}` };
    const amountCents = parseAmountCents(match[1]);
    if (amountCents === null) return { type: 'invalid', reply: AMOUNT_ERROR };
    return { type: 'add', amountCents, category: match[2], note: (match[3] || '').trim() };
  }
  if (/^删除支出(?:\s|$)/u.test(value)) {
    const match = value.match(/^删除支出\s+([a-z0-9_-]+)$/iu);
    return match ? { type: 'delete', id: match[1] } : { type: 'invalid' };
  }
  return null;
}
module.exports = { CATEGORIES, HELP, AMOUNT_ERROR, parseAmountCents, parseExpenseLedgerCommand };
