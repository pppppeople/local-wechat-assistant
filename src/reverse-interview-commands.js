'use strict';

function parseReverseInterviewCommand(text, active = false) {
  const raw = String(text || '');
  const value = raw.trim();
  const match = value.match(/^反过来问我[：:]\s*([\s\S]*)$/u);
  if (match) return { type: 'start', topic: match[1] };
  if (value === '放弃提问') return { type: 'discard' };
  if (value === '结束提问' || (active === true && value === '就这样吧')) return { type: 'end' };
  if (value === '存成卡片') return { type: 'save_card' };
  if (active !== true) return null;
  if (value === '跳过') return { type: 'skip' };
  return { type: 'answer', answer: raw };
}

module.exports = { parseReverseInterviewCommand };
