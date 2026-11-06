'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { extractDueDate } = require('./personal-todo-commands');
const { validateItems } = require('./message-date-provider');
const TTL = 10 * 60 * 1000;
const HINT = '10 分钟内回复「都存」或「存 1、3」；待确认项需先给明确日期并重新提取。';
const line = text => text.replace(/[\r\n]+/gu, ' ');

function resolveDate(item, now) {
  if (item.uncertain) return null;
  const parsed = extractDueDate(item.dueText.trim(), now);
  // Accept only a complete supported phrase, never a suffix of an ambiguous expression.
  return parsed.text === '' ? parsed.dueDate : null;
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.pending) || state.pending.length > 1) {
    throw new Error('消息日期待确认存储格式无效');
  }
  for (const record of state.pending) {
    if (!record || typeof record.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(record.id)
      || typeof record.owner !== 'string' || !record.owner
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
      || !Array.isArray(record.items) || !record.items.length) throw new Error('消息日期待确认记录无效');
    for (const item of record.items) {
      validateItems([{ text: item.text, dueText: item.dueText, uncertain: item.uncertain }]);
      if (item.dueDate !== resolveDate(item, Date.parse(record.createdAt))) throw new Error('消息日期解析结果无效');
    }
  }
}
function createMessageDateStore({ stateFile, provider, todos, now = () => Date.now() }) {
  let queue = Promise.resolve();
  const read = () => readRecordState(stateFile, { schemaVersion: 1, pending: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['pending']); };
  async function apply(side, command, senderId) {
    if (side !== 'owner' || !senderId) return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['extract', 'confirm_all', 'confirm_selected'].includes(command.type)) {
      return refused('不支持这个消息日期操作。');
    }
    const state = read();
    if (command.type === 'extract') {
      // A new extraction invalidates the old preview, including failed generation.
      if (state.pending.length) { state.pending = []; save(state); }
      if (!command.text?.trim()) return refused('请在「提取日期：」后粘贴整段文字。');
      let items;
      try {
        const candidates = validateItems(await provider.extract({ text: command.text }));
        const createdAt = new Date(now()).toISOString();
        items = candidates.map(item => ({ ...item, dueDate: resolveDate(item, Date.parse(createdAt)) }));
        if (!items.length) return unchanged('未提取到事项和日期，请补充文字后重新提取。');
        state.pending = [{ id: crypto.randomUUID(), owner: senderId, createdAt, items }];
      } catch {
        return refused('这次日期提取失败，没有保留预览，请重新提取。');
      }
      save(state);
      return changed(items.map((item, i) => `${i + 1}. ${line(item.text)}（${item.dueDate || `待确认：${line(item.dueText) || '未提供明确日期'}`}）`)
        .join('\n') + `\n${HINT}`);
    }
    const pending = state.pending[0];
    if (pending && pending.owner !== senderId) return refused('这个预览不属于当前主人，请重新提取。');
    if (!pending || now() - Date.parse(pending.createdAt) >= TTL) {
      if (pending) { state.pending = []; save(state); }
      return unchanged('预览已失效，请重新提取日期。');
    }
    const numbers = command.type === 'confirm_all' ? pending.items.map((_, i) => i + 1) : [...new Set(command.numbers || [])];
    if (!numbers.length) return unchanged(`请回复「都存」或「存 1、3」选择编号。\n${HINT}`);
    // Consume before todo writes; retries cannot replay a partially successful batch.
    state.pending = [];
    save(state);
    const added = [], failures = [];
    for (const number of numbers) {
      if (!Number.isSafeInteger(number) || number < 1 || number > pending.items.length) {
        failures.push(`第 ${number} 项：序号越界，未保存。`);
        continue;
      }
      const item = pending.items[number - 1];
      if (!item.dueDate) {
        failures.push(`第 ${number} 项：待确认，需先给明确日期并重新提取，未保存。`);
        continue;
      }
      try {
        const result = await todos.execute('owner', { type: 'add', text: item.text, dueDate: item.dueDate });
        if (result.wrote) added.push(`第 ${number} 项：${result.reply}`);
        else failures.push(`第 ${number} 项：${result.reply}`);
      } catch {
        failures.push(`第 ${number} 项：待办存储失败，请核对待办后重新提取；后续未写入。`);
        break;
      }
    }
    return changed([`实际保存了 ${added.length} 条待办。`, ...added, ...failures].join('\n'));
  }
  function execute(side, command, senderId) {
    const result = queue.then(() => apply(side, command, senderId));
    queue = result.catch(() => {});
    return result;
  }
  return { execute };
}

module.exports = { createMessageDateStore };
