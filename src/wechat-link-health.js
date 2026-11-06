'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function compactError(error) {
  const name = String(error?.name || 'Error').slice(0, 80);
  const message = String(error?.message || error || 'unknown error')
    .replace(/\s+/g, ' ')
    .replace(/\b(authorization)(["'=:\s]+)(?:Bearer\s+)?[^\s,;}]+/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|password|cookie)(["'=:\s]+)\S+/gi, '$1$2[REDACTED]')
    .slice(0, 300);
  return `${name}: ${message}`;
}

function createWechatLinkHealth(file, options = {}) {
  const now = options.now || (() => new Date());

  function update(patch) {
    const current = readJson(file);
    const timestamp = now().toISOString();
    const next = {
      schemaVersion: 1,
      ...current,
      ...patch,
      updatedAt: timestamp,
    };
    try {
      writeJsonAtomic(file, next);
    } catch {}
    return next;
  }

  function recordPollSuccess(details = {}) {
    return update({
      status: 'healthy',
      lastPollSuccessAt: now().toISOString(),
      consecutivePollFailures: 0,
      lastPollMessageCount: Number(details.messageCount || 0),
      lastPollError: null,
    });
  }

  function recordPollFailure(error) {
    const current = readJson(file);
    return update({
      status: 'degraded',
      lastPollFailureAt: now().toISOString(),
      consecutivePollFailures: Number(current.consecutivePollFailures || 0) + 1,
      lastPollError: compactError(error),
    });
  }

  function recordSendSuccess() {
    return update({
      lastSendSuccessAt: now().toISOString(),
      consecutiveSendFailures: 0,
      lastSendError: null,
    });
  }

  function recordSendFailure(error) {
    const current = readJson(file);
    return update({
      status: 'degraded',
      lastSendFailureAt: now().toISOString(),
      consecutiveSendFailures: Number(current.consecutiveSendFailures || 0) + 1,
      lastSendError: compactError(error),
    });
  }

  return {
    read: () => readJson(file),
    recordPollFailure,
    recordPollSuccess,
    recordSendFailure,
    recordSendSuccess,
  };
}

module.exports = { compactError, createWechatLinkHealth };
