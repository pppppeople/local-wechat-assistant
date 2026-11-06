'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  amapRoutable, createAmapPlaceProvider, createOpenPlaceProvider, createPlaceProvider, weatherCodeText,
} = require('../src/amap-place-provider');

function fakeTimers(t) {
  const pending = new Set();
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay };
    pending.add(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', (timer) => {
    assert.ok(pending.delete(timer), 'clear only a pending fake timer');
  });
  t.after(() => assert.equal(pending.size, 0, 'request timers must be cleared'));
  return pending;
}

function fakeAmap(t, payload = { status: '1', pois: [] }) {
  fakeTimers(t);
  const requests = [];
  const provider = createAmapPlaceProvider({
    apiKey: '  fake-key &+  ',
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(String(url)), options });
      return { ok: true, async json() { return payload; } };
    },
  });
  return { provider, requests };
}

test('combined provider skips requests for non-AMap nearby places and walking endpoints', async () => {
  let calls = 0;
  const provider = createPlaceProvider({
    apiKey: 'fake-key',
    fetchImpl: async () => { calls += 1; throw new Error('unexpected fetch'); },
  });
  const amapPlace = { provider: 'amap', longitude: 105.3, latitude: 32.1 };
  const openPlace = { ...amapPlace, provider: 'osm' };
  assert.deepEqual(await provider.nearby(openPlace), []);
  assert.equal(await provider.walkingRoute(openPlace, amapPlace), null);
  assert.equal(await provider.walkingRoute(amapPlace, openPlace), null);
  assert.equal(await provider.walkingRoute(null, null), null);
  assert.equal(calls, 0);
});

test('combined provider routes walking between AMap places', async (t) => {
  fakeTimers(t);
  const requests = [];
  const provider = createPlaceProvider({
    apiKey: 'fake-key',
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(String(url)), options });
      return { ok: true, async json() { return { status: 1, route: { paths: [{ distance: 650, duration: 540 }] } }; } };
    },
  });
  const origin = { provider: 'amap', longitude: 105.3, latitude: 32.1 };
  const destination = { provider: 'amap', longitude: 105.31, latitude: 32.11 };
  const route = await provider.walkingRoute(origin, destination);
  assert.equal(route.distanceMeters, 650);
  assert.equal(route.durationSeconds, 540);
  assert.equal(requests[0].url.pathname, '/v3/direction/walking');
  assert.equal(requests[0].url.searchParams.get('origin'), '105.3,32.1');
});

test('AMap search encodes and truncates keywords and selects city limits', async (t) => {
  const { provider, requests } = fakeAmap(t);
  const query = `咖啡 &+?/${'馆'.repeat(120)}`;
  await provider.searchPlace(query, '甲城 & 乙城');
  await provider.searchPlace(123);
  const first = requests[0];
  assert.equal(first.url.origin, 'https://restapi.amap.com');
  assert.equal(first.url.pathname, '/v3/place/text');
  assert.equal(first.url.searchParams.get('keywords'), query.slice(0, 120));
  assert.equal(first.url.searchParams.get('city'), '甲城 & 乙城');
  assert.equal(first.url.searchParams.get('citylimit'), 'true');
  assert.equal(first.url.searchParams.get('key'), 'fake-key &+');
  assert.equal(first.url.searchParams.get('offset'), '5');
  assert.equal(first.url.searchParams.get('page'), '1');
  assert.deepEqual(first.options.headers, { Accept: 'application/json' });
  assert.ok(first.options.signal instanceof AbortSignal);
  assert.equal(requests[1].url.searchParams.get('keywords'), '123');
  assert.equal(requests[1].url.searchParams.get('city'), '');
  assert.equal(requests[1].url.searchParams.get('citylimit'), 'false');
});

test('AMap rejects missing keys and district codes before fetching', async (t) => {
  const pending = fakeTimers(t);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; assert.fail('unexpected fetch'); };
  const unconfigured = createAmapPlaceProvider({ apiKey: ' \t ', fetchImpl });
  assert.equal(unconfigured.available, false);
  assert.equal(unconfigured.fullCapabilities, false);
  await assert.rejects(unconfigured.searchPlace('咖啡'), /地图服务尚未配置/);
  const configured = createAmapPlaceProvider({ apiKey: 'fake', fetchImpl });
  await assert.rejects(configured.weather({}, '2026-10-25'), /缺少可用的区县编码/);
  assert.equal(calls, 0);
  assert.equal(pending.size, 0);
});

test('AMap search normalizes POIs, removes incomplete entries and caps results at three', async (t) => {
  const valid = { id: 7, name: '馆'.repeat(121), location: '105.3,32.1', pname: '北京市', cityname: '北京市', adname: '海淀区', address: '测试路', type: '博物馆;公园' };
  const { provider } = fakeAmap(t, { status: 1, pois: [
    {}, { ...valid, id: '' }, { ...valid, name: '' },
    { ...valid, location: 'not-a-number,23' }, { ...valid, location: '113' },
    valid, { ...valid, id: 'second', cityname: '' },
    { ...valid, id: 'third', location: '0,0' }, { ...valid, id: 'fourth' },
  ] });
  const places = await provider.searchPlace('馆');
  assert.equal(places.length, 3);
  assert.deepEqual(places.map((place) => place.providerId), ['7', 'second', 'third']);
  assert.equal(places[0].provider, 'amap');
  assert.equal(places[0].name, '馆'.repeat(120));
  assert.equal(places[0].address, '北京市海淀区测试路');
  assert.equal(places[0].province, '北京市');
  assert.equal(places[0].district, '海淀区');
  assert.equal(places[0].category, '博物馆;公园');
  assert.deepEqual(places[0].tags, ['室内', '户外']);
  assert.equal(places[0].longitude, 105.3);
  assert.equal(places[0].latitude, 32.1);
  assert.equal(places[1].city, '北京市');
  assert.equal(places[2].longitude, 0);
  assert.equal(places[2].latitude, 0);
});

test('AMap propagates transport, HTTP, API and malformed JSON errors and clears timers', async (t) => {
  fakeTimers(t);
  const transportError = new Error('fake transport failure');
  const jsonError = new SyntaxError('fake malformed JSON');
  const cases = [
    { fetchImpl: async () => { throw transportError; }, expected: (error) => error === transportError },
    { response: { ok: false, status: 503, json: () => assert.fail('HTTP errors must not parse JSON') }, expected: /地图服务返回 HTTP 503/ },
    { response: { ok: true, json: async () => { throw jsonError; } }, expected: (error) => error === jsonError },
    { payload: { status: '0', info: 'INVALID_USER_KEY' }, expected: /INVALID_USER_KEY/ },
    { payload: {}, expected: /地图服务查询失败/ },
    { payload: { status: '1', pois: {} }, expected: TypeError },
  ];
  for (const entry of cases) {
    const provider = createAmapPlaceProvider({
      apiKey: 'fake',
      fetchImpl: entry.fetchImpl || (async () => entry.response || { ok: true, json: async () => entry.payload }),
    });
    await assert.rejects(provider.searchPlace('咖啡'), entry.expected);
  }
});

test('AMap timeout aborts the injected transport without a real timer', async (t) => {
  const pending = fakeTimers(t);
  const abortError = new Error('fake transport aborted');
  const provider = createAmapPlaceProvider({
    apiKey: 'fake', timeoutMs: 37,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      assert.equal(signal.aborted, false);
      signal.addEventListener('abort', () => reject(abortError), { once: true });
      const [timer] = pending;
      assert.equal(timer.delay, 37);
      timer.callback();
      assert.equal(signal.aborted, true);
    }),
  });
  await assert.rejects(provider.searchPlace('咖啡'), (error) => error === abortError);
  assert.equal(pending.size, 0);
});

test('AMap nearby clamps radius, excludes the source POI and returns at most eight places', async (t) => {
  const poi = { id: 'self', name: '咖啡', location: '105.3,32.1' };
  const { provider, requests } = fakeAmap(t, { status: '1', pois: [
    poi, ...Array.from({ length: 10 }, (_, i) => ({ ...poi, id: `near-${i}` })),
  ] });
  const place = { providerId: 'self', longitude: 105.3, latitude: 32.1 };
  const cases = [[undefined, 2500], [0, 2500], ['bad', 2500], [-1, 500], [500, 500], ['1200', 1200], [5000, 5000], [5001, 5000]];
  for (const [radius, expected] of cases) {
    const nearby = await provider.nearby(place, radius);
    const { url } = requests.at(-1);
    assert.equal(url.pathname, '/v3/place/around');
    assert.equal(url.searchParams.get('location'), '105.3,32.1');
    assert.equal(url.searchParams.get('radius'), String(expected));
    assert.equal(url.searchParams.get('types'), '050000|060000|110000|140000');
    assert.equal(url.searchParams.get('sortrule'), 'distance');
    assert.equal(url.searchParams.get('offset'), '12');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get('extensions'), 'base');
    assert.deepEqual(nearby.map((entry) => entry.providerId), Array.from({ length: 8 }, (_, i) => `near-${i}`));
  }
});

test('AMap weather selects the requested cast, normalizes fields and rejects unavailable dates', async (t) => {
  const date = '2026-10-25';
  const forecast = { city: '戊城区区', reporttime: '2026-10-25 09:00:00', casts: [
    { date: '2026-10-24', dayweather: '雨' },
    { date, dayweather: '晴', nightweather: '多云', daytemp: 28, nighttemp: 21, daywind: '北', daypower: 3, nightwind: '东', nightpower: '1-3' },
  ] };
  const { provider, requests } = fakeAmap(t, { status: '1', forecasts: [forecast] });
  const place = { adcode: '440106', district: '备用区', city: '备用市' };
  assert.deepEqual(await provider.weather(place, date), {
    city: '戊城区区', reportTime: forecast.reporttime, date,
    dayWeather: '晴', nightWeather: '多云', dayTemp: '28', nightTemp: '21',
    dayWind: '北', dayPower: '3', nightWind: '东', nightPower: '1-3', windText: '北风3级',
  });
  assert.equal(requests[0].url.pathname, '/v3/weather/weatherInfo');
  assert.equal(requests[0].url.searchParams.get('city'), '440106');
  assert.equal(requests[0].url.searchParams.get('extensions'), 'all');
  await assert.rejects(provider.weather(place, '2026-11-01'), /目标日期超出当前天气预报范围/);
  delete forecast.city;
  delete forecast.reporttime;
  forecast.casts = [{ date }];
  assert.deepEqual(await provider.weather(place, date), {
    city: '备用区', reportTime: '', date, dayWeather: '', nightWeather: '',
    dayTemp: '', nightTemp: '', dayWind: '', dayPower: '', nightWind: '', nightPower: '', windText: '',
  });
  delete forecast.casts;
  await assert.rejects(provider.weather(place, date), /目标日期超出当前天气预报范围/);
});

test('AMap walking builds endpoints, parses the first path and handles absent paths and fields', async (t) => {
  const payload = { status: '1', route: { paths: [{ distance: '650', duration: '540' }, { distance: '999' }] } };
  const { provider, requests } = fakeAmap(t, payload);
  const origin = { longitude: 105.3, latitude: 32.1 };
  const destination = { longitude: 105.31, latitude: 32.11 };
  assert.deepEqual(await provider.walkingRoute(origin, destination), { distanceMeters: 650, durationSeconds: 540 });
  assert.equal(requests[0].url.pathname, '/v3/direction/walking');
  assert.equal(requests[0].url.searchParams.get('origin'), '105.3,32.1');
  assert.equal(requests[0].url.searchParams.get('destination'), '105.31,32.11');
  payload.route.paths = [{}];
  assert.deepEqual(await provider.walkingRoute(origin, destination), { distanceMeters: 0, durationSeconds: 0 });
  payload.route.paths = [];
  assert.equal(await provider.walkingRoute(origin, destination), null);
  delete payload.route;
  assert.equal(await provider.walkingRoute(origin, destination), null);
});

test('AMap routing validates coordinate boundaries and caps matrices at twelve places', async (t) => {
  for (const longitude of [73, 136]) {
    for (const latitude of [18, 54]) assert.equal(amapRoutable({ longitude, latitude }), true);
  }
  for (const place of [null, {}, { longitude: '113', latitude: 23 },
    { longitude: NaN, latitude: 23 }, { longitude: 113, latitude: Infinity },
    { longitude: 72.999, latitude: 23 }, { longitude: 136.001, latitude: 23 },
    { longitude: 113, latitude: 17.999 }, { longitude: 113, latitude: 54.001 }]) {
    assert.equal(amapRoutable(place), false);
  }
  const { provider, requests } = fakeAmap(t, { status: '1' });
  for (const input of [undefined, {}, []]) assert.deepEqual(await provider.routeMatrix(input), []);
  assert.equal(requests.length, 0);
  const points = Array.from({ length: 13 }, (_, i) => ({ longitude: 113 + i / 100, latitude: 23 }));
  const matrix = await provider.routeMatrix(points);
  assert.equal(matrix.length, 12);
  assert.ok(matrix.every((row) => row.length === 12));
  assert.equal(requests.length, 12);
  for (const { url } of requests) {
    assert.equal(url.searchParams.get('origins').split('|').length, 12);
    assert.notEqual(url.searchParams.get('destination'), '105.12,23');
  }
  assert.equal(matrix[0][1], null, 'missing results leave estimates unknown');
});

test('AMap matrix falls back to response order and ignores nonfinite or out-of-range results', async (t) => {
  const { provider } = fakeAmap(t, { status: '1', results: [
    { distance: '100', duration: '60' },
    { origin_id: '0', distance: '200', duration: '120' },
    { origin_id: '3', distance: 'NaN', duration: '180' },
    { origin_id: '4', distance: '400', duration: 'Infinity' },
    { origin_id: '99', distance: '999', duration: '999' },
  ] });
  const matrix = await provider.routeMatrix(Array.from({ length: 4 }, (_, i) => ({ longitude: 113 + i / 100, latitude: 23 })));
  assert.deepEqual(matrix[0][3], { distanceMeters: 100, durationSeconds: 60 });
  assert.deepEqual(matrix[1][3], { distanceMeters: 200, durationSeconds: 120 });
  assert.equal(matrix[2][0], null);
  assert.equal(matrix[3][0], null);
});

test('open search bounds query fields, normalizes fallback fields and expires its trimmed-key cache', async (t) => {
  fakeTimers(t);
  const requests = [];
  let now = 10_000;
  let payload = [
    { lon: 'bad', lat: '23' },
    { place_id: 42, lon: '0', lat: '0', display_name: '展示名, 地址', address: { province: '省', town: '镇', suburb: '区' }, category: 'shop', type: 'books' },
    { osm_type: 'way', osm_id: 7, lon: '113', lat: '23', namedetails: { 'name:zh': '中文', name: 'English' }, name: '原名', display_name: '地'.repeat(301) },
  ];
  const provider = createOpenPlaceProvider({ now: () => now, fetchImpl: async (url) => {
    requests.push(new URL(String(url)));
    return { ok: true, json: async () => payload };
  } });
  const query = `咖啡 &+${'馆'.repeat(120)}`;
  const city = '市'.repeat(61);
  const places = await provider.searchPlace(query, city);
  assert.equal(requests[0].searchParams.get('q'), `${query.slice(0, 120)}, ${city.slice(0, 60)}`);
  for (const [key, value] of Object.entries({ format: 'jsonv2', limit: '3', addressdetails: '1', namedetails: '1', 'accept-language': 'zh-CN' })) {
    assert.equal(requests[0].searchParams.get(key), value);
  }
  assert.equal(places.length, 2);
  assert.equal(places[0].providerId, 'osm-place-42');
  assert.equal(places[0].name, '展示名');
  assert.equal(places[0].province, '省');
  assert.equal(places[0].city, '镇');
  assert.equal(places[0].district, '区');
  assert.equal(places[0].category, 'shop books');
  assert.equal(places[1].name, '中文');
  assert.equal(places[1].address.length, 300);
  now += 24 * 60 * 60 * 1000 - 1;
  assert.strictEqual(await provider.searchPlace(` ${query} `, ` ${city} `), places);
  assert.equal(requests.length, 1);
  now += 1;
  payload = { malformed: 'non-array search response' };
  assert.deepEqual(await provider.searchPlace(query, city), []);
  assert.equal(requests.length, 2);
});

test('open weather rejects invalid coordinates, missing dates and bad responses; maps other weather-code boundaries', async (t) => {
  fakeTimers(t);
  let calls = 0;
  let response = { ok: true, json: async () => ({}) };
  const provider = createOpenPlaceProvider({ fetchImpl: async () => { calls += 1; return response; } });
  for (const place of [{}, { longitude: '113', latitude: 23 }, { longitude: 113, latitude: NaN }]) {
    await assert.rejects(provider.weather(place, '2026-10-25'), /缺少可用坐标/);
  }
  assert.equal(calls, 0);
  const place = { longitude: 113, latitude: 23 };
  await assert.rejects(provider.weather(place, '2026-10-25'), /目标日期超出当前天气预报范围/);
  response = { ok: false, status: 429, json: () => assert.fail('HTTP errors must not parse JSON') };
  await assert.rejects(provider.weather(place, '2026-10-25'), /公开地图服务返回 HTTP 429/);
  const jsonError = new SyntaxError('fake malformed weather JSON');
  response = { ok: true, json: async () => { throw jsonError; } };
  await assert.rejects(provider.weather(place, '2026-10-25'), (error) => error === jsonError);
  for (const [codes, text] of [
    [[0], '晴'], [[45, 48], '雾'], [[51, 67, 80, 81, 82], '有雨'],
    [[71, 86], '有雪'], [[95, 99], '雷雨'], [[-1, 4, 50, 68, 70, 87, 94, 'bad', undefined], '天气状况不明'],
  ]) {
    for (const code of codes) assert.equal(weatherCodeText(code), text, String(code));
  }
});
