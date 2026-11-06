'use strict';

function parsePairWishCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const add = value.match(/^存一个小心愿[：:]([\s\S]*)$/u);
  if (add) return { type: 'add', text: add[1].trim() };
  const commands = { 我的心愿: 'list', 抽一个对方的小心愿: 'draw', 心愿完成了: 'complete', 换个心愿: 'return' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const remove = value.match(/^删掉我的第\s*([1-9]\d*)\s*个心愿$/u);
  return remove ? { type: 'delete', index: Number(remove[1]) } : null;
}

module.exports = { parsePairWishCommand };
