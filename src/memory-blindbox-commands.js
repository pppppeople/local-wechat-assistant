'use strict';

function parseMemoryBlindboxCommand(text, { bound = true } = {}) {
  if (!bound) return null;
  const value = String(text || '').trim();
  if (value === '回忆盲盒') return { type: 'start' };
  if (value === '结束盲盒') return { type: 'cancel' };
  if (value === '盲盒战绩') return { type: 'stats' };
  const answer = value.match(/^盲盒答\s*[:：]\s*([\s\S]*)$/u);
  if (answer) return { type: 'answer', answer: answer[1].trim() };
  if (/^盲盒答(?:\s|$)/u.test(value)) return { type: 'help' };
  return null;
}
module.exports = { parseMemoryBlindboxCommand };
