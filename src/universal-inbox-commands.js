'use strict';

const { parseTimeExpression } = require('./friend-relay-commands');

const TRIP_SUBJECT = '(我的|我自己的|Owner的|好友的|好友的|好友的|对方的|我们的|我们俩的|我们两个的|我们两个人的|我们两人的|两个人的|双方的)';

function listIndex(value) {
  const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
  return chinese[value] || Number(value);
}

function tripScope(subject, side = 'owner') {
  const value = String(subject || '').replace(/\s+/gu, '');
  if (/^(?:我们的|我们俩的|我们两个的|我们两个人的|我们两人的|两个人的|双方的)$/u.test(value)) return 'pair';
  if (value === '对方的') return 'peer';
  if (value.toLowerCase() === 'owner的') return side === 'owner' ? 'self' : 'peer';
  if (/^(?:好友的|好友的|好友的)$/u.test(value)) return side === 'friend' ? 'self' : 'peer';
  if (/^(?:我的|我自己的)$/u.test(value)) return 'self';
  return '';
}

function parseUniversalInboxCommand(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const compactValue = value.replace(/\s+/gu, '');
  if (/^(?:万能)?收件箱(?:帮助|说明|怎么用|怎么玩)$/u.test(value)) return { type: 'help' };
  const bulkAssignment = compactValue.match(new RegExp(`^((?:这|上面|刚才)?(?:两个|2个|两张|2张|这些|那些)|全部)((?:票券|票|预约|行程))?(?:都)?(?:是|属于|算作|改成|改为|设成|设为|标成|标为)${TRIP_SUBJECT}((?:票券|票|预约|行程))?[。！!~～]?$`, 'iu'));
  if (bulkAssignment && (bulkAssignment[2] || bulkAssignment[4] || options.hasTicketView === true)) return {
    type: 'assign_tickets', indices: [],
    expectedCount: /(?:两个|2个|两张|2张)/u.test(bulkAssignment[1]) ? 2 : 0,
    tripScope: tripScope(bulkAssignment[3], options.side),
  };
  const multiAssignment = compactValue.match(new RegExp(`^(?:把)?(?:第)?([1-5一二三四五])(?:个)?(?:票券|预约|行程)?(?:和|跟|、|以及)(?:第)?([1-5一二三四五])(?:个)?(?:票券|预约|行程)?(?:都)?(?:是|属于|算作|改成|改为|设成|设为|标成|标为)${TRIP_SUBJECT}(?:票券|预约|行程)[。！!~～]?$`, 'iu'));
  if (multiAssignment) return {
    type: 'assign_tickets', indices: [listIndex(multiAssignment[1]), listIndex(multiAssignment[2])],
    expectedCount: 0, tripScope: tripScope(multiAssignment[3], options.side),
  };
  if (options.hasTicketView === true) {
    const contextualMulti = compactValue.match(new RegExp(`^(?:第)?([1-5一二三四五])(?:个)?(?:和|跟|、|以及)(?:第)?([1-5一二三四五])(?:个)?(?:都)?(?:是|属于|算作|改成|改为|设成|设为|标成|标为)${TRIP_SUBJECT}[。！!~～]?$`, 'iu'));
    if (contextualMulti) return {
      type: 'assign_tickets', indices: [listIndex(contextualMulti[1]), listIndex(contextualMulti[2])],
      expectedCount: 0, tripScope: tripScope(contextualMulti[3], options.side),
    };
  }
  const assignment = compactValue.match(new RegExp(`^(?:把)?(?:票券仓(?:里|中)?)?(?:第)?([1-9]\\d?|[一二三四五])(?:个)?(?:票券|预约|行程)?(?:改成|改为|设成|设为|标成|标为|是|属于)${TRIP_SUBJECT}(?:票券|预约|行程)[。！!~～]?$`, 'iu'));
  if (assignment) return { type: 'assign_ticket', index: listIndex(assignment[1]), tripScope: tripScope(assignment[2], options.side) };
  if (options.hasDraft === true) {
    const scopedReply = compactValue.match(new RegExp(`^${TRIP_SUBJECT}(?:票券|预约|行程)[。！!~～]?$`, 'iu'));
    if (scopedReply) return { type: 'resolve', action: 'ticket', index: 0, tripScope: tripScope(scopedReply[1], options.side) };
  }
  if (/^(?:(?:查看|打开|列出)(?:我的)?(?:过期|历史)(?:票券|预约)(?:仓|箱|列表)?|(?:我的)?(?:过期|历史)(?:票券|预约)(?:仓|箱|列表))[？?。]?$/u.test(value)) return { type: 'list', kind: 'ticket', archived: true };
  const ticketList = compactValue.match(new RegExp(`^(?:查看|看看|打开|列出)?(?:(今天|明天)(?:的)?)?${TRIP_SUBJECT}?(?:票券|预约|行程)(?:仓|箱|列表)?[？?。]?$`, 'iu'));
  if (ticketList) return {
    type: 'list', kind: 'ticket',
    ...(ticketList[1] ? { dayOffset: ticketList[1] === '今天' ? 0 : 1 } : {}),
    ...(ticketList[2] ? { tripScope: tripScope(ticketList[2], options.side) } : {}),
  };
  if (/^(?:(?:查看|打开|列出)(?:我的)?(?:收藏|收藏箱|收藏列表)|(?:我的)?(?:收藏箱|收藏列表))[？?。]?$/u.test(value)) return { type: 'list', kind: 'collection' };
  if (/^(?:(?:查看|打开|列出)(?:我的)?(?:惊喜|礼物)(?:箱|列表)?|(?:我的)?(?:惊喜|礼物)(?:箱|列表))[？?。]?$/u.test(value)) return { type: 'list', kind: 'gift' };
  if (options.hasDraft !== true) return null;
  const indexed = value.match(/^(?:第)?([1-5])(?:个)?\s*(.+)$/u);
  const index = indexed ? Number(indexed[1]) : 0;
  const actionText = indexed ? indexed[2].trim() : value;
  const compactActionText = actionText.replace(/\s+/gu, '');
  const allTicket = compactActionText.match(new RegExp(`^全部(?:保存|放进|加入)(?:为|成|到)?${TRIP_SUBJECT}?(?:票券|预约)(?:仓|箱)?[。！!~～]?$`, 'iu'));
  if (allTicket) return { type: 'resolve_all', action: 'ticket', ...(allTicket[1] ? { tripScope: tripScope(allTicket[1], options.side) } : {}) };
  const all = actionText.match(/^全部\s*(收藏|(?:(私密)保存到|保存到私密)(?:惊喜|礼物)箱|保存到(?:惊喜|礼物)箱)[。！!~～]?$/u);
  if (all) return {
    type: 'resolve_all', action: all[1].startsWith('收藏') ? 'collection' : 'gift',
    ...(all[2] || /保存到私密/u.test(all[1]) ? { visibility: 'owner_only' } : {}),
  };
  if (/^(?:加入|放进|加进)(?:我们的|双人的)?想去箱[。！!~～]?$/u.test(actionText)) return { type: 'resolve', action: 'place', index };
  const saveTicket = compactActionText.match(new RegExp(`^(?:保存|放进|加入)(?:为|成|到)?${TRIP_SUBJECT}?(?:票券|预约)(?:仓|箱)?[。！!~～]?$`, 'iu'));
  if (saveTicket) return { type: 'resolve', action: 'ticket', index, ...(saveTicket[1] ? { tripScope: tripScope(saveTicket[1], options.side) } : {}) };
  if (/^(?:收藏|保存到收藏箱|加入收藏)[。！!~～]?$/u.test(actionText)) return { type: 'resolve', action: 'collection', index };
  if (/^(?:私密保存|私密放进|私密加入)(?:到)?(?:惊喜|礼物)箱[。！!~～]?$/u.test(actionText)
    || /^(?:保存|放进|加入)(?:到)?私密(?:惊喜|礼物)箱[。！!~～]?$/u.test(actionText)) {
    return { type: 'resolve', action: 'gift', index, visibility: 'owner_only' };
  }
  if (/^(?:保存|放进|加入)(?:到)?(?:惊喜|礼物)箱[。！!~～]?$/u.test(actionText)) return { type: 'resolve', action: 'gift', index, visibility: 'fixed_pair' };
  if (/^(?:发给|转给|分享给)(?:好友|Owner|对方)[。！!~～]?$/u.test(actionText)) return { type: 'resolve', action: 'relay', index };
  if (/^(?:不用了|先不处理|算了|丢掉|取消)[。！!~～]?$/u.test(actionText)) return { type: 'resolve', action: 'discard', index };
  const reminder = actionText.match(/^(.+?)\s*提醒我(?:处理|查看|准备)?(?:这(?:个|件)|它|第?[1-5]个)[。！!~～]?$/u);
  if (reminder) return { type: 'resolve', action: 'reminder', index, schedule: parseTimeExpression(reminder[1], options.now) };
  return null;
}

module.exports = { parseUniversalInboxCommand };
