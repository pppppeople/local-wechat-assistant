'use strict';

function parsePairDateTurnCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const commands = { 出行轮值: 'status', 出行轮值状态: 'status', 出行轮值历史: 'history', 出行轮到谁: 'current', 撤销出行轮值完成: 'undo' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const start = value.match(/^发起出行轮值[：:]\s*([^\r\n]+?)\s+(主人|好友)先选$/u);
  if (start) return { type: 'start', text: start[1].trim(), first: start[2] === '主人' ? 'owner' : 'friend' };
  const complete = value.match(/^出行轮值完成\s+([1-9]\d*)$/u);
  if (complete) return { type: 'complete', round: Number(complete[1]) };
  return /^(?:发起出行轮值|出行轮值|出行轮到谁|撤销出行轮值完成)/u.test(value) ? { type: 'help' } : null;
}
module.exports = { parsePairDateTurnCommand };
