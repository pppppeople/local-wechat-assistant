'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { HELP, scene } = require('./context-reminder-commands');
const kinds = ['outing', 'keyword', 'task'];
const nonempty = value => typeof value === 'string' && !!value.trim();
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validKeyword = value => nonempty(value) && [...value].length >= 2;

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.reminders)
    || state.reminders.filter(item => item?.status === 'active').length > 20
    || new Set(state.reminders.map(item => item?.id)).size !== state.reminders.length
    || state.reminders.some(item => !item || !/^[a-z0-9_-]+$/iu.test(item.id || '')
      || !kinds.includes(item.kind) || !nonempty(item.text) || !date(item.createdAt)
      || !['active', 'archived'].includes(item.status)
      || (item.kind === 'keyword' && !validKeyword(item.keyword))
      || (item.status === 'archived' && (!date(item.archivedAt) || !['triggered', 'cancelled'].includes(item.reason))))) {
    throw new Error('情境提醒存储格式无效');
  }
}

function createContextReminderStore({ stateFile, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, reminders: [] }, true,
    { strict: true, now, validate: validateState });
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['reminders']); }
  function handle(side, command) {
    if (side !== 'owner') return '情境提醒仅主人可用。';
    if (!command || command.type === 'invalid') return HELP;
    const state = load();
    const active = state.reminders.filter(item => item.status === 'active');
    if (command.type === 'list') return active.length
      ? `待触发的情境提醒：\n${active.map((item, i) => `${i + 1}. ${scene(item)}：${item.text}`).join('\n')}` : '暂无待触发的情境提醒。';
    if (command.type === 'cancel') {
      if (!Number.isSafeInteger(command.number) || command.number < 1 || command.number > active.length) return '情境提醒序号无效，请发送「我的情境提醒」查看当前编号。';
      Object.assign(active[command.number - 1], { status: 'archived', archivedAt: new Date(now()).toISOString(), reason: 'cancelled' });
      save(state);
      return '已取消该情境提醒。';
    }
    if (command.type !== 'create' || !kinds.includes(command.kind) || !nonempty(command.text)) return HELP;
    if (command.kind === 'keyword' && !validKeyword(command.keyword)) return `关键词至少 2 字，未创建提醒。\n${HELP}`;
    if (active.length >= 20) return '最多 20 条待触发的情境提醒，请先取消一些再设置。';
    const item = { id: crypto.randomUUID(), kind: command.kind, text: command.text.trim(),
      ...(command.kind === 'keyword' ? { keyword: command.keyword } : {}),
      status: 'active', createdAt: new Date(now()).toISOString() };
    state.reminders.push(item);
    save(state);
    return `已设置情境提醒：${scene(item)}：${item.text}`;
  }
  async function trigger(side, event, deliver) {
    // Admission precedes all owner storage reads, including keyword checks.
    if (side !== 'owner' || !event || !['outing', 'message', 'task'].includes(event.type)) return false;
    const state = load();
    const matches = state.reminders.filter(item => item.status === 'active' && (event.type === 'message'
      ? item.kind === 'keyword' && typeof event.text === 'string' && event.text.includes(item.keyword)
      : item.kind === event.type));
    if (!matches.length) return false;
    const archivedAt = new Date(now()).toISOString();
    for (const item of matches) Object.assign(item, { status: 'archived', archivedAt, reason: 'triggered' });
    // Claim the entire event before any await. Repeated events, failed delivery
    // and restart never replay a claimed reminder (same contract as focus tick).
    save(state);
    await deliver(matches.map(item => `${item.text}\n场景：${scene(item)}`).join('\n\n'), `context-reminder-${matches[0].id}`);
    return true;
  }
  return { handle, trigger };
}

module.exports = { createContextReminderStore };
