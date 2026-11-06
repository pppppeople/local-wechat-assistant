'use strict';

function parseOpinionChallengeCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^挑战一下这个观点\s*[:：]([\s\S]*)$/u);
  if (!match) return value === '挑战一下这个观点' ? { type: 'invalid' } : null;
  const opinion = match[1].trim();
  return opinion ? { type: 'challenge', opinion } : { type: 'invalid' };
}

module.exports = { parseOpinionChallengeCommand };
