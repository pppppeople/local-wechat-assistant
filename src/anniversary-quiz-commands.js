'use strict';

const { validDay } = require('./surprise-countdown-commands');
const HELP = '主人可用「登记纪念日：名称｜YYYY-MM-DD」「纪念日列表」「删除纪念日：名称」；双方可用「纪念日问答：名称」「纪念日回答：日期」「纪念日揭晓」「纪念日放弃」。';
function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/u);
  const date = match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : text;
  return validDay(date) && !date.startsWith('0000-') ? date : null;
}
function parseAnniversaryQuizCommand(input) {
  const text = String(input || '').trim();
  const exact = { '纪念日列表': 'list', '纪念日揭晓': 'reveal', '纪念日放弃': 'cancel' };
  if (Object.hasOwn(exact, text)) return { type: exact[text] };
  const match = text.match(/^(登记纪念日|删除纪念日|纪念日问答|纪念日回答)[：:]([\s\S]*)$/u);
  if (!match) return /^(?:登记纪念日|删除纪念日|纪念日列表|纪念日问答|纪念日回答|纪念日揭晓|纪念日放弃)/u.test(text) ? { type: 'invalid' } : null;
  const body = match[2].trim();
  if (match[1] === '登记纪念日') {
    const parts = body.split(/[｜|]/u).map(part => part.trim());
    return parts.length === 2 && parts.every(Boolean) ? { type: 'add', name: parts[0], date: parts[1] } : { type: 'invalid' };
  }
  if (!body) return { type: 'invalid' };
  return match[1] === '纪念日回答' ? { type: 'answer', date: body }
    : { type: match[1] === '删除纪念日' ? 'delete' : 'start', name: body };
}
module.exports = { parseAnniversaryQuizCommand, normalizeDate, HELP };
