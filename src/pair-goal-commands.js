'use strict';

function parsePairGoalCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const commands = { 共同目标打卡: 'checkin', 撤销共同目标打卡: 'undo', 共同目标进度: 'progress', 关闭共同目标: 'close' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const create = value.match(/^共同目标[：:]([\s\S]*\S)\s+([0-9]+)次$/u);
  if (create) return { type: 'create', text: create[1].trim(), total: Number(create[2]) };
  return /^共同目标[：:]/u.test(value) || value === '共同目标' ? { type: 'help' } : null;
}

module.exports = { parsePairGoalCommand };
