'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  changed,
  readResult,
  refused,
  resultText,
  unchanged,
} = require('../src/feature-result');

test('builds the three explicit feature outcomes with their write and continuation flags', () => {
  assert.deepEqual(changed('已保存'), { reply: '已保存', wrote: true, continue: true });
  assert.deepEqual(refused('没有修改'), { reply: '没有修改', wrote: false, continue: false });
  assert.deepEqual(unchanged('已经存在'), { reply: '已经存在', wrote: false, continue: true });
});

test('keeps boundary reply values unchanged', () => {
  assert.deepEqual(changed(''), { reply: '', wrote: true, continue: true });
  assert.deepEqual(refused(null), { reply: null, wrote: false, continue: false });
  assert.deepEqual(unchanged(0), { reply: 0, wrote: false, continue: true });
  assert.deepEqual(unchanged(false), { reply: false, wrote: false, continue: true });
});

test('unwraps result objects while returning primitive and missing values as supplied', () => {
  const objectResult = { reply: '完成', wrote: true, continue: true };
  assert.equal(resultText(objectResult), '完成');
  assert.equal(resultText({ reply: undefined }), undefined);
  assert.equal(resultText({}), undefined);
  assert.equal(resultText(null), null);
  assert.equal(resultText(undefined), undefined);
  assert.equal(resultText('直接回复'), '直接回复');
  assert.equal(resultText(0), 0);
  assert.equal(resultText(false), false);
});

test('normalizes string results and preserves structured result identity', () => {
  assert.deepEqual(readResult('直接回复'), {
    reply: '直接回复',
    wrote: false,
    continue: true,
  });
  assert.deepEqual(readResult(''), { reply: '', wrote: false, continue: true });

  const structured = changed('已保存');
  assert.equal(readResult(structured), structured);
  assert.equal(readResult(null), null);
  assert.equal(readResult(undefined), undefined);
  assert.equal(readResult(0), 0);
});
