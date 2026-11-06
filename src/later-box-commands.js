'use strict';

const { parseTimeExpression } = require('./friend-relay-commands');

function parseLaterBoxCommand(text, imagePaths = [], { now = Date.now(), side = 'owner' } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  // Images are claimed only by an explicit save caption, never by a query.
  if (imagePaths.length && !/^(?:稍后再看|存一下)(?:[：:，,\s]|$)/u.test(value)) return null;
  if (!imagePaths.length) {
    if (/^稍后箱(?:\s+全部)?$/u.test(value)) return { type: 'list', all: /全部$/u.test(value) };
    if (value === '稍后随机') return { type: 'random' };
    const search = value.match(/^稍后搜\s+(.+)$/u);
    if (search) return { type: 'search', keyword: search[1].trim() };
    const action = value.match(/^稍后第\s*(\d+)\s*条(已看|删掉)$/u);
    if (action) return { type: action[2] === '已看' ? 'read' : 'delete', number: Number(action[1]) };
  }
  const match = imagePaths.length
    ? value.match(/^(?:稍后再看|存一下)[：:，,\s]*([\s\S]*)$/u)
    : value.match(/^(?:稍后看|存一下)[：:]\s*([\s\S]*)$/u);
  if (!match) return null;
  let content = match[1].trim();
  let note = '', resendAt = null, timeUnparsed = false;
  // Optional tails use explicit separators so links and ordinary prose stay intact.
  const noteTail = content.match(/(?:[，,]\s*|\s+)备注[：:]\s*([\s\S]*)$/u);
  if (noteTail) { note = noteTail[1].trim(); content = content.slice(0, noteTail.index).trim(); }
  const reminder = content.match(/(?:[，,]\s*|^)([^，,]*提醒我)\s*[。！!]?$/u);
  if (reminder) {
    const expression = reminder[1].replace(/提醒我$/u, '').trim();
    content = content.slice(0, reminder.index).trim();
    try {
      if (!/^(?:今天|明天|今早|今晚|明早|明晚)/u.test(expression)) throw new Error('unsupported day');
      resendAt = new Date(parseTimeExpression(expression, now).sendAt).toISOString();
    } catch { timeUnparsed = true; note = [note, reminder[1]].filter(Boolean).join('；'); }
  }
  if ((!content && !imagePaths.length) || imagePaths.length > 1) return { type: 'invalid' };
  return { type: 'add', kind: imagePaths.length ? 'image' : /^https?:\/\/\S+$/iu.test(content) ? 'link' : 'text',
    content, note, resendAt, timeUnparsed, imagePaths: [...imagePaths] };
}

module.exports = { parseLaterBoxCommand };
