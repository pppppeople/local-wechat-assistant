'use strict';

const { createFeatureManual } = require('./feature-manual');
const HELP = '天气：今日＋明日摘要；今日天气 / 明天天气 / 明日天气 / 后天天气：当日详情。设置天气城市：城市名。\n看用法回：天气说明';
const UNAVAILABLE = '天气暂时查不到，请稍后再试。\n看用法回：天气说明';
function parseWeatherCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value === '天气') return { type: 'query', days: [0, 1] };
  const offsets = { 今日天气: 0, 明天天气: 1, 明日天气: 1, 后天天气: 2 };
  if (Object.hasOwn(offsets, value)) return { type: 'query', days: [offsets[value]] };
  if (value === '天气早报测试') return { type: 'test' };
  if (['天气说明', '天气帮助'].includes(value)) return { type: 'help' };
  if (['开启天气早报', '关闭天气早报'].includes(value)) return { type: 'morning', enabled: value === '开启天气早报' };
  if (/^设置天气城市/u.test(value)) {
    const match = value.match(/^设置天气城市[：:]\s*([^\r\n]{1,60})$/u);
    return { type: 'set', city: match ? match[1].trim() : '' };
  }
  return null;
}
function shanghaiClock(now = Date.now()) {
  // Fixed UTC+08:00; Shanghai has no daylight-saving transitions in this runtime.
  const date = new Date(Number(now) + 8 * 3600000);
  return { date: date.toISOString().slice(0, 10), minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
}
const dayDate = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const present = value => typeof value === 'string' && value.trim() && !/^(?:NaN|null|undefined)$/iu.test(value.trim());
const textOrMissing = value => present(value) ? value : '暂无数据';
function temperature(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${value}℃` : '暂无数据';
}
function formatWeather(city, date, forecast, label) {
  if (!forecast || forecast.date !== date || (!present(forecast.dayWeather) && !present(forecast.nightWeather))) {
    return `${city}｜${date} ${label}\n天气暂时查不到。`;
  }
  const wind = (direction, power) => present(direction)
    ? `${direction}风${present(power) ? `${power}级` : '（风力暂无数据）'}` : '暂无数据';
  const lines = [
    `${city}｜${date} ${label}`,
    `白天：${forecast.weatherPeriod === 'daily' ? '暂无单独数据' : textOrMissing(forecast.dayWeather)}；夜间：${textOrMissing(forecast.nightWeather)}`,
    `最高：${temperature(forecast.dayTemp)}；最低：${temperature(forecast.nightTemp)}`,
    `白天风向风力：${wind(forecast.dayWind, forecast.dayPower)}；夜间：${wind(forecast.nightWind, forecast.nightPower)}`,
  ];
  if (forecast.weatherPeriod === 'daily') lines.splice(2, 0, `全天预报：${textOrMissing(forecast.dayWeather)}`);
  if (!present(forecast.dayWind) && present(forecast.windText)) lines.push(forecast.windText);
  const weather = `${forecast.dayWeather || ''}${forecast.nightWeather || ''}`;
  if (/雪/u.test(weather)) lines.push('有雨雪，出门带伞、添衣保暖。');
  else if (/雨/u.test(weather)) lines.push('有雨，出门记得带伞。');
  return lines.join('\n');
}
function cityMatches(place, city) {
  const normalize = value => String(value || '').replace(/(?:特别行政区|自治州|地区|省|市|县|区)$/u, '').trim();
  return [place.name, place.city, place.province, place.district].some(value => normalize(value) === normalize(city));
}
function createWeatherCommands({ provider, store, morningTime = '08:00', now = () => Date.now(), log = () => {} }) {
  const manual = createFeatureManual({ now });
  manual.register({ triggerWord: '天气说明', aliases: ['天气帮助'], intro: '查天气、选自己的城市，双方各自控制每日早报（发送需宿主接线）。', sections: [
    { title: '怎么查天气', keywords: ['查询', '查天气'], body: '回「天气」看今日＋明日；「今日天气」「明天天气」（或明日天气）「后天天气」看当日详情。首次未设城市会先请你选城，选好立即补查。' },
    { title: '怎么切换城市', keywords: ['城市', '切换城市'], body: '回「设置天气城市：城市名」即可更改自己的城市；待选时直接回城市名也可以。两人的设置互不覆盖。没有默认城市，首次必须自己选城。' },
    { title: '早报：时间与开关', keywords: ['早报', '时间', '开关'], body: `双方各自早报，上海时间每天 ${morningTime}。各自可回「关闭天气早报」「开启天气早报」，或「天气早报测试」即时查看（不占定时次数）。时间由 WEATHER_MORNING_TIME 配置；宿主需接定时器与发送通道，控制台不自动推送。首次未选城只提示一次；选好从次日开始，不补当天正文。` },
    { title: '数据来源与说明', keywords: ['来源', '数据来源', '说明'], body: '默认使用 OpenStreetMap 解析地点及 Open-Meteo 天气；宿主可注入高德 provider，失败时按坐标用 Open-Meteo 兜底。查不到就明确说查不到；缺失字段标注暂无数据，不编造昼夜预报或风向风力。' },
  ] });
  const result = (ok, reply, extra = {}) => ({ ok, reply: manual.footer('天气说明', reply), ...extra });
  const cityPrompt = () => result(true, '先选一个天气城市吧。直接回城市名或「设置天气城市：城市名」都可以。', { needsCity: true });
  function selectInput(side, text, { isCommand = false } = {}) {
    if (!['owner', 'friend'].includes(side)) return null;
    const command = parseWeatherCommand(text);
    const reserved = isCommand;
    const reply = manual.select(side, text, { isCommand: Boolean(command && command.type !== 'help') || reserved && !/^(?:\d+|继续)$/u.test(String(text).trim()) });
    if (reply) return { type: 'manual', reply };
    if (command) return command;
    if (!reserved && /^[\p{Script=Han}a-zA-Z][\p{Script=Han}a-zA-Z .-]{0,59}$/u.test(String(text).trim())) {
      try {
        if (store.pending(side)) return { type: 'city_reply', city: String(text).trim() };
      } catch { log('weather pending city state unavailable'); }
    }
    return null;
  }
  async function resolve(name) {
    const candidates = await provider.searchPlace(name);
    return candidates.find(place => cityMatches(place, name)
      && (place.adcode || (Number.isFinite(place.latitude) && Number.isFinite(place.longitude))));
  }
  async function query(side, days, { test = false, morning = false } = {}) {
    const cityName = store.city(side);
    if (!cityName) {
      if (morning && !test && store.morningPrompted(side)) return { ok: false, skip: true };
      store.waitForCity(side, { kind: morning && !test ? 'morning' : 'query', days });
      return cityPrompt();
    }
    let place;
    try { place = await resolve(cityName); } catch { log('weather city resolution unavailable'); }
    if (!place) return result(false, `天气暂时查不到，无法解析天气城市「${cityName}」，请用「设置天气城市：城市名」换个城市名再试。`);
    const today = shanghaiClock(now()).date;
    const forecasts = await Promise.all(days.map(async offset => {
      const date = dayDate(today, offset);
      try {
        const forecast = await provider.weather(place, date);
        const ok = forecast?.date === date && Boolean(present(forecast.dayWeather) || present(forecast.nightWeather));
        return { ok, text: formatWeather(cityName, date, forecast, ['今日', morning ? '明日预告' : '明日', '后天'][offset]) };
      } catch { return { ok: false, text: `${cityName}｜${date}\n天气暂时查不到。` }; }
    }));
    return result(forecasts.every(item => item.ok), [
      ...(morning ? [test ? '天气早报（测试，不影响定时早报）' : '天气早报'] : []),
      ...forecasts.map(item => item.text),
      `来源：${provider.attribution || provider.providerName || '现有天气服务'}`,
    ].join('\n\n'));
  }
  async function handle(side, command) {
    if (!['owner', 'friend'].includes(side)) return result(false, '天气功能仅 owner 和 friend 角色可用。');
    if (command?.type === 'manual') return result(true, command.reply);
    if (command?.type === 'help') return result(true, manual.select(side, '天气说明'));
    manual.exit(side);
    if (command?.type === 'set' || command?.type === 'city_reply') {
      if (typeof command.city !== 'string' || !command.city.trim() || command.city.length > 60 || /[\r\n]/u.test(command.city)) return result(false, HELP);
      let place;
      try { place = await resolve(command.city.trim()); } catch { /* Do not overwrite settings. */ }
      if (!place) return result(false, '查不到这个天气城市，请换个城市名再试；原设置未修改。');
      const pending = store.pending(side);
      const today = shanghaiClock(now()).date;
      const resumeTomorrow = !store.city(side) && store.morningPrompted(side);
      store.setCity(side, command.city.trim(), pending?.kind === 'morning' || resumeTomorrow ? { resumeDate: dayDate(today, 1) } : {});
      const confirmation = `已设置${side === 'owner' ? '小林' : '小周'}的天气城市：${command.city.trim()}。`;
      if (pending?.kind === 'query') {
        const forecast = await query(side, pending.days);
        return { ...forecast, reply: `${confirmation}\n\n${forecast.reply}` };
      }
      return result(true, confirmation + (pending?.kind === 'morning' ? '早报从次日开始，今天不补发天气正文。' : ''));
    }
    if (command?.type === 'morning') {
      store.setMorning(side, command.enabled);
      return result(true, `已${command.enabled ? '开启' : '关闭'}自己的天气早报（真实推送需宿主接线）。`);
    }
    if (command?.type === 'test') return query(side, [0, 1], { morning: true, test: true });
    if (command?.type === 'query') return query(side, command.days);
    return result(true, HELP);
  }
  return { handle, selectInput, exitManual: manual.exit, briefing: side => query(side, [0, 1], { morning: true }) };
}
module.exports = { HELP, UNAVAILABLE, parseWeatherCommand, shanghaiClock, dayDate, formatWeather, createWeatherCommands };
