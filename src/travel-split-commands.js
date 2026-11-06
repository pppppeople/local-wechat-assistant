'use strict';

const { parseAmountCents, AMOUNT_ERROR } = require('./expense-ledger-commands');
const REFUSAL = '旅行预算分摊器仅供主人使用，好友不能读取或操作分账数据。';
const HELP = '请发送“创建旅行分账 活动名”、“旅行分账支出 100元 主人 [分摊 主人 60元 好友 40元] [备注：午餐]”、“旅行分账汇总 [活动编号]”、“旅行分账结算 [活动编号]”或“结束旅行分账”。';
function shareCents(value) {
  return /^0(?:\.0{1,2})?$/u.test(value) ? 0 : parseAmountCents(value);
}
function parseTravelSplitCommand(text) {
  const value = String(text || '').trim();
  if (!/^(?:创建旅行分账|旅行分账支出|旅行分账汇总|旅行分账结算|结束旅行分账)(?:\s|$)/u.test(value)) return null;
  let match = value.match(/^创建旅行分账\s+([^\r\n]+)$/u);
  if (match) return { type: 'create', name: match[1].trim() };
  match = value.match(/^旅行分账(汇总|结算)(?:\s+([a-z0-9_-]+))?$/iu);
  if (match) return { type: match[1] === '汇总' ? 'summary' : 'settle', id: match[2] };
  if (value === '结束旅行分账') return { type: 'end' };
  match = value.match(/^旅行分账支出\s+(\S+?)元\s+(\S+)(?:\s+分摊\s+主人\s+(\S+?)元\s+好友\s+(\S+?)元)?(?:\s+备注[：:]\s*([^\r\n]+))?$/u);
  if (!match) return { type: 'invalid', reply: HELP };
  const amountCents = parseAmountCents(match[1]);
  if (amountCents === null) return { type: 'invalid', reply: AMOUNT_ERROR };
  const shares = match[3] === undefined ? undefined : { 主人: shareCents(match[3]), 好友: shareCents(match[4]) };
  if (shares && Object.values(shares).includes(null)) return { type: 'invalid', reply: '指定分摊金额须非负、最多两位小数，且在安全整数分范围内。' };
  return { type: 'add', amountCents, payer: match[2], shares, note: (match[5] || '').trim() };
}
module.exports = { parseTravelSplitCommand, HELP, REFUSAL };
