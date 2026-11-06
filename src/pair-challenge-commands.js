'use strict';

function parsePairChallengeCommand(text) {
  const value = String(text || '').trim();
  if (value === '来一轮默契挑战') return { type: 'start' };
  if (value === '默契战绩') return { type: 'stats' };
  if (value === '结束默契挑战') return { type: 'cancel' };
  const answer = value.match(/^默契答\s+([A-D])$/iu);
  if (answer) return { type: 'answer', answer: answer[1].toUpperCase() };
  if (/^默契答(?:\s|$)/u.test(value)) return { type: 'help' };
  return null;
}

module.exports = { parsePairChallengeCommand };
