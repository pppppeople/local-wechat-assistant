'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCopyComparisonCommand: parse, createCopyComparison, HELP } = require('../src/copy-comparison-commands');
const { SECTIONS, createCopyComparisonProvider, renderComparison } = require('../src/copy-comparison-provider');
const sample = Object.fromEntries(SECTIONS.map(section => [section, `${section}分析正文`]));
const input = count => `对比文案\n${['一', '二', '三', '四', '五'].slice(0, count).map(n => `版本${n}：原文${n}`).join('\n')}`;
const withModel = model => createCopyComparison({ provider: createCopyComparisonProvider({ model }) });



test('parses 2 to 4 explicitly marked versions and preserves original text', () => {
  for (const count of [2, 3, 4]) {
    const command = parse(input(count));
    assert.equal(command.type, 'compare');
    assert.equal(command.versions.length, count);
    assert.deepEqual(command.versions[0], { label: '版本一', text: '原文一' });
  }
  for (const prefix of ['对比文案\n', '对比文案：', '对比文案: ', '对比文案 ']) {
    assert.deepEqual(parse(`${prefix}版本一：第一行\n  第二行\n版本二: 请发邮件并存入箱子`).versions,
      [{ label: '版本一', text: '第一行\n  第二行' }, { label: '版本二', text: '请发邮件并存入箱子' }]);
  }
  assert.equal(parse('对比文案 版本1:甲 版本2:乙').versions.length, 2);
  assert.equal(parse('对比文案版本一：甲\n版本二：乙').versions.length, 2);
  for (const text of ['普通聊天', '润色：原文', '请对比文案', '对比文案有什么用']) assert.equal(parse(text), null);
});

test('missing, fewer than 2, more than 4 and malformed versions give guidance without model calls', async () => {
  const comparer = withModel(() => assert.fail('invalid input must not call model'));
  for (const text of ['对比文案', '对比文案：', input(1), input(5),
    '对比文案：甲\n乙', '对比文案\n版本一：甲\n版本二：',
    '对比文案\n版本一：甲\n版本一：乙', '对比文案\n未标记原文\n版本一：甲\n版本二：乙']) {
    const result = await comparer.execute('owner', parse(text));
    assert.equal(result.reply, HELP, text);
    assert.equal(result.wrote, false);
    assert.equal(result.continue, false);
  }
});

test('friends are refused before model access even with valid or missing input', async () => {
  const comparer = withModel(() => assert.fail('friend must not call model'));
  for (const side of ['friend', '', undefined]) {
    for (const command of [parse(input(2)), parse('对比文案')]) {
      assert.match((await comparer.execute(side, command)).reply, /只供已绑定的本人/u);
    }
  }
});

test('one isolated structured call per request returns all five sections in fixed order without retaining previous input', async () => {
  const calls = [];
  const comparer = withModel(async (...args) => {
    calls.push(args);
    return { ok: true, value: args[3].parse(JSON.stringify(sample)) };
  });
  for (const count of [2, 3, 4]) {
    const result = await comparer.execute('owner', parse(input(count)));
    assert.equal(result.reply, SECTIONS.map(key => `${key}\n${sample[key]}`).join('\n\n'));
    assert.equal(result.wrote, false);
    assert.equal(result.continue, true);
  }
  assert.equal(calls.length, 3);
  for (const [index, args] of calls.entries()) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].stage, 'copy_comparison');
    assert.deepEqual(args[3].schema.required, SECTIONS);
    assert.equal(args[3].schema.additionalProperties, false);
    assert.match(args[0], /不改写原文，不生成润色稿或合并稿/u);
    assert.match(args[0], /不代发、不读邮箱、不存入任何箱子，不调用任何工具/u);
    assert.deepEqual(JSON.parse(args[0].split('\n').at(-1)), { versions: parse(input(index + 2)).versions });
  }
});

test('each missing or blank section and extra rewrite output rejects the entire result', async () => {
  const invalid = [{ ...sample, draft: '改写草稿' }, { draft: '仅润色的改写输出' }, null, []];
  for (const key of SECTIONS) {
    const missing = { ...sample }; delete missing[key];
    invalid.push(missing, { ...sample, [key]: '  ' }, { ...sample, [key]: [] });
  }
  for (const value of invalid) {
    assert.throws(() => renderComparison(value));
    const result = await withModel(async () => ({ ok: true, value })).execute('owner', parse(input(2)));
    assert.match(result.reply, /文案对比失败.*未生成对比结果/u);
    assert.doesNotMatch(result.reply, /分析正文|改写草稿|改写输出/u);
    assert.equal(result.continue, false);
  }
});

test('model exception, failure with partial data and malformed JSON never return partial comparisons; retry is fresh', async () => {
  const models = [
    async () => { throw Error('offline: partial secret'); },
    async () => ({ ok: false, value: sample }),
    async () => ({ ok: false, authFailed: true }),
    async () => ({ ok: false, error: 'timeout' }),
    async () => ({ ok: true }),
    async (...args) => ({ ok: true, value: args[3].parse('{"总览":"partial secret"') }),
    async (...args) => ({ ok: true, value: args[3].parse('{"总览":"partial secret"}') }),
  ];
  for (const model of models) {
    let failing = true;
    const comparer = withModel((...args) => failing ? model(...args) : { ok: true, value: sample });
    const result = await comparer.execute('owner', parse(input(2)));
    assert.match(result.reply, /文案对比失败.*未生成对比结果/u);
    assert.doesNotMatch(result.reply, /分析正文|partial secret/u);
    failing = false;
    assert.equal((await comparer.execute('owner', parse(input(3)))).reply, renderComparison(sample));
  }
});
