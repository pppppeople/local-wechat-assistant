'use strict';
const { buildPublicMessages } = require('./public-model');
const { FAST_ANSWER_SCHEMA, parseFastAnswer } = require('./chat-lane-policy');
const FASTLANE_TIMEOUT_MS = 20000;
const PROVIDER_ERROR_CATEGORIES = new Set(['http_status', 'network', 'timeout', 'cancelled', 'invalid_response', 'configuration', 'unknown']);

// Timing may retain only these two validated scalars, never an exception/body.
function fastlaneErrorFields(error) {
  const providerErrorCategory = PROVIDER_ERROR_CATEGORIES.has(error?.providerErrorCategory) ? error.providerErrorCategory : 'unknown';
  const status = error?.providerHttpStatus;
  return { providerErrorCategory, providerHttpStatus: providerErrorCategory === 'http_status'
    && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null };
}

// Independent no-tool generation only: never touches quota, probes or journals.
function createFastlaneProvider({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const run = async (text, { history, deadlineAt, isCurrent, onAttempt, onTiming, signal, deferTiming }) => {
    const startedAt = now(), timeoutMs = Math.min(FASTLANE_TIMEOUT_MS, deadlineAt - startedAt);
    if (timeoutMs <= 0 || !isCurrent() || signal?.aborted) return { ok: false, failureReason: 'stale_or_budget' };
    const controller = new AbortController();
    let timer, cancel, ok = false, failureReason = null, timeoutReason = null;
    let providerErrorCategory = null, providerHttpStatus = null;
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
        let category = 'configuration', httpStatus = null;
        try {
          if (!env.FASTLANE_MODEL_ENDPOINT || !env.FASTLANE_MODEL_NAME || !env.FASTLANE_MODEL_API_KEY) throw Error('Missing configuration');
          const url = new URL(env.FASTLANE_MODEL_ENDPOINT);
          if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid endpoint');
          category = 'network';
          const response = await fetchImpl(url.href, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.FASTLANE_MODEL_API_KEY}` },
            body: JSON.stringify({ model: env.FASTLANE_MODEL_NAME, stream: false,
              response_format: { type: 'json_object' },
              messages: buildPublicMessages(text, { history, schema: FAST_ANSWER_SCHEMA }) }),
          });
          if (!response.ok) {
            category = 'http_status'; httpStatus = response.status;
            throw Error('Provider error');
          }
          category = 'invalid_response';
          const data = await response.json();
          if (data?.choices?.some(choice => choice.message?.tool_calls?.length || choice.message?.function_call
            || ['tool_calls', 'function_call'].includes(choice.finish_reason))) {
            return { ok: false, failureReason: 'unexpected_tool' };
          }
          if (data?.choices?.[0]?.finish_reason !== 'stop') {
            providerErrorCategory = 'invalid_response';
            return { ok: false, failureReason: 'invalid_output' };
          }
          try { return { ok: true, value: parseFastAnswer(data.choices[0].message?.content) }; }
          catch {
            if (data.choices[0].message?.content == null) providerErrorCategory = 'invalid_response';
            return { ok: false, failureReason: 'invalid_output' };
          }
        } catch {
          throw Object.assign(Error('Secondary provider failed'), fastlaneErrorFields({ providerErrorCategory: category, providerHttpStatus: httpStatus }));
        }
      };
      const result = await Promise.race([generate(), expired]);
      if (!isCurrent() || now() >= deadlineAt) return { ok: false, failureReason: failureReason = 'stale_or_budget' };
      ok = result.ok; failureReason = result.failureReason || null;
      return result;
    } catch (error) {
      failureReason = timeoutReason ? 'timeout' : signal?.aborted ? 'stale_or_budget' : 'provider_error';
      ({ providerErrorCategory, providerHttpStatus } = fastlaneErrorFields(timeoutReason
        ? { providerErrorCategory: 'timeout' } : signal?.aborted ? { providerErrorCategory: 'cancelled' } : error));
      return { ok: false, failureReason };
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', cancel);
      const row = { provider: 'secondary', stage: 'ordinary_answer', ok, failureReason,
        providerErrorCategory, providerHttpStatus,
        timeoutMs, timeoutReason, firstOutputWatchdog: false, firstOutputMs: null,
        attempt: 1, maxAttempts: 1, retryReason: null, totalMs: now() - startedAt };
      if (deferTiming) deferTiming(row, onTiming);
      else onTiming(row);
    }
  };
  run.available = () => Boolean(env.FASTLANE_MODEL_ENDPOINT && env.FASTLANE_MODEL_NAME && env.FASTLANE_MODEL_API_KEY);
  return run;
}
module.exports = { createFastlaneProvider, FASTLANE_TIMEOUT_MS, fastlaneErrorFields };
