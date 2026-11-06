'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { HELP, REFUSAL } = require('./travel-split-commands');
const { AMOUNT_ERROR } = require('./expense-ledger-commands');
const ROLES = ['主人', '好友'];
const validId = value => typeof value === 'string' && /^[a-z0-9_-]+$/iu.test(value);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const money = value => {
  const cents = BigInt(value);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}元`;
};
function expenseError(row) {
  if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) return AMOUNT_ERROR;
  if (!ROLES.includes(row.payer)) return '付款人只能是主人或好友。';
  if (!row.shares || Object.keys(row.shares).length !== 2
    || ROLES.some(role => !Number.isSafeInteger(row.shares[role]) || row.shares[role] < 0)) {
    return '指定分摊必须包含主人和好友两人的非负整数分。';
  }
  if (BigInt(row.shares.主人) + BigInt(row.shares.好友) !== BigInt(row.amountCents)) return '分摊不守恒：两人的分摊之和必须等于支出金额。';
  if (typeof row.note !== 'string') return HELP;
  return null;
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.activities)
    || state.activities.filter(row => row.status === 'active').length > 1
    || new Set(state.activities.map(row => row?.id)).size !== state.activities.length
    || state.activities.some(row => !row || !validId(row.id) || typeof row.name !== 'string' || !row.name.trim()
      || !['active', 'ended'].includes(row.status) || !validDate(row.createdAt)
      || (row.status === 'ended' && !validDate(row.endedAt)) || !Array.isArray(row.entries)
      || new Set(row.entries.map(entry => entry?.id)).size !== row.entries.length
      || row.entries.some(entry => !entry || !validId(entry.id) || !validDate(entry.createdAt) || expenseError(entry)))) {
    throw Error('旅行分账存储格式无效');
  }
}
function totals(activity) {
  const result = Object.fromEntries(ROLES.map(role => [role, { paid: 0n, due: 0n }]));
  for (const row of activity.entries) {
    result[row.payer].paid += BigInt(row.amountCents);
    for (const role of ROLES) result[role].due += BigInt(row.shares[role]);
  }
  return result;
}
function settlement(result) {
  const balance = result.主人.paid - result.主人.due;
  if (balance === 0n) return '双方已平，无需补款（仅计算文本，未处理任何资金）。';
  return `${balance > 0n ? '好友补给主人' : '主人补给好友'} ${money(balance > 0n ? balance : -balance)}（仅计算文本，未处理任何资金）。`;
}
function createTravelSplitStore({ stateFile, now = () => Date.now() }) {
  function execute(side, command) {
    // Admission must precede even validation or a filesystem lookup.
    if (side !== 'owner') return refused(REFUSAL);
    if (!command || !['create', 'add', 'summary', 'settle', 'end'].includes(command.type)) return refused(command?.reply || HELP);
    if (command.type === 'create' && (typeof command.name !== 'string' || !command.name.trim() || /[\r\n]/u.test(command.name))) return refused(HELP);
    if (command.id !== undefined && !validId(command.id)) return refused(HELP);
    let expense;
    if (command.type === 'add') {
      if (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0) return refused(AMOUNT_ERROR);
      const half = Math.floor(command.amountCents / 2);
      expense = { amountCents: command.amountCents, payer: command.payer, note: command.note,
        shares: command.shares === undefined ? { 主人: command.amountCents - half, 好友: half } : command.shares };
      const error = expenseError(expense);
      if (error) return refused(error);
    }
    const state = readRecordState(stateFile, { schemaVersion: 1, activities: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['activities']); };
    const active = state.activities.find(row => row.status === 'active');
    if (command.type === 'create') {
      if (active) return refused(`已有进行中分账活动“${active.name}”（${active.id}），请先结束后再创建。`);
      const activity = { id: crypto.randomUUID(), name: command.name.trim(), status: 'active',
        createdAt: new Date(now()).toISOString(), entries: [] };
      state.activities.push(activity); save();
      return changed(`已创建旅行分账“${activity.name}”，编号：${activity.id}。固定主人与好友两人、人民币，默认均分；奇数分由主人多承担1分。`);
    }
    const activity = command.id ? state.activities.find(row => row.id === command.id)
      : active || state.activities.at(-1);
    if (!activity) return refused(command.id ? '分账活动编号不存在。' : '暂无分账活动，请先创建旅行分账。');
    if (command.type === 'add' || command.type === 'end') {
      if (activity.status !== 'active') return refused('该分账活动已结束，只可查看，不可再记账或修改。');
      if (command.type === 'end') {
        activity.status = 'ended'; activity.endedAt = new Date(now()).toISOString(); save();
        return changed(`已结束旅行分账“${activity.name}”，编号：${activity.id}；仅可查看。\n${settlement(totals(activity))}`);
      }
      activity.entries.push({ ...expense, id: crypto.randomUUID(), createdAt: new Date(now()).toISOString() }); save();
      return changed(`已记录旅行分账支出：${money(expense.amountCents)}，付款人：${expense.payer}；主人分摊 ${money(expense.shares.主人)}，好友分摊 ${money(expense.shares.好友)}。${command.shares === undefined && command.amountCents % 2 ? '奇数分由主人多承担1分。' : ''}`);
    }
    const result = totals(activity);
    const header = `旅行分账“${activity.name}”（${activity.status === 'active' ? '进行中' : '已结束'}），编号：${activity.id}`;
    if (command.type === 'settle') return unchanged(`${header}\n${settlement(result)}`);
    return unchanged([header, ...ROLES.map(role => {
      const { paid, due } = result[role], balance = paid - due;
      return `${role}：已付 ${money(paid)}，应付 ${money(due)}，应收 ${money(balance > 0n ? balance : 0n)}，应补 ${money(balance < 0n ? -balance : 0n)}`;
    }), settlement(result), '活动目录（可按编号查看汇总或结算）：',
    ...state.activities.map(row => `${row.id} | ${row.name} | ${row.status === 'active' ? '进行中' : '已结束'}`)].join('\n'));
  }
  return { execute };
}
module.exports = { createTravelSplitStore };
