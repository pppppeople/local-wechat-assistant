'use strict';
const { buildPublicMessages } = require('./public-model');
const { FAST_ANSWER_SCHEMA, parseFastAnswer } = require('./chat-lane-policy');
const FASTLANE_TIMEOUT_MS = 20000;

// Independent no-tool generation only: never touches quota, probes or journals.
function createFastlaneProvider({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const run = async (text, { history, deadlineAt, isCurrent, onAttempt, onTiming, signal, deferTiming }) => {
    const startedAt = now(), timeoutMs = Math.min(FASTLANE_TIMEOUT_MS, deadlineAt - startedAt);
    if (timeoutMs <= 0 || !isCurrent() || signal?.aborted) return { ok: false, failureReason: 'stale_or_budget' };
    const controller = new AbortController();
    let timer, cancel, ok = false, failureReason = null, timeoutReason = null;
    try {
      onAttempt();
      const expired = new Promise((_, reject) => {
        cancel = () => { controller.abort(); reject(Error('Draft cancelled')); };
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimer(() => {
          timeoutReason = 'fastlane_budget'; controller.abort(); reject(Error('Fastlane timeout'));
        }, timeoutMs);
      });
      const generate = async () => {
        const url = new URL(env.FASTLANE_MODEL_ENDPOINT);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid endpoint');
        const response = await fetchImpl(url.href, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.FASTLANE_MODEL_API_KEY}` },
          body: JSON.stringify({ model: env.FASTLANE_MODEL_NAME, stream: false,
            response_format: { type: 'json_object' },
            messages: buildPublicMessages(text, { history, schema: FAST_ANSWER_SCHEMA }) }),
        });
        if (!response.ok) throw Error('Provider error');
        const data = await response.json();
        if (data?.choices?.some(choice => choice.message?.tool_calls?.length || choice.message?.function_call
          || ['tool_calls', 'function_call'].includes(choice.finish_reason))) {
          return { ok: false, failureReason: 'unexpected_tool' };
        }
        if (data?.choices?.[0]?.finish_reason !== 'stop') return { ok: false, failureReason: 'invalid_output' };
        try { return { ok: true, value: parseFastAnswer(data.choices[0].message?.content) }; }
        catch { return { ok: false, failureReason: 'invalid_output' }; }
      };
      const result = await Promise.race([generate(), expired]);
      if (!isCurrent() || now() >= deadlineAt) return { ok: false, failureReason: failureReason = 'stale_or_budget' };
      ok = result.ok; failureReason = result.failureReason || null;
      return result;
    } catch {
      failureReason = timeoutReason ? 'timeout' : signal?.aborted ? 'stale_or_budget' : 'provider_error';
      return { ok: false, failureReason };
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', cancel);
      const row = { provider: 'secondary', stage: 'ordinary_answer', ok, failureReason,
        timeoutMs, timeoutReason, firstOutputWatchdog: false, firstOutputMs: null,
        attempt: 1, maxAttempts: 1, retryReason: null, totalMs: now() - startedAt };
      if (deferTiming) deferTiming(row, onTiming);
      else onTiming(row);
    }
  };
  run.available = () => Boolean(env.FASTLANE_MODEL_ENDPOINT && env.FASTLANE_MODEL_NAME && env.FASTLANE_MODEL_API_KEY);
  return run;
}
module.exports = { createFastlaneProvider, FASTLANE_TIMEOUT_MS };
