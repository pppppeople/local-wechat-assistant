'use strict';

const { expectedFollowUpDate } = require('./follow-up-commands');

function parseFutureQuestionCommand(text, { now = Date.now(), side = 'owner' } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (value === '未来的题') return { type: 'list' };
  let match = value.match(/^(取消未来题|未来题回答)[：:]\s*([\s\S]*)$/u);
  if (match) return match[2].trim()
    ? { type: match[1] === '取消未来题' ? 'cancel' : 'answer', text: match[2].trim() }
    : { type: 'invalid' };
  if (!/^给未来的我出题[：:]/u.test(value)) return null;
  match = value.match(/^给未来的我出题[：:]\s*([^｜|]+)[｜|]\s*我的答案[：:]\s*([^｜|]+)[｜|]\s*([^｜|]+)$/u);
  if (!match || !match[1].trim() || !match[2].trim()) return { type: 'invalid' };
  const date = expectedFollowUpDate(match[3].trim(), now);
  return date ? { type: 'create', question: match[1].trim(), answer: match[2].trim(), date } : { type: 'invalid' };
}

module.exports = { parseFutureQuestionCommand };
