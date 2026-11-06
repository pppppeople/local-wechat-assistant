'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged, resultText } = require('./feature-result');
const { addDays, extractDueDate, shanghaiDay } = require('./personal-todo-commands');

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.todos)
    || state.todos.some((item) => !item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || typeof item.text !== 'string' || !item.text.trim() || !['open', 'done'].includes(item.status)
      || !Number.isFinite(Date.parse(item.createdAt))
      || (Object.hasOwn(item, 'estimatedMinutes')
        && (!Number.isSafeInteger(item.estimatedMinutes) || item.estimatedMinutes <= 0))
      || (Object.hasOwn(item, 'dependencyIds') && (!Array.isArray(item.dependencyIds)
        || item.dependencyIds.some(id => typeof id !== 'string')
        || new Set(item.dependencyIds).size !== item.dependencyIds.length))
      || (item.status === 'done' && !Number.isFinite(Date.parse(item.completedAt)))
      || (item.dueDate !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(item.dueDate)
        || !Number.isFinite(Date.parse(`${item.dueDate}T00:00:00Z`))
        || new Date(`${item.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== item.dueDate)))
    || new Set(state.todos.map((item) => item.id)).size !== state.todos.length) {
    throw new Error('个人待办存储格式无效');
  }
  const byId = new Map(state.todos.map(item => [item.id, item]));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (!byId.has(id) || visiting.has(id)) throw new Error('个人待办依赖无效：存在悬空或循环依赖');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of byId.get(id).dependencyIds || []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

function reaches(state, fromId, targetId, seen = new Set()) {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  return (state.todos.find(item => item.id === fromId)?.dependencyIds || [])
    .some(id => reaches(state, id, targetId, seen));
}

function cleanDependencies(state) {
  const ids = new Set(state.todos.map(item => item.id));
  for (const item of state.todos) {
    if (item.dependencyIds) item.dependencyIds = item.dependencyIds.filter(id => ids.has(id));
  }
}

function openItems(state) {
  return state.todos.filter((item) => item.status === 'open').sort((a, b) =>
    (a.dueDate || '9999').localeCompare(b.dueDate || '9999')
    || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
function dueLabel(dueDate, now) {
  if (!dueDate) return '无到期日';
  const today = shanghaiDay(now);
  if (dueDate < today) return '逾期';
  if (dueDate === addDays(today, 1)) return '明天';
  return `${Number(dueDate.slice(5, 7))}月${Number(dueDate.slice(8, 10))}日`;
}

function createPersonalTodoStore({ stateFile, now = () => Date.now(), maxBudgetMinutes = 1440 }) {
  function load() {
    return readRecordState(stateFile, { schemaVersion: 1, todos: [] }, true,
      { strict: true, now, validate: validateState });
  }
  function save(state) { writeRecordState(stateFile, state, ['todos']); }
  function execute(side, command) {
    // Refuse before reading or writing owner data, including every query.
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['add', 'list', 'complete', 'cancel', 'clear_completed', 'budget', 'estimate',
      'ready', 'dependencies', 'set_dependencies', 'remove_dependency'].includes(command.type)) {
      return refused('不支持这个个人待办操作。');
    }
    if (command.type === 'budget' && (!Number.isSafeInteger(command.minutes)
      || command.minutes <= 0 || command.minutes > maxBudgetMinutes)) {
      return refused(`预算须为 1–${maxBudgetMinutes} 的整数分钟，例如：待办预算：30分钟；超限不会截断。`);
    }
    if ((command.type === 'estimate' || (command.type === 'add' && Object.hasOwn(command, 'estimatedMinutes')))
      && (!Number.isSafeInteger(command.estimatedMinutes) || command.estimatedMinutes <= 0)) {
      return refused('预估分钟数须为正整数，例如：第2项估时：15分钟。');
    }
    const state = load();
    const items = openItems(state);
    const clock = now();
    if (command.type === 'ready') {
      const byId = new Map(state.todos.map(item => [item.id, item]));
      const lines = items.flatMap((item, index) => (item.dependencyIds || [])
        .some(id => byId.get(id).status === 'open') ? [] : [`${index + 1}. ${item.text}`]);
      return unchanged(lines.length ? `可开始的待办：\n${lines.join('\n')}` : '暂无可开始的待办。');
    }
    if (command.type === 'budget') {
      let total = 0;
      const selected = [], unestimated = [];
      for (const [index, item] of items.entries()) {
        const line = `${index + 1}. ${item.text}`;
        if (!Object.hasOwn(item, 'estimatedMinutes')) unestimated.push(line);
        else if (item.estimatedMinutes <= command.minutes - total) {
          selected.push(`${line}（${item.estimatedMinutes}分钟）`);
          total += item.estimatedMinutes;
        }
      }
      return unchanged(`时间预算：${command.minutes}分钟；总预计耗时：${total}分钟。\n`
        + (selected.length ? `可做待办：\n${selected.join('\n')}` : '没有可纳入预算的已估算待办，不凑数。')
        + `\n未估算（未纳入预算）：\n${unestimated.length ? unestimated.join('\n') : '无'}`);
    }
    if (command.type === 'list') {
      return unchanged(items.length ? items.map((item, index) =>
        `${index + 1}. ${item.text}（到期：${dueLabel(item.dueDate, clock)}）`
        + (Object.hasOwn(item, 'estimatedMinutes') ? `（预估：${item.estimatedMinutes}分钟）` : '')).join('\n') : '暂无待办。');
    }
    if (command.type === 'add') {
      if (Object.hasOwn(command, 'idempotencyKey')) {
        if (typeof command.idempotencyKey !== 'string' || !/^focus-stash-[a-z0-9_-]+$/iu.test(command.idempotencyKey)) {
          return refused('待办幂等标识无效。');
        }
        if (state.todos.some(item => item.id === command.idempotencyKey)) return unchanged('该暂存已转为待办。');
      }
      if (items.length >= 200) return refused('未完成待办最多 200 条，请先完成或取消一些再新增。');
      const body = Object.hasOwn(command, 'dueDate')
        ? { text: String(command.text || ''), dueDate: command.dueDate }
        : extractDueDate(String(command.text || ''), clock);
      if (!body.text.trim()) return refused('待办内容不能为空，请在“记一下”后写下要做的事。');
      if (Object.hasOwn(command, 'estimatedMinutes')) body.estimatedMinutes = command.estimatedMinutes;
      state.todos.push({ id: command.idempotencyKey || crypto.randomUUID(), ...body, status: 'open', createdAt: new Date(clock).toISOString() });
      validateState(state);
      save(state);
      return changed(`已记下：${body.text}（到期：${dueLabel(body.dueDate, clock)}）。`);
    }
    if (command.type === 'clear_completed') {
      const count = state.todos.length - items.length;
      if (!count) return unchanged('暂无已完成待办可清空。');
      state.todos = items;
      cleanDependencies(state);
      save(state);
      return changed(`已清空 ${count} 条已完成待办。`);
    }
    if (!items.length) return refused('暂无待办，无法操作指定序号。');
    if (!Number.isSafeInteger(command.number) || command.number < 1 || command.number > items.length) {
      return refused(`待办序号越界，请使用当前列表中的 1–${items.length}。`);
    }
    const item = items[command.number - 1];
    if (command.type === 'dependencies') {
      const lines = (item.dependencyIds || []).map(id => {
        const prerequisite = state.todos.find(entry => entry.id === id);
        const number = items.findIndex(entry => entry.id === id) + 1;
        return number ? `第${number}项：${prerequisite.text}（未完成，阻塞）`
          : `${prerequisite.text}（已完成，不阻塞；id：${id}）`;
      });
      return unchanged(`第${command.number}项「${item.text}」的前置待办：\n${lines.length ? lines.join('\n') : '无。'}`);
    }
    if (command.type === 'set_dependencies') {
      if (!Array.isArray(command.numbers) || !command.numbers.length
        || command.numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > items.length)) {
        return refused('前置待办须使用当前列表有效序号，例如：第3项前置：第1项、第2项。');
      }
      const ids = [...new Set(command.numbers.map(number => items[number - 1].id))];
      if (ids.includes(item.id)) return refused('不能设置依赖：待办不能依赖自身。');
      if (ids.some(id => reaches(state, id, item.id))) return refused('不能设置依赖：会形成循环依赖（直接或间接）。');
      item.dependencyIds = ids;
      save(state);
      return changed(`已设置第${command.number}项的前置待办，共 ${ids.length} 条（替换原设置）。`);
    }
    if (command.type === 'remove_dependency') {
      let id = command.dependencyId;
      if (!id) {
        if (!Number.isSafeInteger(command.dependencyNumber) || command.dependencyNumber < 1
          || command.dependencyNumber > items.length) return refused('依赖序号越界，请使用当前列表序号或依赖查询显示的 id。');
        id = items[command.dependencyNumber - 1].id;
      }
      if (!(item.dependencyIds || []).includes(id)) return refused('未找到这条前置依赖，未作修改。');
      item.dependencyIds = item.dependencyIds.filter(dependencyId => dependencyId !== id);
      save(state);
      return changed(`已移除第${command.number}项的一条前置依赖。`);
    }
    if (command.type === 'estimate') {
      item.estimatedMinutes = command.estimatedMinutes;
      save(state);
      return changed(`已设置第${command.number}项预估耗时：${item.estimatedMinutes}分钟。`);
    }
    if (command.type === 'cancel') {
      state.todos = state.todos.filter((entry) => entry.id !== item.id);
    } else {
      item.status = 'done';
      item.completedAt = new Date(clock).toISOString();
      const recent = new Set(state.todos.filter((entry) => entry.status === 'done')
        .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)
          || state.todos.indexOf(b) - state.todos.indexOf(a)).slice(0, 100).map((entry) => entry.id));
      state.todos = state.todos.filter((entry) => entry.status === 'open' || recent.has(entry.id));
    }
    cleanDependencies(state);
    save(state);
    const summary = item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text;
    return changed(`已${command.type === 'cancel' ? '取消' : '完成'}：${summary}。`);
  }
  function handle(side, command) { return resultText(execute(side, command)); }
  function readOpenItems(side) {
    if (side !== 'owner') throw new Error('这个私人助手只供已绑定的本人使用。');
    const state = readRecordState(stateFile, { schemaVersion: 1, todos: [] }, true,
      { strict: true, readOnly: true, validate: validateState });
    return openItems(state).map((item, index) => ({ ...item, number: index + 1 }));
  }
  function readDailyItems(side, date, changesOnly = false) {
    if (side !== 'owner') throw new Error('这个私人助手只供已绑定的本人使用。');
    const state = readRecordState(stateFile, { schemaVersion: 1, todos: [] }, true,
      { strict: true, readOnly: true, validate: validateState });
    return {
      completed: state.todos.filter(item => item.status === 'done' && shanghaiDay(item.completedAt) === date)
        .map(item => ({ text: item.text, completedAt: item.completedAt, dueDate: item.dueDate })),
      open: openItems(state).filter(item => !changesOnly || shanghaiDay(item.createdAt) === date)
        .map(item => ({ text: item.text, dueDate: item.dueDate })),
    };
  }
  // Reuse the daily completion filter; scope open items to their creation day.
  // This is a current-state projection, not a historical snapshot.
  const readDailyChanges = (side, date) => readDailyItems(side, date, true);
  return { execute, handle, readOpenItems, readDailyItems, readDailyChanges };
}

module.exports = { createPersonalTodoStore };
