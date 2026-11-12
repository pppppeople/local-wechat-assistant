'use strict';

function protocolError(raw, extra = {}) {
  return Object.assign(new Error(raw?.message || 'Codex turn failed'), {
    codexErrorInfo: raw?.codexErrorInfo, rpcCode: raw?.code, data: raw?.data,
    additionalDetails: raw?.additionalDetails, ...extra,
  });
}

function classifyCodexError(error) {
  const raw = error?.params?.turn?.error || error?.params?.error || error?.turn?.error || error?.error || error || {};
  const info = raw.codexErrorInfo || raw.data?.codexErrorInfo;
  const variant = typeof info === 'string' ? info : Object.keys(info || {})[0];
  const status = info?.[variant]?.httpStatusCode ?? raw.status ?? raw.statusCode ?? raw.httpStatusCode;
  // Installed Codex app-server generate-json-schema (2026-11-12):
  // TurnCompletedNotification.params.turn.error / ErrorNotification.params.error
  // are TurnError {message,codexErrorInfo,additionalDetails}. CodexErrorInfo has
  // distinct usageLimitExceeded/rateLimitExceeded strings and tagged HTTP variants.
  // JSON-RPC errors carry code/message/data, NOT an HTTP status in code.
  if (variant === 'usageLimitExceeded') return 'QUOTA_EXHAUSTED';
  if (variant === 'unauthorized' || status === 401 || status === 403) return 'AUTH';
  if (variant === 'rateLimitExceeded' || status === 429) return 'RATE_LIMITED';
  if (['serverOverloaded', 'internalServerError', 'httpConnectionFailed', 'responseStreamConnectionFailed',
    'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(variant) || status >= 500) return 'TRANSIENT';
  // Compatibility only for older CLI/SDK or RPC errors without typed evidence.
  // Never treat a generic limit, quota word, 429, or session budget as usage exhaustion.
  const message = String(raw.message || (typeof error === 'string' ? error : ''));
  if (/\b(?:401|403)\b|unauthorized|authentication|refresh.token.*(?:expired|invalid)/iu.test(message)) return 'AUTH';
  if (!variant && /(?:you(?:'|’)ve hit your usage limit|usage limit (?:has been )?(?:exceeded|reached|exhausted)|usage_limit_reached|usageLimitExceeded)/iu.test(message)) return 'QUOTA_EXHAUSTED';
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) return 'RATE_LIMITED';
  if (/timed? ?out|timeout|disconnect|connection|ECONNRESET|EPIPE|\b50[0-9]\b|\b503\b/iu.test(message)) return 'TRANSIENT';
  return 'UNKNOWN';
}

function quotaResetAt(error, now = Date.now()) {
  // TurnError currently has no resetsAt. The app-server attaches the most recent
  // structured account/rateLimits/updated snapshot; resetsAt is Unix seconds.
  // Multiple exhausted windows: all must recover, so use the latest reset.
  const limits = error?.rateLimits || {};
  const windows = [limits.primary, limits.secondary];
  const times = windows.filter(w => w?.usedPercent >= 100 && Number.isFinite(w.resetsAt))
    .map(w => w.resetsAt * 1000).filter(t => t > now);
  return times.length ? Math.max(...times) : now + 5 * 60 * 60 * 1000;
}
module.exports = { protocolError, classifyCodexError, quotaResetAt };
