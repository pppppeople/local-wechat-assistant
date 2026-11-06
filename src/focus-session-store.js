'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { describeTimestamp } = require('./friend-relay-commands');
const { createFocusStashCommands, finishFocusStash, validateFocusStash } = require('./focus-stash-commands');

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.sessions) || state.sessions.length > 1) {
    throw new Error('专注存储格式无效');
  }
  for (const item of state.sessions) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || !['active', 'cancelled', 'finished'].includes(item.status)
      || typeof item.startedAt !== 'string' || typeof item.endsAt !== 'string'
      || !Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.endsAt))
      || Date.parse(item.endsAt) <= Date.parse(item.startedAt)
      || item.createdAt !== item.startedAt || typeof item.goal !== 'string' || typeof item.reminded !== 'boolean'
      || (item.status === 'finished') !== item.reminded) throw new Error('专注记录格式无效');
    validateFocusStash(item.stash);
  }
}

function createFocusSessionStore({ stateFile, now = () => Date.now(), todos }) {
  let initialized = false;
  function load() {
    const state = readRecordState(stateFile, { schemaVersion: 1, sessions: [] }, true,
      { strict: true, now, validate: validateState });
    // Lazy boot cleanup: constructing the store or rejecting a friend never reads
    // owner storage. Preserve the existing timer/reminder across process restarts.
    if (!initialized) {
      if (state.sessions.some(item => Object.hasOwn(item, 'stash'))) {
        for (const item of state.sessions) delete item.stash;
        save(state);
      }
      initialized = true;
    }
    return state;
  }
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['sessions']); }
  const remaining = item => `${Math.max(0, Math.ceil((Date.parse(item.endsAt) - now()) / 60000))} 分钟`;
  function handle(side, command) {
    // Reject before touching any owner state.
    if (side !== 'owner') return '临时专注模式仅主人可用。';
    if (!command || command.type === 'invalid') return '没有开始专注：请提供明确的正整数分钟或小时，例如「专心工作 45 分钟」。';
    if (!['start', 'cancel', 'status'].includes(command.type)) throw new Error('不支持的专注命令');
    const state = load();
    const current = state.sessions.find(item => item.status === 'active');
    if (command.type === 'status') {
      if (!current || Date.parse(current.endsAt) <= now()) return current
        ? '没有进行中的专注；上次专注已到期，结束提醒待发送。' : '没有进行中的专注。';
      return `专注进行中，剩余 ${remaining(current)}，结束时间：${describeTimestamp(current.endsAt)}（Asia/Shanghai）。${current.goal ? `目标：${current.goal}` : ''}`;
    }
    if (command.type === 'cancel') {
      if (!current) return '没有进行中的专注。';
      current.status = 'cancelled';
      const stashReply = finishFocusStash(current);
      save(state);
      return '已结束专注，已取消待发结束提醒，本次不再补发。' + stashReply;
    }
    if (current) return `不能重复开始专注：当前剩余 ${remaining(current)}。${Date.parse(current.endsAt) <= now() ? '已到期，结束提醒待发送；可先结束专注。' : ''}`;
    const clock = now();
    if (!Number.isSafeInteger(command.durationMs) || command.durationMs <= 0
      || !Number.isFinite(new Date(clock + command.durationMs).getTime()) || typeof command.goal !== 'string') {
      return '没有开始专注：时长或目标格式无效。';
    }
    const startedAt = new Date(clock).toISOString();
    const item = { id: crypto.randomUUID(), status: 'active', createdAt: startedAt, startedAt,
      endsAt: new Date(clock + command.durationMs).toISOString(), goal: command.goal, reminded: false };
    state.sessions = [item];
    save(state);
    return `已开始专注，结束时间：${describeTimestamp(item.endsAt)}（Asia/Shanghai）。${item.goal ? `结束提醒你：${item.goal}` : ''}`;
  }
  async function tick(deliver) {
    const state = load();
    const item = state.sessions.find(entry => entry.status === 'active' && !entry.reminded && Date.parse(entry.endsAt) <= now());
    if (!item) return false;
    // Persist before dispatch: overlapping scans, failed sends and restarts never replay.
    item.reminded = true;
    item.status = 'finished';
    const stashReply = finishFocusStash(item);
    save(state);
    await deliver(`专注已结束。${item.goal ? `结束提醒你：${item.goal}` : '辛苦了，休息一下吧。'}${stashReply}`, `focus-session-${item.id}`);
    return true;
  }
  const handleStash = createFocusStashCommands({ load, save, now, todos });
  return { handle, tick, handleStash };
}

module.exports = { createFocusSessionStore };
