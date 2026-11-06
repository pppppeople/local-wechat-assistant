'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTextAdventureCommand: parse, REFUSAL } = require('../src/text-adventure-commands');
const { createTextAdventureStore, advance } = require('../src/text-adventure-store');
const { createTextAdventureProvider } = require('../src/text-adventure-provider');
const output = data => ({ narrative: data.terminal ? '探险落幕。' : '前方出现一座城堡。', summary: '探险者来到城堡门前。',
  options: data.terminal ? [] : ['搜寻密道', '观察门锁', '在门边休息'] });
function fixture(generate = output, readCard = async () => ({ continue: false, reply: '角色卡不存在' })) {
  const calls = [];
  const store = createTextAdventureStore({ readCard, provider: { generate: async data => {
    calls.push(structuredClone(data)); return generate(data, calls.length);
  } } });
  return { store, calls, run: text => store.execute('owner', parse(text, store.claimsAnswer('owner'))) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));



test('friend execution refuses before card/model/session access, owner session survives', async () => {
  let cards = 0;
  const f = fixture(output, () => { cards++; throw Error('must not read'); });
  await f.run('开始冒险');
  for (const command of [{ type: 'start', cardName: '秘密' }, { type: 'end' }, { type: 'choose', choice: 1 }, null]) {
    assert.equal((await f.store.execute('friend', command)).reply, REFUSAL);
  }
  assert.equal(cards, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.store.claimsAnswer('friend'), false); assert.equal(f.store.claimsAnswer('owner'), true);
});

test('invalid owner command types and out-of-range choices refuse without creating or changing a session', async () => {
  const f = fixture();
  const commands = [{ type: 'invalid' }, { type: 'choose', choice: 0 }, { type: 'choose', choice: 4 }];
  const reply = '请用“开始冒险：角色卡名”（卡名可省略）、“冒险选择 1/2/3”或“结束冒险”。';
  for (const command of commands) {
    const result = await f.store.execute('owner', command);
    assert.equal(result.reply, reply); assert.equal(result.wrote, false);
    assert.equal(f.store.claimsAnswer('owner'), false); assert.equal(f.calls.length, 0);
  }
  await f.run('开始冒险');
  const current = { ...f.calls[0], summary: output({}).summary, options: output({}).options };
  for (const command of commands) {
    const result = await f.store.execute('owner', command);
    assert.equal(result.reply, reply); assert.equal(result.wrote, false);
    assert.equal(f.store.claimsAnswer('owner'), true); assert.equal(f.calls.length, 1);
  }
  await f.run('2');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], advance(current, 2));
});

test('local numeric rules, clamping, terminal precedence and bounded history', () => {
  const state = { hp: 3, clues: 0, rounds: 0, history: [], options: ['a', 'b', 'c'] };
  assert.deepEqual([advance(state, 1).hp, advance(state, 1).clues], [2, 2]);
  assert.deepEqual([advance(state, 2).hp, advance(state, 2).clues], [3, 1]);
  assert.deepEqual([advance(state, 3).hp, advance(state, 3).clues], [3, 0]);
  assert.equal(advance({ ...state, hp: 1 }, 3).hp, 2);
  assert.match(advance({ ...state, hp: 1, clues: 4 }, 1).terminal, /失败/);
  assert.match(advance({ ...state, clues: 5 }, 2).terminal, /成功/);
  assert.equal(advance({ ...state, history: Array(6).fill({}) }, 2).history.length, 6);
  assert.equal(state.rounds, 0);
});

test('opening displays exactly three labelled options and numeric actions reach six-round forced end', async () => {
  const f = fixture();
  const reply = (await f.run('开始冒险')).reply;
  for (const n of [1, 2, 3]) assert.match(reply, new RegExp(`\\n${n}\\. `));
  assert.match(reply, /已行动 0\/6 轮.*生命 3\/3.*线索 0/);
  for (let i = 1; i <= 6; i++) {
    const result = await f.run('3');
    assert.equal(f.calls[i].rounds, i); assert.equal(f.calls[i].history.length, i);
    assert.equal(f.calls[i].hp, 3); assert.equal(f.calls[i].clues, 0);
    if (i === 6) assert.match(result.reply, /六轮上限.*已清除/);
  }
  assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(parse('3', f.store.claimsAnswer('owner')), null);
  assert.match((await f.run('冒险选择 3')).reply, /没有进行中/);
  assert.equal(f.calls.length, 7);
});

test('early death and six-clue success clear state', async () => {
  for (const [choice, count, ending] of [['1', 3, /失败/], ['2', 6, /成功/]]) {
    const f = fixture(); await f.run('开始冒险');
    for (let n = 0; n < count; n++) {
      const result = await f.run(choice);
      if (n === count - 1) assert.match(result.reply, ending);
    }
    assert.equal(f.store.claimsAnswer('owner'), false);
  }
});

test('duplicate starts refused including queued start; end and new store discard state', async () => {
  const f = fixture();
  const start = f.run('开始冒险');
  assert.match((await f.run('开始冒险：另一张卡')).reply, /先发送“结束冒险”/);
  await start;
  assert.match((await f.run('开始冒险')).reply, /不会覆盖/);
  assert.equal(f.calls.length, 1);
  assert.equal(fixture().store.claimsAnswer('owner'), false);
  await f.run('结束冒险');
  assert.equal(f.store.claimsAnswer('owner'), false);
  await f.run('开始冒险'); assert.equal(f.calls.at(-1).rounds, 0);
});

test('missing or broken cards explicitly refuse without model or session', async () => {
  for (const read of [() => ({ continue: false, reply: '不存在名为「阿雪」的角色卡' }), () => { throw Error('broken'); }]) {
    const f = fixture(output, read);
    assert.match((await f.run('开始冒险：阿雪')).reply, /不存在|读取失败/);
    assert.equal(f.calls.length, 0); assert.equal(f.store.claimsAnswer('owner'), false);
  }
});

test('real character card read snapshot does not change any card file or start story', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-adventure-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createCharacterCardStore } = require('../src/character-card-store');
  const cards = createCharacterCardStore({ stateFile: path.join(dir, 'state.json'), storyChain: { execute: () => { throw Error('story must not start'); } } });
  cards.execute('owner', { type: 'add', name: '阿雪', description: '会说粤语的企鹅' });
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter(p => fs.statSync(path.join(dir, p)).isFile()).map(p => [p, fs.readFileSync(path.join(dir, p), 'utf8')]));
  const before = snapshot();
  const f = fixture(output, name => cards.execute('owner', { type: 'view', name }));
  await f.run('开始冒险：阿雪'); await f.run('2'); await f.run('结束冒险');
  assert.match(f.calls[0].setting, /阿雪.*\n.*会说粤语的企鹅/);
  assert.deepEqual(snapshot(), before);
});

test('opening failures preserve setting and retry without consuming action', async () => {
  const f = fixture((data, n) => { if (n === 1) throw Error('offline'); return output(data); });
  assert.match((await f.run('开始冒险')).reply, /开场模型生成失败.*保留/);
  assert.equal(f.store.claimsAnswer('owner'), true);
  await f.run('冒险继续');
  assert.deepEqual(f.calls[1], f.calls[0]);
});

test('failed or malformed continuation has no partial result or numeric changes; retry same input', async () => {
  for (const invalid of [null, {}, { ...output({}), hp: 99 }, { ...output({}), options: ['a', 'b'] }, 'throw']) {
    const f = fixture((data, n) => { if (n === 2) { if (invalid === 'throw') throw Error('offline'); return invalid; } return output(data); });
    await f.run('开始冒险');
    const failure = await f.run('1');
    assert.match(failure.reply, /模型生成失败.*保留/); assert.doesNotMatch(failure.reply, /城堡/);
    assert.equal(f.store.claimsAnswer('owner'), true);
    await f.run('1'); assert.deepEqual(f.calls[2], f.calls[1]);
    assert.equal(f.calls[2].hp, 2); assert.equal(f.calls[2].rounds, 1);
  }
});

test('terminal model failure reports local ending and clears state', async () => {
  const f = fixture(data => { if (data.terminal) throw Error('offline'); return output(data); });
  await f.run('开始冒险');
  for (let i = 0; i < 5; i++) await f.run('3');
  assert.match((await f.run('3')).reply, /结局模型生成失败.*已行动 6\/6.*六轮上限.*已清除/);
  assert.equal(f.store.claimsAnswer('owner'), false);
});

test('end during generation discards late output and queued actions', async () => {
  let finish;
  const f = fixture((data, n) => n === 1 ? output(data) : new Promise(resolve => { finish = () => resolve(output(data)); }));
  await f.run('开始冒险');
  const inflight = f.run('2'); await tick();
  const queued = f.run('2');
  await f.run('结束冒险'); finish();
  assert.equal(await inflight, null); assert.equal(await queued, null);
  assert.equal(f.store.claimsAnswer('owner'), false); assert.equal(f.calls.length, 2);
});

test('end during card read cannot resurrect session', async () => {
  let finish;
  const f = fixture(output, () => new Promise(resolve => { finish = resolve; }));
  const start = f.run('开始冒险：阿雪'); await tick();
  await f.run('结束冒险'); finish({ continue: true, reply: '阿雪' });
  assert.equal(await start, null); assert.equal(f.store.claimsAnswer('owner'), false);
  assert.equal(f.calls.length, 0);
});

test('provider uses isolated structured model; rejects bad result and has no numeric output fields', async () => {
  const calls = [];
  const provider = createTextAdventureProvider({ model: async (...args) => { calls.push(args); return { ok: true, value: output({}) }; } });
  await provider.generate({ setting: '雪城', terminal: '' });
  const [prompt, session, images, options] = calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []);
  assert.match(prompt, /不读取历史、文件/); assert.match(prompt, /不得更改/);
  assert.deepEqual(Object.keys(options.schema.properties).sort(), ['narrative', 'options', 'summary']);
  assert.deepEqual(options.parse(JSON.stringify(output({}))), output({}));
  assert.throws(() => options.parse('{}'));
  for (const result of [{ ok: false }, { ok: true, value: { hp: 99 } }]) {
    await assert.rejects(createTextAdventureProvider({ model: async () => result }).generate({}));
  }
});
