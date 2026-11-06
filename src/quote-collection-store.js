'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { HELP, REFUSAL } = require('./quote-collection-commands');
const hasText = value => typeof value === 'string' && Boolean(value.trim());
function validate(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.quotes) || state.quotes.length > 300
    || state.quotes.some(row => !row || !/^[a-z0-9_-]+$/iu.test(row.id || '')
      || !hasText(row.body) || typeof row.source !== 'string' || typeof row.time !== 'string'
      || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(state.quotes.map(row => row.id)).size !== state.quotes.length
    || new Set(state.quotes.map(row => row.body)).size !== state.quotes.length) throw Error('摘录收藏存储格式无效');
}
function display(row) {
  return `编号：${row.id}${row.source ? `\n来源：${row.source}` : ''}${row.time ? `\n时间：${row.time}` : ''}\n原文：\n${row.body}`;
}
function createQuoteCollectionStore({ stateFile, now = () => Date.now(), random = Math.random }) {
  function execute(side, command) {
    // Admission must precede any filesystem access, including corruption checks.
    if (side !== 'owner') return refused(REFUSAL);
    if (!command || !['save', 'search', 'random', 'delete'].includes(command.type)
      || command.type === 'save' && (!hasText(command.body)
        || command.source !== undefined && typeof command.source !== 'string'
        || command.time !== undefined && typeof command.time !== 'string')
      || command.type === 'search' && !hasText(command.keyword)
      || command.type === 'delete' && !/^[a-z0-9_-]+$/iu.test(command.id || '')) return refused(HELP);
    if (!fs.existsSync(stateFile) && fs.existsSync(path.dirname(stateFile))
      && fs.readdirSync(path.dirname(stateFile)).some(name => name.startsWith(`${path.basename(stateFile)}.corrupt-`))) {
      throw Error('摘录收藏存储已隔离，请先恢复索引及正文。');
    }
    const state = readRecordState(stateFile, { schemaVersion: 1, quotes: [] }, true, { strict: true, now, validate });
    const save = () => { validate(state); writeRecordState(stateFile, state, ['quotes']); };
    if (command.type === 'save') {
      const existing = state.quotes.find(row => row.body === command.body);
      if (existing) return refused(`该摘录已存在，编号：${existing.id}；未重复保存。`);
      if (state.quotes.length >= 300) return refused('摘录收藏夹最多 300 条，已满额，本次未保存；请先删除不需要的摘录。');
      const row = { id: crypto.randomUUID(), body: command.body, source: command.source || '',
        time: command.time || '', createdAt: new Date(now()).toISOString() };
      state.quotes.push(row); save(); return changed(`已保存摘录，编号：${row.id}`);
    }
    if (command.type === 'delete') {
      const index = state.quotes.findIndex(row => row.id === command.id);
      if (index < 0) return refused('摘录编号不存在，未删除任何条目。');
      state.quotes.splice(index, 1); save(); return changed(`已删除摘录，编号：${command.id}`);
    }
    if (!state.quotes.length) return unchanged('摘录收藏夹暂无摘录。');
    if (command.type === 'random') return unchanged(display(state.quotes[Math.floor(random() * state.quotes.length)]));
    const keyword = command.keyword.toLocaleLowerCase();
    const rows = state.quotes.filter(row => [row.body, row.source, row.time].some(value => value.toLocaleLowerCase().includes(keyword)));
    return unchanged(rows.length ? `找到 ${rows.length} 条摘录：\n${rows.map(display).join('\n\n')}` : '未找到匹配的摘录。');
  }
  return { execute };
}
module.exports = { createQuoteCollectionStore };
