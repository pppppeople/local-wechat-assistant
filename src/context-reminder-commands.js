'use strict';

const HELP = '请使用以下三种句式：\n下次出门时提醒我<内容>\n下次聊到<词>提醒我<内容>（关键词至少 2 字）\n下次开任务时提醒我<内容>。\n管理：我的情境提醒／取消情境提醒第N条。';

function parseContextReminderCommand(input) {
  const text = String(input || '').trim();
  if (text === '我的情境提醒') return { type: 'list' };
  const cancel = text.match(/^取消情境提醒第([1-9]\d*)条$/u);
  if (cancel) return { type: 'cancel', number: Number(cancel[1]) };
  const simple = text.match(/^下次(出门|开任务)时提醒我([\s\S]+)$/u);
  if (simple && simple[2].trim()) return { type: 'create', kind: simple[1] === '出门' ? 'outing' : 'task', text: simple[2].trim() };
  const keyword = text.match(/^下次聊到(.+?)提醒我([\s\S]+)$/u);
  if (keyword && keyword[1].trim() && keyword[2].trim()) {
    return { type: 'create', kind: 'keyword', keyword: keyword[1].trim(), text: keyword[2].trim() };
  }
  if (/^(?:我的情境提醒|取消情境提醒|情境提醒)/u.test(text) || /^下次(?:出门|聊到|开任务)/u.test(text) || /^下次.*提醒我/u.test(text)) return { type: 'invalid' };
  return null;
}

const scene = item => item.kind === 'outing' ? '下次出门时'
  : item.kind === 'task' ? '下次开任务时' : `下次聊到「${item.keyword}」时`;

module.exports = { parseContextReminderCommand, HELP, scene };
