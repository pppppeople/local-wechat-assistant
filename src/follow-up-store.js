'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');
const { expectedFollowUpDate } = require('./follow-up-commands');

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.waits)) throw new Error('催办助手存储格式无效');
  const ids = new Set();
  for (const item of state.waits) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.counterpart !== 'string' || !item.counterpart.trim()
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || !validDay(item.registeredDate) || (item.expectedDate !== null && !validDay(item.expectedDate))
      || !['open', 'completed', 'cancelled'].includes(item.status) || typeof item.reminded !== 'boolean'
      || (item.status === 'open' ? item.closedDate !== null : !validDay(item.closedDate))) {
      throw new Error('催办助手记录格式无效');
    }
    ids.add(item.id);
  }
}

function createFollowUpStore({ stateFile, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, waits: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['waits']); };
  const describe = item => `${item.name}｜对方：${item.counterpart}｜登记 ${item.registeredDate}｜${item.expectedDate ? `预计 ${item.expectedDate} 有结果` : '无预计'}`;
  const example = '请用「在等：事项（对方：人名/单位）」，可加「预计 明天 有结果」；关闭用「有结果了：事项关键词」或「取消等待：事项关键词」。';
  function handle(side, command) {
    if (side !== 'owner') return '催办助手仅主人可用。';
    if (!command || command.type === 'invalid') return `没有执行催办操作：命令不完整。${example}`;
    const state = load();
    if (command.type === 'create') {
      if (!command.name?.trim() || !command.counterpart?.trim()) return example;
      const expectedDate = expectedFollowUpDate(command.expected, now());
      if (expectedDate === undefined) return '没有登记：预计日期无法识别，请用明天、下周一、11月3日或 YYYY-MM-DD。';
      const clock = now();
      const item = { id: crypto.randomUUID(), name: command.name.trim(), counterpart: command.counterpart.trim(),
        createdAt: new Date(clock).toISOString(), registeredDate: shanghaiDay(clock), expectedDate,
        status: 'open', closedDate: null, reminded: false };
      state.waits.push(item); save(state);
      return `已登记等待：${describe(item)}。`;
    }
    if (command.type === 'list') {
      const items = state.waits.filter(item => item.status === 'open')
        .sort((a, b) => (a.expectedDate || '9999-99-99').localeCompare(b.expectedDate || '9999-99-99'));
      return items.length ? `催办列表：\n${items.map(describe).join('\n')}` : '暂无进行中的等待。';
    }
    if (command.type === 'complete' || command.type === 'cancel') {
      const keyword = String(command.keyword || '').trim();
      if (!keyword) return example;
      const found = state.waits.filter(item => item.status === 'open' && item.name.includes(keyword));
      if (!found.length) return '没有找到匹配的进行中等待。';
      if (found.length > 1) return '匹配到多笔等待，请把事项关键词说得更具体，本次未关闭任何记录。';
      const item = found[0];
      item.status = command.type === 'complete' ? 'completed' : 'cancelled';
      item.closedDate = shanghaiDay(now()); save(state);
      return `已${command.type === 'complete' ? '完成' : '取消'}等待：「${item.name}」，关闭日期 ${item.closedDate}。`;
    }
    return '不支持这个催办操作。';
  }
  async function tick(deliver) {
    const state = load();
    const item = state.waits.find(entry => entry.status === 'open' && !entry.reminded
      && entry.expectedDate === shanghaiDay(now()));
    if (!item) return false;
    // Persist before dispatch: one application attempt, no retry on failure/restart.
    item.reminded = true; save(state);
    await deliver(`「${item.name}」预计今天有结果，可以跟 ${item.counterpart} 确认一下。`, `follow-up-${item.id}-${item.expectedDate}`);
    return true;
  }
  return { handle, tick };
}

module.exports = { createFollowUpStore };
