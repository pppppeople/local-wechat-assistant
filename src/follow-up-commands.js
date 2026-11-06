'use strict';

const { extractDueDate, shanghaiDay } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');

function expectedFollowUpDate(phrase, now) {
  if (phrase == null) return null;
  const value = String(phrase).trim();
  if (value === '今天') return shanghaiDay(now);
  if (validDay(value)) return value;
  const parsed = extractDueDate(value, now);
  return parsed.dueDate && !parsed.text.trim() ? parsed.dueDate : undefined;
}

function parseFollowUpCommand(text, { side = 'owner' } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (value === '催办列表' || value === '在等什么') return { type: 'list' };
  const close = value.match(/^(有结果了|取消等待)[：:]\s*([\s\S]*)$/u);
  if (close) return close[2].trim()
    ? { type: close[1] === '有结果了' ? 'complete' : 'cancel', keyword: close[2].trim() }
    : { type: 'invalid' };
  const create = value.match(/^在等[：:]\s*([\s\S]*)$/u);
  if (!create) return null;
  let name = create[1].trim(), counterpart = '未注明', expected = null;
  const party = name.match(/[（(]对方[：:]\s*([^（）()]*?)[）)]/u);
  if (party) {
    counterpart = party[1].trim();
    name = (name.slice(0, party.index) + name.slice(party.index + party[0].length)).trim();
    if (!counterpart) return { type: 'invalid' };
  }
  const node = name.match(/\s*预计\s*(.*?)\s*有结果$/u);
  if (node) { expected = node[1].trim(); name = name.slice(0, node.index).trim(); }
  if (!name || /[（(]对方[：:]/u.test(name)) return { type: 'invalid' };
  return { type: 'create', name, counterpart, expected };
}

module.exports = { parseFollowUpCommand, expectedFollowUpDate };
