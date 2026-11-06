'use strict';
const os = require('node:os');
const path = require('node:path');

function loadPublicConfig(env = process.env, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const runtime = path.resolve(cwd, env.WECHAT_ASSISTANT_HOME || path.join(dataHome, 'wechat-assistant-framework', 'runtime'));
  const timeoutMs = Number(env.MODEL_TIMEOUT_MS || 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid MODEL_TIMEOUT_MS');
  return {
    runtime,
    account: { accountId: env.WECHAT_ACCOUNT_ID || '', userId: env.WECHAT_OWNER_ID || '', token: env.WECHAT_TOKEN || '', baseUrl: env.WECHAT_BASE_URL || '' },
    model: { endpoint: env.MODEL_ENDPOINT || '', name: env.MODEL_NAME || '', apiKey: env.MODEL_API_KEY || '', timeoutMs },
  };
}
function validateWechatAccount(account) {
  if (!['accountId', 'userId', 'token', 'baseUrl'].every(key => typeof account[key] === 'string' && account[key].trim())) {
    throw new Error('Configure WECHAT_BASE_URL, WECHAT_ACCOUNT_ID, WECHAT_OWNER_ID and WECHAT_TOKEN before connecting');
  }
  let url;
  try { url = new URL(account.baseUrl); } catch { throw new Error('Invalid WECHAT_BASE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('WECHAT_BASE_URL must be HTTPS without embedded credentials');
}
module.exports = { loadPublicConfig, validateWechatAccount };
