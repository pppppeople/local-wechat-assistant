'use strict';

function parsePairDailyQuestionCommand(text) {
  const value = String(text || '').trim();
  if (value === '每日一问') return { type: 'status' };
  if (value === '每日一问揭晓' || value === '每日一问查揭晓') return { type: 'reveal' };
  const answer = value.match(/^每日一问答[：:]([\s\S]*)$/u);
  if (answer) return { type: 'answer', answer: answer[1].trim() };
  return null;
}

module.exports = { parsePairDailyQuestionCommand };
