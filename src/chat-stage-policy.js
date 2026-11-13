'use strict';

const REQUEST_BUDGET_MS = 150000;
const STAGE_TIMEOUTS = Object.freeze({
  '理解完整请求': 40000,
  '独立普通回答核对': 40000,
  '独立语义核对': 40000,
  ordinary_answer: 60000,
  '根据真实结果规划下一步': 120000,
});
const PURE_STAGES = new Set(['理解完整请求', '独立普通回答核对', '独立语义核对', 'ordinary_answer']);

const FIRST_OUTPUT_TIMEOUT_MS = 15000;
const WATCHDOG_STAGES = new Set(['理解完整请求', '独立普通回答核对', 'ordinary_answer']);

// Host policy only. The raw no-tool runner and the transport never replay turns.
// A caller must explicitly attest that no feature/tool has run in this request.
function createChatStageRunner({ run, now = Date.now }) {
  return async function runStage(prompt, sessionId = '', images = [], response = {}) {
    const stage = response.stage || 'ordinary_answer';
    const deadlineAt = Math.min(response.budget?.deadlineAt ?? Infinity,
      now() + (response.budget?.remainingMs ?? REQUEST_BUDGET_MS));
    const maxAttempts = response.retrySafe === true && PURE_STAGES.has(stage) ? 2 : 1;
    let previousFailure = null;
    let lastResult;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // A parallel admission call can still be running when a feature starts.
      if (attempt > 1 && response.isRetrySafe?.() === false) return { ...lastResult, attempts: attempt - 1 };
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) return { ok: false, plan: null, threadId: '', errorKind: 'BUDGET',
        error: '本轮处理时间已达上限，已停止后续生成。', attempts: attempt - 1 };
      const input = attempt > 1 && response.rebuildPrompt ? response.rebuildPrompt() : prompt;
      response.onAttempt?.();
      const result = await run(input, attempt === 1 ? sessionId : '', images, {
        ...response, stage, timeoutMs: STAGE_TIMEOUTS[stage] || 120000,
        firstOutputTimeoutMs: WATCHDOG_STAGES.has(stage) ? FIRST_OUTPUT_TIMEOUT_MS : undefined,
        budget: { ...response.budget, deadlineAt, remainingMs },
        attempt, maxAttempts, retryReason: previousFailure,
      });
      lastResult = result;
      if (result.ok || result.authFailed || ['AUTH', 'QUOTA_EXHAUSTED', 'BUDGET'].includes(result.errorKind)
        || response.retryOnWatchdogOnly && result.timeoutReason !== 'first_output_watchdog'
        || result.failureReason === 'unexpected_tool' || attempt === maxAttempts) return { ...result, attempts: attempt };
      previousFailure = result.failureReason || result.errorKind || 'model_error';
    }
  };
}

module.exports = { REQUEST_BUDGET_MS, STAGE_TIMEOUTS, createChatStageRunner };
