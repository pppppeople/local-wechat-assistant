'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseReverseInterviewCommand: parse } = require('../src/reverse-interview-commands');
const { createReverseInterviewStore } = require('../src/reverse-interview-store');
const { createReverseInterviewProvider } = require('../src/reverse-interview-provider');
const { readRecordState } = require('../src/record-state');
const questions = ['你最希望达成什么目标？', '可以接受多少时间成本？', '最担心什么风险？'];
const summary = { clarified: '主人希望节省时间。', uncertain: '预算与风险仍不确定。', nextSteps: '尚未明确下一步，可继续核实条件。' };
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-interview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const calls = [];
  const provider = {
    generate: async args => { calls.push(['generate', args]); return { questions }; },
    summarize: async args => { calls.push(['summarize', structuredClone(args)]); return summary; },
    ...overrides,
  };
  const store = createReverseInterviewStore({ stateFile, provider, now: () => Date.parse('2026-10-31T00:00:00Z') });
  return { root, stateFile, provider, store, calls, read: () => readRecordState(stateFile),
    run: (text, side = 'owner') => store.execute(side, parse(text, store.claimsAnswer(side))) };
}



test('explicit commands preserve originals; unrelated messages pass unless actively answering', () => {
  assert.deepEqual(parse('反过来问我：要换工作吗？'), { type: 'start', topic: '要换工作吗？' });
  assert.deepEqual(parse('反过来问我:'), { type: 'start', topic: '' });
  assert.deepEqual(parse('  答案\nＡ  ', true), { type: 'answer', answer: '  答案\nＡ  ' });
  assert.equal(parse('普通闲聊'), null);
  assert.equal(parse('普通闲聊', { hasActive: true }), null);
  assert.equal(parse('跳过'), null);
  assert.equal(parse('就这样吧'), null);
  assert.equal(parse('就这样吧', true).type, 'end');
});

test('skip and early end retain unanswered distinctions; reopened session can resume', async t => {
  const f = fixture(t);
  await f.run('反过来问我：搬家吗');
  await f.run('跳过');
  const reopened = createReverseInterviewStore({ stateFile: f.stateFile, provider: f.provider });
  assert.equal(reopened.claimsAnswer('owner'), true);
  await reopened.execute('owner', parse('希望离公司近', true));
  await f.run('就这样吧');
  const data = f.calls[1][1];
  assert.deepEqual(data.answers, [{ status: 'skipped', text: '' }, { status: 'answered', text: '希望离公司近' }]);
  assert.equal(data.questions.length, 3);
  assert.equal(f.read().sessions[0].index, 2);
});

test('discard removes session body without model summary and permits a new start', async t => {
  const f = fixture(t);
  await f.run('反过来问我：换工作吗');
  const body = JSON.parse(fs.readFileSync(f.stateFile)).sessions[0].file;
  assert.match((await f.run('放弃提问')).reply, /已丢弃/u);
  assert.deepEqual(f.read().sessions, []);
  assert.equal(fs.existsSync(path.join(f.root, body)), false);
  assert.equal(f.store.claimsAnswer('owner'), false);
  await f.run('反过来问我：搬家吗');
  assert.deepEqual(f.calls.map(c => c[0]), ['generate', 'generate']);
});

test('invalid generated lists and model exceptions safely end, without partial state', async t => {
  for (const value of [undefined, null, [], {}, { questions: [] }, { questions: questions.slice(0, 2) },
    { questions: [...questions, ...questions] }, { questions: ['目标？', '', '风险？'] },
    { questions: ['目标？', '目标？', '风险？'] }, { questions: [1, 2, 3] }, { questions, advice: '决定吧' }]) {
    const f = fixture(t, { generate: async () => value });
    assert.equal((await f.run('反过来问我：搬家吗')).reply, '这次没生成出问题，可以再试一次');
    assert.equal(f.store.claimsAnswer('owner'), false);
    assert.equal(fs.existsSync(f.stateFile), false);
  }
  const f = fixture(t, { generate: async () => { throw Error('offline'); } });
  assert.equal((await f.run('反过来问我：搬家吗')).reply, '这次没生成出问题，可以再试一次');
  assert.equal(await f.run('普通聊天'), null);
});

test('concurrent starts are blocked during asynchronous generation, answers cannot escape to ordinary chat', async t => {
  let release;
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve; }) });
  const first = f.run('反过来问我：搬家吗');
  assert.equal(f.store.claimsAnswer('owner'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.claimsAnswer('owner'), true);
  const second = f.run('反过来问我：换工作吗');
  release({ questions });
  assert.match((await first).reply, /第 1\/3/u);
  assert.match((await second).reply, /先.*结束提问.*放弃提问/u);
  assert.equal(f.read().sessions[0].topic, '搬家吗');
  assert.match((await f.run('反过来问我：读书吗')).reply, /已有进行中/u);
});

test('summary failure preserves originals and can retry or discard; completed session is replaced', async t => {
  let fail = true;
  const f = fixture(t, { summarize: async () => fail ? { clarified: '残缺' } : summary });
  await f.run('反过来问我：搬家吗');
  await f.run('原始答案');
  assert.match((await f.run('结束提问')).reply, /原文已保留/u);
  assert.equal(f.read().sessions[0].phase, 'summary_pending');
  assert.equal(f.read().sessions[0].answers[0].text, '原始答案');
  assert.match((await f.run('新答案')).reply, /重试小结/u);
  fail = false;
  assert.match((await f.run('结束提问')).reply, /^已明确/u);
  await f.run('反过来问我：读书吗');
  assert.equal(f.read().sessions.length, 1);
  assert.equal(f.read().sessions[0].topic, '读书吗');
});

test('five-question session can skip all questions and summarize without inventing answers', async t => {
  const five = [...questions, '最大预算是多少？', '决定能否撤回？'];
  const f = fixture(t, { generate: async () => ({ questions: five }) });
  await f.run('反过来问我：搬家吗');
  for (let i = 0; i < 5; i++) await f.run('跳过');
  assert.equal(f.read().sessions[0].phase, 'completed');
  assert.deepEqual(f.calls[0][1].answers, Array.from({ length: 5 }, () => ({ status: 'skipped', text: '' })));
  assert.deepEqual(f.calls[0][1].questions, five);
});
