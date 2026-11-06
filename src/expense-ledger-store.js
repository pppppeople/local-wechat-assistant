'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { CATEGORIES, HELP, AMOUNT_ERROR } = require('./expense-ledger-commands');
const shanghaiDate = time => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(time));
function isLedgerDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T12:00:00+08:00`);
  return Number.isFinite(time) && shanghaiDate(time) === value;
}
function money(cents) {
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}元`;
}
const total = rows => rows.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.entries)
    || state.entries.some(row => !row || !/^[a-z0-9_-]+$/iu.test(row.id || '')
      || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0
      || !CATEGORIES.includes(row.category) || typeof row.note !== 'string'
      || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(state.entries.map(row => row.id)).size !== state.entries.length) {
    throw Error('消费流水账存储格式无效');
  }
}
function createExpenseLedgerStore({ stateFile, now = () => Date.now() }) {
  function execute(side, command) {
    if (side !== 'owner') return refused('个人消费流水账仅供主人使用，好友不能记账或查看账目。');
    if (!command || !['add', 'today', 'month', 'delete'].includes(command.type)) return refused(command?.reply || HELP);
    if (command.type === 'add') {
      if (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0) return refused(AMOUNT_ERROR);
      if (!CATEGORIES.includes(command.category)) return refused(`分类只支持：${CATEGORIES.join('、')}。`);
      if (typeof command.note !== 'string') return refused(HELP);
      if (command.date !== undefined && !isLedgerDate(command.date)) return refused('消费日期须为有效的上海日期 YYYY-MM-DD。');
    }
    if (command.type === 'delete' && !/^[a-z0-9_-]+$/iu.test(command.id || '')) return refused(HELP);
    const state = readRecordState(stateFile, { schemaVersion: 1, entries: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['entries']); };
    if (command.type === 'add') {
      const row = { id: crypto.randomUUID(), amountCents: command.amountCents,
        category: command.category, note: command.note,
        createdAt: command.date === undefined ? new Date(now()).toISOString()
          : new Date(`${command.date}T12:00:00+08:00`).toISOString() };
      state.entries.push(row); save();
      return changed(`已记账，编号：${row.id}\n${money(row.amountCents)} ${row.category}${row.note ? ` ${row.note}` : ''}`);
    }
    if (command.type === 'delete') {
      const index = state.entries.findIndex(row => row.id === command.id);
      if (index < 0) return refused('删除失败：支出编号不存在，未删除任何条目。');
      state.entries.splice(index, 1); save();
      return changed(`已删除支出，编号：${command.id}`);
    }
    const date = shanghaiDate(now());
    const period = command.type === 'today' ? date : date.slice(0, 7);
    const rows = state.entries.filter(row => shanghaiDate(row.createdAt).startsWith(period));
    if (!rows.length) return unchanged(command.type === 'today' ? '今日无记录。' : '本月无记录。');
    if (command.type === 'today') return unchanged([`今日账单（${date}）：`,
      ...rows.map(row => `编号：${row.id} | ${money(row.amountCents)} | ${row.category} | ${row.note || '无备注'}`),
      `今日合计：${money(total(rows))}`].join('\n'));
    return unchanged([`本月账单（${period}）：`,
      ...CATEGORIES.map(category => `${category}：${money(total(rows.filter(row => row.category === category)))}`),
      `本月总计：${money(total(rows))}`].join('\n'));
  }
  return { execute };
}
module.exports = { createExpenseLedgerStore, shanghaiDate, isLedgerDate };
