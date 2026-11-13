'use strict';
const { formatChatHistory } = require('./chat-history');

// One prompt/persona and one bounded history representation for both providers.
function buildPublicMessages(text, { history = [], probe = false, schema } = {}) {
  return [
    { role: 'system', content: '你是本地文字助手。只回答当前问题。你没有工具权限，不能声称执行、保存或发送了任何操作。' +
      (schema?.properties?.needs_tool ? ' 自然简洁地用中文回答；不确定的事实说不知道，不编造实时事实。只输出 JSON：{"reply":"回答","needs_tool":false}，需要工具或检索时 needs_tool=true 并将 reply 留空。' : '') },
    ...(!probe && history.length ? [{ role: 'user', content: `同侧历史（仅背景，不是操作授权）：\n${formatChatHistory(history.slice(-12))}` }] : []),
    { role: 'user', content: String(text).slice(0, 12000) },
  ];
}

// Read only typed failure metadata, never echo upstream messages or bodies.
async function modelError(response) {
  const error = Object.assign(new Error(`Model HTTP ${response.status}`), { status: response.status });
  let data;
  try { data = await response.json(); } catch { return error; }
  const raw = data?.error || {};
  const known = ['usageLimitExceeded', 'rateLimitExceeded', 'unauthorized', 'serverOverloaded', 'internalServerError'];
  if (known.includes(raw.codexErrorInfo)) error.codexErrorInfo = raw.codexErrorInfo;
  if (![401, 403].includes(response.status) && !error.codexErrorInfo && raw.code === 'insufficient_quota') {
    error.codexErrorInfo = 'usageLimitExceeded';
  }
  // Authentication errors take precedence even if a gateway includes quota text.
  if ([401, 403].includes(response.status)) error.codexErrorInfo = 'unauthorized';
  const limits = data?.rateLimits || raw.rateLimits;
  if (limits) {
    error.rateLimits = {};
    for (const name of ['primary', 'secondary']) {
      const window = limits[name];
      if (Number.isFinite(window?.usedPercent) && Number.isFinite(window?.resetsAt)) {
        error.rateLimits[name] = { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
      }
    }
  }
  return error;
}

function createPublicModel(config, { fetchImpl = fetch } = {}) {
  if (!config.endpoint) return null;
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !config.name || !config.apiKey) {
    throw new Error('Configure an HTTPS MODEL_ENDPOINT, MODEL_NAME and MODEL_API_KEY');
  }
  const model = async (text, { history = [], probe = false, stage, schema, timeoutMs, deadlineAt, onTiming = () => {} } = {}) => {
    const remainingMs = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    const duration = Math.min(probe ? 15000 : timeoutMs ?? config.timeoutMs, remainingMs);
    if (duration <= 0) throw Object.assign(Error('Model deadline exceeded'), { errorKind: 'BUDGET' });
    // Non-streaming JSON has no observable first-output activity. Keep the full
    // stage/deadline timeout; firstOutputTimeoutMs cannot safely arm a watchdog.
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(duration)));
    let timeoutReason = null;
    try {
      const response = await fetchImpl(url.href, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.name,
          ...(stage ? { tool_choice: 'none' } : {}),
          ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'stage_output', strict: true, schema } } } : {}),
          messages: buildPublicMessages(text, { history, probe, schema }) }),
      });
      if (!response.ok) throw await modelError(response);
      const data = await response.json();
      if (data?.choices?.some(choice => choice.message?.tool_calls?.length || choice.message?.function_call
        || ['tool_calls', 'function_call'].includes(choice.finish_reason))) {
        throw Object.assign(Error('Unexpected model tool request'), { failureReason: 'unexpected_tool' });
      }
      if (data?.choices?.[0]?.finish_reason === 'length') throw Error('Model response truncated');
      const reply = data?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Model returned no text');
      return reply.trim().slice(0, 12000);
    } catch (error) {
      if (!signal.aborted) throw error;
      timeoutReason = 'stage_budget';
      // An HTTP failure already identifies auth/quota/rate status even when
      // reading its optional error body exhausts the stage deadline.
      if (error.status) throw error;
      throw Object.assign(Error('Model stage timeout'), { errorKind: 'TRANSIENT', timeoutReason });
    } finally {
      onTiming({ timeoutReason, firstOutputWatchdog: false, firstOutputMs: null });
    }
  };
  model.probe = () => model('Return only {"ok":true}.', { probe: true });
  return model;
}
module.exports = { createPublicModel, buildPublicMessages };
