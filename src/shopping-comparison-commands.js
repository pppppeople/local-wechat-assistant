'use strict';

const { formatTable } = require('./table-organizer-formatter');
const { validateComparison } = require('./shopping-comparison-provider');
const { refused, unchanged } = require('./feature-result');
const LIMIT_REPLY = '购物对比最多支持 5 个商品、6 个维度；本次超出上限，未生成对比表，请减少后重试。';

function parseShoppingComparisonCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^购物对比(?:[：:]\s*|\s+)([\s\S]*)$/u);
  if (match) return { type: 'compare', text: match[1].trim() };
  return value === '购物对比' ? { type: 'compare', text: '' } : null;
}
function sortProducts(rows, dimensions, text) {
  const match = text.match(/按([^\s，,；;。\n：:]+?)(从低到高|从高到低|升序|降序)/u);
  if (!match) return { rows, note: '未指定可识别的排序条件，保持主人提供顺序。' };
  const index = dimensions.indexOf(match[1]) + 1;
  const numbers = rows.map(row => String(row[index] ?? '').trim().match(/^([¥￥]?)(-?\d+(?:\.\d+)?)([^\d\s]*)$/u));
  if (!index || numbers.some(item => !item || !Number.isFinite(Number(item[2])))
    || new Set(numbers.map(item => `${item[1]}|${item[3]}`)).size !== 1) {
    return { rows, note: '排序维度非完整数值、含未知或单位不一致，保持主人提供顺序。' };
  }
  const direction = /从低到高|升序/u.test(match[2]) ? 1 : -1;
  const sorted = rows.map((row, i) => ({ row, i, number: Number(numbers[i][2]) }))
    .sort((a, b) => direction * (a.number - b.number) || a.i - b.i).map(item => item.row);
  return { rows: sorted, note: `已按${match[1]}${match[2]}排序（相同数值保持原序）。` };
}
function createShoppingComparison({ provider }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'compare' || typeof command.text !== 'string' || !command.text.trim()) {
      return refused('请发送“购物对比：<商品信息>”，可附“按价格从低到高”。');
    }
    try {
      const { dimensions, products } = validateComparison(await provider.compare({ text: command.text }));
      if (products.length > 5 || dimensions.length > 6) return refused(LIMIT_REPLY);
      // Names must be source excerpts; restore source order even if the model reordered rows.
      if (!dimensions.length || dimensions.some(item => !command.text.includes(item))
        || products.some(item => !command.text.includes(item.name))) throw Error('缺少原文依据');
      const ordered = [...products].sort((a, b) => command.text.indexOf(a.name) - command.text.indexOf(b.name));
      const rows = ordered.map(item => [item.name, ...dimensions.map((_, i) => {
        const value = item.values[i];
        return value === null || value === undefined || String(value).trim() === ''
          || !command.text.includes(String(value)) ? '未知' : value;
      })]);
      const sorted = sortProducts(rows, dimensions, command.text);
      return unchanged(`${formatTable({ columns: ['商品', ...dimensions], rows: sorted.rows }, { maxColumns: 7 })}\n${sorted.note}`);
    } catch {
      return refused('购物对比失败：模型调用失败或结构化结果无效，未生成对比表，请重试。');
    }
  } };
}
module.exports = { parseShoppingComparisonCommand, createShoppingComparison };
