'use strict';

const { shanghaiDay, addDays } = require('./personal-todo-commands');
const { refused, unchanged } = require('./feature-result');
const REFUSAL = '工作周报仅主人可用，好友不能读取工作日志或个人待办。';
const HELP = '请发送“工作周报”“工作周报 上周”或“工作周报 YYYY-MM-DD”（有效日期）。';

function validDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) && Number.isFinite(value.getTime())
    && value.toISOString().slice(0, 10) === date;
}

function parseWeeklyWorkReportCommand(text) {
  const value = String(text || '').trim();
  if (value === '工作周报') return { type: 'report', week: 'current' };
  const match = value.match(/^工作周报\s+(.+)$/u);
  if (!match) return null;
  if (match[1] === '上周') return { type: 'report', week: 'previous' };
  return validDate(match[1]) ? { type: 'report', date: match[1] } : { type: 'invalid' };
}

function weekDays(command, clock) {
  const date = command.date || shanghaiDay(clock);
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(date, -weekday - (command.week === 'previous' ? 7 : 0));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function createWeeklyWorkReport({ todos, worklogs, provider, now = () => Date.now() }) {
  return { async execute(side, command) {
    // Admission and date validation precede even the clock and all business reads.
    if (side !== 'owner') return refused(REFUSAL);
    if (command?.type !== 'report' || (command.date ? !validDate(command.date)
      : !['current', 'previous'].includes(command.week))) return refused(HELP);
    try {
      const days = weekDays(command, now());
      const entries = days.map(date => ({ date, logs: worklogs.readDailyEntries(side, date),
        ...todos.readDailyChanges(side, date) }));
      return unchanged(await provider.generate({ start: days[0], end: days[6], entries }));
    } catch {
      return refused('工作周报生成失败，请稍后重试。');
    }
  } };
}

module.exports = { parseWeeklyWorkReportCommand, createWeeklyWorkReport, REFUSAL };
