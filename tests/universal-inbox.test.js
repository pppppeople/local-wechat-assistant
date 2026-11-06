'use strict';

const { readRecordState, writeRecordState } = require('../src/record-state');

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { parseUniversalInboxCommand } = require('../src/universal-inbox-commands');
const { extractUniversalInboxCandidate } = require('../src/universal-inbox-conversation');
const {
  buildTicketIntentInstruction, extractTicketIntent, mightBeNaturalTicketIntent,
} = require('../src/ticket-intent-conversation');
const { createUniversalInboxStore } = require('../src/universal-inbox-store');




test('preserves more than 300 archived records and rejects active overflow without consuming drafts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-capacity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const archived = Array.from({ length: 301 }, (_, i) => ({
    id: `OLD-${i}`, kind: 'collection', title: `旧收藏${i}`, ownerSide: 'owner', status: 'archived',
  }));
  fs.writeFileSync(stateFile, JSON.stringify({ items: archived, drafts: {}, views: {} }));
  const store = createUniversalInboxStore({ stateFile });
  store.addGift('friend', '新礼物');
  let state = readRecordState(stateFile);
  assert.equal(state.items.length, 302);
  assert.equal(state.items[0].id, 'OLD-0');
  state.items = Array.from({ length: 300 }, (_, i) => ({
    id: `ACTIVE-${i}`, kind: 'collection', title: `在用收藏${i}`, ownerSide: 'friend', status: 'active',
  }));
  writeRecordState(stateFile, state, ['items']);
  store.stage('friend', [{ kind: 'link', title: '候选一' }, { kind: 'link', title: '候选二' }]);
  assert.throws(() => store.saveAll('friend', 'collection'), /已有内容和这批候选都不会被覆盖/);
  assert.throws(() => store.saveItem('friend', 'collection', 1), /300/);
  assert.throws(() => store.addGift('friend', '再加一个'), /300/);
  assert.equal(store.getDrafts('friend').length, 2);
  state = readRecordState(stateFile);
  assert.equal(state.items.length, 300);
  assert.equal(state.items[0].id, 'ACTIVE-0');
  store.addGift('owner', '另一方自己的礼物');
  assert.equal(readRecordState(stateFile).items.length, 301);
});

test('extracts only bounded useful fields and strips URL queries', () => {
  const answer = '看起来是一个展览。\n[[UNIVERSAL_INBOX:{"kind":"ticket","title":"海洋展","placeName":"示例高塔","eventTime":"2026-09-18 19:30","url":"https://example.com/event?id=private","summary":"双人票"}]]';
  const extracted = extractUniversalInboxCandidate(answer);
  assert.equal(extracted.reply, '看起来是一个展览。');
  assert.deepEqual(extracted.candidate, {
    kind: 'ticket', title: '海洋展', placeName: '示例高塔', eventTime: '2026-09-18 19:30',
    url: 'https://example.com/event', summary: '双人票',
  });
  assert.equal(extractUniversalInboxCandidate('x\n[[UNIVERSAL_INBOX:{"kind":"ticket","title":"票","summary":"验证码：123456"}]]').candidate, null);
  assert.equal(extractUniversalInboxCandidate('x\n[[UNIVERSAL_INBOX:{"kind":"ticket","title":"同行票","tripScope":"pair"}]]').candidate.tripScope, 'pair');
});

test('only resolves generic follow-ups while a fresh draft exists', () => {
  assert.equal(parseUniversalInboxCommand('收藏', { hasDraft: false }), null);
  assert.deepEqual(parseUniversalInboxCommand('收藏', { hasDraft: true }), { type: 'resolve', action: 'collection', index: 0 });
  assert.deepEqual(parseUniversalInboxCommand('2保存票券', { hasDraft: true }), { type: 'resolve', action: 'ticket', index: 2 });
  assert.deepEqual(parseUniversalInboxCommand('4保存到礼物箱', { hasDraft: true }), {
    type: 'resolve', action: 'gift', index: 4, visibility: 'fixed_pair',
  });
  assert.deepEqual(parseUniversalInboxCommand('4私密保存到礼物箱', { hasDraft: true }), {
    type: 'resolve', action: 'gift', index: 4, visibility: 'owner_only',
  });
  assert.deepEqual(parseUniversalInboxCommand('2保存为好友的票券', { hasDraft: true, side: 'owner' }), { type: 'resolve', action: 'ticket', index: 2, tripScope: 'peer' });
  assert.deepEqual(parseUniversalInboxCommand('我的票券', { hasDraft: true, side: 'friend' }), { type: 'resolve', action: 'ticket', index: 0, tripScope: 'self' });
  assert.deepEqual(parseUniversalInboxCommand('第一个是我们两个人的行程', { side: 'owner' }), { type: 'assign_ticket', index: 1, tripScope: 'pair' });
  assert.deepEqual(parseUniversalInboxCommand('这两个都是Owner的行程', { side: 'owner' }), { type: 'assign_tickets', indices: [], expectedCount: 2, tripScope: 'self' });
  assert.deepEqual(parseUniversalInboxCommand('第一个和第二个都是好友的行程', { side: 'owner' }), { type: 'assign_tickets', indices: [1, 2], expectedCount: 0, tripScope: 'peer' });
  assert.equal(parseUniversalInboxCommand('这些都是我的', { side: 'owner' }), null);
  assert.deepEqual(parseUniversalInboxCommand('这些都是我的', { side: 'owner', hasTicketView: true }), { type: 'assign_tickets', indices: [], expectedCount: 0, tripScope: 'self' });
  assert.deepEqual(parseUniversalInboxCommand('第一和第二都是Owner的', { side: 'owner', hasTicketView: true }), { type: 'assign_tickets', indices: [1, 2], expectedCount: 0, tripScope: 'self' });
  assert.deepEqual(parseUniversalInboxCommand('查看好友的行程', { side: 'owner' }), { type: 'list', kind: 'ticket', tripScope: 'peer' });
  assert.deepEqual(parseUniversalInboxCommand('查看Owner的行程', { side: 'friend' }), { type: 'list', kind: 'ticket', tripScope: 'peer' });
  assert.deepEqual(parseUniversalInboxCommand('全部收藏', { hasDraft: true }), { type: 'resolve_all', action: 'collection' });
  assert.deepEqual(parseUniversalInboxCommand('查看票券仓'), { type: 'list', kind: 'ticket' });
  assert.deepEqual(parseUniversalInboxCommand('查看过期票券'), { type: 'list', kind: 'ticket', archived: true });
  assert.deepEqual(parseUniversalInboxCommand('收件箱帮助'), { type: 'help' });
});

test('extracts and stages up to five independent candidates for numbered handling', () => {
  const answer = '识别到了两个内容。\n[[UNIVERSAL_INBOX:[{"kind":"ticket","title":"海洋展","eventTime":"2026-09-18 19:30"},{"kind":"link","title":"餐厅页面","url":"https://example.com/a?private=1"}]]]';
  const extracted = extractUniversalInboxCandidate(answer);
  assert.equal(extracted.candidates.length, 2);
  assert.equal(extracted.candidates[1].url, 'https://example.com/a');
});

test('archives expired tickets and supports shared or private gifts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-complete-'));
  const stateFile = path.join(directory, 'state.json');
  let current = Date.parse('2026-08-24T06:00:00Z');
  const store = createUniversalInboxStore({ stateFile, now: () => current });
  try {
    store.stage('owner', [
      { kind: 'ticket', title: '明日展览', eventTime: '2026-08-25 18:00' },
      { kind: 'link', title: '餐厅页面' },
    ]);
    assert.equal(store.draftCount('owner'), 2);
    const ticket = store.saveItem('owner', 'ticket', 1, { tripScope: 'self' });
    assert.equal(store.ticketReminderSchedules(ticket).length, 2);
    assert.match(store.list('owner', 'ticket'), /明日展览.*行程人：Owner/);
    store.addGift('friend', '限定手办', '生日备选');
    store.addGift('friend', 'Owner 衣服穿 M 码', '', 'size', 'owner_only');
    const giftList = store.list('friend', 'gift');
    assert.match(giftList, /限定手办.*礼物灵感/u);
    assert.match(giftList, /Owner 衣服穿 M 码.*尺寸线索/u);
    assert.match(store.updateGift('friend', 2, 'bought'), /不需要标记已买/u);
    assert.match(store.list('owner', 'gift'), /限定手办.*双方可见/u);
    assert.doesNotMatch(store.list('owner', 'gift'), /Owner 衣服穿 M 码/u);
    store.list('friend', 'gift');
    assert.match(store.updateGift('friend', 1, 'private'), /仅自己可见/u);
    assert.equal(store.list('owner', 'gift'), '礼物箱现在还是空的。');
    store.list('friend', 'gift');
    assert.match(store.updateGift('friend', 1, 'share'), /双方可见/u);
    assert.match(store.list('owner', 'gift'), /限定手办/u);
    current = Date.parse('2026-08-27T06:00:00Z');
    assert.equal(store.list('owner', 'ticket'), '共享票券/预约仓现在还是空的。');
    assert.match(store.list('owner', 'ticket', { archived: true }), /明日展览/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('stages ephemeral candidates and shares bounded ticket summaries without raw images', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-'));
  const stateFile = path.join(directory, 'state.json');
  let current = Date.parse('2026-08-24T06:00:00Z');
  const store = createUniversalInboxStore({ stateFile, now: () => current });
  try {
    const prompt = store.stage('friend', {
      kind: 'ticket', title: '海洋展', placeName: '示例高塔', eventTime: '2026-09-18 19:30',
      url: 'https://example.com/event', summary: '双人票',
    });
    assert.match(prompt, /保存票券/);
    assert.equal(store.hasDraft('friend'), true);
    assert.throws(() => store.saveItem('friend', 'ticket'), /是谁的行程/);
    const item = store.saveItem('friend', 'ticket', 0, { tripScope: 'pair' });
    assert.equal(item.ownerSide, 'friend');
    assert.deepEqual(item.participantSides, ['owner', 'friend']);
    assert.match(store.list('friend', 'ticket'), /海洋展.*行程人：Owner \+ 好友/);
    assert.doesNotMatch(JSON.stringify(readRecordState(stateFile)), /image|二维码|订单号/iu);
    assert.match(store.explain('friend', '海洋展'), /好友.*明确.*票券\/预约仓/);
    assert.match(store.list('owner', 'ticket'), /海洋展.*添加人：好友.*行程人：Owner \+ 好友/u);
    assert.match(store.assignTicket('owner', 1, 'self'), /只有添加人可以修改/u);

    store.stage('owner', { kind: 'note', title: '临时候选', placeName: '', eventTime: '', url: '', summary: '' });
    current += 31 * 60 * 1000;
    assert.equal(store.hasDraft('owner'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('multi-candidate prompt never suggests an index that was not shown', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-prompt-'));
  const store = createUniversalInboxStore({ stateFile: path.join(directory, 'state.json') });
  try {
    const prompt = store.stage('owner', [
      { kind: 'ticket', title: '第一张票', placeName: '', eventTime: '', url: '', summary: '' },
      { kind: 'note', title: '第二条收藏', placeName: '', eventTime: '', url: '', summary: '' },
    ]);
    assert.match(prompt, /1\. 第一张票/);
    assert.match(prompt, /2\. 第二条收藏/);
    assert.match(prompt, /“1保存票券”“1收藏”“1加入想去箱”/);
    assert.doesNotMatch(prompt, /“3加入想去箱”/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('shares existing collections while preserving legacy gifts as private', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-visibility-migration-'));
  const stateFile = path.join(directory, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 3, drafts: {}, views: {}, items: [
      {
        id: 'CL-OLD', kind: 'collection', title: '旧咖啡店', ownerSide: 'owner', status: 'active',
        createdAt: '2026-08-24T05:00:00.000Z', updatedAt: '2026-08-24T05:00:00.000Z',
        provenance: { ownerSide: 'owner', visibility: 'owner_only' },
      },
      {
        id: 'GF-OLD', kind: 'gift', title: '旧惊喜', ownerSide: 'owner', status: 'active',
        createdAt: '2026-08-24T04:00:00.000Z', updatedAt: '2026-08-24T04:00:00.000Z',
        provenance: { ownerSide: 'owner', visibility: 'owner_only' },
      },
    ],
  }));
  const store = createUniversalInboxStore({ stateFile, now: () => Date.parse('2026-08-24T06:00:00Z') });
  try {
    assert.match(store.list('friend', 'collection'), /旧咖啡店.*添加人：Owner/u);
    assert.equal(store.list('friend', 'gift'), '礼物箱现在还是空的。');
    assert.match(store.list('owner', 'gift'), /旧惊喜.*仅自己可见/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('keeps legacy ticket ownership unknown until an explicit numbered assignment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-legacy-trip-'));
  const stateFile = path.join(directory, 'state.json');
  const reminderUpdates = [];
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 2, drafts: {}, views: {}, items: [{
      id: 'TK-OLD', kind: 'ticket', title: '旧预约', eventTime: '2026-09-20 10:00',
      ownerSide: 'owner', status: 'active', createdAt: '2026-08-24T06:00:00.000Z', updatedAt: '2026-08-24T06:00:00.000Z',
    }],
  }));
  const store = createUniversalInboxStore({
    stateFile,
    now: () => Date.parse('2026-08-24T06:00:00Z'),
    sideNames: { owner: 'Owner', friend: '好友' },
    onTicketAssigned: (side, item, label) => { reminderUpdates.push({ side, id: item.id, label }); return 2; },
  });
  try {
    assert.match(store.list('owner', 'ticket'), /行程人：待确认/);
    const reply = store.assignTicket('owner', 1, 'peer');
    assert.match(reply, /行程人标为：好友/);
    assert.match(reply, /同步更新了 2 条/);
    assert.deepEqual(reminderUpdates, [{ side: 'owner', id: 'TK-OLD', label: '好友' }]);
    assert.match(store.list('owner', 'ticket', { tripScope: 'peer' }), /旧预约.*行程人：好友/);
    assert.equal(store.list('owner', 'ticket', { tripScope: 'self' }), '共享票券/预约仓现在还是空的。');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('assigns natural bulk references only against the current ticket view', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-inbox-bulk-trip-'));
  const stateFile = path.join(directory, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 3, drafts: {}, views: {}, items: ['A', 'B'].map((id) => ({
      id: `TK-${id}`, kind: 'ticket', title: `机票${id}`, eventTime: '2026-09-20 10:00',
      ownerSide: 'owner', status: 'active', createdAt: '2026-08-24T06:00:00.000Z', updatedAt: '2026-08-24T06:00:00.000Z',
    })),
  }));
  const updated = [];
  const store = createUniversalInboxStore({
    stateFile,
    now: () => Date.parse('2026-08-24T06:00:00Z'),
    onTicketAssigned: (side, item, label) => { updated.push({ side, id: item.id, label }); return 2; },
  });
  try {
    store.list('owner', 'ticket');
    assert.deepEqual(store.ticketViewStatus('owner'), { pending: true, count: 2 });
    const reply = store.assignTickets('owner', [], 'self', { expectedCount: 2 });
    assert.match(reply, /这 2 张票券.*行程人标为：Owner/);
    assert.match(reply, /同步更新了 4 条/);
    assert.equal(updated.length, 2);
    assert.doesNotMatch(store.list('owner', 'ticket'), /机票[AB][^\n]*待确认/);
    assert.match(store.assignTickets('owner', [], 'pair', { expectedCount: 3 }), /列表有 2 条，不是 3 条/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('extracts bounded semantic ticket intents and strips hidden markers', () => {
  const context = {
    enabled: true, selfName: 'Owner', peerName: '好友', drafts: [],
    tickets: [{ index: 1, title: '丙城机票', placeName: '丙城', participantLabel: '待确认' }],
    catalog: [{ index: 1, id: 'TK-INTERNAL', kind: 'ticket', title: '丙城机票', placeName: '丙城', status: 'active' }],
  };
  const instruction = buildTicketIntentInstruction(context);
  assert.match(instruction, /丙城机票/);
  assert.match(instruction, /self 是当前说话者/);
  assert.doesNotMatch(instruction, /TK-INTERNAL/);
  assert.equal(mightBeNaturalTicketIntent('去丙城的是我出差', context), true);
  assert.equal(mightBeNaturalTicketIntent('今天吃什么', context), false);
  assert.equal(mightBeNaturalTicketIntent('丙城那张票不要了', context), true);
  assert.equal(mightBeNaturalTicketIntent('把那个文件删掉', context), false);
  const extracted = extractTicketIntent('[[TICKET_INTENT:{"action":"assign_saved","indices":[1],"all":false,"tripScope":"self"}]]');
  assert.equal(extracted.reply, '');
  assert.deepEqual(extracted.intent, {
    action: 'assign_saved', indices: [1], all: false, tripScope: 'self',
  });
  assert.equal(extractTicketIntent('正常回答\n[[TICKET_INTENT:{"action":"assign_saved","indices":[99],"tripScope":"self"}]]').intent, null);
  assert.equal(extractTicketIntent('[[TICKET_INTENT:{"action":"assign_saved","indices":[1],"tripScope":"self","expectedCount":2}]]').intent.expectedCount, 2);
  assert.deepEqual(extractTicketIntent('[[TICKET_INTENT:{"action":"remove_saved","indices":[3],"all":false}]]').intent, {
    action: 'remove_saved', indices: [3], all: false,
  });
  assert.equal(extractTicketIntent('[[TICKET_INTENT:{"action":"remove_saved","indices":[],"all":true}]]').intent, null);
});
