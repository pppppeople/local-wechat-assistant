'use strict';

function parseTroubleshootingGuideCommand(text, active = false) {
  const value = String(text || '').trim();
  const start = value.match(/^(?:帮我排查|排查一下)[：:]\s*([\s\S]*)$/u);
  if (start) return { type: 'start', symptom: start[1].trim() };
  if (/^(?:帮我排查|排查一下)$/u.test(value)) return { type: 'start', symptom: '' };
  if (value === '结束排查') return { type: 'end' };
  return active === true && value ? { type: 'answer', text: String(text) } : null;
}

module.exports = { parseTroubleshootingGuideCommand };
