'use strict';

const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { STYLES, HELP } = require('./message-polish-commands');
function validateState(state) {
  if (state?.schemaVersion !== 1 || !STYLES.includes(state.style)) throw Error('润色风格存储格式无效');
}
function createMessagePolishStore({ stateFile, provider }) {
  // Only the preference is durable; one original and its latest draft stay volatile.
  let context = null;
  let generation = 0;
  let pending = Promise.resolve();
  function load() {
    return readRecordState(stateFile, { schemaVersion: 1, style: '默认' }, true,
      { strict: true, validate: validateState });
  }
  async function apply(command, admitted) {
    const state = load();
    if (command.type === 'style') {
      if (!command.style) return unchanged(`当前润色风格：${state.style}。可选：${STYLES.join(' / ')}。`);
      if (!STYLES.includes(command.style)) return refused(`请选择润色风格：${STYLES.join(' / ')}。`);
      writeRecordState(stateFile, { schemaVersion: 1, style: command.style }, []);
      return changed(`润色风格已切换为：${command.style}。`);
    }
    if (command.type === 'polish' && (typeof command.text !== 'string' || !command.text.trim())) {
      return refused('润色原文不能为空。' + HELP);
    }
    if (command.type === 'refine' && !context) return refused('当前没有润色草稿。' + HELP);
    if (command.type === 'refine' && (typeof command.instruction !== 'string' || !command.instruction.trim())) {
      return refused('请说明如何修改上一稿，例如“再简洁一点”。');
    }
    const data = command.type === 'polish'
      ? { style: state.style, original: command.text }
      : { style: state.style, original: context.original, previousDraft: context.draft, instruction: command.instruction };
    try {
      const draft = await provider.polish(data);
      if (admitted !== generation) return null;
      if (typeof draft !== 'string' || !draft.trim()) throw Error('empty polish draft');
      context = { original: data.original, draft: draft.trim() };
      return changed(context.draft);
    } catch {
      if (admitted !== generation) return null;
      return refused('这次润色模型调用失败，未生成草稿；原有润色上下文已保留，请重发本次指令重试。');
    }
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command || !['polish', 'refine', 'style', 'clear'].includes(command.type)) return Promise.resolve(refused(HELP));
    // Clear immediately, including in-flight and queued model work. Preference is untouched.
    if (command.type === 'clear') {
      context = null;
      generation++;
      return Promise.resolve(changed('润色上下文与临时草稿已清除，风格偏好保留。'));
    }
    const admitted = generation;
    const result = pending.then(() => admitted === generation ? apply(command, admitted) : null);
    pending = result.catch(() => {});
    return result;
  }
  return { execute };
}

module.exports = { createMessagePolishStore };
