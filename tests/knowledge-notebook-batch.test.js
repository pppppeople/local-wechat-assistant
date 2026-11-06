'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKnowledgeNotebookCommand: parse } = require('../src/knowledge-notebook-commands');
const { createKnowledgeNotebookStore } = require('../src/knowledge-notebook-store');
const { createKnowledgeNotebookBatch } = require('../src/knowledge-notebook-batch');
const { writeRecordState } = require('../src/record-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-knowledge-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const store = createKnowledgeNotebookStore({ stateFile });
  return { stateFile, store, run: text => store.execute('owner', parse(text)), rows: () => store.readEntries('owner') };
}
const start = (...lines) => `批量记知识：\n${lines.join('\n')}`;



test('batch parses separate lines, fixed delimiter, trimmed fields and single-add tag semantics', () => {
  const command = parse(start(' A ｜ C ｜ 标签、运维,标签，步骤 ', ' B ｜ D '));
  assert.deepEqual(command, { type: 'batch-preview', entries: [
    { title: 'A', content: 'C', tags: ['标签', '运维', '步骤'] }, { title: 'B', content: 'D', tags: [] },
  ] });
  assert.equal(parse(start('A|B')).entries[0].reason.includes('固定分隔符'), true);
  assert.equal(parse('批量记知识：A｜B').type, 'batch-invalid');
  assert.equal(parse('记知识：A|B').type, 'add');
  assert.equal(parse('改知识：A｜B').type, 'update');
});

test('preview performs zero disk writes; confirmation uses durable single-add semantics and consumes batch', t => {
  const f = fixture(t);
  const preview = f.run(start(' A ｜ C ｜ 标签、标签 ', 'B｜D'));
  assert.equal(preview.wrote, false);
  assert.match(preview.reply, /1\. 标题：A\n内容：C\n标签：标签/u);
  assert.equal(f.rows().length, 0); assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(f.run('确认批量记知识').wrote, true);
  assert.deepEqual(f.rows().map(({ title, content, tags }) => ({ title, content, tags })), [
    { title: 'A', content: 'C', tags: ['标签'] }, { title: 'B', content: 'D', tags: [] },
  ]);
  const saved = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('确认批量记知识').reply, /无待确认批次/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), saved);
  const restored = createKnowledgeNotebookStore({ stateFile: f.stateFile });
  assert.equal(restored.readEntries('owner').length, 2);
  assert.match(restored.handle('owner', parse('确认批量记知识')), /无待确认批次/u);
});

test('over 15 rows refuses entire batch without preview, disk writes or pending batch; exactly 15 accepted', t => {
  const f = fixture(t);
  const lines = Array.from({ length: 16 }, (_, i) => `标题${i}｜内容`);
  const result = f.run(start(...lines));
  assert.equal(result.wrote, false); assert.match(result.reply, /最多 15 条.*未生成预览/u);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match(f.run('确认批量记知识').reply, /无待确认批次/u);
  f.run(start(...lines.slice(0, 15))); f.run('确认批量记知识');
  assert.equal(f.rows().length, 15);
});

test('existing and same-batch duplicate titles are itemized and never overwrite', t => {
  const f = fixture(t);
  f.run('记知识：旧｜原文');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const preview = f.run(start('旧｜覆盖', '新｜正文', '新｜覆盖新'));
  assert.match(preview.reply, /1\. 标题：旧[\s\S]*标题重复（知识本已有）/u);
  assert.match(preview.reply, /3\. 标题：新[\s\S]*标题重复（本批已有）/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  f.run('确认批量记知识');
  assert.deepEqual(f.rows().map(row => row.content), ['原文', '正文']);
});

test('invalid rows show skip reasons and never enter confirmation, including tag validation', t => {
  const f = fixture(t);
  const command = parse(start(' ｜内容', '标题｜ ', 'A|B', '好｜正文', '多｜段｜标签｜额外'));
  command.entries.push({ title: '标签错误', content: '正文', tags: [''] });
  const preview = f.store.execute('owner', command);
  for (const reason of ['标题为空', '内容为空', '固定分隔符', '标签无效']) assert.match(preview.reply, new RegExp(reason, 'u'));
  assert.equal(f.rows().length, 0);
  f.run('确认批量记知识'); assert.deepEqual(f.rows().map(row => row.title), ['好']);
});

test('invalid row does not reserve its title against a later valid row; all-invalid batch clears explicitly', t => {
  const f = fixture(t);
  f.run(start('A｜ ', 'A｜有效正文'));
  f.run('确认批量记知识'); assert.equal(f.rows()[0].content, '有效正文');
  f.run(start(' ｜无标题'));
  assert.match(f.run(start('B｜正文')).reply, /已有待确认批次/u);
  assert.equal(f.run('确认批量记知识').wrote, false);
  assert.match(f.run('确认批量记知识').reply, /无待确认批次/u);
  assert.equal(f.rows().length, 1);
});

test('pending batch cannot be overwritten; cancellation and restart discard only in-memory candidates', t => {
  const f = fixture(t);
  f.run(start('原批｜原文'));
  assert.match(f.run(start('替换批｜正文')).reply, /已有待确认批次.*先发送/u);
  f.run('确认批量记知识'); assert.equal(f.rows()[0].title, '原批');
  f.run(start('取消批｜正文'));
  const saved = fs.readFileSync(f.stateFile, 'utf8');
  assert.equal(f.run('取消批量记知识').wrote, false);
  assert.match(f.run('取消批量记知识').reply, /无待确认批次/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), saved);
  f.run(start('重启丢弃｜正文'));
  assert.match(createKnowledgeNotebookStore({ stateFile: f.stateFile }).handle('owner', parse('确认批量记知识')), /无待确认批次/u);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), saved);
});

test('single-create rechecks titles added after preview and enforces the existing 300-entry limit', t => {
  const f = fixture(t);
  f.run(start('A｜候选', 'B｜候选'));
  f.run('记知识：A｜先保存');
  assert.match(f.run('确认批量记知识').reply, /已存在同名条目.*不会覆盖/u);
  assert.equal(f.rows()[0].content, '先保存');
  const entries = Array.from({ length: 299 }, (_, i) => ({ id: `id-${i}`, title: `旧${i}`, content: '正文', tags: [], createdAt: new Date().toISOString() }));
  writeRecordState(f.stateFile, { schemaVersion: 1, entries }, ['entries']);
  f.run(start('末条｜正文', '超限｜正文'));
  const result = f.run('确认批量记知识');
  assert.match(result.reply, /300 条上限/u); assert.equal(f.rows().length, 300);
  assert.match(f.run('确认批量记知识').reply, /无待确认批次/u);
});

test('per-entry write exceptions report failures, continue the batch and never replay confirmation', t => {
  for (const failingTitles of [['B'], ['A', 'B', 'C']]) {
    const f = fixture(t), calls = [];
    const batch = createKnowledgeNotebookBatch({
      readEntries: f.rows, validTags: Array.isArray,
      add: command => {
        calls.push(command.title);
        if (failingTitles.includes(command.title)) throw Error('mock write failure');
        return f.store.execute('owner', command);
      },
    });
    batch(parse(start('A｜正文A', 'B｜正文B', 'C｜正文C')));
    assert.deepEqual(calls, []);
    const result = batch(parse('确认批量记知识'));
    assert.equal(result.wrote, failingTitles.length < 3);
    assert.equal(result.continue, true);
    assert.deepEqual(calls, ['A', 'B', 'C']);
    for (const title of failingTitles) assert.match(result.reply, new RegExp(`${title}：写入未完成.*核对该条`, 'u'));
    const savedTitles = ['A', 'B', 'C'].filter(title => !failingTitles.includes(title));
    for (const title of savedTitles) assert.match(result.reply, new RegExp(`${title}：已保存知识：${title}`, 'u'));
    assert.deepEqual(f.rows().map(row => row.title), savedTitles);
    assert.match(batch(parse('确认批量记知识')).reply, /无待确认批次/u);
    assert.deepEqual(calls, ['A', 'B', 'C']);
    assert.deepEqual(f.rows().map(row => row.title), savedTitles);
  }
});

test('friend refuses all batch commands before reading corrupt private state or consuming owner batch', t => {
  const f = fixture(t);
  f.run(start('主人｜正文'));
  fs.writeFileSync(f.stateFile, '{broken');
  for (const text of [start('好友｜正文'), '确认批量记知识', '取消批量记知识']) {
    const result = f.store.execute('friend', parse(text));
    assert.equal(result.wrote, false); assert.match(result.reply, /只供已绑定的本人/u);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken');
  fs.unlinkSync(f.stateFile);
  f.run('确认批量记知识'); assert.equal(f.rows()[0].title, '主人');
});
