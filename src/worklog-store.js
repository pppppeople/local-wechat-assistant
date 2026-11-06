'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged, resultText } = require('./feature-result');
const { shanghaiDay } = require('./personal-todo-commands');
const { HELP } = require('./worklog-commands');

const SECTIONS = [['完成', '已完成'], ['进行中', '进行中'], ['阻塞', '阻塞'], ['明日', '明日计划'], ['记录', '记录']];

function statusOf(text) {
  return text.trimStart().match(/^(完成|进行中|阻塞|明日)(?=$|[\s：:，,、。])/u)?.[1] || '记录';
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.entries)
    || state.entries.some(item => !item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || typeof item.text !== 'string' || !item.text.trim()
      || !Number.isFinite(Date.parse(item.createdAt)) || item.date !== shanghaiDay(item.createdAt))
    || new Set(state.entries.map(item => item.id)).size !== state.entries.length) {
    throw new Error('工作日志存储格式无效');
  }
}

function createWorklogStore({ stateFile, now = () => Date.now() }) {
  function execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['add', 'list', 'summary', 'delete'].includes(command.type)) return refused(HELP);
    if (command.type === 'add' && (typeof command.text !== 'string' || !command.text.trim())) {
      return refused('工作日志内容不能为空。' + HELP);
    }
    const clock = now();
    const date = shanghaiDay(clock);
    const state = readRecordState(stateFile, { schemaVersion: 1, entries: [] }, true,
      { strict: true, now, validate: validateState });
    const today = state.entries.filter(item => item.date === date);
    const save = () => writeRecordState(stateFile, state, ['entries']);
    if (command.type === 'add') {
      state.entries.push({ id: crypto.randomUUID(), date, text: command.text, createdAt: new Date(clock).toISOString() });
      save();
      return changed(`已追加今日工作日志第 ${today.length + 1} 条（${date}）：${command.text}`);
    }
    if (command.type === 'delete') {
      if (!Number.isSafeInteger(command.number) || command.number < 1 || command.number > today.length) {
        return refused(today.length ? `工作日志序号越界，请使用今日列表中的 1–${today.length}。` : `今日暂无工作日志（${date}），无法删除。`);
      }
      const entry = today[command.number - 1];
      state.entries = state.entries.filter(item => item.id !== entry.id);
      save();
      return changed(`已删除今日工作日志第 ${command.number} 条：${entry.text}`);
    }
    if (!today.length) return unchanged(`今日暂无工作日志（${date}）。`);
    const numbered = today.map((item, index) => ({ ...item, number: index + 1 }));
    const line = item => `${item.number}. ${item.text}`;
    if (command.type === 'list') return unchanged([`今日工作日志（${date}）`, ...numbered.map(line)].join('\n'));
    return unchanged([`今日工作日志汇总（${date}）`, ...SECTIONS.map(([status, title]) => {
      const items = numbered.filter(item => statusOf(item.text) === status);
      return `${title}\n${items.length ? items.map(line).join('\n') : '暂无'}`;
    })].join('\n\n'));
  }
  function readDailyEntries(side, date) {
    if (side !== 'owner') throw new Error('这个私人助手只供已绑定的本人使用。');
    const state = readRecordState(stateFile, { schemaVersion: 1, entries: [] }, true,
      { strict: true, readOnly: true, validate: validateState });
    return state.entries.filter(item => item.date === date).map(item => ({ text: item.text }));
  }
  return { execute, handle: (side, command) => resultText(execute(side, command)), readDailyEntries };
}

module.exports = { createWorklogStore, statusOf };
