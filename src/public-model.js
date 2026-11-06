'use strict';

function createPublicModel(config, { fetchImpl = fetch } = {}) {
  if (!config.endpoint) return null;
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !config.name || !config.apiKey) {
    throw new Error('Configure an HTTPS MODEL_ENDPOINT, MODEL_NAME and MODEL_API_KEY');
  }
  return async text => {
    const response = await fetchImpl(url.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.name, messages: [
        { role: 'system', content: '你是本地文字助手。只回答当前问题。你没有工具权限，不能声称执行、保存或发送了任何操作。' },
        { role: 'user', content: String(text).slice(0, 12000) },
      ] }),
    });
    if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('Model returned no text');
    return reply.trim().slice(0, 12000);
  };
}
module.exports = { createPublicModel };
