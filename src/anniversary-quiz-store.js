'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { normalizeDate, HELP } = require('./anniversary-quiz-commands');
const ROUND_TTL_MS = 24 * 60 * 60 * 1000;
const SIDES = ['owner', 'friend'];
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && Boolean(value.trim());
const canonicalDate = value => normalizeDate(value) === value && value !== null;
// Shanghai local midnights, independent of the machine's process timezone.
const midnight = date => Date.parse(`${date}T00:00:00+08:00`);
function anniversaryStats(date, time) {
  const today = shanghaiDay(time);
  const year = Number(today.slice(0, 4)), startYear = Number(date.slice(0, 4));
  let occurrence = `${today.slice(0, 4)}-${date.slice(5)}`;
  if (!normalizeDate(occurrence)) occurrence = `${today.slice(0, 4)}-02-28`;
  return { today, years: Math.max(0, year - startYear - (today < occurrence ? 1 : 0)),
    days: (midnight(today) - midnight(date)) / 86400000 };
}
function validate(state) {
  const fail = () => { throw new Error('纪念日问答存储格式无效'); };
  if (state?.schemaVersion !== 1 || !text(state.binding) || !Array.isArray(state.anniversaries)
    || state.anniversaries.length > 20 || !Array.isArray(state.rounds)
    || state.rounds.filter(r => r?.status === 'active').length > 1) fail();
  const ids = new Set(), names = new Set();
  for (const row of [...state.anniversaries, ...state.rounds]) {
    if (!row || typeof row.id !== 'string' || !/^[a-z0-9-]+$/iu.test(row.id) || ids.has(row.id)
      || !text(row.name) || !canonicalDate(row.date) || !stamp(row.createdAt)) fail();
    ids.add(row.id);
  }
  for (const row of state.anniversaries) {
    if (names.has(row.name)) fail();
    names.add(row.name);
  }
  for (const r of state.rounds) {
    if (!['active', 'revealed', 'cancelled', 'expired'].includes(r.status)
      || !stamp(r.expiresAt) || Date.parse(r.expiresAt) - Date.parse(r.createdAt) !== ROUND_TTL_MS
      || (r.status === 'active' ? r.endedAt !== null : !stamp(r.endedAt))
      || !r.answers || Object.keys(r.answers).some(side => !SIDES.includes(side) || !canonicalDate(r.answers[side]))) fail();
  }
}
function createAnniversaryQuizStore({ stateFile, now = () => Date.now(), getBinding = () => 'local',
  sideNames = { owner: 'Owner', friend: '好友' } }) {
  const empty = binding => ({ schemaVersion: 1, binding, anniversaries: [], rounds: [] });
  const save = state => { validate(state); writeRecordState(stateFile, state, ['anniversaries', 'rounds']); };
  function load() {
    if (!fs.existsSync(stateFile) && fs.existsSync(path.dirname(stateFile))
      && fs.readdirSync(path.dirname(stateFile)).some(name => name.startsWith(`${path.basename(stateFile)}.corrupt-`))) {
      throw new Error('纪念日问答存储已隔离，请先恢复索引及记录');
    }
    const binding = getBinding();
    if (!text(binding)) throw new Error('缺少配对绑定');
    const state = readRecordState(stateFile, empty(binding), true, { strict: true, now, validate });
    if (state.binding !== binding) throw new Error('纪念日问答绑定已变化，请先恢复或清理旧配对存储');
    return state;
  }
  function expireState(state) {
    let changed = false;
    for (const r of state.rounds) if (r.status === 'active' && now() >= Date.parse(r.expiresAt)) {
      r.status = 'expired'; r.endedAt = r.expiresAt; changed = true;
    }
    if (changed) save(state);
  }
  function result(r) {
    const stats = anniversaryStats(r.date, Date.parse(r.endedAt));
    return [`纪念日「${r.name}」已揭晓。登记日期：${r.date}`,
      ...SIDES.map(side => `${sideNames[side]}：${!Object.hasOwn(r.answers, side) ? '未作答' : r.answers[side] === r.date ? '正确' : '错误'}`),
      `截至 ${stats.today}（上海本地日期）：完整周年数 ${stats.years} 年；${stats.days < 0 ? `距纪念日还有 ${-stats.days} 天` : `距今 ${stats.days} 天`}。`].join('\n');
  }
  function handle(side, command) {
    if (!SIDES.includes(side)) throw new Error('invalid anniversary quiz side');
    if (!command || !['add', 'list', 'delete', 'start', 'answer', 'reveal', 'cancel'].includes(command.type)) return HELP;
    const { type } = command;
    if (['add', 'list', 'delete'].includes(type) && side !== 'owner') return '仅主人可以登记、列出或删除纪念日。';
    if (['add', 'delete', 'start'].includes(type) && !text(command.name)) return HELP;
    if (type === 'add' && (!canonicalDate(command.date))) return '登记日期无效，请使用真实日期 YYYY-MM-DD。';
    const answer = type === 'answer' ? normalizeDate(command.date) : null;
    if (type === 'answer' && !answer) return '回答日期无效，请使用真实日期 YYYY-MM-DD 或 YYYY年M月D日；本次未记为作答。';
    const state = load();
    const name = command.name?.trim();
    const row = state.anniversaries.find(item => item.name === name);
    if (type === 'add') {
      if (row) return '已存在同名纪念日，不会覆盖。';
      if (state.anniversaries.length >= 20) return '纪念日已达 20 个上限，无法新增。';
      state.anniversaries.push({ id: crypto.randomUUID(), name, date: command.date, createdAt: new Date(now()).toISOString() });
      save(state); return `已登记纪念日：${name}｜${command.date}`;
    }
    if (type === 'list') return ['纪念日列表：', ...state.anniversaries.map(item => `${item.name}｜${item.date}`),
      ...(!state.anniversaries.length ? ['暂无纪念日。'] : [])].join('\n');
    expireState(state);
    const active = state.rounds.find(r => r.status === 'active');
    if (type === 'delete') {
      if (!row) return '纪念日不存在，未删除。';
      if (active?.anniversaryId === row.id) return '该纪念日有进行中题目，请先揭晓或放弃。';
      state.anniversaries = state.anniversaries.filter(item => item !== row); save(state);
      return `已删除纪念日：${name}`;
    }
    if (type === 'start') {
      if (!row) return '纪念日不存在，请主人先登记。';
      if (active) return '已有进行中题目，请先揭晓或放弃；同时仅一题。';
      const time = now();
      state.rounds.push({ id: crypto.randomUUID(), anniversaryId: row.id, name: row.name, date: row.date,
        createdAt: new Date(time).toISOString(), expiresAt: new Date(time + ROUND_TTL_MS).toISOString(),
        endedAt: null, status: 'active', answers: {} });
      save(state);
      return `纪念日「${name}」：该纪念日的日期是哪一天？\n双方密封作答，用「纪念日回答：日期」回答；每方仅一次，24 小时过期。`;
    }
    if (!active) {
      const latest = state.rounds.at(-1);
      if (type === 'reveal' && latest?.status === 'revealed') return result(latest);
      return latest?.status === 'expired' ? '本题已过期并归档，不能作答或揭晓。' : '当前没有进行中的纪念日题目。';
    }
    if (type === 'cancel') {
      active.status = 'cancelled'; active.endedAt = new Date(now()).toISOString(); save(state);
      return '已放弃纪念日问答，本题结束，未揭晓。';
    }
    if (type === 'answer') {
      if (Object.hasOwn(active.answers, side)) return '本题你已作答，不能重复作答或修改。';
      active.answers[side] = answer;
      if (Object.keys(active.answers).length < 2) {
        save(state); return '已密封记录你的作答，揭晓前不展示对方答案。';
      }
    }
    active.status = 'revealed'; active.endedAt = new Date(now()).toISOString(); save(state);
    return result(active);
  }
  function deleteSide(side) {
    if (!SIDES.includes(side)) throw new Error('invalid anniversary quiz side');
    const state = load(), removed = state.rounds.length;
    state.rounds = []; save(state); // Preserve owner-managed registrations.
    return { removed };
  }
  return { handle, expire: () => expireState(load()), deleteSide };
}
module.exports = { createAnniversaryQuizStore, anniversaryStats, ROUND_TTL_MS };
