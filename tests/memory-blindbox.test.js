'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMemoryBlindboxCommand: parse } = require('../src/memory-blindbox-commands');
const { createMemoryBlindboxStore, selectQuestions, normalizeAnswer, ROUND_TTL_MS } = require('../src/memory-blindbox-store');
const { parsePairChallengeCommand } = require('../src/pair-challenge-commands');
const { createPairChallengeStore } = require('../src/pair-challenge-store');
const { readRecordState, writeRecordState } = require('../src/record-state');
const { readProposalPlaces } = require('../src/date-proposal-provider');

const place = { id: 'place-1', name: '测试咖啡馆', status: 'visited', updatedAt: '2026-10-12T08:00:00Z' };
function fixture(t, records = [place], random = () => 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-blindbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T00:00:00Z');
  const notices = [], stateFile = path.join(root, 'blindbox/state.json');
  const options = { stateFile, readSharedMemory: () => records, random, now: () => time,
    onNotice: (side, text, key) => notices.push({ side, text, key }), sideNames: { owner: 'Owner', friend: '好友' } };
  const game = createMemoryBlindboxStore(options);
  return { root, stateFile, notices, game, options, advance: ms => { time += ms; },
    state: () => readRecordState(stateFile), say: (text, side = 'owner') => game.handle(side, parse(text)) };
}


test('exact parsers and deterministic fact filtering without narrative inference', t => {
  assert.equal(parse('回忆盲盒', { bound: false }), null);
  for (const text of ['默契答 A', '来一轮默契挑战', '不要回忆盲盒']) assert.equal(parse(text), null);
  for (const text of ['回忆盲盒', '盲盒答：A', '结束盲盒', '盲盒战绩']) assert.equal(parsePairChallengeCommand(text), null);
  assert.deepEqual(parse('盲盒答: Ａ  B！'), { type: 'answer', answer: 'Ａ  B！' });
  const records = Object.freeze([Object.freeze(place), { ...place, status: 'active' },
    { ...place, name: '' }, { ...place, updatedAt: '' }, { text: '一起去过某处' },
    { title: '密封胶囊', status: 'sealed' }]);
  assert.equal(selectQuestions(records).length, 1);
  const f = fixture(t, records);
  const text = f.say(' 回忆盲盒 ');
  assert.match(text, /2026-10-12.*记录更新日.*去过地点/s);
  assert.ok(!text.includes(place.name));
  assert.ok(!JSON.stringify(f.notices).includes(place.name));
  assert.equal(f.state().rounds[0].question.answer, place.name);
  assert.equal(selectQuestions([place, { ...place, name: '另一家' }]).length, 0);
});

test('empty or missing answer pool terminates; invalid candidates skipped; random injectable', t => {
  for (const records of [[], [{ ...place, name: '' }], [{ ...place, updatedAt: 'bad' }]]) {
    const f = fixture(t, records);
    assert.match(f.say('回忆盲盒'), /没有可确定答案/);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(f.notices.length, 0);
  }
  const f = fixture(t, [{ ...place, name: '' }, place, { ...place, name: '另一家', updatedAt: '2026-10-13T00:00:00Z' }], () => 0.999);
  f.say('回忆盲盒');
  assert.equal(f.state().rounds[0].question.answer, '另一家');
  const invalid = fixture(t, [place], () => 1);
  assert.throws(() => invalid.say('回忆盲盒'), /随机源无效/);
});

test('first answer sealed across restart, duplicate start/stats/answer do not leak or notify', t => {
  for (const first of ['owner', 'friend']) {
    const f = fixture(t); f.say('回忆盲盒', first);
    const count = f.notices.length;
    assert.equal(f.say('盲盒答：秘密答案', first), '答案已封存，等对方作答。');
    assert.equal(f.notices.length, count);
    const restarted = createMemoryBlindboxStore(f.options);
    for (const side of ['owner', 'friend']) {
      const text = restarted.handle(side, parse('回忆盲盒'));
      assert.match(text, /不能重复开局/);
      assert.ok(!text.includes('秘密答案') && !text.includes(place.name));
      assert.equal(restarted.handle(side, parse('盲盒战绩')), '盲盒默契 0/0 次');
    }
    assert.match(f.say('盲盒答：改写', first), /不能修改/);
    assert.equal(f.notices.length, count);
    assert.equal(f.state().rounds[0].answers[first], '秘密答案');
  }
});

test('both reveal originals and normalized agreement; independent challenge stats and files', t => {
  const f = fixture(t);
  const challengeFile = path.join(f.root, 'challenge/state.json');
  const challenge = createPairChallengeStore({ stateFile: challengeFile, random: () => 0 });
  challenge.handle('owner', { type: 'start' }); challenge.handle('owner', { type: 'answer', answer: 'A' });
  const snapshot = dir => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter(file => fs.statSync(path.join(dir, file)).isFile()).map(file => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
  const before = snapshot(path.dirname(challengeFile));
  f.say('回忆盲盒'); f.say('盲盒答： Ａ B，咖啡！');
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  const body = path.join(path.dirname(f.stateFile), index.rounds[0].file);
  assert.match(f.say('盲盒答：ab咖啡', 'friend'), /双方已答完/);
  const results = f.notices.slice(-2);
  assert.deepEqual(results.map(n => n.side), ['owner', 'friend']);
  for (const notice of results) {
    assert.match(notice.text, /Owner：Ａ B，咖啡！/); assert.match(notice.text, /好友：ab咖啡/);
    assert.match(notice.text, /原始记录.*测试咖啡馆/); assert.match(notice.text, /双方答案一致/);
    assert.match(notice.text, /盲盒默契 1\/1 次/);
  }
  assert.equal(fs.existsSync(body), false);
  f.say('回忆盲盒'); f.say('盲盒答：甲'); f.say('盲盒答：乙', 'friend');
  assert.match(f.notices.at(-1).text, /不一致/);
  assert.equal(f.say('盲盒战绩'), '盲盒默契 1/2 次');
  assert.deepEqual(snapshot(path.dirname(challengeFile)), before);
  assert.equal(normalizeAnswer(' Ａ， b。'), 'ab');
});

test('expiry at 24 hours, cancel by either side, invalid answer and side', t => {
  const f = fixture(t);
  assert.throws(() => f.game.handle('stranger', { type: 'start' }), /invalid blindbox side/);
  assert.throws(() => f.game.hasPending('stranger'), /invalid blindbox side/);
  f.say('回忆盲盒');
  for (const answer of ['', '！！！', 'a'.repeat(201)]) assert.match(f.game.handle('owner', { type: 'answer', answer }), /1–200/);
  f.say('盲盒答：甲'); f.advance(ROUND_TTL_MS - 1); assert.equal(f.game.hasPending('friend'), true);
  f.advance(1); assert.equal(f.game.hasPending('owner'), false);
  assert.match(f.say('盲盒答：甲', 'friend'), /可能已过期/);
  for (const side of ['owner', 'friend']) {
    f.say('回忆盲盒'); f.say('盲盒答：甲');
    assert.match(f.say('结束盲盒', side), /未计入统计/);
    assert.equal(f.game.hasPending('owner'), false);
  }
  assert.equal(f.say('盲盒战绩'), '盲盒默契 0/0 次');
});

test('strict damaged index/schema/body quarantines and fails closed', t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t); f.say('回忆盲盒');
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.rounds[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : '{}');
    assert.throws(() => f.say('回忆盲盒'), /损坏.*隔离/);
    assert.equal(f.notices.length, 1);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(n => n.includes('.corrupt-')));
  }
});

test('production read interface leaves shared index/bodies byte-for-byte unchanged', t => {
  const f = fixture(t), sourceFile = path.join(f.root, 'shared/state.json');
  writeRecordState(sourceFile, { places: [place] }, ['places']);
  const index = fs.readFileSync(sourceFile, 'utf8');
  const body = path.join(path.dirname(sourceFile), JSON.parse(index).places[0].file);
  const original = fs.readFileSync(body, 'utf8');
  const game = createMemoryBlindboxStore({ ...f.options, readSharedMemory: () => readProposalPlaces(sourceFile) });
  game.handle('owner', parse('回忆盲盒')); game.handle('owner', parse('盲盒答：甲')); game.handle('friend', parse('盲盒答：乙'));
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), index); assert.equal(fs.readFileSync(body, 'utf8'), original);
});
