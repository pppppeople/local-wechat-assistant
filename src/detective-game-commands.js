'use strict';

const REFUSAL = '桌游主持仅主人可用，好友不能读取或操作。';
function parseDetectiveGameCommand(input) {
  const text = String(input || '').trim();
  if (text === '桌游主持' || text === '开始桌游') return { type: 'start' };
  if (text === '调查' || text === '问线索') return { type: 'investigate' };
  if (text === '结束桌游') return { type: 'end' };
  const answer = text.match(/^答案[：:]([\s\S]*)$/u);
  return answer ? { type: 'answer', answer: answer[1].trim() } : null;
}
module.exports = { parseDetectiveGameCommand, REFUSAL };
