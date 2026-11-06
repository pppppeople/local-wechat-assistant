'use strict';

const USAGE = '用法：提取待确认事项：<粘贴的邮件线程文本>。首版仅处理粘贴文本，不连接邮箱。';
const FAILURE = '邮件线程提取失败，本次结果整次作废，未保存或发送任何邮件。请重新粘贴后再试。';
function parseEmailThreadCommand(text) {
  const value = String(text || '').trim();
  if (value === '提取待确认事项') return { type: 'extract', text: '' };
  const match = value.match(/^提取待确认事项[：:]\s*([\s\S]*)$/u);
  return match ? { type: 'extract', text: match[1] } : null;
}
function formatExtraction(value) {
  return ['邮件线程事项（模型分类，请核对原文；段落按粘贴文本的非空行编号）',
    ...[['answered', '已答事项'], ['unanswered', '未答事项'], ['uncertain', '待确认事项']].map(([key, title]) =>
      `${title}：\n${value[key].length ? value[key].map((row, i) =>
        `${i + 1}. ${row.text}（来源：${row.sources.length ? row.sources.map(n => `段落 ${n}`).join('、') : '待确认，无法归属'}）`).join('\n') : '无'}`),
  ].join('\n\n');
}
function createEmailThreadCommands({ provider }) {
  return { async execute(side, command) {
    if (side !== 'owner') return { reply: '这个私人助手只供已绑定的本人使用。', wrote: false };
    if (!command?.text?.trim()) return { reply: USAGE, wrote: false };
    try {
      const value = await provider.extract({ text: command.text });
      return { reply: formatExtraction(value), wrote: false };
    } catch { return { reply: FAILURE, wrote: false }; }
  } };
}
module.exports = { USAGE, FAILURE, parseEmailThreadCommand, createEmailThreadCommands };
