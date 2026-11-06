'use strict';

function parseRequirementClarifierCommand(text, active = false) {
  const raw = String(text || '');
  const value = raw.trim();
  const match = value.match(/^(?:澄清需求|帮我澄清这个需求)[：:]\s*([\s\S]*)$/u);
  if (match) return { type: 'start', requirement: match[1] };
  if (/^(?:澄清需求|帮我澄清这个需求)$/u.test(value)) return { type: 'start', requirement: '' };
  if (value === '结束澄清') return { type: 'end' };
  if (active !== true) return null;
  if (value === '跳过') return { type: 'skip' };
  if (value === '重试') return { type: 'retry' };
  return { type: 'answer', answer: raw };
}

module.exports = { parseRequirementClarifierCommand };
