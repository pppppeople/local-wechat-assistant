'use strict';

const DURATIONS = { '30分钟': 30 * 60000, '2小时': 2 * 3600000, '24小时': 24 * 3600000 };
const HELP = '请用“存临时信息 <文本> [有效期：30分钟/2小时/24小时]”、“临时信息”或“删除临时信息 <编号>”；默认2小时。';
const REFUSAL = '临时信息保管箱仅主人可用，好友不能保存、查看或删除任何条目。';
const SECRET_REFUSAL = '拒绝保存密码、验证码或密钥类内容。临时信息保管箱不具备加密保险箱能力。';
function containsSecret(text) {
  return /密码|口令|验证码|校验码|动态码|密钥|私钥|助记词|访问令牌|令牌|password|passwd|passphrase|\bpwd\b|\bpin\b|\botp\b|verification[ _-]*code|secret|api[ _-]*key|access[ _-]*key|(?:access|refresh|auth)[ _-]*token|private[ _-]*key|\btoken\b|\bbearer\b|-----BEGIN|\bsk-[a-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/iu.test(text);
}
function parseTemporaryNoteCommand(text) {
  const value = String(text || '').trim();
  if (value === '临时信息') return { type: 'list' };
  if (value.startsWith('删除临时信息')) {
    const id = value.slice('删除临时信息'.length).replace(/^[：:\s]+/u, '').trim();
    return /^[a-z0-9_-]+$/iu.test(id) ? { type: 'delete', id } : { type: 'invalid', reply: HELP };
  }
  if (value.startsWith('存临时信息')) {
    let body = value.slice('存临时信息'.length).replace(/^[：:\s]+/u, '').trim();
    if (containsSecret(body)) return { type: 'invalid', reply: SECRET_REFUSAL };
    let durationMs = DURATIONS['2小时'];
    // Optional duration is a trailing token, optionally labelled 有效期.
    const expiry = body.match(/(?:^|\s+)(?:有效期[：:]?\s*)?(\d+\s*(?:分钟|小时))$/u);
    if (expiry) {
      const duration = expiry[1].replace(/\s/gu, '');
      if (!Object.hasOwn(DURATIONS, duration)) return { type: 'invalid', reply: HELP };
      durationMs = DURATIONS[duration]; body = body.slice(0, expiry.index).trim();
    } else if (/(?:^|\s)有效期/u.test(body)) return { type: 'invalid', reply: HELP };
    return body ? { type: 'save', text: body, durationMs } : { type: 'invalid', reply: HELP };
  }
  if (value.startsWith('临时信息')) return { type: 'invalid', reply: HELP };
  return null;
}
module.exports = { parseTemporaryNoteCommand, containsSecret, DURATIONS, HELP, REFUSAL, SECRET_REFUSAL };
