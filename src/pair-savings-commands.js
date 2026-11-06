'use strict';

// Decimal RMB text is converted exactly once; no floating-point multiplication.
function parseAmount(text) {
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/u.test(text)) return null;
  const [yuan, fraction = ''] = text.split('.');
  const cents = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function parsePairSavingsCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (['共同愿望', '共同愿望清单', '共同愿望进度', '查看共同愿望'].includes(value)) return { type: 'progress' };
  const create = value.match(/^共同愿望(?:清单)?[：:]\s*([^\r\n]+?)\s+([0-9]+(?:\.[0-9]{1,2})?)元$/u);
  if (create) {
    const targetCents = parseAmount(create[2]);
    if (targetCents && create[1].trim().length <= 120) return { type: 'create', name: create[1].trim(), targetCents };
  }
  const contribution = value.match(/^愿望贡献[：:]\s*([0-9]+(?:\.[0-9]{1,2})?)元$/u);
  if (contribution) {
    const amountCents = parseAmount(contribution[1]);
    if (amountCents) return { type: 'contribute', amountCents };
  }
  const undo = value.match(/^撤销愿望贡献[：:]\s*([0-9]+)$/u);
  if (undo && Number.isSafeInteger(Number(undo[1])) && Number(undo[1]) > 0) return { type: 'undo', number: Number(undo[1]) };
  return /^(?:共同愿望|查看共同愿望|愿望贡献|撤销愿望贡献)/u.test(value) ? { type: 'help' } : null;
}

module.exports = { parsePairSavingsCommand };
