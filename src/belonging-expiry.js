'use strict';

const { shanghaiParts } = require('./friend-relay-commands');

function expiryTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('保质期只接受合法的 YYYY-MM-DD 日期');
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('保质期日期无效，请填写真实存在的 YYYY-MM-DD 日期');
  return time;
}

function expiryDaysLeft(expiresAt, now) {
  const { year, month, day } = shanghaiParts(now);
  const today = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return (expiryTimestamp(expiresAt) - expiryTimestamp(today)) / 86400000;
}

function expiryStatus(days) {
  return days < 0 ? `已过期 ${-days} 天` : `${days <= 30 ? '临期' : '未到期'}，剩 ${days} 天`;
}

module.exports = { expiryTimestamp, expiryDaysLeft, expiryStatus };
