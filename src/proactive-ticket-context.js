'use strict';

const { eventTimestamp } = require('./universal-inbox-store');

function shanghaiTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp));
}

function arrivalTimestamp(item) {
  const departureAt = eventTimestamp(item?.eventTime);
  if (!Number.isFinite(departureAt)) return NaN;
  const summary = String(item?.summary || '');
  const match = summary.match(/(?:(次日|翌日)\s*)?(\d{1,2}):(\d{2})\s*(?:到达|抵达|落地)/u);
  if (!match) return NaN;
  const departure = new Date(departureAt);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(departure).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  let value = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${String(match[2]).padStart(2, '0')}:${match[3]}:00+08:00`);
  if (match[1] || value <= departureAt) value += 24 * 60 * 60 * 1000;
  return value;
}

function ticketPhase(item, currentTime = Date.now()) {
  const departureAt = eventTimestamp(item?.eventTime);
  if (!Number.isFinite(departureAt)) return null;
  const arrivalAt = arrivalTimestamp(item);
  if (currentTime < departureAt) return { name: '出发前', departureAt, arrivalAt };
  if (Number.isFinite(arrivalAt) && currentTime < arrivalAt) return { name: '途中', departureAt, arrivalAt };
  if (Number.isFinite(arrivalAt)) return { name: '已过计划到达时间', departureAt, arrivalAt };
  return { name: '已过出发时间（到达时间未知）', departureAt, arrivalAt };
}

function relevantTickets(state, currentTime = Date.now()) {
  return (Array.isArray(state?.items) ? state.items : [])
    .filter((item) => item?.kind === 'ticket' && item.status === 'active'
      && Array.isArray(item.participantSides) && item.participantSides.includes('owner'))
    .map((item) => ({ item, phase: ticketPhase(item, currentTime) }))
    .filter(({ phase }) => phase && phase.departureAt > currentTime - 24 * 60 * 60 * 1000)
    .sort((left, right) => left.phase.departureAt - right.phase.departureAt)
    .slice(0, 5);
}

function buildTicketTimingContext(state, currentTime = Date.now()) {
  const tickets = relevantTickets(state, currentTime);
  if (!tickets.length) return '';
  const lines = tickets.map(({ item, phase }) => {
    const arrival = Number.isFinite(phase.arrivalAt) ? `，计划到达 ${shanghaiTime(phase.arrivalAt)}` : '';
    const rule = phase.name === '出发前'
      ? '禁止暗示已经启程、在路上或已经抵达，也不要问到没到。'
      : (phase.name === '途中' ? '禁止暗示已经落地或抵达，也不要问到没到。' : '可以关心行程，但不要把计划到达当成已确认抵达。');
    return `- ${String(item.title || '票券').slice(0, 120)}：计划出发 ${shanghaiTime(phase.departureAt)}${arrival}；当前阶段：${phase.name}。${rule}`;
  });
  return [
    `当前时间（Asia/Shanghai）：${shanghaiTime(currentTime)}`,
    '票券时序约束（高优先级，不能被动态记忆里的不确定描述覆盖）：',
    ...lines,
  ].join('\n');
}

function timingViolation(message, state, currentTime = Date.now()) {
  const value = String(message || '');
  const phase = relevantTickets(state, currentTime)[0]?.phase?.name;
  const prematureArrival = /(?:到没到|到[^。！？\n]{0,8}(?:了没|了吗|没有)|到达了吗|抵达[^。！？\n]{0,8}(?:没|吗)|落地了吗)/u;
  if (phase === '出发前' && (/(?:已经|已|这会儿|现在|如果|要是|若)[^。！？\n]{0,12}(?:启程|出发|在路上|落地|抵达)/u.test(value) || prematureArrival.test(value))) {
    return '票券仍处于出发前，消息却暗示已经启程或抵达';
  }
  if (phase === '途中' && (/(?:已经|已|这会儿|现在|如果|要是|若)[^。！？\n]{0,12}(?:落地|抵达|到达)/u.test(value) || prematureArrival.test(value))) {
    return '票券仍处于途中，消息却暗示已经抵达';
  }
  return '';
}

module.exports = { arrivalTimestamp, buildTicketTimingContext, ticketPhase, timingViolation };
