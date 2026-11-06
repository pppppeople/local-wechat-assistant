'use strict';

const { splitParagraphs } = require('./meeting-minutes-provider');
const USAGE = '用法：整理会议纪要：<粘贴的会议转写文本>，也可用空格分隔。仅支持粘贴纯文本。';
const FAILURE = '会议纪要整理失败，本次结果整次作废，未保存文件或创建待办、任务。请重新粘贴后再试。';
function parseMeetingMinutesCommand(text) {
  const value = String(text || '').trim();
  if (value === '整理会议纪要') return { type: 'organize', text: '' };
  const match = value.match(/^整理会议纪要(?:[：:]\s*|\s+)([\s\S]*)$/u);
  return match ? { type: 'organize', text: match[1] } : null;
}
function formatMinutes(value, text) {
  const refs = row => `（依据：${row.sources.map(n => `段落 ${n}`).join('、')}）`;
  const used = new Set([...value.conclusions, ...value.actions].flatMap(row => row.sources));
  return ['会议纪要（模型整理，请核对原文）', `会议主题：${value.topic}`,
    `结论要点：\n${value.conclusions.map((row, i) => `${i + 1}. ${row.text}${refs(row)}`).join('\n') || '暂无'}`,
    `待办事项：\n${value.actions.map((row, i) => `${i + 1}. ${row.text}｜负责人：${row.owner}｜截止时间：${row.deadline}${refs(row)}`).join('\n') || '暂无'}`,
    `原文依据：\n${splitParagraphs(text).filter(row => used.has(row.number)).map(row => `段落 ${row.number}：${row.text}`).join('\n') || '暂无引用段落'}`,
  ].join('\n\n');
}
function createMeetingMinutesCommands({ provider }) {
  return { async execute(side, command, { hasMedia = false } = {}) {
    if (side !== 'owner') return { reply: '这个私人助手只供已绑定的本人使用。', wrote: false };
    if (hasMedia || !command?.text?.trim()) return { reply: USAGE, wrote: false };
    try {
      const value = await provider.organize({ text: command.text });
      return { reply: formatMinutes(value, command.text), wrote: false };
    } catch { return { reply: FAILURE, wrote: false }; }
  } };
}

module.exports = { USAGE, FAILURE, parseMeetingMinutesCommand, createMeetingMinutesCommands };
