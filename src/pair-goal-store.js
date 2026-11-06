'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const SIDES = ['owner', 'friend'];
const validSide = side => { if (!SIDES.includes(side)) throw new Error('invalid goal side'); };
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const day = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const HELP = '请用「共同目标：一起散步 10次」创建，目标不能为空，总次数须为正整数。';

function validate(state) {
  const fail = () => { throw new Error('共同目标存储格式无效'); };
  if (state?.schemaVersion !== 1 || !Array.isArray(state.goals)
    || state.goals.filter(goal => goal?.status === 'active').length > 1) fail();
  const ids = new Set();
  for (const goal of state.goals) {
    if (!goal || typeof goal.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(goal.id) || ids.has(goal.id)
      || !SIDES.includes(goal.createdBy) || typeof goal.text !== 'string' || !goal.text.trim()
      || !Number.isSafeInteger(goal.total) || goal.total <= 0 || !date(goal.createdAt)
      || !['active', 'completed', 'closed'].includes(goal.status) || !Array.isArray(goal.checkins)
      || !(goal.endedAt === null || date(goal.endedAt))
      || (goal.status === 'active') !== (goal.endedAt === null)
      || goal.checkins.length > goal.total
      || (goal.status === 'completed') !== (goal.checkins.length === goal.total)) fail();
    ids.add(goal.id);
    const seen = new Set();
    for (const entry of goal.checkins) {
      if (!entry || !SIDES.includes(entry.side) || !date(entry.createdAt) || entry.date !== day(entry.createdAt)
        || seen.has(`${entry.side}|${entry.date}`)) fail();
      seen.add(`${entry.side}|${entry.date}`);
    }
  }
}

function createPairGoalStore({ stateFile, now = () => Date.now(), sideNames = { owner: 'Owner', friend: '好友' } }) {
  const empty = () => ({ schemaVersion: 1, goals: [] });
  const load = () => readRecordState(stateFile, empty(), true, { strict: true, now, validate });
  function save(state) { validate(state); writeRecordState(stateFile, state, ['goals']); }
  function progress(goal) {
    return [`共同目标：${goal.text}（${{ active: '进行中', completed: '已完成', closed: '已关闭' }[goal.status]}）`,
      `总次数：${goal.total}；已完成：${goal.checkins.length}；剩余：${goal.total - goal.checkins.length}。`,
      ...SIDES.map(side => `${sideNames[side]}打卡：${goal.checkins.filter(entry => entry.side === side).length} 次。`)].join('\n');
  }
  function handle(side, command) {
    validSide(side);
    if (!command || !['create', 'checkin', 'undo', 'progress', 'close', 'help'].includes(command.type)) throw new Error('不支持的共同目标命令');
    if (command.type === 'help') return HELP;
    const state = load();
    const goal = state.goals.find(item => item.status === 'active');
    if (command.type === 'create') {
      if (typeof command.text !== 'string' || !command.text.trim() || !Number.isSafeInteger(command.total) || command.total <= 0) return HELP;
      if (goal) return `已有进行中的共同目标「${goal.text}」，请先完成或「关闭共同目标」，不会覆盖。`;
      const created = { id: crypto.randomUUID(), text: command.text.trim(), total: command.total, createdBy: side,
        createdAt: new Date(now()).toISOString(), status: 'active', endedAt: null, checkins: [] };
      state.goals.push(created);
      save(state);
      return `已创建共同目标。\n${progress(created)}`;
    }
    if (command.type === 'progress') {
      if (!state.goals.length) return '还没有共同目标。' + HELP;
      return [goal ? progress(goal) : '当前没有进行中的共同目标。',
        ...state.goals.filter(item => item.status !== 'active').map(item => `历史记录：\n${progress(item)}`)].join('\n\n');
    }
    if (!goal) return '当前没有进行中的共同目标，可用「共同目标进度」查看历史。';
    if (command.type === 'close') {
      goal.status = 'closed';
      goal.endedAt = new Date(now()).toISOString();
      save(state);
      return `已关闭共同目标，历史记录保留。\n${progress(goal)}`;
    }
    const time = now();
    const today = day(time);
    const index = goal.checkins.findIndex(entry => entry.side === side && entry.date === today);
    if (command.type === 'undo') {
      if (index < 0) return `你今天（${today}，上海日期）没有共同目标打卡可撤销。`;
      goal.checkins.splice(index, 1);
      save(state);
      return `已撤销你今天（${today}，上海日期）的打卡。\n${progress(goal)}`;
    }
    if (index >= 0) return `你今天（${today}，上海日期）已打过卡，不会重复计数。\n${progress(goal)}`;
    goal.checkins.push({ side, date: today, createdAt: new Date(time).toISOString() });
    if (goal.checkins.length === goal.total) {
      goal.status = 'completed';
      goal.endedAt = new Date(time).toISOString();
    }
    save(state);
    return [`${sideNames[side]}已打卡（${today}，上海日期）。`,
      goal.status === 'completed' ? '恭喜你们达成共同目标！已自动标记完成。' : '', progress(goal)].filter(Boolean).join('\n');
  }
  // Like pair challenge, deleting the paired relationship clears the feature's shared records.
  function deleteSide(side) {
    validSide(side);
    const state = load();
    save(empty());
    return { removed: state.goals.length };
  }
  return { handle, deleteSide };
}

module.exports = { createPairGoalStore };
