'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseWeatherCommand: parse, createWeatherCommands, formatWeather, shanghaiClock } = require('../src/weather-commands');
const { createWeatherStore, CITY_REPLY_TTL_MS } = require('../src/weather-store');
const { createWeatherMorning, morningMinute } = require('../src/weather-morning');
const { createPlaceProvider } = require('../src/amap-place-provider');
const cast = date => ({ date, dayWeather: '小雨', nightWeather: '多云', dayTemp: '20', nightTemp: '12',
  dayWind: '北', dayPower: '3-4', nightWind: '东', nightPower: '1-3' });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'weather', 'state.json');
  let at = Date.parse('2026-11-06T08:00:00+08:00');
  const now = () => at;
  const store = createWeatherStore({ stateFile, now });
  if (options.city !== '') store.setCity('owner', '纸月城');
  const calls = [], logs = [], sends = [];
  const provider = { attribution: '模拟天气',
    async searchPlace(name) { calls.push(['city', name]); return [{ name, city: name, adcode: 'demo-city', provider: 'amap' }]; },
    async weather(place, date) { calls.push(['weather', place.name, date]); return cast(date); }, ...options.provider };
  const weather = createWeatherCommands({ store, provider, now, log: line => logs.push(line) });
  const scheduler = (overrides = {}) => createWeatherMorning({ store, weather, now, time: '08:00', sides: ['owner'],
    send: async (...args) => { sends.push(args); }, log: line => logs.push(line), ...overrides });
  return { stateFile, root, store, weather, provider, calls, logs, sends, scheduler, now,
    setTime: time => { at = Date.parse(time); },
    say: (text, side = 'owner') => weather.handle(side, weather.selectInput(side, text) || parse(text)) };
}
test('pending city expires at 24 hours across restart, without clearing settings or the other role', t => {
  const f = fixture(t);
  f.store.waitForCity('owner', { kind: 'query', days: [2] });
  const pending = f.store.pending('owner');
  assert.equal(pending.createdAt, f.now());
  assert.equal(pending.expiresAt, f.now() + CITY_REPLY_TTL_MS);
  f.setTime('2026-11-07T07:59:59.999+08:00');
  f.store.waitForCity('owner', { kind: 'morning', days: [0, 1] });
  assert.deepEqual(f.store.pending('owner'), pending); // Timer does not renew a query.
  f.store.waitForCity('friend', { kind: 'morning', days: [0, 1] });
  const friend = f.store.pending('friend');
  const reopened = createWeatherStore({ stateFile: f.stateFile, now: f.now });
  assert.deepEqual(reopened.pending('owner'), pending);
  f.setTime('2026-11-07T08:00:00+08:00');
  assert.equal(reopened.pending('owner'), null);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).roles.owner.pending, undefined);
  assert.equal(reopened.city('owner'), '纸月城');
  assert.deepEqual(reopened.pending('friend'), friend);
  reopened.waitForCity('owner', { kind: 'morning', days: [0, 1] });
  assert.equal(reopened.pending('owner').createdAt, f.now());
  f.setTime('2026-11-08T08:00:00+08:00');
  assert.equal(reopened.pending('owner'), null);
});

test('undated legacy pending expires silently and a new query gets its own lifetime', t => {
  const f = fixture(t);
  f.store.waitForCity('owner', { kind: 'query', days: [2] });
  const state = JSON.parse(fs.readFileSync(f.stateFile));
  delete state.roles.owner.pending.createdAt;
  delete state.roles.owner.pending.expiresAt;
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  assert.equal(f.store.pending('owner'), null);
  assert.equal(f.store.city('owner'), '纸月城');
  f.store.waitForCity('owner', { kind: 'query', days: [0] });
  assert.equal(f.store.pending('owner').expiresAt, f.now() + CITY_REPLY_TTL_MS);
});
test('weather commands parse exact dates, malformed city settings and avoid prose/quoted/combined requests', () => {
  for (const [text, result] of [
    ['天气', { type: 'query', days: [0, 1] }], ['今日天气', { type: 'query', days: [0] }],
    ['明天天气', { type: 'query', days: [1] }], ['明日天气', { type: 'query', days: [1] }],
    ['后天天气', { type: 'query', days: [2] }], ['天气早报测试', { type: 'test' }],
    ['设置天气城市：星湾城市', { type: 'set', city: '星湾城市' }], ['设置天气城市: 纸月城', { type: 'set', city: '纸月城' }],
    ['设置天气城市：', { type: 'set', city: '' }], ['设置天气城市：纸月城\n再执行', { type: 'set', city: '' }],
  ]) {
    assert.deepEqual(parse(` ${text} `), result);
  }
  for (const text of ['今天天气真好', '“天气”', '不要设置天气城市：纸月城', '天气然后转告好友', 'toString', '__proto__', {}, null]) assert.equal(parse(text), null);
});
test('formatter supplies city/date, day/night, high/low, winds and one rain/snow hint; zero is valid', () => {
  const reply = formatWeather('纸月城', '2026-11-06', cast('2026-11-06'), '今日');
  assert.match(reply, /纸月城｜2026-11-06 今日/);
  assert.match(reply, /白天：小雨；夜间：多云/);
  assert.match(reply, /最高：20℃；最低：12℃/);
  assert.match(reply, /北风3-4级；夜间：东风1-3级/);
  assert.match(reply, /带伞/);
  assert.match(formatWeather('纸月城', '2026-11-06', { ...cast('2026-11-06'), nightWeather: '雪', nightTemp: '0' }, '今日'), /最低：0℃[\s\S]*添衣/);
  const missing = formatWeather('纸月城', '2026-11-06', { date: '2026-11-06', dayWeather: '晴', dayTemp: 'NaN' }, '今日');
  assert.match(missing, /夜间：暂无数据/); assert.match(missing, /最高：暂无数据/);
  assert.doesNotMatch(missing, /带伞|添衣|NaN|undefined/);
  assert.match(formatWeather('纸月城', '2026-11-06', cast('2026-11-05'), '今日'), /暂时查不到/);
});
test('unresolvable/wrong cities retain prior setting and return explicit errors', async t => {
  const f = fixture(t); await f.say('设置天气城市：星湾城');
  f.provider.searchPlace = async () => [{ name: '纸月城博物馆', city: '纸月城市', adcode: '310000' }];
  assert.match((await f.say('设置天气城市：不存在城')).reply, /换个城市名/);
  assert.equal(f.store.city('owner'), '星湾城');
  assert.match((await f.say('天气')).reply, /无法解析天气城市/);
  f.provider.searchPlace = async () => { throw new Error('offline'); };
  assert.match((await f.say('设置天气城市：星湖城')).reply, /原设置未修改/);
});
test('stored city, date offsets at Shanghai midnight, and partial/unavailable forecasts are explicit', async t => {
  const f = fixture(t); f.setTime('2026-12-31T16:01:00Z');
  assert.deepEqual(shanghaiClock(Date.parse('2026-12-31T16:01:00Z')), { date: '2027-01-01', minute: 1 });
  const reply = (await f.say('后天天气')).reply;
  assert.match(reply, /纸月城｜2027-01-03 后天/);
  assert.deepEqual(f.calls.filter(item => item[0] === 'weather').map(item => item[2]), ['2027-01-03']);
  f.provider.weather = async (_place, date) => {
    if (date === '2027-01-02') throw new Error('unavailable');
    return cast(date);
  };
  const partial = await f.say('天气'); assert.equal(partial.ok, false);
  assert.match(partial.reply, /2027-01-01 今日[\s\S]*2027-01-02\n天气暂时查不到/);
  f.provider.weather = async () => ({ date: '1900-01-01', dayWeather: '晴' });
  assert.equal((await f.say('今日天气')).ok, false);
});
test('existing combined provider falls back from AMap weather to Open-Meteo without inventing night data', async t => {
  const requested = [];
  const provider = createPlaceProvider({ apiKey: 'fake', fetchImpl: async url => {
    requested.push(String(url));
    return { ok: true, json: async () => String(url).includes('weatherInfo')
      ? { status: '0', info: 'UNKNOWN_ERROR' }
      : { daily: { time: ['2026-11-06'], weather_code: [61], temperature_2m_max: [21], temperature_2m_min: [12], wind_speed_10m_max: [20] } } };
  } });
  const forecast = await provider.weather({ provider: 'amap', adcode: '310000', latitude: 31, longitude: 121 }, '2026-11-06');
  const text = formatWeather('纸月城', '2026-11-06', forecast, '今日');
  assert.match(text, /白天：暂无单独数据；夜间：暂无数据/);
  assert.match(text, /全天预报：有雨/); assert.match(text, /最大风速约20km\/h/);
  assert.equal(requested.length, 2); assert.match(requested[1], /api.open-meteo.com/);
});
test('fallback null/missing measurements do not become zero, NaN or an invented sunny forecast', async () => {
  const { createOpenPlaceProvider } = require('../src/amap-place-provider');
  const provider = createOpenPlaceProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({
    daily: { time: ['2026-11-06'], weather_code: [null], temperature_2m_max: [null], temperature_2m_min: [undefined], wind_speed_10m_max: [null] },
  }) }) });
  const forecast = await provider.weather({ latitude: 31, longitude: 121 }, '2026-11-06');
  assert.equal(forecast.dayWeather, ''); assert.equal(forecast.dayTemp, ''); assert.equal(forecast.nightTemp, ''); assert.equal(forecast.windText, '');
  assert.match(formatWeather('纸月城', '2026-11-06', forecast, '今日'), /暂时查不到/);
});
test('no implicit Shanghai: first query prompts, bare city persists and completes the requested dates across restart', async t => {
  const f = fixture(t, { city: '' });
  const first = await f.say('后天天气');
  assert.match(first.reply, /直接回城市名或「设置天气城市：城市名」/);
  assert.equal(first.needsCity, true); assert.equal(f.calls.length, 0);
  const reopened = createWeatherCommands({ store: createWeatherStore({ stateFile: f.stateFile, now: f.now }), provider: f.provider,
    now: () => Date.parse('2026-11-06T08:01:00+08:00') });
  const command = reopened.selectInput('owner', '星湾城'); assert.equal(command.type, 'city_reply');
  const result = await reopened.handle('owner', command);
  assert.match(result.reply, /已设置小林的天气城市：星湾城。[\s\S]*星湾城｜2026-11-08 后天/);
  assert.equal(f.store.pending('owner'), null); assert.equal(f.store.city('friend'), '');
  assert.match(result.reply, /\n看用法回：天气说明$/);
});
test('pending queries accept explicit setting, isolate sides, and do not capture other commands or invalid cities', async t => {
  const f = fixture(t, { city: '' });
  await f.say('天气'); await f.say('明天天气', 'friend');
  assert.equal(f.weather.selectInput('owner', '我的待办', { isCommand: true }), null);
  f.provider.searchPlace = async name => name === '随便聊聊' ? [] : [{ name, adcode: '1' }];
  assert.match((await f.weather.handle('owner', f.weather.selectInput('owner', '随便聊聊'))).reply, /解析不了这个天气城市/);
  assert.equal(f.store.city('owner'), '');
  const friend = await f.say('设置天气城市：云桥城', 'friend');
  assert.match(friend.reply, /云桥城｜2026-11-07 明日/); assert.doesNotMatch(friend.reply, /2026-11-06 今日/);
  assert.equal(f.store.city('owner'), ''); assert.equal(f.store.city('friend'), '云桥城');
  assert.equal(f.store.pending('owner').kind, 'query');
  assert.match((await f.say('星湾城')).reply, /星湾城｜2026-11-06 今日/);
  assert.equal(f.store.city('friend'), '云桥城');
});
test('weather manual is compact, section-only, side-isolated, expiring, and exits for other commands', async t => {
  const f = fixture(t);
  const catalog = (await f.say('天气说明')).reply;
  assert.equal(catalog.split('\n').length, 6);
  assert.match(catalog, /1 怎么查天气[\s\S]*4 数据来源与说明/);
  assert.doesNotMatch(catalog, /天气早报测试|Open-Meteo/);
  assert.equal(f.weather.selectInput('friend', '1'), null);
  const section = await f.say('1'); assert.match(section.reply, /今日天气/); assert.doesNotMatch(section.reply, /Open-Meteo/);
  assert.match((await f.say('天气帮助', 'friend')).reply, /1 怎么查天气/);
  assert.match((await f.say('城市', 'friend')).reply, /互不覆盖/);
  assert.equal(f.weather.selectInput('owner', '我的待办', { isCommand: true }), null);
  assert.equal(f.weather.selectInput('owner', '1'), null);
  assert.match((await f.say('来源', 'friend')).reply, /Open-Meteo/);
  f.setTime('2026-11-06T08:15:00+08:00'); assert.equal(f.weather.selectInput('friend', '1'), null);
  await f.say('天气说明'); await f.say('天气'); assert.equal(f.weather.selectInput('owner', '1'), null);
});
test('every weather reply including errors/settings/test/manual has one footer', async t => {
  const f = fixture(t, { city: '' });
  for (const text of ['天气', '设置天气城市：', '天气帮助', '1', '设置天气城市：星湾城', '天气早报测试', '关闭天气早报']) {
    const result = await f.say(text);
    assert.match(result.reply, /\n看用法回：天气说明$/);
    assert.equal(result.reply.split('看用法回：天气说明').length, 2);
  }
  assert.match((await f.weather.handle('stranger', parse('天气'))).reply, /看用法回：天气说明$/);
});

test('morning claims before send, deduplicates ticks/restarts, and catches up only before noon', async t => {
  const f = fixture(t); const job = f.scheduler();
  f.setTime('2026-11-06T07:59:59+08:00'); await job.tick(); assert.equal(f.sends.length, 0);
  f.setTime('2026-11-06T08:00:00+08:00'); await Promise.all([job.tick(), job.tick()]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][0], 'owner'); assert.equal(f.sends[0][2], 'weather-morning:owner:2026-11-06');
  assert.match(f.sends[0][1], /天气早报[\s\S]*今日[\s\S]*明日预告[\s\S]*带伞[\s\S]*看用法回：天气说明$/);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).roles.owner.status, 'sent');
  await f.scheduler().tick(); assert.equal(f.sends.length, 1);
  f.setTime('2026-11-07T11:59:59+08:00'); await f.scheduler().tick(); assert.equal(f.sends.length, 2);
  f.setTime('2026-11-08T12:00:00+08:00'); await f.scheduler().tick(); assert.equal(f.sends.length, 2);
});
test('uncertain send and unavailable forecasts persist failure without replay; other role still sends', async t => {
  const f = fixture(t); f.store.setCity('friend', '星湾城'); let calls = 0;
  const send = async side => {
    calls++;
    assert.equal(f.store.attempted(side, '2026-11-06'), true);
    if (side === 'owner') throw new Error('uncertain acceptance');
  };
  await f.scheduler({ sides: ['owner', 'friend'], send }).tick();
  await f.scheduler({ sides: ['owner', 'friend'], send }).tick();
  assert.equal(calls, 2); assert.equal(f.logs.length, 1);
  const state = JSON.parse(fs.readFileSync(f.stateFile)).roles;
  assert.equal(state.owner.status, 'failed'); assert.equal(state.owner.sentDate, '');
  assert.equal(state.friend.status, 'sent');
  f.setTime('2026-11-07T08:00:00+08:00');
  f.provider.weather = async () => { throw Error('offline'); };
  await f.scheduler().tick(); const count = f.calls.length;
  await f.scheduler().tick(); assert.equal(f.calls.length, count);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).roles.owner.status, 'unavailable');
});
test('a lost sent-status write leaves the durable claim and cannot resend on restart', async t => {
  const f = fixture(t); let sends = 0;
  const store = { ...f.store, finish() { throw Error('disk unavailable'); } };
  const send = async () => { sends++; };
  await f.scheduler({ store, send }).tick(); await f.scheduler({ send }).tick();
  assert.equal(sends, 1); assert.equal(f.store.attempted('owner', '2026-11-06'), true);
});
test('morning switches and test queries belong to each role independently', async t => {
  const f = fixture(t); f.store.setCity('friend', '星湾城');
  await f.say('关闭天气早报'); await f.say('开启天气早报', 'friend');
  await f.scheduler({ sides: ['owner', 'friend'] }).tick();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0][0], 'friend');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  assert.match((await f.say('天气早报测试', 'friend')).reply, /测试，不影响定时早报[\s\S]*星湾城/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  await f.say('开启天气早报'); await f.scheduler().tick(); assert.equal(f.sends.length, 2);
});
test('unset morning prompts once across restarts, expired query can restart and morning starts tomorrow', async t => {
  const f = fixture(t, { city: '' });
  await f.say('后天天气'); await f.scheduler().tick();
  assert.equal(f.store.pending('owner').kind, 'query');
  assert.equal(f.sends.length, 1); assert.match(f.sends[0][1], /先选/);
  f.setTime('2026-11-07T08:00:00+08:00'); await f.scheduler().tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.store.pending('owner'), null);
  assert.equal(f.weather.selectInput('owner', '纸月城'), null);
  assert.equal((await f.say('后天天气')).needsCity, true);
  assert.match((await f.say('纸月城')).reply, /2026-11-09 后天/);
  await f.scheduler().tick(); assert.equal(f.sends.length, 1);
  f.setTime('2026-11-08T08:00:00+08:00'); await f.scheduler().tick(); assert.equal(f.sends.length, 2);
  assert.equal(f.store.city('friend'), '');
});
test('custom morning time validates HH:MM and slow forecasts cannot send past the window', async t => {
  for (const value of ['8:00', '24:00', '08:60', '', '08:00:00']) assert.throws(() => morningMinute(value), /HH:MM/);
  const f = fixture(t); const job = f.scheduler({ time: '09:15' });
  await job.tick(); assert.equal(f.sends.length, 0);
  f.setTime('2026-11-06T09:15:00+08:00'); await job.tick(); assert.equal(f.sends.length, 1);
  f.setTime('2026-11-07T11:59:59+08:00');
  await f.scheduler({ weather: { async briefing() {
    f.setTime('2026-11-07T12:00:00+08:00'); return { ok: true, reply: 'expired' };
  } } }).tick(); assert.equal(f.sends.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).roles.owner.status, 'expired');
  f.setTime('2026-11-08T13:00:00+08:00'); await f.scheduler({ time: '13:00' }).tick(); assert.equal(f.sends.length, 2);
  f.setTime('2026-11-09T13:01:00+08:00'); await f.scheduler({ time: '13:00' }).tick(); assert.equal(f.sends.length, 2);
});
test('weather state writes to classified default/custom paths, is private and fails closed on corruption', t => {
  const f = fixture(t, { city: '' });
  const defaults = createWeatherStore({ runtime: f.root, env: {} });
  defaults.setCity('friend', '星湾城');
  assert.equal(defaults.stateFile, path.join(f.root, 'state', 'features', 'weather', 'state.json'));
  assert.equal(fs.statSync(defaults.stateFile).mode & 0o777, 0o600);
  const custom = createWeatherStore({ runtime: f.root, env: { WEATHER_STATE_FILE: 'state/custom-weather/settings.json' } });
  custom.setMorning('owner', false);
  assert.equal(custom.stateFile, path.join(f.root, 'state', 'custom-weather', 'settings.json'));
  assert.equal(createWeatherStore({ stateFile: custom.stateFile }).morningAllowed('owner', '2026-11-06'), false);
  const configured = createWeatherStore({ env: { WECHAT_ASSISTANT_HOME: f.root, WEATHER_STATE_FILE: 'state/env-weather.json' } });
  configured.setCity('owner', '纸月城'); assert.ok(fs.existsSync(path.join(f.root, 'state', 'env-weather.json')));
  assert.throws(() => custom.setCity('stranger', '纸月城'), /身份无效/);
  fs.writeFileSync(custom.stateFile, '{bad');
  assert.throws(() => custom.setCity('owner', '纸月城'), /Invalid JSON/);
  assert.equal(fs.readFileSync(custom.stateFile, 'utf8'), '{bad');
});
test('public assistant and console wire weather, preserve roles and exit manuals for other feature commands', async t => {
  const { createPublicAssistant } = require('../src/public-assistant');
  const { createPairConsole } = require('../src/public-pair-console');
  const f = fixture(t, { city: '' });
  const options = { runtime: f.root, weatherStore: f.store, weatherProvider: f.provider, now: f.now,
    model: async () => { throw Error('Weather must never use model'); } };
  const host = createPublicAssistant(options);
  assert.match(await host.reply('天气'), /先选/);
  assert.match(await host.reply('纸月城'), /纸月城｜2026-11-06 今日[\s\S]*2026-11-07 明日/);
  assert.match(await host.reply('天气', 'friend'), /先选/);
  assert.match(await host.reply('星湾城', 'friend'), /星湾城｜2026-11-06 今日/);
  await host.reply('天气说明'); await host.reply('天气说明', 'friend');
  await host.reply('我的待办'); assert.equal(host.weather.selectInput('owner', '1'), null);
  assert.match(await host.reply('1', 'friend'), /怎么查天气/);
  const console = createPairConsole(options);
  await console.reply('天气说明'); await console.reply('查看想去箱');
  assert.equal(console.weather.selectInput('owner', '1'), null);
  await console.reply('天气说明'); await console.reply('切换 小周');
  await console.reply('天气说明'); await console.reply('切换 小林');
  assert.match(await console.reply('1'), /怎么查天气/);
  await console.reply('切换 小周'); assert.match(await console.reply('今日天气'), /星湾城｜/);
});
test('default console uses the real keyless provider contract and reports offline lookup honestly', async t => {
  const { createPairConsole } = require('../src/public-pair-console');
  const f = fixture(t, { city: '' }); const urls = []; let offline = false;
  t.mock.method(global, 'fetch', async url => {
    if (offline) throw Error('network unavailable');
    urls.push(new URL(url));
    if (url.hostname === 'nominatim.openstreetmap.org') return { ok: true, json: async () => [
      { name: '纸月城', lat: '30', lon: '120', address: { city: '纸月城' } },
    ] };
    return { ok: true, json: async () => ({ daily: { time: ['2026-11-06', '2026-11-07'],
      weather_code: [61, 3], temperature_2m_max: [20.4, 21.5], temperature_2m_min: [12, 13], wind_speed_10m_max: [8, 9] } }) };
  });
  const host = createPairConsole({ runtime: f.root, now: f.now, weatherStore: f.store });
  await host.reply('天气');
  assert.match(await host.reply('纸月城'), /全天预报：有雨[\s\S]*最高：20℃[\s\S]*Open-Meteo/);
  assert.ok(urls.some(url => url.hostname === 'api.open-meteo.com'));
  assert.ok(urls.every(url => !url.searchParams.has('key')));
  offline = true;
  assert.match(await host.reply('今日天气'), /暂时查不到/);
});
test('demo uses no network even if fetch fails', async t => {
  t.mock.method(global, 'fetch', async () => { throw Error('demo must be offline'); });
  const lines = [];
  await require('../scripts/demo').demo({ log: text => lines.push(text) });
  assert.match(lines.join('\n'), /第五幕 · 天气 \+ 每日早报（模拟）[\s\S]*小林 模拟发送/);
});

test('city-prefixed weather parses two-day and single-day queries without claiming combined requests', () => {
  for (const [text, days] of [['纸月城天气', [0, 1]], ['纸月城今日天气', [0]],
    ['纸月城明天天气', [1]], ['纸月城明日天气', [1]], ['纸月城后天天气', [2]]]) {
    assert.deepEqual(parse(text), { type: 'query', city: '纸月城', days });
  }
  for (const text of ['“纸月城天气”', '纸月城天气然后转告好友', '纸月城天气，帮我转告', '纸月城天气\n再执行']) {
    assert.equal(parse(text), null);
  }
});

test('city-prefixed queries save only their role, override pending dates and confirm before forecast across restart', async t => {
  for (const side of ['owner', 'friend']) {
    for (const pending of [false, true]) {
      for (const [text, dates] of [['纸月城天气', ['2026-11-06', '2026-11-07']],
        ['纸月城今日天气', ['2026-11-06']], ['纸月城明天天气', ['2026-11-07']],
        ['纸月城明日天气', ['2026-11-07']], ['纸月城后天天气', ['2026-11-08']]]) {
        const f = fixture(t, { city: '' });
        const other = side === 'owner' ? 'friend' : 'owner';
        f.store.setCity(other, '星湾城');
        f.store.waitForCity(other, { kind: 'query', days: [0] });
        const otherBefore = JSON.parse(fs.readFileSync(f.stateFile)).roles[other];
        if (pending) f.store.waitForCity(side, { kind: 'query', days: [2] });
        const command = f.weather.selectInput(side, text);
        assert.deepEqual(command, parse(text));
        const result = await f.weather.handle(side, command);
        assert.equal(result.ok, true);
        assert.match(result.reply, new RegExp(`^已设置${side === 'owner' ? '小林' : '小周'}的天气城市：纸月城。\\n\\n纸月城｜`));
        const reopened = createWeatherStore({ stateFile: f.stateFile, now: f.now });
        assert.equal(reopened.city(side), '纸月城'); assert.equal(reopened.pending(side), null);
        assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).roles[other], otherBefore);
        assert.deepEqual(f.calls.filter(call => call[0] === 'weather').map(call => call[2]), dates);
        assert.ok(f.calls.filter(call => call[0] === 'city').every(call => call[1] === '纸月城'));
        assert.equal(result.reply.split('看用法回：天气说明').length, 2);
      }
    }
  }
});

test('all city selection failures report categories without content and preserve settings and pending byte-for-byte', async t => {
  for (const side of ['owner', 'friend']) {
    for (const pending of [null, 'query', 'morning']) {
      for (const type of ['set', 'city_reply', 'query']) {
        for (const fails of ['empty', 'throw', 'wrong-city']) {
          const f = fixture(t);
          f.store.setCity('friend', '星湾城');
          if (pending) f.store.waitForCity(side, { kind: pending, days: [2] });
          const before = fs.readFileSync(f.stateFile, 'utf8');
          f.provider.searchPlace = async () => {
            if (fails === 'throw') throw Error('synthetic provider error containing 未知城');
            return fails === 'empty' ? [] : [{ name: '别的地方', adcode: 'demo-city' }];
          };
          const result = await f.weather.handle(side, { type, city: '未知城', days: [0, 1] });
          assert.equal(result.ok, false);
          assert.equal(result.reply, '解析不了这个天气城市，请换个城市名再试；原设置未修改。\n看用法回：天气说明');
          assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
          assert.deepEqual(f.logs, [`weather city resolution failed type=${type} reason=${fails === 'throw' ? 'provider_error' : 'no_match'}`]);
          assert.equal(f.calls.filter(call => call[0] === 'weather').length, 0);
        }
      }
    }
  }
});

test('pending city selection excludes weather-bearing prose and preserves other command admission', async t => {
  const f = fixture(t, { city: '' });
  await f.say('天气');
  for (const text of ['纸月城天气然后转告好友', '天气真好', '“纸月城天气”']) {
    assert.equal(f.weather.selectInput('owner', text), null);
  }
  assert.equal(f.weather.selectInput('owner', '我的待办', { isCommand: true }), null);
  assert.equal(f.store.pending('owner').kind, 'query');
  assert.equal(f.weather.selectInput('owner', '纸月城天气').type, 'query');
  assert.equal(f.weather.selectInput('owner', '纸月城').type, 'city_reply');
});
