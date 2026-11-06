'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePairChallengeCommand: parse } = require('../src/pair-challenge-commands');
const { createPairChallengeStore, QUESTIONS, ROUND_TTL_MS } = require('../src/pair-challenge-store');
const { readRecordState } = require('../src/record-state');


function fixture(t, random = () => 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-challenge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  let time = Date.parse('2026-10-30T00:00:00Z');
  const notices = [];
  // Same adapter as production; notifications are captured, never dispatched.
  const friendRelayStore = {
    notifyPrivate: (text, key) => notices.push({ side: 'owner', text, key }),
    notifyFriend: (text, key) => notices.push({ side: 'friend', text, key }),
  };
  const options = { stateFile, now: () => time, random, sideNames: { owner: 'Owner', friend: '好友' },
    onNotice: (side, text, key) => side === 'owner'
      ? friendRelayStore.notifyPrivate(text, key) : friendRelayStore.notifyFriend(text, key) };
  const game = createPairChallengeStore(options);
  return { game, notices, root, stateFile, options, advance: ms => { time += ms; },
    state: () => readRecordState(stateFile),
    say: (text, side = 'owner') => game.handle(side, parse(text)) };
}



test('built-in bank and exact command parsing, including lowercase and invalid answer help', () => {
  assert.ok(QUESTIONS.length >= 10);
  for (const q of QUESTIONS) { assert.ok(q.text); assert.equal(q.options.length, 4); }
  assert.deepEqual(parse(' 默契答 b '), { type: 'answer', answer: 'B' });
  assert.deepEqual(parse('默契答 E'), { type: 'help' });
  for (const text of ['A', '他说来一轮默契挑战', '不要结束默契挑战', '']) assert.equal(parse(text), null);
});

test('either side starts: initiating reply and opposite channel receive question with no submitted answer', t => {
  for (const side of ['owner', 'friend']) {
    const f = fixture(t);
    const reply = f.say('来一轮默契挑战', side);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].side, side === 'owner' ? 'friend' : 'owner');
    assert.equal(f.notices[0].text, reply);
    for (const text of [reply, f.notices[0].text]) {
      assert.match(text, /理想的周末/);
      assert.match(text, /A\. 宅家[\s\S]*D\. 说走就走/);
      assert.match(text, /默契答 A/);
      assert.doesNotMatch(text, /Owner：|好友：|揭晓：|已选择/);
    }
    assert.deepEqual(f.state().rounds[0].answers, {});
  }
});

test('first answer stays secret, duplicate does not overwrite, repeat start gives only pending status', t => {
  const f = fixture(t);
  f.say('来一轮默契挑战');
  f.notices.length = 0;
  assert.equal(f.say('默契答 a'), '已记下，等对方作答');
  assert.equal(f.notices.length, 0);
  // No post-answer peer notification may contain the first answer letter or option.
  assert.ok(f.notices.filter(n => n.side === 'friend').every(n => !/A|宅家/u.test(n.text)));
  assert.match(f.say('默契答 B'), /已答过/);
  assert.equal(f.state().rounds[0].answers.owner, 'A');
  const before = f.state().rounds[0];
  const status = f.say('来一轮默契挑战', 'friend');
  assert.match(status, /仍在进行/);
  assert.match(status, /还没答：好友/);
  assert.doesNotMatch(status, /Owner：A|Owner.*选择.*宅家/);
  assert.deepEqual(f.state().rounds[0], before);
  assert.equal(f.notices.length, 0);
});

test('both answers reveal through both channels and count exactly once across cold reload', t => {
  const f = fixture(t);
  f.say('来一轮默契挑战', 'friend');
  f.say('默契答 c', 'friend');
  f.notices.length = 0;
  f.say('默契答 C');
  assert.deepEqual(f.notices.map(n => n.side), ['owner', 'friend']);
  assert.equal(f.notices[0].text, f.notices[1].text);
  assert.notEqual(f.notices[0].key, f.notices[1].key);
  assert.match(f.notices[0].text, /理想的周末[\s\S]*Owner：C\. 约朋友[\s\S]*好友：C\. 约朋友[\s\S]*默契一致[\s\S]*共玩 1 轮、默契 1 次/);
  assert.equal(f.state().rounds.length, 0);
  const cold = createPairChallengeStore(f.options);
  assert.equal(cold.handle('friend', parse('默契战绩')), '默契战绩：共玩 1 轮、默契 1 次。');
  assert.match(f.say('默契答 A'), /没有进行中/);
  assert.equal(f.state().played, 1);
  f.say('来一轮默契挑战');
  f.say('默契答 A');
  f.say('默契答 D', 'friend');
  assert.match(f.notices.at(-1).text, /Owner：A\. 宅家[\s\S]*好友：D\. 说走就走[\s\S]*选择不同[\s\S]*共玩 2 轮、默契 1 次/);
});

test('expiry at 24h removes classified answer body, refuses answer, allows a fresh round', t => {
  const f = fixture(t);
  f.say('来一轮默契挑战');
  f.say('默契答 B');
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  const body = path.join(f.root, index.rounds[0].file);
  assert.match(index.rounds[0].file, /^records\/rounds\/rounds\/2026\/10\//);
  assert.equal(index.rounds[0].answers, undefined);
  f.advance(ROUND_TTL_MS - 1);
  assert.equal(f.game.hasPending('friend'), true);
  f.advance(1);
  assert.match(f.say('默契答 D', 'friend'), /没有进行中/);
  assert.equal(fs.existsSync(body), false);
  assert.equal(f.game.hasPending('owner'), false);
  assert.equal(f.say('默契战绩'), '默契战绩：共玩 0 轮、默契 0 次。');
  assert.match(f.say('来一轮默契挑战'), /挑战开始/);
});

test('either side can cancel and stats query never reveals pending answers or notifies', t => {
  for (const side of ['owner', 'friend']) {
    const f = fixture(t);
    assert.match(f.say('默契战绩'), /共玩 0 轮、默契 0 次/);
    f.say('来一轮默契挑战');
    f.say('默契答 A');
    const count = f.notices.length;
    assert.equal(f.say('默契战绩', 'friend'), '默契战绩：共玩 0 轮、默契 0 次。');
    assert.equal(f.notices.length, count);
    assert.match(f.say('结束默契挑战', side), /未计入战绩/);
    assert.match(f.notices.at(-1).text, /已结束/);
    assert.match(f.say('默契答 A'), /没有进行中/);
    assert.equal(f.state().played, 0);
  }
});

test('injected random selects last question and invalid sides/commands cannot mutate', t => {
  const f = fixture(t, () => 0.999999);
  assert.match(f.say('来一轮默契挑战'), new RegExp(QUESTIONS.at(-1).text));
  assert.throws(() => f.say('默契答 A', 'outsider'), /invalid challenge side/);
  assert.throws(() => f.game.hasPending('outsider'), /invalid challenge side/);
  assert.match(f.game.handle('owner', { type: 'answer', answer: 'E' }), /A–D/);
  assert.deepEqual(f.state().rounds[0].answers, {});
});

test('strict corrupt index, invalid schema and missing body fail closed with quarantine', t => {
  for (const corrupt of ['json', 'schema', 'body']) {
    const f = fixture(t);
    f.say('来一轮默契挑战');
    if (corrupt === 'body') {
      const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      fs.rmSync(path.join(f.root, index.rounds[0].file));
    } else fs.writeFileSync(f.stateFile, corrupt === 'json' ? '{bad' : '{}');
    const count = f.notices.length;
    assert.throws(() => f.say('来一轮默契挑战'), /损坏.*隔离/);
    assert.equal(f.notices.length, count);
    assert.ok(fs.readdirSync(f.root).some(name => name.includes('.corrupt-')));
  }
});

test('paired deletion clears active answer body and accumulated game stats', t => {
  const f = fixture(t);
  f.say('来一轮默契挑战');
  f.say('默契答 A');
  f.say('默契答 A', 'friend');
  f.say('来一轮默契挑战');
  f.say('默契答 B');
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  const body = path.join(f.root, index.rounds[0].file);
  assert.deepEqual(f.game.deleteSide('friend'), { removed: 1 });
  assert.equal(fs.existsSync(body), false);
  assert.equal(f.game.hasPending('owner'), false);
  assert.equal(f.say('默契战绩'), '默契战绩：共玩 0 轮、默契 0 次。');
});
