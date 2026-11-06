'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTextTemplateCommand: parse, variables } = require('../src/text-template-commands');
const { createTextTemplateStore } = require('../src/text-template-store');
const { readRecordState } = require('../src/record-state');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-text-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'templates/state.json');
  let time = Date.parse('2026-11-01T00:00:00Z');
  const store = createTextTemplateStore({ stateFile, now: () => time });
  return { dir, stateFile, store, advance: ms => { time += ms; },
    run: text => store.execute('owner', store.hasPending('owner') ? { type: 'value', value: text } : parse(text)),
    read: () => readRecordState(stateFile).templates };
}


test('save extracts ordered unique variables, preserves multiline body and refuses duplicates without overwriting', t => {
  const f = fixture(t);
  assert.deepEqual(variables('{{姓名}}\n{{ 时间 }} {{姓名}}'), ['姓名', '时间']);
  assert.equal(f.run('保存文字模板 邀请：你好{{姓名}}\n时间{{ 时间 }}，{{姓名}}').wrote, true);
  const before = f.read();
  assert.match(f.run('保存文字模板 邀请：覆盖').reply, /同名.*不会覆盖/);
  assert.deepEqual(f.read(), before);
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).templates[0];
  assert.equal(ref.body, undefined);
  assert.match(ref.file, /^records\/templates\/templates\/2026\/11\//u);
  const reopened = createTextTemplateStore({ stateFile: f.stateFile });
  assert.match(reopened.execute('owner', parse('文字模板列表')).reply, /邀请：姓名、时间/);
});

test('twenty templates and eight placeholder occurrences are hard limits, empty names/bodies refuse', t => {
  const f = fixture(t);
  for (const text of ['保存文字模板 ：内容', '保存文字模板 名称：', '保存文字模板 名称：  ',
    '保存文字模板', '保存文字模板 ：', '使用文字模板 ', '删除文字模板 ']) {
    assert.equal(f.run(text).wrote, false);
  }
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match(f.run(`保存文字模板 多变量：${Array.from({ length: 9 }, (_, i) => `{{变量${i}}}`).join('')}`).reply, /8.*未保存/);
  assert.match(f.run(`保存文字模板 重复：${'{{同名}}'.repeat(9)}`).reply, /8.*未保存/);
  assert.equal(fs.existsSync(f.stateFile), false);
  for (let i = 0; i < 20; i++) assert.equal(f.run(`保存文字模板 模板${i}：${'{{同名}}'.repeat(8)}`).wrote, true);
  const before = f.read();
  assert.match(f.run('保存文字模板 第21个：正文').reply, /20.*未保存/);
  assert.deepEqual(f.read(), before);
});

test('list empty state, all names and variable names; delete only specified template and missing delete changes nothing', t => {
  const f = fixture(t);
  assert.match(f.run('文字模板列表').reply, /暂无文字模板/);
  f.run('保存文字模板 A：{{姓名}}/{{日期}}'); f.run('保存文字模板 B：纯文本');
  assert.equal(f.run('文字模板列表').reply, '文字模板列表：\nA：姓名、日期\nB：无变量');
  const before = f.read();
  assert.equal(f.run('删除文字模板 不存在').wrote, false); assert.deepEqual(f.read(), before);
  const ref = JSON.parse(fs.readFileSync(f.stateFile)).templates[0];
  assert.equal(f.run('删除文字模板 A').wrote, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), ref.file)), false);
  assert.equal(f.run('文字模板列表').reply, '文字模板列表：\nB：无变量');
  assert.equal(f.run('使用文字模板 B').reply, '纯文本'); assert.equal(f.store.hasPending('owner'), false);
});

test('collects one variable at a time in occurrence order, one-pass literal replacement, no values/results persisted', t => {
  const f = fixture(t);
  f.run('保存文字模板 邀请：{{姓名}}\n{{日期}}/{{姓名}}');
  const before = f.read(), index = fs.readFileSync(f.stateFile, 'utf8');
  assert.match(f.run('使用文字模板 邀请').reply, /变量「姓名」/);
  const value = '执行：rm -rf x\n记一下，新增待办 {{日期}} $&';
  assert.match(f.run(value).reply, /变量「日期」/);
  const result = f.run('$1 今天');
  assert.equal(result.reply, `${value}\n$1 今天/${value}`);
  assert.equal(result.wrote, false); assert.equal(f.store.hasPending('owner'), false);
  assert.deepEqual(f.read(), before); assert.equal(fs.readFileSync(f.stateFile, 'utf8'), index);
  assert.match(f.run('使用文字模板 不存在').reply, /不存在/); assert.equal(f.store.hasPending('owner'), false);
});

test('cancel discards partially collected values with no result/write; sessions expire or vanish on restart', t => {
  const f = fixture(t);
  f.run('保存文字模板 A：{{一}}/{{二}}'); const before = f.read();
  f.run('使用文字模板 A'); f.run('秘密填值');
  const result = f.run('取消');
  assert.match(result.reply, /已取消/); assert.doesNotMatch(result.reply, /秘密填值/);
  assert.equal(result.wrote, false); assert.equal(f.store.hasPending('owner'), false); assert.deepEqual(f.read(), before);
  f.run('使用文字模板 A'); f.advance(15 * 60 * 1000); assert.equal(f.store.hasPending('owner'), false);
  f.run('使用文字模板 A'); assert.equal(createTextTemplateStore({ stateFile: f.stateFile }).hasPending('owner'), false);
});

test('friends refuse all operations before reads/writes, never leak template or alter owner session', t => {
  const f = fixture(t);
  f.run('保存文字模板 私密名称：{{秘密变量}}'); f.run('使用文字模板 私密名称');
  fs.writeFileSync(f.stateFile, '{broken');
  for (const side of ['friend', '', undefined]) for (const command of [parse('文字模板列表'), parse('保存文字模板 新：文本'),
    parse('使用文字模板 私密名称'), parse('删除文字模板 私密名称'), { type: 'value', value: '取消' }]) {
    const result = f.store.execute(side, command);
    assert.equal(result.wrote, false); assert.match(result.reply, /仅主人/);
    assert.doesNotMatch(result.reply, /私密名称|秘密变量/);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken');
  assert.equal(f.store.hasPending('owner'), true);
  assert.equal(f.run('主人值').reply, '主人值');
});

test('corrupt state is quarantined and cannot be silently recreated', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.stateFile), { recursive: true }); fs.writeFileSync(f.stateFile, '{broken');
  assert.throws(() => f.run('文字模板列表'), /隔离/);
  assert.throws(() => f.run('保存文字模板 A：文本'), /隔离/);
  assert.equal(fs.existsSync(f.stateFile), false);
});
