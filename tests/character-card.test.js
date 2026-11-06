'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCharacterCardCommand: parse } = require('../src/character-card-commands');
const { createCharacterCardStore } = require('../src/character-card-store');
const { createStoryChainStore } = require('../src/story-chain-store');

const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-character-card-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'character-cards', 'state.json');
  const calls = [];
  const storyChain = createStoryChainStore({ provider: { generate: async data => {
    calls.push(structuredClone(data));
    return { sentences: ['雪落在城堡。', '阿雪打开门。', '里面有一封信。'], characters: '阿雪', events: '发现信件' };
  } } });
  const store = createCharacterCardStore({ stateFile, storyChain, now: () => Date.parse('2026-11-01T00:00:00Z') });
  return { dir, stateFile, store, storyChain, calls, run: text => store.execute('owner', parse(text)),
    read: () => readRecordState(stateFile).cards };
}



test('README command forms, both colons/separators and multiline description parse deterministically', () => {
  for (const colon of ['：', ':']) for (const bar of ['｜', '|']) {
    assert.deepEqual(parse(`新建角色卡${colon} 阿雪 ${bar} 冰城企鹅\n喜欢冒险 `),
      { type: 'add', name: '阿雪', description: '冰城企鹅\n喜欢冒险' });
    assert.deepEqual(parse(`修改角色卡${colon}阿雪${bar}小雪${bar}新设定`),
      { type: 'update', name: '阿雪', newName: '小雪', description: '新设定' });
    assert.deepEqual(parse(`查看角色卡${colon}阿雪`), { type: 'view', name: '阿雪' });
    assert.deepEqual(parse(`删除角色卡${colon}阿雪`), { type: 'delete', name: '阿雪' });
  }
  assert.deepEqual(parse('角色卡列表'), { type: 'list' });
  assert.deepEqual(parse('用角色卡阿雪开始故事'), { type: 'start', name: '阿雪' });
  for (const text of ['新建角色卡', '新建角色卡：A', '新建角色卡：|描述', '新建角色卡：A|B|C',
    '修改角色卡：A|B', '修改角色卡：A||B', '查看角色卡：', '删除角色卡：', '用角色卡开始故事', '角色卡列表其他']) {
    assert.equal(parse(text).type, 'invalid', text);
  }
  for (const text of ['普通聊天', '开始故事', '开始故事：原设定', '看看故事', '结束故事']) assert.equal(parse(text), null);
});

test('all non-owner operations refuse before reading corrupt state or calling story model', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, '{broken');
  for (const side of ['friend', '', undefined]) for (const text of ['新建角色卡：A|B', '查看角色卡：A',
    '角色卡列表', '修改角色卡：A|B|C', '删除角色卡：A', '用角色卡A开始故事']) {
    const result = f.store.execute(side, parse(text));
    assert.equal(result.wrote, false); assert.match(result.reply, /只供已绑定的本人/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken');
});

test('create, view, list, restart persistence and duplicate refusal preserve original classified body', t => {
  const f = fixture(t);
  assert.match(f.run('角色卡列表').reply, /共 0 张.*\n暂无角色卡/s);
  assert.equal(f.run('新建角色卡：阿雪｜冰城企鹅\n喜欢冒险').wrote, true);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('新建角色卡: 阿雪 | 覆盖').reply, /同名.*不会覆盖/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.match(f.run('查看角色卡：阿雪').reply, /角色卡：阿雪\n设定描述：冰城企鹅\n喜欢冒险/);
  assert.match(f.run('角色卡列表').reply, /共 1 张.*\n阿雪/s);
  const ref = JSON.parse(before).cards[0];
  assert.equal(ref.description, undefined);
  assert.match(ref.file, /^records\/cards\/cards\/2026\/11\//u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.stateFile), ref.file))).description, '冰城企鹅\n喜欢冒险');
  const reopened = createCharacterCardStore({ stateFile: f.stateFile });
  assert.equal(reopened.execute('owner', parse('查看角色卡：阿雪')).reply, f.run('查看角色卡：阿雪').reply);
  assert.equal(f.calls.length, 0);
});

test('twenty-card limit refuses without deleting or overwriting existing cards', t => {
  const f = fixture(t);
  for (let n = 0; n < 20; n++) assert.equal(f.run(`新建角色卡：角色${n}|设定${n}`).wrote, true);
  const before = f.read();
  assert.match(f.run('新建角色卡：第21张|设定').reply, /20 张上限/);
  assert.deepEqual(f.read(), before);
  assert.match(f.run('角色卡列表').reply, /角色0\n.*角色19/s);
  assert.match(f.run('新建角色卡：角色0|覆盖').reply, /同名/);
  assert.equal(f.calls.length, 0);
});

test('update supports rename and description, rejects collisions; delete removes body and frees capacity', t => {
  const f = fixture(t);
  f.run('新建角色卡：A|旧设定'); f.run('新建角色卡：B|另一张');
  const before = f.read();
  assert.match(f.run('修改角色卡：A|B|覆盖').reply, /同名/);
  assert.deepEqual(f.read(), before);
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).cards[0];
  assert.equal(f.run('修改角色卡：A|C|新设定').wrote, true);
  assert.match(f.run('查看角色卡：C').reply, /新设定/);
  assert.match(f.run('查看角色卡：A').reply, /不存在/);
  f.run('修改角色卡：C|C|只改描述');
  assert.equal(f.read()[0].description, '只改描述');
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).cards[0].file, ref.file);
  assert.equal(f.run('删除角色卡：C').wrote, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), ref.file)), false);
  for (const text of ['查看角色卡：C', '删除角色卡：C', '修改角色卡：C|D|设定']) assert.match(f.run(text).reply, /不存在/);
  for (let n = 0; n < 19; n++) f.run(`新建角色卡：角色${n}|设定`);
  assert.equal(f.read().length, 20);
  f.run('删除角色卡：B');
  assert.equal(f.run('新建角色卡：新卡|设定').wrote, true);
  assert.equal(f.calls.length, 0);
});

test('invalid commands and corrupt state fail explicitly without inventing cards', t => {
  const f = fixture(t);
  for (const command of [null, { type: 'invalid' }, { type: 'add', name: 'A', description: '' },
    { type: 'update', name: 'A', newName: '', description: 'B' }]) {
    assert.equal(f.store.execute('owner', command).wrote, false);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, '{broken');
  assert.throws(() => f.run('用角色卡A开始故事'));
  assert.equal(f.calls.length, 0);
});
