'use strict';

const { parseTimeExpression, shanghaiParts } = require('./friend-relay-commands');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function localTimestamp(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

function localDay(now, offset = 0) {
  const parts = shanghaiParts(now);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dateOffset(value, now) {
  const parts = shanghaiParts(now);
  const explicit = value.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  if (explicit) {
    const stamp = Date.parse(`${explicit[1]}T12:00:00+08:00`);
    if (!Number.isFinite(stamp) || new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) !== explicit[1]) throw new Error('日期无效，请写清要查询哪一天');
    const today = Date.UTC(parts.year, parts.month - 1, parts.day);
    return Math.round((Date.parse(`${explicit[1]}T00:00:00Z`) - today) / DAY_MS);
  }
  if (/后天/u.test(value)) return 2;
  if (/明天|明晚|明早/u.test(value)) return 1;
  if (/今天|今晚|今早/u.test(value)) return 0;
  const weekday = value.match(/(?:这|本|下)?(?:周|星期)([一二三四五六日天])/u);
  if (weekday) {
    let offset = (WEEKDAYS[weekday[1]] - parts.weekday + 7) % 7;
    if (/下(?:周|星期)/u.test(weekday[0])) offset = 7 - ((parts.weekday + 6) % 7) + ((WEEKDAYS[weekday[1]] + 6) % 7);
    return offset;
  }
  return 0;
}

function dayPart(value) {
  if (/凌晨/u.test(value)) return [0, 6];
  if (/早上|上午|今早|明早/u.test(value)) return [8, 12];
  if (/中午/u.test(value)) return [11, 14];
  if (/下午/u.test(value)) return [13, 18];
  if (/傍晚/u.test(value)) return [17, 20];
  if (/晚上|今晚|明晚/u.test(value)) return [18, 23];
  return [9, 22];
}

function parseClockRange(value) {
  const match = String(value).match(/([零〇一二两三四五六七八九十\d]{1,3})点(?:(半)|([零〇一二两三四五六七八九十\d]{1,3})分?)?\s*(?:到|至|[-—~～])\s*([零〇一二两三四五六七八九十\d]{1,3})点(?:(半)|([零〇一二两三四五六七八九十\d]{1,3})分?)?/u);
  if (!match) return null;
  const number = (raw) => {
    if (/^\d+$/u.test(raw)) return Number(raw);
    const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (raw === '十') return 10;
    if (raw.includes('十')) {
      const [left, right] = raw.split('十');
      return (left ? map[left] : 1) * 10 + (right ? map[right] : 0);
    }
    return map[raw];
  };
  let startHour = number(match[1]);
  let endHour = number(match[4]);
  const rangeStartHour = startHour;
  if (/下午|傍晚|晚上/u.test(value)) {
    if (startHour < 12) startHour += 12;
    if (endHour < 12 && endHour >= rangeStartHour) endHour += 12;
  }
  return { startHour, startMinute: match[2] ? 30 : number(match[3] || '0'), endHour, endMinute: match[5] ? 30 : number(match[6] || '0') };
}

function parseWindow(value, now = Date.now()) {
  const text = String(value || '').trim();
  const weekend = /(?:这|本)?周末/u.test(text);
  const nextWeek = /下周(?![一二三四五六日天])/u.test(text);
  const nextWeekend = /下周末/u.test(text);
  if (weekend || nextWeek) {
    const parts = shanghaiParts(now);
    const saturday = nextWeek ? 7 - ((parts.weekday + 6) % 7) + 5 : (6 - parts.weekday + 7) % 7;
    const startDay = localDay(now, nextWeek && !nextWeekend ? saturday - 5 : saturday);
    const endDay = localDay(now, saturday + 1);
    return {
      startAt: localTimestamp(startDay.year, startDay.month, startDay.day, 0),
      endAt: localTimestamp(endDay.year, endDay.month, endDay.day, 23, 59),
      label: nextWeekend ? '下周末' : nextWeek ? '下周' : '本周末',
    };
  }
  const offset = dateOffset(text, now);
  const day = localDay(now, offset);
  const clock = parseClockRange(text);
  const hours = clock || (() => {
    const [startHour, endHour] = dayPart(text);
    return { startHour, startMinute: 0, endHour, endMinute: 0 };
  })();
  const startAt = localTimestamp(day.year, day.month, day.day, hours.startHour, hours.startMinute);
  let endAt = localTimestamp(day.year, day.month, day.day, hours.endHour, hours.endMinute);
  if (endAt <= startAt) endAt += DAY_MS;
  return { startAt, endAt, label: text.match(/(?:\d{4}-\d{2}-\d{2}|今天|明天|后天|(?:这|本|下)?(?:周|星期)[一二三四五六日天]|(?:这|本)?周末|下周)/u)?.[0] || '今天' };
}

function parsePairCoordinationCommand(text, options = {}) {
  const value = String(text || '').trim().replace(/[。！!~～]+$/gu, '');
  if (!value) return null;
  const now = options.now || Date.now();
  if (/^(?:双人)?(?:空闲|时间匹配|协调)(?:帮助|说明|怎么用)$/u.test(value)) return { type: 'help' };
  if (/^(?:看看|查看|列出)(?:我)?(?:报备的)?(?:空闲|有空时间|没空时间)(?:记录)?$/u.test(value)) return { type: 'availability_list' };
  if (/^(?:看看|查查|查看|帮我们(?:看看)?)(?:我们(?:俩)?|双方)?(?:这周|本周|下周|周末|这周末|本周末|下周末|今天|明天)?(?:共同|都)?(?:什么时候|哪些时间)?(?:有空|空闲|能见面|可以约)[？?]?$/u.test(value)
    || /^(?:我们(?:俩)?)(?:这周|本周|下周|周末|这周末|本周末|下周末|今天|明天)?(?:什么时候)(?:都有空|能见面|可以约)[？?]?$/u.test(value)) {
    return { type: 'availability_match', window: parseWindow(value, now) };
  }
  let match = value.match(/^(?:删除|删掉|取消|忘掉)(?:我)?(.+?)(?:报备的)?(?:空闲|有空|没空|不行)(?:记录|时间)?$/u);
  if (match) return { type: 'availability_remove', query: match[1].trim(), window: parseWindow(match[1], now) };
  if (/^(?:我)?(?:忙完了|空闲了|有空了|解除勿扰|取消勿扰|结束忙碌)$/u.test(value)) return { type: 'busy_clear' };
  if (/^(?:看看|查看|问问)?(?:好友|Owner|对方|他|她)(?:现在)?(?:忙不忙|有空吗|是不是在忙)[？?]?$/u.test(value)) return { type: 'busy_status', target: 'peer' };
  match = value.match(/^我(?:要)?(?:开会|工作|忙|上课|休息|勿扰|先别打扰我)(?:到|至)(.+)$/u);
  if (match) {
    const schedule = parseTimeExpression(match[1], now);
    return { type: 'busy_set', endAt: schedule.sendAt, description: schedule.description };
  }
  if (/^(?:我)?(?:今晚|现在|这会儿)?(?:先)?(?:别打扰我|勿扰|有点忙|在忙)$/u.test(value)) {
    return { type: 'busy_set', endAt: now + 4 * 60 * 60 * 1000, description: '约四小时后' };
  }
  match = value.match(/^我(.+?)(?:有空|可以|没安排|时间方便)$/u);
  if (match) return { type: 'availability_add', availability: 'available', window: parseWindow(match[1], now) };
  match = value.match(/^我(.+?)(?:没空|不行|有事|不方便)$/u);
  if (match) return { type: 'availability_add', availability: 'unavailable', window: parseWindow(match[1], now) };
  if (/^(?:准备出门|今晚出行|明天旅游|周末出去玩|帮我们看看(?:今天|今晚|明天|周末)怎么安排)$/u.test(value)) {
    const kind = /出行/u.test(value) ? 'date' : (/旅游|出去玩/u.test(value) ? 'trip' : 'outing');
    const dayOffset = /明天/u.test(value) ? 1 : 0;
    return { type: 'scene_build', kind, dayOffset, label: value, window: parseWindow(value, now) };
  }
  return null;
}

module.exports = { dateOffset, parsePairCoordinationCommand, parseWindow };
