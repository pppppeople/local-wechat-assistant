'use strict';

const { parseTimeExpression, shanghaiParts } = require('./friend-relay-commands');
const { parseCapsuleTime } = require('./shared-life-commands');
const { targetDate } = require('./shared-place-commands');

// Adapt date-only phrases to the existing Shanghai parsers; do not alter them.
function reviewDate(expression, now) {
  let value = expression.trim().replace(/\s+/gu, '').replace(/号/gu, '日');
  const relative = value.match(/^(?:再)?过(.+)$/u);
  if (relative) value = `${relative[1]}后`;
  if (/^[一二两三四五六七八九十\d]+(?:小时|天|周|个月|月|年)后$/u.test(value)) {
    return new Date(parseCapsuleTime(value, now).sendAt).toISOString();
  }
  const month = value.match(/^(下个?月|本月|这个月)([一二三四五六七八九十\d]+)日(.*)$/u);
  if (month) {
    const { year, month: current } = shanghaiParts(now);
    const shifted = new Date(Date.UTC(year, current - 1 + (month[1].startsWith('下') ? 1 : 0), 1));
    // Chinese day numbers follow the same digits/tens convention as focus durations.
    const digits = '零一二三四五六七八九';
    const raw = month[2];
    const [left, right] = raw.split('十');
    const day = /^\d+$/u.test(raw) ? Number(raw) : raw.includes('十')
      ? (left ? digits.indexOf(left) : 1) * 10 + (right ? digits.indexOf(right) : 0) : digits.indexOf(raw);
    value = `${shifted.getUTCFullYear()}-${shifted.getUTCMonth() + 1}-${day}${month[3]}`;
  }
  if (/^(?:下|本|这)?(?:周|星期)[一二三四五六日天]$|^周末$|^下周末$/u.test(value)) value = targetDate(value, now).date;
  if (!/点|\d:\d/u.test(value)) value += '09:00';
  const schedule = parseTimeExpression(value, now);
  if (schedule.recurrence) throw new Error('请提供单次复盘日期');
  return new Date(schedule.sendAt).toISOString();
}

function parseDecisionReviewCommand(text, { now = Date.now(), side = 'owner' } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim().replace(/[。！!]+$/gu, '');
  const invalid = () => /^想法(?:没变|变了[：:])/u.test(value)
    ? { type: 'invalid', requiresPending: true } : { type: 'invalid' };
  if (value === '我的复盘卡') return { type: 'list' };
  let match = value.match(/^复盘卡第\s*([1-9]\d*)\s*张(?:改到\s*(.+))?$/u);
  try {
    if (match) return match[2] ? { type: 'reschedule', number: Number(match[1]), dueAt: reviewDate(match[2], now) }
      : { type: 'show', number: Number(match[1]) };
    match = value.match(/^记决定[：:]\s*([\s\S]*)$/u);
    if (match) {
      let body = match[1].trim(), dueAt = new Date(now + 30 * 86400000).toISOString(), defaultDate = true;
      const tail = body.match(/(?:[，,]\s*|\s+)([^，,]+?)复盘$/u);
      if (tail) { dueAt = reviewDate(tail[1], now); defaultDate = false; body = body.slice(0, tail.index).trim(); }
      const because = body.indexOf('因为');
      const decision = (because < 0 ? body : body.slice(0, because)).replace(/[，,\s]+$/gu, '');
      const reason = because < 0 ? '' : body.slice(because + 2).trim();
      if (!decision || (because >= 0 && !reason)) return invalid();
      return { type: 'create', decision, reason, dueAt, defaultDate };
    }
    match = value.match(/^复盘第\s*([1-9]\d*)\s*张[：:]\s*([\s\S]+)$/u);
    const short = /^(?:想法没变|想法变了[：:]\s*\S)/u.test(value)
      && /^(?:想法没变(?:[，,][\s\S]+)?|想法变了[：:]\s*[\s\S]+)$/u.test(value);
    if (!match && !short) return null;
    let thought = match ? match[2].trim() : value;
    let dueAt = null, close = false;
    const closeTail = thought.match(/(?:^|[，,]\s*)复盘完了$/u);
    if (closeTail) { close = true; thought = thought.slice(0, closeTail.index).trim() || '复盘完了'; }
    const next = thought.match(/[，,]\s*((?:再)?过.+?|.+?后)看$/u);
    if (next) { dueAt = reviewDate(next[1], now); thought = thought.slice(0, next.index).trim(); }
    if (!thought || (close && dueAt)) return invalid();
    return { type: 'review', number: match ? Number(match[1]) : null, thought, dueAt, close };
  } catch { return invalid(); }
}

module.exports = { parseDecisionReviewCommand };
