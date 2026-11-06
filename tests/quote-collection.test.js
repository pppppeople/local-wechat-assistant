'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createQuoteCollectionStore } = require('../src/quote-collection-store');
const { parseQuoteCollectionCommand: parse } = require('../src/quote-collection-commands');
const { readRecordState } = require('../src/record-state');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-quote-collection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'quote-collection/state.json');
  let time = Date.parse('2026-10-31T15:59:59Z');
  const now = () => time;
  const store = createQuoteCollectionStore({ stateFile, now });
  return { dir, stateFile, store, now, at: value => { time = Date.parse(value); },
    run: text => store.execute('owner', parse(text)), rows: () => readRecordState(stateFile).quotes };
}


test('exact duplicate refuses without changes; full 300 refuses without eviction', t => {
  const f = fixture(t);
  f.run('摘录保存：原文');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('摘录保存 [来源=新来源]：原文').reply, /已存在/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  // Seed a valid inline state to exercise the boundary without 300 unrelated writes.
  const row = f.rows()[0];
  const quotes = Array.from({ length: 300 }, (_, i) => ({ ...row, id: `q${i}`, body: `原文${i}` }));
  fs.writeFileSync(f.stateFile, JSON.stringify({ schemaVersion: 1, quotes }));
  const full = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('摘录保存：额外').reply, /300.*满额/);
  assert.match(f.run('摘录保存：原文0').reply, /已存在/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), full);
  f.run('摘录删除 q0'); assert.equal(f.run('摘录保存：额外').wrote, true);
  assert.equal(f.rows().length, 300);
});

test('friend refused before filesystem access and invalid commands never save', t => {
  const f = fixture(t);
  const store = createQuoteCollectionStore({ get stateFile() { return f.dir; } });
  for (const text of ['摘录保存：隐私', '摘录查找 隐私', '摘录回顾', '摘录删除 x']) {
    assert.match(store.execute('friend', parse(text)).reply, /仅主人/);
  }
  for (const text of ['摘录保存：  ', '摘录保存 [时间=]：正文', '摘录查找', '摘录删除', '摘录回顾 多余']) {
    assert.equal(f.run(text).wrote, false);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
  for (const text of ['保存：正文', '查找 书', '随机回顾', '今日账单', '保存文字模板 A：正文']) assert.equal(parse(text), null);
});

test('corruption is visible and subsequent operations cannot overwrite isolated originals', t => {
  const f = fixture(t); f.run('摘录保存：保留');
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  fs.writeFileSync(path.join(path.dirname(f.stateFile), index.quotes[0].file), '{broken');
  assert.throws(() => f.run('摘录回顾'));
  assert.throws(() => f.run('摘录保存：新内容'), /隔离/);
  assert.equal(fs.existsSync(f.stateFile), false);
});
