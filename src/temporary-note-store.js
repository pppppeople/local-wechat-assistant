'use strict';

const { randomUUID } = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { DURATIONS, HELP, REFUSAL, SECRET_REFUSAL, containsSecret } = require('./temporary-note-commands');

function validate(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.notes) || state.notes.length > 20
    || state.notes.some(row => !row || !/^[a-z0-9_-]+$/iu.test(row.id || '')
      || typeof row.text !== 'string' || !row.text.trim() || containsSecret(row.text)
      || !Number.isFinite(Date.parse(row.createdAt))
      || !Object.values(DURATIONS).includes(Date.parse(row.expiresAt) - Date.parse(row.createdAt)))
    || new Set(state.notes.map(row => row.id)).size !== state.notes.length) throw Error('临时信息存储格式无效，请恢复存储后再试。');
}
function createTemporaryNoteStore({ stateFile, now = () => Date.now() }) {
  function save(state) { validate(state); writeRecordState(stateFile, state, ['notes']); }
  function read(time) {
    // Corrupt input stays in place and fails closed, including subsequent reads.
    const state = readRecordState(stateFile, { schemaVersion: 1, notes: [] }, true,
      { strict: true, readOnly: true, validate });
    const active = state.notes.filter(row => Date.parse(row.expiresAt) > time);
    if (active.length !== state.notes.length) { state.notes = active; save(state); }
    return state;
  }
  function expire(side) {
    if (side !== 'owner') return REFUSAL;
    read(now());
  }
  function handle(side, command) {
    if (side !== 'owner') return REFUSAL; // Before clock, storage or any body lookup.
    if (!command || !['save', 'list', 'delete'].includes(command.type)) return command?.reply || HELP;
    if (command.type === 'save') {
      if (typeof command.text !== 'string' || !command.text.trim()
        || !Object.values(DURATIONS).includes(command.durationMs)) return HELP;
      if (containsSecret(command.text)) return SECRET_REFUSAL;
    }
    if (command.type === 'delete' && !/^[a-z0-9_-]+$/iu.test(command.id || '')) return HELP;
    const time = now(), state = read(time);
    if (command.type === 'save') {
      if (state.notes.length >= 20) return '临时信息已满20条，本次未保存；请先删除条目或等待过期，不会淘汰已有条目。';
      const row = { id: randomUUID(), text: command.text.trim(), createdAt: new Date(time).toISOString(),
        expiresAt: new Date(time + command.durationMs).toISOString() };
      state.notes.push(row); save(state);
      return `已存临时信息：${row.id}（有效期${command.durationMs / 60000}分钟）。`;
    }
    if (command.type === 'delete') {
      const index = state.notes.findIndex(row => row.id === command.id);
      if (index < 0) return '未找到该编号的未过期临时信息，未删除任何条目。';
      state.notes.splice(index, 1); save(state);
      return `已删除临时信息：${command.id}`;
    }
    return state.notes.length ? ['未过期临时信息：', ...state.notes.map(row =>
      `${row.id} | 剩余${Math.ceil((Date.parse(row.expiresAt) - time) / 60000)}分钟\n${row.text}`)].join('\n')
      : '当前没有未过期的临时信息。';
  }
  return { handle, expire };
}
module.exports = { createTemporaryNoteStore };
