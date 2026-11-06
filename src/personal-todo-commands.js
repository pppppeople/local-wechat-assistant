'use strict';

const DAY = 24 * 60 * 60 * 1000;
function shanghaiDay(now) {
  return new Date(new Date(now).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}
function datePhrase(phrase, now) {
  const today = shanghaiDay(now);
  if (phrase === '明天' || phrase === '后天') return addDays(today, phrase === '明天' ? 1 : 2);
  const week = phrase.match(/^(下)?周([一二三四五六日天])$/u);
  if (week) {
    const current = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const target = '一二三四五六日'.indexOf(week[2] === '天' ? '日' : week[2]);
    return addDays(today, week[1] ? 7 - current + target : (target - current + 7) % 7);
  }
  const explicit = phrase.match(/^(\d{1,2})月(\d{1,2})日$/u);
  if (!explicit) return null;
  const year = today.slice(0, 4);
  const day = `${year}-${explicit[1].padStart(2, '0')}-${explicit[2].padStart(2, '0')}`;
  const value = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === day ? day : null;
}

function extractDueDate(text, now) {
  // Only the boundary phrase is removed; punctuation, whitespace and all other
  // body characters remain verbatim. Prefer the leading phrase if both exist.
  const phrase = '(?:明天|后天|下?周[一二三四五六日天]|\\d{1,2}月\\d{1,2}日)';
  const leading = text.match(new RegExp(`^(${phrase})`, 'u'));
  const trailing = text.match(new RegExp(`(${phrase})$`, 'u'));
  for (const match of [leading, trailing]) {
    if (!match) continue;
    const dueDate = datePhrase(match[1], now);
    if (dueDate) return { text: text.slice(0, match.index) + text.slice(match.index + match[1].length), dueDate };
  }
  return { text, dueDate: null };
}

function parsePersonalTodoCommand(text) {
  const value = String(text || '');
  const control = value.trim();
  if (/^待办预算/u.test(control)) {
    const budget = control.match(/^待办预算[：:]\s*(\d+)\s*(?:分钟)?$/u);
    return { type: 'budget', minutes: budget ? Number(budget[1]) : NaN };
  }
  if (/^(?:第.*项估时|待办估时)/u.test(control)) {
    const estimate = control.match(/^第(\d+)项估时[：:]\s*(\d+)\s*(?:分钟)?$/u);
    return { type: 'estimate', number: estimate ? Number(estimate[1]) : NaN,
      estimatedMinutes: estimate ? Number(estimate[2]) : NaN };
  }
  if (control === '我的待办') return { type: 'list' };
  if (control === '每日三件事') return { type: 'daily_top_three' };
  if (control === '可开始的待办') return { type: 'ready' };
  const dependencyTarget = control.match(/^第(\d+)项前置[：:]/u);
  if (dependencyTarget) {
    const dependency = control.match(/^第(\d+)项前置[：:]\s*(第\d+项(?:\s*[、，,]\s*第\d+项)*)$/u);
    return { type: 'set_dependencies', number: Number(dependencyTarget[1]),
      numbers: dependency ? [...dependency[2].matchAll(/第(\d+)项/gu)].map(x => Number(x[1])) : [] };
  }
  let dependency = control.match(/^查看第(\d+)项依赖$/u);
  if (dependency) return { type: 'dependencies', number: Number(dependency[1]) };
  if (/^移除第\d+项依赖[：:]/u.test(control)) {
    dependency = control.match(/^移除第(\d+)项依赖[：:]\s*(?:第(\d+)项|([a-z0-9_-]+))$/iu);
    return { type: 'remove_dependency', number: dependency ? Number(dependency[1]) : NaN,
      ...(dependency?.[3] ? { dependencyId: dependency[3] }
        : { dependencyNumber: dependency?.[2] ? Number(dependency[2]) : NaN }) };
  }
  if (control === '清空已完成') return { type: 'clear_completed' };
  let match = control.match(/^(?:第(\d+)项完成|完成第(\d+)项)$/u);
  if (match) return { type: 'complete', number: Number(match[1] || match[2]) };
  match = control.match(/^取消第(\d+)项$/u);
  if (match) return { type: 'cancel', number: Number(match[1]) };
  match = value.match(/^记一下(?:[，,]\s*|\s+)([\s\S]*)$/u);
  if (match) return { type: 'add', text: match[1] };
  return null;
}

module.exports = { addDays, extractDueDate, parsePersonalTodoCommand, shanghaiDay };
