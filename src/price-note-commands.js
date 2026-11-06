'use strict';

const DEFAULT_SOURCE = '未注明来源';
const PRICE_EXAMPLE = '价格无法解析，没有记录。请使用「记价格：牛奶 12.5元 超市」或「记价格：牛奶 12.5」。';

function parsePriceNoteCommand(text) {
  const value = String(text || '').trim();
  if (/^记价格[：:]/u.test(value)) {
    const match = value.match(/^记价格[：:]\s*(.+?)\s+(\d+(?:\.\d+)?)(?:元)?(?:\s+(.+))?$/u);
    if (!match || !Number.isFinite(Number(match[2]))) return { type: 'invalid', reply: PRICE_EXAMPLE };
    return { type: 'record', name: match[1].trim(), amount: Number(match[2]), source: match[3]?.trim() || DEFAULT_SOURCE };
  }
  if (/^删价格[：:]/u.test(value)) {
    const match = value.match(/^删价格[：:]\s*(.+?)\s+(\S.*)$/u);
    return match ? { type: 'delete', name: match[1].trim(), source: match[2].trim() }
      : { type: 'invalid', reply: '请使用「删价格：牛奶 超市」；未填来源的记录用「删价格：牛奶 未注明来源」。' };
  }
  for (const [pattern, type] of [[/^比价[：:]\s*(.*)$/u, 'compare'], [/^最低价[：:]\s*(.*)$/u, 'lowest'], [/^(.+?)最低价$/u, 'lowest']]) {
    const match = value.match(pattern);
    if (match) return match[1].trim() ? { type, name: match[1].trim() }
      : { type: 'invalid', reply: '请说清楚物品名，例如「比价：牛奶」或「最低价：牛奶」。' };
  }
  return null;
}

module.exports = { parsePriceNoteCommand, DEFAULT_SOURCE, PRICE_EXAMPLE };
