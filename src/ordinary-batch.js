'use strict';

const QUIET_MS = 1000;
const MAX_WAIT_MS = 3500;

// Called on each arrival; receivedAt always belongs to the first fragment.
function ordinaryBatchDelay(receivedAt, now = Date.now()) {
  return Math.max(0, Math.min(QUIET_MS, receivedAt + MAX_WAIT_MS - now));
}

module.exports = { ordinaryBatchDelay, QUIET_MS, MAX_WAIT_MS };
