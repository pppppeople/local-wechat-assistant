'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { describeTimestamp } = require('./friend-relay-commands');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.cards) || state.cards.length > 100) throw new Error('复盘卡存储格式无效');
  const numbers = new Set(), ids = new Set();
  for (const card of state.cards) {
    if (!card || typeof card.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(card.id) || ids.has(card.id)
      || !Number.isSafeInteger(card.number) || card.number < 1 || numbers.has(card.number)
      || typeof card.decision !== 'string' || !card.decision.trim() || typeof card.reason !== 'string'
      || !['open', 'closed'].includes(card.status) || !validDate(card.createdAt)
      || !validDate(card.dueAt) || typeof card.asked !== 'boolean' || typeof card.reviewed !== 'boolean'
      || !Array.isArray(card.reviews) || card.reviews.some(review => !validDate(review.date)
        || typeof review.thought !== 'string' || !review.thought.trim())) throw new Error('复盘卡记录格式无效');
    numbers.add(card.number); ids.add(card.id);
  }
}

function createDecisionReviewStore({ stateFile, now = () => Date.now() }) {
  const load = (readOnly = false) => readRecordState(stateFile, { schemaVersion: 1, cards: [] }, true,
    { strict: true, readOnly, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['cards']); };
  const due = card => card.status === 'open' && !card.reviewed && Date.parse(card.dueAt) <= now();
  const date = value => `${describeTimestamp(value)}（Asia/Shanghai）`;
  function hasPending(side = 'owner') {
    if (side !== 'owner') return false;
    try { return load(true).cards.filter(due).length === 1; } catch { return false; }
  }
  function handle(side, command) {
    if (side !== 'owner') return '决定复盘卡仅主人可用。';
    if (!command || command.type === 'invalid') return '复盘卡操作未执行：请写清决定、复盘内容或未来日期，例如「记决定：先做直达，因为改签风险低，下个月 15 号复盘」。';
    const state = load();
    if (command.type === 'create') {
      if (state.cards.length >= 100) return '复盘卡已达 100 张上限（含已关闭），没有新增。';
      if (!command.decision?.trim() || typeof command.reason !== 'string' || !validDate(command.dueAt)
        || Date.parse(command.dueAt) <= now()) return '没有新增：决定或未来复盘日期无效。';
      const card = { id: crypto.randomUUID(), number: Math.max(0, ...state.cards.map(item => item.number)) + 1,
        decision: command.decision, reason: command.reason, createdAt: new Date(now()).toISOString(),
        dueAt: command.dueAt, status: 'open', asked: false, reviewed: false, reviews: [] };
      state.cards.push(card); save(state);
      return `已记第 ${card.number} 张复盘卡：${card.decision}\n原因：${card.reason || '未记原因'}\n${command.defaultDate ? '未指定复盘日期，默认 30 天后；' : ''}复盘日：${date(card.dueAt)}`;
    }
    if (command.type === 'list') {
      const pending = state.cards.filter(card => card.status === 'open' && !card.reviewed);
      return pending.length ? `待复盘卡：\n${pending.map(card => `第 ${card.number} 张：${card.decision.slice(0, 60)}；复盘日：${date(card.dueAt)}`).join('\n')}` : '暂无待复盘卡。';
    }
    const pending = state.cards.filter(due);
    const card = command.type === 'review' && command.number == null
      ? (pending.length === 1 ? pending[0] : null) : state.cards.find(item => item.number === command.number);
    if (!card) return '未找到可操作的复盘卡；请使用「复盘第 N 张：新想法」指定编号。';
    if (command.type === 'show') return `第 ${card.number} 张复盘卡（${card.status === 'closed' ? '已关闭' : card.reviewed ? '本轮已复盘，未约下次' : '待复盘'}）\n决定：${card.decision}\n原因：${card.reason || '未记原因'}\n复盘日：${date(card.dueAt)}\n历次复盘：\n${card.reviews.map(review => `${date(review.date)}：${review.thought}`).join('\n') || '暂无'}`;
    if (card.status === 'closed') return '该复盘卡已关闭。';
    if (command.type === 'reschedule') {
      if (!validDate(command.dueAt) || Date.parse(command.dueAt) <= now()) return '没有改期：请指定未来日期。';
      card.dueAt = command.dueAt; card.asked = false; card.reviewed = false;
      save(state); return `第 ${card.number} 张已改期，复盘日：${date(card.dueAt)}`;
    }
    if (command.type !== 'review') throw new Error('不支持的复盘卡命令');
    if (!command.thought?.trim() || (command.close && command.dueAt)
      || (command.dueAt && (!validDate(command.dueAt) || Date.parse(command.dueAt) <= now()))) return '复盘未记录：内容或下次日期无效。';
    card.reviews.push({ date: new Date(now()).toISOString(), thought: command.thought });
    card.reviewed = true;
    if (command.close) card.status = 'closed';
    else if (command.dueAt) { card.dueAt = command.dueAt; card.asked = false; card.reviewed = false; }
    save(state);
    return `第 ${card.number} 张已追加复盘。${command.close ? '已关闭，不再询问。' : command.dueAt
      ? `下次复盘日：${date(card.dueAt)}` : '本轮已复盘；未约下次，可随时显式追加或改期。'}`;
  }
  async function tick(deliver) {
    const state = load();
    const card = state.cards.find(item => due(item) && !item.asked);
    if (!card) return false;
    // One application dispatch per round: persist first, never retry failure/restart.
    card.asked = true; save(state);
    await deliver(`第 ${card.number} 张复盘卡到期了。\n原决定：${card.decision}\n原因：${card.reason || '未记原因'}\n现在想法有变化吗？回复「复盘第 ${card.number} 张：新想法」，可附「，再过一个月看」或「，复盘完了」。`,
      `decision-review-${card.id}-${Date.parse(card.dueAt)}`);
    return true;
  }
  return { handle, hasPending, tick };
}

module.exports = { createDecisionReviewStore };
