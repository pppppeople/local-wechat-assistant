'use strict';

const { shanghaiParts } = require('./friend-relay-commands');

function todayShanghai(now = Date.now()) {
  const { year, month, day } = shanghaiParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('购买日期请写 YYYY-MM-DD 或 X月X日');
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('购买日期无效');
  return time;
}

function purchaseDate(value, now = Date.now()) {
  if (value === undefined) return todayShanghai(now);
  const short = typeof value === 'string' && value.match(/^(\d{1,2})月(\d{1,2})日$/u);
  const date = short ? `${shanghaiParts(now).year}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}` : value;
  dateTimestamp(date);
  return date;
}

function warrantyExpiry(date, months) {
  dateTimestamp(date);
  if (!Number.isSafeInteger(months) || months <= 0) throw new Error('保修时长必须为正整数年或月数');
  const [year, month, day] = date.split('-').map(Number);
  const index = year * 12 + month - 1 + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index % 12 + 1;
  if (targetYear > 9999) throw new Error('保修到期日期超出支持范围');
  const first = new Date(`${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-01T00:00:00.000Z`);
  first.setUTCMonth(first.getUTCMonth() + 1, 0);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, first.getUTCDate())).padStart(2, '0')}`;
}

function validatePurchase({ amount, warrantyMonths, purchaseDate: date }, now = Date.now()) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new Error('购买金额必须为正数');
  const normalized = { amount, warrantyMonths, purchaseDate: purchaseDate(date, now) };
  warrantyExpiry(normalized.purchaseDate, warrantyMonths);
  return normalized;
}

function warrantyDaysLeft(purchase, now) {
  return (dateTimestamp(warrantyExpiry(purchase.purchaseDate, purchase.warrantyMonths)) - dateTimestamp(todayShanghai(now))) / 86400000;
}

module.exports = { todayShanghai, purchaseDate, validatePurchase, warrantyExpiry, warrantyDaysLeft };
