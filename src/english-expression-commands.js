'use strict';

const HELP = '请发送“收藏表达：<总结序号>”、“表达收藏列表”或“删除表达：<收藏ID>”。';
function parseEnglishExpressionCommand(text) {
  const value = String(text || '').trim();
  if (/^表达收藏列表/u.test(value)) return { type: value === '表达收藏列表' ? 'list' : 'invalid' };
  if (/^收藏表达/u.test(value)) {
    const match = value.match(/^收藏表达\s*[：:]?\s*([1-9]\d*)$/u);
    return match && Number.isSafeInteger(Number(match[1])) ? { type: 'add', number: Number(match[1]) } : { type: 'invalid' };
  }
  if (/^删除表达/u.test(value)) {
    const match = value.match(/^删除表达\s*[：:]?\s*([a-z0-9_-]+)$/iu);
    return match ? { type: 'delete', id: match[1] } : { type: 'invalid' };
  }
  return null;
}
module.exports = { HELP, parseEnglishExpressionCommand };
