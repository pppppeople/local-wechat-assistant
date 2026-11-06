'use strict';

const HELP = '用“记知识：标题｜内容｜标签”录入（标签可省略）；“查知识：关键词”查询；“知识列表”查看；“删知识：标题”删除；“改知识：标题｜新内容”更新。';
const parseTags = value => [...new Set((value || '').split(/[、，,]/u).map(tag => tag.trim()).filter(Boolean))];

function parseKnowledgeNotebookCommand(input) {
  const text = String(input || '').trim();
  if (text === '确认批量记知识') return { type: 'batch-confirm' };
  if (text === '取消批量记知识') return { type: 'batch-cancel' };
  if (/^批量记知识[：:]/u.test(text)) {
    const lines = text.split(/\r?\n/u);
    if (!/^批量记知识[：:]\s*$/u.test(lines.shift()) || !lines.length) return { type: 'batch-invalid' };
    if (lines.length > 15) return { type: 'batch-too-large' };
    return { type: 'batch-preview', entries: lines.map(line => {
      const parts = line.split('｜').map(value => value.trim());
      return { title: parts[0], content: parts[1] || '', tags: parseTags(parts[2]),
        ...(parts.length < 2 || parts.length > 3 ? { reason: '格式无效，请使用固定分隔符“｜”，每行两段或三段' } : {}) };
    }) };
  }
  if (/^(?:批量记知识|确认批量记知识|取消批量记知识)/u.test(text)) return { type: 'batch-invalid' };
  if (text === '知识列表') return { type: 'list' };
  const match = text.match(/^(记知识|查知识|删知识|改知识)[：:]([\s\S]*)$/u);
  if (!match) return /^(?:记知识|查知识|删知识|改知识|知识列表)/u.test(text) ? { type: 'invalid' } : null;
  const body = match[2].trim();
  if (match[1] === '查知识') return body ? { type: 'search', keyword: body } : { type: 'invalid' };
  if (match[1] === '删知识') return body ? { type: 'delete', title: body } : { type: 'invalid' };
  const parts = body.split(/[｜|]/u).map(value => value.trim());
  const add = match[1] === '记知识';
  if (!parts[0] || !parts[1] || parts.length < 2 || parts.length > (add ? 3 : 2)) return { type: 'invalid' };
  if (!add) return { type: 'update', title: parts[0], content: parts[1] };
  const tags = parseTags(parts[2]);
  return { type: 'add', title: parts[0], content: parts[1], tags };
}

module.exports = { parseKnowledgeNotebookCommand, HELP };
