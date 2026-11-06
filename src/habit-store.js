'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged, resultText } = require('./feature-result');
const { shanghaiDay, addDays } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');
const { HELP } = require('./habit-commands');

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.habits)
    || state.habits.some(item => !item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name !== item.name.trim()
      || !['active', 'archived'].includes(item.status) || !Number.isFinite(Date.parse(item.createdAt))
      || (item.status === 'archived' ? !Number.isFinite(Date.parse(item.archivedAt)) : item.archivedAt !== null)
      || !Array.isArray(item.days) || item.days.some(day => !validDay(day) || day < shanghaiDay(item.createdAt))
      || new Set(item.days).size !== item.days.length)
    || new Set(state.habits.map(item => item.id)).size !== state.habits.length
    || new Set(state.habits.map(item => item.name)).size !== state.habits.length) {
    throw new Error('习惯存储格式无效');
  }
}

// A streak ending yesterday remains current until today's opportunity has passed.
function habitStats(habit, today) {
  const cutoff = habit.status === 'archived' && shanghaiDay(habit.archivedAt) < today
    ? shanghaiDay(habit.archivedAt) : today;
  const days = new Set(habit.days.filter(day => day <= cutoff));
  let cursor = days.has(cutoff) ? cutoff : addDays(cutoff, -1);
  let streak = 0;
  while (days.has(cursor)) { streak++; cursor = addDays(cursor, -1); }
  return { streak, total: days.size, checkedToday: days.has(today) };
}

function createHabitStore({ stateFile, now = () => Date.now() }) {
  function execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['create', 'check', 'uncheck', 'stats', 'list', 'archive'].includes(command.type)) return refused(HELP);
    if (command.type !== 'list' && (typeof command.name !== 'string' || !command.name.trim() || /[\r\n]/u.test(command.name))) return refused(HELP);
    const clock = now();
    const today = shanghaiDay(clock);
    const timestamp = new Date(clock).toISOString();
    const state = readRecordState(stateFile, { schemaVersion: 1, habits: [] }, true, { strict: true, now, validate: validateState });
    const save = () => writeRecordState(stateFile, state, ['habits']);
    const summary = item => {
      const stats = habitStats(item, today);
      return `${item.name}｜${item.status === 'archived' ? '已归档' : '进行中'}｜连续 ${stats.streak} 天｜累计 ${stats.total} 天｜今天${stats.checkedToday ? '已' : '未'}打卡`;
    };
    if (command.type === 'list') return unchanged(state.habits.length ? state.habits.map(summary).join('\n') : '暂无习惯。' + HELP);
    const name = command.name.trim();
    const item = state.habits.find(habit => habit.name === name);
    if (command.type === 'create') {
      if (item) return refused('同名习惯已存在（含归档），请使用不同名称。');
      state.habits.push({ id: crypto.randomUUID(), name, status: 'active', createdAt: timestamp, archivedAt: null, days: [] });
      save();
      return changed(`已创建习惯：${name}，尚未打卡。`);
    }
    if (!item) return refused('未找到这个习惯，请使用完整名称。');
    if (command.type === 'stats') return unchanged(summary(item));
    if (item.status === 'archived') return refused('该习惯已归档，记录保留，仅可查看统计。');
    if (today < shanghaiDay(item.createdAt)) return refused('当前日期早于习惯创建日期，未修改。');
    if (command.type === 'archive') {
      item.status = 'archived'; item.archivedAt = timestamp;
    } else if (command.type === 'check') {
      if (item.days.includes(today)) return unchanged(`今天已打卡，未重复记录。\n${summary(item)}`);
      item.days.push(today); item.days.sort();
    } else {
      if (!item.days.includes(today)) return unchanged(`今天尚未打卡，未修改。\n${summary(item)}`);
      item.days = item.days.filter(day => day !== today);
    }
    save();
    return changed(`${command.type === 'archive' ? '已归档' : command.type === 'check' ? '已打卡' : '已取消当天打卡'}（${today}）\n${summary(item)}`);
  }
  function readActiveItems(side) {
    if (side !== 'owner') throw Error('这个私人助手只供已绑定的本人使用。');
    const state = readRecordState(stateFile, { schemaVersion: 1, habits: [] }, true,
      { strict: true, readOnly: true, validate: validateState });
    return state.habits.filter(item => item.status === 'active').map(({ id, name }) => ({ id, name }));
  }
  return { execute, handle: (side, command) => resultText(execute(side, command)), readActiveItems };
}
module.exports = { createHabitStore, habitStats };
