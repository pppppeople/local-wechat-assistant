'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { validateItems } = require('./todo-breakdown-provider');
const TTL = 10 * 60 * 1000;
const HINT = '仅预览，未写入任何子任务。10 分钟内回复「确认拆解」全部写入，或「取消拆解」。';

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.pending) || state.pending.length > 1) {
    throw new Error('待办拆解待确认存储格式无效');
  }
  for (const row of state.pending) {
    if (!row || typeof row.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(row.id)
      || typeof row.owner !== 'string' || !row.owner || typeof row.parent !== 'string' || !row.parent.trim()
      || !Number.isFinite(Date.parse(row.createdAt)) || row.items?.length > 8) {
      throw new Error('待办拆解待确认记录无效');
    }
    validateItems(row.items);
  }
}
function createTodoBreakdownStore({ stateFile, provider, todos, now = () => Date.now() }) {
  let queue = Promise.resolve();
  const read = () => readRecordState(stateFile, { schemaVersion: 1, pending: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['pending']); };
  async function apply(side, command, senderId) {
    if (side !== 'owner' || !senderId) return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['generate', 'confirm', 'discard'].includes(command.type)) return refused('不支持这个待办拆解操作。');
    const state = read();
    if (command.type === 'generate') {
      // Failed replacement must never leave an older preview confirmable.
      if (state.pending.length) { state.pending = []; save(state); }
      if (!command.text?.trim()) return refused('请在「拆解待办：」后写一件大事；未写入任何子任务。');
      let candidates;
      try { candidates = validateItems(await provider.generate({ text: command.text })); }
      catch { return refused('这次待办拆解失败，没有保留预览，未写入任何子任务，请重新拆解。'); }
      const parent = command.text.trim().replace(/[\r\n]+/gu, ' ');
      const items = candidates.slice(0, 8);
      state.pending = [{ id: crypto.randomUUID(), owner: senderId, parent, items, createdAt: new Date(now()).toISOString() }];
      save(state);
      return changed([`大事：${parent}`, ...items.map((text, i) => `${i + 1}. ${text}`),
        ...(candidates.length > 8 ? ['模型返回超过 8 个子任务，只取前 8 个。'] : []), HINT].join('\n'));
    }
    const pending = state.pending[0];
    if (pending && pending.owner !== senderId) return refused('这个预览不属于当前主人；未写入任何子任务，请重新拆解。');
    if (!pending || now() - Date.parse(pending.createdAt) >= TTL) {
      if (pending) { state.pending = []; save(state); }
      return unchanged('预览已失效，未写入任何子任务，请重新拆解待办。');
    }
    // Consume before writing: repeated confirmation cannot replay a partial batch.
    state.pending = [];
    save(state);
    if (command.type === 'discard') return changed('已取消拆解，未写入任何子任务。');
    const added = [], failures = [];
    for (const [index, text] of pending.items.entries()) {
      try {
        // Explicit null bypasses the direct-add date phrase parser. No inferred deadline.
        const result = await todos.execute('owner', { type: 'add', text: `【${pending.parent}】${text}`, dueDate: null });
        (result.wrote ? added : failures).push(`第 ${index + 1} 项：${result.reply}`);
      } catch {
        failures.push(`第 ${index + 1} 项：存储失败或结果不明，后续未写入；请核对个人待办，不自动重试。`);
        break;
      }
    }
    return changed([`实际保存了 ${added.length} 条子任务（共 ${pending.items.length} 条）。`, ...added, ...failures].join('\n'));
  }
  function execute(...args) {
    const result = queue.then(() => apply(...args));
    queue = result.catch(() => {});
    return result;
  }
  return { execute };
}

module.exports = { createTodoBreakdownStore };
