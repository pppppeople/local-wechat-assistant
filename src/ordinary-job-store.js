'use strict';

const fs = require('fs');
const path = require('path');

function isValidRecord(job) {
  return job !== null && typeof job === 'object'
    && (Object.getPrototypeOf(job) === Object.prototype || Object.getPrototypeOf(job) === null)
    && typeof job.id === 'string' && job.id.trim().length > 0
    && typeof job.accountId === 'string' && typeof job.senderId === 'string'
    && Number.isFinite(job.receivedAt);
}

// A private, short-lived execution journal, never an ordinary-chat memory source.
function createOrdinaryJobStore(file, { now = Date.now, ttlMs = 20 * 3600000 } = {}) {
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(state.jobs)) throw new Error('invalid ordinary task journal');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, jobs: [] };
      throw error;
    }
  }
  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function get(id) { return read().jobs.find((job) => isValidRecord(job) && job.id === id); }
  function save(job) {
    const state = read();
    const index = state.jobs.findIndex((item) => isValidRecord(item) && item.id === job.id);
    const value = { ...job, updatedAt: now() };
    delete value.timer;
    if (index < 0) state.jobs.push(value);
    else state.jobs[index] = value;
    write(state);
    return value;
  }
  function update(id, fields) {
    const job = get(id);
    if (!job) return null; // An explicit cancellation must not resurrect work.
    return save({ ...job, ...fields });
  }
  function complete(id) {
    const state = read();
    state.jobs = state.jobs.filter((job) => !isValidRecord(job) || job.id !== id);
    write(state);
  }
  function recover(account) {
    const state = read();
    const ready = [], held = [];
    for (let index = 0; index < state.jobs.length; index++) {
      let job = state.jobs[index];
      if (!isValidRecord(job)) {
        // Primitive/array records need an envelope so their original value survives.
        if (job === null || typeof job !== 'object' || Array.isArray(job)) {
          job = state.jobs[index] = { invalidRecord: job };
        }
        job.status = 'held'; job.holdReason = 'invalid_record'; held.push(job);
        continue;
      }
      if (job.accountId !== account?.accountId || job.senderId !== account?.userId) {
        job.status = 'held'; job.holdReason = 'account_binding_changed'; held.push(job);
      } else {
        // Old, unstarted requests cannot unexpectedly mutate after a long outage.
        if (now() - job.receivedAt > ttlMs && !job.finalDeliveries) job.expired = true;
        job.status = 'queued'; job.queuedAt ??= now(); ready.push({ ...job });
      }
    }
    if (state.jobs.length) write(state);
    return { ready, held };
  }
  function cancel(senderId) {
    const state = read();
    const removed = state.jobs.filter((job) => isValidRecord(job) && job.senderId === senderId);
    state.jobs = state.jobs.filter((job) => !isValidRecord(job) || job.senderId !== senderId);
    if (removed.length) write(state);
    return removed;
  }
  function hasMessage(id) { return !!id && read().jobs.some((job) => isValidRecord(job) && (job.messageIds || [job.id]).includes(id)); }
  return { read, get, hasMessage, save, update, complete, recover, cancel, count: () => read().jobs.filter(isValidRecord).length };
}

function recoveryReply(job) {
  const completed = (job.taskState?.results || []).map((result) => result.reply).filter(Boolean).join('\n\n');
  const reason = job.expired ? '这条请求等待超过20小时，剩余步骤没有继续执行。'
    : '助手重启前有一步已派发，但没有拿到完整结果；为避免重复操作，没有重新执行。';
  return [completed, reason].filter(Boolean).join('\n\n');
}

// Persist the reply first. Enqueue and journal removal are synchronous: no sender
// may run between them. Recovery repeats this handoff using the same client IDs.
function handoffOrdinaryAnswer(store, outbox, id, deliveries) {
  const saved = store.update(id, { finalDeliveries: deliveries, status: 'delivering' });
  if (!saved) return false;
  deliveries.forEach((delivery) => outbox.enqueue(delivery));
  store.complete(id);
  return true;
}

module.exports = { createOrdinaryJobStore, recoveryReply, handoffOrdinaryAnswer };
