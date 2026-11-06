'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMeetingSimulatorStore } = require('../src/meeting-simulator-store');
const { createEnglishExpressionStore } = require('../src/english-expression-store');
const { parseEnglishExpressionCommand: parse } = require('../src/english-expression-commands');
const { readRecordState } = require('../src/record-state');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-english-expression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'english-expressions/state.json');
  const meetingSimulator = createMeetingSimulatorStore({ provider: {
    open: async () => ({ role: 'Host', question: 'How can I help?', practice: '介绍背景' }),
    turn: async () => ({ question: 'Could you explain?', advice: '本轮建议不落盘' }),
    summarize: async data => ({ issues: ['总结全文标记不落盘'], comparisons: data.turns.map(turn => ({
      original: turn.answer, suggested: `Please clarify ${turn.answer}` })) }),
  } });
  const store = createEnglishExpressionStore({ stateFile, meetingSimulator });
  const run = text => store.execute('owner', parse(text));
  const summarize = async (scene = '场景一') => {
    await meetingSimulator.execute('owner', { type: 'start', scene });
    for (const text of ['Selected', 'Unselected']) await meetingSimulator.execute('owner', { type: 'answer', text });
    return meetingSimulator.execute('owner', { type: 'end' });
  };
  return { dir, stateFile, meetingSimulator, store, run, summarize };
}



test('only selected triples persist; dedup, restart listing and physical deletion', async t => {
  const f = fixture(t);
  assert.match(f.run('表达收藏列表').reply, /暂无收藏/);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match((await f.summarize()).reply, /1\. Selected →.*\n2\. Unselected →/);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(f.run('收藏表达：1').wrote, true);
  assert.equal(f.run('收藏表达：1').wrote, false);
  await f.summarize('场景二');
  assert.match(f.run('收藏表达：3').reply, /已收藏.*不会重复/);
  const state = readRecordState(f.stateFile);
  assert.equal(state.expressions.length, 1);
  assert.equal(state.expressions[0].scene, '场景一');
  const files = fs.readdirSync(path.dirname(f.stateFile), { recursive: true }).filter(file => file.endsWith('.json'));
  const disk = files.map(file => fs.readFileSync(path.join(path.dirname(f.stateFile), file), 'utf8')).join('\n');
  assert.match(disk, /Selected/); assert.doesNotMatch(disk, /Unselected|总结全文标记|本轮建议|Host|How can I help/);
  assert.deepEqual(Object.keys(state.expressions[0]).sort(), ['createdAt', 'id', 'original', 'scene', 'suggested']);
  const reopened = createEnglishExpressionStore({ stateFile: f.stateFile, meetingSimulator: createMeetingSimulatorStore({ provider: {} }) });
  assert.match(reopened.execute('owner', parse('表达收藏列表')).reply, /Selected → Please clarify Selected/);
  assert.match(reopened.execute('owner', parse('收藏表达：1')).reply, /没有.*缓存/);
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).expressions[0];
  assert.match(ref.file, /^records\/expressions\/expressions\/\d{4}\/\d{2}\//);
  assert.equal(f.run(`删除表达：${ref.id}`).wrote, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), ref.file)), false);
  assert.match(f.run('表达收藏列表').reply, /共 0 条/);
  assert.equal(f.run(`删除表达：${ref.id}`).wrote, false);
});

test('invalid saved expression fields and duplicate pairs quarantine the index and preserve originals', async t => {
  for (const kind of ['blank-suggestion', 'duplicate-pair']) {
    const f = fixture(t); await f.summarize();
    assert.equal(f.run('收藏表达：1').wrote, true);
    assert.equal(f.run('收藏表达：2').wrote, true);
    const index = fs.readFileSync(f.stateFile, 'utf8');
    const references = JSON.parse(index).expressions;
    const bodyFiles = references.map(row => path.join(path.dirname(f.stateFile), row.file));
    const first = JSON.parse(fs.readFileSync(bodyFiles[0], 'utf8'));
    const second = JSON.parse(fs.readFileSync(bodyFiles[1], 'utf8'));
    if (kind === 'blank-suggestion') second.suggested = ' ';
    else { second.original = first.original; second.suggested = first.suggested; }
    fs.writeFileSync(bodyFiles[1], JSON.stringify(second));
    const originals = bodyFiles.map(file => fs.readFileSync(file, 'utf8'));
    assert.throws(() => f.run('表达收藏列表'), error => {
      assert.match(error.message, /损坏.*隔离/);
      assert.equal(error.cause.message, '英语表达收藏存储格式无效');
      return true;
    });
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.deepEqual(bodyFiles.map(file => fs.readFileSync(file, 'utf8')), originals);
    const quarantined = fs.readdirSync(path.dirname(f.stateFile)).filter(name => name.startsWith('state.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.stateFile), quarantined[0]), 'utf8'), index);
  }
});

test('all friend operations refuse before any reads; summary failure never populates cache', async t => {
  const f = fixture(t);
  for (const text of ['收藏表达：1', '表达收藏列表', '删除表达：abc']) assert.match(f.store.execute('friend', parse(text)).reply, /只供已绑定的本人/);
  assert.equal(f.meetingSimulator.getExpression('friend', 1).entry, undefined);
  const broken = createMeetingSimulatorStore({ provider: { open: async () => { throw Error('offline'); }, summarize: async () => { throw Error('offline'); } } });
  await broken.execute('owner', { type: 'start', scene: 'test' });
  await broken.execute('owner', { type: 'end' });
  assert.match(broken.getExpression('owner', 1).reply, /没有.*缓存/);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('empty summary and unvalidated model comparisons never supply favorites', async t => {
  const f = fixture(t);
  await f.meetingSimulator.execute('owner', { type: 'start', scene: '空场景' });
  await f.meetingSimulator.execute('owner', { type: 'end' });
  assert.match(f.run('收藏表达：1').reply, /越界/);
  assert.equal(fs.existsSync(f.stateFile), false);
  const broken = createMeetingSimulatorStore({ provider: {
    open: async () => ({ role: 'Host', question: 'How are you?', practice: '介绍' }),
    summarize: async () => ({ issues: [], comparisons: [{ original: 'invented', suggested: 'Please' }] }),
  } });
  await broken.execute('owner', { type: 'start', scene: '测试' });
  assert.match((await broken.execute('owner', { type: 'end' })).reply, /总结失败/);
  assert.equal(broken.getExpression('owner', 1).entry, undefined);
});
