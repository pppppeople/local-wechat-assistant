'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');

const ROUND_TTL_MS = 24 * 60 * 60 * 1000;
const QUESTIONS = Object.freeze([
  ['理想的周末是？', '宅家', '出门逛', '约朋友', '说走就走'],
  ['旅行最想去哪里？', '海边', '山里', '古城', '大都市'],
  ['下雨天最想做什么？', '看电影', '睡觉', '读书', '听雨喝茶'],
  ['聚餐更想吃什么？', '火锅', '烧烤', '日料', '家常菜'],
  ['出游更喜欢哪种节奏？', '提前排满', '只定大方向', '随走随停', '让同伴决定'],
  ['更喜欢哪种礼物？', '实用物品', '手写信', '一起体验', '惊喜盲盒'],
  ['一天中最喜欢哪个时段？', '清晨', '午后', '傍晚', '深夜'],
  ['看电影更想选哪类？', '喜剧', '悬疑', '科幻', '动画'],
  ['休息时最想喝什么？', '咖啡', '奶茶', '果汁', '清茶'],
  ['拍照最喜欢拍什么？', '风景', '美食', '人物', '街头日常'],
  ['突然多一天假会怎么过？', '补觉', '短途旅行', '整理房间', '见朋友'],
  ['散步时更喜欢哪里？', '公园', '江边', '老街', '商场'],
].map(([text, ...options], index) => Object.freeze({
  id: `Q${index + 1}`, text, options: Object.freeze(options),
})));
const SIDES = ['owner', 'friend'];
function validSide(side) {
  if (!SIDES.includes(side)) throw new Error('invalid challenge side');
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.rounds) || state.rounds.length > 1
    || !Number.isSafeInteger(state.played) || state.played < 0
    || !Number.isSafeInteger(state.matched) || state.matched < 0 || state.matched > state.played) {
    throw new Error('默契挑战存储格式无效');
  }
  for (const round of state.rounds) {
    const question = QUESTIONS.find(item => item.id === round?.question?.id);
    if (!round || typeof round.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(round.id) || !SIDES.includes(round.createdBy)
      || round.status !== 'collecting' || typeof round.createdAt !== 'string' || !Number.isFinite(Date.parse(round.createdAt))
      || !question || round.question.text !== question.text
      || JSON.stringify(round.question.options) !== JSON.stringify(question.options)
      || !round.answers || typeof round.answers !== 'object' || Array.isArray(round.answers)
      || Object.entries(round.answers).some(([side, answer]) => !SIDES.includes(side) || !/^[A-D]$/u.test(answer))
      || Object.keys(round.answers).length > 1) throw new Error('默契挑战轮次格式无效');
  }
}

function createPairChallengeStore({ stateFile, now = () => Date.now(), random = Math.random,
  onNotice = () => {}, sideNames = { owner: 'Owner', friend: '好友' } }) {
  function save(state) {
    validateState(state);
    writeRecordState(stateFile, state, ['rounds']);
  }
  function load() {
    const state = readRecordState(stateFile, { schemaVersion: 1, rounds: [], played: 0, matched: 0 }, true,
      { strict: true, now, validate: validateState });
    if (state.rounds[0] && now() - Date.parse(state.rounds[0].createdAt) >= ROUND_TTL_MS) {
      state.rounds = [];
      save(state);
    }
    return state;
  }
  const questionText = round => [round.question.text,
    ...round.question.options.map((option, index) => `${'ABCD'[index]}. ${option}`)].join('\n');
  const statsText = state => `默契战绩：共玩 ${state.played} 轮、默契 ${state.matched} 次。`;
  function hasPending(side) {
    validSide(side);
    return Boolean(load().rounds.length);
  }
  function handle(side, command) {
    validSide(side);
    if (!command || !['start', 'answer', 'cancel', 'stats', 'help'].includes(command.type)) throw new Error('不支持的默契挑战命令');
    const state = load();
    const round = state.rounds[0];
    if (command.type === 'help') return '请用「默契答 A」作答，字母可选 A–D，大小写均可。';
    if (command.type === 'stats') return statsText(state);
    if (command.type === 'start') {
      if (round) return `当前默契挑战仍在进行：\n${questionText(round)}\n还没答：${SIDES.filter(item => !round.answers[item]).map(item => sideNames[item]).join('、')}。\n请回复「默契答 A」（A–D），双方都答完才揭晓。`;
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源无效');
      const created = { id: crypto.randomUUID(), status: 'collecting', question: QUESTIONS[Math.floor(value * QUESTIONS.length)],
        answers: {}, createdBy: side, createdAt: new Date(now()).toISOString() };
      state.rounds = [created];
      save(state);
      const text = `默契挑战开始！\n${questionText(created)}\n请回复「默契答 A」（A–D），双方都答完才揭晓；24 小时未答齐自动作废。`;
      onNotice(side === 'owner' ? 'friend' : 'owner', text, `pair-challenge-created|${created.id}`);
      return text;
    }
    if (!round) return '现在没有进行中的默契挑战（可能已过期）。可以说「来一轮默契挑战」。';
    if (command.type === 'cancel') {
      state.rounds = [];
      save(state);
      onNotice(side === 'owner' ? 'friend' : 'owner', '本轮默契挑战已结束，未计入战绩。', `pair-challenge-cancelled|${round.id}`);
      return '已结束本轮默契挑战，未计入战绩。';
    }
    const answer = String(command.answer || '').toUpperCase();
    if (!/^[A-D]$/u.test(answer)) return '请用「默契答 A」作答，字母可选 A–D。';
    if (round.answers[side]) return '你已答过，不能修改。等对方作答后揭晓。';
    round.answers[side] = answer;
    if (!SIDES.every(item => round.answers[item])) {
      save(state);
      return '已记下，等对方作答';
    }
    state.played++;
    const matched = round.answers.owner === round.answers.friend;
    if (matched) state.matched++;
    state.rounds = [];
    save(state);
    const result = [`默契挑战揭晓：${round.question.text}`, ...SIDES.map(item => {
      const letter = round.answers[item];
      return `${sideNames[item]}：${letter}. ${round.question.options['ABCD'.indexOf(letter)]}`;
    }), matched ? '默契一致！' : '这次选择不同。', statsText(state)].join('\n');
    for (const recipient of SIDES) onNotice(recipient, result, `pair-challenge-result|${round.id}|${recipient}`);
    return '双方已答完，揭晓已交给通知通道。';
  }
  function deleteSide(side) {
    validSide(side);
    const state = load();
    const removed = state.rounds.length;
    save({ schemaVersion: 1, rounds: [], played: 0, matched: 0 });
    return { removed };
  }
  return { handle, hasPending, deleteSide };
}

module.exports = { QUESTIONS, ROUND_TTL_MS, createPairChallengeStore };
