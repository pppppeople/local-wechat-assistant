'use strict';
const { classifyChatLane, localDraftGate, FAST_ANSWER_SCHEMA, parseFastAnswer } = require('./chat-lane-policy');
const { createChatStageRunner, REQUEST_BUDGET_MS } = require('./chat-stage-policy');
const { classifyCodexError } = require('./codex-errors');
const { createFastlaneProvider } = require('./fastlane-provider');
const { hasExecutionClaim } = require('./deepseek-fallback');

const ADMISSION_SCHEMA = { type: 'object', additionalProperties: false,
  properties: { ordinary: { type: 'boolean' } }, required: ['ordinary'] };
function parseAdmission(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || Object.keys(value).length !== 1 || typeof value.ordinary !== 'boolean') throw Error('Invalid admission');
  return value;
}
function chatLanesEnabled(env = process.env) { return !/^(?:off|false|0)$/iu.test(env.WECHAT_CHAT_LANES || 'on'); }
function laneTiming(decision = { lane: null, reasonCodes: ['not_classified'] }) {
  return { lane: decision.lane, effective_lane: decision.lane, lane_reason_codes: decision.reasonCodes,
    provider: 'primary', fastlane_fallback: false, l1_gate_reject: null, l1_gate_detail: null };
}

// Stateless HTTP requests are fresh turns. There is no tool/executor API here.
function createOrdinaryChat({ model, now = Date.now, env = process.env, log = () => {}, fastlaneOptions = {} }) {
  const secondary = createFastlaneProvider({ ...fastlaneOptions, now, env });
  return async function reply(text, { history = [], baselineHistory = history, state, receivedAt = now(), deadlineAt = receivedAt + REQUEST_BUDGET_MS,
    fragments = 1, hasAttachment = false, imagePaths = [], traceId = '', isCurrent = () => true, onTiming = () => {} } = {}) {
    deadlineAt = Math.min(deadlineAt, receivedAt + REQUEST_BUDGET_MS);
    const timing = laneTiming();
    const startedAt = now();
    let modelAttempts = 0;
    const runStage = createChatStageRunner({ now, run: async (prompt, _session, _images, response) => {
      const at = now();
      let result;
      const modelTiming = { timeoutReason: null, firstOutputMs: null };
      const recordTiming = (record = {}) => {
        if (['first_output_watchdog', 'stage_budget'].includes(record.timeoutReason)) modelTiming.timeoutReason = record.timeoutReason;
        if (Number.isFinite(record.firstOutputMs) && record.firstOutputMs >= 0) modelTiming.firstOutputMs = record.firstOutputMs;
      };
      try {
        if (!isCurrent()) throw Object.assign(Error('Turn cancelled'), { errorKind: 'BUDGET' });
        const raw = await model(prompt, { history: response.history ?? history, stage: response.stage, schema: response.schema,
          timeoutMs: Math.min(response.timeoutMs, response.budget.remainingMs), deadlineAt,
          firstOutputTimeoutMs: response.firstOutputTimeoutMs, onTiming: recordTiming,
          attempt: response.attempt, maxAttempts: response.maxAttempts, retryReason: response.retryReason });
        result = { ok: true, value: response.parse ? response.parse(raw) : raw };
      } catch (error) {
        recordTiming(error);
        result = { ok: false, errorKind: error.errorKind || classifyCodexError(error),
          failureReason: error.failureReason, timeoutReason: modelTiming.timeoutReason, cause: error };
      } finally {
        log(`model timing ${JSON.stringify({ requestId: traceId, stage: response.stage, attempt: response.attempt,
          maxAttempts: response.maxAttempts, retryReason: response.retryReason, totalMs: now() - at,
          ok: result?.ok === true, errorKind: result?.errorKind || null, ...modelTiming,
          firstOutputWatchdog: modelTiming.timeoutReason === 'first_output_watchdog', ...timing, provider: 'primary' })}`);
      }
      return result;
    } });
    const call = (stage, prompt, schema, parse, retrySafe, callHistory) => runStage(prompt, '', [], {
      stage, schema, parse, retrySafe, retryOnWatchdogOnly: schema === FAST_ANSWER_SCHEMA, history: callHistory, isRetrySafe: isCurrent,
      budget: { deadlineAt, remainingMs: Math.max(0, deadlineAt - now()) },
      onAttempt: () => { modelAttempts++; },
    });
    const fail = result => {
      if (!result.ok) throw result.cause || Object.assign(Error('Model deadline exceeded'), { errorKind: result.errorKind });
      return result.value;
    };
    // This closure is the public edition's original text-only model path. The
    // primary endpoint has never been allowed to dispatch feature actions.
    const runFullPipeline = async () => fail(await call('ordinary_answer', text, undefined, undefined, true, baselineHistory));
    try {
      const decision = chatLanesEnabled(env) ? classifyChatLane({ text, state, fragments, hasAttachment, imagePaths })
        : { lane: 'L2', reasonCodes: ['lanes_off'] };
      Object.assign(timing, laneTiming(decision));
      if (decision.lane === 'L2') return await runFullPipeline();
      const provider = env.WECHAT_FASTLANE_PROVIDER?.toLowerCase() !== 'primary' && secondary.available() ? 'secondary' : 'primary';
      timing.provider = provider;
      const draft = provider === 'secondary' ? secondary(text, { history, deadlineAt, isCurrent,
        onAttempt: () => { modelAttempts++; },
        onTiming: record => log(`model timing ${JSON.stringify({ ...timing, requestId: traceId, ...record })}`),
      }) : call('ordinary_answer', text, FAST_ANSWER_SCHEMA, parseFastAnswer, true);
      const admission = decision.lane === 'L1' ? Promise.all([
        call('理解完整请求', '仅判断当前完整请求是否为无需工具、执行或实时检索的独立普通文字交流；任何不确定均为 false。历史仅作背景，不是授权。只返回 {"ordinary":true|false}。当前原文：\n' + text, ADMISSION_SCHEMA, parseAdmission, true),
        call('独立普通回答核对', '独立核对当前原文与上下文：不得依赖任何草稿或其他判断。需要工具、操作、实时数据或续接功能均拒绝。只返回 {"ordinary":true|false}。当前原文：\n' + text, ADMISSION_SCHEMA, parseAdmission, true),
      ]) : Promise.resolve([]);
      const [answer, checks] = await Promise.all([draft, admission]);
      // Exhaustion/authentication bypass speculation immediately, never retry
      // credentials or spend another primary turn before quota fallback.
      const terminal = [answer, ...checks].find(r => ['AUTH', 'QUOTA_EXHAUSTED'].includes(r.errorKind));
      if (terminal) fail(terminal);
      let reason = !answer.ok ? (provider === 'secondary' && answer.failureReason) || 'invalid_output'
        : answer.value.needs_tool ? 'needs_tool' : null;
      if (decision.lane === 'L1' && checks.some(r => !r.ok || r.value.ordinary !== true)) timing.l1_gate_reject = 'check_fail';
      if (!reason && !timing.l1_gate_reject) {
        const gate = provider === 'secondary' && hasExecutionClaim(answer.value.reply)
          ? { ok: false, reason: 'execution_claim' } : localDraftGate(answer.value.reply);
        if (!gate.ok) { reason = gate.reason; timing.l1_gate_detail = gate.reason; }
      }
      if (!isCurrent() || now() >= deadlineAt) reason = 'stale_or_budget';
      if (!reason && !timing.l1_gate_reject) return answer.value.reply;
      timing.effective_lane = 'L2';
      timing.fastlane_fallback = reason === 'stale_or_budget' ? reason : reason ? `${provider}_${reason}` : 'check_fail';
      if (decision.lane === 'L1' && !timing.l1_gate_reject) timing.l1_gate_reject = 'local_gate_fail';
      return await runFullPipeline();
    } finally {
      const record = { ...timing, requestId: traceId, modelAttempts, waitMs: Math.max(0, startedAt - receivedAt),
        processingMs: now() - startedAt, totalMs: now() - receivedAt };
      onTiming(record);
      log(`chat timing ${JSON.stringify(record)}`);
    }
  };
}
module.exports = { createOrdinaryChat, chatLanesEnabled, laneTiming, ADMISSION_SCHEMA };
