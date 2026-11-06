'use strict';

function parseFeynmanCoachCommand(text, active = false) {
  const value = String(text || '').trim();
  if (value === '结束费曼') return { type: 'end' };
  const start = value.match(/^费曼(?:模式)?\s*[:：]\s*(.*)$/su);
  if (start) return { type: 'start', topic: start[1].trim() };
  if (/^费曼(?:模式)?$/u.test(value)) return { type: 'start', topic: '' };
  return active && value ? { type: 'answer', text: String(text) } : null;
}

module.exports = { parseFeynmanCoachCommand };
