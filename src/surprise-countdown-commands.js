'use strict';

const { extractDueDate, shanghaiDay } = require('./personal-todo-commands');

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function countdownDate(phrase, now) {
  if (phrase === '今天') return shanghaiDay(now);
  if (validDay(phrase)) return phrase;
  const parsed = extractDueDate(phrase, now);
  return parsed.dueDate && !parsed.text.trim() ? parsed.dueDate : null;
}

function parseSurpriseCountdownCommand(text, { now = Date.now(), side = 'owner' } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (value === '我的倒计时') return { type: 'list' };
  let match = value.match(/^删除倒计时[：:]\s*([\s\S]*)$/u);
  if (match) return match[1].trim() ? { type: 'delete', name: match[1].trim() } : { type: 'invalid' };
  if (!/^倒计时[：:]/u.test(value)) return null;
  match = value.match(/^倒计时[：:]\s*(.+?)\s+(\S+)$/u);
  if (!match) return { type: 'invalid' };
  const date = countdownDate(match[2], now);
  return date ? { type: 'create', name: match[1].trim(), date } : { type: 'invalid' };
}

module.exports = { parseSurpriseCountdownCommand, validDay };
