'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorklogStore, statusOf } = require('../src/worklog-store');
const { parseWorklogCommand } = require('../src/worklog-commands');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-worklog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'worklog', 'state.json');
  let clock = Date.parse('2026-10-30T15:59:59Z');
  const store = createWorklogStore({ stateFile, now: () => clock });
  return { dir, stateFile, store, setTime: value => { clock = Date.parse(value); },
    run: text => store.execute('owner', parseWorklogCommand(text)),
    read: () => readRecordState(stateFile, {}) };
}



test('commands preserve exact appended original and recognize only explicit controls', () => {
  assert.deepEqual(parseWorklogCommand('工作日志：  完成：A\nB  '), { type: 'add', text: '  完成：A\nB  ' });
  assert.deepEqual(parseWorklogCommand('工作日志:abc'), { type: 'add', text: 'abc' });
  assert.deepEqual(parseWorklogCommand('删除工作日志第 2 条'), { type: 'delete', number: 2 });
  assert.equal(parseWorklogCommand('整理今日工作日志').type, 'summary');
  assert.equal(parseWorklogCommand('今日工作日志').type, 'list');
  assert.equal(parseWorklogCommand('工作日志').type, 'invalid');
  assert.equal(parseWorklogCommand('删除工作日志第abc条').type, 'invalid');
  assert.equal(parseWorklogCommand('请帮我写一篇工作日志'), null);
});

test('append persists Shanghai date and verbatim body through classified JSON and reload', t => {
  const f = fixture(t);
  assert.equal(f.run('工作日志：  完成：A\nB  ').wrote, true);
  f.run('工作日志:第二条');
  const state = f.read();
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].date, '2026-10-30');
  assert.equal(state.entries[0].text, '  完成：A\nB  ');
  const index = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(index.entries[0].text, undefined);
  assert.match(index.entries[0].file, /^records\/entries\/entries\/2026\/10\//u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.stateFile), index.entries[0].file))).date, '2026-10-30');
  const reloaded = createWorklogStore({ stateFile: f.stateFile, now: () => Date.parse('2026-10-30T15:59:59Z') });
  assert.match(reloaded.handle('owner', { type: 'list' }), /2\. 第二条/u);
});

test('Shanghai midnight isolates list, summary, numbering and deletion; earlier day remains intact', t => {
  const f = fixture(t);
  f.run('工作日志：完成：昨日事项');
  f.setTime('2026-10-30T16:00:00Z');
  assert.match(f.run('今日工作日志').reply, /今日暂无工作日志（2026-10-31）/u);
  assert.equal(f.run('删除工作日志第1条').wrote, false);
  f.run('工作日志：明日：明日计划');
  assert.match(f.run('今日工作日志').reply, /1\. 明日：明日计划/u);
  assert.doesNotMatch(f.run('整理今日工作日志').reply, /昨日事项/u);
  assert.equal(f.read().entries[1].date, '2026-10-31');
  f.run('删除工作日志第1条');
  assert.equal(f.read().entries.length, 1);
  f.setTime('2026-10-30T15:59:59Z');
  assert.match(f.run('今日工作日志').reply, /1\. 完成：昨日事项/u);
});

test('summary has fixed sections and uses explicit prefix markers, keeping original day numbers', t => {
  const f = fixture(t);
  for (const body of ['随手记，完成：不算标记', '明日：准备材料', '阻塞 等待', '完成：交付', '进行中，核对', '完成不了这项']) {
    f.run(`工作日志：${body}`);
  }
  assert.equal(f.run('整理今日工作日志').reply,
    '今日工作日志汇总（2026-10-30）\n\n已完成\n4. 完成：交付\n\n进行中\n5. 进行中，核对\n\n阻塞\n3. 阻塞 等待\n\n明日计划\n2. 明日：准备材料\n\n记录\n1. 随手记，完成：不算标记\n6. 完成不了这项');
  assert.equal(statusOf('  完成：内容'), '完成');
  assert.equal(statusOf('这是进行中'), '记录');
});

test('deletion validates current numbers, removes classified body and renumbers retained entries', t => {
  const f = fixture(t);
  for (const text of ['甲', '乙', '丙']) f.run(`工作日志：${text}`);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const number of [0, -1, 4, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(f.store.execute('owner', { type: 'delete', number }).wrote, false);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  const body = JSON.parse(before).entries[1].file;
  assert.equal(f.run('删除工作日志第 2 条').wrote, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), body)), false);
  assert.equal(f.run('今日工作日志').reply, '今日工作日志（2026-10-30）\n1. 甲\n2. 丙');
});

test('empty day and whitespace content do not write; empty sections are visible', t => {
  const f = fixture(t);
  for (const text of ['今日工作日志', '整理今日工作日志', '工作日志： \n\t', '删除工作日志第1条', '工作日志']) {
    assert.equal(f.run(text).wrote, false);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  f.run('工作日志：普通记录');
  assert.match(f.run('整理今日工作日志').reply, /已完成\n暂无\n\n进行中\n暂无\n\n阻塞\n暂无\n\n明日计划\n暂无\n\n记录\n1\. 普通记录/u);
});

test('non-owner is refused before any storage access; corrupt data fails visibly and preserves original', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, '{broken');
  for (const type of ['add', 'list', 'summary', 'delete']) {
    assert.equal(f.store.execute('friend', { type, text: 'secret', number: 1 }).wrote, false);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken');
  assert.throws(() => f.run('今日工作日志'), /隔离保全/u);
  const preserved = fs.readdirSync(path.dirname(f.stateFile)).find(name => name.includes('.corrupt-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), preserved), 'utf8'), '{broken');
});

test('invalid parsed entries fail read-only validation unchanged and quarantine on execution', t => {
  for (const damage of ['date', 'duplicate-id']) {
    for (const command of [{ type: 'add', text: '不得追加' }, { type: 'list' }]) {
      const f = fixture(t);
      const entry = { id: 'entry-1', text: '原始日志', date: '2026-10-30', createdAt: '2026-10-30T15:59:59Z' };
      const entries = damage === 'date' ? [{ ...entry, date: '2026-10-31' }] : [entry, { ...entry }];
      const original = JSON.stringify({ schemaVersion: 1, entries });
      fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
      fs.writeFileSync(f.stateFile, original);
      assert.throws(() => f.store.readDailyEntries('owner', '2026-10-30'), {
        message: '工作日志存储格式无效',
      });
      assert.equal(fs.readFileSync(f.stateFile, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), ['state.json']);
      const preserved = `${f.stateFile}.corrupt-2026-10-30T15-59-59-000Z`;
      assert.throws(() => f.store.execute('owner', command), error => {
        assert.equal(error.message, `已保存的内容损坏，已隔离保全：${preserved}。本次操作未执行。`);
        assert.equal(error.cause.message, '工作日志存储格式无效');
        return true;
      });
      assert.equal(fs.existsSync(f.stateFile), false);
      assert.equal(fs.readFileSync(preserved, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), [path.basename(preserved)]);
    }
  }
});
