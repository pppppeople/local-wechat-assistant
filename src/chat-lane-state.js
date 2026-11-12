'use strict';

// Only enabled host features supply probes. Bodies never enter timing records.
function captureChatLaneState({ probes, item = {}, history = [] }) {
  try {
    if (!Array.isArray(probes) || !probes.length) return { known: false };
    const pendingReasons = [];
    for (const [name, read] of probes) {
      const pending = read();
      if (typeof pending !== 'boolean') return { known: false };
      if (pending) pendingReasons.push(name);
    }
    return { known: true, pending: pendingReasons.length > 0, pendingReasons, history,
      recovery: Boolean(item.recovery || item.expired || item.taskState || typeof item.hasAttachment !== 'boolean') };
  } catch { return { known: false }; }
}
module.exports = { captureChatLaneState };
