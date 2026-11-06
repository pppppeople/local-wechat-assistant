'use strict';

const { readRecordState } = require('./record-state');
const { refused, unchanged } = require('./feature-result');
const { shanghaiDay, addDays } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');

const REFUSAL = '习惯热力图仅供主人使用，好友不能查看习惯数据。';
const HELP = '请发送“习惯热力图”、“习惯热力图 7天”或“习惯热力图 7天：习惯名”；窗口只支持 7/14/30 天，默认 30 天。';
const WINDOWS = [7, 14, 30];

function parseHabitCalendarCommand(input) {
  const text = String(input || '').trim();
  if (!/^习惯热力图(?:$|[\s：:0-9])/u.test(text)) return null;
  const match = text.match(/^习惯热力图(?:\s*(\d+)\s*天)?(?:\s*[：:]\s*([^\r\n]+))?$/u);
  if (!match || (match[2] !== undefined && !match[2].trim())) return { type: 'invalid' };
  const windowDays = match[1] === undefined ? 30 : Number(match[1]);
  return WINDOWS.includes(windowDays)
    ? { type: 'calendar', windowDays, name: match[2]?.trim() || null } : { type: 'invalid' };
}

// Validate report fields without changing or quarantining the source. Duplicate
// dates are accepted here and counted once by the report's Set.
function validateCalendarState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.habits)
    || state.habits.some(item => !item || typeof item.name !== 'string' || !item.name.trim()
      || !['active', 'archived'].includes(item.status) || !Array.isArray(item.days)
      || item.days.some(day => !validDay(day))
      || (item.status === 'archived' && !Number.isFinite(Date.parse(item.archivedAt))))) {
    throw new Error('习惯热力图数据格式无效');
  }
}

function summarizeHabitCalendar(habit, dates) {
  const cutoff = habit.status === 'archived' ? shanghaiDay(habit.archivedAt) : dates.at(-1);
  const checked = new Set(habit.days.filter(day => day <= cutoff));
  let completed = 0;
  let streak = 0;
  let longest = 0;
  const calendar = dates.map(day => {
    if (!checked.has(day)) { streak = 0; return '·'; }
    completed++;
    longest = Math.max(longest, ++streak);
    return '■';
  }).join('');
  return { completed, rate: Number((completed / dates.length * 100).toFixed(1)), longest, calendar };
}

function createHabitCalendar({ stateFile, now = () => Date.now(),
  readState = () => readRecordState(stateFile, { schemaVersion: 1, habits: [] }, true,
    { strict: true, readOnly: true, validate: validateCalendarState }) }) {
  function execute(side, command) {
    if (side !== 'owner') return refused(REFUSAL);
    if (command?.type !== 'calendar' || !WINDOWS.includes(command.windowDays)
      || (command.name !== null && (typeof command.name !== 'string' || !command.name.trim()))) return refused(HELP);
    let state;
    try { state = readState(); validateCalendarState(state); } catch {
      return refused('习惯热力图读取未完成，请检查并恢复习惯存储后再试。');
    }
    const items = state.habits.filter(item => command.name ? item.name === command.name : item.status === 'active');
    if (!items.length) return unchanged(command.name ? '未找到这个习惯，无数据。请使用完整名称。'
      : '暂无进行中的习惯，无数据。归档习惯需用“习惯热力图：完整习惯名”查看历史。');
    const today = shanghaiDay(now());
    const dates = Array.from({ length: command.windowDays }, (_, i) => addDays(today, i + 1 - command.windowDays));
    const header = `图例：■ 已打卡，· 未打卡；每字符 1 天，从左到右按上海日期排列。\n${dates[0]} 至 ${today}（含今天，共 ${dates.length} 天）；最长连续仅统计本窗口。`;
    const rows = items.map(item => {
      const summary = summarizeHabitCalendar(item, dates);
      return `${item.name}${item.status === 'archived' ? '（已归档，历史只读）' : ''}\n完成 ${summary.completed}/${dates.length} 天｜完成率 ${summary.rate}%｜最长连续打卡 ${summary.longest} 天\n${summary.calendar}${summary.completed ? '' : '\n本窗口无打卡记录，无数据。'}`;
    });
    return unchanged([header, ...rows].join('\n\n'));
  }
  return { execute };
}

module.exports = { parseHabitCalendarCommand, createHabitCalendar, summarizeHabitCalendar, HELP, REFUSAL };
