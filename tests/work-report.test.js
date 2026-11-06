'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkReport, parseWorkReportCommand } = require('../src/work-report-commands');
const { createWorkReportProvider } = require('../src/work-report-provider');
const { createWorklogStore } = require('../src/worklog-store');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const SECTIONS = ['今日完成', '进行中', '风险阻塞', '明日计划'];

function answer(prompt) {
  const { sources } = JSON.parse(prompt.split('\n').at(-1));
  return Object.fromEntries(SECTIONS.map(title => [title, sources.filter(x => x.section === title)
    .map(x => ({ source: x.source, owner: null, result: null, deadline: x.dueDate }))]));
}
function fixture(t, model = async prompt => ({ ok: true, value: answer(prompt) })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-11-01T15:59:59Z');
  const now = () => time;
  const todos = createPersonalTodoStore({ stateFile: path.join(dir, 'todos/state.json'), now });
  const worklogs = createWorklogStore({ stateFile: path.join(dir, 'logs/state.json'), now });
  const calls = [];
  const provider = createWorkReportProvider({ model: async (...args) => { calls.push(args); return model(...args); } });
  const report = createWorkReport({ todos, worklogs, provider, now });
  return { dir, todos, worklogs, calls, report, setTime: value => { time = Date.parse(value); },
    run: () => report.execute('owner', parseWorkReportCommand('工作日报')) };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}
function seed(f) {
  f.worklogs.handle('owner', { type: 'add', text: '完成：核对资料' });
  f.worklogs.handle('owner', { type: 'add', text: '阻塞：等待采购确认' });
  f.worklogs.handle('owner', { type: 'add', text: '明日：复核资料' });
  f.todos.handle('owner', { type: 'add', text: '提交方案', dueDate: '2026-11-02' });
  f.todos.handle('owner', { type: 'complete', number: 1 });
  f.todos.handle('owner', { type: 'add', text: '待核实事项' });
}



test('friend refused before clock, either store, or model', async () => {
  const fail = () => assert.fail('must not read any dependency');
  const report = createWorkReport({ now: fail, todos: { readDailyItems: fail }, worklogs: { readDailyEntries: fail }, provider: { generate: fail } });
  assert.match((await report.execute('friend', { type: 'report' })).reply, /仅主人可用/u);
});

test('four complete sections, correct todo placement, explicit unknown fields, one isolated model call, no file writes', async t => {
  const f = fixture(t); seed(f);
  const before = snapshot(f.dir);
  for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'writeFile', 'appendFile']) {
    t.mock.method(fs, method, () => assert.fail(`generation must not call fs.${method}`));
  }
  const result = await f.run();
  t.mock.restoreAll();
  assert.equal(result.wrote, false);
  assert.equal(f.calls.length, 1);
  const parts = result.reply.split('\n\n');
  assert.deepEqual(parts.map(x => x.split('\n')[0]), SECTIONS);
  assert.match(parts[0], /提交方案/u); assert.doesNotMatch(parts[0], /待核实事项/u);
  assert.match(parts[1], /待核实事项/u); assert.doesNotMatch(parts[1], /提交方案/u);
  assert.match(parts[2], /等待采购确认/u); assert.match(parts[3], /复核资料/u);
  assert.match(parts[0], /负责人：待确认；结果：待确认；截止日期：待确认/u);
  assert.match(parts[0], /截止日期：2026-11-02/u);
  const [prompt, session, images, options] = f.calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []); assert.equal(options.stage, 'work_report_generate');
  assert.deepEqual(options.parse(JSON.stringify(answer(prompt))), answer(prompt));
  assert.match(prompt, /未写明负责人、结果、截止日期.*待确认/u);
  assert.match(prompt, /不得读取、复制或改写既有收工总结正文/u);
  assert.deepEqual(snapshot(f.dir), before);
});

test('Shanghai midnight excludes old logs/completions, includes today completion and all open items', async t => {
  const f = fixture(t);
  f.todos.handle('owner', { type: 'add', text: '昨日完成' });
  f.todos.handle('owner', { type: 'complete', number: 1 });
  f.todos.handle('owner', { type: 'add', text: '今日完成' });
  f.worklogs.handle('owner', { type: 'add', text: '昨日记录' });
  f.setTime('2026-11-01T16:00:00Z');
  f.todos.handle('owner', { type: 'complete', number: 1 });
  f.todos.handle('owner', { type: 'add', text: '未完成', dueDate: '2026-11-10' });
  f.worklogs.handle('owner', { type: 'add', text: '今日记录' });
  const result = await f.run();
  assert.doesNotMatch(result.reply, /昨日/u);
  assert.match(result.reply, /今日已完成待办/u); assert.match(result.reply, /未完成/u);
  assert.match(result.reply, /状态：待确认/u);
  assert.equal(JSON.parse(f.calls[0][0].split('\n').at(-1)).today, '2026-11-02');
});

test('empty data: four no-data sections, no invented items, no model or files; partial absence explicit', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.reply.split('\n\n').length, 4);
  assert.equal((result.reply.match(/无数据（无显式记录）/gu) || []).length, 4);
  assert.match(result.reply, /当日工作日志：无数据/u); assert.match(result.reply, /当日个人待办：无数据/u);
  assert.doesNotMatch(result.reply, /^- /mu); assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.dir), []);
  f.todos.handle('owner', { type: 'add', text: '唯一待办' });
  assert.match((await f.run()).reply, /当日工作日志：无数据/u);
  f.todos.handle('owner', { type: 'cancel', number: 1 });
  f.worklogs.handle('owner', { type: 'add', text: '完成：唯一日志' });
  assert.match((await f.run()).reply, /当日个人待办：无数据/u);
});

test('corrupt store fails read-only without quarantine writes or model calls', async t => {
  const f = fixture(t); seed(f);
  fs.writeFileSync(path.join(f.dir, 'logs/state.json'), '{bad');
  const before = snapshot(f.dir);
  assert.equal((await f.run()).reply, '工作日报生成失败，请稍后重试。');
  assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.dir), before);
});
