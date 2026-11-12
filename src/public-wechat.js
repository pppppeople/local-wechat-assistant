'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJsonAtomic } = require('./json-file');
const { sendWechatHttp } = require('./wechat-http-send');
const { splitMessage } = require('./message-chunks');
const { validateWechatAccount } = require('./public-config');
const { ordinaryBatchDelay, MAX_WAIT_MS } = require('./ordinary-batch');
const { REQUEST_BUDGET_MS } = require('./chat-stage-policy');

// A single foreground consumer. No login-file discovery or other-account reply.
function createPublicWechat({ account, runtime, assistant, fetchImpl = fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  validateWechatAccount(account);
  const stateFile = path.join(runtime, 'state', 'transport', 'checkpoint.json');
  let state = readJson(stateFile, { binding: '', cursor: '', processed: [], pending: null });
  const binding = JSON.stringify([account.accountId, account.userId, account.baseUrl]);
  if (state.binding && state.binding !== binding) throw new Error('Transport binding changed; select a new runtime directory');
  state.binding = binding;
  state.queue ||= [];
  // Buffered records have not invoked anything; recover them through L2. An
  // executing/sending checkpoint remains held by the existing recovery rule.
  for (const job of state.queue) { job.status = 'queued'; job.recovery = true; }
  const save = () => writeJsonAtomic(stateFile, state);
  let timer, active, failure, initialized = false;
  const waiters = [];
  function settle() {
    if (failure || !active && !timer && !state.queue.length) {
      for (const { resolve, reject } of waiters.splice(0)) failure ? reject(failure) : resolve();
    }
  }
  function idle() {
    if (failure) return Promise.reject(failure);
    if (!active && !timer && !state.queue.length) return Promise.resolve();
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }
  function schedule() {
    if (timer) clearTimer(timer);
    timer = undefined;
    const buffered = state.queue.find(job => job.status === 'buffering');
    if (buffered) timer = setTimer(() => {
      timer = undefined; buffered.status = 'queued'; buffered.queuedAt = now(); save(); pump();
    }, ordinaryBatchDelay(buffered.receivedAt, now()));
    pump();
  }
  function pump() {
    if (active || failure) return;
    active = (async () => {
      await deliverPending();
      while (state.queue[0]?.status === 'queued') {
        const job = state.queue.shift();
        const processingAt = now();
        let laneRecord = {}, deliveryAt, delivered = false;
        state.pending = { ...job, status: 'executing' }; save();
        try {
          const reply = now() >= job.receivedAt + REQUEST_BUDGET_MS
          ? '本轮处理时间已达上限，未继续生成或派发。'
          : await assistant.reply(job.texts.join('\n'), 'owner', {
            id: job.messageId, accountId: account.accountId, senderId: account.userId,
            receivedAt: job.receivedAt, fragments: job.texts.length, hasAttachment: job.hasAttachment,
            recovery: job.recovery === true,
            traceId: job.deliveryId, onTiming: record => { laneRecord = record; },
          });
          state.pending = { ...state.pending, status: 'ready', chunks: splitMessage(String(reply), 1700), next: 0 }; save();
          deliveryAt = now();
          await deliverPending(); delivered = true;
        } finally {
          log(`chat timing ${JSON.stringify({ ...laneRecord, requestId: job.deliveryId, delivered,
            batchWaitMs: (job.queuedAt ?? processingAt) - job.receivedAt,
            queueWaitMs: processingAt - (job.queuedAt ?? processingAt),
            processingMs: (deliveryAt ?? now()) - processingAt,
            deliveryMs: deliveryAt === undefined ? null : now() - deliveryAt, totalMs: now() - job.receivedAt })}`);
        }
      }
    })().catch(error => { failure = error; }).finally(() => {
      active = null;
      if (!failure && state.queue[0]?.status === 'queued') pump();
      settle();
    });
  }
  function enqueue(message, text) {
    const messageId = String(message.message_id);
    const hasAttachment = message.item_list.some(item => item.type !== 1);
    const canBatch = assistant.canBatch?.(text) === true;
    const previous = state.queue.at(-1);
    if (previous?.status === 'buffering') {
      if (canBatch && now() < previous.receivedAt + MAX_WAIT_MS) {
        previous.texts.push(text); previous.messageIds.push(messageId);
        previous.context = message.context_token; previous.hasAttachment ||= hasAttachment;
        save(); schedule(); return;
      }
      previous.status = 'queued'; previous.queuedAt = now();
    }
    state.queue.push({ messageId, messageIds: [messageId], deliveryId: crypto.randomUUID(),
      context: message.context_token, receivedAt: now(), hasAttachment, texts: [text],
      status: canBatch ? 'buffering' : 'queued', ...(canBatch ? {} : { queuedAt: now() }) });
    save(); schedule();
  }
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
    state.processed = [...state.processed, ...(pending.messageIds || [pending.messageId])].slice(-500);
    state.pending = null; save();
  }
  async function pollOnce({ waitForIdle = true } = {}) {
    if (failure) throw failure;
    if (!initialized) { await deliverPending(); initialized = true; schedule(); }
    const updates = await poll();
    for (const message of updates.msgs || []) {
      if (message.from_user_id !== account.userId || (message.to_user_id && message.to_user_id !== account.accountId)) continue;
      const messageId = String(message.message_id || '');
      const text = (message.item_list || []).filter(item => item.type === 1 && typeof item.text_item?.text === 'string')
        .map(item => item.text_item.text).filter(value => value.trim()).join('\n');
      if (!messageId || typeof text !== 'string' || !text.trim() || !message.context_token || state.processed.includes(messageId)
        || state.pending?.messageIds?.includes(messageId) || state.pending?.messageId === messageId
        || state.queue.some(job => job.messageIds.includes(messageId))) continue;
      enqueue(message, text);
    }
    state.cursor = updates.get_updates_buf || state.cursor; save();
    if (waitForIdle) await idle();
  }
  return { pollOnce, idle };
}
module.exports = { createPublicWechat };
