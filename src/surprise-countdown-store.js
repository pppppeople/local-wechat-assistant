'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.events)) throw new Error('倒计时存储格式无效');
  const ids = new Set();
  for (const event of state.events) {
    if (!event || typeof event.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(event.id) || ids.has(event.id)
      || typeof event.name !== 'string' || !event.name.trim() || !validDay(event.date)
      || typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt))
      || typeof event.reminded !== 'boolean') throw new Error('倒计时记录格式无效');
    ids.add(event.id);
  }
}

function createSurpriseCountdownStore({ stateFile, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, events: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['events']); };
  const active = (event, today) => !event.reminded && event.date >= today;
  const example = '请写清事件名和未过期日期，例如「倒计时：平安夜 2026-12-24」或「倒计时：出游 明天」。';
  function handle(side, command) {
    if (side !== 'owner') return '惊喜倒计时仅主人可用。';
    if (!command || command.type === 'invalid') return `没有执行倒计时操作：日期无法解析或命令不完整。${example}`;
    const today = shanghaiDay(now());
    const state = load();
    if (command.type === 'create') {
      if (typeof command.name !== 'string' || !command.name.trim() || !validDay(command.date)) return `没有新增倒计时：事件名或日期无效。${example}`;
      if (command.date < today) return `没有新增倒计时：日期已过。${example}`;
      const name = command.name.trim();
      const existing = state.events.find(event => event.name === name && active(event, today));
      if (existing) return `没有新增：同一事件「${name}」已有未到期倒计时（${existing.date}），请先删除再创建。`;
      state.events.push({ id: crypto.randomUUID(), name, date: command.date,
        createdAt: new Date(now()).toISOString(), reminded: false });
      save(state);
      return `已创建倒计时：${name}，${command.date}（Asia/Shanghai）。`;
    }
    if (command.type === 'list') {
      const events = state.events.filter(event => active(event, today)).sort((a, b) => a.date.localeCompare(b.date));
      return events.length ? `我的倒计时：\n${events.map(event => {
        const days = (Date.parse(`${event.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
        return `${event.name}，${event.date}，${days === 0 ? '就是今天' : `还剩 ${days} 天`}`;
      }).join('\n')}` : '暂无未到期倒计时。';
    }
    if (command.type !== 'delete') throw new Error('不支持的倒计时命令');
    const events = state.events.filter(event => event.name !== command.name);
    if (events.length === state.events.length) return `不存在「${command.name}」的倒计时。`;
    state.events = events; save(state);
    return `已删除「${command.name}」的倒计时。`;
  }
  async function tick(deliver) {
    const state = load();
    const today = shanghaiDay(now());
    const event = state.events.find(item => !item.reminded && item.date === today);
    if (!event) return false;
    // Persist the archive marker first: one application dispatch, no retry on failure/restart.
    event.reminded = true; save(state);
    await deliver(`今天就是${event.name}的日子！`, `surprise-countdown-${event.id}-${event.date}`);
    return true;
  }
  return { handle, tick };
}

module.exports = { createSurpriseCountdownStore };
