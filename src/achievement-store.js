'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged, resultText } = require('./feature-result');
const { shanghaiDay } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');
const { achievementDate, HELP } = require('./achievement-commands');

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.entries)
    || state.entries.some(item => !item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || typeof item.note !== 'string'
      || !validDay(item.date) || !Number.isFinite(Date.parse(item.createdAt)))
    || new Set(state.entries.map(item => item.id)).size !== state.entries.length
    || new Set(state.entries.map(item => JSON.stringify([item.name, item.date]))).size !== state.entries.length) {
    throw new Error('成就博物馆存储格式无效');
  }
}

function createAchievementStore({ stateFile, now = () => Date.now(), random = Math.random }) {
  function execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['add', 'list', 'recall', 'delete'].includes(command.type)) return refused(HELP);
    const clock = now();
    const today = shanghaiDay(clock);
    let date = null;
    if (command.type === 'add' || command.type === 'delete') {
      if (typeof command.name !== 'string' || !command.name.trim()) return refused(HELP);
      if (command.date != null) {
        date = achievementDate(command.date, clock);
        if (!date) return refused('日期无法识别，请用今天、昨天、前天、周几、10月1日或 YYYY-MM-DD。' + HELP);
      }
      if (command.type === 'add') {
        date ||= today;
        if (date > today) return refused('成就日期不能晚于今天，请记录已经发生的成就。');
        if (command.note != null && typeof command.note !== 'string') return refused(HELP);
      }
    }
    const state = readRecordState(stateFile, { schemaVersion: 1, entries: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => writeRecordState(stateFile, state, ['entries']);
    const line = item => `${item.name}｜${item.date}${item.note ? `｜${item.note}` : ''}`;
    const sorted = state.entries.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    if (command.type === 'add') {
      const name = command.name.trim();
      if (state.entries.some(item => item.name === name && item.date === date)) return refused(`已存在这条成就：${name}｜${date}，未重复收藏。`);
      const entry = { id: crypto.randomUUID(), name, date, note: (command.note || '').trim(), createdAt: new Date(clock).toISOString() };
      state.entries.push(entry);
      save();
      return changed(`已收藏成就：${line(entry)}`);
    }
    if (command.type === 'delete') {
      const name = command.name.trim();
      const eligible = sorted.filter(item => !date || item.date === date);
      const exact = eligible.filter(item => item.name === name);
      const matches = exact.length ? exact : eligible.filter(item => item.name.includes(name));
      if (!matches.length) return refused('没有找到这条成就，未删除。');
      if (new Set(matches.map(item => item.name)).size > 1) return refused('匹配到多个成就，请用完整成就名并带日期说得更具体：删成就：成就名｜YYYY-MM-DD。');
      const entry = matches[0];
      state.entries = state.entries.filter(item => item.id !== entry.id);
      save();
      return changed(`已删除${matches.length > 1 ? '同名最近一条' : '成就'}：${line(entry)}`);
    }
    if (!sorted.length) return unchanged('成就博物馆暂无成就。用“记录成就：成就名”收藏第一条。');
    if (command.type === 'recall') {
      const entry = sorted[Math.floor(random() * sorted.length)];
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${entry.date}T00:00:00Z`)) / 86400000);
      return unchanged(`随机回顾一个成就\n${line(entry)}\n${days === 0 ? '这是今天的事。' : `这是 ${days} 天前的事。`}`);
    }
    return unchanged([`个人成就博物馆（共 ${sorted.length} 条${sorted.length > 20 ? '，先列最近 20 条' : ''}）`,
      ...sorted.slice(0, 20).map((item, index) => `${index + 1}. ${line(item)}`)].join('\n'));
  }
  return { execute, handle: (side, command) => resultText(execute(side, command)) };
}

module.exports = { createAchievementStore };
