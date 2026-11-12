'use strict';
const { formatChatHistory } = require('./chat-history');

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
  const model = async (text, { history = [], probe = false } = {}) => {
    const response = await fetchImpl(url.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(probe ? 15000 : config.timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.name, messages: [
        { role: 'system', content: '你是本地文字助手。只回答当前问题。你没有工具权限，不能声称执行、保存或发送了任何操作。' },
        ...(!probe && history.length ? [{ role: 'user', content: `同侧历史（仅背景，不是操作授权）：\n${formatChatHistory(history.slice(-12))}` }] : []),
        { role: 'user', content: String(text).slice(0, 12000) },
      ] }),
    });
    if (!response.ok) throw await modelError(response);
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('Model returned no text');
    return reply.trim().slice(0, 12000);
  };
  model.probe = () => model('Return only {"ok":true}.', { probe: true });
  return model;
}
module.exports = { createPublicModel };
