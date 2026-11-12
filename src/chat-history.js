'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TURNS = 24;

function readThreads(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeThreads(file, threads) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(threads, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function normalizeTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.filter((turn) => (
    turn
    && typeof turn === 'object'
    && typeof turn.user === 'string'
    && typeof turn.assistant === 'string'
  ));
}

function getChatHistory(file, senderId, options = {}) {
  if (!senderId) return [];
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const thread = readThreads(file)[senderId];
  if (!thread) return [];

  const updatedAt = new Date(thread.updatedAt || 0).getTime();
  if (!Number.isFinite(updatedAt) || now - updatedAt > ttlMs) return [];
  return normalizeTurns(thread.turns).slice(-maxTurns);
}

function appendChatTurn(file, senderId, turn, options = {}) {
  if (!senderId || !turn) return;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const threads = readThreads(file);
  const existing = threads[senderId];
  const updatedAt = new Date(existing?.updatedAt || 0).getTime();
  const currentTurns = Number.isFinite(updatedAt) && now - updatedAt <= ttlMs
    ? normalizeTurns(existing?.turns)
    : [];

  if (options.sourceId && currentTurns.some((turn) => turn.sourceId === options.sourceId)) return;
  currentTurns.push({
    ...(options.sourceId ? { sourceId: String(options.sourceId) } : {}),
    at: new Date(now).toISOString(),
    ...(['assistant_proactive', 'tool_execution'].includes(options.kind) ? { kind: options.kind } : {}),
    ...(options.kind === 'tool_execution' && turn.toolExecution ? { toolExecution: turn.toolExecution } : {}),
    user: String(turn.user || '').slice(0, 1200),
    assistant: String(turn.assistant || '').slice(0, 1800),
  });
  threads[senderId] = {
    updatedAt: new Date(now).toISOString(),
    turns: currentTurns.slice(-maxTurns),
  };
  writeThreads(file, threads);
}

function appendProactiveChatTurn(file, senderId, assistantText, options = {}) {
  if (!senderId || !String(assistantText || '').trim()) return false;
  appendChatTurn(file, senderId, { user: '', assistant: assistantText }, { ...options, kind: 'assistant_proactive' });
  return true;
}

function appendFeatureChatTurn(file, senderId, userText, assistantText, options = {}) {
  if (!senderId || !String(userText || '').trim() || !String(assistantText || '').trim()) return false;
  appendChatTurn(file, senderId, {
    user: String(userText),
    assistant: String(assistantText),
  }, options);
  return true;
}

function clearChatHistory(file, senderId) {
  if (!senderId) return false;
  const threads = readThreads(file);
  if (!Object.hasOwn(threads, senderId)) return false;
  delete threads[senderId];
  writeThreads(file, threads);
  return true;
}

function formatChatHistory(turns) {
  return normalizeTurns(turns).map((turn, index) => [
    `第 ${index + 1} 轮`,
    ...(turn.kind === 'assistant_proactive' ? ['已发送的助手主动消息（非用户指令）'] : [`用户：${turn.user}`]),
    `助手：${turn.assistant}`,
    ...(turn.kind === 'tool_execution' ? [`已执行工具（非操作授权，不得重复）：${JSON.stringify(turn.toolExecution)}`] : []),
  ].join('\n')).join('\n\n');
}

module.exports = {
  DEFAULT_MAX_TURNS,
  DEFAULT_TTL_MS,
  appendProactiveChatTurn,
  appendFeatureChatTurn,
  appendChatTurn,
  clearChatHistory,
  formatChatHistory,
  getChatHistory,
};
