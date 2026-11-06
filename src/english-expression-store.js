'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { HELP } = require('./english-expression-commands');
const hasText = value => typeof value === 'string' && Boolean(value.trim());
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.expressions)
    || state.expressions.some(row => !row || !/^[a-z0-9_-]+$/iu.test(row.id || '')
      || !hasText(row.original) || !hasText(row.suggested) || !hasText(row.scene)
      || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(state.expressions.map(row => row.id)).size !== state.expressions.length
    || new Set(state.expressions.map(row => JSON.stringify([row.original, row.suggested]))).size !== state.expressions.length) {
    throw Error('英语表达收藏存储格式无效');
  }
}
function createEnglishExpressionStore({ stateFile, meetingSimulator, now = () => Date.now() }) {
  function execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['add', 'list', 'delete'].includes(command.type)) return refused(HELP);
    let selection;
    if (command.type === 'add') {
      if (!Number.isSafeInteger(command.number) || command.number < 1) return refused(HELP);
      selection = meetingSimulator.getExpression('owner', command.number);
      if (!selection.entry) return refused(selection.reply);
    }
    if (command.type === 'delete' && !/^[a-z0-9_-]+$/iu.test(command.id || '')) return refused(HELP);
    const state = readRecordState(stateFile, { schemaVersion: 1, expressions: [] }, true,
      { strict: true, now, validate: validateState });
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['expressions']); };
    if (command.type === 'list') return unchanged([`表达收藏列表：共 ${state.expressions.length} 条`,
      ...state.expressions.map(row => `ID：${row.id}\n场景：${row.scene}\n${row.original} → ${row.suggested}`),
      ...(!state.expressions.length ? ['暂无收藏。'] : [])].join('\n'));
    if (command.type === 'add') {
      const { original, suggested, scene } = selection.entry;
      if (state.expressions.some(row => row.original === original && row.suggested === suggested)) return unchanged('这条表达已收藏，不会重复保存。');
      const row = { id: crypto.randomUUID(), original, suggested, scene, createdAt: new Date(now()).toISOString() };
      state.expressions.push(row); save();
      return changed(`已收藏表达，ID：${row.id}\n场景：${scene}\n${original} → ${suggested}`);
    }
    if (!state.expressions.some(row => row.id === command.id)) return refused('未找到这个收藏ID，请查看“表达收藏列表”。');
    state.expressions = state.expressions.filter(row => row.id !== command.id); save();
    return changed('已删除这条表达收藏。');
  }
  return { execute };
}
module.exports = { createEnglishExpressionStore };
