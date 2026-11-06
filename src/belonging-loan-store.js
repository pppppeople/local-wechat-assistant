'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { expectedReturnDate } = require('./belonging-loan-commands');

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.loans)
    || state.loans.some(item => !item || !/^[a-z0-9_-]+$/iu.test(item.id || '')
      || typeof item.belongingId !== 'string' || !item.belongingId
      || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.borrower !== 'string' || !item.borrower.trim()
      || !Number.isFinite(Date.parse(item.createdAt)) || !validDate(item.loanDate)
      || (item.expectedDate !== null && !validDate(item.expectedDate))
      || !['open', 'returned'].includes(item.status) || typeof item.reminded !== 'boolean'
      || (item.status === 'returned' ? !validDate(item.returnDate) : item.returnDate !== null))
    || new Set(state.loans.map(item => item.id)).size !== state.loans.length) throw new Error('借出登记存储格式无效');
}
const key = value => String(value || '').trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
function matches(items, name) {
  const needle = key(name);
  if (!needle) return [];
  const exact = items.filter(item => key(item.name) === needle);
  return exact.length ? exact : items.filter(item => key(item.name).includes(needle) || needle.includes(key(item.name)));
}

function createBelongingLoanStore({ stateFile, belongings, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, loans: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['loans']); };
  const describe = item => `${item.name}｜借给 ${item.borrower}｜借出 ${item.loanDate}｜${item.expectedDate ? `预计 ${item.expectedDate} 归还` : '无预计归还日'}`;
  function handle(side, command) {
    if (side !== 'owner') return '物品借出登记仅主人可用。';
    if (!command || command.type === 'invalid') return '请使用「借出登记：物品名 借给 人名」，可加「预计 明天 归还」。';
    const state = load();
    if (command.type === 'list' || command.type === 'history') {
      const items = state.loans.filter(item => command.type === 'history' || item.status === 'open');
      return items.length ? `${command.type === 'history' ? '借出历史' : '借出列表'}：\n${items.map(item =>
        `${describe(item)}｜${item.status === 'returned' ? `已归还 ${item.returnDate}` : '未归还'}`).join('\n')}` : '暂无对应借出记录。';
    }
    if (command.type === 'create') {
      if (!command.name?.trim() || !command.borrower?.trim()) return '请说清楚物品名和借用人。';
      const expectedDate = expectedReturnDate(command.expected, now());
      if (expectedDate === undefined) return '没有登记：预计归还日期无法识别，请用明天、下周一、11月3日或 YYYY-MM-DD。';
      const found = matches(belongings.readBelongings('owner'), command.name);
      if (!found.length) return '没有找到这个物品，请先在生活箱登记物品。';
      if (found.length > 1) return '匹配到多个或同名物品，请把物品名说得更具体。';
      const item = found[0];
      const existing = state.loans.find(entry => entry.belongingId === item.id && entry.status === 'open');
      if (existing) return `「${item.name}」已借给 ${existing.borrower}，尚未归还，不能重复登记。`;
      const clock = now();
      const loan = { id: crypto.randomUUID(), belongingId: item.id, name: item.name, borrower: command.borrower,
        createdAt: new Date(clock).toISOString(), loanDate: shanghaiDay(clock), expectedDate,
        status: 'open', returnDate: null, reminded: false };
      state.loans.push(loan); save(state);
      return `已登记借出：${describe(loan)}。`;
    }
    if (command.type === 'return') {
      const found = matches(state.loans.filter(item => item.status === 'open'), command.name);
      if (!found.length) return '没有找到这个物品的未归还借出记录。';
      if (found.length > 1) return '匹配到多笔未归还记录，请把物品名说得更具体。';
      const item = found[0]; item.status = 'returned'; item.returnDate = shanghaiDay(now()); save(state);
      return `已标记归还：${item.name}，归还日期 ${item.returnDate}。`;
    }
    return '不支持这个借出登记操作。';
  }
  async function tick(deliver) {
    let delivered = false;
    // Mark before attempting delivery; reload after await to preserve returns.
    for (;;) {
      const state = load();
      const item = state.loans.find(entry => entry.status === 'open' && !entry.reminded
        && entry.expectedDate === shanghaiDay(now()));
      if (!item) return delivered;
      item.reminded = true; save(state);
      await deliver(`借出归还提醒：${describe(item)}，目前仍未归还。`, `belonging-loan-${item.id}`);
      delivered = true;
    }
  }
  return { handle, tick };
}

module.exports = { createBelongingLoanStore };
