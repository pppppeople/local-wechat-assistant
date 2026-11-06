'use strict';

const crypto = require('crypto');
const { changed, unchanged, refused, readResult, resultText } = require('./feature-result');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { DEFAULT_SOURCE, PRICE_EXAMPLE } = require('./price-note-commands');

// Same normalization and exact-before-inclusion matching as shared-life-store.
const key = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[\s，,。.!！?？、：:；;（）()“”"'‘’_-]+/gu, '');
const validAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.prices)
    || state.prices.some(item => !item || !/^[a-z0-9_-]+$/iu.test(item.id || '')
      || !key(item.name) || typeof item.name !== 'string'
      || typeof item.source !== 'string' || !item.source.trim() || !validAmount(item.amount)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(item.date) || !Number.isFinite(Date.parse(`${item.date}T00:00:00Z`))
      || new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date
      || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt)))
    || new Set(state.prices.map(item => item.id)).size !== state.prices.length) throw new Error('价格速记存储格式无效');
}

function createPriceNoteStore({ stateFile, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, prices: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['prices']); };
  const describe = item => `${item.source}｜${item.amount}元｜${item.date}`;
  const byPrice = (a, b) => a.amount - b.amount || b.date.localeCompare(a.date) || a.source.localeCompare(b.source);

  function handleResult(side, command, linkId = null) {
    if (side !== 'owner') return '价格速记与比较仅主人可用。';
    if (!command || command.type === 'invalid') return command?.reply || PRICE_EXAMPLE;
    if (!key(command.name)) return refused('请说清楚物品名称，例如「比价：牛奶」。');
    if (command.type === 'record' && !validAmount(command.amount)) return PRICE_EXAMPLE;
    const state = load();
    if (linkId && state.cooldownLinks?.[linkId]) return unchanged('该冷静期条目已登记价格，不会重复写入。');
    const names = [...new Set(state.prices.map(item => item.name))];
    const needle = key(command.name);
    const exact = names.filter(name => key(name) === needle);
    const matches = exact.length ? exact : names.filter(name => key(name).includes(needle) || needle.includes(key(name)));
    if (matches.length > 1) return refused(`匹配到多个物品：${matches.join('、')}。请把物品名说得更具体。`);
    const name = matches[0] || command.name.trim();
    const items = state.prices.filter(item => item.name === name);
    if (command.type === 'record') {
      const source = command.source?.trim() || DEFAULT_SOURCE;
      const clock = now(), date = shanghaiDay(clock), timestamp = new Date(clock).toISOString();
      const existing = items.find(item => item.source === source && item.date === date);
      const item = existing || { id: crypto.randomUUID(), name, source, date, createdAt: timestamp };
      item.amount = command.amount; item.updatedAt = timestamp;
      if (!existing) state.prices.push(item);
      if (linkId) state.cooldownLinks = { ...state.cooldownLinks, [linkId]: true };
      save(state);
      return changed(`已${existing ? '更新' : '记录'}价格：${name}｜${describe(item)}。`);
    }
    if (command.type === 'delete') {
      const source = command.source?.trim();
      const removed = items.filter(item => item.source === source);
      if (!removed.length) return `不存在「${name}」来源「${source || '未填写'}」的价格记录。`;
      state.prices = state.prices.filter(item => !removed.includes(item)); save(state);
      return `已删除「${name}」来源「${source}」的全部 ${removed.length} 笔价格记录。`;
    }
    if (!items.length) return `「${name}」暂无价格记录。`;
    if (command.type === 'lowest') {
      const sorted = [...items].sort(byPrice);
      const lowest = sorted.filter(item => item.amount === sorted[0].amount);
      return `「${name}」历史最低价：\n${lowest.map(describe).join('\n')}`;
    }
    if (command.type === 'compare') {
      const latest = new Map();
      for (const item of items) {
        if (!latest.has(item.source) || item.date > latest.get(item.source).date) latest.set(item.source, item);
      }
      const sorted = [...latest.values()].sort(byPrice);
      return `「${name}」各来源最近价格：\n${sorted.map(item => `${describe(item)}${item.amount === sorted[0].amount ? '（最低价）' : ''}`).join('\n')}`;
    }
    return '不支持这个价格操作。';
  }
  function handle(side, command) { return resultText(handleResult(side, command)); }
  function recordCooldownPrice(side, id, command) {
    if (side !== 'owner') return refused('购物冷静期仅主人可用。');
    if (!/^[a-z0-9_-]+$/iu.test(id || '') || command?.type !== 'record' || !validAmount(command.amount)) throw new Error('无效冷静期价格关联');
    return readResult(handleResult(side, command, id));
  }
  return { handle, recordCooldownPrice };
}

module.exports = { createPriceNoteStore };
