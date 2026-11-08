'use strict';
const path = require('node:path');
const { parsePersonalTodoCommand } = require('./personal-todo-commands');
const { createPersonalTodoStore } = require('./personal-todo-store');
const { parseExpenseLedgerCommand } = require('./expense-ledger-commands');
const { createExpenseLedgerStore } = require('./expense-ledger-store');
const { parseTemporaryNoteCommand } = require('./temporary-note-commands');
const { createTemporaryNoteStore } = require('./temporary-note-store');
const { parseHabitCommand } = require('./habit-commands');
const { createHabitStore } = require('./habit-store');
const { createWeatherCommands } = require('./weather-commands');
const { createWeatherStore } = require('./weather-store');
const { createContextLeaseStore } = require('./context-lease-store');
const { createOpenPlaceProvider } = require('./amap-place-provider');
const { resultText } = require('./feature-result');

const HELP = '支持：记一下 明天买牛奶；我的待办；记账 12元 餐饮 示例午餐；今日账单；存临时信息 示例备忘；临时信息；创建习惯：散步；我的习惯。天气；天气说明；设置天气城市：城市名；开启天气早报 / 关闭天气早报；天气早报测试。天气双方均可用，早报推送需宿主接线。普通问答需要自备模型。';
function createPublicAssistant({ runtime, model = null, helpText = HELP, now = () => Date.now(), weatherProvider, weatherStore, weatherMorningTime }) {
  const stateFile = feature => path.join(runtime, 'state', 'features', feature, 'state.json');
  const routes = [
    [parsePersonalTodoCommand, createPersonalTodoStore({ stateFile: stateFile('todo') })],
    [parseExpenseLedgerCommand, createExpenseLedgerStore({ stateFile: stateFile('expense') })],
    [parseTemporaryNoteCommand, createTemporaryNoteStore({ stateFile: stateFile('notes') })],
    [parseHabitCommand, createHabitStore({ stateFile: stateFile('habit') })],
  ];
  const weather = createWeatherCommands({ provider: weatherProvider || createOpenPlaceProvider({ now }),
    store: weatherStore || createWeatherStore({ runtime, now }), now,
    morningTime: weatherMorningTime || process.env.WEATHER_MORNING_TIME || '08:00' });
  const contextLeases = createContextLeaseStore({ runtime, now });
  return {
    weather,
    contextLeases,
    exitManual: side => weather.exitManual(side),
    async reply(text, side = 'owner', { refreshReply } = {}) {
      if (!['owner', 'friend'].includes(side)) throw new Error('invalid assistant side');
      // The pair console consumes at its own ingress, before pair-command routing.
      refreshReply ??= contextLeases.consumeRefreshReply(side);
      const value = String(text || '').trim();
      if (!value || /^(?:帮助|help)$/iu.test(value)) { weather.exitManual(side); return helpText; }
      for (const [parse, store] of routes) {
        const command = parse(value);
        if (command) {
          weather.exitManual(side);
          const result = await (store.execute ? store.execute(side, command) : store.handle(side, command));
          return resultText(result);
        }
      }
      const command = weather.selectInput(side, value, { skipPendingCity: refreshReply });
      if (command) return (await weather.handle(side, command)).reply;
      // Text generation cannot select tools or mutate feature stores.
      return model ? model(value) : helpText;
    },
  };
}
module.exports = { createPublicAssistant, HELP };
