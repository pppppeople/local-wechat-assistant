'use strict';

const DAY_MINUTES = 9 * 60;
const FLEX_MINUTES = 45;
const MEAL_MINUTES = 60;
const MAX_STOPS = 4;
const DEFAULT_MAX_LEG_MINUTES = 90;

function estimateVisitMinutes(place) {
  const note = String(place.note || '');
  const hourMatch = note.match(/(?:玩|逛|停留|预计|大约|约)?\s*(\d+(?:\.\d+)?)\s*(?:个)?小时/u);
  if (hourMatch) return Math.max(30, Math.min(480, Math.round(Number(hourMatch[1]) * 60)));
  const minuteMatch = note.match(/(?:玩|逛|停留|预计|大约|约)?\s*(\d+)\s*分钟/u);
  if (minuteMatch) return Math.max(30, Math.min(480, Number(minuteMatch[1])));
  if (/半天/u.test(note)) return 240;
  const text = `${place.name || ''} ${place.category || ''} ${(place.tags || []).join(' ')}`;
  if (/地市级地名|省级地名|行政区划|(?:^|\s)[^\s]{2,12}市(?:\s|$)/u.test(text)) return 480;
  if (/主题乐园|游乐园|欢乐世界|欢乐海岸|大型主题乐园/u.test(text)) return 300;
  if (/动物园|植物园|大型公园|风景区|景区|度假区/u.test(text)) return 180;
  if (/博物馆|美术馆|科技馆|展览馆|文化馆/u.test(text)) return 150;
  if (/古镇|步行街|历史街区|创意园/u.test(text)) return 150;
  if (/餐厅|餐饮|酒楼|小吃/u.test(text)) return 75;
  if (/咖啡|书店|商场|购物/u.test(text)) return 90;
  return 120;
}

function travelMinutes(matrix, fromIndex, toIndex) {
  const seconds = matrix?.[fromIndex]?.[toIndex]?.durationSeconds;
  return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : Infinity;
}

function normalizeRegion(value) {
  return String(value || '').replace(/\s+/gu, '').replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/u, '');
}

function sameDayRegion(left, right) {
  const leftProvince = normalizeRegion(left?.province);
  const rightProvince = normalizeRegion(right?.province);
  if (leftProvince && rightProvince) return leftProvince === rightProvince;
  const leftCity = normalizeRegion(left?.city);
  const rightCity = normalizeRegion(right?.city);
  return Boolean(leftCity && rightCity && leftCity === rightCity);
}

function routeAllowed(entries, matrix, fromIndex, toIndex, maxLegMinutes) {
  return sameDayRegion(entries[fromIndex].place, entries[toIndex].place)
    && travelMinutes(matrix, fromIndex, toIndex) <= maxLegMinutes;
}

function categoryGroup(place) {
  const text = `${place.category || ''} ${(place.tags || []).join(' ')}`;
  if (/博物馆|美术馆|展览|文化|科技馆/u.test(text)) return 'culture';
  if (/餐饮|咖啡|小吃/u.test(text)) return 'food';
  if (/公园|景区|古镇|街区|动物园|植物园|游乐/u.test(text)) return 'outdoor';
  if (/商场|购物|书店/u.test(text)) return 'indoor';
  return 'other';
}

function planMinutes(path, entries, matrix) {
  const visits = path.reduce((sum, index) => sum + estimateVisitMinutes(entries[index].place), 0);
  const travel = path.slice(1).reduce((sum, index, offset) => sum + travelMinutes(matrix, path[offset], index), 0);
  const meal = visits >= 240 ? MEAL_MINUTES : 0;
  return { visits, travel, meal, flex: FLEX_MINUTES, total: visits + travel + meal + FLEX_MINUTES };
}

function itineraryScore(path, entries, matrix) {
  const totals = planMinutes(path, entries, matrix);
  const weather = path.reduce((sum, index) => sum + (entries[index].rating?.score || 50), 0);
  const diversity = new Set(path.map((index) => categoryGroup(entries[index].place))).size;
  return weather + path.length * 18 + diversity * 6 - totals.travel * 0.22;
}

function createDayPlan(entries, matrix, { focusId = '', maxLegMinutes = DEFAULT_MAX_LEG_MINUTES } = {}) {
  if (!Array.isArray(entries) || !entries.length || !Array.isArray(matrix) || matrix.length !== entries.length) return null;
  let best = null;
  function visit(path, remaining) {
    if (path.length) {
      const totals = planMinutes(path, entries, matrix);
      const hasFocus = !focusId || path.some((index) => entries[index].place.id === focusId);
      if (totals.total <= DAY_MINUTES && hasFocus) {
        const score = itineraryScore(path, entries, matrix);
        if (!best || path.length > best.path.length || (path.length === best.path.length && score > best.score)) {
          best = { path: [...path], totals, score };
        }
      }
    }
    if (path.length >= MAX_STOPS) return;
    for (const index of remaining) {
      if (path.length && !routeAllowed(entries, matrix, path.at(-1), index, maxLegMinutes)) continue;
      const next = [...path, index];
      if (planMinutes(next, entries, matrix).total > DAY_MINUTES) continue;
      visit(next, remaining.filter((candidate) => candidate !== index));
    }
  }
  visit([], entries.map((_, index) => index));
  if (!best) return null;
  return { ...best, entries: best.path.map((index) => entries[index]), matrixIndexes: best.path };
}

function clockText(minutesAfterTen) {
  const minutes = 10 * 60 + minutesAfterTen;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

module.exports = {
  FLEX_MINUTES,
  DEFAULT_MAX_LEG_MINUTES,
  MEAL_MINUTES,
  clockText,
  createDayPlan,
  estimateVisitMinutes,
  sameDayRegion,
  travelMinutes,
};
