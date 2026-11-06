'use strict';
function parsePairSecretMissionCommand(text) {
  if (typeof text !== 'string') return null;
  const commands = { 秘密任务: 'draw', 秘密任务完成了: 'complete', 放弃秘密任务: 'abandon' };
  return Object.hasOwn(commands, text.trim()) ? { type: commands[text.trim()] } : null;
}
module.exports = { parsePairSecretMissionCommand };
