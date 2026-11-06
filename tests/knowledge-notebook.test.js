'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKnowledgeNotebookCommand: parse } = require('../src/knowledge-notebook-commands');
const { createKnowledgeNotebookStore } = require('../src/knowledge-notebook-store');
const { readRecordState, writeRecordState } = require('../src/record-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-knowledge-notebook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'knowledge-notebook', 'state.json');
  let clock = Date.parse('2026-10-30T16:00:00Z');
  const store = createKnowledgeNotebookStore({ stateFile, now: () => clock });
  return { dir, stateFile, store, setTime: value => { clock = Date.parse(value); },
    run: text => store.execute('owner', parse(text)), read: () => readRecordState(stateFile) };
}



test('explicit commands parse both separators, optional deduplicated tags and multiline original', () => {
  assert.deepEqual(parse('记知识： 标题 ｜ 第一行\n第二行 ｜ 标签、运维,标签，步骤 '),
    { type: 'add', title: '标题', content: '第一行\n第二行', tags: ['标签', '运维', '步骤'] });
  assert.deepEqual(parse('记知识:Title|Content'), { type: 'add', title: 'Title', content: 'Content', tags: [] });
  assert.deepEqual(parse('改知识：Title｜New\nContent'), { type: 'update', title: 'Title', content: 'New\nContent' });
  for (const text of ['记知识：标题', '记知识：｜内容', '记知识：标题｜ ', '记知识：标题|内容|标签|多余', '查知识：', '删知识：', '改知识：标题|新内容|标签', '查知识']) {
    assert.equal(parse(text).type, 'invalid');
  }
  assert.equal(parse('帮我整理知识'), null);
});

test('friend and all non-owner sides refuse before reading or writing private state', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, '{broken');
  for (const side of ['friend', '', undefined]) {
    for (const text of ['记知识：秘密|原文', '查知识：秘密', '知识列表', '删知识：秘密', '改知识：秘密|新原文']) {
      const result = f.store.execute(side, parse(text));
      assert.equal(result.wrote, false); assert.match(result.reply, /只供已绑定的本人/u);
      assert.doesNotMatch(result.reply, /秘密|原文/u);
    }
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken');
});

test('add persists classified originals and dates; duplicate title refuses without overwriting', t => {
  const f = fixture(t);
  assert.equal(f.run('记知识：重启|先检查日志\n再重启|运维、操作').wrote, true);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('记知识：重启|覆盖').reply, /已存在同名条目.*请先改名或删旧/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  const row = f.read().entries[0];
  assert.equal(row.content, '先检查日志\n再重启'); assert.deepEqual(row.tags, ['运维', '操作']);
  assert.equal(row.updatedAt, undefined);
  const ref = JSON.parse(before).entries[0];
  assert.equal(ref.content, undefined); assert.match(ref.file, /^records\/entries\/entries\/2026\/10\//u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.stateFile), ref.file))).content, row.content);
  const reopened = createKnowledgeNotebookStore({ stateFile: f.stateFile });
  assert.equal(reopened.handle('owner', parse('查知识：日志')), '重启\n先检查日志\n再重启\n记录日期：2026-10-31');
  f.run('记知识：无标签|原文'); assert.deepEqual(f.read().entries[1].tags, []);
});

test('search matches title/tags/content case-insensitively, title first, latest next, at most five', t => {
  const f = fixture(t);
  f.run('记知识：TOPIC 标题|标题命中');
  f.setTime('2026-11-01T00:00:00Z'); f.run('记知识：标签命中|标签正文|topic');
  for (let i = 0; i < 6; i++) {
    f.setTime(`2026-11-0${i + 2}T00:00:00Z`); f.run(`记知识：内容${i}|正文含 TOPIC ${i}`);
  }
  const reply = f.run('查知识：tOpIc').reply;
  const blocks = reply.split('\n\n');
  assert.equal(blocks.length, 5); assert.match(blocks[0], /^TOPIC 标题\n标题命中/u);
  assert.match(blocks[1], /^内容5\n正文含 TOPIC 5/u); assert.match(blocks[4], /^内容2\n正文含 TOPIC 2/u);
  assert.match(f.run('查知识：标签正文').reply, /^标签命中/u);
  f.run('记知识：独立|标签唯一正文|ONLY-TAG');
  assert.match(f.run('查知识：only-tag').reply, /^独立\n标签唯一正文/u);
});

test('no match explicitly returns unknown and never writes or manufactures an answer', t => {
  const f = fixture(t);
  assert.equal(f.run('查知识：未知问题').reply, '没有找到相关知识');
  assert.equal(fs.existsSync(f.stateFile), false);
  f.run('记知识：已知|仅此原文');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.deepEqual(f.run('查知识：请猜测不存在的答案'), { reply: '没有找到相关知识', wrote: false, continue: true });
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
});

test('list shows total, tags and dates, capped at twenty ordered by last update', t => {
  const f = fixture(t);
  assert.match(f.run('知识列表').reply, /共 0 条.*\n暂无知识条目/u);
  for (let i = 1; i <= 22; i++) {
    f.setTime(`2026-11-${String(i).padStart(2, '0')}T00:00:00Z`); f.run(`记知识：标题${i}|内容|标签`);
  }
  f.setTime('2026-12-01T00:00:00Z'); f.run('改知识：标题1|新内容');
  const lines = f.run('知识列表').reply.split('\n');
  assert.equal(lines.length, 21); assert.match(lines[0], /共 22 条.*20 条/u);
  assert.equal(lines[1], '标题1｜标签：标签｜记录日期：2026-11-01｜更新日期：2026-12-01');
  assert.match(lines[2], /^标题22｜/u); assert.doesNotMatch(lines.join('\n'), /标题2｜/u);
});

test('exact delete removes physical body; update keeps identity, creation and tags with update date', t => {
  const f = fixture(t);
  f.run('记知识：A|旧内容|标签'); f.run('记知识：AB|保留');
  const old = f.read().entries[0];
  f.setTime('2026-11-02T16:00:00Z');
  assert.equal(f.run('改知识：A|新内容').wrote, true);
  assert.deepEqual(f.read().entries[0], { ...old, content: '新内容', updatedAt: '2026-11-02T16:00:00.000Z' });
  assert.match(f.run('查知识：新内容').reply, /记录日期：2026-10-31｜更新日期：2026-11-03/u);
  for (const text of ['改知识：a|不能改', '删知识：a', '删知识：不存在']) assert.match(f.run(text).reply, /不存在标题/u);
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).entries[0];
  assert.equal(f.run('删知识：A').wrote, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), ref.file)), false);
  assert.equal(f.read().entries[0].title, 'AB');
  assert.equal(f.run('记知识：A|重新录入').wrote, true);
});

test('300-entry capacity refuses without eviction, allows updates and reuse after exact deletion', t => {
  const f = fixture(t);
  const entries = Array.from({ length: 299 }, (_, i) => ({ id: `entry-${i}`, title: `标题${i}`, content: `内容${i}`, tags: [], createdAt: '2026-10-31T00:00:00Z' }));
  writeRecordState(f.stateFile, { schemaVersion: 1, entries }, ['entries']);
  assert.equal(f.run('记知识：第300条|末条').wrote, true);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const refused = f.run('记知识：第301条|超限');
  assert.equal(refused.wrote, false); assert.match(refused.reply, /300 条上限.*先删旧/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before); assert.equal(f.read().entries.length, 300);
  assert.equal(f.run('改知识：标题0|仍可改').wrote, true);
  assert.equal(f.run('删知识：标题0').wrote, true);
  assert.equal(f.run('记知识：第301条|腾位新增').wrote, true);
  assert.equal(f.read().entries.length, 300);
});

test('invalid commands do not write, corrupt state fails visibly with preserved evidence', t => {
  const f = fixture(t);
  for (const command of [null, { type: 'invalid' }, { type: 'add', title: 'a', content: ' ' },
    { type: 'add', title: 'a', content: 'b', tags: 'bad' }, { type: 'search', keyword: '' }, { type: 'update', title: '', content: 'b' }]) {
    assert.equal(f.store.execute('owner', command).wrote, false);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  f.run('记知识：A|原文');
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).entries[0];
  fs.writeFileSync(path.join(path.dirname(f.stateFile), ref.file), '{broken');
  assert.throws(() => f.run('查知识：A'), /隔离保全/u);
  assert.equal(fs.readdirSync(path.dirname(f.stateFile)).some(name => name.includes('.corrupt-')), true);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), ref.file), 'utf8'), '{broken');
});
