'use strict';

function normalizeTemplateName(value) {
  return String(value || '').trim().replace(/[。！？!?；;，,、.\s]+$/u, '').trim();
}

function parseTripChecklistCommand(text, { hasActive = false } = {}) {
  const value = String(text || '').trim();
  // Colloquial reports belong to this feature only while its owner has an active list.
  if (hasActive) {
    if (/^(?:还剩什么没带|看看缺漏)[？?。！!]?$/u.test(value)) return { type: 'remaining' };
    const report = value.match(/^(?:我)?(?:已经)?(?:都带了[：:]|带了)\s*(.+?)[。！!]?$/u);
    if (report) {
      const names = [...new Set(report[1].split(/[、，,和]/u).map(name => name.trim()).filter(Boolean))];
      if (names.length) return { type: 'check-batch', names };
    }
  }
  if (!value.includes('清单')) return null;
  if (value === '出门清单') return { type: 'list' };
  if (value === '看归档清单') return { type: 'archived' };
  if (value === '清单归档') return { type: 'archive' };
  let match = value.match(/^(?:帮我准备出门清单|出门清单)[：:]([\s\S]*)$/u);
  if (match) return { type: 'generate', scenario: match[1].trim() };
  match = value.match(/^清单加一项[：:]([\s\S]*)$/u);
  if (match) return { type: 'add', text: match[1].trim() };
  match = value.match(/^清单第\s*(\d+)\s*项(好了|取消打勾)$/u);
  if (match) return { type: match[2] === '好了' ? 'check' : 'uncheck', number: Number(match[1]) };
  match = value.match(/^清单删第\s*(\d+)\s*项$/u);
  if (match) return { type: 'delete', number: Number(match[1]) };
  // Existing checklist phrases above keep priority, even if their body mentions templates.
  if (value === '出门清单模板列表') return { type: 'template-list' };
  for (const [phrase, type] of [
    ['把这份出门清单存为模板', 'template-save'],
    ['用模板创建清单', 'template-create'],
    ['删除出门清单模板', 'template-delete'],
  ]) {
    match = value.match(new RegExp(`^${phrase}[：:]([\\s\\S]*)$`, 'u'));
    if (match) return { type, name: normalizeTemplateName(match[1]) };
  }
  return null;
}

module.exports = { parseTripChecklistCommand, normalizeTemplateName };
