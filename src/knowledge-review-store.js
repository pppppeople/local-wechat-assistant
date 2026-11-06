'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { HELP } = require('./knowledge-review-commands');
const TTL = 20 * 60 * 1000;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const id = value => typeof value === 'string' && /^[a-z0-9_-]+$/iu.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validateState(state) {
  if (state?.schemaVersion !== 1 || typeof state.enabled !== 'boolean' || !TIME.test(state.time)
    || !Array.isArray(state.progress) || !Array.isArray(state.days)
    || [state.progress, state.days].some(rows => new Set(rows.map(row => row?.id)).size !== rows.length)
    || state.progress.some(row => !row || !id(row.id) || !timestamp(row.createdAt)
      || !Number.isSafeInteger(row.misses) || row.misses < 0
      || row.masteredOn !== null && !DATE.test(row.masteredOn))
    || state.days.some(row => !row || !DATE.test(row.id) || !timestamp(row.createdAt)
      || !['processed', 'sent', 'delivery_failed', 'draw_failed'].includes(row.status))
    || state.pending !== null && (!state.pending || !id(state.pending.id)
      || !id(state.pending.entryId) || !timestamp(state.pending.createdAt))) throw Error('知识复习存储格式无效');
}

function createKnowledgeReviewStore({ stateFile, notebook, now = () => Date.now(), random = Math.random }) {
  const load = (readOnly = false) => readRecordState(stateFile,
    { schemaVersion: 1, enabled: false, time: '21:00', progress: [], days: [], pending: null }, !readOnly,
    { strict: true, readOnly, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['progress', 'days']); };
  const fresh = pending => Boolean(pending && now() >= Date.parse(pending.createdAt)
    && now() - Date.parse(pending.createdAt) < TTL);
  function hasPending(side) {
    if (side !== 'owner') return false;
    try { return fresh(load(true).pending); } catch { return false; }
  }
  function draw(state) {
    const entries = notebook.readEntries('owner');
    const mastered = new Set(state.progress.filter(row => row.masteredOn).map(row => row.id));
    const pool = entries.filter(row => !mastered.has(row.id));
    if (!pool.length) {
      state.pending = null; save(state);
      return entries.length ? '知识本中的条目已全部掌握。' : '知识本为空，请先记录知识。';
    }
    const entry = pool[Math.floor(random() * pool.length)];
    state.pending = { id: crypto.randomUUID(), entryId: entry.id, createdAt: new Date(now()).toISOString() };
    save(state);
    return `${entry.title}\n${entry.content}\n\n20 分钟内回复「会了」或「不会」自评。`;
  }
  function execute(side, command) {
    if (side !== 'owner') return '这个私人助手只供已绑定的本人使用。';
    if (!command || !['draw', 'stats', 'master', 'miss', 'enable', 'disable'].includes(command.type)) return HELP;
    const state = load();
    if (command.type === 'draw') return draw(state);
    if (command.type === 'stats') {
      const entries = notebook.readEntries('owner');
      const mastered = entries.filter(entry => state.progress.some(row => row.id === entry.id && row.masteredOn)).length;
      return `复习统计：知识本总数 ${entries.length}｜已掌握 ${mastered}｜待复习 ${entries.length - mastered}`;
    }
    if (command.type === 'enable') {
      if (typeof command.time !== 'string' || !TIME.test(command.time)) return HELP;
      state.enabled = true; state.time = command.time; save(state);
      return `已开启每日复习，每天 ${state.time}（上海时间）抽题。`;
    }
    if (command.type === 'disable') { state.enabled = false; save(state); return '已关闭每日复习。'; }
    if (!fresh(state.pending)) return '当前没有待自评题目，请先发送「复习知识」。';
    const entry = notebook.readEntries('owner').find(row => row.id === state.pending.entryId);
    state.pending = null;
    if (!entry) { save(state); return '该知识条目已删除，请重新发送「复习知识」。'; }
    let progress = state.progress.find(row => row.id === entry.id);
    if (!progress) {
      progress = { id: entry.id, createdAt: new Date(now()).toISOString(), misses: 0, masteredOn: null };
      state.progress.push(progress);
    }
    if (command.type === 'master') progress.masteredOn = shanghaiDay(now());
    else { progress.misses++; progress.masteredOn = null; }
    save(state);
    return command.type === 'master' ? `已标记掌握：${entry.title}（${progress.masteredOn}）`
      : `已记录未掌握：${entry.title}（累计 ${progress.misses} 次），仍在待复习池。`;
  }
  async function tick(deliver) {
    const clock = now(), local = new Date(clock + 8 * 3600000).toISOString(), date = local.slice(0, 10);
    const state = load();
    if (!state.enabled || local.slice(11, 16) < state.time || state.days.some(row => row.id === date)) return false;
    // Claim before reading/drawing/dispatch, matching the daily theater's no-replay scan.
    state.days.push({ id: date, createdAt: new Date(clock).toISOString(), status: 'processed' }); save(state);
    function finish(status, failedPendingId) {
      const current = load();
      current.days.find(row => row.id === date).status = status;
      if (failedPendingId && current.pending?.id === failedPendingId) current.pending = null;
      save(current);
    }
    let text;
    try { text = draw(state); } catch { finish('draw_failed'); return false; }
    const pendingId = state.pending?.id;
    try { await deliver(text, `knowledge-review-${date}`); }
    catch { finish('delivery_failed', pendingId); return false; }
    finish('sent'); return true;
  }
  return { execute, hasPending, tick };
}

module.exports = { createKnowledgeReviewStore };
