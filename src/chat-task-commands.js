'use strict';

function parseChatTaskCommand(text, { side = 'owner', hasPending = false } = {}) {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (/^把(?:刚才|刚刚|上面)(?:讨论的|说的)(?:整理一下[，,]?\s*)?[，,]?\s*生成(?:一个|一份)任务[。！!]?$/u.test(value)) return { type: 'generate' };
  const confirmation = value.match(/^执行 ([A-Z0-9]{8})$/u);
  if (confirmation) return { type: 'confirm', code: confirmation[1] };
  if (/^(?:好|好的|好呀|行|可以|执行吧|执行|确认|确定|执行\s+\S+)[。！!]?$/u.test(value) && (typeof hasPending === 'function' ? hasPending() : hasPending)) return { type: 'invalid_confirm' };
  return null;
}

module.exports = { parseChatTaskCommand };
