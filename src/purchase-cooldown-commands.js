'use strict';

function parsePurchaseCooldownCommand(text) {
  const value = String(text || '').trim();
  const link = require('./purchase-cooldown-link').parseLinkCommand(value);
  if (link) return link;
  if (/^冷静期清单[。？?]?$/u.test(value)) return { type: 'list' };
  if (/^冷静期战绩[。？?]?$/u.test(value)) return { type: 'stats' };
  const decision = value.match(/^(?:第\s*([1-9]\d*)\s*个\s*)?(买了|放弃|再想想)[。！!]?$/u);
  if (decision) return { type: 'decide', number: decision[1] ? Number(decision[1]) : null,
    decision: { '买了': 'bought', '放弃': 'abandoned', '再想想': 'extend' }[decision[2]] };
  // The warranty ledger and quoted/ordinary purchase talk keep their own routes.
  if (!/^冷静期[：:]/u.test(value) && !/^想买.+[，,]\s*先冷静/u.test(value)) return null;
  const match = value.match(/^(?:冷静期[：:]\s*|想买\s*)(.+?)\s+(\d+(?:\.\d{1,2})?)\s*元(?:\s*[，,]\s*先冷静\s*(\d+)\s*天)?[。！!]?$/u);
  const amount = match ? Number(match[2]) : NaN;
  const days = match?.[3] ? Number(match[3]) : 3;
  if (!match || !Number.isSafeInteger(Math.round(amount * 100)) || amount <= 0
    || !Number.isSafeInteger(days) || days <= 0 || days > 36500
    || (/^想买/u.test(value) && !match[3])) return { type: 'invalid' };
  return { type: 'create', item: match[1].trim(), amount, days };
}

module.exports = { parsePurchaseCooldownCommand };
