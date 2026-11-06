'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  arrivalTimestamp, buildTicketTimingContext, ticketPhase, timingViolation,
} = require('../src/proactive-ticket-context');

const flight = {
  kind: 'ticket', status: 'active', title: '甲城飞丙城机票 SYN0001',
  eventTime: '2042-03-10 12:55', summary: '甲城示例北T3至丙城示例南T3，15:05到达，经济舱。',
  participantSides: ['owner'],
};
const state = { items: [flight] };

test('derives same-day and overnight ticket arrival times', () => {
  assert.equal(arrivalTimestamp(flight), Date.parse('2042-03-10T15:05:00+08:00'));
  assert.equal(arrivalTimestamp({ ...flight, eventTime: '2042-03-10 23:00', summary: '01:30抵达' }), Date.parse('2042-03-11T01:30:00+08:00'));
});

test('states the actual ticket phase in the proactive prompt', () => {
  const before = Date.parse('2042-03-10T09:00:00+08:00');
  const context = buildTicketTimingContext(state, before);
  assert.equal(ticketPhase(flight, before).name, '出发前');
  assert.match(context, /12:55/);
  assert.match(context, /15:05/);
  assert.match(context, /当前阶段：出发前/);
  assert.match(context, /不要问到没到/);
  assert.equal(ticketPhase(flight, Date.parse('2042-03-10T13:30:00+08:00')).name, '途中');
  assert.equal(ticketPhase(flight, Date.parse('2042-03-10T15:30:00+08:00')).name, '已过计划到达时间');
});

test('keeps arrival unknown after departure when the ticket has no arrival time', () => {
  const phase = ticketPhase(
    { ...flight, summary: '甲城去丙城，经济舱' },
    Date.parse('2042-03-10T15:30:00+08:00'),
  );
  assert.equal(phase.name, '已过出发时间（到达时间未知）');
  assert.equal(Number.isNaN(phase.arrivalAt), true);
});

test('blocks premature departure and arrival assumptions', () => {
  const before = Date.parse('2042-03-10T09:00:00+08:00');
  assert.match(timingViolation('今天如果已经启程，就祝你一路顺利。', state, before), /出发前/);
  assert.match(timingViolation('这会儿如果已经落地丙城，报个平安。', state, before), /出发前/);
  assert.match(timingViolation('到没到丙城呀？', state, before), /出发前/);
  assert.match(timingViolation('现在到丙城了吗？', state, before), /出发前/);
  assert.equal(timingViolation('今天 12:55 的航班，出发前别太赶。', state, before), '');

  const transit = Date.parse('2042-03-10T13:30:00+08:00');
  assert.match(timingViolation('落地了吗？', state, transit), /途中/);
  assert.equal(timingViolation('在路上就不用回，落地后再说。', state, transit), '');
});

test('uses the current trip rather than a later return ticket for validation', () => {
  const withReturn = { items: [flight, {
    ...flight, title: '丙城返甲城机票', eventTime: '2042-03-13 19:45', summary: '21:55到达',
  }] };
  const afterArrival = Date.parse('2042-03-10T15:30:00+08:00');
  assert.equal(timingViolation('到丙城了吗？', withReturn, afterArrival), '');
});

test('ignores tickets that do not belong to Owner', () => {
  const peerOnly = { items: [{ ...flight, participantSides: ['friend'] }] };
  assert.equal(buildTicketTimingContext(peerOnly, Date.parse('2042-03-10T09:00:00+08:00')), '');
});
