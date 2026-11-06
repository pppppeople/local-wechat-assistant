'use strict';
// Read-only projection of existing logs. Never return message bodies or identities.
const METRICS = ['totalMs', 'startupMs', 'turnMs', 'cleanupMs', 'latencyMs', 'queueWaitMs', 'batchWaitMs', 'processingMs', 'deliveryMs', 'waitMs', 'processMs'];
function timingRecord(line) {
  const match = line.match(/^\[([^\]]+)\] (.*)$/);
  if (!match || !Number.isFinite(Date.parse(match[1]))) return null;
  const at = Date.parse(match[1]), text = match[2];
  const json = text.match(/^(model timing|tool timing|chat timing|assistant task) (\{.*\})$/);
  let value, event;
  if (json) {
    try { value = JSON.parse(json[2]); } catch { return null; }
    event = json[1];
  } else {
    value = Object.fromEntries([...text.matchAll(/(?:^| )([A-Za-z]+)=([^ ]*)/g)].map(m => [m[1], m[2]]));
    event = value.event;
    if (!['codex_stage', 'model_slot', 'job_started', 'job_completed'].includes(event)) return null;
  }
  const metrics = {};
  for (const key of METRICS) {
    if (value[key] === null || value[key] === undefined || value[key] === '') continue;
    const n = Number(value[key]);
    if (Number.isFinite(n) && n >= 0) metrics[key] = n;
  }
  return {at, delivered: value.delivered, ordinary: value.ordinary, requestId: value.requestId || '', event, stage: value.phase || value.stage || value.tool || event, metrics};
}
function createTimingSummary({since = Date.now()-86400000, requestId = ''} = {}) {
  const groups = new Map(), requests = new Map(); let matchedRecords = 0;
  return {
    add(line) {
      const r = timingRecord(line);
      if (!r || r.at < since || requestId && r.requestId !== requestId) return;
      if (r.requestId && ['assistant task', 'chat timing'].includes(r.event)) {
        const item = requests.get(r.requestId) || {};
        if (r.event === 'assistant task' && typeof r.ordinary === 'boolean') item.kind = r.ordinary ? 'chat' : 'task';
        if (r.event === 'chat timing') { item.delivered = r.delivered; item.totalMs = r.metrics.totalMs; }
        requests.set(r.requestId, item);
      }
      for (const [metric, value] of Object.entries(r.metrics)) {
        const key = JSON.stringify([r.event, r.stage, metric]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(value);
      }
      matchedRecords++;
    },
    result() {
      const endToEnd = ['chat', 'task', 'unknown'].map(kind => {
        const items = [...requests.values()].filter(r => (r.kind || 'unknown') === kind && r.delivered !== undefined);
        const values = items.filter(r => r.delivered === true && Number.isFinite(r.totalMs)).map(r => r.totalMs).sort((a,b) => a-b);
        return {kind, observed:items.length, delivered:items.filter(r=>r.delivered===true).length,
          notDelivered:items.filter(r=>r.delivered===false).length, timedSamples:values.length,
          p50:values.length ? values[Math.ceil(values.length*.5)-1] : null,
          p95:values.length ? values[Math.ceil(values.length*.95)-1] : null, max:values.length ? values.at(-1) : null};
      });
      return {since: new Date(since).toISOString(), matchedRecords, endToEnd, metrics: [...groups].map(([key, values]) => {
        values.sort((a,b)=>a-b); const [event, stage, metric] = JSON.parse(key);
        return {event, stage, metric, samples: values.length, p50: values[Math.ceil(values.length*.5)-1], p95: values[Math.ceil(values.length*.95)-1], max: values.at(-1)};
      })};
    },
  };
}
module.exports = {timingRecord, createTimingSummary};
