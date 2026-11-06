'use strict';

const { readRecordState, writeRecordState } = require('./record-state');
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const DEFAULT_THEME = '轻松日常';
function validateState(state) {
  if (state?.schemaVersion !== 1 || typeof state.enabled !== 'boolean' || !TIME.test(state.time)
    || typeof state.theme !== 'string' || !state.theme.trim() || state.theme.length > 200
    || !Array.isArray(state.days) || new Set(state.days.map(day => day.id)).size !== state.days.length
    || state.days.some(day => !/^\d{4}-\d{2}-\d{2}$/u.test(day.id)
      || !['processed', 'sent', 'generation_failed', 'delivery_failed'].includes(day.status)
      || !Number.isFinite(Date.parse(day.createdAt)))) throw Error('小剧场存储格式无效');
}
function createDailyTheaterStore({ stateFile, provider, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile,
    { schemaVersion: 1, enabled: false, time: '21:00', theme: DEFAULT_THEME, days: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['days']); };
  async function generate(theme) {
    const text = await provider.generate({ theme });
    // Injected providers obey the same complete-result boundary as the model adapter.
    const lines = typeof text === 'string' ? text.split('\n') : [];
    if (lines.length < 3 || lines.length > 5 || lines.some(line => !line.trim() || line.length > 200 || /\r/u.test(line))) {
      throw Error('invalid daily theater output');
    }
    return text;
  }
  async function execute(side, command) {
    if (side !== 'owner') return 'AI 每日小剧场仅主人可用。';
    if (!command || command.type === 'invalid') return '小剧场设置未修改：时间请用 HH:mm（如 21:30），主题请填 1–200 字。';
    const state = load();
    switch (command.type) {
      case 'enable':
        if (typeof command.time !== 'string' || !TIME.test(command.time)) return '小剧场时间无效，请用 HH:mm。';
        state.enabled = true; state.time = command.time; save(state);
        return `已开启小剧场，每天 ${state.time}（上海时间）推送。`;
      case 'disable': state.enabled = false; save(state); return '已关闭小剧场每日推送。';
      case 'theme':
        if (typeof command.theme !== 'string' || !command.theme.trim() || command.theme.length > 200) return '小剧场主题请填 1–200 字。';
        state.theme = command.theme.trim(); save(state); return `小剧场主题已设为：${state.theme}`;
      case 'settings': return `小剧场设置：${state.enabled ? '已开启' : '已关闭'}；每天 ${state.time}（上海时间）；主题：${state.theme}。`;
      case 'generate':
        try { return await generate(state.theme); } catch { return '小剧场这次生成失败，请稍后再试。'; }
      default: throw Error('不支持的小剧场命令');
    }
  }
  async function tick(deliver) {
    const clock = now();
    const local = new Date(clock + 8 * 3600000).toISOString();
    const date = local.slice(0, 10);
    const state = load();
    if (!state.enabled || local.slice(11, 16) < state.time || state.days.some(day => day.id === date)) return false;
    // Synchronous durable claim BEFORE generation/dispatch; concurrent scans and restarts cannot replay.
    state.days.push({ id: date, createdAt: new Date(clock).toISOString(), status: 'processed' });
    save(state);
    function finish(status) {
      const current = load(); // Preserve commands received while the provider/delivery was awaiting.
      current.days.find(day => day.id === date).status = status; save(current);
    }
    let text;
    try { text = await generate(state.theme); } catch { finish('generation_failed'); return false; }
    try { await deliver(text, `daily-theater-${date}`); } catch { finish('delivery_failed'); return false; }
    finish('sent');
    return true;
  }
  return { execute, tick };
}
module.exports = { createDailyTheaterStore };
