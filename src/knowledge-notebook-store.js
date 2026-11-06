'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged, resultText } = require('./feature-result');
const { shanghaiDay } = require('./personal-todo-commands');
const { HELP } = require('./knowledge-notebook-commands');

const hasText = value => typeof value === 'string' && Boolean(value.trim());
const validTags = tags => Array.isArray(tags) && tags.every(hasText);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const latest = row => row.updatedAt || row.createdAt;
const newestFirst = (a, b) => Date.parse(latest(b)) - Date.parse(latest(a));
function dates(row) {
  return `记录日期：${shanghaiDay(row.createdAt)}${row.updatedAt ? `｜更新日期：${shanghaiDay(row.updatedAt)}` : ''}`;
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.entries) || state.entries.length > 300
    || state.entries.some(row => !row || typeof row.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(row.id)
      || !hasText(row.title) || !hasText(row.content) || !validTags(row.tags) || !validTime(row.createdAt)
      || row.updatedAt !== undefined && !validTime(row.updatedAt))
    || new Set(state.entries.map(row => row.id)).size !== state.entries.length
    || new Set(state.entries.map(row => row.title)).size !== state.entries.length) throw Error('知识问答本存储格式无效');
}

function createKnowledgeNotebookStore({ stateFile, now = () => Date.now() }) {
  const batch = require('./knowledge-notebook-batch').createKnowledgeNotebookBatch({
    readEntries: () => readEntries('owner'), add: command => execute('owner', command), validTags,
  });
  function execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type?.startsWith('batch-')) return batch(command);
    if (!command || !['add', 'search', 'list', 'delete', 'update'].includes(command.type)) return refused(HELP);
    const { type } = command;
    if (['add', 'delete', 'update'].includes(type) && !hasText(command.title)
      || ['add', 'update'].includes(type) && !hasText(command.content)
      || type === 'add' && command.tags !== undefined && !validTags(command.tags)
      || type === 'search' && !hasText(command.keyword)) return refused(HELP);
    const state = readRecordState(stateFile, { schemaVersion: 1, entries: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['entries']); };
    if (type === 'list') {
      const rows = state.entries.slice().sort(newestFirst).slice(0, 20);
      return unchanged([`知识列表：共 ${state.entries.length} 条（最多列出 20 条）`,
        ...rows.map(row => `${row.title}｜标签：${row.tags.join('、') || '无'}｜${dates(row)}`),
        ...(!rows.length ? ['暂无知识条目。'] : [])].join('\n'));
    }
    if (type === 'search') {
      const keyword = command.keyword.trim().toLocaleLowerCase();
      const titleHit = row => row.title.toLocaleLowerCase().includes(keyword);
      const rows = state.entries.filter(row => [row.title, row.content, ...row.tags]
        .some(value => value.toLocaleLowerCase().includes(keyword)))
        .sort((a, b) => Number(titleHit(b)) - Number(titleHit(a)) || newestFirst(a, b)).slice(0, 5);
      return unchanged(rows.length ? rows.map(row => `${row.title}\n${row.content}\n${dates(row)}`).join('\n\n') : '没有找到相关知识');
    }
    const title = command.title.trim();
    const row = state.entries.find(entry => entry.title === title);
    if (type === 'add') {
      if (row) return refused('已存在同名条目，请先改名或删旧，不会覆盖。');
      if (state.entries.length >= 300) return refused('知识问答本已达 300 条上限，请先删旧再新增。');
      state.entries.push({ id: crypto.randomUUID(), title, content: command.content,
        tags: command.tags || [], createdAt: new Date(now()).toISOString() });
      save();
      return changed(`已保存知识：${title}`);
    }
    if (!row) return refused(`不存在标题为「${title}」的知识条目。`);
    if (type === 'delete') {
      state.entries = state.entries.filter(entry => entry !== row); save();
      return changed(`已删除知识：${title}`);
    }
    row.content = command.content;
    row.updatedAt = new Date(now()).toISOString(); save();
    return changed(`已更新知识：${title}｜${dates(row)}`);
  }
  function readEntries(side) {
    if (side !== 'owner') throw Error('这个私人助手只供已绑定的本人使用。');
    return readRecordState(stateFile, { schemaVersion: 1, entries: [] }, false,
      { strict: true, readOnly: true, now, validate: validateState }).entries;
  }
  return { readEntries, execute, handle: (side, command) => resultText(execute(side, command)) };
}

module.exports = { createKnowledgeNotebookStore };
