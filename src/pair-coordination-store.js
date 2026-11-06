'use strict';

const crypto = require('crypto');
const { changed, refused, resultText } = require('./feature-result');
const { readRecordState, writeRecordState } = require('./record-state');

const MAX_MANUAL_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function validSide(side) { if (!['owner', 'friend'].includes(side)) throw new Error('invalid coordination side'); return side; }
function otherSide(side) { return validSide(side) === 'owner' ? 'friend' : 'owner'; }
function id() { return `AV-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase(); }
function dateText(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));
}
function subtract(windows, blocks) {
  let current = windows;
  for (const block of blocks) {
    current = current.flatMap((window) => {
      if (block.endAt <= window.startAt || block.startAt >= window.endAt) return [window];
      const result = [];
      if (block.startAt > window.startAt) result.push({ startAt: window.startAt, endAt: block.startAt });
      if (block.endAt < window.endAt) result.push({ startAt: block.endAt, endAt: window.endAt });
      return result;
    });
  }
  return current.filter((window) => window.endAt - window.startAt >= 30 * 60 * 1000);
}

function merge(windows) {
  const ordered = windows.slice().sort((left, right) => left.startAt - right.startAt || left.endAt - right.endAt);
  const merged = [];
  for (const window of ordered) {
    const previous = merged.at(-1);
    if (previous && window.startAt <= previous.endAt) previous.endAt = Math.max(previous.endAt, window.endAt);
    else merged.push({ startAt: window.startAt, endAt: window.endAt });
  }
  return merged;
}

function createPairCoordinationStore({ stateFile, now = () => Date.now(), calendarBusy = async () => [], sideNames = { owner: 'Owner', friend: '好友' } }) {
  function load() {
    const state = readRecordState(stateFile, { schemaVersion: 1, availability: [], busy: {} });
    state.schemaVersion = 1;
    state.availability = (Array.isArray(state.availability) ? state.availability : []).filter((entry) => entry.endAt > now() - 60 * 60 * 1000);
    state.busy = state.busy && typeof state.busy === 'object' ? state.busy : {};
    for (const side of ['owner', 'friend']) if (state.busy[side]?.endAt <= now()) delete state.busy[side];
    return state;
  }
  function save(state) { writeRecordState(stateFile, state, ['availability']); }
  function addAvailability(side, command) {
    validSide(side);
    const window = command.window || {};
    if (!Number.isFinite(window.startAt) || !Number.isFinite(window.endAt) || window.endAt <= window.startAt) throw new Error('没有看懂这段时间');
    if (window.endAt - window.startAt > MAX_MANUAL_WINDOW_MS) throw new Error('一次报备最多覆盖 31 天');
    const state = load();
    const entry = { id: id(), side, availability: command.availability === 'unavailable' ? 'unavailable' : 'available', startAt: window.startAt, endAt: window.endAt, label: String(window.label || '').slice(0, 40), source: 'wechat_manual', createdAt: new Date(now()).toISOString() };
    state.availability.push(entry); save(state);
    return `记下了：${dateText(entry.startAt)} 到 ${dateText(entry.endAt)}，你${entry.availability === 'available' ? '有空' : '不方便'}。编号 #${entry.id}。`;
  }
  function listAvailability(side) {
    validSide(side); const state = load(); save(state);
    const entries = state.availability.filter((entry) => entry.side === side).slice(-12);
    if (!entries.length) return '你还没有报备空闲时间。';
    return ['你报备的时间：', ...entries.map((entry) => `• #${entry.id}｜${dateText(entry.startAt)}－${dateText(entry.endAt)}｜${entry.availability === 'available' ? '有空' : '不方便'}`)].join('\n');
  }
  function removeAvailabilityResult(side, query, window = null) {
    validSide(side); const state = load(); const value = String(query || '').trim().toUpperCase().replace(/^#/, '');
    const byId = /^AV-/u.test(value);
    const candidates = state.availability.filter((entry) => entry.side === side && (byId ? entry.id === value : (entry.id === value
      || `${entry.label}${dateText(entry.startAt)}`.includes(query)
      || (window && entry.startAt < window.endAt && entry.endAt > window.startAt))));
    if (candidates.length !== 1) return refused(candidates.length ? '对应到多条时间，请带编号删除。' : '没有找到这条空闲记录。');
    state.availability = state.availability.filter((entry) => entry.id !== candidates[0].id); save(state);
    return changed(`已经删除 #${candidates[0].id} 这条时间记录。`);
  }
  function removeAvailability(side, query, window = null) { return resultText(removeAvailabilityResult(side, query, window)); }
  async function matchAvailability(side, window) {
    validSide(side); const state = load(); save(state);
    const range = window || { startAt: now(), endAt: now() + 7 * 24 * 60 * 60 * 1000, label: '未来七天' };
    const bySide = {};
    let calendarUnavailable = false;
    for (const target of ['owner', 'friend']) {
      const available = state.availability.filter((entry) => entry.side === target && entry.availability === 'available' && entry.endAt > range.startAt && entry.startAt < range.endAt).map((entry) => ({ startAt: Math.max(entry.startAt, range.startAt), endAt: Math.min(entry.endAt, range.endAt) }));
      const unavailable = state.availability.filter((entry) => entry.side === target && entry.availability === 'unavailable').map((entry) => ({ startAt: entry.startAt, endAt: entry.endAt }));
      let calendar = [];
      if (target === 'owner' && calendarBusy.enabled !== false) {
        try { calendar = await calendarBusy(range.startAt, range.endAt); } catch { calendarUnavailable = true; }
      }
      bySide[target] = merge(subtract(merge(available), [...unavailable, ...calendar]));
    }
    const missing = ['owner', 'friend'].filter((target) => !bySide[target].length);
    if (missing.length) return `暂时算不出共同空闲：还需要${missing.map((target) => sideNames[target]).join('和')}报备这段时间的空闲。`;
    const common = [];
    for (const owner of bySide.owner) for (const friend of bySide.friend) {
      const startAt = Math.max(owner.startAt, friend.startAt); const endAt = Math.min(owner.endAt, friend.endAt);
      if (endAt - startAt >= 30 * 60 * 1000) common.push({ startAt, endAt });
    }
    const mergedCommon = merge(common);
    if (!mergedCommon.length) return `${range.label || '这段时间'}暂时没有共同空闲。双方各自的完整安排不会公开，可以分别再补充或调整一段时间。${calendarUnavailable ? '\nOwner 的 Apple 日历这次没有读到，因此没有把日历忙碌时间算进去。' : ''}`;
    return [`${range.label || '这段时间'}你们共同有空：`, ...mergedCommon.slice(0, 8).map((entry, index) => `${index + 1}. ${dateText(entry.startAt)}－${dateText(entry.endAt)}`), '这里只显示交集，不显示任何一方的完整安排。', ...(calendarUnavailable ? ['Owner 的 Apple 日历这次没有读到，因此没有把日历忙碌时间算进去。'] : [])].join('\n');
  }
  function setBusy(side, command) {
    validSide(side); const state = load(); const endAt = Number(command.endAt);
    if (!Number.isFinite(endAt) || endAt <= now()) throw new Error('忙碌结束时间需要在未来');
    state.busy[side] = { endAt, publicReason: String(command.publicReason || '').slice(0, 80), updatedAt: new Date(now()).toISOString() }; save(state);
    return `好，已经标记你忙到 ${dateText(endAt)}。消息仍会照常送达，对方发消息时会看到你可能在忙。`;
  }
  function clearBusy(side) { validSide(side); const state = load(); delete state.busy[side]; save(state); return '忙碌状态已经解除。'; }
  function busyStatus(requestingSide, target = 'peer') {
    validSide(requestingSide); const state = load(); save(state); const targetSide = target === 'self' ? requestingSide : otherSide(requestingSide); const value = state.busy[targetSide];
    if (!value) return `${targetSide === requestingSide ? '你' : sideNames[targetSide]}现在没有设置忙碌状态。`;
    return `${targetSide === requestingSide ? '你' : sideNames[targetSide]}可能正忙到 ${dateText(value.endAt)}${value.publicReason ? `（${value.publicReason}）` : ''}，但消息仍会正常送达。`;
  }
  function peerBusyHint(side) { const state = load(); save(state); const value = state.busy[otherSide(side)]; return value ? `顺带提醒：${sideNames[otherSide(side)]}可能正忙到 ${dateText(value.endAt)}，不过消息仍会照常发送，不会被拦住。` : ''; }
  function deleteSide(side) { validSide(side); const state = load(); const removed = state.availability.filter((entry) => entry.side === side).length; state.availability = state.availability.filter((entry) => entry.side !== side); delete state.busy[side]; save(state); return { availability: removed, busy: true }; }
  return { addAvailability, busyStatus, clearBusy, deleteSide, listAvailability, matchAvailability, peerBusyHint, removeAvailability, removeAvailabilityResult, setBusy };
}

module.exports = { createPairCoordinationStore, merge, subtract };
