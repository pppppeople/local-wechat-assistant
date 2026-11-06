'use strict';

const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');

// Original, low-sensitivity prompts; absolute Shanghai day number rotates the bank.
const QUESTIONS = Object.freeze([
  '如果给今天的天空取个菜名，你会叫什么？',
  '周末的小推车只卖一种点心，你想卖什么？',
  '哪一种日常声音适合当作散步的背景音乐？',
  '如果把一座公园装进口袋，你最想留下哪个角落？',
  '小时候觉得哪件普通小物最像宝贝？',
  '你想给常用的杯子起什么外号？',
  '如果雨滴有颜色，你希望今天下什么颜色的雨？',
  '只能用三样食材设计一份野餐，你会带什么？',
  '哪一种路边小店值得你放慢脚步？',
  '如果电梯能开往一个童话场景，你想在哪层下？',
  '想起以前的课间，你先想到哪种小游戏？',
  '给普通的星期三加一个小节日，你会庆祝什么？',
  '如果能给月亮挂一块招牌，你会写什么？',
  '在海边捡到一颗会讲笑话的石头，你想问它什么？',
  '你最想把哪一种香味做成书签？',
  '如果鞋子会记旅行日记，第一句会写什么？',
  '你会给一辆慢吞吞的观光车选什么主题？',
  '哪一种水果最适合当动画片主角？',
  '记忆里哪次看到的小风景让你想多停一会儿？',
  '如果今天的晚霞是一张明信片，你想配哪句话？',
  '在云朵上开一家店，你打算卖什么？',
  '你喜欢把最爱的一口留到最后，还是先吃掉？',
  '如果只拍三张照片记录一条老街，你会拍什么？',
  '哪一种小摆件会让你的桌面更有趣？',
  '假如能给四季各配一种饮料，你怎么搭配？',
  '如果公交站变成小展览，你想看什么主题？',
  '以前吃过的哪种零食，包装让你印象最深？',
  '给一个纸箱设计冒险用途，你会把它变成什么？',
  '如果路灯晚上会聊天，你猜它们聊什么？',
  '想给一次没有目的地的散步起什么名字？',
  '如果能为家常菜设计一枚勋章，你会颁给哪道菜？',
  '你想用哪种颜色给明天画一个开场？',
]);
const SIDES = ['owner', 'friend'];
function validSide(side) {
  if (!SIDES.includes(side)) throw new Error('invalid daily question side');
}
function questionForDate(date) {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return QUESTIONS[((day % QUESTIONS.length) + QUESTIONS.length) % QUESTIONS.length];
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || typeof state.binding !== 'string' || !Array.isArray(state.days)
    || state.days.length > 1 || state.days.some(day =>
      !/^\d{4}-\d{2}-\d{2}$/u.test(day.id) || day.id !== shanghaiDay(day.createdAt)
      || !['collecting', 'revealed'].includes(day.status)
      || !day.answers || typeof day.answers !== 'object' || Array.isArray(day.answers)
      || Object.entries(day.answers).some(([side, answer]) => !SIDES.includes(side)
        || typeof answer !== 'string' || !answer.trim() || answer.length > 500)
      || !day.seen || typeof day.seen !== 'object' || Array.isArray(day.seen) || SIDES.some(side => typeof day.seen[side] !== 'boolean')
      || (day.status === 'revealed') !== SIDES.every(side => Boolean(day.answers[side]))
      || (day.status === 'collecting' && SIDES.some(side => day.seen[side])))) {
    throw new Error('每日一问存储格式无效');
  }
}

function createPairDailyQuestionStore({ stateFile, getBinding, now = () => Date.now(),
  sideNames = { owner: 'Owner', friend: '好友' } }) {
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['days']); };
  function load() {
    // Binding is derived from the broker configuration, never caller-supplied side/identity.
    const binding = getBinding();
    if (typeof binding !== 'string' || !binding) throw new Error('每日一问尚未绑定');
    const state = readRecordState(stateFile, { schemaVersion: 1, binding, days: [] }, true,
      { strict: true, now, validate: validateState });
    const date = shanghaiDay(now());
    if (state.binding !== binding || state.days.some(day => day.id !== date)) {
      state.binding = binding;
      state.days = [];
      save(state);
    }
    return { state, date };
  }
  function render(day, side) {
    const lines = [`每日一问（${day.id}）：${questionForDate(day.id)}`,
      `你${day.answers[side] ? '已答' : '未答'}，对方${day.answers[side === 'owner' ? 'friend' : 'owner'] ? '已答' : '未答'}。`];
    if (day.status === 'revealed') lines.push('双方答案揭晓：', ...SIDES.map(key => `${sideNames[key]}：${day.answers[key]}`));
    else lines.push('回复「每日一问答：你的答案」，双方答完才揭晓；揭晓前可改答，过日未答齐作废。');
    return lines.join('\n');
  }
  function handle(side, command) {
    validSide(side);
    if (!command || !['status', 'answer', 'reveal'].includes(command.type)) throw new Error('不支持的每日一问命令');
    const { state, date } = load();
    const day = state.days[0] || { id: date, createdAt: new Date(now()).toISOString(),
      status: 'collecting', answers: {}, seen: { owner: false, friend: false } };
    if (command.type === 'answer') {
      if (day.status === 'revealed') {
        day.seen[side] = true;
        save(state);
        return `今日已揭晓，不能修改。\n${render(day, side)}`;
      }
      if (typeof command.answer !== 'string' || !command.answer.trim() || command.answer.trim().length > 500) {
        return '请用「每日一问答：答案」提交 1–500 字答案。';
      }
      day.answers[side] = command.answer.trim();
      if (SIDES.every(key => day.answers[key])) day.status = 'revealed';
      state.days = [day];
      if (day.status === 'revealed') day.seen[side] = true;
      save(state);
      return day.status === 'revealed' ? render(day, side) : `答案已封存，揭晓前可重新提交覆盖。\n${render(day, side)}`;
    }
    if (day.status === 'revealed') {
      day.seen[side] = true;
      save(state);
    }
    return render(day, side);
  }
  function takePending(side) {
    validSide(side);
    const { state } = load();
    const day = state.days[0];
    if (!day || day.status !== 'revealed' || day.seen[side]) return { pending: false, text: '' };
    day.seen[side] = true;
    save(state); // Consume durably before returning or attempting transport.
    return { pending: true, text: render(day, side) };
  }
  async function tick(deliver) {
    const result = takePending('owner');
    if (result.pending) await deliver(result.text, `pair-daily-question:${shanghaiDay(now())}`);
  }
  function deleteSide(side) {
    validSide(side);
    const { state } = load();
    const removed = state.days.length;
    state.days = [];
    save(state);
    return { removed };
  }
  return { handle, takePending, tick, deleteSide };
}

module.exports = { QUESTIONS, questionForDate, createPairDailyQuestionStore };
