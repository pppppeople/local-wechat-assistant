'use strict';

const REFUSAL = '文字冒险仅主人可用，好友不能读取或操作。';
function parseTextAdventureCommand(input, active = false) {
  const text = String(input || '').trim();
  if (text === '开始冒险') return { type: 'start', cardName: '' };
  const start = text.match(/^开始冒险(?:[：:]\s*|\s+)(.+)$/su);
  if (start) return { type: 'start', cardName: start[1].trim() };
  if (text === '结束冒险') return { type: 'end' };
  if (text === '冒险继续') return { type: 'retry' };
  const choice = text.match(/^(?:冒险(?:选择)?\s*[:：]?\s*)?([123])$/u);
  if (choice && (active === true || text !== choice[1])) return { type: 'choose', choice: Number(choice[1]) };
  if (/^(?:开始冒险|冒险)/u.test(text)) return { type: 'invalid' };
  return null;
}
module.exports = { parseTextAdventureCommand, REFUSAL };
