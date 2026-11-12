'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { createCodexQuotaState } = require('./codex-quota-state');
const { createDeepSeekClient } = require('./deepseek-client');
const { createDeepSeekFallback } = require('./deepseek-fallback');
const { createFallbackJournal } = require('./fallback-journal');
const { createFallbackTools } = require('./fallback-tools');
const { appendChatTurn, getChatHistory } = require('./chat-history');

// Public hosts supply their own model and stores. No private host discovery.
function createPublicFallback({ runtime, model, config, personalTodos, expenseLedger,
  weatherCommands, placeBox, now = Date.now, complete, probeIntervalMs = 30000 }) {
  if (!config?.apiKey) return null;
  if (!model) throw Error('DeepSeek fallback requires a configured primary model');
  const state = createCodexQuotaState({ file: path.join(runtime, 'state', 'model-fallback', 'codex-quota.json'), now });
  const historyFile = path.join(runtime, 'state', 'chat', 'threads.json');
  const journal = createFallbackJournal({
    operationDir: path.join(runtime, 'state', 'model-fallback', 'operations'),
    pendingFile: path.join(runtime, 'queues', 'model-fallback', 'pending.jsonl'), historyFile, now,
  });
  const client = complete || createDeepSeekClient({ env: { DEEPSEEK_API_KEY: config.apiKey, DEEPSEEK_MODEL: config.model } });
  const handlers = new Map(['owner', 'friend'].map(side => [side, createDeepSeekFallback({
    complete: client, journal, now,
    tools: createFallbackTools({ side, personalTodos, expenseLedger, weatherCommands, placeBox }),
    loadPersona: () => ({ style: '你是本地文字助手。自然、简洁地用中文回答；示例角色不代表真实个人。' }),
    getContext: () => ({ todos: side === 'owner' ? personalTodos.readOpenItems(side) : [] }),
  })]));
  const history = request => getChatHistory(historyFile, request.historyKey, { now: now(), maxTurns: 12 });
  function request(text, side, metadata = {}) {
    if (!handlers.has(side)) throw Error('Invalid fallback side');
    const accountId = metadata.accountId || 'local-console';
    const senderId = metadata.senderId || side;
    return { text, side, accountId, senderId, id: metadata.id || crypto.randomUUID(),
      historyKey: JSON.stringify([accountId, senderId, side]) };
  }
  function probe() {
    return state.maybeProbe(async () => {
      try {
        // A fresh independent request, with neither history nor feature tools.
        const reply = model.probe ? await model.probe() : await model('Return only {"ok":true}.', { probe: true });
        return { ok: JSON.parse(reply)?.ok === true };
      } catch (failure) { return { ok: false, failure }; }
    });
  }
  const timer = probeIntervalMs > 0 ? setInterval(probe, probeIntervalMs) : null;
  timer?.unref?.();
  return {
    state, journal, request, probe, history,
    close: () => clearInterval(timer),
    isExhausted: () => state.isExhausted(),
    hasPending: side => handlers.get(side).hasPending(side),
    exitManual: side => handlers.get(side).exitManual(side),
    remember(req, reply) {
      appendChatTurn(historyFile, req.historyKey, { user: req.text, assistant: String(reply) },
        { now: now(), sourceId: `turn:${req.id}`, strict: true });
    },
    async intercept(req) {
      const handler = handlers.get(req.side);
      const help = handler.manual(req.side, req.text);
      if (help) return help;
      if (!state.isExhausted()) return null;
      probe();
      return handler.run(req, history(req));
    },
    async reply(req, generate = model) {
      try { return await generate(req.text, { history: history(req) }); }
      catch (error) {
        if (!state.exhaust(error)) throw error;
        return handlers.get(req.side).run(req, history(req));
      }
    },
  };
}
module.exports = { createPublicFallback };
