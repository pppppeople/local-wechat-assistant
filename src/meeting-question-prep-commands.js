'use strict';

const { validatePrep } = require('./meeting-question-prep-provider');
const USAGE = '请提供会议主题或背景：会议问题准备：<会议主题/背景>。仅支持粘贴纯文本，背景不能为空。';
const FAILURE = '会议问题准备失败，本次未生成清单，请重新提供主题和背景后再试。';
const REFUSAL = '会议问题准备仅主人可用，好友不能使用此功能。';
function parseMeetingQuestionPrepCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^会议问题准备(?:[：:]\s*|$)([\s\S]*)$/u);
  return match ? { type: 'prepare', text: match[1].trim() } : null;
}
function createMeetingQuestionPrepCommands({ provider }) {
  return { async execute(side, command, { hasMedia = false } = {}) {
    if (side !== 'owner') return { reply: REFUSAL, wrote: false };
    if (hasMedia || !command?.text?.trim()) return { reply: USAGE, wrote: false };
    try {
      const value = validatePrep(await provider.prepare({ text: command.text.trim() }));
      const list = rows => rows.map((text, i) => `${i + 1}. ${text}`).join('\n');
      return { reply: [
        `核心问题：${value.questions.length > 8 ? '（已截断至 8 问）' : ''}\n${list(value.questions.slice(0, 8))}`,
        `期望确认结果：\n${list(value.expectedResults)}`,
        `会后行动检查：\n${list(value.actionChecks)}`,
      ].join('\n\n'), wrote: false };
    } catch { return { reply: FAILURE, wrote: false }; }
  } };
}

module.exports = { USAGE, FAILURE, REFUSAL, parseMeetingQuestionPrepCommand, createMeetingQuestionPrepCommands };
