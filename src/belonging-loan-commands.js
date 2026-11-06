'use strict';

const { extractDueDate } = require('./personal-todo-commands');

function parseBelongingLoanCommand(text) {
  const value = String(text || '').trim();
  if (value === '借出列表') return { type: 'list' };
  if (value === '借出历史') return { type: 'history' };
  const returned = value.match(/^已归还[：:]\s*(.+)$/u);
  if (returned) return { type: 'return', name: returned[1].trim() };
  if (!/^借出登记[：:]/u.test(value)) return null;
  const match = value.match(/^借出登记[：:]\s*(.+?)\s+借给\s+(.+?)(?:\s+预计\s*(.+?)\s*归还)?$/u);
  return match ? { type: 'create', name: match[1].trim(), borrower: match[2].trim(), expected: match[3] || null }
    : { type: 'invalid' };
}

function expectedReturnDate(phrase, now) {
  if (phrase == null) return null;
  const value = String(phrase).trim();
  const parsed = extractDueDate(value, now);
  if (parsed.dueDate && !parsed.text.trim()) return parsed.dueDate;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const time = Date.parse(`${value}T00:00:00Z`);
    if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value) return value;
  }
  return undefined;
}

module.exports = { parseBelongingLoanCommand, expectedReturnDate };
