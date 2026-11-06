'use strict';

const AMAP_BASE = 'https://restapi.amap.com';

function coordinates(value) {
  const [longitude, latitude] = String(value || '').split(',').map(Number);
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? { longitude, latitude } : null;
}

function amapRoutable(place) {
  return Number.isFinite(place?.longitude) && Number.isFinite(place?.latitude)
    && place.longitude >= 73 && place.longitude <= 136
    && place.latitude >= 18 && place.latitude <= 54;
}

function inferTags(type = '', name = '') {
  const value = `${type} ${name}`;
  const indoor = /博物馆|美术馆|展览|商场|购物|影剧院|电影院|室内|餐饮|咖啡|茶艺|书店|文化馆|科技馆/u.test(value);
  const outdoor = /公园|风景|自然|广场|步行街|古镇|海滩|山|湖|动物园|植物园|游乐场/u.test(value);
  return [...(indoor ? ['室内'] : []), ...(outdoor ? ['户外'] : [])];
}

function normalizedSearchText(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]+/gu, '');
}

function candidateMatchesQuery(candidate, query) {
  const requested = normalizedSearchText(query);
  const name = normalizedSearchText(candidate?.name);
  const location = normalizedSearchText(`${candidate?.province || ''}${candidate?.city || ''}${candidate?.district || ''}${candidate?.address || ''}`);
  if (!requested || !name) return false;
  if (requested === name) return true;
  if (!requested.includes(name)) return false;
  const qualifier = requested.replace(name, '');
  return !qualifier || location.includes(qualifier);
}

function createAmapPlaceProvider({ apiKey = '', fetchImpl = global.fetch, timeoutMs = 8000 } = {}) {
  const key = String(apiKey || '').trim();

  async function request(pathname, params) {
    if (!key) throw new Error('地图服务尚未配置');
    const url = new URL(pathname, AMAP_BASE);
    url.search = new URLSearchParams({ ...params, key }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`地图服务返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (String(payload.status) !== '1') throw new Error(String(payload.info || '地图服务查询失败'));
    return payload;
  }

  function normalizePoi(poi) {
    const point = coordinates(poi.location);
    if (!poi?.id || !poi?.name || !point) return null;
    return {
      provider: 'amap',
      providerId: String(poi.id),
      name: String(poi.name).slice(0, 120),
      address: [poi.pname, poi.cityname, poi.adname, poi.address].filter((part, index, array) => part && array.indexOf(part) === index).join(''),
      province: String(poi.pname || ''),
      city: String(poi.cityname || poi.pname || ''),
      district: String(poi.adname || ''),
      adcode: String(poi.adcode || ''),
      longitude: point.longitude,
      latitude: point.latitude,
      category: String(poi.type || ''),
      tags: inferTags(poi.type, poi.name),
      attribution: '高德地图',
    };
  }

  async function searchPlace(query, city = '') {
    const payload = await request('/v3/place/text', {
      keywords: String(query).slice(0, 120),
      city: String(city || ''),
      citylimit: city ? 'true' : 'false',
      offset: '5',
      page: '1',
      extensions: 'all',
    });
    return (payload.pois || []).map(normalizePoi).filter(Boolean).slice(0, 3);
  }

  async function weather(place, date) {
    if (!place.adcode) throw new Error('这个地点缺少可用的区县编码');
    const payload = await request('/v3/weather/weatherInfo', { city: place.adcode, extensions: 'all' });
    const forecast = payload.forecasts?.[0];
    const cast = (forecast?.casts || []).find((item) => item.date === date);
    if (!cast) throw new Error('目标日期超出当前天气预报范围');
    return {
      city: String(forecast.city || place.district || place.city || ''),
      reportTime: String(forecast.reporttime || ''),
      date: cast.date,
      dayWeather: String(cast.dayweather || ''),
      nightWeather: String(cast.nightweather || ''),
      dayTemp: String(cast.daytemp || ''),
      nightTemp: String(cast.nighttemp || ''),
      dayWind: String(cast.daywind || ''),
      dayPower: String(cast.daypower || ''),
      windText: cast.daywind ? `${cast.daywind}风${cast.daypower || ''}级` : '',
    };
  }

  async function nearby(place, radius = 2500) {
    const payload = await request('/v3/place/around', {
      location: `${place.longitude},${place.latitude}`,
      radius: String(Math.min(Math.max(Number(radius) || 2500, 500), 5000)),
      types: '050000|060000|110000|140000',
      sortrule: 'distance',
      offset: '12',
      page: '1',
      extensions: 'base',
    });
    return (payload.pois || []).map(normalizePoi).filter(Boolean)
      .filter((candidate) => candidate.providerId !== place.providerId)
      .slice(0, 8);
  }

  async function walkingRoute(origin, destination) {
    const payload = await request('/v3/direction/walking', {
      origin: `${origin.longitude},${origin.latitude}`,
      destination: `${destination.longitude},${destination.latitude}`,
    });
    const route = payload.route?.paths?.[0];
    if (!route) return null;
    return { distanceMeters: Number(route.distance || 0), durationSeconds: Number(route.duration || 0) };
  }

  async function routeMatrix(places) {
    const points = (Array.isArray(places) ? places : []).slice(0, 12);
    if (!points.length) return [];
    const matrix = points.map((_, originIndex) => points.map((__, destinationIndex) => (
      originIndex === destinationIndex ? { distanceMeters: 0, durationSeconds: 0 } : null
    )));
    const routableIndexes = points.map((place, index) => (amapRoutable(place) ? index : -1)).filter((index) => index >= 0);
    if (!routableIndexes.length) return matrix;
    const origins = routableIndexes.map((index) => `${points[index].longitude},${points[index].latitude}`).join('|');
    await Promise.all(routableIndexes.map(async (destinationIndex) => {
      const destination = points[destinationIndex];
      const payload = await request('/v3/distance', {
        origins,
        destination: `${destination.longitude},${destination.latitude}`,
        type: '1',
      });
      for (const [resultIndex, result] of (payload.results || []).entries()) {
        const declaredIndex = Number(result.origin_id) - 1;
        const routableOriginIndex = Number.isInteger(declaredIndex) && declaredIndex >= 0 ? declaredIndex : resultIndex;
        const originIndex = routableIndexes[routableOriginIndex];
        if (!Number.isInteger(originIndex) || originIndex === destinationIndex) continue;
        const distanceMeters = Number(result.distance);
        const durationSeconds = Number(result.duration);
        if (Number.isFinite(distanceMeters) && Number.isFinite(durationSeconds)) {
          matrix[originIndex][destinationIndex] = { distanceMeters, durationSeconds };
        }
      }
    }));
    return matrix;
  }

  return {
    available: Boolean(key),
    providerName: '高德地图',
    attribution: '高德地图',
    fullCapabilities: Boolean(key),
    nearby,
    routeMatrix,
    searchPlace,
    walkingRoute,
    weather,
  };
}

function weatherCodeText(code) {
  const value = Number(code);
  if (value === 0) return '晴';
  if ([1, 2, 3].includes(value)) return '多云';
  if ([45, 48].includes(value)) return '雾';
  if (value >= 51 && value <= 67) return '有雨';
  if (value >= 71 && value <= 86) return '有雪';
  if (value >= 95) return '雷雨';
  return '天气状况不明';
}

function createOpenPlaceProvider({ fetchImpl = global.fetch, timeoutMs = 8000, now = () => Date.now() } = {}) {
  const cache = new Map();
  let lastGeocodeAt = 0;

  async function getJson(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`公开地图服务返回 HTTP ${response.status}`);
    return response.json();
  }

  async function searchPlace(query, city = '') {
    const cacheKey = `${String(query).trim()}|${String(city).trim()}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < 24 * 60 * 60 * 1000) return cached.value;
    const waitMs = Math.max(0, 1000 - (now() - lastGeocodeAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastGeocodeAt = now();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
      q: [String(query).slice(0, 120), String(city).slice(0, 60)].filter(Boolean).join(', '),
      format: 'jsonv2',
      limit: '3',
      addressdetails: '1',
      namedetails: '1',
      'accept-language': 'zh-CN',
    }).toString();
    const payload = await getJson(url, { 'User-Agent': 'LocalWechatAssistant/0.1 (private two-person assistant)' });
    const value = (Array.isArray(payload) ? payload : []).map((item) => {
      const longitude = Number(item.lon);
      const latitude = Number(item.lat);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
      const address = item.address || {};
      const name = item.namedetails?.['name:zh'] || item.namedetails?.name || item.name || String(item.display_name || '').split(',')[0];
      return {
        provider: 'open',
        providerId: `osm-${item.osm_type || 'place'}-${item.osm_id || item.place_id}`,
        name: String(name || query).slice(0, 120),
        address: String(item.display_name || '').slice(0, 300),
        province: String(address.state || address.province || ''),
        city: String(address.city || address.town || address.county || ''),
        district: String(address.city_district || address.suburb || address.county || ''),
        adcode: '',
        longitude,
        latitude,
        category: `${item.category || ''} ${item.type || ''}`.trim(),
        tags: inferTags(`${item.category || ''} ${item.type || ''}`, name),
        attribution: '© OpenStreetMap contributors',
      };
    }).filter(Boolean);
    cache.set(cacheKey, { at: now(), value });
    return value;
  }

  async function weather(place, date) {
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) throw new Error('这个地点缺少可用坐标');
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: 'temperature_2m,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max',
      timezone: 'Asia/Shanghai',
      forecast_days: '8',
    }).toString();
    const payload = await getJson(url);
    const index = (payload.daily?.time || []).indexOf(date);
    if (index < 0) throw new Error('目标日期超出当前天气预报范围');
    return {
      city: String(place.district || place.city || place.name),
      reportTime: String(payload.current?.time || ''),
      date,
      dayWeather: weatherCodeText(payload.daily.weather_code?.[index]),
      nightWeather: '',
      dayTemp: String(Math.round(Number(payload.daily.temperature_2m_max?.[index]))),
      nightTemp: String(Math.round(Number(payload.daily.temperature_2m_min?.[index]))),
      dayWind: '',
      dayPower: '',
      windText: `最大风速约${Math.round(Number(payload.daily.wind_speed_10m_max?.[index]))}km/h`,
    };
  }

  return {
    available: true,
    providerName: '公开地图与天气',
    attribution: '© OpenStreetMap contributors；Open-Meteo',
    fullCapabilities: false,
    searchPlace,
    weather,
    async nearby() { return []; },
    async walkingRoute() { return null; },
  };
}

function createPlaceProvider(options = {}) {
  if (!options.apiKey) return createOpenPlaceProvider(options);
  const primary = createAmapPlaceProvider(options);
  const fallback = createOpenPlaceProvider(options);
  return {
    available: true,
    providerName: '高德地图；海外地点由 OpenStreetMap 补充',
    attribution: '高德地图；© OpenStreetMap contributors；Open-Meteo',
    fullCapabilities: true,
    async searchPlace(query, city = '') {
      const candidates = await primary.searchPlace(query, city);
      if (!candidates.length) return fallback.searchPlace(query, city);
      if (candidates.some((candidate) => candidateMatchesQuery(candidate, query))) return candidates;
      const openCandidates = await fallback.searchPlace(query, city);
      const matchingOpenCandidates = openCandidates.filter((candidate) => candidateMatchesQuery(candidate, query));
      return matchingOpenCandidates.length ? matchingOpenCandidates : candidates;
    },
    async weather(place, date) {
      if (place?.provider !== 'amap') return fallback.weather(place, date);
      try { return await primary.weather(place, date); }
      catch { return fallback.weather(place, date); }
    },
    async nearby(place, radius) {
      return place?.provider === 'amap' ? primary.nearby(place, radius) : fallback.nearby(place, radius);
    },
    async walkingRoute(origin, destination) {
      if (origin?.provider !== 'amap' || destination?.provider !== 'amap') return null;
      return primary.walkingRoute(origin, destination);
    },
    routeMatrix: primary.routeMatrix,
  };
}

module.exports = { amapRoutable, candidateMatchesQuery, createAmapPlaceProvider, createOpenPlaceProvider, createPlaceProvider, inferTags, weatherCodeText };
