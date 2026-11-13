'use strict';
const { localDraftGate } = require('./chat-lane-policy');
const { hasExecutionClaim } = require('./deepseek-fallback');

// Speculation owns no quota state, tools, planning or upstream products.
function startL2Draft({ provider, text, history, deadlineAt, isCurrent, onAttempt, onTiming,
  timing, now = Date.now, env = process.env }) {
  if (/^(?:off|false|0)$/iu.test(env.WECHAT_L2_DRAFT || 'on')
    || env.WECHAT_FASTLANE_PROVIDER?.toLowerCase() === 'primary' || !provider?.available()) return null;
  const controller = new AbortController();
  let terminal = false, intentPassed = false, checkPassed = false, buffered;
  Object.assign(timing, { draftProvider: 'secondary', draftMs: null, draftOutcome: 'pending' });
  const flush = () => {
    if (!terminal || !buffered) return;
    const { row, emit } = buffered; buffered = null;
    emit({ ...row, draftProvider: timing.draftProvider, draftMs: timing.draftMs, draftOutcome: timing.draftOutcome });
  };
  const finish = reason => {
    if (terminal) return;
    terminal = true; timing.draftOutcome = reason;
    if (reason !== 'sent') controller.abort();
    flush();
  };
  const pending = (async () => {
    try {
      return await provider(text, { history, deadlineAt, isCurrent, onAttempt, onTiming, signal: controller.signal,
        deferTiming: (row, emit) => { timing.draftMs = row.totalMs; buffered = { row, emit }; flush(); } });
    } catch { return { ok: false, failureReason: 'provider_error' }; }
  })();
  return {
    discard: (reason = 'discarded_needs_pipeline') => finish(reason),
    observe(stage, response) {
      if (terminal) return;
      // Public host's two existing strict no-tool admission contracts.
      const passed = response.ok && response.value?.ordinary === true;
      if (stage === '理解完整请求') {
        intentPassed = passed;
        if (!passed) finish('discarded_needs_pipeline');
      } else if (stage === '独立普通回答核对') {
        checkPassed = passed;
        if (!passed) finish('discarded_check');
      } else finish('discarded_needs_pipeline');
    },
    async take({ outcome, isDispatched, blocked = false }) {
      if (terminal) return null;
      if (blocked || isDispatched() || !outcome.ordinary || outcome.actions.length || outcome.results.length) {
        finish('discarded_needs_pipeline'); return null;
      }
      if (!intentPassed || !checkPassed) { finish('discarded_check'); return null; }
      const draft = await pending;
      if (terminal) return null;
      if (isDispatched()) { finish('discarded_needs_pipeline'); return null; }
      if (!isCurrent() || now() >= Math.min(deadlineAt, outcome.budget?.deadlineAt ?? Infinity)) {
        finish('discarded_timeout'); return null;
      }
      if (!draft.ok) {
        finish(['timeout', 'stale_or_budget'].includes(draft.failureReason) ? 'discarded_timeout' : 'discarded_error');
        return null;
      }
      const value = draft.value;
      if (value?.needs_tool !== false || !localDraftGate(value?.reply).ok || hasExecutionClaim(value?.reply || '')) {
        finish('discarded_gate'); return null;
      }
      finish('sent'); return { reply: value.reply };
    },
  };
}
module.exports = { startL2Draft };
