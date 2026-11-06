'use strict';

const { parseTimeExpression } = require('./friend-relay-commands');

function parsePhotoVaultCommand(text, imagePaths = [], { now = Date.now(), side = 'owner' } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (!imagePaths.length) {
    if (/^我的照片[。？?]?$/u.test(value)) return { type: 'list' };
    const action = value.match(/^(发回|删)第\s*(\d+)\s*张(照片)?[。！!]?$/u);
    if (action && (action[1] === '发回' || action[3])) {
      return { type: action[1] === '发回' ? 'send' : 'delete', number: Number(action[2]) };
    }
  }
  const save = value.match(/^存这张照片(?:[：:]\s*([\s\S]*))?[。！!]?$/u);
  const timed = value.match(/^(?:这张照片\s*(.+?)\s*发回给我|(.+?)\s*把这张照片发回(?:给我)?)(?:[：:]\s*([\s\S]*))?[。！!]?$/u);
  if (!save && !timed) return null;
  if (imagePaths.length !== 1) return { type: 'invalid' };
  let resendAt = null, timeUnparsed = false;
  const expression = timed && (timed[1] || timed[2]).trim();
  if (expression) {
    try {
      let normalized = expression;
      // Local adapter only: the common parser requires a calendar date and clock.
      // A day-only next-month request uses 09:00 Shanghai, stated in the receipt.
      const month = normalized.match(/^下个?月\s*([\d一二三四五六七八九十两]+)\s*[号日](.*)$/u);
      if (month) {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric' })
          .formatToParts(new Date(now));
        const date = Object.fromEntries(parts.map(p => [p.type, p.value]));
        const digits = '零一二三四五六七八九';
        const number = v => /^\d+$/u.test(v) ? Number(v) : v.includes('十')
          ? (v.split('十')[0] ? digits.indexOf(v.split('十')[0].replace('两', '二')) : 1) * 10
            + (v.split('十')[1] ? digits.indexOf(v.split('十')[1]) : 0)
          : digits.indexOf(v.replace('两', '二'));
        if (!/^(?:\d{1,2}|[一二两三四五六七八九]|[一二三]?十[一二三四五六七八九]?)$/u.test(month[1])) throw new Error('invalid day');
        const next = new Date(Date.UTC(Number(date.year), Number(date.month), 1));
        normalized = `${next.getUTCFullYear()}-${next.getUTCMonth() + 1}-${number(month[1])} ${month[2].trim() || '09:00'}`;
      }
      const schedule = parseTimeExpression(normalized, now);
      if (schedule.recurrence) throw new Error('one shot only');
      resendAt = new Date(schedule.sendAt).toISOString();
    } catch { timeUnparsed = true; }
  }
  return { type: 'add', note: (save ? save[1] || '' : timed[3] || '').trim(),
    resendAt, timeUnparsed, timeText: expression || '', imagePaths: [...imagePaths] };
}

module.exports = { parsePhotoVaultCommand };
