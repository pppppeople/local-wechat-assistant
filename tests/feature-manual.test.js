'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeatureManual, SESSION_MS } = require('../src/feature-manual');
function fixture() {
  let at = 0;
  const manual = createFeatureManual({ now: () => at });
  manual.register({ triggerWord: '示例说明', aliases: ['示例帮助'], intro: '一句话简介。', sections: [
    { title: '用法', keywords: ['怎么用'], body: '简短用法。' },
    { title: '进阶', body: ['上半节。', '下半节。'] },
  ] });
  return { manual, advance: () => { at += SESSION_MS; } };
}
test('manual shows only compact catalog first, then a single selected section with footer', () => {
  const { manual } = fixture();
  const catalog = manual.select('owner', '示例帮助');
  assert.equal(catalog.split('\n').length, 4);
  assert.match(catalog, /一句话简介。\n1 用法\n2 进阶/);
  assert.doesNotMatch(catalog, /简短用法|上半节/);
  assert.equal(manual.select('owner', '1'), '1 用法\n简短用法。\n看用法回：示例说明');
  assert.match(manual.select('owner', '怎么用'), /简短用法/);
  assert.equal(manual.footer('示例说明', catalog), catalog);
});
test('manual long section requires explicit continue, without exposing other sections', () => {
  const { manual } = fixture(); manual.select('owner', '示例说明');
  assert.match(manual.select('owner', '2'), /上半节。[\s\S]*回「继续」看下半节/);
  assert.equal(manual.select('friend', '继续'), null);
  const lower = manual.select('owner', '继续');
  assert.match(lower, /下半节/); assert.doesNotMatch(lower, /上半节|简短用法|回「继续」/);
});
test('manual sessions isolate sides, expire lazily, and exit for another command', () => {
  const { manual, advance } = fixture();
  manual.select('owner', '示例说明'); assert.equal(manual.select('friend', '1'), null);
  manual.select('friend', '示例说明');
  assert.equal(manual.select('owner', '用法', { isCommand: true }), null);
  assert.equal(manual.select('owner', '1'), null);
  assert.match(manual.select('friend', '1'), /简短用法/);
  advance(); assert.equal(manual.select('friend', '1'), null);
});
