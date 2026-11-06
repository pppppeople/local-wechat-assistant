'use strict';

const MAX_ROWS = 20;
const MAX_COLUMNS = 6;
const MAX_CELL_WIDTH = 16;

function validateTable(value) {
  const cell = item => item === null || typeof item === 'string' || typeof item === 'boolean'
    || typeof item === 'number' && Number.isFinite(item);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'columns,rows'
    || !Array.isArray(value.columns) || !value.columns.length || !value.columns.every(cell)
    || !Array.isArray(value.rows) || !value.rows.every(row => Array.isArray(row)
      && row.length <= value.columns.length && row.every(cell))) throw Error('表格字段格式无效');
  return value;
}

function characterWidth(char) {
  if (/\p{Mark}/u.test(char) || char === '\u200d' || char === '\ufe0f') return 0;
  const cp = char.codePointAt(0);
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
    || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3
    || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe19
    || cp >= 0xfe30 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60
    || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x1f300 && cp <= 0x1faff
    || cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}
function displayWidth(text) { return Array.from(text).reduce((sum, char) => sum + characterWidth(char), 0); }
function normalizeCell(value) {
  if (value === undefined || value === null) return '—';
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\|/gu, '｜').replace(/\s+/gu, ' ').trim() || '—';
}
function truncateCell(text) {
  if (displayWidth(text) <= MAX_CELL_WIDTH) return text;
  let result = '', width = 0;
  for (const char of text) {
    const next = characterWidth(char);
    if (width + next > MAX_CELL_WIDTH - 1) break;
    result += char;
    width += next;
  }
  return `${result}…`;
}
function formatTable(value, { maxColumns = MAX_COLUMNS } = {}) {
  validateTable(value);
  const count = Math.min(value.columns.length, maxColumns);
  let shortened = false;
  const matrix = [value.columns, ...value.rows.slice(0, MAX_ROWS)].map(row =>
    Array.from({ length: count }, (_, index) => {
      const text = normalizeCell(row[index]);
      const output = truncateCell(text);
      if (output !== text) shortened = true;
      return output;
    }));
  const widths = Array.from({ length: count }, (_, index) => Math.max(...matrix.map(row => displayWidth(row[index]))));
  const render = row => row.map((text, index) => text + ' '.repeat(widths[index] - displayWidth(text))).join(' | ');
  const lines = [render(matrix[0]), widths.map(width => '-'.repeat(width)).join('-+-'), ...matrix.slice(1).map(render)];
  if (value.rows.length > MAX_ROWS) lines.push(`已截断：共 ${value.rows.length} 行，仅显示前 ${MAX_ROWS} 行（不含表头）。`);
  if (value.columns.length > maxColumns) lines.push(`已截断：共 ${value.columns.length} 列，仅显示前 ${maxColumns} 列。`);
  if (shortened) lines.push(`单元格过长已截断为最多 ${MAX_CELL_WIDTH} 个显示宽度，以 … 标注。`);
  return lines.join('\n');
}

module.exports = { MAX_ROWS, MAX_COLUMNS, MAX_CELL_WIDTH, validateTable, displayWidth, formatTable };
