'use strict';

const { readRecordState, writeRecordState } = require('./record-state');

// Handwritten clues with fixed answers; no generation or model judging.
const QUESTIONS = Object.freeze([
  ['字谜：把“日”和“月”左右并排，组成哪个字？', '明', '左边是日，右边是月。'],
  ['字谜：“木”字上面加一撇，变成哪个字？', '禾', '想一想禾苗的禾。'],
  ['字谜：两个“木”左右并排，组成哪个字？', '林', '两棵树成什么？'],
  ['字谜：三个“人”叠成一上一下两人的结构，组成哪个字？', '众', '表示许多人。'],
  ['字谜：“门”里面放一个“口”，组成哪个字？', '问', '有疑惑就开口做这个动作。'],
  ['谐音：小葱拌豆腐——一清二什么？补一个字。', '白', '豆腐的颜色；“青”与“清”谐音。'],
  ['谐音：外甥打灯笼——照什么？补一个字，和“舅”同音，表示原来如此。', '旧', '组成词语“照旧”。'],
  ['谐音：孔夫子搬家——净是输；“输”谐音哪种装订成册的读物？答一个字。', '书', '孔夫子搬的是读物。'],
  ['谐音：咸菜烧豆腐——有言在先；“言”谐音哪种调味品？答一个字。', '盐', '咸味的来源。'],
  ['谐音：四月的冰河——开动了；“动”谐音哪个表示冰融化的字？答一个字。', '冻', '组成词语“开冻”。'],
  ['逻辑：盒里只有红球和蓝球，不看颜色至少取几个球，才能保证有两个同色？只答阿拉伯数字。', '3', '最坏情况先取到一红一蓝。'],
  ['逻辑：三只猫同时各吃一条鱼都需三分钟。六只猫同时各吃一条鱼需几分钟？只答阿拉伯数字。', '3', '每只猫的吃鱼时间不变。'],
  ['逻辑：你在赛跑中超过了原本第二名的人，此时你是第几名？只答阿拉伯数字。', '2', '你接替的是被超过者的位置。'],
  ['逻辑：一根绳子对折一次后，从折痕处剪断，展开得到几段？只答阿拉伯数字。', '2', '剪的是原绳的中点。'],
  ['逻辑：抽屉里有十只黑袜和十只白袜，不看颜色至少取几只才能保证有一双同色袜？只答阿拉伯数字。', '3', '先取的两只可能一黑一白。'],
].map(([text, answer, hint], index) => Object.freeze({ id: `Q${index + 1}`, text, answer, hint })));

const normalizeAnswer = value => String(value || '').replace(/[\s\p{P}]/gu, '');
function validateState(state) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const current = state?.current;
  if (state?.schemaVersion !== 1 || !Number.isInteger(state.next) || state.next < 0 || state.next >= QUESTIONS.length
    || !count(state.correct) || !count(state.attempted) || state.correct > state.attempted
    || !(current === null || current && Number.isInteger(current.index) && current.index >= 0 && current.index < QUESTIONS.length
      && state.next === (current.index + 1) % QUESTIONS.length && count(current.wrongGuesses)
      && typeof current.hintUsed === 'boolean' && typeof current.attempted === 'boolean'
      && (!current.wrongGuesses || current.attempted))) throw new Error('解谜存储格式无效');
}

function createTextPuzzleStore({ stateFile, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile,
    { schemaVersion: 1, next: 0, current: null, correct: 0, attempted: 0 }, true,
    { strict: true, now, validate: validateState });
  function save(state) { validateState(state); writeRecordState(stateFile, state, []); }
  function start(state) {
    state.current = { index: state.next, wrongGuesses: 0, hintUsed: false, attempted: false };
    state.next = (state.next + 1) % QUESTIONS.length;
  }
  const render = current => `当前谜题（${current.index + 1}/${QUESTIONS.length}）：${QUESTIONS[current.index].text}\n请说「猜：答案」，也可说「提示」或「放弃这题」。`;
  function handle(side, command) {
    if (side !== 'owner') return 'AI 文字解谜游戏仅主人可用，好友不能触发。';
    if (!command || !['start', 'answer', 'hint', 'skip', 'stats'].includes(command.type)) throw new Error('不支持的解谜命令');
    const state = load();
    if (command.type === 'stats') return `解谜战绩：已答对 ${state.correct} 题／已尝试 ${state.attempted} 题。`;
    if (command.type === 'start') {
      if (!state.current) { start(state); save(state); }
      return render(state.current);
    }
    const current = state.current;
    if (!current) return '没有进行中的谜题，可以说「解谜」开始。';
    const question = QUESTIONS[current.index];
    if (command.type === 'hint') {
      if (current.hintUsed) return '这题的提示已经用过，每题限一次。';
      current.hintUsed = true; save(state);
      return `提示：${question.hint}`;
    }
    const answer = normalizeAnswer(command.answer);
    if (command.type === 'answer' && !answer) return '请用「猜：答案」填写答案。';
    if (!current.attempted) { current.attempted = true; state.attempted++; }
    if (command.type === 'skip') {
      start(state); save(state);
      return `已放弃这题，答案：${question.answer}。不计分。\n${render(state.current)}`;
    }
    if (answer === normalizeAnswer(question.answer)) {
      state.correct++; start(state); save(state);
      return `答对了！加一分，累计 ${state.correct} 分。\n${render(state.current)}`;
    }
    current.wrongGuesses++; save(state);
    return `答错了，本题已猜错 ${current.wrongGuesses} 次。${current.hintUsed ? '提示已用过，可继续猜或说「放弃这题」。' : '可说「提示」，也可继续猜。'}`;
  }
  return { handle };
}

module.exports = { QUESTIONS, normalizeAnswer, createTextPuzzleStore };
