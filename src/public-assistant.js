'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { parsePersonalTodoCommand } = require('./personal-todo-commands');
const { createPersonalTodoStore } = require('./personal-todo-store');
const { parseExpenseLedgerCommand } = require('./expense-ledger-commands');
const { createExpenseLedgerStore } = require('./expense-ledger-store');
const { parseTemporaryNoteCommand } = require('./temporary-note-commands');
const { createTemporaryNoteStore } = require('./temporary-note-store');
const { parseHabitCommand } = require('./habit-commands');
const { createHabitStore } = require('./habit-store');
const { createWeatherCommands, parseWeatherCommand } = require('./weather-commands');
const { createWeatherStore } = require('./weather-store');
const { createContextLeaseStore } = require('./context-lease-store');
const { createOpenPlaceProvider } = require('./amap-place-provider');
const { createPublicFallback } = require('./public-fallback');
const { resultText } = require('./feature-result');
const { createOrdinaryChat, chatLanesEnabled, laneTiming } = require('./ordinary-chat-lanes');
const { captureChatLaneState } = require('./chat-lane-state');
const { appendChatTurn, getChatHistory } = require('./chat-history');
const { REQUEST_BUDGET_MS } = require('./chat-stage-policy');

const HELP = '支持：记一下 明天买牛奶；我的待办；记账 12元 餐饮 示例午餐；今日账单；存临时信息 示例备忘；临时信息；创建习惯：散步；我的习惯。天气；天气说明；设置天气城市：城市名；开启天气早报 / 关闭天气早报；天气早报测试。天气双方均可用，早报推送需宿主接线。普通问答需要自备模型；可选额度兜底见「降级说明」。';
function createPublicAssistant({ runtime, model = null, helpText = HELP, now = () => Date.now(), weatherProvider, weatherStore, weatherMorningTime, fallbackConfig, fallbackOptions = {}, placeBox,
  laneProbes = () => [], env = process.env, log = () => {} }) {
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
  const fallback = createPublicFallback({ runtime, model, config: fallbackConfig, now, ...fallbackOptions,
    personalTodos: routes[0][1], expenseLedger: routes[1][1], weatherCommands: weather, placeBox });
  const ordinaryChat = model && createOrdinaryChat({ model, now, env, log });
  const historyFile = path.join(runtime, 'state', 'chat', 'threads.json');
  const request = (text, side, metadata = {}) => fallback?.request(text, side, metadata) || {
    text, side, id: metadata.id || crypto.randomUUID(),
    historyKey: JSON.stringify([metadata.accountId || 'local-console', metadata.senderId || side, side]),
  };
  function remember(req, reply) {
    if (fallback) fallback.remember(req, reply);
    else appendChatTurn(historyFile, req.historyKey, { user: req.text, assistant: String(reply) },
      { now: now(), sourceId: `turn:${req.id}`, strict: true });
  }
  function probes(side, req) {
    return [['weather', () => weather.hasPending(side)],
      ['history', () => { getChatHistory(historyFile, req.historyKey, { now: now(), strict: true }); return false; }],
      ...(fallback ? [['fallback_manual', () => fallback.hasPending(side)],
        ['fallback_operation', () => fallback.journal.read(req).length > 0]] : []), ...laneProbes(side)];
  }
  const assistant = {
    weather,
    fallback,
    close: () => fallback?.close(),
    contextLeases,
    remember: (text, side, reply, metadata) => remember(request(text, side, metadata), reply),
    canBatch(text, side = 'owner') {
      // Never delay known feature commands or interpret pending replies as chat.
      try { return !/^(?:帮助|help|降级说明|降级帮助)$/iu.test(text) && !fallback?.isExhausted()
        && !routes.some(([parse]) => parse(text)) && !parseWeatherCommand(text)
        && weather.hasPending(side) === false && !fallback?.hasPending(side); } catch { return false; }
    },
    exitManual: side => { weather.exitManual(side); fallback?.exitManual(side); },
    async replyRaw(text, side = 'owner', { refreshReply, fallbackRequest, ...metadata } = {}) {
      if (!['owner', 'friend'].includes(side)) throw new Error('invalid assistant side');
      // The pair console consumes at its own ingress, before pair-command routing.
      refreshReply ??= contextLeases.consumeRefreshReply(side);
      const value = String(text || '').trim();
      if (!value || /^(?:帮助|help)$/iu.test(value)) { assistant.exitManual(side); return helpText; }
      if (metadata.receivedAt !== undefined && now() >= metadata.receivedAt + REQUEST_BUDGET_MS) return '本轮处理时间已达上限，未继续生成或派发。';
      if (fallback) {
        const exhausted = fallback.isExhausted();
        const result = await fallback.intercept(fallbackRequest);
        if (result !== null) {
          if (exhausted) {
            const record = { ...laneTiming({ lane: null, reasonCodes: ['deepseek_bypass'] }), requestId: metadata.traceId,
              totalMs: now() - metadata.receivedAt };
            metadata.onTiming?.(record); log(`chat timing ${JSON.stringify(record)}`);
          }
          weather.exitManual(side); return result;
        }
      } else if (/^(?:降级说明|降级帮助)$/u.test(value)) {
        return '额度兜底尚未启用；请配置主模型与 DEEPSEEK_API_KEY。\n看用法回：降级说明';
      }
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
      if (!ordinaryChat) return helpText;
      const generate = (input, { history = getChatHistory(historyFile, fallbackRequest.historyKey, { now: now(), maxTurns: 12 }) } = {}) => {
        // With lanes off no probe is called, exactly the original text path.
        const item = { hasAttachment: false, ...metadata };
        let state;
        if (chatLanesEnabled(env)) {
          try { state = captureChatLaneState({ probes: probes(side, fallbackRequest), item, history }); }
          catch { state = { known: false }; }
        }
        return ordinaryChat(input, { ...item, history, baselineHistory: fallback ? history : [], state });
      };
      return fallback ? fallback.reply(fallbackRequest, generate) : generate(value);
    },
  };
  return { ...assistant, async reply(text, side = 'owner', metadata = {}) {
    metadata = { receivedAt: now(), traceId: crypto.randomUUID(), ...metadata };
    const req = request(String(text || '').trim(), side, metadata);
    const reply = await assistant.replyRaw(text, side, { ...metadata, fallbackRequest: req });
    remember(req, reply);
    return reply;
  } };
}
module.exports = { createPublicAssistant, HELP };
