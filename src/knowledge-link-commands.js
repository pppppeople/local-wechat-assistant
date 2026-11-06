'use strict';

const HELP = '用“串联知识”从全部知识条目抽取两条；用“串联知识：标签”限定单个标签（精确匹配，不区分大小写）。';
function parseKnowledgeLinkCommand(input) {
  const text = String(input || '').trim();
  if (text === '串联知识') return { type: 'link' };
  if (!text.startsWith('串联知识')) return null;
  const match = text.match(/^串联知识[：:]([^\n\r：:｜|、，,]+)$/u);
  return match && match[1].trim() ? { type: 'link', tag: match[1].trim() } : { type: 'invalid' };
}

module.exports = { parseKnowledgeLinkCommand, HELP };
