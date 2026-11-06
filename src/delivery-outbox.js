'use strict';

const fs = require('fs');
const path = require('path');
const { compactError } = require('./wechat-link-health');

function createDeliveryOutbox(file, options = {}) {
  const now = options.now || (() => new Date());

  function read() {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, deliveries: [] };
      throw error;
    }
    try {
      const value = JSON.parse(content);
      if (!value || Object.getPrototypeOf(value) !== Object.prototype
        || !Array.isArray(value.deliveries)) {
        throw new Error('Expected an object with a deliveries array');
      }
      return value;
    } catch (error) {
      const base = `${file}.corrupt-${now().toISOString().replace(/[^a-zA-Z0-9-]/g, '-')}`;
      let quarantine = base;
      let suffix = 0;
      while (fs.existsSync(quarantine)) quarantine = `${base}-${++suffix}`;
      try {
        fs.renameSync(file, quarantine);
      } catch (renameError) {
        throw new Error(`Delivery outbox file is corrupt: ${file}; failed to quarantine to ${quarantine}: ${renameError.message}`);
      }
      throw new Error(`Delivery outbox file is corrupt; quarantined to ${quarantine}: ${error.message}`);
    }
  }

  function write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function enqueue(delivery) {
    const state = read();
    if (state.deliveries.some((item) => item.id === delivery.id)) return false;
    const createdAt = now().toISOString();
    const initialDelayMs = Math.max(0, Number(delivery.initialDelayMs || 0));
    state.deliveries.push({
      id: String(delivery.id),
      clientId: String(delivery.clientId || delivery.id).slice(0, 240),
      accountId: String(delivery.accountId || ''),
      senderId: String(delivery.senderId),
      text: String(delivery.text || '').slice(0, 12000),
      kind: String(delivery.kind || 'text').slice(0, 80),
      metadata: {
        historyId: String(delivery.metadata?.historyId || '').slice(0, 240),
        userText: String(delivery.metadata?.userText || '').slice(0, 3000),
        recordHistory: delivery.metadata?.recordHistory !== false,
        historyText: String(delivery.metadata?.historyText || '').slice(0, 1800),
        imageCount: Math.max(0, Number(delivery.metadata?.imageCount || 0)),
      },
      status: 'pending',
      attempts: 0,
      createdAt,
      nextAttemptAt: new Date(now().getTime() + initialDelayMs).toISOString(),
    });
    write(state);
    return true;
  }

  function claim() {
    const state = read();
    const timestamp = now().getTime();
    const delivery = state.deliveries.find((item) => (
      item.status === 'pending'
      && item.waitingForContext !== true
      && new Date(item.nextAttemptAt || item.createdAt || 0).getTime() <= timestamp
    ));
    if (!delivery) return null;
    delivery.status = 'processing';
    delivery.attempts = Number(delivery.attempts || 0) + 1;
    delivery.startedAt = now().toISOString();
    write(state);
    return { ...delivery, metadata: { ...(delivery.metadata || {}) } };
  }

  function complete(id) {
    const state = read();
    const before = state.deliveries.length;
    state.deliveries = state.deliveries.filter((item) => item.id !== id);
    if (state.deliveries.length !== before) write(state);
  }

  function defer(id, error, delayMs = 15000) {
    const state = read();
    const delivery = state.deliveries.find((item) => item.id === id);
    if (!delivery) return false;
    delivery.status = 'pending';
    delivery.lastError = compactError(error);
    delivery.lastFailureAt = now().toISOString();
    delivery.nextAttemptAt = new Date(now().getTime() + delayMs).toISOString();
    write(state);
    return true;
  }

  function waitForContext(id, error) {
    const state = read();
    const delivery = state.deliveries.find((item) => item.id === id);
    if (!delivery) return false;
    delivery.status = 'pending';
    delivery.waitingForContext = true;
    delivery.lastError = compactError(error);
    delivery.lastFailureAt = now().toISOString();
    delete delivery.nextAttemptAt;
    write(state);
    return true;
  }

  function refreshContext(senderId) {
    const state = read();
    let resumed = 0;
    for (const delivery of state.deliveries) {
      if (delivery.senderId !== senderId || delivery.status !== 'pending' || delivery.waitingForContext !== true) continue;
      delivery.waitingForContext = false;
      delivery.nextAttemptAt = now().toISOString();
      delete delivery.lastError;
      resumed += 1;
    }
    if (resumed) write(state);
    return resumed;
  }

  function recover() {
    const state = read();
    let recovered = 0;
    for (const delivery of state.deliveries) {
      if (delivery.status !== 'processing') continue;
      delivery.status = 'pending';
      delivery.nextAttemptAt = now().toISOString();
      recovered += 1;
    }
    if (recovered) write(state);
    return recovered;
  }

  function cancelPending(senderId) {
    const state = read();
    const removed = state.deliveries.filter((item) => (
      item.senderId === senderId && item.status === 'pending'
    ));
    if (!removed.length) return [];
    state.deliveries = state.deliveries.filter((item) => (
      item.senderId !== senderId || item.status !== 'pending'
    ));
    write(state);
    return removed;
  }

  function count() {
    return read().deliveries.length;
  }

  function nextAttemptDelay() {
    const timestamp = now().getTime();
    const dueTimes = read().deliveries
      .filter((item) => item.status === 'pending')
      .filter((item) => item.waitingForContext !== true)
      .map((item) => new Date(item.nextAttemptAt || item.createdAt || 0).getTime())
      .filter(Number.isFinite);
    if (!dueTimes.length) return null;
    return Math.max(0, Math.min(...dueTimes) - timestamp);
  }

  return {
    cancelPending,
    claim,
    complete,
    count,
    defer,
    enqueue,
    nextAttemptDelay,
    read,
    recover,
    refreshContext,
    waitForContext,
  };
}

module.exports = { createDeliveryOutbox };

function ordinaryDeliveryBindingValid(account, delivery) {
  return delivery.kind !== 'ordinary-answer' || !!delivery.accountId
    && account?.accountId === delivery.accountId && account?.userId === delivery.senderId;
}
module.exports.ordinaryDeliveryBindingValid = ordinaryDeliveryBindingValid;
