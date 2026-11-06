'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWeeklyWorkReport, parseWeeklyWorkReportCommand, REFUSAL } = require('../src/weekly-work-report-commands');
const { createWeeklyWorkReportProvider } = require('../src/weekly-work-report-provider');
const { createWorklogStore } = require('../src/worklog-store');
const { createPersonalTodoStore } = require('../src/personal-todo-store');
const { addDays } = require('../src/personal-todo-commands');
const SECTIONS = ['本周完成', '进行中', '风险阻塞', '下周计划'];

function answer(prompt) {
  const { sources } = JSON.parse(prompt.split('\n').at(-1));
  return Object.fromEntries(SECTIONS.map(title => [title, sources.filter(item => item.section === title)
    .map(item => ({ theme: null, sources: [item.source] }))]));
}
function fixture(t, model = async prompt => ({ ok: true, value: answer(prompt) })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-weekly-work-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-11-03T03:00:00Z');
  const now = () => time;
  const todos = createPersonalTodoStore({ stateFile: path.join(dir, 'todos/state.json'), now });
  const worklogs = createWorklogStore({ stateFile: path.join(dir, 'logs/state.json'), now });
  const calls = [];
  const provider = createWeeklyWorkReportProvider({ model: async (...args) => { calls.push(args); return model(...args); } });
  const report = createWeeklyWorkReport({ todos, worklogs, provider, now });
  return { dir, todos, worklogs, report, calls, setTime: value => { time = Date.parse(value); },
    run: (text = '工作周报') => report.execute('owner', parseWeeklyWorkReportCommand(text)) };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(dir, name))]);
}
function seed(f) {
  for (const text of ['完成：交接资料核对', '阻塞：等待采购确认', '下周计划：复核资料', '进行中：交接资料归档']) {
    f.worklogs.handle('owner', { type: 'add', text });
  }
  f.todos.handle('owner', { type: 'add', text: '提交方案' });
  f.todos.handle('owner', { type: 'complete', number: 1 });
  f.todos.handle('owner', { type: 'add', text: '待核实事项', dueDate: '2026-11-20' });
}



test('invalid dates rejected before clock, stores and model, including normalized rollover and wrong format', async () => {
  const fail = () => assert.fail('invalid request must not read dependencies');
  const report = createWeeklyWorkReport({ now: fail, todos: { readDailyChanges: fail },
    worklogs: { readDailyEntries: fail }, provider: { generate: fail } });
  for (const text of ['工作周报 2026-02-29', '工作周报 2026-02-30', '工作周报 2026-13-01',
    '工作周报 2026-11-00', '工作周报 2026-1-01', '工作周报 不是日期', '工作周报 2026-11-03 并发送']) {
    assert.deepEqual(parseWeeklyWorkReportCommand(text), { type: 'invalid' });
    assert.match((await report.execute('owner', parseWeeklyWorkReportCommand(text))).reply, /有效日期/u);
  }
  assert.match((await report.execute('owner', { type: 'report', date: '2026-02-30' })).reply, /有效日期/u);
});

test('friend rejected explicitly before clock, either store, or model (even invalid commands)', async () => {
  const fail = () => assert.fail('friend must not access dependency');
  const report = createWeeklyWorkReport({ now: fail, todos: { readDailyChanges: fail },
    worklogs: { readDailyEntries: fail }, provider: { generate: fail } });
  for (const text of ['工作周报', '工作周报 上周', '工作周报 2026-11-03', '工作周报 2026-02-30']) {
    assert.equal((await report.execute('friend', parseWeeklyWorkReportCommand(text))).reply, REFUSAL);
  }
});

test('four sections, unknown themes marked pending, one isolated model call; aggregation is byte-for-byte read-only', async t => {
  const f = fixture(t); seed(f); const before = snapshot(f.dir);
  for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'writeFile', 'appendFile']) {
    t.mock.method(fs, method, () => assert.fail(`must not call fs.${method}`));
  }
  const result = await f.run();
  t.mock.restoreAll();
  assert.equal(result.wrote, false); assert.equal(f.calls.length, 1);
  const parts = result.reply.split('\n\n');
  assert.deepEqual(parts.map(part => part.split('\n')[0]), SECTIONS);
  assert.match(parts[0], /交接资料核对/u); assert.match(parts[0], /提交方案/u);
  assert.match(parts[1], /待核实事项/u); assert.match(parts[1], /进展\/计划：待确认/u);
  assert.match(parts[2], /等待采购确认/u); assert.match(parts[3], /复核资料/u);
  for (const part of parts) assert.match(part, /主题：待确认/u);
  const [prompt, session, images, options] = f.calls[0];
  assert.equal(session, ''); assert.deepEqual(images, []); assert.equal(options.stage, 'weekly_work_report_generate');
  assert.deepEqual(options.parse(JSON.stringify(answer(prompt))), answer(prompt));
  assert.match(prompt, /不按日拼接日报正文/u);
  assert.deepEqual(snapshot(f.dir), before);
});

test('model groups same theme across days using original evidence, not concatenated daily reports', async t => {
  const f = fixture(t, async prompt => {
    const value = answer(prompt);
    value.本周完成 = [{ theme: '交接资料', sources: value.本周完成.flatMap(group => group.sources) }];
    return { ok: true, value };
  });
  f.setTime('2026-11-02T02:00:00Z'); f.worklogs.handle('owner', { type: 'add', text: '完成：交接资料核对' });
  f.setTime('2026-11-03T02:00:00Z'); f.worklogs.handle('owner', { type: 'add', text: '完成：交接资料归档' });
  const result = await f.run();
  assert.equal((result.reply.match(/主题：交接资料/gu) || []).length, 1);
  assert.match(result.reply, /2026-11-02 工作日志/u); assert.match(result.reply, /2026-11-03 工作日志/u);
  assert.equal(f.calls.length, 1);
});

test('completion uses Shanghai completedAt, open uses creation day, no duplicate daily open items or due-date filtering', async t => {
  const f = fixture(t);
  f.setTime('2026-11-01T15:59:59Z');
  f.worklogs.handle('owner', { type: 'add', text: '周外日志' });
  f.todos.handle('owner', { type: 'add', text: '周外已完成' }); f.todos.handle('owner', { type: 'complete', number: 1 });
  f.todos.handle('owner', { type: 'add', text: '跨周完成', dueDate: '2026-12-01' });
  f.setTime('2026-11-01T16:00:00Z'); f.todos.handle('owner', { type: 'complete', number: 1 });
  f.todos.handle('owner', { type: 'add', text: '周内待办', dueDate: '2026-12-01' });
  f.worklogs.handle('owner', { type: 'add', text: '周内日志' });
  f.setTime('2026-11-08T15:59:59Z');
  f.todos.handle('owner', { type: 'add', text: '周日完成', dueDate: null }); f.todos.handle('owner', { type: 'complete', number: 2 });
  f.worklogs.handle('owner', { type: 'add', text: '明日：周一复核' });
  f.setTime('2026-11-08T16:00:00Z');
  f.todos.handle('owner', { type: 'add', text: '下个周完成', dueDate: null }); f.todos.handle('owner', { type: 'complete', number: 3 });
  f.worklogs.handle('owner', { type: 'add', text: '下个周日志' });
  const before = snapshot(f.dir);
  const result = await f.run('工作周报 上周');
  assert.doesNotMatch(result.reply, /周外|下个周/u);
  assert.match(result.reply, /跨周完成/u); assert.match(result.reply, /周日完成/u);
  assert.equal((result.reply.match(/周内待办/gu) || []).length, 1);
  assert.match(result.reply.split('\n\n')[3], /周一复核/u);
  assert.deepEqual(snapshot(f.dir), before);
});

test('weekday tomorrow is not a next-week plan; no inference of commitments from open tasks', async t => {
  const f = fixture(t);
  f.worklogs.handle('owner', { type: 'add', text: '明日：周三核对' });
  f.todos.handle('owner', { type: 'add', text: '下周到期任务', dueDate: '2026-11-10' });
  const parts = (await f.run()).reply.split('\n\n');
  assert.match(parts[1], /周三核对.*待确认/u); assert.match(parts[1], /下周到期任务/u);
  assert.equal(parts[3], '下周计划\n无数据（待确认）。');
});

test('both empty: four no-data sections, no model, no files; old unchanged backlog alone stays empty', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal((result.reply.match(/无数据（待确认）/gu) || []).length, 4);
  assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.dir), []);
  f.setTime('2026-10-20T03:00:00Z'); f.todos.handle('owner', { type: 'add', text: '旧积压', dueDate: '2026-11-04' });
  f.setTime('2026-11-03T03:00:00Z'); const before = snapshot(f.dir);
  assert.equal((await f.run()).reply, result.reply); assert.equal(f.calls.length, 0);
  assert.deepEqual(snapshot(f.dir), before);
});
