'use strict';

// Match the relay parser's decimal digits / Chinese digits and tens convention,
// but reject malformed numbers rather than silently turning them into zero.
function durationNumber(text) {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  const digit = value => digits.indexOf(value.replace('〇', '零').replace('两', '二'));
  if (/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/u.test(text)) {
    const [left, right] = text.split('十');
    return (left ? digit(left) : 1) * 10 + (right ? digit(right) : 0);
  }
  if (/^[零〇一二两三四五六七八九]+$/u.test(text)) {
    return [...text].reduce((total, item) => total * 10 + digit(item), 0);
  }
  return NaN;
}

function parseFocusSessionCommand(text) {
  const value = String(text || '').trim();
  if (/^结束专注[。！!]?$/u.test(value)) return { type: 'cancel' };
  if (/^专注状态[。？?]?$/u.test(value)) return { type: 'status' };
  if (!/^(?:专心工作|专注)(?:\s|[\d零〇一二两三四五六七八九十半]|$)/u.test(value)) return null;
  const match = value.match(/^(?:专心工作|专注)\s*([\d零〇一二两三四五六七八九十]+)\s*(分钟|小时)(?:\s*[，,]\s*结束提醒我\s*(.+?))?\s*[。！!]?$/u);
  const count = match ? durationNumber(match[1]) : NaN;
  const durationMs = count * (match?.[2] === '小时' ? 3600000 : 60000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isFinite(new Date(durationMs).getTime())) {
    return { type: 'invalid' };
  }
  return { type: 'start', durationMs, goal: (match[3] || '').trim() };
}

module.exports = { parseFocusSessionCommand };
