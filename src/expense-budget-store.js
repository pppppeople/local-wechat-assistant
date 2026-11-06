'use strict';

const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { CATEGORIES, AMOUNT_ERROR } = require('./expense-ledger-commands');
const { HELP, REFUSAL, CATEGORY_ERROR } = require('./expense-budget-commands');
const monthOf = time => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
}).format(new Date(time));
function money(cents) {
  const value = BigInt(cents), absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}元`;
}
function percentage(spent, budget) {
  // Hundredths of a percent, rounded using integer arithmetic even for large totals.
  const ratio = (spent * 10000n + budget / 2n) / budget;
  return `${ratio / 100n}.${String(ratio % 100n).padStart(2, '0')}%`;
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.budgets)
    || state.budgets.some(row => !row || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.month || '')
      || !CATEGORIES.includes(row.category) || row.id !== `${row.month}-${CATEGORIES.indexOf(row.category)}`
      || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0
      || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(state.budgets.map(row => row.id)).size !== state.budgets.length) {
    throw Error('消费预算存储格式无效');
  }
}
function validateLedger(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.entries)
    || state.entries.some(row => !row || !CATEGORIES.includes(row.category)
      || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0
      || !Number.isFinite(Date.parse(row.createdAt)))) throw Error('消费流水账存储格式无效');
}
function createExpenseBudgetStore({ stateFile, ledgerStateFile, now = () => Date.now() }) {
  function execute(side, command) {
    if (side !== 'owner') return refused(REFUSAL);
    if (!command || !['set', 'query', 'delete'].includes(command.type)) return refused(command?.reply || HELP);
    if (command.type !== 'query' && !CATEGORIES.includes(command.category)) return refused(CATEGORY_ERROR);
    if (command.type === 'set' && (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0)) return refused(AMOUNT_ERROR);
    const month = monthOf(now());
    const state = readRecordState(stateFile, { schemaVersion: 1, budgets: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['budgets']); };
    const index = state.budgets.findIndex(row => row.month === month && row.category === command.category);
    if (command.type === 'set') {
      if (index >= 0) state.budgets[index].amountCents = command.amountCents;
      else state.budgets.push({ id: `${month}-${CATEGORIES.indexOf(command.category)}`, month,
        category: command.category, amountCents: command.amountCents, createdAt: new Date(now()).toISOString() });
      save();
      return changed(`已${index >= 0 ? '修改' : '设置'}预算（${month}）：${command.category} ${money(command.amountCents)}`);
    }
    if (command.type === 'delete') {
      if (index < 0) return refused(`删除失败：本月${command.category}预算未设置。`);
      state.budgets.splice(index, 1); save();
      return changed(`已删除预算（${month}）：${command.category}`);
    }
    // Read-only: never rewrite, classify or quarantine the ledger from this feature.
    const ledger = readRecordState(ledgerStateFile, { schemaVersion: 1, entries: [] }, true,
      { strict: true, readOnly: true, validate: validateLedger });
    const totals = new Map(CATEGORIES.map(category => [category, 0n]));
    for (const row of ledger.entries) {
      if (monthOf(row.createdAt) === month) totals.set(row.category, totals.get(row.category) + BigInt(row.amountCents));
    }
    return unchanged([`本月消费预算（${month}，上海时间）：`, ...CATEGORIES.map(category => {
      const budget = state.budgets.find(row => row.month === month && row.category === category);
      const spent = totals.get(category);
      if (!budget) return `${category}：预算未设置 | 已消费 ${money(spent)} | 剩余、超支、使用比例：未设置`;
      const amount = BigInt(budget.amountCents), remaining = amount - spent;
      return `${category}：预算 ${money(amount)} | 已消费 ${money(spent)} | 剩余 ${money(remaining)} | 超支 ${money(remaining < 0n ? -remaining : 0n)} | 使用比例 ${percentage(spent, amount)}`;
    })].join('\n'));
  }
  return { execute };
}
module.exports = { createExpenseBudgetStore };
