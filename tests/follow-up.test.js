'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseFollowUpCommand: parse } = require('../src/follow-up-commands');
const { createFollowUpStore } = require('../src/follow-up-store');
const { readRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T15:59:00Z'); // Shanghai 23:59.
  const stateFile = path.join(root, 'follow-up/state.json');
  const options = { stateFile, now: () => time };
  const store = createFollowUpStore(options), sent = [];
  return { root, stateFile, options, store, sent, now: () => time, advance: ms => { time += ms; },
    say: text => store.handle('owner', parse(text)), read: () => readRecordState(stateFile),
    restart: () => createFollowUpStore(options), deliver: async (...args) => sent.push(args) };
}



test('explicit registration supports optional party and node independently, existing Shanghai dates', t => {
  const f = fixture(t);
  for (const text of ['我在等审批', '他说在等：审批', '看看邮件有什么要催办', '提醒对方发结果']) assert.equal(parse(text), null);
  for (const text of ['在等：', '有结果了：', '取消等待:', '在等：审批（对方：）']) assert.match(f.say(text), /命令不完整/);
  f.say('在等：审批');
  f.say('在等:合同(对方:采购部)');
  f.say('在等：报销预计 明天 有结果');
  f.say('在等：报价（对方：成员乙）预计 下周一 有结果');
  assert.deepEqual(f.read().waits.map(item => [item.name, item.counterpart, item.expectedDate]),
    [['审批', '未注明', null], ['合同', '采购部', null], ['报销', '未注明', '2026-11-01'], ['报价', '成员乙', '2026-11-02']]);
  for (const [phrase, date] of [['今天', '2026-10-31'], ['后天', '2026-11-02'], ['周五', '2026-11-06'],
    ['下周五', '2026-11-06'], ['11月3日', '2026-11-03'], ['2026-12-24', '2026-12-24']]) {
    assert.match(f.say(`在等：节点预计 ${phrase} 有结果`), /已登记/);
    assert.equal(f.read().waits.at(-1).expectedDate, date);
  }
  const before = f.read().waits.length;
  for (const phrase of ['不知道', '2月30日', '2026-02-30']) assert.match(f.say(`在等：节点预计 ${phrase} 有结果`), /日期无法识别/);
  assert.equal(f.read().waits.length, before);
  f.advance(60000); f.say('在等：跨日预计 明天 有结果');
  assert.equal(f.read().waits.at(-1).registeredDate, '2026-11-01');
  assert.equal(f.read().waits.at(-1).expectedDate, '2026-11-02');
});

test('list has all required fields, sorts dated waits first and keeps reminded waits open', async t => {
  const f = fixture(t);
  assert.match(f.say('催办列表'), /暂无进行中/);
  f.say('在等：无节点'); f.say('在等：晚些预计 后天 有结果');
  f.say('在等：最早（对方：单位）预计 今天 有结果'); f.say('在等：明日预计 明天 有结果');
  await f.store.tick(f.deliver);
  const reply = f.say('在等什么');
  assert.equal(reply, '催办列表：\n最早｜对方：单位｜登记 2026-10-31｜预计 2026-10-31 有结果\n明日｜对方：未注明｜登记 2026-10-31｜预计 2026-11-01 有结果\n晚些｜对方：未注明｜登记 2026-10-31｜预计 2026-11-02 有结果\n无节点｜对方：未注明｜登记 2026-10-31｜无预计');
});

test('complete and cancel match name containment only; ambiguity including exact name never closes', async t => {
  const f = fixture(t);
  f.say('在等：合同预计 今天 有结果'); f.say('在等：合同审批（对方：采购部）预计 今天 有结果');
  const before = JSON.stringify(f.read());
  for (const text of ['有结果了：合同', '取消等待：合同']) assert.match(f.say(text), /多笔.*更具体.*未关闭/);
  for (const text of ['有结果了：找不到', '取消等待：采购部', '有结果了：合同审批完整名称']) assert.match(f.say(text), /没有找到/);
  assert.equal(JSON.stringify(f.read()), before);
  f.advance(60000);
  assert.match(f.say('有结果了：审批'), /已完成.*2026-11-01/);
  assert.match(f.say('取消等待：合同'), /已取消.*2026-11-01/);
  assert.deepEqual(f.read().waits.map(item => [item.status, item.closedDate]), [['cancelled', '2026-11-01'], ['completed', '2026-11-01']]);
  assert.match(f.say('催办列表'), /暂无/);
  assert.match(f.say('有结果了：审批'), /没有找到/);
  await f.restart().tick(f.deliver); assert.equal(f.sent.length, 0);
});

test('friend store and parser reject every operation without touching state', t => {
  const f = fixture(t);
  for (const text of ['在等：合同', '催办列表', '在等什么', '有结果了：合同', '取消等待：合同']) {
    assert.equal(parse(text, { side: 'friend' }), null);
    assert.match(f.store.handle('friend', parse(text)), /仅主人/);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('unsupported follow-up operations neither create storage nor change an existing wait', t => {
  const f = fixture(t);
  assert.equal(f.store.handle('owner', { type: 'unsupported' }), '不支持这个催办操作。');
  assert.equal(fs.existsSync(f.stateFile), false);
  f.say('在等：审批预计 今天 有结果');
  const originalIndex = fs.readFileSync(f.stateFile, 'utf8');
  const index = JSON.parse(originalIndex);
  const body = path.join(path.dirname(f.stateFile), index.waits[0].file);
  const originalBody = fs.readFileSync(body, 'utf8');
  assert.equal(f.restart().handle('owner', { type: 'unsupported', keyword: '审批' }), '不支持这个催办操作。');
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), originalIndex);
  assert.equal(fs.readFileSync(body, 'utf8'), originalBody);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)).sort(), ['records', 'state.json']);
});

test('due Shanghai day marks before dispatch; concurrent scans and restart attempt exactly once', async t => {
  const f = fixture(t);
  f.say('在等：报销（对方：财务）预计 明天 有结果'); f.say('在等：无预计');
  assert.equal(await f.store.tick(f.deliver), false);
  f.advance(60000);
  await Promise.all([f.store.tick(async (...args) => {
    assert.equal(f.read().waits[0].reminded, true);
    await f.deliver(...args);
  }), f.restart().tick(f.deliver)]);
  await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], '「报销」预计今天有结果，可以跟 财务 确认一下。');
  assert.match(f.sent[0][1], /^follow-up-/);
  f.advance(86400000); await f.restart().tick(f.deliver);
  assert.equal(f.sent.length, 1); assert.equal(f.read().waits[1].reminded, false);
});

test('failed dispatch never retries; closed, undated and missed waits never remind', async t => {
  const f = fixture(t);
  f.say('在等：取消预计 今天 有结果'); f.say('取消等待：取消');
  f.say('在等：完成预计 今天 有结果'); f.say('有结果了：完成');
  f.say('在等：无日期'); f.say('在等：失败预计 今天 有结果'); f.say('在等：下一笔预计 今天 有结果');
  let attempts = 0;
  await assert.rejects(f.store.tick(async () => { attempts++; throw new Error('mock failure'); }), /mock failure/);
  await f.restart().tick(f.deliver); await f.restart().tick(f.deliver);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 1); assert.match(f.sent[0][0], /下一笔/);
  f.say('在等：错过预计 明天 有结果'); f.advance(2 * 86400000);
  assert.equal(await f.restart().tick(f.deliver), false);
  assert.equal(f.read().waits.at(-1).reminded, false);
});

test('strict damaged state preserves evidence and does not dispatch', async t => {
  const f = fixture(t); f.say('在等：审批预计 今天 有结果');
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  const body = path.join(path.dirname(f.stateFile), index.waits[0].file);
  assert.match(body, /records\/waits\/waits\/2026\/10\/.+\.json$/u);
  fs.writeFileSync(f.stateFile, '{bad');
  await assert.rejects(f.restart().tick(f.deliver), /损坏.*隔离/);
  assert.ok(fs.existsSync(body)); assert.equal(f.sent.length, 0);
});

test('invalid persisted wait fields quarantine the index and preserve the record body', t => {
  for (const fields of [
    { status: 'unknown' }, { reminded: 'false' },
    { status: 'open', closedDate: '2026-10-31' }, { status: 'completed', closedDate: null },
  ]) {
    const f = fixture(t);
    f.say('在等：审批预计 今天 有结果');
    const originalIndex = fs.readFileSync(f.stateFile, 'utf8');
    const index = JSON.parse(originalIndex);
    const body = path.join(path.dirname(f.stateFile), index.waits[0].file);
    fs.writeFileSync(body, JSON.stringify({ ...JSON.parse(fs.readFileSync(body)), ...fields }));
    const damagedBody = fs.readFileSync(body, 'utf8');

    assert.throws(() => f.restart().handle('owner', parse('催办列表')), error => {
      assert.match(error.message, /损坏.*隔离保全/u);
      assert.match(error.cause.message, /催办助手记录格式无效/u);
      return true;
    });
    assert.equal(fs.existsSync(f.stateFile), false);
    const quarantined = fs.readdirSync(path.dirname(f.stateFile)).filter(name => name.startsWith('state.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), quarantined[0]), 'utf8'), originalIndex);
    assert.equal(fs.readFileSync(body, 'utf8'), damagedBody);
  }
});
