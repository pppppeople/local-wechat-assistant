'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readRecordState } = require('../src/record-state');
const {
  SESSION_TTL_MS,
  createPairDecisionStore,
  normalizeConstraints,
  normalizePreference,
  openDecisionResult,
} = require('../src/pair-decision-store');

const NOW = Date.UTC(2026, 8, 4, 4);
const optionInput = { title: '今晚吃什么', options: ['火锅', '日料', '烧烤'] };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-store-'));
  const stateFile = path.join(directory, 'state.json');
  const notices = [];
  const store = createPairDecisionStore({
    stateFile,
    now: () => NOW,
    onNotice: (...args) => notices.push(args),
    ...options,
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, stateFile, store, notices };
}

function decisionId(text) {
  return text.match(/#(PD-[A-Z0-9]+)/u)[1];
}

test('normalizers expose bounded structured preferences and reject unusable input', () => {
  const preference = normalizePreference('首选2，1也可以，不要3', 3, ['火锅', '日料', '烧烤']);
  assert.deepEqual(preference.accepted, [2, 1]);
  assert.deepEqual(preference.rejected, [3]);
  assert.deepEqual(preference.ranking, [2]);
  assert.equal(typeof preference.submittedAt, 'string');

  const constraints = normalizeConstraints('预算两百元，想室内，附近，不想吃辣');
  assert.equal(constraints.budgetMax, 200);
  assert.equal(constraints.environment, 'indoor');
  assert.equal(constraints.distance, 'near');
  assert.ok(constraints.dislikes.includes('辣'));
  assert.throws(() => normalizePreference('这是一句无关的话', 3, optionInput.options), /请说出选项名称或编号/u);
  assert.throws(() => normalizeConstraints('这是一句无关的话'), /还没提取到可比较的条件/u);
  assert.throws(() => normalizeConstraints(''), /请说说你的预算/u);
});

test('normalizeConstraints parses Chinese thousand-level budgets', () => {
  assert.equal(normalizeConstraints('预算一千元想室内').budgetMax, 1000);
  assert.equal(normalizeConstraints('预算两千五百元想室内').budgetMax, 2500);
  assert.equal(normalizeConstraints('预算千元想室内').budgetMax, 1000);
});

test('normalizeConstraints parses wan budgets without truncating the amount', () => {
  for (const [text, expected] of [
    ['2万', 20000], ['1.5万', 15000], ['0.5万', 5000],
    ['一万', 10000], ['一万元', 10000], ['一万五千', 15000],
    ['两万', 20000], ['一万五千元', 15000], ['一万零五十块', 10050],
    ['200元', 200], ['今晚6点，预算200元', 200], ['150块', 150], ['两百元', 200], ['十元', 10], ['0元', 0],
  ]) {
    assert.equal(normalizeConstraints(`预算${text}`).budgetMax, expected, text);
  }
});

test('normalizeConstraints keeps unsupported amounts on the failure or ignore path', () => {
  for (const text of ['预算未知', '预算150', '预算一亿五千元']) {
    assert.throws(() => normalizeConstraints(text), /还没提取到可比较的条件/u, text);
    assert.equal(normalizeConstraints(`${text}，室内`).budgetMax, null, text);
  }
  for (const text of ['预算1.2.5万元', '预算一万万五千元', '预算-2万元']) {
    assert.throws(() => normalizeConstraints(text), /还没提取到可比较的条件/u, text);
    assert.equal(normalizeConstraints(`${text}，室内`).budgetMax, null, text);
  }
});

test('creating an option decision lists it, notifies the peer and survives reopening', t => {
  const { directory, stateFile, store, notices } = fixture(t);
  const created = store.create('owner', optionInput);
  const id = decisionId(created);
  assert.match(created, /火锅[\s\S]*日料[\s\S]*烧烤/u);
  assert.deepEqual(notices[0][0], 'friend');
  assert.equal(notices[0][2], `pair-decision-created|${id}`);
  assert.equal(store.hasPending('friend'), true);
  assert.match(store.list('friend'), new RegExp(`#${id}｜今晚吃什么｜等你提交`, 'u'));

  const state = readRecordState(stateFile);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.sessions[0].id, id);
  const index = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(fs.existsSync(path.join(directory, index.sessions[0].file)), true);
  const reopened = createPairDecisionStore({ stateFile, now: () => NOW });
  assert.match(reopened.list('owner'), new RegExp(`#${id}｜今晚吃什么｜等你提交`, 'u'));
});

test('option submissions update private state, resolve on the second side and persist the result', t => {
  const { stateFile, store, notices } = fixture(t);
  const id = decisionId(store.create('owner', optionInput));
  const first = store.submitResult('owner', { id, preferenceText: '首选2，1也可以，不要3' });
  assert.equal(first.wrote, true);
  assert.equal(first.continue, true);
  assert.match(first.reply, /还在等对方提交/u);
  const storedFirst = readRecordState(stateFile).sessions[0];
  assert.deepEqual(storedFirst.preferences.owner.accepted, [2, 1]);
  assert.equal(storedFirst.preferences.owner.rejected[0], 3);
  assert.doesNotMatch(JSON.stringify(storedFirst), /首选2|不要3/u);

  const result = store.submit('friend', { id, preferenceText: '首选1，2也可以，不要3' });
  assert.match(result, /最大交集：(?:1\. 火锅；2\. 日料|2\. 日料；1\. 火锅)/u);
  assert.match(result, /这里只公布共同可接受的结果/u);
  const resolved = readRecordState(stateFile).sessions[0];
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.result, result);
  assert.equal(store.hasPending('owner'), false);
  assert.match(createPairDecisionStore({ stateFile, now: () => NOW }).list('friend'), /已出结果/u);
  assert.equal(notices.length, 2);
  assert.equal(notices[1][0], 'owner');
});

test('constraint submissions store only normalized conditions and expose the shared result', t => {
  const { stateFile, store } = fixture(t);
  const id = decisionId(store.create('owner', { title: '周末干嘛', options: [], mode: 'constraints' }));
  assert.match(store.submit('owner', { id, preferenceText: '预算200元，想室内，最好近一点，不想吃辣，这是私密原话' }), /标准化条件/u);
  const result = store.submit('friend', { id, preferenceText: '人均150元，室内外都行，附近，想看展，不要排队' });
  assert.match(result, /预算按人均不超过 150 元/u);
  assert.match(result, /距离近优先/u);
  assert.doesNotMatch(result, /看展|私密原话/u);
  const session = readRecordState(stateFile).sessions[0];
  assert.equal(session.status, 'resolved');
  assert.equal(openDecisionResult(session), result);
  assert.equal(session.constraints.owner.budgetMax, 200);
  assert.equal(session.constraints.friend.budgetMax, 150);
  assert.doesNotMatch(JSON.stringify(session), /私密原话|看展/u);
});

test('incompatible option submissions clear both responses and permit a fresh round', t => {
  const { stateFile, store } = fixture(t);
  const id = decisionId(store.create('owner', { title: '二选一', options: ['甲', '乙'] }));
  store.submit('owner', { id, preferenceText: '我选1' });
  const conflict = store.submitResult('friend', { id, preferenceText: '我选2' });
  assert.equal(conflict.wrote, true);
  assert.match(conflict.reply, /没有共同接受/u);
  assert.deepEqual(readRecordState(stateFile).sessions[0].preferences, {});
  assert.equal(readRecordState(stateFile).sessions[0].status, 'collecting');
  assert.equal(store.hasPending('owner'), true);
  assert.equal(store.hasPending('friend'), true);
  store.submit('owner', { preferenceText: '都可以' });
  assert.match(store.submit('friend', { preferenceText: '我选2' }), /推荐先选：2\. 乙/u);
  assert.equal(readRecordState(stateFile).sessions[0].status, 'resolved');
});

test('only the creator can cancel, and side deletion removes all sessions and record bodies', t => {
  const { directory, stateFile, store } = fixture(t);
  const first = decisionId(store.create('owner', optionInput));
  const second = decisionId(store.create('friend', { title: '周末去哪', options: ['公园', '博物馆'] }));
  const refs = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions.map((session) => session.file);
  assert.throws(() => store.cancel('friend', first), /没有找到由你发起/u);
  assert.match(store.cancel('owner', first.toLowerCase()), /已经取消/u);
  assert.equal(readRecordState(stateFile).sessions.find((session) => session.id === first).status, 'cancelled');
  assert.doesNotMatch(store.list('friend'), new RegExp(first, 'u'));
  assert.match(store.list('friend'), new RegExp(second, 'u'));
  assert.deepEqual(store.deleteSide(), { removed: 2 });
  assert.deepEqual(readRecordState(stateFile).sessions, []);
  for (const file of refs) assert.equal(fs.existsSync(path.join(directory, file)), false);
  assert.deepEqual(store.deleteSide(), { removed: 0 });
});

test('invalid sides, creation fields and submissions fail without unintended writes', t => {
  const { stateFile, store, notices } = fixture(t);
  for (const invoke of [
    () => store.create('other', optionInput),
    () => store.submitResult('other', {}),
    () => store.hasPending('other'),
    () => store.list('other'),
    () => store.cancel('other', 'PD-1'),
  ]) assert.throws(invoke, /invalid decision side/u);
  for (const input of [
    { title: ' ', options: ['甲', '乙'] },
    { title: '问题', options: ['甲'] },
    { title: '问题', options: ['甲', '甲', '', null] },
  ]) assert.throws(() => store.create('owner', input), /需要一个问题和至少两个候选/u);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(notices.length, 0);
  assert.deepEqual(store.submitResult('owner', { preferenceText: '我选1' }), {
    reply: '现在没有等你填写的双人私密决策。', wrote: false, continue: false,
  });

  const id = decisionId(store.create('owner', optionInput));
  const before = readRecordState(stateFile);
  assert.equal(store.submitResult('owner', { id: 'PD-UNKNOWN', preferenceText: '我选1' }).wrote, false);
  assert.throws(() => store.submit('owner', { id, preferenceText: '完全无关的话' }), /请说出选项名称或编号/u);
  assert.deepEqual(readRecordState(stateFile), before);
  assert.throws(() => store.cancel('friend', id), /没有找到由你发起/u);
});

test('five live sessions is the limit, and exact expiry frees capacity and persists', t => {
  let clock = NOW;
  const { stateFile, store } = fixture(t, { now: () => clock });
  for (let index = 0; index < 5; index += 1) {
    store.create('owner', { ...optionInput, title: `问题${index}` });
  }
  const before = readRecordState(stateFile);
  assert.throws(() => store.create('owner', optionInput), /最多五个/u);
  assert.deepEqual(readRecordState(stateFile), before);
  clock = NOW + SESSION_TTL_MS - 1;
  assert.equal(store.hasPending('owner'), true);
  clock += 1;
  assert.equal(store.hasPending('owner'), false);
  assert.equal(store.list('friend'), '现在没有双人私密决策。');
  assert.ok(readRecordState(stateFile).sessions.every((session) => session.status === 'expired'));
  const id = decisionId(store.create('friend', optionInput));
  const reopened = createPairDecisionStore({ stateFile, now: () => clock });
  assert.equal(reopened.hasPending('owner'), true);
  assert.equal(readRecordState(stateFile).sessions.filter((session) => session.id === id).length, 1);
});
