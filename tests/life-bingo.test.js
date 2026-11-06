'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseLifeBingoCommand: parse } = require('../src/life-bingo-commands');
const { createLifeBingoStore, completedLines } = require('../src/life-bingo-store');
const { LIFE_BINGO_POOL } = require('../src/life-bingo-pool');
const { readRecordState, writeRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'life-bingo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'life-bingo/state.json');
  let time = Date.parse('2026-10-30T15:59:00Z'), draws = 0;
  const options = { stateFile, now: () => time, random: () => ((draws++ * 7) % 29) / 29 };
  const store = createLifeBingoStore(options);
  return { root, stateFile, store, options, read: () => readRecordState(stateFile),
    say: text => store.handle('owner', parse(text)), advance: ms => { time += ms; },
    restart: () => createLifeBingoStore(options), draws: () => draws };
}



test('exact full commands; friend never claims; random draw and challenge syntax remain separate', () => {
  assert.ok(LIFE_BINGO_POOL.length >= 24);
  assert.equal(new Set(LIFE_BINGO_POOL).size, LIFE_BINGO_POOL.length);
  for (const text of ['今日 Bingo', '今日Bingo', 'Bingo 战绩', 'Bingo 第 9 格完成',
    '抽一张任务卡', '换一张任务卡', '任务卡完成了', '任务卡算了']) {
    assert.ok(parse(text), text); assert.equal(parse(text, 'friend'), null);
    assert.equal(require('../src/random-draw-commands').parseRandomDrawCommand(text), null);
    assert.equal(require('../src/pair-challenge-commands').parsePairChallengeCommand(text), null);
  }
  for (const text of ['抽签', '再抽一次', '来一轮默契挑战', '默契答 A', '结束默契挑战',
    '任务卡', '完成了', '换一张', 'Bingo 第 0 格完成', 'Bingo 第 10 格完成', '他说今日 Bingo',
    '今日 Bingo 然后抽签', '记一下，今日 Bingo']) assert.equal(parse(text), null, text);
  assert.ok(require('../src/random-draw-commands').parseRandomDrawCommand('抽签：A、B'));
});

test('nine distinct persisted cells, stable same day/restart; Shanghai midnight settles old board', t => {
  const f = fixture(t);
  const first = f.say('今日 Bingo');
  assert.match(first, /2026-10-30/);
  assert.equal(first.split('\n').filter(line => line.includes(' ｜ ')).length, 3);
  assert.equal(f.draws(), 9);
  const board = f.read().boards[0];
  assert.equal(new Set(board.tasks).size, 9);
  assert.ok(board.tasks.every(task => LIFE_BINGO_POOL.includes(task)));
  assert.equal(f.restart().handle('owner', parse('今日 Bingo')), first);
  assert.equal(f.draws(), 9);
  f.advance(60000);
  assert.match(f.say('今日 Bingo'), /2026-10-30 结算：未达标.*\n今日 Bingo（2026-10-31/s);
  assert.equal(f.draws(), 18);
  assert.equal(f.read().boards[0].status, 'settled');
  assert.equal(f.read().boards[1].checked.length, 0);
  assert.equal(f.say('今日 Bingo').includes('结算'), false);
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.match(index.boards[0].file, /^records\/boards\/boards\/2026\/10\/2026-10-30.json$/);
});

test('rows, columns, both diagonals and incomplete pattern; duplicate checks count a day only once', t => {
  for (const numbers of [[1, 2, 3], [2, 5, 8], [1, 5, 9], [3, 5, 7], [1, 2, 5]]) {
    const f = fixture(t); f.say('今日 Bingo');
    let reply;
    for (const number of numbers) reply = f.say(`Bingo 第 ${number} 格完成`);
    const achieved = completedLines(numbers).length > 0;
    assert.equal(reply.includes('恭喜，今日达标'), achieved);
    assert.equal(f.read().achievedDates.length, achieved ? 1 : 0);
    assert.match(reply, achieved ? new RegExp(`已连线：${numbers.join('–')}`) : /已连线：暂无/);
    assert.match(reply, new RegExp(`✅${numbers[0]}`));
    f.say(`Bingo 第 ${numbers[2]} 格完成`);
    assert.equal(f.read().boards[0].checked.length, 3);
    assert.equal(f.read().achievedDates.length, achieved ? 1 : 0);
  }
  const f = fixture(t);
  for (let number = 1; number <= 9; number++) f.say(`Bingo 第 ${number} 格完成`);
  assert.equal(completedLines(f.read().boards[0].checked).length, 8);
  assert.equal(f.read().achievedDates.length, 1);
  const before = f.read();
  assert.match(f.store.handle('owner', { type: 'check', number: 10 }), /1–9/);
  assert.deepEqual(f.read(), before);
});

test('natural month statistics across Shanghai month boundary and missed days', t => {
  const f = fixture(t);
  const win = () => [1, 2, 3].forEach(n => f.say(`Bingo 第 ${n} 格完成`));
  win(); f.advance(60000); win();
  assert.match(f.say('Bingo 战绩'), /本月达标 2 天/);
  f.advance(86400000);
  assert.match(f.say('Bingo 战绩'), /2026-10-31 结算：已达标.*\n.*2026-11.*本月达标 0 天/s);
  win(); assert.match(f.say('Bingo 战绩'), /本月达标 1 天/);
  f.advance(3 * 86400000); f.say('今日 Bingo');
  assert.equal(f.read().boards.length, 4);
  assert.equal(f.read().achievedDates.length, 3);
});

test('independent single task card draw/replace/finish/abandon, persists across midnight and restart', t => {
  const f = fixture(t);
  assert.match(f.say('换一张任务卡'), /没有进行中/);
  assert.match(f.say('任务卡完成了'), /没有进行中/);
  f.say('抽一张任务卡'); const first = f.read().card;
  const draws = f.draws();
  assert.match(f.say('抽一张任务卡'), /已有进行中/);
  assert.equal(f.draws(), draws);
  f.say('换一张任务卡'); assert.notEqual(f.read().card, first);
  const current = f.read().card;
  f.advance(86400000);
  assert.match(f.restart().handle('owner', parse('抽一张任务卡')), new RegExp(current));
  assert.equal(f.read().boards.length, 0);
  f.say('任务卡完成了'); f.say('任务卡完成了');
  assert.equal(f.read().cardCompleted, 1); assert.equal(f.read().card, null);
  f.say('抽一张任务卡'); f.say('任务卡算了'); f.say('任务卡算了');
  assert.equal(f.read().cardCompleted, 1); assert.equal(f.read().card, null);
  assert.match(f.say('Bingo 战绩'), /本月达标 0 天；任务卡完成总数 1 张/);
  f.say('今日 Bingo'); const original = f.read().boards[0];
  f.say('抽一张任务卡'); f.say('任务卡完成了');
  assert.deepEqual(f.read().boards[0], original);
});

test('friend cannot read or write owner state; invalid randomness never saves', t => {
  const f = fixture(t);
  for (const type of ['board', 'check', 'stats', 'draw', 'replace', 'finish', 'abandon']) {
    assert.match(f.store.handle('friend', { type, number: 1 }), /仅主人/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  for (const value of [-1, 1, NaN]) assert.throws(() => createLifeBingoStore({ ...f.options, random: () => value }).handle('owner', { type: 'board' }), /随机源/);
  assert.equal(fs.existsSync(f.stateFile), false);
  f.say('今日 Bingo'); const before = f.read();
  f.store.handle('friend', { type: 'check', number: 1 }); assert.deepEqual(f.read(), before);
});

test('unsupported Bingo commands reject before storage reads, random draws or writes', t => {
  const f = fixture(t);
  for (const command of [null, {}, { type: 'unsupported' }]) {
    assert.throws(() => f.store.handle('owner', command), /不支持的 Bingo 命令/u);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(f.draws(), 0);
  f.say('今日 Bingo');
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  const body = path.join(path.dirname(f.stateFile), index.boards[0].file);
  const originalBody = fs.readFileSync(body, 'utf8');
  fs.writeFileSync(f.stateFile, '{bad');
  const draws = f.draws();
  assert.throws(() => f.restart().handle('owner', { type: 'unsupported' }), /不支持的 Bingo 命令/u);
  assert.equal(f.draws(), draws);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{bad');
  assert.equal(fs.readFileSync(body, 'utf8'), originalBody);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)).sort(), ['records', 'state.json']);
});

test('strict JSON/schema/body corruption quarantines index and preserves surviving bodies', t => {
  for (const kind of ['json', 'schema', 'body', 'missing', 'count', 'date', 'checks']) {
    const f = fixture(t); f.say('今日 Bingo');
    const index = JSON.parse(fs.readFileSync(f.stateFile));
    const bodyFile = path.join(path.dirname(f.stateFile), index.boards[0].file);
    if (kind === 'json') fs.writeFileSync(f.stateFile, '{bad');
    if (kind === 'schema') fs.writeFileSync(f.stateFile, '{}');
    if (kind === 'body') fs.writeFileSync(bodyFile, '{bad');
    if (kind === 'missing') fs.rmSync(bodyFile);
    if (['count', 'date', 'checks'].includes(kind)) {
      const state = f.read();
      if (kind === 'count') state.cardCompleted = -1;
      if (kind === 'date') state.achievedDates = ['2026-02-30'];
      if (kind === 'checks') state.boards[0].checked = [1, 1];
      writeRecordState(f.stateFile, state, ['boards']);
    }
    assert.throws(() => f.say('Bingo 战绩'), /损坏.*隔离/);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.ok(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.startsWith('state.json.corrupt-')));
    if (kind !== 'missing') assert.ok(fs.existsSync(bodyFile));
  }
});
