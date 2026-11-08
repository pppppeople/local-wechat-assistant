'use strict';
const path = require('node:path');
const { readJson, writeJsonAtomic, isJsonObject } = require('./json-file');
const { refreshContextLease, recordContextLeaseWarning, contextLeaseWarningStatus,
  consumeContextRefreshReply } = require('./context-lease');

// Host-owned leases, separate from the transport's delivery checkpoint.
function createContextLeaseStore({ runtime, now = () => Date.now() }) {
  const stateFile = path.join(runtime, 'state', 'transport', 'context-leases.json');
  const load = () => readJson(stateFile, {}, { validate: isJsonObject });
  const save = leases => writeJsonAtomic(stateFile, leases, { validate: isJsonObject });
  function update(fn, input) {
    const leases = load();
    const next = fn(leases, { ...input, now: now() });
    if (next !== leases) save(next);
  }
  return {
    stateFile,
    refresh: input => update(refreshContextLease, input),
    // Call only after the host confirms its refresh reminder was sent.
    recordWarning: input => update(recordContextLeaseWarning, input),
    warningStatus: input => contextLeaseWarningStatus(load(), { ...input, now: now() }),
    consumeRefreshReply(senderId) {
      const leases = load();
      const result = consumeContextRefreshReply(leases, { senderId, now: now() });
      if (result.leases !== leases) save(result.leases);
      return result.consumed;
    },
  };
}
module.exports = { createContextLeaseStore };
