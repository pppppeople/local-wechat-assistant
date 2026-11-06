'use strict';

const HELP = '用「复习知识」抽题、「复习统计」查看进度；「每天复习 HH:MM」开启每日复习，「关闭每日复习」取消。';
function parseKnowledgeReviewCommand(input, hasPending = false) {
  const text = String(input || '').trim();
  if (text === '复习知识') return { type: 'draw' };
  if (text === '复习统计') return { type: 'stats' };
  if (text === '关闭每日复习') return { type: 'disable' };
  const match = text.match(/^每天复习\s+((?:[01]\d|2[0-3]):[0-5]\d)$/u);
  if (match) return { type: 'enable', time: match[1] };
  if (/^每天复习(?:\s|$)/u.test(text)) return { type: 'invalid' };
  if (hasPending === true && ['会了', '不会'].includes(text)) return { type: text === '会了' ? 'master' : 'miss' };
  return null;
}

module.exports = { parseKnowledgeReviewCommand, HELP };
