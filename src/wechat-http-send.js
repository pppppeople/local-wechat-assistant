'use strict';

const crypto = require('crypto');
const { confirmedWechatSend } = require('./wechat-send-result');

// Transport only: no account/state reads, history, leases, retries or bookkeeping.
async function sendWechatHttp({ account, payload }, {
  fetchImpl = fetch, timeoutMs = 15000, randomBytes = crypto.randomBytes,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status, data, text;
  try {
    const body = JSON.stringify(payload);
    const base = account.baseUrl.endsWith('/') ? account.baseUrl : `${account.baseUrl}/`;
    const response = await fetchImpl(new URL('ilink/bot/sendmessage', base).href, {
      method: 'POST',
      headers: {
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
        Authorization: `Bearer ${account.token.trim()}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      },
      body, signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
    if (!(status >= 200 && status < 300)) throw new Error(`微信 HTTP ${status}`);
    data = JSON.parse(text || '{}');
    if (!confirmedWechatSend(status, data)) {
      const detail = String(data?.errmsg || '').replace(/\s+/g, ' ').slice(0, 120);
      const reason = typeof data?.ret === 'number' && data.ret !== 0 ? `send ret=${data.ret}`
        : data?.errcode !== undefined && data.errcode !== 0 ? `send errcode=${data.errcode}` : '微信未确认发送成功';
      throw new Error(`${reason}${detail ? `: ${detail}` : ''}`);
    }
    return { state: 'confirmed', confirmed: true, status, data, text };
  } catch (error) {
    return { state: 'unconfirmed', confirmed: false, status, data, text, error };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendWechatHttp };
