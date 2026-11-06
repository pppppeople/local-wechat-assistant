'use strict';

function parseChatCardCommand(text) {
  const value = String(text || '').trim().normalize('NFKC');
  if (value === '我的卡片') return { type: 'list' };
  let match = value.match(/^(看|删)卡片第\s*([1-9]\d*)\s*张$/u);
  if (match) return { type: match[1] === '看' ? 'view' : 'delete', number: Number(match[2]) };
  match = value.match(/^搜卡片\s+(.+)$/u);
  if (match) return { type: 'search', keyword: match[1].trim() };
  if (/^整理成(?:卡片|交接包)$/u.test(value)) return { type: 'generate', topic: '' };
  match = value.match(/^(?:把(?:刚才|刚刚|上面)(?:说的)?(?:关于(.+?)(?:的讨论|的对话|的内容)?)?|关于(.+?))整理成(?:卡片|交接包)$/u);
  return match ? { type: 'generate', topic: (match[1] || match[2] || '').trim() } : null;
}
module.exports = { parseChatCardCommand };
