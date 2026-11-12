'use strict';

function createDeepSeekClient({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 45000 } = {}) {
  return async function complete({ messages, tools, json = false, signal }) {
    const key = env.DEEPSEEK_API_KEY;
    if (!key) throw Error('DeepSeek API key is unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      if (signal?.aborted) abort();
      const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.DEEPSEEK_MODEL || 'deepseek-flash', messages, stream: false,
          thinking: { type: 'disabled' }, max_tokens: 2048,
          ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
          ...(json ? { response_format: { type: 'json_object' } } : {}) }),
      });
      // Never include upstream bodies, headers, request objects or transport errors:
      // providers/proxies may echo Authorization or private input in diagnostics.
      if (!response.ok) throw Error(`DeepSeek HTTP ${response.status}`);
      const value = await response.json();
      const choice = value?.choices?.[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)
        || !choice.message || choice.message.role !== 'assistant') throw Error('DeepSeek invalid response');
      return choice.message;
    } catch (error) {
      const safe = /^DeepSeek (?:HTTP \d{3}|invalid response)$/u.test(error.message);
      throw Error(safe ? error.message : controller.signal.aborted ? 'DeepSeek request timed out or aborted' : 'DeepSeek request failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}
module.exports = { createDeepSeekClient };
