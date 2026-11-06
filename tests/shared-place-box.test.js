'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { parseSharedPlaceCommand } = require('../src/shared-place-commands');
const { createSharedPlaceBox, sharedPlaceHelp } = require('../src/shared-place-box');
const {
  amapRoutable, createAmapPlaceProvider, createOpenPlaceProvider, createPlaceProvider,
} = require('../src/amap-place-provider');
const { createDayPlan, estimateVisitMinutes, sameDayRegion } = require('../src/shared-place-day-planner');
const { readRecordState } = require('../src/record-state');

test('deleting one participant purges their current and removed records without touching the other side', (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(stateFile, JSON.stringify({ places: [
    { id: 'SP-FRIEND-1', name: '朋友地点', addedBy: 'friend', status: 'active' },
    { id: 'SP-FRIEND-2', name: '朋友旧地点', addedBy: 'friend', status: 'removed' },
    { id: 'SP-Owner', name: '本人地点', addedBy: 'owner', status: 'active' },
  ] }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  box.status();
  const previous = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(box.deleteSide('friend').removed, 1);
  assert.deepEqual(readRecordState(stateFile).places.map((record) => record.id), ['SP-Owner']);
  for (const reference of previous.places.filter((entry) => entry.id.startsWith('SP-FRIEND'))) {
    assert.equal(fs.existsSync(path.join(directory, reference.file)), false);
  }
});

function tempState() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-place-box-'));
  return { directory, stateFile: path.join(directory, 'state.json') };
}

function fakeProvider() {
  return {
    available: true,
    async searchPlace(query) {
      if (query === '示例街区') return [
        { provider: 'amap', providerId: 'poi-1', name: '示例街区', address: '甲城市甲城区区示例路', city: '甲城市', district: '甲城区区', adcode: '990103', longitude: 105.238, latitude: 32.116, category: '风景名胜', tags: ['户外'] },
        { provider: 'amap', providerId: 'poi-2', name: '示例街区二期', address: '甲城市甲城区区', city: '甲城市', district: '甲城区区', adcode: '990103', longitude: 105.239, latitude: 32.117, category: '风景名胜', tags: ['户外'] },
      ];
      return [{ provider: 'amap', providerId: `poi-${query}`, name: query, address: '乙城市丙城区区', city: '乙城市', district: '丙城区区', adcode: '990606', longitude: 105.22, latitude: 31.82, category: '商场', tags: ['室内'] }];
    },
    async weather(place, date) {
      return { city: place.district, date, reportTime: '2026-08-11 20:00:00', dayWeather: '阵雨', nightWeather: '多云', dayTemp: '32', nightTemp: '27', dayWind: '南', dayPower: '3' };
    },
    async nearby() {
      return [{ provider: 'amap', providerId: 'near-1', name: '附近咖啡馆', address: '附近', city: '乙城市', district: '丙城区区', adcode: '990606', longitude: 105.221, latitude: 31.821, category: '咖啡厅', tags: ['室内'] }];
    },
    async walkingRoute() { return { distanceMeters: 650, durationSeconds: 540 }; },
  };
}

test('adds and lists a place when the map provider is unavailable', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.available = false;
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  const reply = await box.handle('owner', { type: 'add', name: '测试地点甲', note: '' });
  assert.match(reply, /先把测试地点甲放进我们共用的想去箱啦/);
  assert.match(reply, /当前还没配置地图服务/);
  assert.match(await box.handle('owner', { type: 'list' }), /测试地点甲/);
});

test('reports a duplicate place when the map provider is unavailable', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.available = false;
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  await box.handle('owner', { type: 'add', name: '测试地点甲', note: '' });
  const reply = await box.handle('owner', { type: 'add', name: '测试地点甲', note: '' });
  assert.match(reply, /测试地点甲已经在想去箱里啦/);
});

test('reports a duplicate place after selecting the same candidate twice', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  const prompt = await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  assert.match(prompt, /1\. 示例街区/);
  assert.match(prompt, /2\. 示例街区二期/);
  assert.match(await box.handle('owner', { type: 'select', index: 1 }), /示例街区.*放进/u);
  await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  const reply = await box.handle('owner', { type: 'select', index: 1 });
  assert.match(reply, /示例街区已经在想去箱里啦/);
});

test('recommends a standalone theme park day with a late lunch break', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = {
    available: true,
    async searchPlace() {
      return [{
        provider: 'test', providerId: 'synthetic-park', name: '示例游乐园', address: '甲城市乙城区区',
        city: '甲城市', district: '乙城区区', adcode: '990113', longitude: 105.3,
        latitude: 32.0, category: '主题乐园', tags: ['户外'],
      }];
    },
    async weather(place, date) {
      return { city: place.district, date, dayWeather: '多云', nightWeather: '多云', dayTemp: '30', nightTemp: '25' };
    },
    async routeMatrix(places) {
      return places.map(() => places.map(() => ({ distanceMeters: 0, durationSeconds: 0 })));
    },
  };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  await box.handle('owner', { type: 'add', name: '示例游乐园', note: '' });
  const reply = await box.handle('owner', {
    type: 'recommend', date: '2026-08-12', label: '今天', energy: 'balanced', focus: '',
  });
  assert.match(reply, /今天的一日路线建议/);
  assert.match(reply, /这一站更适合单独玩/);
  assert.match(reply, /15:00–16:00 午饭 \/ 休息/);
});

test('requires explicit unambiguous names before marking places visited', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  assert.match(await box.handle('owner', { type: 'visited', names: [] }), /请明确要标记的地点名称/);
  const missing = await box.handle('owner', { type: 'visited', names: ['不存在的地点'] });
  assert.match(missing, /想去箱里没有找到/);
  assert.match(missing, /这次没有修改任何地点/);
  await box.handle('owner', { type: 'add', name: '示例园区甲', note: '' });
  await box.handle('owner', { type: 'add', name: '示例园区乙', note: '' });
  const ambiguous = await box.handle('owner', { type: 'visited', names: ['示例园区'] });
  assert.match(ambiguous, /箱子里有几个相近地点/);
  assert.match(ambiguous, /示例园区甲/);
  assert.match(ambiguous, /示例园区乙/);
  assert.match(ambiguous, /这次没有修改任何地点/);
  const visited = await box.handle('owner', { type: 'visited', names: ['示例园区甲', '示例园区乙'] });
  assert.match(visited, /示例园区甲/);
  assert.match(visited, /示例园区乙/);
  assert.match(visited, /都标成去过啦/);
});

test('rejects selection when no place confirmation is pending', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  assert.match(await box.handle('owner', { type: 'select', index: 1 }), /现在没有等待你确认的地点/);
});

test('rejects an out-of-range command selection with pending candidates', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  const prompt = await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  assert.match(prompt, /1\. 示例街区/);
  assert.match(prompt, /2\. 示例街区二期/);
  assert.equal(await box.handle('owner', { type: 'select', index: 9 }), '只能选择刚才列出的 1～3。');
});

test('rejects semantic selection with a stale pending token without writing', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  const { pendingToken } = box.intentContext('owner');
  assert.ok(pendingToken);
  const result = await box.applyIntentResult('owner', { action: 'select', index: 1 }, { pendingToken: `${pendingToken}-stale` });
  assert.match(result.reply, /刚才待选的地点已经变化或过期了/);
  assert.equal(result.wrote, false);
});

test('rejects semantic selection outside pending candidates without writing', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  const { pendingToken } = box.intentContext('owner');
  assert.ok(pendingToken);
  const result = await box.applyIntentResult('owner', { action: 'select', index: 9 }, { pendingToken });
  assert.match(result.reply, /你选的编号不在刚才的地点候选里/);
  assert.equal(result.wrote, false);
});

test('returns the place list for a semantic list action with the current view token', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  await box.handle('owner', { type: 'list' });
  const { viewToken } = box.intentContext('owner');
  assert.ok(viewToken);
  const result = await box.applyIntentResult('owner', { action: 'list' }, { viewToken });
  assert.match(result.reply, /甲省域省博物馆/);
});

test('returns no explanation for an empty box with an empty or unknown query', (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  assert.equal(box.explain('owner', ''), null);
  assert.equal(box.explain('owner', '不存在的地点'), null);
});

test('explains the latest place when no query is supplied', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  const reply = box.explain('owner', '');
  assert.match(reply, /甲省域省博物馆/);
  assert.match(reply, /双方共享的想去箱/);
});

test('explains the last referenced place for an unknown query instead of the latest place', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(box.explain('owner', '示例园区'), /示例园区/);
  const reply = box.explain('owner', '不存在的地点');
  assert.match(reply, /示例园区/);
  assert.match(reply, /双方共享的想去箱/);
});

test('recommends a single focused place when the map provider is unavailable', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.available = false;
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  const reply = await box.handle('owner', {
    type: 'recommend', date: '2026-08-11', label: '今天', energy: 'balanced', focus: '示例园区',
  });
  assert.match(reply, /示例园区/);
  assert.match(reply, /地图服务还没配置好/);
  assert.match(reply, /备选还有：暂时没有/);
});

test('recommends a single focused place without weather conclusions when weather fails', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.weather = async () => { throw new Error('天气接口挂了'); };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  const reply = await box.handle('owner', {
    type: 'recommend', date: '2026-08-11', label: '今天', energy: 'balanced', focus: '示例园区',
  });
  assert.match(reply, /我先推荐示例园区/);
  assert.match(reply, /天气暂时没查到/);
  assert.match(reply, /天气接口挂了/);
  assert.match(reply, /不按天气给结论/);
  assert.match(reply, /地图/);
});

test('reports a weather provider error when no forecasts are available', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.weather = async () => { throw new Error('天气接口挂了'); };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  const reply = await box.handle('owner', { type: 'weather', date: '2026-08-11', label: '今天' });
  assert.match(reply, /已取得 0 个/);
  assert.match(reply, /暂不可用（天气接口挂了）/);
});

test('reports a fallback weather error when the provider error message is empty', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.weather = async () => { throw new Error(''); };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  const reply = await box.handle('owner', { type: 'weather', date: '2026-08-11', label: '今天' });
  assert.match(reply, /暂不可用（天气服务暂时不可用）/);
});

test('lists all places as alternatives when reliable local travel times are unavailable', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  const reply = await box.handle('owner', {
    type: 'recommend', date: '2026-08-11', label: '今天', energy: 'balanced', focus: '',
  });
  assert.match(reply, /这次还拿不到可靠的本地交通时间/);
  assert.match(reply, /今天想去箱全部地点/);
  assert.match(reply, /示例园区｜备选/);
});

test('exports shared place help and returns it for the help command', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  const help = sharedPlaceHelp();
  assert.match(help, /想去箱/);
  assert.match(help, /15 分钟后失效/);
  assert.equal(await box.handle('owner', { type: 'help' }), help);
});

test('rejects out-of-range semantic visited indices without changing active places', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  await box.handle('owner', { type: 'list' });
  const { viewToken } = box.intentContext('owner');
  assert.ok(viewToken);
  for (const intent of [
    { action: 'visited', index: 99 },
    { action: 'visited', indices: [1, 99] },
  ]) {
    const result = await box.applyIntentResult('owner', intent, { viewToken });
    assert.equal(result.reply, '你说的地点不在刚才那份想去箱列表里。');
    assert.equal(result.wrote, false);
  }
  const { places } = box.intentContext('owner');
  assert.equal(places.length, 1);
  assert.equal(places[0].name, '甲省域省博物馆');
  assert.equal(places[0].status, 'active');
});

test('rejects an invalid semantic action', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await assert.rejects(box.applyIntentResult('owner', { action: 'unsupported' }), {
    message: '想去箱语义操作无效',
  });
});

test('rejects an unsupported command type', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider() });
  await assert.rejects(box.handle('owner', { type: 'unsupported' }), {
    message: '不支持的想去箱操作',
  });
});

test('parses natural shared place box commands without treating ordinary chat as a command', () => {
  assert.deepEqual(parseSharedPlaceCommand('把示例街区放进想去箱'), { type: 'add', name: '示例街区', note: '' });
  assert.deepEqual(parseSharedPlaceCommand('想去箱加入：甲省域省博物馆，备注想看新展'), { type: 'add', name: '甲省域省博物馆', note: '想看新展' });
  assert.deepEqual(parseSharedPlaceCommand('下次去示例街区，帮我记一下'), { type: 'add', name: '示例街区', note: '' });
  assert.deepEqual(parseSharedPlaceCommand('把甲省域省博物馆加到出行清单里'), { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.deepEqual(parseSharedPlaceCommand('示例街区先不去了，删掉吧'), { type: 'remove', name: '示例街区' });
  assert.deepEqual(parseSharedPlaceCommand('删除第一个'), { type: 'remove', index: 1 });
  assert.deepEqual(parseSharedPlaceCommand('把第二个删掉'), { type: 'remove', index: 2 });
  assert.deepEqual(parseSharedPlaceCommand('帮我删一下第一个'), { type: 'remove', index: 1 });
  assert.deepEqual(parseSharedPlaceCommand('标记1去过了'), { type: 'visited', index: 1 });
  assert.deepEqual(parseSharedPlaceCommand('第一个标记成去过了'), { type: 'visited', index: 1 });
  assert.deepEqual(parseSharedPlaceCommand('把想去箱里的1号优衣库标记为已去过'), { type: 'visited', index: 1 });
  assert.deepEqual(parseSharedPlaceCommand('把第二个标成已去过'), { type: 'visited', index: 2 });
  assert.deepEqual(parseSharedPlaceCommand('我想把示例街区从想去箱里删掉'), { type: 'remove', name: '示例街区' });
  assert.equal(parseSharedPlaceCommand('今天去哪').type, 'recommend');
  assert.equal(parseSharedPlaceCommand('以示例园区为主，再搭两个附近地方').focus, '示例园区');
  assert.deepEqual(parseSharedPlaceCommand('想去箱选二'), { type: 'select', index: 2 });
  assert.deepEqual(parseSharedPlaceCommand('我们的想去箱现在有什么地方？'), { type: 'list' });
  assert.equal(parseSharedPlaceCommand('我们以后可以建个想去箱吗'), null);
  assert.equal(parseSharedPlaceCommand('我们下次去示例街区吧'), null);
  assert.equal(parseSharedPlaceCommand('我想去吃火锅'), null);
  assert.equal(parseSharedPlaceCommand('把这个想法记下来'), null);
  assert.equal(parseSharedPlaceCommand('删除第一个文件'), null);
});

test('shares explicit places across both sides, confirms ambiguity, and enforces creator deletion', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider(), now: () => Date.parse('2026-08-11T12:00:00Z') });
  const prompt = await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  assert.match(prompt, /1\. 示例街区/);
  assert.match(await box.handle('owner', { type: 'select', index: 1 }), /已经把示例街区/);
  assert.match(await box.handle('friend', { type: 'list' }), /示例街区/);
  assert.match(box.explain('friend', 'Owner为什么知道示例街区'), /双方共享的想去箱/);
  assert.match(box.explain('friend', 'Owner为什么知道示例街区'), /不是从另一方的私人聊天或长期记忆/);
  assert.match(await box.handle('friend', { type: 'remove', name: '示例街区' }), /Owner放进来的/);
  assert.match(await box.handle('owner', { type: 'list' }), /^1\. 示例街区$/m);
  assert.match(await box.handle('owner', { type: 'remove', index: 1 }), /拿掉了/);
});

test('resolves numbered deletion only against the same side recent displayed list', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  let currentNow = Date.parse('2026-08-11T12:00:00Z');
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider(), now: () => currentNow });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  await box.handle('owner', { type: 'visited', name: '示例园区' });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  await box.handle('friend', { type: 'add', name: '丙城区欢乐海岸PLUS', note: '' });

  assert.match(await box.handle('owner', { type: 'remove', index: 1 }), /列表已经过期/);
  const listing = await box.handle('owner', { type: 'list' });
  assert.match(listing, /^1\. 甲省域省博物馆$/m);
  assert.match(listing, /^2\. 丙城区欢乐海岸PLUS$/m);
  assert.doesNotMatch(listing, /示例园区/);
  assert.match(await box.handle('friend', { type: 'remove', index: 1 }), /列表已经过期/);
  assert.match(await box.handle('owner', { type: 'remove', index: 2 }), /好友放进来的/);
  currentNow += 16 * 60 * 1000;
  assert.match(await box.handle('owner', { type: 'remove', index: 1 }), /列表已经过期/);
  await box.handle('owner', { type: 'list' });
  assert.match(await box.handle('owner', { type: 'remove', index: 1 }), /甲省域省博物馆从想去箱拿掉了/);
  assert.equal(readRecordState(files.stateFile).places.find((place) => place.name === '示例园区').status, 'visited');
});

test('marks a numbered place visited from the same side recent list', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  let currentNow = Date.parse('2026-08-11T12:00:00Z');
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider(), now: () => currentNow });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  await box.handle('friend', { type: 'add', name: '丙城区欢乐海岸PLUS', note: '' });

  assert.match(await box.handle('owner', { type: 'visited', index: 1 }), /列表已经过期/);
  await box.handle('owner', { type: 'list' });
  assert.match(await box.handle('friend', { type: 'visited', index: 1 }), /列表已经过期/);
  assert.match(await box.handle('owner', { type: 'visited', index: 1 }), /甲省域省博物馆标成去过啦/);
  const listing = await box.handle('owner', { type: 'list' });
  assert.doesNotMatch(listing, /甲省域省博物馆/);
  assert.match(listing, /^1\. 丙城区欢乐海岸PLUS$/m);
  currentNow += 16 * 60 * 1000;
  assert.match(await box.handle('owner', { type: 'visited', index: 1 }), /列表已经过期/);
  await box.handle('owner', { type: 'list' });
  assert.match(await box.handle('owner', { type: 'visited', index: 1 }), /丙城区欢乐海岸PLUS标成去过啦/);
  assert.ok(readRecordState(files.stateFile).places.every((place) => place.status === 'visited'));
});

test('lists only active names on both sides without changing saved place details', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const places = [
    { id: 'SP-VISITED', name: '示例园区', status: 'visited', addedBy: 'owner', district: '禅城区', note: '已经去过' },
    { id: 'SP-ACTIVE-1', name: '示例街区', status: 'active', addedBy: 'owner', city: '甲城市', district: '甲城区区', note: '晚上散步' },
    { id: 'SP-ACTIVE-2', name: '甲省域省博物馆', status: 'active', addedBy: 'friend', city: '甲城市', note: '想看新展' },
  ];
  fs.writeFileSync(stateFile, JSON.stringify({ places }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  const expected = [
    '想去箱（还没去的 2 个）：',
    '1. 示例街区',
    '2. 甲省域省博物馆',
    '可以直接说“第一个标记成去过了”“删除第一个”或“把第二个删掉”。',
    '另有 1 个去过的地方不在此列表，发送「去过的地方」可一次查看',
  ].join('\n');
  for (const side of ['owner', 'friend']) {
    const listing = await box.handle(side, { type: 'list' });
    assert.equal(listing, expected);
    assert.doesNotMatch(listing, /示例园区|禅城区|甲城区区|甲城市|晚上散步|想看新展|Owner|好友|加入|○|✓|｜/);
    assert.deepEqual(readRecordState(stateFile).views[side].placeIds, ['SP-ACTIVE-1', 'SP-ACTIVE-2']);
    assert.deepEqual(box.intentContext(side).places.map(({ index, name }) => ({ index, name })), [
      { index: 1, name: '示例街区' }, { index: 2, name: '甲省域省博物馆' },
    ]);
  }
  assert.deepEqual(readRecordState(stateFile).places, places);
});

test('caps the displayed active list at thirty and counts only active overflow', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const places = Array.from({ length: 32 }, (_, index) => ({
    id: `SP-${index + 1}`, name: `地点${index + 1}`, status: 'active', addedBy: 'owner',
  }));
  places.splice(1, 0, { id: 'SP-VISITED', name: '去过的公园', status: 'visited', addedBy: 'owner' });
  places.push({ id: 'SP-REMOVED', name: '移除的公园', status: 'removed', addedBy: 'owner' });
  fs.writeFileSync(stateFile, JSON.stringify({ places }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  const listing = await box.handle('owner', { type: 'list' });
  assert.match(listing, /^想去箱（还没去的 32 个）：/);
  assert.equal(listing.split('\n').filter((line) => /^\d+\./.test(line)).length, 30);
  assert.match(listing, /^30\. 地点30$/m);
  assert.match(listing, /^还有 2 个地点没有展开。$/m);
  assert.doesNotMatch(listing, /地点31|地点32|去过的公园|移除的公园/);
  assert.deepEqual(readRecordState(stateFile).views.owner.placeIds, Array.from({ length: 30 }, (_, index) => `SP-${index + 1}`));
  assert.deepEqual(readRecordState(stateFile).places, places);
});

test('reports an all-visited box and clears the previous numbered view', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '' });
  await box.handle('owner', { type: 'list' });
  await box.handle('friend', { type: 'visited', name: '示例园区' });
  assert.ok(readRecordState(stateFile).views.owner);
  const before = readRecordState(stateFile).places;
  assert.equal(await box.handle('owner', { type: 'list' }), '想去箱里的地点都去过啦，已隐藏；说地点名称可查看详情或恢复。\n另有 1 个去过的地方不在此列表，发送「去过的地方」可一次查看');
  assert.equal(readRecordState(stateFile).views.owner, undefined);
  assert.deepEqual(readRecordState(stateFile).places, before);
  assert.equal(box.intentContext('owner').enabled, false);
  assert.match(await box.handle('owner', { type: 'visited', index: 1 }), /列表已经过期/);
});

test('keeps the fully empty reply and clears a stale numbered view', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(stateFile, JSON.stringify({
    places: [], views: { owner: { placeIds: ['SP-OLD'], createdAt: new Date().toISOString() } },
  }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  assert.equal(await box.handle('owner', { type: 'list' }), '我们的想去箱现在还是空的。直接说“把某个地方放进想去箱”就能开始啦。');
  assert.equal(readRecordState(stateFile).views.owner, undefined);
});

test('still inspects, restores and removes hidden visited places by name', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  await box.handle('owner', { type: 'add', name: '示例园区', note: '想看陶艺' });
  await box.handle('owner', { type: 'visited', name: '示例园区' });
  await box.handle('owner', { type: 'list' });
  const detail = box.inspect('friend', '示例园区');
  assert.equal(detail.reply, '想去箱：示例园区\n状态：已去过\n地点：乙城市丙城区区');
  assert.equal(detail.data.status, 'visited');
  assert.equal(detail.continue, true);
  assert.match(box.explain('owner', '示例园区'), /被Owner加入了双方共享的想去箱/);
  assert.match(await box.handle('owner', { type: 'restore', name: '示例园区' }), /重新放回想去清单/);
  const restoredListing = await box.handle('owner', { type: 'list' });
  assert.match(restoredListing, /^1\. 示例园区$/m);
  assert.doesNotMatch(restoredListing, /已隐藏|没有展开/);
  await box.handle('owner', { type: 'visited', name: '示例园区' });
  assert.match(await box.handle('owner', { type: 'remove', name: '示例园区' }), /从想去箱拿掉了/);
});

test('applies natural semantic follow-ups only against the same recent place context', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({
    stateFile: files.stateFile, provider: fakeProvider(), now: () => Date.parse('2026-08-11T12:00:00Z'),
  });
  await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  await box.handle('friend', { type: 'list' });
  const context = box.intentContext('friend');
  assert.equal(context.enabled, true);
  assert.equal(context.places[0].name, '甲省域省博物馆');
  assert.match(await box.applyIntent('friend', { action: 'visited', index: 1 }, {
    viewToken: context.viewToken,
  }, '大学那个去过了'), /标成去过啦/);
  assert.match(await box.applyIntent('friend', { action: 'remove', index: 1 }, {
    viewToken: context.viewToken,
  }, '删掉刚才那个'), /变化或过期/);

  const ambiguous = await box.handle('friend', { type: 'add', name: '示例街区', note: '' });
  assert.match(ambiguous, /想去箱选1/);
  const choiceContext = box.intentContext('friend');
  assert.equal(choiceContext.pending.length, 2);
  const selected = await box.applyIntent('friend', { action: 'select', index: 2 }, {
    pendingToken: choiceContext.pendingToken,
  }, '就第二个吧');
  assert.match(selected, /示例街区二期/);
  assert.match(selected, /放进.*想去箱/);
});

test('replies that a duplicate place is already saved when the peer notice is already queued', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  let noticeAttempts = 0;
  const box = createSharedPlaceBox({
    stateFile: files.stateFile,
    provider: fakeProvider(),
    now: () => Date.parse('2026-08-11T12:00:00Z'),
    async onPlaceAdded() { noticeAttempts += 1; },
  });

  const first = await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(first, /通知对方的消息也已经排上啦/);
  const duplicate = await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(duplicate, /甲省域省博物馆已经在想去箱里啦/);
  assert.doesNotMatch(duplicate, /补排了对方通知/);
  assert.equal(noticeAttempts, 1);
  const listing = await box.handle('friend', { type: 'list' });
  assert.match(listing, /^1\. 甲省域省博物馆$/m);
  assert.equal(listing.split('\n').filter((line) => /^\d+\./.test(line)).length, 1);
});

test('replies that a duplicate place peer notice was requeued after an initial failure', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  let failNotice = true;
  let noticeAttempts = 0;
  const box = createSharedPlaceBox({
    stateFile: files.stateFile,
    provider: fakeProvider(),
    now: () => Date.parse('2026-08-11T12:00:00Z'),
    async onPlaceAdded() {
      noticeAttempts += 1;
      if (failNotice) throw new Error('temporary queue failure');
    },
  });

  const first = await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(first, /通知暂时没排上/);
  assert.equal(noticeAttempts, 1);
  failNotice = false;
  const retry = await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(retry, /甲省域省博物馆已经在想去箱里啦，刚刚也补排了对方通知/);
  assert.equal(noticeAttempts, 2);
  const listing = await box.handle('friend', { type: 'list' });
  assert.match(listing, /^1\. 甲省域省博物馆$/m);
  assert.equal(listing.split('\n').filter((line) => /^\d+\./.test(line)).length, 1);
});

test('notifies the peer only after a real addition and retries a failed queue without duplicating the place', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const events = [];
  let failOnce = true;
  const box = createSharedPlaceBox({
    stateFile: files.stateFile,
    provider: fakeProvider(),
    now: () => Date.parse('2026-08-11T12:00:00Z'),
    async onPlaceAdded(event) {
      events.push(event);
      if (failOnce) {
        failOnce = false;
        throw new Error('temporary queue failure');
      }
    },
  });

  const first = await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(first, /通知暂时没排上/);
  assert.equal(events.length, 1);
  const retry = await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' });
  assert.match(retry, /补排了对方通知/);
  assert.equal(events.length, 2);
  assert.equal(events[1].side, 'friend');
  assert.equal(events[1].place.name, '甲省域省博物馆');
  assert.match(await box.handle('friend', { type: 'add', name: '甲省域省博物馆', note: '' }), /已经在想去箱里/);
  assert.equal(events.length, 2);

  const ambiguous = await box.handle('owner', { type: 'add', name: '示例街区', note: '' });
  assert.match(ambiguous, /想去箱选1/);
  assert.equal(events.length, 2);
  assert.match(await box.handle('owner', { type: 'select', index: 1 }), /通知对方的消息也已经排上啦/);
  assert.equal(events.length, 3);
  assert.equal(events[2].side, 'owner');
});

test('keeps conversational suggestions isolated, expiring, and confirmation-gated', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  let currentNow = Date.parse('2026-08-11T12:00:00Z');
  const events = [];
  const box = createSharedPlaceBox({
    stateFile: files.stateFile,
    provider: fakeProvider(),
    now: () => currentNow,
    async onPlaceAdded(event) { events.push(event); },
  });

  assert.match(await box.handle('friend', { type: 'suggest', name: '甲省域省博物馆', reason: '用户说想去' }), /回“加吧”/);
  assert.equal(box.hasPendingSuggestion('friend'), true);
  assert.equal(await box.handle('owner', { type: 'resolve_suggestion', text: '加吧' }), null);
  const added = await box.handle('friend', { type: 'resolve_suggestion', text: '加吧' });
  assert.match(added, /已经把甲省域省博物馆/);
  assert.equal(events.length, 1);
  assert.equal(events[0].side, 'friend');
  assert.equal(box.hasPendingSuggestion('friend'), false);
  assert.equal(await box.handle('friend', { type: 'resolve_suggestion', text: '好啊' }), null);
  assert.equal(await box.handle('friend', { type: 'suggest', name: '甲省域省博物馆', reason: '' }), '');

  assert.match(await box.handle('owner', { type: 'suggest', name: '丙城区欢乐海岸PLUS', reason: '' }), /丙城区欢乐海岸PLUS/);
  assert.equal(await box.handle('owner', { type: 'resolve_suggestion', text: '不用了' }), '好，那这次不放进想去箱。');
  await box.handle('owner', { type: 'suggest', name: '示例园区', reason: '' });
  currentNow += 16 * 60 * 1000;
  assert.equal(box.hasPendingSuggestion('owner'), false);
  assert.equal(await box.handle('owner', { type: 'resolve_suggestion', text: '加吧' }), null);
});

test('returns grounded weather and route details, then deletes only one side contributions', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider: fakeProvider(), now: () => Date.parse('2026-08-11T12:00:00Z') });
  await box.handle('friend', { type: 'add', name: '丙城区欢乐海岸PLUS', note: '' });
  await box.handle('owner', { type: 'add', name: '甲省域省博物馆', note: '' });
  const answer = await box.handle('owner', { type: 'recommend', date: '2026-08-11', label: '今天', energy: 'weatherproof', focus: '丙城区欢乐海岸PLUS' });
  assert.match(answer, /阵雨/);
  assert.match(answer, /附近咖啡馆/);
  assert.match(answer, /步行约9分钟/);
  assert.match(answer, /天气发布时间/);
  assert.deepEqual(box.deleteSide('friend'), { removed: 1 });
  const listing = await box.handle('owner', { type: 'list' });
  assert.doesNotMatch(listing, /丙城区欢乐海岸PLUS/);
  assert.match(listing, /甲省域省博物馆/);
});

test('lists every active place with address, map, weather score, and one weather request per district', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const weatherCalls = [];
  const places = {
    甲省域省博物馆: { providerId: 'museum', address: '甲城市戊城区区珠江东路2号', adcode: '440106', longitude: 105.324, latitude: 32.119, category: '博物馆', tags: ['室内'] },
    戊城区公园: { providerId: 'park', address: '甲城市戊城区区黄埔大道员村段', adcode: '440106', longitude: 105.362, latitude: 32.124, category: '公园', tags: ['户外'] },
    顺峰山公园: { providerId: 'shunfeng', address: '乙城市丙城区区南国东路', adcode: '990606', longitude: 105.293, latitude: 31.819, category: '公园', tags: ['户外'] },
    神秘小店: { providerId: 'mystery', address: '地址待补充', adcode: '', longitude: null, latitude: null, category: '', tags: [] },
  };
  const provider = {
    available: true,
    providerName: '测试地图',
    attribution: '测试地图数据',
    async searchPlace(query) { return [{ provider: 'test', name: query, city: '甲城市', district: '戊城区区', ...places[query] }]; },
    async weather(place, date) {
      weatherCalls.push(place.adcode);
      if (place.adcode === '440106') return { city: '戊城区区', date, reportTime: '2026-08-11 20:00:00', dayWeather: '阵雨', nightWeather: '多云', dayTemp: '33', nightTemp: '27', dayWind: '南', dayPower: '3' };
      return { city: '丙城区区', date, reportTime: '2026-08-11 20:00:00', dayWeather: '晴', nightWeather: '晴', dayTemp: '31', nightTemp: '26', dayWind: '南', dayPower: '2' };
    },
  };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider, now: () => Date.parse('2026-08-11T12:00:00Z') });
  await box.handle('owner', { type: 'add', name: '已去过的小店', note: '' });
  await box.handle('owner', { type: 'visited', name: '已去过的小店' });
  for (const name of Object.keys(places)) await box.handle('owner', { type: 'add', name, note: '' });
  await box.handle('friend', { type: 'list' });

  const answer = await box.handle('friend', { type: 'recommend', date: '2026-08-11', label: '今天', energy: 'balanced', focus: '' });
  assert.doesNotMatch(answer, /已去过的小店/);
  for (const [name, place] of Object.entries(places)) {
    assert.match(answer, new RegExp(name));
    assert.match(answer, new RegExp(place.address));
  }
  assert.equal(weatherCalls.filter((adcode) => adcode === '440106').length, 1);
  assert.equal(weatherCalls.filter((adcode) => adcode === '990606').length, 1);
  assert.match(answer, /甲省域省博物馆｜备选｜95\/100 很推荐/);
  assert.match(answer, /顺峰山公园｜备选｜87\/100 很推荐/);
  assert.match(answer, /戊城区公园｜备选｜42\/100 不太推荐/);
  assert.ok(answer.indexOf('甲省域省博物馆｜') < answer.indexOf('顺峰山公园｜'));
  assert.ok(answer.indexOf('顺峰山公园｜') < answer.indexOf('戊城区公园｜'));
  assert.match(answer, /神秘小店｜备选｜评分暂缺/);
  assert.match(answer, /地图：https:\/\/uri\.amap\.com\/marker/);
  assert.match(answer, /地图：暂不可用/);
  assert.match(answer, /天气上更适合：甲省域省博物馆/);
  assert.match(await box.handle('friend', { type: 'visited', index: 1 }), /甲省域省博物馆标成去过啦/);
});

test('explains rain, heat and strong wind by place setting and applies outdoor energy penalties', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const places = {
    室内展馆: { providerId: 'indoor', longitude: 105.324, latitude: 32.119, category: '展览', tags: ['室内'] },
    综合空间: { providerId: 'mixed', longitude: 105.334, latitude: 32.129, category: '综合场所', tags: [] },
    户外公园: { providerId: 'outdoor', longitude: 105.344, latitude: 32.139, category: '公园', tags: ['户外'] },
  };
  const provider = {
    available: true,
    providerName: '测试地图',
    attribution: '测试地图数据',
    async searchPlace(query) { return [{ provider: 'test', name: query, city: '甲城市', district: '戊城区区', adcode: '440106', ...places[query] }]; },
    async weather(place, date) {
      return { city: place.district, date, dayWeather: '阵雨', nightWeather: '多云', dayTemp: '36', nightTemp: '28', dayWind: '南', dayPower: '6' };
    },
  };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider, now: () => Date.parse('2026-08-11T12:00:00Z') });
  for (const name of Object.keys(places)) await box.handle('owner', { type: 'add', name, note: '' });
  await box.handle('friend', { type: 'list' });

  const outdoorScores = {};
  for (const energy of ['balanced', 'low', 'weatherproof']) {
    const answer = await box.handle('friend', { type: 'recommend', date: '2026-08-11', label: '今天', energy, focus: '' });
    const indoor = answer.match(/室内展馆｜[^\n]*\n天气：[^\n]*\n理由：([^\n]*)/u);
    assert.ok(indoor, `${energy}: missing indoor recommendation reasons`);
    assert.match(indoor[1], /高温下室内更舒服/u);
    const mixed = answer.match(/综合空间｜[^\n]*\n天气：[^\n]*\n理由：([^\n]*)/u);
    assert.ok(mixed, `${energy}: missing mixed recommendation reasons`);
    assert.match(mixed[1], /有降雨，最好准备室内备选/u);
    assert.match(mixed[1], /高温时注意避晒降温/u);
    const outdoor = answer.match(/户外公园｜[^｜\n]*｜(\d+)\/100[^\n]*\n天气：[^\n]*\n理由：([^\n]*)/u);
    assert.ok(outdoor, `${energy}: missing outdoor recommendation score and reasons`);
    assert.match(outdoor[2], /有降雨，户外体验会受影响/u);
    assert.match(outdoor[2], /高温会明显影响户外体验/u);
    assert.match(outdoor[2], /风力偏强，户外体验扣分/u);
    outdoorScores[energy] = Number(outdoor[1]);
  }
  assert.equal(outdoorScores.low - outdoorScores.balanced, -3);
  assert.equal(outdoorScores.weatherproof - outdoorScores.balanced, -5);
});

test('explains sunny mild calm weather and applies indoor energy bonuses without hitting the score cap', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  provider.weather = async (place, date) => ({
    city: place.district, date, dayWeather: '晴', nightWeather: '晴', dayTemp: '28', nightTemp: '22', dayWind: '无', dayPower: '0',
  });
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider, now: () => Date.parse('2026-08-11T12:00:00Z') });
  await box.handle('owner', { type: 'add', name: '室内展馆', note: '' });
  await box.handle('friend', { type: 'list' });

  const indoorScores = {};
  for (const energy of ['balanced', 'low', 'weatherproof']) {
    const answer = await box.handle('friend', { type: 'recommend', date: '2026-08-11', label: '今天', energy, focus: '' });
    const indoor = answer.match(/室内展馆｜[^｜\n]*｜(\d+)\/100[^\n]*\n天气：[^\n]*\n理由：([^\n]*)/u);
    assert.ok(indoor, `${energy}: missing indoor recommendation score and reasons`);
    assert.match(indoor[2], /天气晴朗，出行条件不错/u);
    indoorScores[energy] = Number(indoor[1]);
  }
  assert.ok(indoorScores.weatherproof < 100);
  assert.equal(indoorScores.low - indoorScores.balanced, 4);
  assert.equal(indoorScores.weatherproof - indoorScores.balanced, 5);
});

test('plans a multi-stop day for the friend while still listing every place', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const placeNames = ['甲咖啡馆', '乙书店', '丙商场', '丁创意园', '戊公园'];
  const provider = {
    available: true,
    providerName: '测试高德',
    attribution: '测试地图数据',
    async searchPlace(query) {
      const index = placeNames.indexOf(query);
      return [{
        provider: 'test', providerId: `place-${index}`, name: query, address: `测试路${index + 1}号`,
        city: '甲城市', district: '戊城区区', adcode: '440106', longitude: 105.3 + index * 0.01,
        latitude: 32.1 + index * 0.01, category: /公园|创意园/u.test(query) ? '户外景点' : '室内场所',
        tags: /公园|创意园/u.test(query) ? ['户外'] : ['室内'],
      }];
    },
    async weather(place, date) {
      return { city: place.district, date, reportTime: '2026-08-12 08:00:00', dayWeather: '多云', nightWeather: '多云', dayTemp: '30', nightTemp: '25', dayWind: '南', dayPower: '2' };
    },
    async routeMatrix(places) {
      return places.map((_, from) => places.map((__, to) => ({
        distanceMeters: from === to ? 0 : Math.abs(from - to) * 1800,
        durationSeconds: from === to ? 0 : Math.abs(from - to) * 10 * 60,
      })));
    },
  };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider, now: () => Date.parse('2026-08-12T00:00:00Z') });
  for (const name of placeNames) await box.handle('owner', { type: 'add', name, note: '停留90分钟' });

  const answer = await box.handle('friend', { type: 'recommend', date: '2026-08-12', label: '今天', energy: 'balanced', focus: '' });
  assert.match(answer, /今天的一日路线建议/);
  assert.match(answer, /只组合同省地点，单段驾车不超过 90 分钟/);
  assert.match(answer, /驾车估算 10分钟（1\.8公里）/);
  assert.match(answer, /午饭 \/ 休息/);
  assert.match(answer, /预留机动 45 分钟/);
  assert.equal((answer.match(/｜今日路线｜/gu) || []).length, 4);
  assert.equal((answer.match(/｜备选｜/gu) || []).length, 1);
  for (const name of placeNames) assert.match(answer, new RegExp(name));
  assert.equal((answer.match(/地图：https:\/\/uri\.amap\.com\/marker/gu) || []).length, 5);
  assert.match(await box.handle('friend', { type: 'recommend', date: '2026-08-12', label: '今天', energy: 'balanced', focus: '不存在的地点' }), /没有找到/);
});

test('day planning never joins provinces or legs over ninety minutes just to add stops', () => {
  const entry = (id, province, city, score = 80) => ({
    place: { id, name: id, province, city, category: '商场', tags: ['室内'], note: '停留90分钟' },
    rating: { score },
  });
  const entries = [
    entry('湖南地点', '湖南省', '戊城市', 99),
    entry('甲城甲', '甲省域省', '甲城市', 75),
    entry('甲城乙', '甲省域省', '甲城市', 74),
    entry('甲省域远点', '甲省域省', '韶关市', 98),
  ];
  const durations = [
    [0, 30, 30, 30],
    [30, 0, 20, 120],
    [30, 20, 0, 120],
    [30, 120, 120, 0],
  ];
  const matrix = durations.map((row) => row.map((minutes) => ({ distanceMeters: minutes * 1000, durationSeconds: minutes * 60 })));
  const plan = createDayPlan(entries, matrix);
  assert.deepEqual(plan.entries.map((item) => item.place.id).sort(), ['甲城乙', '甲城甲']);
  assert.equal(sameDayRegion(entries[0].place, entries[1].place), false);
  assert.equal(sameDayRegion(entries[1].place, entries[2].place), true);
});

test('city destinations consume a full day while theme parks default to five hours', () => {
  assert.equal(estimateVisitMinutes({ name: '戊城市', category: '地名地址信息;地市级地名', tags: [] }), 480);
  assert.equal(estimateVisitMinutes({ name: '示例游乐园', category: '游乐场', tags: ['户外'] }), 300);
});

test('works without a map key but never invents weather or routes', async (t) => {
  const files = tempState();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const provider = { available: false };
  const box = createSharedPlaceBox({ stateFile: files.stateFile, provider, now: () => Date.parse('2026-08-11T12:00:00Z') });
  assert.match(await box.handle('owner', { type: 'add', name: '示例园区', note: '' }), /暂时只保存名字/);
  const recommendation = await box.handle('friend', { type: 'recommend', date: '2026-08-11', label: '今天', energy: 'balanced', focus: '' });
  assert.match(recommendation, /不能可靠地告诉你今天天气和推荐指数/);
  assert.match(recommendation, /示例园区｜备选｜评分暂缺/);
  assert.doesNotMatch(recommendation, /℃/);
});

test('keyless provider resolves public place data and weather with attribution', async () => {
  const responses = [
    [{ place_id: 1, osm_type: 'node', osm_id: 2, lat: '32.116', lon: '105.238', name: '示例街区', display_name: '示例街区, 甲城区区, 甲城市, 甲省域省, 中国', address: { city: '甲城市', city_district: '甲城区区', state: '甲省域省' }, category: 'tourism', type: 'attraction' }],
    { current: { time: '2026-08-11T22:45' }, daily: { time: ['2026-08-11'], weather_code: [61], temperature_2m_max: [33.2], temperature_2m_min: [27.1], wind_speed_10m_max: [18.4] } },
  ];
  const seenUrls = [];
  const provider = createOpenPlaceProvider({
    now: () => Date.parse('2026-08-11T12:00:00Z'),
    fetchImpl: async (url, options) => {
      seenUrls.push({ url: String(url), userAgent: options.headers['User-Agent'] || '' });
      const payload = responses.shift();
      return { ok: true, async json() { return payload; } };
    },
  });
  const places = await provider.searchPlace('示例街区');
  assert.equal(places[0].name, '示例街区');
  assert.equal(places[0].attribution, '© OpenStreetMap contributors');
  assert.match(seenUrls[0].userAgent, /LocalWechatAssistant/);
  const weather = await provider.weather(places[0], '2026-08-11');
  assert.equal(weather.dayWeather, '有雨');
  assert.equal(weather.dayTemp, '33');
  assert.match(weather.windText, /18km\/h/);
  assert.match(seenUrls[1].url, /api\.open-meteo\.com/);
});

test('AMap text search requests full POI fields so district weather has an adcode', async () => {
  let requestedUrl = '';
  const provider = createAmapPlaceProvider({
    apiKey: 'test-key-1234567890',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        async json() {
          return {
            status: '1',
            pois: [{
              id: 'B00140WBI1', name: '示例高塔', location: '105.324521,32.106428',
              pname: '甲省域省', cityname: '甲城市', adname: '海珠区', adcode: '440105',
              address: '阅江西路222号', type: '风景名胜;风景名胜;国家级景点',
            }],
          };
        },
      };
    },
  });
  const places = await provider.searchPlace('示例高塔', '甲城');
  assert.equal(new URL(requestedUrl).searchParams.get('extensions'), 'all');
  assert.equal(places[0].adcode, '440105');
});

test('AMap route matrix keeps the key private and parses each origin-to-destination estimate', async () => {
  const requestedUrls = [];
  const provider = createAmapPlaceProvider({
    apiKey: 'private-test-key',
    fetchImpl: async (url) => {
      const requestedUrl = new URL(String(url));
      requestedUrls.push(requestedUrl);
      return {
        ok: true,
        async json() {
          const secondDestination = requestedUrl.searchParams.get('destination') === '105.31,32.11';
          return {
            status: '1',
            results: secondDestination ? [
              { origin_id: '1', dest_id: '1', distance: '1800', duration: '600' },
              { origin_id: '2', dest_id: '1', distance: '0', duration: '0' },
            ] : [
              { origin_id: '1', dest_id: '1', distance: '0', duration: '0' },
              { origin_id: '2', dest_id: '1', distance: '1800', duration: '600' },
            ],
          };
        },
      };
    },
  });
  const matrix = await provider.routeMatrix([
    { longitude: 105.3, latitude: 32.1 },
    { longitude: 105.31, latitude: 32.11 },
  ]);
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].pathname, '/v3/distance');
  assert.equal(requestedUrls[0].searchParams.get('type'), '1');
  assert.equal(requestedUrls[0].searchParams.get('origins'), '105.3,32.1|105.31,32.11');
  assert.deepEqual(matrix[1][0], { distanceMeters: 1800, durationSeconds: 600 });
  assert.equal(matrix[0][0].durationSeconds, 0);
  assert.deepEqual(matrix[0][1], { distanceMeters: 1800, durationSeconds: 600 });
});

test('AMap route matrix excludes coordinates outside its supported region without losing valid rows', async () => {
  const requestedUrls = [];
  const provider = createAmapPlaceProvider({
    apiKey: 'private-test-key',
    fetchImpl: async (url) => {
      const requestedUrl = new URL(String(url));
      requestedUrls.push(requestedUrl);
      return {
        ok: true,
        async json() {
          const secondDestination = requestedUrl.searchParams.get('destination') === '105.31,32.11';
          return { status: '1', results: secondDestination
            ? [{ origin_id: '1', distance: '1800', duration: '600' }, { origin_id: '2', distance: '0', duration: '0' }]
            : [{ origin_id: '1', distance: '0', duration: '0' }, { origin_id: '2', distance: '1800', duration: '600' }] };
        },
      };
    },
  });
  const matrix = await provider.routeMatrix([
    { longitude: -94.338, latitude: 45.974 },
    { longitude: 105.3, latitude: 32.1 },
    { longitude: 105.31, latitude: 32.11 },
  ]);
  assert.equal(amapRoutable({ longitude: -94.338, latitude: 45.974 }), false);
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get('origins'), '105.3,32.1|105.31,32.11');
  assert.equal(matrix[0][1], null);
  assert.deepEqual(matrix[1][2], { distanceMeters: 1800, durationSeconds: 600 });
});

test('configured AMap falls back to the open provider for overseas places', async () => {
  const requests = [];
  const provider = createPlaceProvider({
    apiKey: 'private-key',
    now: (() => { let value = 10_000; return () => { value += 1000; return value; }; })(),
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes('restapi.amap.com')) {
        return { ok: true, async json() { return { status: '1', pois: [] }; } };
      }
      return {
        ok: true,
        async json() {
          return [{
            lon: '116.0735', lat: '5.9804', osm_type: 'relation', osm_id: 1101961,
            display_name: '亚庇, 沙巴, 马来西亚', namedetails: { 'name:zh': '亚庇' },
            address: { city: '亚庇', state: '沙巴', country: '马来西亚' }, category: 'place', type: 'city',
          }];
        },
      };
    },
  });
  const places = await provider.searchPlace('马来西亚亚庇');
  assert.equal(places[0].name, '亚庇');
  assert.equal(places[0].provider, 'open');
  assert.match(places[0].attribution, /OpenStreetMap/);
  assert.equal(requests.some((url) => url.includes('restapi.amap.com')), true);
  assert.equal(requests.some((url) => url.includes('nominatim.openstreetmap.org')), true);
});

test('configured AMap rejects a domestic namesake when an overseas qualifier is explicit', async () => {
  const requests = [];
  const provider = createPlaceProvider({
    apiKey: 'private-key',
    now: (() => { let value = 20_000; return () => { value += 1000; return value; }; })(),
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes('restapi.amap.com')) {
        return {
          ok: true,
          async json() {
            return {
              status: '1',
              pois: [{
                id: 'beijing-namesake', name: '巴塞罗那花园', location: '116.1,39.8',
                pname: '北京市', cityname: '北京市', adname: '丰台区', address: '园博大道',
              }],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [{
            lon: '2.1774', lat: '41.3829', osm_type: 'relation', osm_id: 347950,
            display_name: '巴塞罗那, 巴塞罗那县, 加泰罗尼亚, 西班牙',
            namedetails: { 'name:zh': '巴塞罗那' },
            address: { city: '巴塞罗那', state: '加泰罗尼亚', country: '西班牙' },
            category: 'place', type: 'city',
          }];
        },
      };
    },
  });
  const places = await provider.searchPlace('西班牙巴塞罗那');
  assert.equal(places.length, 1);
  assert.equal(places[0].name, '巴塞罗那');
  assert.equal(places[0].provider, 'open');
  assert.match(places[0].address, /西班牙/u);
  assert.equal(requests.some((url) => url.includes('restapi.amap.com')), true);
  assert.equal(requests.some((url) => url.includes('nominatim.openstreetmap.org')), true);
});

test('configured AMap prefers an exact overseas city over a longer domestic namesake', async () => {
  const provider = createPlaceProvider({
    apiKey: 'private-key',
    now: (() => { let value = 30_000; return () => { value += 1000; return value; }; })(),
    fetchImpl: async (url) => {
      if (String(url).includes('restapi.amap.com')) {
        return {
          ok: true,
          async json() {
            return {
              status: '1',
              pois: [{
                id: 'beijing-namesake', name: '巴塞罗那花园', location: '116.1,39.8',
                pname: '北京市', cityname: '北京市', adname: '丰台区', address: '园博大道',
              }],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [{
            lon: '2.1774', lat: '41.3829', osm_type: 'relation', osm_id: 347950,
            display_name: '巴塞罗那, 巴塞罗那县, 加泰罗尼亚, 西班牙',
            namedetails: { 'name:zh': '巴塞罗那' },
            address: { city: '巴塞罗那', state: '加泰罗尼亚', country: '西班牙' },
            category: 'place', type: 'city',
          }];
        },
      };
    },
  });
  const places = await provider.searchPlace('巴塞罗那');
  assert.equal(places.length, 1);
  assert.equal(places[0].name, '巴塞罗那');
  assert.equal(places[0].provider, 'open');
});

test('marks every explicitly numbered visited place in one write against the original list', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-10T06:09:29Z');
  fs.writeFileSync(stateFile, JSON.stringify({ places: Array.from({ length: 19 }, (_, i) => ({
    id: `SP-${i + 1}`, name: `地点${i + 1}`, addedBy: 'friend', status: 'active',
  })) }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider(), now: () => now });
  const command = parseSharedPlaceCommand('想去箱8 15 19都去过了');
  assert.deepEqual(command, { type: 'visited', indices: [8, 15, 19] });
  for (const text of ['第八个、第十五个和第十九个都去过了', '把想去箱里的8、15、19全部标记为已去过']) {
    assert.deepEqual(parseSharedPlaceCommand(text), command);
  }
  assert.equal(parseSharedPlaceCommand('想去箱8 15 19都没去过'), null);
  assert.equal(parseSharedPlaceCommand('想去箱8 15 19都去过了吗？'), null);
  assert.equal(parseSharedPlaceCommand('想去箱8 31都去过了'), null);
  await box.handle('owner', { type: 'list' });
  assert.match(await box.handle('friend', command), /列表已经过期/);
  assert.match(await box.handle('owner', { type: 'visited', indices: [8, 20] }), /没有修改任何地点/);
  assert.equal(readRecordState(stateFile).places.filter((p) => p.status === 'visited').length, 0);
  assert.match(await box.handle('owner', command), /地点8、地点15、地点19都标成去过/);
  assert.deepEqual(readRecordState(stateFile).places.filter((p) => p.status === 'visited').map((p) => p.id), ['SP-8', 'SP-15', 'SP-19']);
  await box.handle('owner', { type: 'list' });
  const context = box.intentContext('owner');
  assert.match(await box.applyIntent('owner', { action: 'visited', indices: [1, 2] }, { viewToken: 'stale' }), /变化或过期/);
  assert.match(await box.applyIntent('owner', { action: 'visited', indices: [1, 2] }, context), /地点1、地点2都标成去过/);
  await box.handle('owner', { type: 'list' });
  now += 16 * 60 * 1000;
  assert.match(await box.handle('owner', command), /列表已经过期/);
});

test('weather-only query includes every active place, caches districts and does not ask for a road matrix', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let weatherCalls = 0;
  const provider = fakeProvider();
  const baseWeather = provider.weather;
  provider.weather = async (...args) => { weatherCalls++; return baseWeather(...args); };
  provider.routeMatrix = async () => { throw Error('weather must not request routes'); };
  const box = createSharedPlaceBox({ stateFile, provider });
  await box.handle('owner', { type: 'add', name: '模拟公园甲' });
  await box.handle('owner', { type: 'add', name: '模拟公园乙' });
  await box.handle('owner', { type: 'add', name: '模拟公园丙' });
  await box.handle('owner', { type: 'visited', name: '模拟公园丙' });
  const reply = await box.handle('owner', { type: 'weather', date: '2026-10-10', label: '今天' });
  assert.equal(weatherCalls, 1);
  assert.match(reply, /共 2 个，已取得 2 个/);
  assert.match(reply, /模拟公园甲.*阵雨/);
  assert.match(reply, /模拟公园乙.*阵雨/);
  assert.doesNotMatch(reply, /模拟公园丙|路线|路程/);
  assert.equal(box.intentContext('owner').places.length, 2);
});

test('weather falls back to coordinates when AMap rejects a stored Hong Kong district', async () => {
  const requests = [];
  const provider = createPlaceProvider({ apiKey: 'private-test-key', fetchImpl: async (input) => {
    const url = new URL(input);
    requests.push(url);
    return { ok: true, async json() {
      if (url.hostname === 'restapi.amap.com') return { status: '0', info: 'UNKNOWN_ERROR' };
      return { current: { time: '2026-10-10T19:00' }, daily: { time: ['2026-10-10'], weather_code: [1], temperature_2m_max: [29], temperature_2m_min: [24], wind_speed_10m_max: [12] } };
    } };
  } });
  const result = await provider.weather({ provider: 'amap', adcode: '810018', latitude: 31.309841, longitude: 106.047326, city: '香港' }, '2026-10-10');
  assert.equal(result.dayTemp, '29');
  assert.equal(result.dayWeather, '多云');
  assert.equal(requests[1].hostname, 'api.open-meteo.com');
  assert.equal(requests[1].searchParams.get('latitude'), '31.309841');
  assert.equal(requests[1].searchParams.has('key'), false);
});


test('parses visited-list phrases without confusing mutations, recommendations or negations', () => {
  for (const text of ['去过的地方', '想去箱去过的地方', '已去过的地点', '看下去过哪些地方',
    '查看全部去过的地方', '一次查看所有已去过的地点', '看看我们的想去箱里去过的地方？']) {
    assert.deepEqual(parseSharedPlaceCommand(text), { type: 'list', status: 'visited' }, text);
  }
  assert.deepEqual(parseSharedPlaceCommand('查看想去箱'), { type: 'list' });
  assert.deepEqual(parseSharedPlaceCommand('把示例街区标记为去过'), { type: 'visited', name: '示例街区' });
  for (const text of ['没去过的地方', '还没有去过的地方', '示例街区去过了吗？', '不要查看去过的地方']) {
    assert.equal(parseSharedPlaceCommand(text), null, text);
  }
});

for (const count of [0, 1, 3, 32]) {
  test(`lists every visited name on both sides (${count}) with a working restore instruction`, async (t) => {
    const { directory, stateFile } = tempState();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const visited = Array.from({ length: count }, (_, index) => ({
      id: `SP-V${index}`, name: `去过地点${index + 1}`, status: 'visited', addedBy: index % 2 ? 'owner' : 'friend',
      address: '不显示地址', note: '不显示备注', district: '不显示地区',
    }));
    const places = [
      { id: 'SP-A', name: '未去地点', status: 'active', addedBy: 'owner' }, ...visited,
      { id: 'SP-R', name: '移除地点', status: 'removed', addedBy: 'owner' },
      { id: 'SP-X', name: '归档地点', status: 'archived', addedBy: 'friend' },
    ];
    fs.writeFileSync(stateFile, JSON.stringify({ places }));
    const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
    for (const side of ['owner', 'friend']) {
      const activeList = await box.handle(side, { type: 'list' });
      assert.match(activeList, /^1\. 未去地点$/m);
      if (count) assert.ok(activeList.endsWith(`另有 ${count} 个去过的地方不在此列表，发送「去过的地方」可一次查看`));
      else assert.doesNotMatch(activeList, /另有|去过的地方|已隐藏/);
      const listing = await box.handle(side, parseSharedPlaceCommand('看下去过哪些地方'));
      const expected = count ? [`想去箱（去过的 ${count} 个）：`, ...visited.map((place, i) => `${i + 1}. ${place.name}`)]
        : ['还没有标记去过的地方'];
      expected.push('发送「把<地点名>恢复为想去」可把地点移回未去列表');
      assert.equal(listing, expected.join('\n'));
      assert.equal(readRecordState(stateFile).views[side], undefined);
      assert.deepEqual(readRecordState(stateFile).places, places);
      assert.doesNotMatch(listing, /不显示|未去地点|移除地点|归档地点/);
    }
    if (count) {
      // Substitute a displayed name into the exact advertised restore syntax.
      const listing = await box.handle('friend', { type: 'list', status: 'visited' });
      const syntax = listing.match(/发送「(.+?)」/u)[1].replace('<地点名>', visited[0].name);
      assert.deepEqual(parseSharedPlaceCommand(syntax), { type: 'restore', name: visited[0].name });
      assert.match(await box.handle('friend', parseSharedPlaceCommand(syntax)), /重新放回想去清单/);
      assert.match(await box.handle('friend', { type: 'list' }), /^2\. 去过地点1$/m);
    }
  });
}

test('only successful visited confirmations include the discovery hint, including batches', async (t) => {
  const { directory, stateFile } = tempState();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const box = createSharedPlaceBox({ stateFile, provider: fakeProvider() });
  for (const name of ['地点甲', '地点乙']) await box.handle('owner', { type: 'add', name });
  const hint = '之后发送「去过的地方」可以一次查看全部去过的地方';
  for (const side of ['owner', 'friend']) {
    for (const name of ['地点甲', '地点乙']) await box.handle(side, { type: 'restore', name });
    assert.ok((await box.handle(side, { type: 'visited', name: '地点甲' })).endsWith(hint));
    await box.handle(side, { type: 'restore', name: '地点甲' });
    await box.handle(side, { type: 'list' });
    assert.ok((await box.handle(side, { type: 'visited', indices: [1, 2] })).endsWith(hint));
    assert.doesNotMatch(await box.handle(side, { type: 'visited', name: '不存在' }), /之后发送/);
    assert.doesNotMatch(await box.handle(side, { type: 'restore', name: '地点甲' }), /之后发送|另有/);
    assert.doesNotMatch(box.inspect(side, '地点乙').reply, /之后发送|另有/);
  }
});
