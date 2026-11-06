'use strict';
const path = require('node:path');
const { createPublicAssistant, HELP: PERSONAL_HELP } = require('./public-assistant');
const { parseSharedPlaceCommand } = require('./shared-place-commands');
const { createSharedPlaceBox } = require('./shared-place-box');
const { parsePairDailyQuestionCommand } = require('./pair-daily-question-commands');
const { createPairDailyQuestionStore } = require('./pair-daily-question-store');
const { parsePairChallengeCommand } = require('./pair-challenge-commands');
const { createPairChallengeStore } = require('./pair-challenge-store');
const { parsePairSavingsCommand } = require('./pair-savings-commands');
const { createPairSavingsStore } = require('./pair-savings-store');

const SIDE_NAMES = Object.freeze({ owner: '小林', friend: '小周' });
const HELP = [
  '双人助手：小林（owner）与小周（friend）均为虚构角色，同一控制台切换模拟两人。',
  '切换 小林 / 切换 小周；也可用 /as owner 或 /as friend。当前说话人显示在提示中。',
  '想去箱：想去箱添加：纸月公园；查看想去箱；把纸月公园标记为去过；去过的地方。',
  '每日一问：每日一问；每日一问答：你的答案；每日一问揭晓。双方答完才揭晓。',
  '默契挑战：来一轮默契挑战；默契答 A（A–D）；默契战绩；结束默契挑战。双方答完才揭晓。',
  '共同储蓄：共同愿望：周末野餐 200元；愿望贡献：30元；共同愿望进度；撤销愿望贡献：1。',
  '储蓄仅为文本记账，不处理真实资金。通知只在本次本地会话切换或输入时显示，不发送到微信。',
  '个人待办、记账、临时信息与习惯仅小林/owner 可用，小周不能读取或修改；天气双方均可用：',
  PERSONAL_HELP,
].join('\n');

// Local role selection is simulation, never authentication for a network caller.
// Pair data is kept by the existing stores; only transient display notices live here.
function createPairConsole({ runtime, model = null, now = () => Date.now(), random = Math.random, weatherProvider, weatherStore, weatherMorningTime }) {
  let side = 'owner';
  const notices = { owner: [], friend: [] };
  const notify = (recipient, text) => notices[recipient].push(text);
  const stateFile = feature => path.join(runtime, 'state', 'features', feature, 'state.json');
  const options = feature => ({ stateFile: stateFile(feature), now, sideNames: SIDE_NAMES });
  const getBinding = () => 'local-console-pair';
  const daily = createPairDailyQuestionStore({ ...options('pair-daily-question'), getBinding });
  const routes = [
    [text => parseSharedPlaceCommand(text, { now: now() }), createSharedPlaceBox({
      ...options('shared-place'), provider: { available: false },
      onPlaceAdded: ({ side: author, place }) => notify(author === 'owner' ? 'friend' : 'owner',
        `${SIDE_NAMES[author]}添加了「${place.name}」，可用「查看想去箱」查看共同清单。`),
    })],
    [parsePairDailyQuestionCommand, daily],
    [parsePairChallengeCommand, createPairChallengeStore({ ...options('pair-challenge'), random, onNotice: notify })],
    [parsePairSavingsCommand, createPairSavingsStore({ ...options('pair-savings'), getBinding })],
  ];
  const personal = createPublicAssistant({ runtime, model, now, weatherProvider, weatherStore, weatherMorningTime, helpText: HELP });
  function drainNotices() {
    const pending = notices[side].splice(0);
    const question = daily.takePending(side);
    if (question.pending) pending.push(question.text);
    return pending.map(text => `[${SIDE_NAMES[side]} 本地通知]\n${text}`).join('\n');
  }
  return {
    weather: personal.weather,
    get speaker() { return SIDE_NAMES[side]; },
    get side() { return side; },
    async reply(text) {
      const value = String(text || '').trim();
      const change = value.match(/^(?:切换|\/as)(?:\s+(.*))?$/u);
      if (change) {
        const name = (change[1] || '').trim();
        const target = Object.keys(SIDE_NAMES).find(key => key === name || SIDE_NAMES[key] === name);
        if (!target) return '请选择「切换 小林」或「切换 小周」（/as owner 或 /as friend）。';
        side = target;
        return [`当前说话人：${SIDE_NAMES[side]}（${side}，虚构角色）`, drainNotices()].filter(Boolean).join('\n');
      }
      // Take pending reveals before the command, so a new daily answer is not echoed twice.
      const pending = drainNotices();
      let reply;
      if (!value || /^(?:帮助|help)$/iu.test(value)) { personal.exitManual(side); reply = HELP; }
      else {
        for (const [parse, store] of routes) {
          const command = parse(value);
          if (command) { personal.exitManual(side); reply = await store.handle(side, command); break; }
        }
        if (reply === undefined) reply = await personal.reply(value, side);
      }
      return [pending, reply, drainNotices()].filter(Boolean).join('\n');
    },
  };
}
module.exports = { createPairConsole, SIDE_NAMES, HELP };
