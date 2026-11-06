'use strict';

const { readRecordState } = require('../src/record-state');

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const crypto = require('node:crypto');
const { parseGiftBoxCommand } = require('../src/gift-box-commands');
const { parsePairDecisionCommand } = require('../src/pair-decision-commands');
const { SESSION_TTL_MS, createPairDecisionStore } = require('../src/pair-decision-store');

const NOW = Date.UTC(2026, 8, 4, 4);

function decisionFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-edges-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const notices = [];
  const store = createPairDecisionStore({ stateFile, now: () => NOW,
    onNotice: (...args) => notices.push(args), ...options });
  return { directory, stateFile, notices, store };
}

function decisionId(reply) { return reply.match(/#(PD-[A-Z0-9-]+)/u)[1]; }
const optionInput = { title: '合成选择', options: ['选项甲', '选项乙'] };

test('parses natural private decisions and surprise-box actions', () => {
  assert.deepEqual(parsePairDecisionCommand('双人决策：今晚吃什么；选项：火锅、日料、烧烤'), {
    type: 'create', title: '今晚吃什么', options: ['火锅', '日料', '烧烤'],
  });
  assert.deepEqual(parsePairDecisionCommand('我选2，1也可以，不要3', { hasPending: true }), {
    type: 'submit', id: '', preferenceText: '我选2，1也可以，不要3',
  });
  assert.deepEqual(parsePairDecisionCommand('今晚吃火锅、日料还是烧烤？'), {
    type: 'create', title: '今晚吃什么', options: ['火锅', '日料', '烧烤'],
  });
  assert.equal(parsePairDecisionCommand('今天去示例高塔，明天去乙城'), null);
  assert.deepEqual(parsePairDecisionCommand('我最想吃日料，火锅也可以，不想烧烤', { hasPending: true }), {
    type: 'submit', id: '', preferenceText: '我最想吃日料，火锅也可以，不想烧烤',
  });
  assert.equal(parsePairDecisionCommand('我选2，1也可以，不要3', { hasPending: false }), null);
  assert.deepEqual(parsePairDecisionCommand('帮我们决定周末干嘛'), {
    type: 'create', title: '周末干嘛', options: [], mode: 'constraints',
  });
  assert.deepEqual(parseGiftBoxCommand('这个先别告诉好友，我想买给他：限定手办', {
    peerNames: ['好友'],
  }), { type: 'add', title: '限定手办', category: 'idea', visibility: 'owner_only' });
  assert.deepEqual(parseGiftBoxCommand('把好友衣服穿 M 码记进礼物箱'), {
    type: 'add', title: '好友衣服穿 M 码', category: 'size', visibility: 'fixed_pair',
  });
  assert.deepEqual(parseGiftBoxCommand('把好友喜欢蓝色记进礼物箱'), {
    type: 'add', title: '好友喜欢蓝色', category: 'preference', visibility: 'fixed_pair',
  });
  assert.deepEqual(parseGiftBoxCommand('礼物箱第一个已买'), { type: 'update', index: 1, action: 'bought' });
  assert.deepEqual(parseGiftBoxCommand('礼物箱第一个不给对方看'), { type: 'update', index: 1, action: 'private' });
});

test('open private decisions persist normalized constraints and reveal only their intersection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-constraints-'));
  const notices = [];
  const store = createPairDecisionStore({
    stateFile: path.join(directory, 'state.json'),
    onNotice: (...args) => notices.push(args),
  });
  try {
    const created = store.create('owner', { title: '周末干嘛', options: [], mode: 'constraints' });
    const id = created.match(/#(PD-[A-Z0-9-]+)/u)[1];
    const ownerRaw = '我预算200元，想室内，最好近一点，不想吃辣，这是只跟你说的原话';
    assert.match(store.submit('owner', { id, preferenceText: ownerRaw }), /标准化条件/u);
    const result = store.submit('friend', { id, preferenceText: '人均150元，室内外都行，附近，想看展，不要排队' });
    assert.match(result, /人均不超过 150 元/u);
    assert.match(result, /距离近优先/u);
    assert.match(result, /只使用双方条件的交集/u);
    assert.doesNotMatch(result, /看展/u);
    assert.doesNotMatch(result, /这是只跟你说的原话/u);
    const persisted = JSON.stringify(readRecordState(path.join(directory, 'state.json')));
    assert.doesNotMatch(persisted, /这是只跟你说的原话/u);
    assert.doesNotMatch(notices.at(-1)[1], /这是只跟你说的原话/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('open private decisions do not expose one-sided constraints as shared', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-one-sided-'));
  const store = createPairDecisionStore({ stateFile: path.join(directory, 'state.json') });
  try {
    const created = store.create('owner', { title: '周末做什么', options: [], mode: 'constraints' });
    const id = created.match(/#(PD-[A-Z0-9-]+)/u)[1];
    store.submit('owner', { id, preferenceText: '预算两百，不想吃辣，想室内' });
    const result = store.submit('friend', { id, preferenceText: '想去看展，距离无所谓' });
    assert.doesNotMatch(result, /200|吃辣|室内优先/u);
    assert.match(result, /未共同设定预算|未共同指定室内外/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('accepts option names while persisting only normalized private choices', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-natural-'));
  const store = createPairDecisionStore({ stateFile: path.join(directory, 'state.json') });
  try {
    const created = store.create('owner', { title: '今晚吃什么', options: ['火锅', '日料', '烧烤'] });
    const id = created.match(/#(PD-[A-Z0-9-]+)/u)[1];
    assert.match(store.submit('owner', { id, preferenceText: '我最想吃日料，火锅也可以，不想烧烤' }), /还在等对方/);
    const result = store.submit('friend', { id, preferenceText: '我最想吃火锅，日料也可以，不想烧烤' });
    assert.match(result, /火锅|日料/u);
    const persisted = JSON.stringify(readRecordState(path.join(directory, 'state.json')));
    assert.doesNotMatch(persisted, /最想吃|不想烧烤/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('two-option decisions only suggest choices that actually exist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-two-options-'));
  const notices = [];
  const store = createPairDecisionStore({
    stateFile: path.join(directory, 'state.json'),
    onNotice: (...args) => notices.push(args),
  });
  try {
    const created = store.create('owner', { title: '今晚吃什么', options: ['火锅', '日料'] });
    assert.match(created, /首选火锅，日料也可以/);
    assert.doesNotMatch(created, /不要3|选项3/);
    assert.match(notices[0][1], /首选火锅，日料也可以/);
    assert.doesNotMatch(notices[0][1], /不要3|选项3/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reveals only the shared decision intersection and never either raw preference', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-decision-'));
  const notices = [];
  const store = createPairDecisionStore({
    stateFile: path.join(directory, 'state.json'),
    onNotice: (...args) => notices.push(args),
  });
  try {
    const created = store.create('owner', { title: '今晚吃什么', options: ['火锅', '日料', '烧烤'] });
    const id = created.match(/#(PD-[A-Z0-9-]+)/u)[1];
    assert.match(store.submit('owner', { id, preferenceText: '首选2，1也可以，不要3' }), /还在等对方/);
    const result = store.submit('friend', { id, preferenceText: '首选1，2也可以，不要3' });
    assert.match(result, /最大交集：(?:1\. 火锅；2\. 日料|2\. 日料；1\. 火锅)/);
    assert.doesNotMatch(result, /首选|不要3/);
    assert.equal(notices.at(-1)[0], 'owner');
    assert.doesNotMatch(JSON.stringify(readRecordState(path.join(directory, 'state.json'))), /首选2|不要3/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('decision status uses the computed intersection, never words in the title', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-title-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = createPairDecisionStore({ stateFile: file });
  for (const input of [
    { title: '暂时没有共同接受的选项', options: ['火锅', '日料'] },
    { title: '没有交集是什么意思', options: [], mode: 'constraints' },
  ]) {
    const created = store.create('owner', input);
    const id = created.match(/#(PD-[A-Z0-9-]+)/u)[1];
    const preferenceText = input.options.length ? '我选1' : '想室内';
    store.submit('owner', { id, preferenceText });
    store.submit('friend', { id, preferenceText });
    assert.equal(readRecordState(file).sessions.find(s => s.id === id).status, 'resolved');
  }
});

test('incompatible indoor and outdoor constraints remain unresolved and keep raw preferences private', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-conflict-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const notices = [];
  const store = createPairDecisionStore({ stateFile: file, onNotice: (_, text) => notices.push(text) });
  const id = store.create('owner', { title: '周末安排', options: [], mode: 'constraints' }).match(/#(PD-[A-Z0-9-]+)/u)[1];
  store.submit('owner', { id, preferenceText: '只想室内，这是合成私密原话' });
  const result = store.submit('friend', { id, preferenceText: '只想室外，这是另一句合成私密原话' });
  assert.match(result, /没有交集/);
  assert.doesNotMatch(result, /这是合成|另一句/);
  const session = readRecordState(file).sessions.find(s => s.id === id);
  assert.equal(session.status, 'collecting');
  assert.deepEqual(session.constraints, {});
  assert.doesNotMatch(notices.at(-1), /合成私密原话/);
});

for (const [name, contents] of [
  ['missing', undefined], ['empty', ''], ['corrupt', 'not json'],
  ['truncated', '{"sessions":['], ['invalid collection', '{"schemaVersion":1,"sessions":{}}'],
]) {
  const corrupt = ['empty', 'corrupt', 'truncated'].includes(name);
  test(`decisions ${corrupt ? 'refuse and preserve' : 'initialize or normalize'} a ${name} index`, t => {
    const { directory, stateFile, store, notices } = decisionFixture(t);
    if (contents !== undefined) fs.writeFileSync(stateFile, contents);
    if (corrupt) {
      assert.throws(() => store.list('owner'), /Invalid JSON file/);
      assert.throws(() => store.create('friend', optionInput), /Invalid JSON file/);
      assert.throws(() => store.deleteSide(), /Invalid JSON file/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), contents);
      assert.deepEqual(fs.readdirSync(directory), ['state.json']);
      assert.equal(notices.length, 0);
      return;
    }
    assert.equal(store.list('owner'), '现在没有双人私密决策。');
    assert.equal(store.hasPending('friend'), false);
    assert.deepEqual(store.submitResult('owner', { preferenceText: '我选1' }), {
      reply: '现在没有等你填写的双人私密决策。', wrote: false, continue: false,
    });
    assert.deepEqual(store.deleteSide(), { removed: 0 });
    assert.equal(notices.length, 0);
    const id = decisionId(store.create('friend', optionInput));
    const reopened = createPairDecisionStore({ stateFile, now: () => NOW });
    assert.equal(reopened.hasPending('owner'), true);
    const state = readRecordState(stateFile);
    assert.equal(state.schemaVersion, 2);
    assert.deepEqual(state.sessions.map(session => session.id), [id]);
    assert.equal(notices.length, 1);
    assert.equal(notices[0][0], 'owner');
  });
}

for (const damage of ['missing', 'corrupt', 'truncated']) {
  test(`decisions refuse submission with a ${damage} body and recover without a premature notice`, t => {
    const { directory, stateFile, store, notices } = decisionFixture(t);
    const id = decisionId(store.create('owner', optionInput));
    const index = fs.readFileSync(stateFile, 'utf8');
    const body = path.join(directory, JSON.parse(index).sessions[0].file);
    const original = fs.readFileSync(body, 'utf8');
    if (damage === 'missing') fs.unlinkSync(body);
    else fs.writeFileSync(body, damage === 'corrupt' ? 'invalid' : original.slice(0, -5));
    assert.throws(() => store.submit('owner', { id, preferenceText: '我选1' }), /内容暂时无法读取/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), index);
    assert.equal(notices.length, 1);
    fs.writeFileSync(body, original);
    assert.equal(store.submitResult('owner', { id, preferenceText: '我选1' }).wrote, true);
    assert.deepEqual(readRecordState(stateFile).sessions[0].preferences.owner.accepted, [1]);
    assert.equal(notices.length, 1);
  });
}

test('legacy inline option sessions without mode or constraints remain usable after migration', t => {
  const { stateFile, store } = decisionFixture(t);
  const legacy = { id: 'PD-LEGACY', ...optionInput, createdBy: 'owner', status: 'collecting',
    preferences: {}, createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + SESSION_TTL_MS).toISOString() };
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, sessions: [legacy] }));
  assert.equal(store.hasPending('friend'), true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile))._recordState.version, 1);
  assert.deepEqual(readRecordState(stateFile).sessions, [legacy]);
  store.submit('owner', { id: 'pd-legacy', preferenceText: '我选1' });
  assert.match(store.submit('friend', { id: 'pd-legacy', preferenceText: '我选1' }), /推荐先选：1\. 选项甲/);
  const state = readRecordState(stateFile);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.sessions[0].status, 'resolved');
});

test('decision validation rejects invalid sides, empty titles and collapsed options before writes or notices', t => {
  const { stateFile, store, notices } = decisionFixture(t);
  for (const invoke of [
    () => store.create('other', optionInput), () => store.submitResult('other', {}),
    () => store.hasPending('other'), () => store.list('other'), () => store.cancel('other', 'PD-1'),
  ]) assert.throws(invoke, /invalid decision side/);
  for (const input of [{ title: ' ', options: ['甲', '乙'] }, { title: '问题', options: ['甲'] },
    { title: '问题', options: [' 甲 ', '甲', '', null] }]) {
    assert.throws(() => store.create('owner', input), /需要一个问题和至少两个候选/);
  }
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(notices.length, 0);
});

test('decision creation trims, deduplicates and bounds options before persisting or notifying', t => {
  const { stateFile, store, notices } = decisionFixture(t);
  const longOption = '长'.repeat(80);
  store.create('owner', { title: ` ${'题'.repeat(121)} `,
    options: [' 甲 ', '甲', '', null, longOption + '一', longOption + '二', ...Array.from({ length: 8 }, (_, i) => `候选${i}`)] });
  const session = readRecordState(stateFile).sessions[0];
  assert.equal(session.title, '题'.repeat(120));
  assert.deepEqual(session.options, ['甲', longOption, '候选0', '候选1', '候选2', '候选3', '候选4', '候选5']);
  assert.equal(session.mode, 'options');
  assert.doesNotMatch(notices[0][1], /候选6|候选7/);
});

test('decision collection limit includes five live sessions and frees capacity at the exact expiry time', t => {
  let clock = NOW;
  const { stateFile, store, notices } = decisionFixture(t, { now: () => clock });
  for (let i = 0; i < 5; i++) store.create(i % 2 ? 'friend' : 'owner', { ...optionInput, title: `问题${i}` });
  const before = readRecordState(stateFile);
  assert.throws(() => store.create('owner', optionInput), /最多五个/);
  assert.deepEqual(readRecordState(stateFile), before);
  assert.equal(notices.length, 5);
  clock = NOW + SESSION_TTL_MS - 1;
  assert.equal(store.hasPending('owner'), true);
  clock += 1;
  assert.equal(store.hasPending('owner'), false);
  assert.equal(store.list('friend'), '现在没有双人私密决策。');
  assert.ok(readRecordState(stateFile).sessions.every(session => session.status === 'expired'));
  assert.equal(store.submitResult('owner', { id: before.sessions[0].id, preferenceText: '我选1' }).wrote, false);
  store.create('owner', optionInput);
  assert.equal(readRecordState(stateFile).sessions.filter(session => session.status === 'collecting').length, 1);
  assert.equal(notices.length, 6);
});

test('legacy collecting sessions without an expiry expire without hiding resolved sessions', t => {
  const { stateFile, store } = decisionFixture(t);
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: [
    { id: 'PD-NO-EXPIRY', title: '旧待填', status: 'collecting', preferences: {} },
    { id: 'PD-RESOLVED', title: '旧结果', status: 'resolved', preferences: {}, result: '合成结果' },
  ] }));
  assert.equal(store.hasPending('owner'), false);
  assert.deepEqual(readRecordState(stateFile).sessions.map(session => session.status), ['expired', 'resolved']);
  assert.match(store.list('friend'), /旧结果.*已出结果[\s\S]*合成结果/);
  assert.doesNotMatch(store.list('owner'), /旧待填/);
});

test('implicit submissions choose the newest unanswered session independently for each side', t => {
  let clock = NOW;
  const { stateFile, store } = decisionFixture(t, { now: () => clock });
  const older = decisionId(store.create('owner', optionInput));
  clock += 1000;
  const newer = decisionId(store.create('friend', { title: '合成条件', options: [] }));
  assert.match(store.submit('owner', { preferenceText: '附近' }), new RegExp(newer));
  assert.match(store.list('friend'), new RegExp(`${newer}.*等你提交`));
  assert.match(store.list('owner'), new RegExp(`${newer}.*你已提交`));
  assert.match(store.submit('owner', { preferenceText: '我选1' }), new RegExp(older));
  assert.equal(store.hasPending('owner'), false);
  assert.equal(store.hasPending('friend'), true);
  assert.match(store.submit('friend', { preferenceText: '附近' }), new RegExp(newer));
  const sessions = readRecordState(stateFile).sessions;
  assert.equal(sessions.find(session => session.id === newer).status, 'resolved');
  assert.equal(sessions.find(session => session.id === older).status, 'collecting');
});

for (const mode of ['options', 'constraints']) {
  test(`invalid ${mode} submissions preserve the stored response and do not notify`, t => {
    const { stateFile, store, notices } = decisionFixture(t);
    const id = decisionId(store.create('owner', { ...optionInput, mode }));
    const valid = mode === 'options' ? '我选1' : '附近';
    store.submit('owner', { id, preferenceText: valid });
    const before = readRecordState(stateFile);
    assert.throws(() => store.submit('owner', { id, preferenceText: '这是一句无关的话' }), /请说出选项|还没提取到可比较的条件/);
    assert.equal(store.submitResult('friend', { id: 'PD-UNKNOWN', preferenceText: valid }).wrote, false);
    assert.deepEqual(readRecordState(stateFile), before);
    assert.equal(notices.length, 1);
  });
}

test('disjoint option choices clear both submissions and allow a fresh round to resolve', t => {
  const { stateFile, store, notices } = decisionFixture(t);
  const id = decisionId(store.create('owner', optionInput));
  store.submit('owner', { id, preferenceText: '我选1' });
  const conflict = store.submitResult('friend', { id, preferenceText: '我选2' });
  assert.equal(conflict.wrote, true);
  assert.match(conflict.reply, /没有共同接受/);
  const session = readRecordState(stateFile).sessions[0];
  assert.equal(session.status, 'collecting');
  assert.deepEqual(session.preferences, {});
  assert.equal(session.result, undefined);
  assert.equal(store.hasPending('owner'), true);
  assert.equal(store.hasPending('friend'), true);
  store.submit('owner', { preferenceText: '都可以' });
  assert.match(store.submit('friend', { preferenceText: '我选2' }), /推荐先选：2\. 选项乙/);
  const resolved = readRecordState(stateFile);
  assert.equal(resolved.sessions[0].status, 'resolved');
  assert.equal(store.submitResult('owner', { id, preferenceText: '我选1' }).wrote, false);
  assert.deepEqual(readRecordState(stateFile), resolved);
  assert.equal(notices.length, 3);
});

test('option ranking orders the intersection by combined preference and excludes vetoed choices', t => {
  const { store } = decisionFixture(t);
  const id = decisionId(store.create('owner', { title: '合成排名', options: ['甲', '乙', '丙'] }));
  store.submit('owner', { id, preferenceText: '3>2>1' });
  const result = store.submit('friend', { id, preferenceText: '2>1>3；不要3' });
  assert.match(result, /最大交集：2\. 乙；1\. 甲/);
  assert.match(result, /推荐先选：2\. 乙/);
  assert.doesNotMatch(result, /3\. 丙/);
});

for (const mode of ['options', 'constraints']) {
  test(`only the creator can cancel a collecting ${mode} decision and clear both responses`, t => {
    const { stateFile, store, notices } = decisionFixture(t);
    const id = decisionId(store.create('owner', { ...optionInput, mode }));
    store.submit('friend', { id, preferenceText: mode === 'options' ? '我选1' : '附近' });
    const before = readRecordState(stateFile);
    assert.throws(() => store.cancel('friend', id), /没有找到由你发起/);
    assert.deepEqual(readRecordState(stateFile), before);
    assert.equal(notices.length, 1);
    assert.match(store.cancel('owner', id.toLowerCase()), /已经取消/);
    const session = readRecordState(stateFile).sessions[0];
    assert.equal(session.status, 'cancelled');
    assert.deepEqual(session.preferences, {});
    assert.deepEqual(session.constraints, {});
    assert.equal(store.hasPending('owner'), false);
    assert.equal(store.list('friend'), '现在没有双人私密决策。');
    assert.throws(() => store.cancel('owner', id), /仍在进行/);
    assert.equal(notices.length, 2);
    assert.equal(notices[1][0], 'friend');
    assert.equal(notices[1][2], `pair-decision-cancelled|${id}`);
  });
}

test('decision lists exclude terminal hidden sessions before taking the last ten in reverse insertion order', t => {
  const { stateFile, store } = decisionFixture(t);
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `PD-${i}`, title: `问题${i}`, status: 'resolved', preferences: {},
    createdAt: new Date(NOW - i * 1000).toISOString(),
  }));
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: [...sessions,
    { id: 'PD-CANCELLED', status: 'cancelled' }, { id: 'PD-EXPIRED', status: 'expired' },
  ] }));
  const ids = [...store.list('owner').matchAll(/#(PD-[A-Z0-9-]+)/gu)].map(match => match[1]);
  assert.deepEqual(ids, sessions.slice(-10).reverse().map(session => session.id));
  assert.equal(readRecordState(stateFile).sessions.length, 14);
});

test('decision deletion clears the pair history and classified bodies and is idempotent', t => {
  const { directory, stateFile, store, notices } = decisionFixture(t);
  store.create('owner', optionInput);
  store.create('friend', optionInput);
  const refs = JSON.parse(fs.readFileSync(stateFile)).sessions;
  assert.deepEqual(store.deleteSide(), { removed: 2 });
  assert.deepEqual(readRecordState(stateFile).sessions, []);
  for (const ref of refs) assert.equal(fs.existsSync(path.join(directory, ref.file)), false);
  assert.deepEqual(store.deleteSide(), { removed: 0 });
  assert.equal(notices.length, 2);
});

test('decision ID collisions preserve the first session and never emit a second creation notice', t => {
  const { stateFile, store, notices } = decisionFixture(t);
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(crypto, 'randomBytes', () => Buffer.from('abcd', 'hex'));
  store.create('owner', optionInput);
  const before = readRecordState(stateFile);
  assert.throws(() => store.create('friend', { ...optionInput, title: '不应覆盖' }), /duplicate classified record identity/);
  assert.deepEqual(readRecordState(stateFile), before);
  assert.equal(notices.length, 1);
});

test('decision creation cannot notify before atomic index publication succeeds', t => {
  const { stateFile, store, notices } = decisionFixture(t);
  store.list('owner');
  const before = fs.readFileSync(stateFile, 'utf8');
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(crypto, 'randomBytes', () => Buffer.from('abcd', 'hex'));
  const rename = fs.renameSync;
  const stub = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === stateFile) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
    return rename(source, target);
  });
  assert.throws(() => store.create('owner', optionInput), /暂时无法确认完成/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.deepEqual(readRecordState(stateFile).sessions, []);
  assert.equal(notices.length, 0);
  stub.mock.restore();
  store.create('owner', optionInput);
  assert.equal(readRecordState(stateFile).sessions.length, 1);
  assert.equal(notices.length, 1);
  assert.equal(fs.existsSync(`${stateFile}.tmp-${process.pid}`), false);
});
