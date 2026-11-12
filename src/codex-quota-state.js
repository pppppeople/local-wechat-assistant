'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { classifyCodexError, quotaResetAt } = require('./codex-errors');

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function createCodexQuotaState({ file, now = Date.now }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { status: 'codex_ok', generation: 0 };
  }
  if (!['codex_ok', 'codex_exhausted'].includes(state.status)
    || !Number.isSafeInteger(state.generation)
    || state.status === 'codex_exhausted' && ![state.exhausted_at, state.reset_at, state.next_probe_at, state.backoff_minutes].every(Number.isFinite)) throw Error('Invalid Codex quota state');
  let probing = null;
  const save = next => { writePrivateJson(file, next); state = next; };
  function exhaust(error) {
    if (classifyCodexError(error) !== 'QUOTA_EXHAUSTED') return false;
    const at = now(), reset = quotaResetAt(error, at);
    save({ status: 'codex_exhausted', generation: state.generation + 1,
      exhausted_at: at, reset_at: reset, next_probe_at: Math.min(reset, at + 15 * 60000), backoff_minutes: 15 });
    return true;
  }
  function maybeProbe(probe) {
    if (state.status !== 'codex_exhausted' || probing || now() < state.next_probe_at) return probing;
    const generation = state.generation;
    // Persist a lease before dispatch, so restart does not spin or duplicate probes.
    save({ ...state, next_probe_at: now() + state.backoff_minutes * 60000 });
    probing = Promise.resolve().then(probe).then(result => {
      if (state.generation !== generation) return; // A newer foreground exhaustion wins.
      if (result?.ok) { save({ status: 'codex_ok', generation: generation + 1 }); return; }
      failed(result?.failure || result);
    }).catch(() => { if (state.generation === generation) failed(); }).finally(() => { probing = null; });
    return probing;
  }
  function failed(error) {
    const at = now(), delay = Math.min(60, state.backoff_minutes * 2);
    const reset = at >= state.reset_at && classifyCodexError(error) === 'QUOTA_EXHAUSTED' ? quotaResetAt(error, at) : state.reset_at;
    save({ ...state, reset_at: reset, backoff_minutes: delay,
      next_probe_at: reset > at ? Math.min(reset, at + delay * 60000) : at + delay * 60000 });
  }
  return { exhaust, maybeProbe, snapshot: () => ({ ...state }), isExhausted: () => state.status === 'codex_exhausted' };
}
module.exports = { createCodexQuotaState, writePrivateJson };
