'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseImageDiffCommand: parse } = require('../src/image-diff-commands');
const { createImageDiffStore } = require('../src/image-diff-store');
const { createImageDiffProvider, parseDiff } = require('../src/image-diff-provider');
const { readRecordState } = require('../src/record-state');
const DIFF = { differences: ['按钮从灰色变为蓝色'], unchanged: ['标题未变化'], uncertain: ['小字看不清'] };
function fixture(t, compare = () => structuredClone(DIFF)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state/image-diff/state.json');
  const first = path.join(root, 'first.png'), second = path.join(root, 'second.png');
  fs.writeFileSync(first, 'first-image'); fs.writeFileSync(second, 'second-image');
  let clock = Date.parse('2026-10-31T00:00:00Z');
  const calls = [];
  const provider = { compare: async args => { calls.push(args); return compare(args); } };
  const store = createImageDiffStore({ stateFile, provider, now: () => clock });
  const read = () => readRecordState(stateFile);
  return { root, stateFile, first, second, store, calls, provider, read,
    copy: () => path.join(path.dirname(stateFile), 'images', read().pending[0].file),
    advance: ms => { clock += ms; },
    run: (text, images = [], side = 'owner') => store.execute(side, parse(text, images)),
  };
}



test('only owner image keywords or text-only exact cancellation claim; ordinary Q&A and action extraction stay out', () => {
  for (const text of ['对比一下', '看看差异', '这是第一张', '第二张']) {
    assert.equal(parse(text, ['a.png']).type, 'compare');
    assert.equal(parse(text), null);
    assert.equal(parse(text, ['friend.png'], 'friend'), null);
  }
  for (const text of ['这张图是什么？', '帮我读一下截图', '提取行动项', '提取行动项：对比第一张差异', '普通聊天']) {
    assert.equal(parse(text, ['a.png']), null);
  }
  assert.deepEqual(parse('取消对比'), { type: 'cancel' });
  assert.equal(parse('请取消对比'), null);
  assert.equal(parse('取消对比', [], 'friend'), null);
});

test('managed copy survives inbound cleanup, classified record reopens, success uses exactly two ordered images then deletes copy and body', async t => {
  const f = fixture(t);
  assert.equal((await f.run('第一张', [f.first])).reply, '已存为第一张，再发第二张');
  assert.equal(f.calls.length, 0);
  const copy = f.copy();
  assert.notEqual(copy, f.first);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'first-image');
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(index._recordState.version, 1);
  const body = path.join(path.dirname(f.stateFile), index.pending[0].file);
  assert.doesNotMatch(fs.readFileSync(body, 'utf8'), new RegExp(f.first));
  fs.rmSync(f.first);
  const reopened = createImageDiffStore({ stateFile: f.stateFile, provider: f.provider,
    now: () => Date.parse('2026-10-31T00:01:00Z') });
  const result = await reopened.execute('owner', parse('第二张', [f.second]));
  assert.match(result.reply, /差异点\n- 按钮.*\n\n未变化\n- 标题.*\n\n无法判断\n- 小字/su);
  assert.match(result.reply, /模型判断，请人工核对/u);
  assert.deepEqual(f.calls, [{ text: '第二张', imagePaths: [copy, f.second] }]);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(fs.existsSync(body), false);
  assert.equal(fs.existsSync(f.second), true, 'store never deletes inbound files');
  assert.deepEqual(f.read().pending, []);
});

test('replacement retains at most one copy; cancel removes it and its record', async t => {
  const f = fixture(t);
  await f.run('对比', [f.first]);
  const old = f.copy();
  assert.match((await f.run('第一张重新来', [f.second])).reply, /替换.*已存为第一张/u);
  const copy = f.copy();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'second-image');
  assert.equal(fs.readdirSync(path.dirname(copy)).length, 1);
  assert.equal(f.calls.length, 0);
  assert.match((await f.run('取消对比')).reply, /已取消对比/u);
  assert.equal(fs.existsSync(copy), false);
  assert.deepEqual(f.read().pending, []);
  assert.match((await f.run('取消对比')).reply, /没有待对比/u);
});

test('30-minute lazy expiry clears old copy; late second becomes new first without model call', async t => {
  const f = fixture(t);
  await f.run('第一张', [f.first]);
  const old = f.copy();
  f.advance(30 * 60 * 1000);
  assert.equal(fs.existsSync(old), true);
  assert.match((await f.run('第二张', [f.second])).reply, /已过期.*新的第一张.*已存为第一张/u);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(f.copy(), 'utf8'), 'second-image');
  assert.equal(f.calls.length, 0);
  f.advance(30 * 60 * 1000);
  const newer = f.copy();
  await f.run('取消对比');
  assert.equal(fs.existsSync(newer), false);
});

test('failed/invalid model result is discarded as whole, retains first and original TTL for retry', async t => {
  for (const bad of [null, { differences: [] }, { ...DIFF, uncertain: [7] }, { ...DIFF, extra: [] }, 'not JSON']) {
    let output = bad;
    const f = fixture(t, () => output);
    await f.run('第一张', [f.first]);
    const copy = f.copy(), before = f.read();
    const failed = await f.run('对比', [f.second]);
    assert.equal(failed.wrote, false);
    assert.match(failed.reply, /作废.*第一张仍保留/u);
    assert.deepEqual(f.read(), before);
    assert.equal(fs.existsSync(copy), true);
    output = DIFF;
    assert.match((await f.run('差异', [f.second])).reply, /差异点/u);
    assert.equal(fs.existsSync(copy), false);
    assert.equal(f.calls.length, 2);
  }
  const f = fixture(t, () => { throw Error('offline'); });
  await f.run('第一张', [f.first]);
  assert.match((await f.run('第二张', [f.second])).reply, /第一张仍保留/u);
});

test('friend/unsupported commands never touch storage or provider; multi-image input refuses without replacing', async t => {
  const f = fixture(t);
  for (const command of [null, { type: 'bogus' }]) await f.store.execute('owner', command);
  await f.store.execute('friend', parse('第一张', [f.first]));
  assert.equal(fs.existsSync(f.stateFile), false);
  await f.run('第一张', [f.first]);
  const before = f.read(), copy = f.copy();
  assert.match((await f.run('第一张', [f.first, f.second])).reply, /只发一张/u);
  assert.deepEqual(f.read(), before);
  assert.equal(fs.existsSync(copy), true);
  assert.equal(f.calls.length, 0);
});

test('strict corrupt index/body/path failures quarantine without calling provider or deleting copy', async t => {
  for (const damage of ['json', 'schema', 'body', 'missing', 'path']) {
    const f = fixture(t);
    await f.run('第一张', [f.first]);
    const copy = f.copy();
    const body = path.join(path.dirname(f.stateFile), JSON.parse(fs.readFileSync(f.stateFile)).pending[0].file);
    if (damage === 'json') fs.writeFileSync(f.stateFile, '{');
    if (damage === 'schema') fs.writeFileSync(f.stateFile, '{"schemaVersion":1,"pending":{}}');
    if (damage === 'body') fs.writeFileSync(body, '{}');
    if (damage === 'missing') fs.rmSync(body);
    if (damage === 'path') {
      const record = JSON.parse(fs.readFileSync(body)); record.file = '../first.png';
      fs.writeFileSync(body, JSON.stringify(record));
    }
    await assert.rejects(f.run('第二张', [f.second]), /损坏，已隔离保全/u);
    assert.equal(fs.existsSync(copy), true);
    assert.equal(f.calls.length, 0);
  }
});

test('provider makes one fresh strict-schema multi-image call and validates transport plus injected results', async () => {
  let calls = 0;
  const provider = createImageDiffProvider({ model: async (...args) => {
    calls++;
    assert.equal(args[1], '');
    assert.deepEqual(args[2], ['one.png', 'two.png']);
    assert.equal(args[3].schema.additionalProperties, false);
    assert.deepEqual(args[3].schema.required, ['differences', 'unchanged', 'uncertain']);
    assert.equal(args[3].stage, 'image_diff');
    return { ok: true, value: args[3].parse(JSON.stringify(DIFF)) };
  } });
  assert.deepEqual(await provider.compare({ text: '对比', imagePaths: ['one.png', 'two.png'] }), DIFF);
  assert.equal(calls, 1);
  for (const value of ['not JSON', '{"differences":[]}', JSON.stringify({ ...DIFF, unchanged: [' '] }),
    JSON.stringify({ ...DIFF, extra: true })]) assert.throws(() => parseDiff(value));
  assert.deepEqual(parseDiff('{"differences":[],"unchanged":[],"uncertain":[]}'),
    { differences: [], unchanged: [], uncertain: [] });
  for (const response of [{ ok: false }, { ok: true, value: { differences: [] } }]) {
    await assert.rejects(createImageDiffProvider({ model: async () => response })
      .compare({ text: '对比', imagePaths: ['one.png', 'two.png'] }));
  }
});

test('serialized first and second share one copy; failed replacement leaves previous first usable', async t => {
  const f = fixture(t);
  await f.run('第一张', [f.first]);
  const copy = f.copy(), before = f.read();
  await assert.rejects(f.run('第一张', [path.join(f.root, 'missing.png')]));
  assert.deepEqual(f.read(), before);
  assert.equal(fs.existsSync(copy), true);
  assert.deepEqual(fs.readdirSync(path.dirname(copy)), [path.basename(copy)]);
  await f.run('取消对比');
  const results = await Promise.all([f.run('第一张', [f.first]), f.run('第二张', [f.second])]);
  assert.match(results[0].reply, /已存为第一张/u);
  assert.match(results[1].reply, /差异点/u);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.read().pending, []);
  assert.deepEqual(fs.readdirSync(path.dirname(copy)), []);
});

test('missing managed copy fails as storage error before model without claiming it is retained', async t => {
  const f = fixture(t);
  await f.run('第一张', [f.first]);
  fs.rmSync(f.copy());
  await assert.rejects(f.run('第二张', [f.second]), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
});
