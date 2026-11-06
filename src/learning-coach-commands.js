'use strict';

function parseLearningCoachCommand(text) {
  const value = String(text || '').trim().normalize('NFKC');
  if (value === '结束练习') return { type: 'end' };
  if (value === '我的错题') return { type: 'mistakes' };
  if (value === '重练错题') return { type: 'retry' };
  if (/^[a-d]$/iu.test(value)) return { type: 'answer', answer: value.toUpperCase() };
  const match = value.match(/^考我(?:(\d+)道)?(.+?)(?:题)?$/u);
  if (!match) return null;
  return { type: 'start', count: match[1] === undefined ? 3 : Number(match[1]), topic: match[2].trim() };
}

module.exports = { parseLearningCoachCommand };
