'use strict';
function confirmedWechatSend(status, data) {
  if (!(status >= 200 && status < 300)) return false;
  // Explicit errors win even when another field contains a success receipt.
  if (data?.errcode !== undefined && data.errcode !== 0) return false;
  if (typeof data?.ret === 'number') return data.ret === 0;
  const id = data?.message_id;
  return status === 200 && ((typeof id === 'string' && id.trim().length > 0)
    || (typeof id === 'number' && Number.isFinite(id) && id > 0));
}
module.exports = { confirmedWechatSend };
