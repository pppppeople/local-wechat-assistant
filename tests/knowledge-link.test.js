'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKnowledgeLinkCommand: parse } = require('../src/knowledge-link-commands');
const { createKnowledgeLink } = require('../src/knowledge-link');
const { createKnowledgeLinkProvider } = require('../src/knowledge-link-provider');
const { createKnowledgeNotebookStore } = require('../src/knowledge-notebook-store');
const { writeRecordState } = require('../src/record-state');

function fixture(t, count = 2, model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-knowledge-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'notebook', 'state.json');
  const entries = Array.from({ length: count }, (_, i) => ({ id: `card-${i}`, title: `卡${i}`,
    content: `原文${i}：先核对再操作。`, tags: i % 2 ? ['限定'] : ['其他'], createdAt: '2026-11-01T00:00:00Z' }));
  if (count) writeRecordState(stateFile, { schemaVersion: 1, entries }, ['entries']);
  const notebook = createKnowledgeNotebookStore({ stateFile });
  const inputs = [];
  const provider = createKnowledgeLinkProvider({ model: async (...args) => {
    inputs.push(args);
    if (model) return model(...args);
    const cards = JSON.parse(args[0].split('\n').at(-1));
    return { ok: true, value: { connected: true, quotes: cards.map(card => card.content),
      explanation: `两条均写明先核对再操作：“${cards[0].content}”；“${cards[1].content}”。` } };
  } });
  let values = [0, 0];
  const link = createKnowledgeLink({ notebook, provider, random: () => values.shift() ?? 0 });
  return { dir, stateFile, entries, inputs, link, provider,
    random: sequence => { values = [...sequence]; }, run: text => link.execute('owner', parse(text || '串联知识')) };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}



test('only owner admitted before any read/random/model dependency', async () => {
  const fail = () => assert.fail('unauthorized dependency');
  const link = createKnowledgeLink({ notebook: { readEntries: fail }, provider: { generate: fail }, random: fail });
  for (const side of ['friend', '', undefined, 'synthetic-stranger']) {
    const result = await link.execute(side, { type: 'link' });
    assert.match(result.reply, /只供已绑定的本人/u); assert.equal(result.wrote, false);
  }
});

test('every one of 300 entries can be selected, without replacement and without list/search caps or writes', async t => {
  const f = fixture(t, 300), before = snapshot(f.dir);
  for (let i = 0; i < 300; i++) {
    f.random([(i + 0.1) / 300, 0.999999]);
    const result = await f.run();
    const cards = JSON.parse(f.inputs.at(-1)[0].split('\n').at(-1));
    assert.equal(cards[0].title, `卡${i}`);
    assert.notEqual(cards[0].title, cards[1].title);
    assert.equal(result.wrote, false);
    assert.match(result.reply, /抽取范围：全部知识条目/u);
  }
  assert.deepEqual(snapshot(f.dir), before);
});

test('explicit exact case-insensitive tag restricts the entire pool and shows its scope', async t => {
  const f = fixture(t, 30);
  f.random([0.999999, 0.999999]);
  const result = await f.run('串联知识：限定');
  const cards = JSON.parse(f.inputs[0][0].split('\n').at(-1));
  assert.deepEqual(cards.map(card => card.title), ['卡29', '卡27']);
  assert.match(result.reply, /范围：标签「限定」/u);
  assert.match((await f.run('串联知识：定')).reply, /该标签下无知识条目/u);
  const link = createKnowledgeLink({ notebook: { readEntries: () => [
    { title: 'A', content: 'A', tags: ['tAg'] }, { title: 'B', content: 'B', tags: ['TAG'] },
  ] }, provider: { generate: async cards => { assert.equal(cards.length, 2); return 'test'; } }, random: () => 0 });
  assert.match((await link.execute('owner', parse('串联知识：tag'))).reply, /标签「tag」/u);
});

test('zero and one candidate never call model; show explicit fallback and original, leave storage unchanged', async t => {
  for (const count of [0, 1, 2]) {
    const f = fixture(t, count), before = snapshot(f.dir);
    const result = await f.run(count === 2 ? '串联知识：限定' : '串联知识');
    assert.match(result.reply, count === 0 ? /知识本为空，请先添加知识条目/u : /仅有 1 条，无法串联/u);
    if (count) assert.match(result.reply, /原文\d：先核对再操作/u);
    assert.equal(f.inputs.length, 0); assert.equal(result.wrote, false);
    assert.deepEqual(snapshot(f.dir), before);
  }
});

test('no direct connection uses fixed wording and separately shows both originals', async t => {
  const f = fixture(t, 2, async () => ({ ok: true, value: {
    connected: false, quotes: ['原文0', '原文1'], explanation: '',
  } }));
  const result = await f.run();
  assert.match(result.reply, /这两条暂未看出直接联系/u);
  for (const row of f.entries) assert.ok(result.reply.includes(row.content));
  assert.doesNotMatch(result.reply, /串联说明/u);
});

test('corrupt notebook fails without writes/quarantine or model call', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.stateFile, '{broken');
  const before = snapshot(f.dir);
  assert.match((await f.run()).reply, /无法读取知识本.*未生成串联/u);
  assert.equal(f.inputs.length, 0); assert.deepEqual(snapshot(f.dir), before);
});
