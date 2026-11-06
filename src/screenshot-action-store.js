'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { extractDueDate } = require('./personal-todo-commands');
const { validateItems } = require('./screenshot-action-provider');
const TTL = 20 * 60 * 1000;
const HINT = '回复「都加入待办」或「加入第1、3项」或「算了」。';
const line = text => text.replace(/[\r\n]+/gu, ' ');

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.pending) || state.pending.length > 1
    || state.pending.some(record => !record || typeof record.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(record.id)
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)))) {
    throw new Error('行动项待确认存储格式无效');
  }
  for (const record of state.pending) validateItems(record.items);
}
function createScreenshotActionStore({ stateFile, provider, todos, now = () => Date.now() }) {
  let queue = Promise.resolve();
  function hasPending() {
    try {
      // Admission is read-only; execution retains ownership of strict failure handling.
      const state = readRecordState(stateFile, { schemaVersion: 1, pending: [] }, false,
        { strict: true, readOnly: true, now, validate: validateState });
      const pending = state.pending[0];
      return Boolean(pending?.items.length && now() - Date.parse(pending.createdAt) < TTL);
    } catch {
      return false;
    }
  }
  function save(state) {
    validateState(state);
    writeRecordState(stateFile, state, ['pending']);
  }
  async function apply(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['extract', 'confirm_all', 'confirm_selected', 'discard'].includes(command.type)) {
      return refused('不支持这个行动项操作。');
    }
    const state = readRecordState(stateFile, { schemaVersion: 1, pending: [] }, true,
      { strict: true, now, validate: validateState });
    if (state.pending[0] && now() - Date.parse(state.pending[0].createdAt) >= TTL) {
      state.pending = [];
      save(state);
    }
    if (command.type === 'extract') {
      // The newest extraction supersedes the previous preview even if generation fails.
      if (state.pending.length) { state.pending = []; save(state); }
      let items;
      try {
        if (!command.imagePaths?.length) throw new Error('缺少图片');
        items = validateItems(await provider.extract({ text: command.text, imagePaths: command.imagePaths }));
      } catch {
        return refused('这次没提取成功，没有保留待确认行动项，请带上截图重试。');
      }
      state.pending = [{ id: crypto.randomUUID(), items, createdAt: new Date(now()).toISOString() }];
      save(state);
      return changed((items.length ? items.map((item, index) => {
        const uncertain = item.uncertain || (item.dueText !== '' && !extractDueDate(` ${item.dueText}`, now()).dueDate);
        return `${index + 1}. ${line(item.text)}（到期：${line(item.dueText)}）${uncertain ? '（待确认）' : ''}`;
      }).join('\n') : '未提取到行动项。') + `\n${HINT}`);
    }
    const pending = state.pending[0];
    if (!pending) return unchanged('当前没有待确认的行动项（可能已过期），请带上截图重新发送「提取行动项」。');
    // Consume before adding: an interrupted or partially refused batch must not be replayed.
    state.pending = [];
    save(state);
    if (command.type === 'discard') return changed('已丢弃这次提取的行动项。');
    const numbers = command.type === 'confirm_all' ? pending.items.map((_, i) => i + 1) : [...new Set(command.numbers)];
    const invalid = numbers.filter(n => !Number.isSafeInteger(n) || n < 1 || n > pending.items.length);
    const added = [], failures = [];
    for (const number of numbers.filter(n => !invalid.includes(n))) {
      const item = pending.items[number - 1];
      const text = item.text + (item.dueText ? ` ${item.dueText}` : '');
      try {
        const result = todos.execute('owner', { type: 'add', text });
        if (result.wrote) added.push(result.reply);
        else failures.push(`第${number}项：${result.reply}`);
      } catch {
        failures.push(`第${number}项：待办存储失败，请检查待办后再操作。`);
        break;
      }
    }
    return changed([`实际加入了 ${added.length} 条待办。`, ...added,
      ...(invalid.length ? [`已忽略越界序号：${invalid.join('、')}。`] : []), ...failures].join('\n'));
  }
  function execute(side, command) {
    const result = queue.then(() => apply(side, command));
    queue = result.catch(() => {});
    return result;
  }
  return { execute, hasPending };
}

module.exports = { createScreenshotActionStore };
