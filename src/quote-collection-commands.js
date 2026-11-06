'use strict';

const REFUSAL = '阅读摘录收藏夹仅主人可用，好友不能读取或操作。';
const HELP = '请用“摘录保存：<原文>”（可在冒号前加 [来源=书名] [时间=原文时间]）、“摘录查找 <关键词>”、“摘录回顾”或“摘录删除 <编号>”。冒号后的原文逐字保存，含首尾空白和换行。';
function parseQuoteCollectionCommand(input) {
  // Do not trim the body: whitespace is part of the owner's original quotation.
  const text = String(input || '').trimStart();
  const save = text.match(/^摘录保存\s*((?:\[(?:来源|时间)=[^\]\r\n]+\]\s*)*)[：:]([\s\S]*)$/u);
  if (save) {
    const command = { type: 'save', body: save[2], source: '', time: '' };
    const seen = new Set();
    for (const match of save[1].matchAll(/\[(来源|时间)=([^\]\r\n]+)\]/gu)) {
      if (seen.has(match[1]) || !match[2].trim()) return { type: 'invalid' };
      seen.add(match[1]); command[match[1] === '来源' ? 'source' : 'time'] = match[2];
    }
    return command;
  }
  if (text.trimEnd() === '摘录回顾') return { type: 'random' };
  const search = text.match(/^摘录查找\s+([\s\S]*\S)\s*$/u);
  if (search) return { type: 'search', keyword: search[1].trim() };
  const deletion = text.trimEnd().match(/^摘录删除\s+([a-z0-9_-]+)$/iu);
  if (deletion) return { type: 'delete', id: deletion[1] };
  return /^(?:摘录保存|摘录查找|摘录回顾|摘录删除)/u.test(text) ? { type: 'invalid' } : null;
}
module.exports = { HELP, REFUSAL, parseQuoteCollectionCommand };
