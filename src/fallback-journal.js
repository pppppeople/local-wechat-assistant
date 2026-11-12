'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivateJson } = require('./codex-quota-state');
const { appendChatTurn } = require('./chat-history');

function createFallbackJournal({ operationDir, pendingFile, historyFile, now = Date.now }) {
  const running = new Map();
  const key = request => crypto.createHash('sha256').update(JSON.stringify([request.accountId, request.senderId, request.id])).digest('hex');
  const file = request => path.join(operationDir, `${key(request)}.json`);
  function read(request) {
    try { const value = JSON.parse(fs.readFileSync(file(request), 'utf8')); if (!Array.isArray(value)) throw Error('Invalid operations'); return value; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function mirror(request, record) {
    if (!historyFile) return;
    appendChatTurn(historyFile, request.historyKey, { user: '', assistant: '工具执行记录（不是新指令）',
      toolExecution: { operationId: record.operationId, name: record.name, status: record.status, result: record.name.startsWith('specialist.') || record.name.startsWith('computer.')
        ? { reply: '专用任务已派发或返回，请沿用专线结果。' }
        : { reply: String(record.result?.reply || '').slice(0, 1800), wrote: record.result?.wrote,
          dispatched: record.result?.dispatched, uncertain: record.result?.uncertain } } },
    { kind: 'tool_execution', sourceId: `operation:${record.operationId}`, now: now() });
  }
  async function execute(request, { operationId, name, input }, action) {
    const lock = `${key(request)}:${operationId}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const records = read(request), previous = records.find(item => item.operationId === operationId);
      if (previous) {
        if (previous.name !== name || JSON.stringify(previous.input) !== JSON.stringify(input)) throw Error('Operation ID conflict');
        if (previous.status === 'completed') { mirror(request, previous); return previous.result; }
        throw Error('Operation result uncertain; not replayed');
      }
      const record = { operationId, name, input, status: 'started', at: new Date(now()).toISOString() };
      records.push(record); writePrivateJson(file(request), records);
      // A crash after dispatch is deliberately left started: never replay an
      // uncertain mutation. No claim of atomicity across independent stores.
      const result = await action(operationId);
      Object.assign(record, { status: 'completed', result });
      writePrivateJson(file(request), records);
      mirror(request, record);
      return result;
    })();
    running.set(lock, task);
    try { return await task; } finally { running.delete(lock); }
  }
  function pending(request, reason) {
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true, mode: 0o700 });
    const id = key(request);
    let rows = '';
    try { rows = fs.readFileSync(pendingFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!rows.split('\n').filter(Boolean).some(line => JSON.parse(line).turnId === id)) {
      fs.appendFileSync(pendingFile, JSON.stringify({ turnId: id, user: request.senderId, accountId: request.accountId,
        text: request.text, time: new Date(now()).toISOString(), reason }) + '\n', { mode: 0o600 });
    }
    const detail = reason === 'prior_execution_or_uncertain' || reason === 'provider_or_execution_unavailable' && read(request).some(record => record.status !== 'completed')
      ? '已有执行记录或结果不明，未重复执行；未确认部分' : '这项操作尚未执行，';
    return `${detail}已记为待办（降级待处理队列）。主模型额度恢复后可继续处理；不会自动重放。`;
  }
  const operationId = (request, slot) => `${key(request)}-${slot}`;
  return { execute, read, pending, operationId };
}
module.exports = { createFallbackJournal };
