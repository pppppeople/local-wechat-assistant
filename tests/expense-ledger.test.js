'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExpenseLedgerStore } = require('../src/expense-ledger-store');
const { parseExpenseLedgerCommand: parse } = require('../src/expense-ledger-commands');
const { readRecordState } = require('../src/record-state');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-expense-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'expense-ledger/state.json');
  let time = Date.parse('2026-10-31T15:59:59Z');
  const now = () => time;
  const store = createExpenseLedgerStore({ stateFile, now });
  return { dir, stateFile, store, now, at: value => { time = Date.parse(value); },
    run: text => store.execute('owner', parse(text)), rows: () => readRecordState(stateFile).entries };
}


test('yuan become exact integer cents, optional notes, restart and classified storage', t => {
  const f = fixture(t);
  assert.equal(f.run('记账 12.5元 餐饮 午饭').wrote, true);
  assert.equal(f.run('记账 8元 交通').wrote, true);
  assert.deepEqual(f.rows().map(row => row.amountCents), [1250, 800]);
  assert.deepEqual(f.rows().map(row => row.note), ['午饭', '']);
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.match(index.entries[0].file, /^records\/entries\/entries\/2026\/10\//);
  assert.equal(index.entries[0].amountCents, undefined);
  const reopened = createExpenseLedgerStore({ stateFile: f.stateFile, now: f.now });
  assert.match(reopened.execute('owner', parse('今日账单')).reply, /今日合计：20.50元/);
});

test('invalid amounts and categories refuse without creating or changing records', t => {
  const f = fixture(t);
  for (const amount of ['0', '-1', '1.234', 'abc', 'NaN', '1e2', '9007199254740992']) {
    const result = f.run(`记账 ${amount}元 餐饮`);
    assert.equal(result.wrote, false); assert.match(result.reply, /金额须大于 0/);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
  assert.match(f.run('记账 2元 医疗').reply, /餐饮、交通、购物、娱乐、其他/);
  assert.equal(fs.existsSync(f.stateFile), false);
  f.run('记账 1元 其他');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const text of ['记账 -1元 餐饮', '记账 2元 医疗']) assert.equal(f.run(text).wrote, false);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(f.rows().length, 1);
});

test('today list and category month totals, Shanghai midnight/month rollover and empty states', t => {
  const f = fixture(t);
  assert.equal(f.run('今日账单').reply, '今日无记录。');
  assert.equal(f.run('本月账单').reply, '本月无记录。');
  assert.equal(fs.existsSync(f.stateFile), false);
  f.run('记账 12.5元 餐饮 午饭'); f.run('记账 7.50元 餐饮'); f.run('记账 3元 交通 地铁');
  const today = f.run('今日账单').reply;
  for (const row of f.rows()) assert.ok(today.includes(row.id));
  assert.match(today, /12.50元 \| 餐饮 \| 午饭/);
  assert.match(today, /今日合计：23.00元/);
  const month = f.run('本月账单').reply;
  assert.match(month, /餐饮：20.00元/); assert.match(month, /交通：3.00元/);
  assert.match(month, /本月总计：23.00元/);
  f.at('2026-10-31T16:00:00Z');
  assert.equal(f.run('今日账单').reply, '今日无记录。');
  assert.equal(f.run('本月账单').reply, '本月无记录。');
  f.run('记账 1元 其他');
  f.at('2026-11-01T16:00:00Z');
  assert.equal(f.run('今日账单').reply, '今日无记录。');
  assert.match(f.run('本月账单').reply, /本月总计：1.00元/);
  assert.equal(f.rows().length, 4);
});

test('deletion uses stable IDs, removes only one body and reduces both totals', t => {
  const f = fixture(t);
  f.run('记账 12.5元 餐饮 午饭'); f.run('记账 3元 交通');
  const [first, second] = f.rows();
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).entries[0];
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const failure = f.run('删除支出 missing');
  assert.equal(failure.wrote, false); assert.match(failure.reply, /编号不存在/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(f.run(`删除支出 ${first.id}`).wrote, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), ref.file)), false);
  assert.deepEqual(f.rows(), [second]);
  assert.match(f.run('今日账单').reply, /今日合计：3.00元/);
  assert.match(f.run('本月账单').reply, /餐饮：0.00元/);
  assert.match(f.run('本月账单').reply, /本月总计：3.00元/);
  assert.equal(f.run(`删除支出 ${first.id}`).wrote, false);
});

test('friend refused before reading even a broken ledger; no writes or disclosure', t => {
  const f = fixture(t); f.run('记账 123元 购物 私密备注');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const text of ['记账 12元 餐饮', '今日账单', '本月账单', `删除支出 ${f.rows()[0].id}`]) {
    const result = f.store.execute('friend', parse(text));
    assert.equal(result.wrote, false); assert.match(result.reply, /仅供主人/);
    assert.doesNotMatch(result.reply, /私密备注|123/);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  fs.writeFileSync(f.stateFile, 'broken');
  assert.match(f.store.execute('friend', parse('今日账单')).reply, /仅供主人/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), 'broken');
});

test('parseable invalid ledger rows fail closed and preserve the original without writing back', t => {
  const row = { id: 'expense-1', category: '餐饮', amountCents: 1250, note: '午饭',
    createdAt: '2026-10-31T15:59:59Z' };
  for (const entries of [[{ ...row, category: '医疗' }], [{ ...row, amountCents: 0 }], [row, { ...row }]]) {
    for (const command of ['今日账单', '记账 3元 交通']) {
      const f = fixture(t), dir = path.dirname(f.stateFile);
      fs.mkdirSync(dir, { recursive: true });
      const original = JSON.stringify({ schemaVersion: 1, entries });
      fs.writeFileSync(f.stateFile, original);
      assert.throws(() => f.run(command), error => {
        assert.match(error.message, /已保存的内容损坏，已隔离保全：.*。本次操作未执行。/u);
        assert.equal(error.cause.message, '消费流水账存储格式无效');
        return true;
      });
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 1);
      assert.ok(files[0].startsWith('state.json.corrupt-'));
      assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), original);
      assert.equal(fs.existsSync(f.stateFile), false);
    }
  }
});
