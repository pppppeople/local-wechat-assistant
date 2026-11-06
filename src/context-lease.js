'use strict';

const MAX_CONTEXT_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_PROACTIVE_SENDS = 8;
const CONTEXT_WARNING_AGE_MS = 18 * 60 * 60 * 1000;
const CONTEXT_WARNING_SENDS = 6;

function refreshContextLease(leases, { senderId, token, now = Date.now() }) {
  if (!senderId || !token) return leases;
  return {
    ...(leases && typeof leases === 'object' ? leases : {}),
    [senderId]: {
      token,
      updatedAt: new Date(now).toISOString(),
      proactiveSends: 0,
    },
  };
}

function contextLeaseStatus(leases, { senderId, token, now = Date.now() }) {
  const lease = leases && typeof leases === 'object' ? leases[senderId] : null;
  if (!token || !lease || lease.token !== token) return { available: false, reason: 'missing' };
  if (lease.invalidatedAt) return { available: false, reason: 'invalidated' };
  const updatedAt = new Date(lease.updatedAt || 0).getTime();
  if (!Number.isFinite(updatedAt) || now - updatedAt >= MAX_CONTEXT_AGE_MS) {
    return { available: false, reason: 'expired' };
  }
  if (Number(lease.proactiveSends || 0) >= MAX_PROACTIVE_SENDS) {
    return { available: false, reason: 'budget' };
  }
  return { available: true, reason: 'fresh' };
}

function recordProactiveSend(leases, { senderId, token, now = Date.now() }) {
  const lease = leases && typeof leases === 'object' ? leases[senderId] : null;
  if (!lease || lease.token !== token) return leases;
  return {
    ...leases,
    [senderId]: {
      ...lease,
      proactiveSends: Number(lease.proactiveSends || 0) + 1,
      lastProactiveSendAt: new Date(now).toISOString(),
    },
  };
}

function contextLeaseWarningStatus(leases, { senderId, token, now = Date.now() }) {
  const status = contextLeaseStatus(leases, { senderId, token, now });
  if (!status.available) return { due: false, reason: status.reason };
  const lease = leases[senderId];
  if (lease.warningSentAt) return { due: false, reason: 'already_sent' };
  const updatedAt = new Date(lease.updatedAt || 0).getTime();
  if (Number(lease.proactiveSends || 0) >= CONTEXT_WARNING_SENDS) {
    return { due: true, reason: 'budget' };
  }
  if (now - updatedAt >= CONTEXT_WARNING_AGE_MS) {
    return { due: true, reason: 'age' };
  }
  return { due: false, reason: 'fresh' };
}

function recordContextLeaseWarning(leases, { senderId, token, now = Date.now() }) {
  const lease = leases && typeof leases === 'object' ? leases[senderId] : null;
  if (!lease || lease.token !== token || lease.warningSentAt) return leases;
  return {
    ...leases,
    [senderId]: {
      ...lease,
      warningSentAt: new Date(now).toISOString(),
    },
  };
}

function invalidateContextLease(leases, { senderId, token, now = Date.now() }) {
  const lease = leases && typeof leases === 'object' ? leases[senderId] : null;
  if (!lease || lease.token !== token) return leases;
  return {
    ...leases,
    [senderId]: {
      ...lease,
      invalidatedAt: new Date(now).toISOString(),
    },
  };
}

function isContextRefreshFailure(error) {
  return /(?:send ret=-2|prepare failed|context refresh required)/iu.test(String(error?.message || error || ''));
}

function contextRefreshError(reason) {
  const error = new Error(`context refresh required: ${reason || 'unavailable'}`);
  error.code = 'WECHAT_CONTEXT_REFRESH_REQUIRED';
  return error;
}

module.exports = {
  CONTEXT_WARNING_AGE_MS,
  CONTEXT_WARNING_SENDS,
  MAX_CONTEXT_AGE_MS,
  MAX_PROACTIVE_SENDS,
  contextLeaseStatus,
  contextLeaseWarningStatus,
  contextRefreshError,
  invalidateContextLease,
  isContextRefreshFailure,
  recordContextLeaseWarning,
  recordProactiveSend,
  refreshContextLease,
};
