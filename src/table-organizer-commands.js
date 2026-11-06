'use strict';

const { formatTable } = require('./table-organizer-formatter');
const { refused, unchanged } = require('./feature-result');

function parseTableOrganizerCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^整理成表格(?:[：:]\s*|\s+)([\s\S]*)$/u);
  if (match) return { type: 'organize', text: match[1].trim() };
  return value === '整理成表格' ? { type: 'organize', text: '' } : null;
}
function createTableOrganizer({ provider }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'organize' || typeof command.text !== 'string' || !command.text.trim()) {
      return refused('请发送“整理成表格：<一段杂乱文字>”。');
    }
    try { return unchanged(formatTable(await provider.organize({ text: command.text }))); }
    catch { return refused('表格整理失败：模型调用失败或 JSON 格式无效，未生成表格，请重试。'); }
  } };
}

module.exports = { parseTableOrganizerCommand, createTableOrganizer };
