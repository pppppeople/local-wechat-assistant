'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseDateProposalCommand: parse } = require('../src/date-proposal-commands');
const { createDateProposalStore, VIEW_TTL_MS } = require('../src/date-proposal-store');
const { createDateProposalProvider, readProposalPlaces } = require('../src/date-proposal-provider');
const { createAmapPlaceProvider } = require('../src/amap-place-provider');
const { readRecordState, writeRecordState } = require('../src/record-state');

const bound = text => parse(text, { bound: true });
const place = (name, status = 'active', extra = {}) => ({ name, status, address: '测试市示例路', city: '测试市',
  provider: 'amap', providerId: name, category: '咖啡馆', longitude: 113, latitude: 23, ...extra });
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'date-proposal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T00:00:00Z');
  const stateFile = path.join(root, 'state.json');
  const store = createDateProposalStore({ stateFile, now: () => time,
    readPlaces: () => [place('待去咖啡'), place('旧咖啡', 'visited')],
    provider: { canSearch: false, canRoute: false }, ...extra });
  return { root, stateFile, store, say: (text, side = 'owner') => store.handle(side, bound(text)),
    advance: ms => { time += ms; }, state: () => readRecordState(stateFile) };
}



test('bounded parsing extracts conditions and saved origins, never claims unbound or existing pair commands', () => {
  const cmd = bound('出行提案：离咱俩都近、安静点的咖啡馆；城市：测试市；Owner出发：甲站；好友出发：乙站');
  assert.equal(cmd.category, '咖啡馆'); assert.equal(cmd.near, true);
  assert.equal(cmd.city, '测试市'); assert.deepEqual(cmd.origins, { owner: '甲站', friend: '乙站' });
  assert.deepEqual(bound('就它了 2'), { type: 'select', index: 2 });
  for (const text of ['出行提案：咖啡馆', '就它了 1']) assert.equal(parse(text), null);
  for (const text of ['抽签：甲、乙', '再抽一次', '来一轮默契挑战', '默契答 A', '查看双人决策',
    '今晚吃火锅还是日料？', '决策 #PD-1：首选1', '他说出行提案：咖啡馆', '就它了', '就它了 4']) assert.equal(bound(text), null);
});

test('assembly prioritizes unvisited, includes verified POIs, ranks near by slower ETA inside priority', async t => {
  const origins = [place('甲站', 'visited', { category: '车站' }), place('乙站', 'visited', { category: '车站' })];
  const calls = [];
  const f = fixture(t, {
    readPlaces: () => [...origins, place('慢咖啡'), place('快咖啡'), place('旧咖啡', 'visited')],
    provider: { canSearch: true, canRoute: true,
      search: async (category, city) => { assert.equal(category, '咖啡馆'); assert.equal(city, '测试市');
        return [place('新咖啡', 'active', { rating: 5, openingHours: '24小时' }), place('快咖啡')]; },
      route: async (origin, destination) => { calls.push([origin.name, destination.name]);
        return { durationSeconds: destination.name === '慢咖啡' ? 1200 : destination.name === '快咖啡' ? 650 : 60 }; } },
  });
  const text = await f.say('出行提案：离咱俩都近、安静点的咖啡馆；城市：测试市；Owner出发：甲站；好友出发：乙站');
  assert.match(text, /1\. 快咖啡/); assert.match(text, /2\. 慢咖啡/); assert.match(text, /3\. 旧咖啡/);
  assert.match(text, /步行约11分钟/); assert.match(text, /安静、预算、评分、营业状态及其他条件未核/);
  assert.doesNotMatch(text, /24小时|5分|距离|公里/);
  assert.equal(calls.length, 8); assert.equal(fs.existsSync(f.stateFile), false);
  await f.say('就它了 1');
  const saved = f.state().proposals[0];
  assert.equal(saved.place.name, '快咖啡');
  assert.equal(saved.place.rating, undefined); assert.equal(saved.place.openingHours, undefined);
  assert.equal(saved.place.longitude, undefined); assert.equal(saved.origins, undefined);
});

test('missing routes stay independently unverified, no points means no provider call, no fabricated candidates', async t => {
  let calls = 0;
  const f = fixture(t, { readPlaces: () => [place('甲站', 'visited', { category: '车站' }), place('咖啡')],
    provider: { canSearch: false, canRoute: true, route: async () => { calls++; return null; } } });
  const text = await f.say('出行提案：安静咖啡馆');
  assert.equal(calls, 0); assert.match(text, /Owner：路线未核；好友：路线未核/);
  assert.match(text, /仅有 1 个可核候选/); assert.doesNotMatch(text, /\d+分钟|评分：|营业：/);
  await f.say('出行提案：咖啡馆；Owner出发：甲站'); assert.equal(calls, 1);
  const none = fixture(t, { readPlaces: () => [] });
  assert.match(await none.say('出行提案：咖啡馆'), /没有生成提案/);
  assert.equal(fs.existsSync(none.stateFile), false);
});

test('one explicit selection writes one classified record; side-scoped views, expiry, restart and deletion', async t => {
  const f = fixture(t);
  await f.say('出行提案：咖啡馆');
  assert.match(await f.say('就它了 1', 'friend'), /不存在/);
  await f.say('就它了 1'); await f.say('就它了 2');
  assert.equal(f.state().proposals.length, 1);
  const index = JSON.parse(fs.readFileSync(f.stateFile));
  assert.match(index.proposals[0].file, /^records\/proposals\/date_proposal\/2026\/10\//);
  const restored = createDateProposalStore({ stateFile: f.stateFile });
  assert.match(await restored.handle('owner', bound('就它了 1')), /不存在/);
  await f.say('出行提案：咖啡馆', 'friend'); await f.say('就它了 2', 'friend');
  assert.equal(f.state().proposals.length, 2);
  f.store.deleteSide('friend'); assert.equal(f.state().proposals.length, 1);
  await f.say('出行提案：咖啡馆'); f.advance(VIEW_TTL_MS);
  assert.match(await f.say('就它了 1'), /过期/); assert.equal(f.state().proposals.length, 1);
});

test('map adapter reuses existing calls and rejects absent/zero duration normalized by existing map code', async () => {
  const urls = [];
  let missing = false;
  const map = createAmapPlaceProvider({ apiKey: 'synthetic-test-key', fetchImpl: async url => {
    urls.push(new URL(url));
    return { ok: true, json: async () => ({ status: '1', route: { paths: [missing ? { distance: '10' } : { duration: '321', distance: '10' }] } }) };
  } });
  const adapter = createDateProposalProvider(map);
  assert.deepEqual(await adapter.route(place('甲'), place('乙')), { durationSeconds: 321 });
  assert.equal(urls[0].pathname, '/v3/direction/walking');
  assert.equal(urls[0].searchParams.get('origin'), '113,23');
  assert.equal(urls[0].searchParams.has('name'), false);
  missing = true; assert.equal(await adapter.route(place('甲'), place('乙')), null);
  assert.equal(await adapter.route({}, place('乙')), null);
  assert.equal(urls.length, 2);
  const fallback = createDateProposalProvider({ available: true, fullCapabilities: false,
    searchPlace() { throw new Error('must not call'); }, walkingRoute() { throw new Error('must not call'); } });
  assert.equal(fallback.canSearch, false); assert.equal(fallback.canRoute, false);
  assert.deepEqual(await fallback.search('咖啡', '测试市'), []);
  assert.equal(await fallback.route(place('甲'), place('乙')), null);
});
