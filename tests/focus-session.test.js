'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseFocusSessionCommand: parse } = require('../src/focus-session-commands');
const { createFocusSessionStore } = require('../src/focus-session-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'focus-session', 'state.json');
  let time = Date.parse('2026-10-31T01:00:00Z');
  const options = { stateFile, now: () => time };
  const sent = [];
  const deliver = async (text, id) => sent.push({ text, id });
  const store = createFocusSessionStore(options);
  return { root, stateFile, options, store, sent, deliver,
    read: () => readRecordState(stateFile),
    advance: ms => { time += ms; },
    say: text => store.handle('owner', parse(text)),
    restart: () => createFocusSessionStore(options) };
}



test('exact commands parse Arabic / Chinese minutes and hours with optional goal', () => {
  for (const [text, minutes, goal] of [
    ['专心工作 45 分钟', 45, ''], ['专注 1 小时，结束提醒我继续处理 专业系统 工单', 60, '继续处理 专业系统 工单'],
    ['专注四十五分钟', 45, ''], ['专注十分钟', 10, ''], ['专注两小时,结束提醒我喝水', 120, '喝水'],
    ['专注二十分钟', 20, ''], ['专注一小时', 60, ''], ['专注〇五分钟', 5, ''],
  ]) assert.deepEqual(parse(text), { type: 'start', durationMs: minutes * 60000, goal }, text);
  assert.deepEqual(parse('专注状态'), { type: 'status' });
  assert.deepEqual(parse('结束专注'), { type: 'cancel' });
  for (const text of ['专注', '专注 0 分钟', '专注半小时', '专注 1.5 小时', '专注一会儿',
    '专心工作 -5 分钟', '专注十十分钟', '专注 1 天', '专注 1 小时，结束提醒我', '专注 2 小时，然后发消息']) {
    assert.deepEqual(parse(text), { type: 'invalid' }, text);
  }
  for (const text of ['我要提高专注力', '他说“专注 45 分钟”', '结束默契挑战', '专注状态是什么',
    '记一下，专注 45 分钟', '执行：专注 45 分钟', '提醒我专注工作', '专注力训练']) assert.equal(parse(text), null, text);
});

test('create persists classified record, confirms Shanghai time, refuses duplicate without overwrite', t => {
  const f = fixture(t);
  assert.match(f.say('专注状态'), /没有进行中/);
  assert.match(f.say('专心工作 45 分钟'), /09:45.*Asia\/Shanghai/);
  const original = f.read().sessions[0];
  assert.equal(original.startedAt, '2026-10-31T01:00:00.000Z');
  assert.equal(original.endsAt, '2026-10-31T01:45:00.000Z');
  assert.equal(original.goal, ''); assert.equal(original.reminded, false);
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match(index.sessions[0].file, /^records\/sessions\/sessions\/2026\/10\//);
  assert.ok(fs.existsSync(path.join(path.dirname(f.stateFile), index.sessions[0].file)));
  f.advance(60000);
  assert.match(f.say('专注状态'), /剩余 44 分钟/);
  assert.match(f.say('专注 1 小时，结束提醒我另一个目标'), /不能重复开始.*44 分钟/);
  assert.deepEqual(f.read().sessions[0], original);
});

test('due scan delivers once with goal, persisted BEFORE delivery; repeated and overlapping ticks never replay', async t => {
  const f = fixture(t);
  f.say('专注 1 小时，结束提醒我继续处理 专业系统 工单');
  f.advance(3600000 - 1);
  assert.equal(await f.store.tick(f.deliver), false);
  assert.equal(f.sent.length, 0);
  f.advance(1);
  await Promise.all([f.store.tick(async (...args) => {
    assert.equal(f.read().sessions[0].reminded, true);
    await f.deliver(...args);
  }), f.store.tick(f.deliver)]);
  await f.store.tick(f.deliver);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /专注已结束.*继续处理 专业系统 工单/);
  assert.match(f.sent[0].id, /^focus-session-/);
  assert.match(f.say('专注状态'), /没有进行中/);
  assert.match(f.say('专注十分钟'), /已开始专注/);
});

test('cancel suppresses pending reminder permanently including after restart', async t => {
  const f = fixture(t);
  f.say('专注 45 分钟');
  f.advance(60000);
  assert.match(f.say('结束专注'), /已结束专注.*取消待发/);
  f.advance(3600000);
  await f.store.tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 0);
  assert.equal(f.read().sessions[0].status, 'cancelled');
  assert.match(f.say('结束专注'), /没有进行中/);
});

test('restart before deadline waits; overdue unreminded session recovers exactly once', async t => {
  const f = fixture(t);
  f.say('专注 45 分钟');
  f.advance(30000);
  const cold = f.restart();
  assert.match(cold.handle('owner', parse('专注状态')), /45 分钟/);
  await cold.tick(f.deliver);
  assert.equal(f.sent.length, 0);
  f.advance(45 * 60000);
  assert.match(cold.handle('owner', parse('专注状态')), /已到期.*待发送/);
  assert.match(cold.handle('owner', parse('专注 1 小时')), /不能重复开始.*0 分钟/);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1);
});

test('overdue pending reminder can be cancelled; failed dispatch is never replayed', async t => {
  const f = fixture(t);
  f.say('专注 1 分钟'); f.advance(60000);
  f.say('结束专注'); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 0);
  f.say('专注 1 分钟'); f.advance(60000);
  let attempts = 0;
  await assert.rejects(f.store.tick(async () => { attempts++; throw new Error('mock transport failure'); }), /mock/);
  await f.restart().tick(f.deliver);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 0);
});

test('invalid duration refuses without state; friend cannot read, mutate or create owner state', t => {
  const f = fixture(t);
  assert.match(f.say('专注半小时'), /没有开始专注/);
  for (const text of ['专注 1 小时', '专注状态', '结束专注']) assert.match(f.store.handle('friend', parse(text)), /仅主人/);
  assert.equal(fs.existsSync(f.stateFile), false);
  f.say('专注 1 小时');
  const before = f.read();
  f.store.handle('friend', parse('结束专注'));
  assert.deepEqual(f.read(), before);
});

test('direct starts reject invalid durations, date overflow and non-string goals without persistence', t => {
  const f = fixture(t);
  const invalid = [
    ...[0, -60000, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].map(durationMs =>
      ({ type: 'start', durationMs, goal: '' })),
    { type: 'start', durationMs: 60000, goal: null },
  ];
  for (const command of invalid) {
    assert.match(f.store.handle('owner', command), /没有开始专注：时长或目标格式无效/);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
  assert.match(f.say('专注状态'), /没有进行中的专注/);
  assert.match(f.say('专注 1 分钟'), /已开始专注/);
  assert.equal(f.read().sessions.length, 1);
  assert.equal(Date.parse(f.read().sessions[0].endsAt) - Date.parse(f.read().sessions[0].startedAt), 60000);
});

test('invalid top-level focus state is quarantined with its original contents and bodies preserved', t => {
  for (const fields of [{ schemaVersion: 2 }, { sessions: {} }, { duplicate: true }]) {
    const f = fixture(t);
    f.say('专注 1 分钟');
    const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    const body = path.join(path.dirname(f.stateFile), index.sessions[0].file);
    const originalBody = fs.readFileSync(body, 'utf8');
    const state = f.read();
    if (fields.duplicate) state.sessions.push({ ...state.sessions[0] });
    else Object.assign(state, fields);
    const damagedIndex = JSON.stringify(state);
    fs.writeFileSync(f.stateFile, damagedIndex);

    assert.throws(() => f.restart().handle('owner', { type: 'status' }), error => {
      assert.match(error.message, /损坏.*隔离保全/u);
      assert.equal(error.cause.message, '专注存储格式无效');
      return true;
    });
    assert.equal(fs.existsSync(f.stateFile), false);
    const quarantined = fs.readdirSync(path.dirname(f.stateFile)).filter(name => name.startsWith('state.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), quarantined[0]), 'utf8'), damagedIndex);
    assert.equal(fs.readFileSync(body, 'utf8'), originalBody);
  }
});

test('strict corruption quarantines malformed index, invalid schema and missing body; scan never dispatches', async t => {
  for (const kind of ['json', 'schema', 'body']) {
    const f = fixture(t);
    f.say('专注 1 分钟');
    if (kind === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      fs.rmSync(path.join(path.dirname(f.stateFile), index.sessions[0].file));
    } else fs.writeFileSync(f.stateFile, kind === 'json' ? '{bad' : JSON.stringify({ schemaVersion: 1, sessions: [{}] }));
    f.advance(60000);
    await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.startsWith('state.json.corrupt-')));
  }
});
