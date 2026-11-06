'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLearningCoachCommand: parse } = require('../src/learning-coach-commands');
const { createLearningCoachStore } = require('../src/learning-coach-store');
const { createLearningCoachProvider } = require('../src/learning-coach-provider');
const { readRecordState, writeRecordState } = require('../src/record-state');
const NOW = Date.parse('2026-10-30T00:00:00Z');
function question(i) {
  return { question: `问题${i}`, options: { A: '甲', B: '乙', C: '丙', D: '丁' }, answer: 'B', explanation: `解析证据${i}` };
}
function fixture(t, generate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-coach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'learning-coach', 'state.json');
  let clock = NOW;
  const calls = [];
  const provider = { generateQuiz: async args => {
    calls.push(args);
    return generate ? generate(args) : Array.from({ length: args.count }, (_, i) => question(i + 1));
  } };
  const store = createLearningCoachStore({ stateFile, provider, now: () => clock });
  return { root, stateFile, store, calls, read: () => readRecordState(stateFile),
    advance: ms => { clock += ms; }, run: (text, side = 'owner') => store.execute(side, parse(text)) };
}



test('commands accept counts/defaults and only single normalized letters', () => {
  assert.deepEqual(parse('考我2道数学题'), { type: 'start', count: 2, topic: '数学' });
  assert.deepEqual(parse('考我英语'), { type: 'start', count: 3, topic: '英语' });
  assert.deepEqual(parse('考我数学题'), { type: 'start', count: 3, topic: '数学' });
  for (const letter of ['a', 'A', 'ａ', 'Ａ']) assert.equal(parse(letter).answer, 'A');
  for (const text of ['答案A', 'AB', 'A。', '我选B', '随便聊聊']) assert.equal(parse(text), null);
});

test('invalid operations refuse before generation, state creation or lazy session expiry', async t => {
  const f = fixture(t);
  const commands = [null, {}, { type: 'unsupported' }];
  for (const command of commands) {
    assert.deepEqual(await f.store.execute('owner', command), {
      reply: '不支持这个碎片学习操作。', wrote: false, continue: false,
    });
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);

  await f.run('考我2道数学题');
  const before = f.read(), index = fs.readFileSync(f.stateFile, 'utf8');
  f.advance(2 * 60 * 60 * 1000 + 1);
  for (const command of commands) {
    assert.equal((await f.store.execute('owner', command)).continue, false);
    assert.deepEqual(f.read(), before);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.deepEqual(f.read().sessions, []);
});

test('reopened game survives, duplicate starts are blocked and explicit end summarizes partial work', async t => {
  const f = fixture(t);
  await f.run('考我英语');
  await f.run('B');
  const reopened = createLearningCoachStore({ stateFile: f.stateFile, now: () => NOW });
  assert.equal(reopened.claimsAnswer('owner'), true);
  for (const text of ['考我法语', '重练错题']) {
    const result = await f.run(text);
    assert.equal(result.wrote, false);
    assert.match(result.reply, /已答 1\/3.*结束练习/u);
  }
  assert.equal(f.calls.length, 1);
  assert.match((await f.run('结束练习')).reply, /对 1\/3，已答 1\/3/u);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.match((await f.run('结束练习')).reply, /没有进行中/u);
});

test('idle expiry is lazy, letters stop claiming, unrelated text does not change progress', async t => {
  const f = fixture(t);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(await f.run('A'), null);
  await f.run('考我英语');
  const before = f.read();
  assert.equal(parse('解释一下这个主题'), null);
  assert.deepEqual(f.read(), before);
  f.advance(2 * 60 * 60 * 1000);
  assert.equal(f.store.claimsAnswer('owner'), true);
  f.advance(1);
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(await f.run('B'), null);
  assert.equal(f.read().sessions.length, 0);
  await f.run('考我英语');
  f.advance(60 * 60 * 1000); await f.run('B');
  f.advance(60 * 60 * 1000 + 1);
  assert.equal(f.store.claimsAnswer('owner'), true);
});

test('invalid generated batch, missing output, exceptions and count errors never create partial sessions', async t => {
  for (const generate of [() => undefined, () => [], () => [question(1)],
    () => [question(1), { ...question(2), answer: 'E' }],
    () => [question(1), { ...question(2), explanation: '' }],
    () => [question(1), { ...question(2), options: { A: '甲' } }],
    () => { throw Error('offline'); }]) {
    const f = fixture(t, generate);
    const result = await f.run('考我2道数学题');
    assert.match(result.reply, /这次没生成成功/u);
    assert.equal(result.wrote, false);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
  const f = fixture(t);
  for (const text of ['考我0道数学题', '考我11道数学题']) assert.equal((await f.run(text)).wrote, false);
  assert.equal(f.calls.length, 0);
});

test('friend refused before reading files or invoking provider; concurrent starts serialize', async t => {
  const f = fixture(t);
  for (const text of ['考我数学', '我的错题', '重练错题', '结束练习', 'A']) {
    assert.match((await f.run(text, 'friend')).reply, /只供已绑定的本人/u);
  }
  assert.equal(f.store.claimsAnswer('friend'), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
  const results = await Promise.all([f.run('考我数学'), f.run('考我英语')]);
  assert.equal(results[0].wrote, true); assert.equal(results[1].wrote, false);
  assert.equal(f.calls.length, 1);
});

test('mistake cap evicts oldest and classified body; corrupt state fails closed', async t => {
  const f = fixture(t);
  await f.run('考我1道数学题');
  const state = f.read();
  state.mistakes = Array.from({ length: 50 }, (_, i) => ({ ...question(i), id: `old-${i}`, topic: '旧主题', errors: 1,
    createdAt: new Date(NOW - 10000 + i).toISOString() }));
  writeRecordState(f.stateFile, state, ['sessions', 'mistakes']);
  const oldFile = JSON.parse(fs.readFileSync(f.stateFile)).mistakes[0].file;
  await f.run('A');
  assert.equal(f.read().mistakes.length, 50);
  assert.equal(f.read().mistakes.some(q => q.id === 'old-0'), false);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), oldFile)), false);
  for (const damage of ['json', 'schema', 'body', 'missing']) {
    const broken = fixture(t);
    await broken.run('考我数学');
    const index = JSON.parse(fs.readFileSync(broken.stateFile));
    const body = path.join(path.dirname(broken.stateFile), index.sessions[0].file);
    if (damage === 'json') fs.writeFileSync(broken.stateFile, '{broken');
    if (damage === 'schema') fs.writeFileSync(broken.stateFile, JSON.stringify({ schemaVersion: 1, sessions: [], mistakes: 'bad' }));
    if (damage === 'body') fs.writeFileSync(body, '{}');
    if (damage === 'missing') fs.rmSync(body);
    // Letter admission is read-only on damage; execution then quarantines and reports it.
    assert.throws(() => broken.store.claimsAnswer('owner'));
    assert.equal(fs.existsSync(broken.stateFile), true);
    await assert.rejects(broken.run('考我英语'), /损坏，已隔离保全/u);
    assert.ok(fs.readdirSync(path.dirname(broken.stateFile)).some(name => name.includes('.corrupt-')));
  }
});

test('production provider uses fresh schema-constrained shared model call and fails closed', async () => {
  let args;
  const provider = createLearningCoachProvider({ model: async (...input) => {
    args = input; return { ok: true, value: { questions: [question(1)] } };
  } });
  assert.deepEqual(await provider.generateQuiz({ topic: '数学', count: 1 }), [question(1)]);
  assert.equal(args[1], ''); assert.deepEqual(args[2], []);
  assert.equal(args[3].stage, 'learning_coach_generate');
  assert.equal(args[3].parse, JSON.parse);
  assert.equal(args[3].schema.additionalProperties, false);
  await assert.rejects(createLearningCoachProvider({ model: async () => ({ ok: false }) }).generateQuiz({ topic: '数学', count: 1 }));
});
