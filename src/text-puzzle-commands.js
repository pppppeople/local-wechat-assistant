'use strict';

function parseTextPuzzleCommand(text, side = 'owner') {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  const commands = { '解谜': 'start', '来个谜题': 'start', '解谜战绩': 'stats', '提示': 'hint', '放弃这题': 'skip' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const answer = value.match(/^猜[：:]([\s\S]*)$/u);
  return answer ? { type: 'answer', answer: answer[1] } : null;
}

module.exports = { parseTextPuzzleCommand };
