'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJsonAtomic } = require('./json-file');
const { sendWechatHttp } = require('./wechat-http-send');
const { splitMessage } = require('./message-chunks');
const { validateWechatAccount } = require('./public-config');

// A single foreground consumer. No login-file discovery or other-account reply.
function createPublicWechat({ account, runtime, assistant, fetchImpl = fetch }) {
  validateWechatAccount(account);
  const stateFile = path.join(runtime, 'state', 'transport', 'checkpoint.json');
  let state = readJson(stateFile, { binding: '', cursor: '', processed: [], pending: null });
  const binding = JSON.stringify([account.accountId, account.userId, account.baseUrl]);
  if (state.binding && state.binding !== binding) throw new Error('Transport binding changed; select a new runtime directory');
  state.binding = binding;
  const save = () => writeJsonAtomic(stateFile, state);
  async function poll() {
    const base = account.baseUrl.endsWith('/') ? account.baseUrl : `${account.baseUrl}/`;
    const body = JSON.stringify({ get_updates_buf: state.cursor, base_info: { channel_version: '1.0.0' } });
    const response = await fetchImpl(new URL('ilink/bot/getupdates', base).href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000),
      headers: { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${account.token.trim()}`,
        'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString('base64'),
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body,
    });
    if (!response.ok) throw new Error(`Poll HTTP ${response.status}`);
    const result = await response.json();
    if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) throw new Error('Poll rejected');
    return result;
  }
  async function deliverPending() {
    const pending = state.pending;
    if (!pending) return;
    // A crash between invocation and checkpoint is never automatically replayed.
    if (pending.status !== 'ready') throw new Error('Uncertain prior operation; inspect private transport checkpoint before continuing');
    while (pending.next < pending.chunks.length) {
      pending.status = 'sending'; save();
      const result = await sendWechatHttp({ account, payload: {
        msg: { from_user_id: '', to_user_id: account.userId, client_id: `${pending.deliveryId}:${pending.next}`,
          message_type: 2, message_state: 2, context_token: pending.context,
          item_list: [{ type: 1, text_item: { text: pending.chunks[pending.next] } }] },
        base_info: { channel_version: '1.0.0' },
      } }, { fetchImpl });
      if (!result.confirmed) throw new Error('Send unconfirmed; inspect private transport checkpoint before continuing');
      pending.status = 'ready';
      // Save the next unsent chunk only after server acceptance.
      pending.next++; save();
    }
    state.processed = [...state.processed, pending.messageId].slice(-500);
    state.pending = null; save();
  }
  async function pollOnce() {
    await deliverPending();
    const updates = await poll();
    for (const message of updates.msgs || []) {
      if (message.from_user_id !== account.userId || (message.to_user_id && message.to_user_id !== account.accountId)) continue;
      const messageId = String(message.message_id || '');
      const text = (message.item_list || []).find(item => item.type === 1)?.text_item?.text;
      if (!messageId || typeof text !== 'string' || !text.trim() || !message.context_token || state.processed.includes(messageId)) continue;
      state.pending = { messageId, deliveryId: crypto.randomUUID(), context: message.context_token, status: 'executing' }; save();
      const reply = await assistant.reply(text, 'owner', { id: messageId, accountId: account.accountId, senderId: account.userId });
      state.pending = { ...state.pending, status: 'ready', chunks: splitMessage(String(reply), 1700), next: 0 }; save();
      await deliverPending();
    }
    state.cursor = updates.get_updates_buf || state.cursor; save();
  }
  return { pollOnce };
}
module.exports = { createPublicWechat };
