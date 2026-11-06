'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShoppingComparisonCommand: parse, createShoppingComparison } = require('../src/shopping-comparison-commands');
const { createShoppingComparisonProvider, validateComparison } = require('../src/shopping-comparison-provider');
const sample = { dimensions: ['价格', '重量', '续航'], products: [
  { name: 'A耳机', values: ['200元', '20克', null] },
  { name: 'B耳机', values: ['100元'] },
  { name: 'C耳机', values: ['150元', null, '8小时'] },
] };
const input = 'A耳机 价格200元 重量20克；B耳机 价格100元；C耳机 价格150元 续航8小时';
const create = model => createShoppingComparison({ provider: createShoppingComparisonProvider({ model }) });
const modelFor = value => async (...args) => ({ ok: true, value: args[3].parse(JSON.stringify(value)) });
const execute = (value = sample, text = input) => create(modelFor(value)).execute('owner', parse(`购物对比：${text}`));
const names = reply => reply.split('\n').filter(line => /^[ABC]耳机/u.test(line)).map(line => line.split(' ')[0]);



test('friends refused without invoking provider', async () => {
  const service = create(() => assert.fail('friends cannot call model'));
  for (const side of ['friend', undefined, '']) {
    const result = await service.execute(side, parse(`购物对比：${input}`));
    assert.match(result.reply, /只供已绑定的本人/u);
    assert.equal(result.continue, false);
    assert.equal(result.wrote, false);
  }
});

test('three products, multiple dimensions, unknown null/absent cells and original order', async () => {
  const result = await execute();
  assert.match(result.reply, /商品.*价格.*重量.*续航/u);
  assert.equal((result.reply.match(/未知/gu) || []).length, 4);
  assert.deepEqual(names(result.reply), ['A耳机', 'B耳机', 'C耳机']);
  assert.match(result.reply, /未指定.*保持主人提供顺序/u);
  assert.equal(result.wrote, false);
  assert.equal(result.continue, true);
  assert.deepEqual(names((await execute({ ...sample, products: [...sample.products].reverse() })).reply), ['A耳机', 'B耳机', 'C耳机']);
});

test('six products and seven dimensions are refused, never truncated', async () => {
  for (const [productCount, dimensionCount] of [[6, 2], [2, 7]]) {
    const value = { dimensions: Array.from({ length: dimensionCount }, (_, i) => `维度${i}`),
      products: Array.from({ length: productCount }, (_, i) => ({ name: `商品${i}`, values: [] })) };
    const result = await execute(value, JSON.stringify(value));
    assert.match(result.reply, /最多支持 5 个商品、6 个维度.*超出上限/u);
    assert.equal(result.continue, false);
    assert.doesNotMatch(result.reply, /\|/u);
  }
});

test('five products and six dimensions render all seven columns', async () => {
  const value = { dimensions: Array.from({ length: 6 }, (_, i) => `维度${i}`),
    products: Array.from({ length: 5 }, (_, i) => ({ name: `商品${i}`, values: [0, false] })) };
  const result = await execute(value, JSON.stringify(value));
  assert.match(result.reply, /维度5/u);
  assert.match(result.reply, /商品4/u);
  assert.match(result.reply, /0.*false/u);
  assert.doesNotMatch(result.reply, /截断|上限/u);
});

test('explicit price ascending/descending sorting and stable ties', async () => {
  assert.deepEqual(names((await execute(sample, `${input}；按价格从低到高`)).reply), ['B耳机', 'C耳机', 'A耳机']);
  assert.deepEqual(names((await execute(sample, `${input}；按价格降序`)).reply), ['A耳机', 'C耳机', 'B耳机']);
  const tied = structuredClone(sample); tied.products[2].values[0] = '100元';
  assert.deepEqual(names((await execute(tied, `${input.replace('150元', '100元')}；按价格升序`)).reply), ['B耳机', 'C耳机', 'A耳机']);
});

test('non-numeric, missing, unknown and mixed unit sort dimensions preserve input order', async () => {
  for (const condition of ['按颜色升序', '按重量升序', '按续航降序']) {
    const result = await execute(sample, `${input}；${condition}`);
    assert.deepEqual(names(result.reply), ['A耳机', 'B耳机', 'C耳机']);
    assert.match(result.reply, /保持主人提供顺序/u);
  }
  const mixed = structuredClone(sample); mixed.products[1].values[0] = '100美元';
  assert.deepEqual(names((await execute(mixed, `${input.replace('100元', '100美元')}；按价格升序`)).reply), ['A耳机', 'B耳机', 'C耳机']);
});

test('unprovided values become unknown instead of fabricated facts', async () => {
  const value = structuredClone(sample); value.products[0].values[2] = '99小时';
  const result = await execute(value);
  assert.doesNotMatch(result.reply, /99小时/u);
  assert.equal((result.reply.match(/未知/gu) || []).length, 4);
});

test('provider calls existing isolated structured channel with only current input', async () => {
  const calls = [];
  const service = create(async (...args) => { calls.push(args); return modelFor(sample)(...args); });
  await service.execute('owner', parse(`购物对比：${input}`));
  await service.execute('owner', parse(`购物对比 ${input}；按价格升序`));
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.equal(args[1], ''); assert.deepEqual(args[2], []);
    assert.equal(args[3].stage, 'shopping_comparison');
    assert.equal(args[3].schema.additionalProperties, false);
    assert.equal(args[3].schema.properties.products.maxItems, undefined);
    assert.equal(args[3].schema.properties.dimensions.maxItems, undefined);
    assert.match(args[0], /保留全部商品和维度/u);
    assert.match(args[0], /不排序、不排名/u);
    assert.equal(typeof JSON.parse(args[0].split('\n').at(-1)).text, 'string');
  }
});

test('model failure/invalid JSON/schema yields explicit failure, no partial table', async () => {
  for (const model of [async () => { throw Error('offline'); }, async () => ({ ok: false, authFailed: true }),
    async () => ({ ok: false, error: 'timeout' }), async (...args) => ({ ok: true, value: args[3].parse('{broken') }),
    async () => ({ ok: true }), modelFor({ ...sample, extra: true }),
    modelFor({ ...sample, products: [{ name: 'invented', values: [] }] })]) {
    const result = await create(model).execute('owner', parse(`购物对比：${input}`));
    assert.match(result.reply, /购物对比失败.*未生成对比表/u);
    assert.doesNotMatch(result.reply, /A耳机|\|/u);
    assert.equal(result.continue, false);
  }
  for (const value of [null, {}, { dimensions: [], products: [] },
    { dimensions: ['价格'], products: [{ name: '甲', values: [Infinity] }] }]) assert.throws(() => validateComparison(value));
});
