'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTableOrganizerCommand: parse, createTableOrganizer } = require('../src/table-organizer-commands');
const { createTableOrganizerProvider } = require('../src/table-organizer-provider');
const { formatTable, validateTable, displayWidth } = require('../src/table-organizer-formatter');
const sample = { columns: ['姓名', '数量'], rows: [['小明', 0], ['Amy', 12]] };
const runWithModel = model => createTableOrganizer({ provider: createTableOrganizerProvider({ model }) });



test('explicit colon and space entries only; blank input needs content without model call', async () => {
  for (const text of ['整理成表格：甲\n乙', '整理成表格:甲\n乙', '整理成表格 甲\n乙']) {
    assert.deepEqual(parse(text), { type: 'organize', text: '甲\n乙' });
  }
  for (const text of ['请整理成表格：甲', '整理成表格甲', '普通文字']) assert.equal(parse(text), null);
  const organizer = runWithModel(() => assert.fail('empty input must not call model'));
  for (const text of ['整理成表格', '整理成表格： ', '整理成表格:']) {
    assert.match((await organizer.execute('owner', parse(text))).reply, /<一段杂乱文字>/u);
  }
});

test('friends refused before any provider call', async () => {
  const organizer = runWithModel(() => assert.fail('friend must not call model'));
  for (const side of ['friend', '', undefined]) {
    assert.match((await organizer.execute(side, parse('整理成表格：甲'))).reply, /只供已绑定的本人/u);
  }
});

test('deterministic CJK double-width header, separator and mixed text alignment', () => {
  const original = structuredClone(sample);
  const output = formatTable(sample);
  assert.equal(output, '姓名 | 数量\n-----+-----\n小明 | 0   \nAmy  | 12  ');
  assert.equal(displayWidth('中文Ａab'), 8);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(displayWidth('𠮷'), 2);
  assert.deepEqual(output.split('\n').map(displayWidth), [11, 11, 11, 11]);
  assert.equal(formatTable(sample), output);
  assert.deepEqual(sample, original);
});

test('null, blank and absent cells are missing, zero and false remain facts', () => {
  const output = formatTable({ columns: ['A', 'B', 'C'], rows: [[null, '', '  '], [], [0, false]] });
  assert.equal((output.match(/—/gu) || []).length, 7);
  assert.match(output, /0\s+\| false \| —/u);
  assert.doesNotMatch(output, /undefined|null/u);
});

test('excess rows and columns truncate visibly, exact limits do not warn', () => {
  const columns = Array.from({ length: 7 }, (_, i) => `C${i}`);
  const rows = Array.from({ length: 21 }, (_, i) => columns.map((_, j) => `${i}:${j}`));
  const output = formatTable({ columns, rows });
  const lines = output.split('\n');
  assert.equal(lines.length, 24);
  assert.match(lines[21], /19:5/u);
  assert.doesNotMatch(output, /C6|20:0|0:6/u);
  assert.match(output, /共 21 行，仅显示前 20 行/u);
  assert.match(output, /共 7 列，仅显示前 6 列/u);
  assert.doesNotMatch(formatTable({ columns: columns.slice(0, 6), rows: rows.slice(0, 20).map(row => row.slice(0, 6)) }), /截断/u);
});

test('long headers and cells truncate on display width with ellipsis and note', () => {
  const output = formatTable({ columns: ['a'.repeat(17), '标题'], rows: [['中'.repeat(9), 'a'.repeat(16)]] });
  const lines = output.split('\n');
  assert.ok(lines[0].startsWith(`${'a'.repeat(15)}…`));
  assert.ok(lines[2].startsWith(`${'中'.repeat(7)}… `));
  assert.ok(lines[2].endsWith('a'.repeat(16)));
  assert.match(lines[3], /单元格过长已截断/u);
  assert.deepEqual(lines.slice(0, 3).map(displayWidth), [35, 35, 35]);
});

test('multiline cells and pipes cannot create extra table rows or separators', () => {
  const output = formatTable({ columns: ['项目'], rows: [['甲\n乙\t|丙']] });
  assert.equal(output.split('\n').length, 3);
  assert.ok(output.includes('甲 乙 ｜丙'));
});

test('validates complete result including hidden rows/columns before rendering', () => {
  for (const value of [null, {}, { ...sample, extra: true }, { columns: [], rows: [] },
    { columns: ['A'], rows: ['bad'] }, { columns: ['A'], rows: [[{}]] },
    { columns: ['A'], rows: [[1, 2]] }, { columns: ['A'], rows: [[Infinity]] },
    { columns: ['A'], rows: [...Array.from({ length: 20 }, () => [1]), [{}]] }]) {
    assert.throws(() => validateTable(value));
    assert.throws(() => formatTable(value));
  }
});

test('provider uses isolated existing structured model and stateless executions', async () => {
  const calls = [];
  const organizer = runWithModel(async (...args) => {
    calls.push(args);
    return { ok: true, value: args[3].parse(JSON.stringify(sample)) };
  });
  for (const text of ['甲的资料', '乙的资料']) {
    const result = await organizer.execute('owner', parse(`整理成表格：${text}`));
    assert.equal(result.reply, formatTable(sample));
    assert.equal(result.wrote, false);
  }
  for (const [i, args] of calls.entries()) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].stage, 'table_organizer');
    assert.equal(args[3].schema.additionalProperties, false);
    assert.match(args[0], /不推测、不补充事实/u);
    assert.match(args[0], /缺失值用 null/u);
    assert.deepEqual(JSON.parse(args[0].split('\n').at(-1)), { text: i === 0 ? '甲的资料' : '乙的资料' });
  }
});

test('invalid JSON, invalid schema, auth failure, timeout and thrown model never yield partial tables', async () => {
  const models = [
    async (...args) => ({ ok: true, value: args[3].parse('{broken') }),
    async (...args) => ({ ok: true, value: args[3].parse('```json\n{}\n```') }),
    async () => ({ ok: true, value: { ...sample, rows: [['可见'], [{}]] } }),
    async () => ({ ok: false, authFailed: true }),
    async () => ({ ok: false, error: 'timed out' }),
    async () => { throw Error('offline'); },
    async () => ({ ok: true }),
  ];
  for (const model of models) {
    const result = await runWithModel(model).execute('owner', parse('整理成表格：甲'));
    assert.match(result.reply, /表格整理失败.*未生成表格/u);
    assert.doesNotMatch(result.reply, /姓名|可见|\|/u);
    assert.equal(result.continue, false);
  }
});
