'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const ROUND_TTL_MS = 24 * 60 * 60 * 1000;
const SIDES = ['owner', 'friend'];
const HELP = '请用「盲盒答：<答案>」作答（1–200 字），双方都答完才揭晓。';
const normalizeAnswer = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
function validSide(side) {
  if (!SIDES.includes(side)) throw new Error('invalid blindbox side');
}
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
// Only real shared-place fields. updatedAt is a record date, never a visit date.
function selectQuestions(records) {
  const candidates = records.filter(record => record?.status === 'visited' && validText(record.name)
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
    && /^\d{4}-\d{2}-\d{2}T/u.test(record.updatedAt));
  const dateOf = record => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(record.updatedAt));
  const dates = candidates.map(dateOf);
  return candidates.flatMap((record, index) => {
    const date = dates[index];
    if (dates.filter(value => value === date).length !== 1) return [];
    return [{ date, type: '去过地点', text: '这条标为去过的共享地点记录，地点叫什么？',
      answer: record.name.trim(), original: `地点：${record.name.trim()}｜状态：visited（去过）｜updatedAt：${record.updatedAt}` }];
  });
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.rounds) || state.rounds.length > 1
    || !Number.isSafeInteger(state.played) || state.played < 0 || !Number.isSafeInteger(state.matched)
    || state.matched < 0 || state.matched > state.played) throw new Error('回忆盲盒存储格式无效');
  for (const round of state.rounds) {
    const q = round?.question;
    if (!round || typeof round.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(round.id)
      || !SIDES.includes(round.createdBy) || round.status !== 'collecting'
      || typeof round.createdAt !== 'string' || !Number.isFinite(Date.parse(round.createdAt))
      || !q || !/^\d{4}-\d{2}-\d{2}$/u.test(q.date) || q.type !== '去过地点'
      || !validText(q.text) || !validText(q.answer) || !normalizeAnswer(q.answer)
      || typeof q.original !== 'string' || q.original.length > 500 || !q.original.includes(q.answer)
      || !round.answers || typeof round.answers !== 'object' || Array.isArray(round.answers)
      || Object.keys(round.answers).length > 1
      || Object.entries(round.answers).some(([side, answer]) => !SIDES.includes(side) || !validText(answer) || !normalizeAnswer(answer))) {
      throw new Error('回忆盲盒轮次格式无效');
    }
  }
}
function createMemoryBlindboxStore({ stateFile, readSharedMemory, now = () => Date.now(), random = Math.random,
  onNotice = () => {}, sideNames = { owner: 'Owner', friend: '好友' } }) {
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['rounds']); }
  function load() {
    const state = readRecordState(stateFile, { schemaVersion: 1, rounds: [], played: 0, matched: 0 }, true,
      { strict: true, now, validate: validateState });
    if (state.rounds[0] && now() - Date.parse(state.rounds[0].createdAt) >= ROUND_TTL_MS) {
      state.rounds = []; save(state);
    }
    return state;
  }
  const stats = state => `盲盒默契 ${state.matched}/${state.played} 次`;
  const prompt = q => `${q.date}（记录更新日）｜${q.type}\n${q.text}`;
  function handle(side, command) {
    validSide(side);
    if (!command || !['start', 'answer', 'cancel', 'stats', 'help'].includes(command.type)) throw new Error('不支持的回忆盲盒命令');
    const state = load(), round = state.rounds[0];
    if (command.type === 'stats') return stats(state);
    if (command.type === 'help') return HELP;
    if (command.type === 'start') {
      if (round) return `当前回忆盲盒仍在进行，不能重复开局。\n${prompt(round.question)}\n${HELP}`;
      const records = readSharedMemory(side);
      const questions = selectQuestions(Array.isArray(records) ? records : []).filter(q => normalizeAnswer(q.answer));
      if (!questions.length) return '没有可确定答案的共享记忆条目（可能缺答案、有效日期或同日记录不唯一），本次未开局。';
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源无效');
      const created = { id: crypto.randomUUID(), status: 'collecting', question: questions[Math.floor(value * questions.length)],
        createdAt: new Date(now()).toISOString(), createdBy: side, answers: {} };
      state.rounds = [created]; save(state);
      const text = `回忆盲盒开始！\n${prompt(created.question)}\n${HELP}\n24 小时未答齐自动作废。`;
      onNotice(side === 'owner' ? 'friend' : 'owner', text, `memory-blindbox-created|${created.id}`);
      return text;
    }
    if (!round) return '现在没有进行中的回忆盲盒（可能已过期）。可以说「回忆盲盒」。';
    if (command.type === 'cancel') {
      state.rounds = []; save(state);
      onNotice(side === 'owner' ? 'friend' : 'owner', '本轮回忆盲盒已结束，未计入统计。', `memory-blindbox-cancelled|${round.id}`);
      return '已结束本轮回忆盲盒，未计入统计。';
    }
    if (!validText(command.answer) || !normalizeAnswer(command.answer)) return HELP;
    if (round.answers[side]) return '你的答案已封存，不能修改，等双方答完再揭晓。';
    round.answers[side] = command.answer.trim();
    if (!SIDES.every(item => round.answers[item])) { save(state); return '答案已封存，等对方作答。'; }
    const matched = normalizeAnswer(round.answers.owner) === normalizeAnswer(round.answers.friend);
    state.played++; if (matched) state.matched++;
    state.rounds = []; save(state);
    const result = ['回忆盲盒揭晓：', ...SIDES.map(item => `${sideNames[item]}：${round.answers[item]}`),
      `原始记录（共享字段）：${round.question.original}`, matched ? '双方答案一致！' : '双方答案不一致。',
      '一致仅比较双方答案，不代表答对原记录。', stats(state)].join('\n');
    for (const recipient of SIDES) onNotice(recipient, result, `memory-blindbox-result|${round.id}|${recipient}`);
    return '双方已答完，揭晓已交给通知通道。';
  }
  function hasPending(side) { validSide(side); return Boolean(load().rounds.length); }
  function deleteSide(side) {
    validSide(side); const removed = load().rounds.length;
    save({ schemaVersion: 1, rounds: [], played: 0, matched: 0 }); return { removed };
  }
  return { handle, hasPending, deleteSide };
}
module.exports = { createMemoryBlindboxStore, selectQuestions, normalizeAnswer, ROUND_TTL_MS };
