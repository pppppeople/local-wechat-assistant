'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { HELP } = require('./character-card-commands');

const MAX_CARDS = 20;
const hasText = value => typeof value === 'string' && Boolean(value.trim());
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.cards) || state.cards.length > MAX_CARDS
    || state.cards.some(row => !row || typeof row.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(row.id)
      || !hasText(row.name) || row.name !== row.name.trim() || !hasText(row.description)
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(state.cards.map(row => row.id)).size !== state.cards.length
    || new Set(state.cards.map(row => row.name)).size !== state.cards.length) throw Error('角色卡存储格式无效');
}

function createCharacterCardStore({ stateFile, storyChain, now = () => Date.now() }) {
  function execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['add', 'view', 'list', 'update', 'delete', 'start'].includes(command.type)) return refused(HELP);
    const { type } = command;
    if (type !== 'list' && !hasText(command.name)
      || ['add', 'update'].includes(type) && !hasText(command.description)
      || type === 'update' && !hasText(command.newName)) return refused(HELP);
    const state = readRecordState(stateFile, { schemaVersion: 1, cards: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['cards']); };
    if (type === 'list') return unchanged([`角色卡列表：共 ${state.cards.length} 张（上限 ${MAX_CARDS} 张）`,
      ...state.cards.map(row => row.name), ...(!state.cards.length ? ['暂无角色卡。'] : [])].join('\n'));
    const name = command.name.trim();
    const row = state.cards.find(card => card.name === name);
    if (type === 'add') {
      if (row) return refused('已存在同名角色卡，不会覆盖，请换名新建或修改原卡。');
      if (state.cards.length >= MAX_CARDS) return refused(`角色卡已达 ${MAX_CARDS} 张上限，无法新增；已有角色卡保留。`);
      state.cards.push({ id: crypto.randomUUID(), name, description: command.description.trim(), createdAt: new Date(now()).toISOString() });
      save(); return changed(`已新建角色卡：${name}`);
    }
    if (!row) return refused(`不存在名为「${name}」的角色卡，请先新建。`);
    if (type === 'view') return unchanged(`角色卡：${row.name}\n设定描述：${row.description}`);
    // Pass a snapshot only to this story session; card edits never alter a running story.
    if (type === 'start') return storyChain.execute('owner', { type: 'start', setting: `角色名字：${row.name}\n设定描述：${row.description}` });
    if (type === 'delete') {
      state.cards = state.cards.filter(card => card !== row); save();
      return changed(`已删除角色卡：${name}`);
    }
    const newName = command.newName.trim();
    if (state.cards.some(card => card !== row && card.name === newName)) return refused('已存在同名角色卡，不能修改为该名字。');
    row.name = newName; row.description = command.description.trim(); save();
    return changed(`已修改角色卡：${newName}`);
  }
  return { execute };
}

module.exports = { createCharacterCardStore };
