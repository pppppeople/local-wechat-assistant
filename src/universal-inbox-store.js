'use strict';

const crypto = require('crypto');
const { changed, refused, resultText } = require('./feature-result');
const { readRecordState, writeRecordState } = require('./record-state');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const VIEW_TTL_MS = 15 * 60 * 1000;
const MAX_ITEMS = 300;
const MAX_DRAFTS = 5;

function initialState(value = {}) {
  const drafts = {};
  for (const [side, entry] of Object.entries(value.drafts || {})) {
    drafts[side] = Array.isArray(entry) ? entry : (entry ? [entry] : []);
  }
  const items = Array.isArray(value.items) ? value.items : [];
  for (const item of items) {
    if (!['ticket', 'collection'].includes(item?.kind)) continue;
    item.provenance = item.provenance && typeof item.provenance === 'object' ? item.provenance : {};
    item.provenance.visibility = 'fixed_pair';
    item.provenance.reshareAllowed = false;
  }
  return {
    schemaVersion: 4,
    drafts,
    items,
    views: value.views && typeof value.views === 'object' ? value.views : {},
  };
}

function normalizeTripScope(value) {
  return ['self', 'peer', 'pair'].includes(value) ? value : '';
}

function normalizeGiftCategory(value, title = '') {
  if (['idea', 'preference', 'size', 'occasion'].includes(value)) return value;
  if (/(?:尺码|码数|尺寸|穿.{0,8}[码号]|鞋.{0,8}[码号])/u.test(title)) return 'size';
  if (/(?:生日|纪念日|周年|相识日|日期)/u.test(title)) return 'occasion';
  if (/(?:喜欢|偏好|爱吃|口味|颜色|不喜欢|不吃|忌口)/u.test(title)) return 'preference';
  return 'idea';
}

function normalizeVisibility(value, fallback = 'owner_only') {
  return ['fixed_pair', 'owner_only'].includes(value) ? value : fallback;
}

function tripParticipants(side, scope) {
  const normalized = normalizeTripScope(scope);
  if (!normalized) return [];
  if (normalized === 'pair') return ['owner', 'friend'];
  if (normalized === 'self') return [side];
  return [side === 'owner' ? 'friend' : 'owner'];
}

function tripScopeForSide(side, participants) {
  const values = Array.isArray(participants) ? [...new Set(participants.filter((entry) => ['owner', 'friend'].includes(entry)))] : [];
  if (values.includes('owner') && values.includes('friend')) return 'pair';
  if (values.length !== 1) return '';
  return values[0] === side ? 'self' : 'peer';
}

function validSide(side) {
  if (!['owner', 'friend'].includes(side)) throw new Error('invalid inbox side');
  return side;
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();
}

function clean(value, limit) {
  return String(value || '').replace(/[\r\n]+/gu, ' ').trim().slice(0, limit);
}

function publicUrl(value) {
  try {
    const parsed = new URL(clean(value, 500));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, 500);
  } catch { return ''; }
}

function sanitizeCandidate(candidate = {}) {
  const kind = ['place', 'ticket', 'event', 'link', 'note', 'gift'].includes(candidate.kind) ? candidate.kind : '';
  const title = clean(candidate.title, 120);
  const combined = JSON.stringify({
    title: candidate.title, placeName: candidate.placeName,
    eventTime: candidate.eventTime, summary: candidate.summary,
  });
  if (!kind || !title || /(?:密码|口令|验证码|token|cookie|secret|api[ _-]?key|身份证|订单号|票号)\s*[：:=]\s*\S+/iu.test(combined)) return null;
  return {
    kind, title, placeName: clean(candidate.placeName, 160), eventTime: clean(candidate.eventTime, 40),
    url: publicUrl(candidate.url), summary: clean(candidate.summary, 200),
    tripScope: kind === 'ticket' ? normalizeTripScope(candidate.tripScope) : '',
  };
}

function eventTimestamp(eventTime) {
  const match = String(eventTime || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/u);
  if (!match) return NaN;
  const value = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4] || '12'}:${match[5] || '00'}:00+08:00`);
  return Number.isFinite(value) ? value : NaN;
}

function ticketReminderSchedules(item, currentTime = Date.now()) {
  const eventAt = eventTimestamp(item?.eventTime);
  if (!Number.isFinite(eventAt)) return [];
  return [
    { key: 'day', sendAt: eventAt - 24 * 60 * 60 * 1000, label: '提前一天' },
    { key: 'two-hours', sendAt: eventAt - 2 * 60 * 60 * 1000, label: '提前两小时' },
  ].filter((entry) => entry.sendAt > currentTime + 30_000);
}

function shanghaiDateKey(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

function createUniversalInboxStore({
  stateFile, now = () => Date.now(), sideNames = {}, onTicketAssigned = null, onItemRemoved = null,
}) {
  const names = {
    owner: clean(sideNames.owner || 'Owner', 40),
    friend: clean(sideNames.friend || '好友', 40),
  };

  function participantLabel(participants) {
    const values = Array.isArray(participants) ? participants : [];
    if (values.includes('owner') && values.includes('friend')) return `${names.owner} + ${names.friend}`;
    if (values.includes('owner')) return names.owner;
    if (values.includes('friend')) return names.friend;
    return '待确认';
  }

  function scopePrompt(side, index = 0) {
    const self = names[side];
    const peer = names[side === 'owner' ? 'friend' : 'owner'];
    const prefix = Number(index) > 0 ? `第 ${Number(index)} 个候选` : '这张票';
    return `${prefix}是谁的行程？请回复“${self}的票券”“${peer}的票券”或“我们两个人的票券”。我确认行程人后再保存。`;
  }
  function load() {
    const state = initialState(readRecordState(stateFile, {}));
    const cutoff = now() - DRAFT_TTL_MS;
    for (const side of Object.keys(state.drafts)) {
      state.drafts[side] = state.drafts[side].filter((draft) => new Date(draft?.createdAt || 0).getTime() >= cutoff);
      if (!state.drafts[side].length) delete state.drafts[side];
    }
    const viewCutoff = now() - VIEW_TTL_MS;
    for (const side of Object.keys(state.views)) {
      if (new Date(state.views[side]?.createdAt || 0).getTime() < viewCutoff) delete state.views[side];
    }
    for (const item of state.items) {
      const eventAt = item.kind === 'ticket' ? eventTimestamp(item.eventTime) : NaN;
      if (item.status === 'active' && Number.isFinite(eventAt) && eventAt + 24 * 60 * 60 * 1000 < now()) {
        item.status = 'archived';
        item.archivedAt = new Date(now()).toISOString();
        item.updatedAt = item.archivedAt;
      }
    }
    return state;
  }

  function save(state) { writeRecordState(stateFile, state, ['items']); }

  function requireCapacity(state, side, additional) {
    const active = state.items.filter((item) => item.ownerSide === side && !['archived', 'removed'].includes(item.status)).length;
    if (active + additional > MAX_ITEMS) {
      throw new Error(`你保存的在用内容最多 ${MAX_ITEMS} 条。请先整理不再需要的条目；已有内容和这批候选都不会被覆盖。`);
    }
  }

  function draftsFor(state, side) { return Array.isArray(state.drafts[validSide(side)]) ? state.drafts[side] : []; }

  function hasDraft(side) {
    const state = load();
    save(state);
    return draftsFor(state, side).length > 0;
  }

  function draftCount(side) {
    const state = load();
    save(state);
    return draftsFor(state, side).length;
  }

  function ticketViewStatus(side) {
    validSide(side);
    const state = load();
    save(state);
    const view = state.views[side];
    return {
      pending: view?.kind === 'ticket' && Array.isArray(view.itemIds) && view.itemIds.length > 0,
      count: view?.kind === 'ticket' && Array.isArray(view.itemIds) ? view.itemIds.length : 0,
    };
  }

  function ticketIntentContext(side) {
    validSide(side);
    const state = load();
    save(state);
    const drafts = draftsFor(state, side).map((draft, offset) => ({ draft, index: offset + 1 }))
      .filter(({ draft }) => draft.kind === 'ticket').slice(0, MAX_DRAFTS).map(({ draft, index }) => ({
        index, title: draft.title, eventTime: draft.eventTime, placeName: draft.placeName,
      }));
    const view = state.views[side];
    const currentViewItems = view && Array.isArray(view.itemIds)
      ? view.itemIds.map((id, offset) => ({
          item: state.items.find((entry) => entry.id === id && entry.ownerSide === side
            && entry.kind === view.kind && entry.status !== 'removed'),
          index: offset + 1,
        })).filter(({ item }) => item)
      : [];
    const tickets = view?.kind === 'ticket' && Array.isArray(view.itemIds)
      ? view.itemIds.map((id, offset) => ({
          item: state.items.find((entry) => entry.id === id && entry.ownerSide === side && entry.kind === 'ticket'),
          index: offset + 1,
        })).filter(({ item }) => item).map(({ item, index }) => ({
          index, title: item.title, eventTime: item.eventTime, placeName: item.placeName,
          participantLabel: participantLabel(item.participantSides),
        }))
      : [];
    const currentIds = currentViewItems.map(({ item }) => item.id);
    const remainingItems = state.items.filter((item) => item.ownerSide === side && item.status !== 'removed'
      && ['ticket', 'collection', 'gift'].includes(item.kind) && !currentIds.includes(item.id))
      .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
    const catalogItems = [...currentViewItems.map(({ item }) => item), ...remainingItems].slice(0, 30);
    const catalog = catalogItems.map((item, offset) => ({
      index: offset + 1, id: item.id, kind: item.kind, title: item.title, eventTime: item.eventTime,
      placeName: item.placeName, status: item.status,
    }));
    const draftIds = draftsFor(state, side).map((draft) => draft.id);
    const viewIds = view?.kind === 'ticket' && Array.isArray(view.itemIds) ? view.itemIds : [];
    const token = (label, ids, createdAt = '') => ids.length
      ? crypto.createHash('sha256').update(JSON.stringify([side, label, createdAt, ids])).digest('hex').slice(0, 24)
      : '';
    return {
      enabled: drafts.length > 0 || tickets.length > 0 || catalog.length > 0,
      selfName: names[side], peerName: names[side === 'owner' ? 'friend' : 'owner'], drafts, tickets,
      currentView: {
        kind: view?.kind || '',
        items: currentViewItems.map(({ item, index }) => ({
          index, title: item.title, eventTime: item.eventTime, placeName: item.placeName,
        })),
      },
      catalog,
      draftToken: token('draft', draftIds),
      viewToken: token('view', viewIds, view?.createdAt || ''),
      catalogToken: token('catalog', catalogItems.map((item) => item.id)),
      currentViewToken: token('items', view?.itemIds || [], view?.createdAt || ''),
    };
  }

  function stage(side, input) {
    validSide(side);
    const candidates = (Array.isArray(input) ? input : [input]).map(sanitizeCandidate).filter(Boolean).slice(0, MAX_DRAFTS);
    if (!candidates.length) throw new Error('没有可安全保存的收件箱候选');
    const state = load();
    const timestamp = new Date(now()).toISOString();
    state.drafts[side] = candidates.map((candidate) => ({
      id: createId('UI'), ...candidate, createdAt: timestamp,
      provenance: {
        sourceType: 'universal_inbox_extraction', ownerSide: side, visibility: 'owner_only',
        createdReason: '当前消息或图片识别出的临时候选，等待用户明确选择',
        reshareAllowed: false, createdAt: timestamp, expiresAt: new Date(now() + DRAFT_TTL_MS).toISOString(),
      },
    }));
    save(state);
    const drafts = state.drafts[side];
    const lines = drafts.map((draft, index) => {
      const details = [draft.eventTime, draft.placeName].filter(Boolean).join('｜');
      return `${index + 1}. ${draft.title}${details ? `｜${details}` : ''}`;
    });
    if (drafts.length === 1) {
      return `我从这条内容里整理出「${drafts[0].title}」${lines[0].includes('｜') ? `（${lines[0].split('｜').slice(1).join('｜')}）` : ''}。\n回复：保存票券 / 收藏 / 加入想去箱 / 保存到礼物箱 / 发给对方 / 不用了；也可以说“明天下午三点提醒我处理这个”。`;
    }
    return [`我整理出 ${drafts.length} 个候选：`, ...lines,
      '每个编号都可以接处理方式，例如“1保存票券”“1收藏”“1加入想去箱”；也可以说“全部收藏”“全部保存票券”或“不用了”。'].join('\n');
  }

  function getDrafts(side) {
    const state = load();
    save(state);
    return draftsFor(state, side).map((draft) => ({ ...draft }));
  }

  function getDraft(side, index = 0) {
    const drafts = getDrafts(side);
    if (Number(index) > 0) return drafts[Number(index) - 1] || null;
    return drafts.length === 1 ? drafts[0] : null;
  }

  function consumeDraft(side, index = 0) {
    const state = load();
    const drafts = draftsFor(state, side);
    const offset = Number(index) > 0 ? Number(index) - 1 : (drafts.length === 1 ? 0 : -1);
    if (offset < 0 || !drafts[offset]) return null;
    const [draft] = drafts.splice(offset, 1);
    if (!drafts.length) delete state.drafts[side];
    save(state);
    return { ...draft };
  }

  function discard(side, index = 0) {
    validSide(side);
    const state = load();
    if (!Number(index)) {
      const removed = draftsFor(state, side).length;
      delete state.drafts[side];
      save(state);
      return removed;
    }
    const drafts = draftsFor(state, side);
    if (!drafts[Number(index) - 1]) return 0;
    drafts.splice(Number(index) - 1, 1);
    if (!drafts.length) delete state.drafts[side];
    save(state);
    return 1;
  }

  function itemFromDraft(side, kind, draft, timestamp, tripScope = '', visibility = '') {
    const itemVisibility = ['ticket', 'collection'].includes(kind)
      ? 'fixed_pair'
      : normalizeVisibility(visibility, 'fixed_pair');
    const item = {
      id: createId(kind === 'ticket' ? 'TK' : (kind === 'gift' ? 'GF' : 'CL')),
      kind, title: draft.title, placeName: draft.placeName, eventTime: draft.eventTime,
      url: draft.url, summary: draft.summary, ownerSide: side, status: 'active',
      createdAt: timestamp, updatedAt: timestamp,
      provenance: {
        sourceType: 'universal_inbox', ownerSide: side,
        visibility: itemVisibility,
        createdReason: `用户明确选择保存到${kind === 'ticket' ? '票券仓' : (kind === 'gift' ? '礼物箱' : '收藏箱')}`,
        reshareAllowed: false, createdAt: timestamp,
      },
    };
    if (kind === 'ticket') item.participantSides = tripParticipants(side, tripScope || draft.tripScope);
    if (kind === 'gift') item.giftCategory = normalizeGiftCategory('', item.title);
    return item;
  }

  function saveItem(side, kind, index = 0, options = {}) {
    validSide(side);
    if (!['ticket', 'collection', 'gift'].includes(kind)) throw new Error('unsupported inbox item kind');
    const state = load();
    const drafts = draftsFor(state, side);
    const offset = Number(index) > 0 ? Number(index) - 1 : (drafts.length === 1 ? 0 : -1);
    if (offset < 0 || !drafts[offset]) return null;
    const tripScope = normalizeTripScope(options.tripScope || drafts[offset].tripScope);
    if (kind === 'ticket' && !tripScope) throw new Error(scopePrompt(side, index));
    requireCapacity(state, side, 1);
    const timestamp = new Date(now()).toISOString();
    const item = itemFromDraft(side, kind, drafts[offset], timestamp, tripScope, options.visibility);
    state.items.push(item);
    drafts.splice(offset, 1);
    if (!drafts.length) delete state.drafts[side];
    save(state);
    return item;
  }

  function saveAll(side, kind, options = {}) {
    validSide(side);
    if (!['ticket', 'collection', 'gift'].includes(kind)) throw new Error('unsupported inbox item kind');
    const state = load();
    const drafts = draftsFor(state, side);
    const overrideScope = normalizeTripScope(options.tripScope);
    if (kind === 'ticket' && drafts.some((draft) => !normalizeTripScope(overrideScope || draft.tripScope))) {
      throw new Error('这些候选里还有没标明行程人的票券。请分别说“1保存为我的票券”“2保存为对方的票券”，或者说“全部保存为我们两个人的票券”。');
    }
    requireCapacity(state, side, drafts.length);
    const timestamp = new Date(now()).toISOString();
    const items = drafts.map((draft) => itemFromDraft(
      side, kind, draft, timestamp, overrideScope || draft.tripScope, options.visibility,
    ));
    state.items.push(...items);
    delete state.drafts[side];
    save(state);
    return items;
  }

  function saveSelected(side, kind, indices, options = {}) {
    validSide(side);
    if (!['ticket', 'collection', 'gift'].includes(kind)) throw new Error('unsupported inbox item kind');
    const state = load();
    const drafts = draftsFor(state, side);
    const positions = [...new Set(indices)];
    if (!positions.length || positions.some(index => !Number.isInteger(index) || index < 1 || !drafts[index - 1])) throw new Error('待保存候选已经变化，请重新发送内容');
    const selected = positions.map(index => drafts[index - 1]);
    const scope = normalizeTripScope(options.tripScope);
    if (kind === 'ticket' && selected.some(draft => !normalizeTripScope(scope || draft.tripScope))) throw new Error('请明确这些票券的行程人');
    requireCapacity(state, side, selected.length);
    const timestamp = new Date(now()).toISOString();
    const items = selected.map(draft => itemFromDraft(side, kind, draft, timestamp, scope || draft.tripScope, options.visibility));
    state.items.push(...items);
    state.drafts[side] = drafts.filter((draft, offset) => !positions.includes(offset + 1));
    if (!state.drafts[side].length) delete state.drafts[side];
    save(state);
    return items;
  }

  function addGift(side, title, summary = '', category = '', visibility = 'fixed_pair') {
    validSide(side);
    const candidate = sanitizeCandidate({ kind: 'gift', title, summary });
    if (!candidate) throw new Error('礼物内容不能为空，也不能包含密码或票据编号');
    const state = load();
    requireCapacity(state, side, 1);
    const timestamp = new Date(now()).toISOString();
    const item = itemFromDraft(side, 'gift', candidate, timestamp, '', visibility);
    item.giftCategory = normalizeGiftCategory(category, item.title);
    item.provenance.sourceType = 'explicit_gift_idea';
    item.provenance.createdReason = item.provenance.visibility === 'owner_only'
      ? '用户明确要求私密保存惊喜或礼物灵感'
      : '用户明确要求保存到双方共享礼物箱';
    state.items.push(item);
    save(state);
    return item;
  }

  function list(side, kind, options = {}) {
    validSide(side);
    const state = load();
    const dateLabel = options.window?.label || (options.dayOffset === 0 ? '今天' : options.dayOffset === 1 ? '明天'
      : Number.isInteger(options.dayOffset) ? shanghaiDateKey(now() + options.dayOffset * 86400000) : '');
    const status = options.archived === true ? 'archived' : (kind === 'gift' ? null : 'active');
    let items = state.items.filter((item) => item.kind === kind
      && (item.ownerSide === side || normalizeVisibility(item.provenance?.visibility) === 'fixed_pair')
      && (status ? item.status === status : !['removed', 'archived'].includes(item.status)));
    const requestedScope = normalizeTripScope(options.tripScope);
    if (kind === 'ticket' && requestedScope) {
      items = items.filter((item) => tripScopeForSide(side, item.participantSides) === requestedScope);
    }
    if (kind === 'ticket' && options.window) {
      const { startAt, endAt } = options.window;
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new Error('票券查询时间范围无效');
      items = items.filter(item => {
        const time = eventTimestamp(item.eventTime);
        return Number.isFinite(time) && time >= startAt && time < endAt;
      });
    } else if (kind === 'ticket' && Number.isInteger(options.dayOffset)) {
      const target = shanghaiDateKey(now() + options.dayOffset * 24 * 60 * 60 * 1000);
      items = items.filter((item) => {
        const itemTime = eventTimestamp(item.eventTime);
        return Number.isFinite(itemTime) && shanghaiDateKey(itemTime) === target;
      });
    }
    items = items.sort((left, right) => {
      if (kind === 'ticket') {
        const leftTime = eventTimestamp(left.eventTime);
        const rightTime = eventTimestamp(right.eventTime);
        if (Number.isFinite(leftTime) || Number.isFinite(rightTime)) return (leftTime || Infinity) - (rightTime || Infinity);
      }
      return new Date(right.createdAt) - new Date(left.createdAt);
    }).slice(0, 30);
    if (!items.length) {
      delete state.views[side];
      save(state);
      if (kind === 'ticket') {
        if (options.window || Number.isInteger(options.dayOffset)) return `${dateLabel}没有符合这个行程人条件、且带明确时间的票券／预约。`;
        return options.archived ? '共享过期票券仓现在还是空的。' : '共享票券/预约仓现在还是空的。';
      }
      if (kind === 'gift') return '礼物箱现在还是空的。';
      return '共享收藏箱现在还是空的。';
    }
    state.views[side] = { kind, itemIds: items.map((item) => item.id), createdAt: new Date(now()).toISOString() };
    save(state);
    const heading = kind === 'ticket' ? (options.window || Number.isInteger(options.dayOffset)
      ? `${dateLabel}的票券行程`
      : (options.archived ? '共享过期票券仓' : '共享票券/预约仓'))
      : (kind === 'gift' ? '礼物箱（共享项目双方可见；私密项目仅添加人可见）' : '共享收藏箱');
    return [heading, ...items.map((item, index) => {
      const giftCategory = ({ idea: '礼物灵感', preference: '喜好线索', size: '尺寸线索', occasion: '纪念日线索' })[
        normalizeGiftCategory(item.giftCategory, item.title)
      ];
      const details = [item.eventTime, item.placeName,
        ['ticket', 'collection', 'gift'].includes(kind) ? `添加人：${names[item.ownerSide]}` : '',
        kind === 'ticket' ? `行程人：${participantLabel(item.participantSides)}` : '',
        kind === 'gift' ? `${giftCategory}${item.status === 'bought' ? '·已买' : (item.status === 'given' ? '·已送' : '')}` : '',
        kind === 'gift' ? (normalizeVisibility(item.provenance?.visibility) === 'fixed_pair' ? '双方可见' : '仅自己可见') : '',
      ].filter(Boolean).join('｜');
      return `${index + 1}. ${item.title}${details ? `｜${details}` : ''}${item.url ? `\n   ${item.url}` : ''}`;
    }), ...(kind === 'gift' ? ['新礼物默认双方可见；添加人可以说“礼物箱第一个不给对方看”或“礼物箱第一个双方可见”切换。礼物灵感还可以标记已买、已送或删除。'] : []),
    ...(kind === 'ticket' ? ['双方都能查看这里的票券摘要；只有添加人可以修改行程人或删除。行程人显示“待确认”时，添加人可以说“第一个是我的行程”“第一个是对方的行程”或“第一个是我们两个人的行程”；删除时可以直接说“丙城那张票不要了”。'] : []),
    ...(kind === 'collection' ? ['双方都能查看收藏摘要；只有添加人可以删除。删除时可以直接说“把刚才收藏的那家店删掉”。'] : [])].join('\n');
  }

  function assignTicketsResult(side, indices, tripScope, options = {}) {
    validSide(side);
    const state = load();
    const view = state.views[side];
    if (!view || view.kind !== 'ticket') return refused('请先查看票券仓或今天行程，再按列表编号说明是谁的行程。');
    const expectedCount = Number(options.expectedCount || 0);
    if (expectedCount > 0 && view.itemIds.length !== expectedCount) {
      return refused(`刚才的票券列表有 ${view.itemIds.length} 条，不是 ${expectedCount} 条。请直接说编号，例如“第一个和第二个都是我的行程”。`);
    }
    const positions = Array.isArray(indices) && indices.length
      ? [...new Set(indices.map(Number))]
      : view.itemIds.map((unused, index) => index + 1);
    if (!positions.length || positions.some((position) => !Number.isInteger(position) || position < 1 || position > view.itemIds.length)) {
      return refused('你说的票券编号不在刚才的列表里，请重新查看票券仓。');
    }
    const items = positions.map((position) => state.items.find((entry) => (
      entry.id === view.itemIds[position - 1] && entry.kind === 'ticket'
    )));
    if (items.some((item) => !item)) return refused('刚才的票券列表已经变化，请重新查看后再标记。');
    const foreign = items.find((item) => item.ownerSide !== side);
    if (foreign) {
      return refused(`「${foreign.title}」是由${names[foreign.ownerSide]}添加的；共享票券仓允许双方查看，但只有添加人可以修改行程人或删除。`);
    }
    const normalized = normalizeTripScope(tripScope);
    if (!normalized) return refused(scopePrompt(side, positions[0]));
    const updatedAt = new Date(now()).toISOString();
    for (const item of items) {
      item.participantSides = tripParticipants(side, normalized);
      item.updatedAt = updatedAt;
    }
    save(state);
    const label = participantLabel(items[0].participantSides);
    const updatedReminders = typeof onTicketAssigned === 'function'
      ? items.reduce((count, item) => count + Number(onTicketAssigned(side, { ...item }, label) || 0), 0)
      : 0;
    const subject = items.length === 1 ? `「${items[0].title}」` : `这 ${items.length} 张票券`;
    return changed(`已经把${subject}的行程人标为：${label}。${updatedReminders ? `同步更新了 ${updatedReminders} 条还没发送的行前提醒。` : ''}票券摘要会继续显示在双方共享票券仓里，但仍只有添加人可以修改或删除。`);
  }

  function assignTicket(side, index, tripScope) {
    return assignTickets(side, [index], tripScope);
  }

  function removeItemsResult(side, itemIds, options = {}) {
    validSide(side);
    const state = load();
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String).filter(Boolean))];
    const expectedCount = Number(options.expectedCount || 0);
    if (!ids.length) return refused('我没有找到要删除的项目，所以什么都没改。');
    if (expectedCount > 0 && ids.length !== expectedCount) {
      return refused(`当前能对应到 ${ids.length} 个项目，不是你说的 ${expectedCount} 个。我还没有删除，请再说具体一点。`);
    }
    const items = ids.map((id) => state.items.find((entry) => entry.id === id && entry.ownerSide === side
      && entry.status !== 'removed' && ['ticket', 'collection', 'gift'].includes(entry.kind)));
    if (items.some((item) => !item)) return refused('要删除的项目已经变化，请重新说一下名称或查看对应箱子。');
    const updatedAt = new Date(now()).toISOString();
    for (const item of items) {
      item.status = 'removed';
      item.updatedAt = updatedAt;
    }
    delete state.views[side];
    save(state);
    const cancelledReminders = typeof onItemRemoved === 'function'
      ? items.reduce((count, item) => count + Number(onItemRemoved(side, { ...item }) || 0), 0)
      : 0;
    const boxName = (kind) => ({ ticket: '票券/预约仓', collection: '收藏箱', gift: '惊喜／礼物箱' }[kind]);
    const subject = items.length === 1
      ? `「${items[0].title}」从${boxName(items[0].kind)}`
      : `这 ${items.length} 个项目从对应箱子`;
    return changed(`已经把${subject}删除。${cancelledReminders ? `同时取消了 ${cancelledReminders} 条尚未发送的行前提醒。` : ''}${items.some((item) => item.kind === 'gift') ? '礼物箱的删除不会通知对方。' : ''}`);
  }

  function resolveGiftView(side, index) {
    const state = load();
    const view = state.views[side];
    if (!view || view.kind !== 'gift') return { state, item: null, error: '请先说“查看礼物箱”，再按编号操作。' };
    const id = view.itemIds[Number(index) - 1];
    const item = state.items.find((entry) => entry.id === id && entry.kind === 'gift');
    if (!item) return { state, item: null, error: '刚才的礼物箱列表已经变化，请重新查看。' };
    if (item.ownerSide !== side) {
      return { state, item: null, error: `「${item.title}」是由${names[item.ownerSide]}添加的；你可以查看，但只有添加人可以修改或删除。` };
    }
    return { state, item };
  }

  function updateGiftResult(side, index, action) {
    validSide(side);
    const resolved = resolveGiftView(side, index);
    if (!resolved.item) return refused(resolved.error);
    return updateGiftByIdResult(side, resolved.item.id, action);
  }

  function updateGiftByIdResult(side, id, action) {
    validSide(side);
    const state = load();
    const item = state.items.find((entry) => entry.id === id && entry.kind === 'gift' && entry.ownerSide === side && entry.status !== 'removed');
    if (!item) return refused('没有找到由你保存的对应礼物，未修改。');
    item.provenance = item.provenance && typeof item.provenance === 'object'
      ? item.provenance : { ownerSide: side, visibility: 'owner_only', reshareAllowed: false };
    if (action === 'private') item.provenance.visibility = 'owner_only';
    else if (action === 'share') item.provenance.visibility = 'fixed_pair';
    else if (action === 'remove') item.status = 'removed';
    else if (['bought', 'given'].includes(action)
      && normalizeGiftCategory(item.giftCategory, item.title) !== 'idea') {
      return refused('这是一条尺寸、喜好或纪念日线索，不需要标记已买或已送；可以直接保留或删除。');
    } else if (action === 'bought') item.status = 'bought';
    else if (action === 'given') item.status = 'given';
    else throw new Error('不支持的礼物箱操作');
    item.updatedAt = new Date(now()).toISOString();
    save(state);
    if (action === 'private') return changed(`已经把「${item.title}」设为仅自己可见，对方之后查看礼物箱时不会看到。`);
    if (action === 'share') return changed(`已经把「${item.title}」设为双方可见，对方之后打开礼物箱就能看到。`);
    if (action === 'remove') return changed(`已经从礼物箱删除「${item.title}」。`);
    return changed(`已经把「${item.title}」标记为${action === 'bought' ? '已买' : '已送'}，不会通知对方。`);
  }

  function explain(side, query = '') {
    validSide(side);
    const value = String(query || '').toLocaleLowerCase('zh-CN');
    const state = load();
    const item = state.items.filter((entry) => (entry.ownerSide === side
      || normalizeVisibility(entry.provenance?.visibility) === 'fixed_pair')
      && !['removed'].includes(entry.status))
      .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
      .find((entry) => value && (value.includes(entry.title.toLocaleLowerCase('zh-CN'))
        || entry.title.toLocaleLowerCase('zh-CN').includes(value)));
    if (!item) return null;
    const box = item.kind === 'ticket' ? '票券/预约仓' : (item.kind === 'gift' ? '惊喜／礼物箱' : '收藏箱');
    const trip = item.kind === 'ticket' ? ` 当前标注的行程人是：${participantLabel(item.participantSides)}。` : '';
    if (['ticket', 'collection'].includes(item.kind)) {
      const summaryName = item.kind === 'ticket' ? '票券摘要' : '收藏摘要';
      return `我知道「${item.title}」是因为${names[item.ownerSide]}在 ${item.createdAt.slice(0, 10)} 明确把它保存进了${box}。${trip}${summaryName}对固定双方可见，但仍只有添加人可以修改或删除，也不会包含订单号、票号或二维码。`;
    }
    const visibility = normalizeVisibility(item.provenance?.visibility) === 'fixed_pair' ? '双方可见' : '仅添加人可见';
    return `我知道「${item.title}」是因为${names[item.ownerSide]}在 ${item.createdAt.slice(0, 10)} 明确把它保存进了${box}。当前可见范围是：${visibility}；仍只有添加人可以修改或删除。`;
  }

  function deleteSide(side) {
    validSide(side);
    const state = load();
    const before = state.items.length;
    state.items = state.items.filter((item) => item.ownerSide !== side);
    delete state.drafts[side];
    delete state.views[side];
    save(state);
    return { removed: before - state.items.length };
  }

  function reminderSchedules(item) {
    return ticketReminderSchedules(item, now());
  }

  function assignTickets(side, indices, tripScope, options) { return resultText(assignTicketsResult(side, indices, tripScope, options)); }
  function removeItems(side, ids, options) { return resultText(removeItemsResult(side, ids, options)); }
  function updateGift(side, index, action) { return resultText(updateGiftResult(side, index, action)); }
  function updateGiftById(side, id, action) { return resultText(updateGiftByIdResult(side, id, action)); }

  return { assignTicketsResult, removeItemsResult, updateGiftResult, updateGiftByIdResult, saveSelected,
    addGift, assignTicket, assignTickets, consumeDraft, deleteSide, discard, draftCount, explain, getDraft, getDrafts,
    hasDraft, list, participantLabel: (item) => participantLabel(item?.participantSides), saveAll, saveItem,
    removeItems, scopePrompt, stage, ticketIntentContext, ticketReminderSchedules: reminderSchedules, ticketViewStatus, updateGift, updateGiftById,
  };
}

module.exports = {
  DRAFT_TTL_MS, MAX_DRAFTS, createUniversalInboxStore, eventTimestamp, normalizeTripScope,
  normalizeVisibility, ticketReminderSchedules, tripParticipants, tripScopeForSide,
};
