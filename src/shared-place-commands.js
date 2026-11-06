'use strict';
const { dateOffset } = require('./pair-coordination-commands');

function cleanPlaceName(value) {
  return String(value || '')
    .replace(/[。！!？?]+$/g, '')
    .replace(/^(?:一下|一个)\s*/u, '')
    .trim()
    .slice(0, 120);
}

function shanghaiDate(now, offsetDays = 0) {
  const shifted = new Date(Number(now) + (8 * 60 * 60 * 1000) + (offsetDays * 24 * 60 * 60 * 1000));
  return shifted.toISOString().slice(0, 10);
}

function targetDate(text, now = Date.now()) {
  const value = String(text || '');
  const explicit = value.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  if (explicit) {
    const stamp = Date.parse(`${explicit[1]}T12:00:00+08:00`);
    if (!Number.isFinite(stamp) || shanghaiDate(stamp) !== explicit[1]) throw new Error('日期无效，请写清要查询哪一天');
    return { date: explicit[1], label: explicit[1] };
  }
  if (/后天/u.test(value)) return { date: shanghaiDate(now, 2), label: '后天' };
  if (/明天|明日/u.test(value)) return { date: shanghaiDate(now, 1), label: '明天' };
  const weekdayMatch = value.match(/(?:这|本|下)?(?:周|星期)([一二三四五六日天])/u);
  if (weekdayMatch) {
    const offset = dateOffset(weekdayMatch[0], now);
    return { date: shanghaiDate(now, offset), label: weekdayMatch[0] };
  }
  if (/周末/u.test(value)) {
    const localToday = new Date(Number(now) + 8 * 60 * 60 * 1000).getUTCDay();
    const offset = /下周末/u.test(value) ? 7 - ((localToday + 6) % 7) + 5 : (6 - localToday + 7) % 7;
    return { date: shanghaiDate(now, offset), label: /下周末/u.test(value) ? '下周末' : '周末' };
  }
  return { date: shanghaiDate(now, 0), label: '今天' };
}

function splitNote(value) {
  const match = String(value || '').match(/^(.+?)(?:[，,；;]\s*备注[：:]?|\s+备注[：:]?)\s*(.+)$/u);
  if (!match) return { name: cleanPlaceName(value), note: '' };
  return { name: cleanPlaceName(match[1]), note: String(match[2] || '').trim().slice(0, 200) };
}

function numberedReference(value) {
  const token = String(value || '').trim();
  if (/^\d{1,2}$/u.test(token)) {
    const index = Number(token);
    return index >= 1 && index <= 30 ? index : 0;
  }
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (token === '十') return 10;
  if (/^十[一二三四五六七八九]$/u.test(token)) return 10 + digits[token[1]];
  if (/^[一二]十$/u.test(token)) return digits[token[0]] * 10;
  if (/^[一二]十[一二三四五六七八九]$/u.test(token)) return digits[token[0]] * 10 + digits[token[2]];
  return digits[token] || 0;
}

function parseSharedPlaceCommand(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const now = options.now ?? Date.now();

  if (/^(?:(?:查看|看看|看下|列出|一次查看)(?:全部|所有)?)?(?:我们的|双人的)?(?:想去箱|双人想去箱)?(?:里|里的)?(?:全部|所有)?(?:已)?去过(?:的|哪些)(?:地方|地点)[。！!？?]?$/u.test(raw)) return { type: 'list', status: 'visited' };
  if (/^(?:想去箱|双人想去箱)(?:帮助|怎么玩|怎么用)$/u.test(raw)) return { type: 'help' };
  if (/^(?:想去箱|双人想去箱)(?:状态)$/u.test(raw)) return { type: 'status' };
  if (/^(?:查看|看看|打开|列出)?(?:我们的|双人的)?(?:想去箱|双人想去箱)(?:(?:里)?(?:现在|目前)?(?:有|是)?什么(?:内容|地方|地点)?|里有什么|清单)?[？?。]?$/u.test(raw)) return { type: 'list' };
  if (/^(?:想去箱)?(?:选|选择)(?:第)?\s*([1-3一二三])(?:个)?[。！!]?$/u.test(raw)) {
    const index = { 一: 1, 二: 2, 三: 3 }[RegExp.$1] || Number(RegExp.$1);
    return { type: 'select', index };
  }

  const removalText = raw.replace(/^(?:(?:我想|我要|请|麻烦)(?:帮我)?|帮我)\s*/u, '');
  const numberedRemoval = removalText.match(/^(?:把)?(?:想去箱|清单|列表)?(?:里|里的)?(?:删除|删掉|删了|删一下|移除|划掉|拿掉)?\s*(?:第)?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})(?:个|条|项)?(?:地点|地方)?\s*(?:删除|删掉|删了|删一下|移除|划掉|拿掉|不要了|不去了)?(?:吧)?[。！!]?$/u);
  if (numberedRemoval && /(?:删除|删|移除|划掉|拿掉|不要了|不去了)/u.test(removalText)) {
    const index = numberedReference(numberedRemoval[1]);
    if (index) return { type: 'remove', index };
  }

  if (/(?:没|没有|未|还没|不曾)去过|去过(?:了)?(?:吗|么|没有|没)[？?]?$/u.test(raw)) return null;

  const batchVisited = raw.match(/^(?:把)?(?:想去箱|双人想去箱|清单|列表)?(?:里|里的)?\s*((?:第?\s*(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})(?:个|号|条|项)?(?:地点|地方)?)(?:(?:\s+|[、，,]|和|及|还有)+第?\s*(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})(?:个|号|条|项)?(?:地点|地方)?)+)\s*(?:都|全|全部)?(?:标记(?:为|成)?|标成|设为)?(?:已经|已)?去过(?:了)?[。！!]?$/u);
  if (batchVisited) {
    const indices = batchVisited[1].match(/[0-9]{1,2}|[一二三四五六七八九十]{1,3}/gu).map(numberedReference);
    if (indices.some((index) => !index)) return null;
    return { type: 'visited', indices: [...new Set(indices)] };
  }

  const numberedVisited = raw.match(/^(?:把)?(?:想去箱|双人想去箱|清单|列表)?(?:里|里的)?\s*(?:第)?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})(?:个|号|条|项)?(?:地点|地方)?(?:[^。！!?？]{0,60})?(?:标记(?:为|成)?|标成|设为)?(?:已经|已)?去过(?:了)?[。！!]?$/u)
    || raw.match(/^(?:把)?(?:标记|标一下|标注)\s*(?:第)?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})(?:个|号|条|项)?(?:地点|地方)?(?:为|成)?(?:已经|已)?去过(?:了)?[。！!]?$/u);
  if (numberedVisited) {
    const index = numberedReference(numberedVisited[1]);
    return index ? { type: 'visited', index } : null;
  }

  let match = removalText.match(/^(?:从)?(?:我们的|双人的)?(?:想去箱|双人想去箱)(?:里)?(?:删除|删掉|删一下|移除)[：:\s]*(.+)$/u);
  if (match) return { type: 'remove', name: cleanPlaceName(match[1]) };
  match = removalText.match(/^把(.+?)(?:从)?(?:我们的|双人的)?(?:想去箱|双人想去箱)(?:里)?(?:删除|删掉|删一下|移除)[。！!]?$/u);
  if (match) return { type: 'remove', name: cleanPlaceName(match[1]) };
  match = removalText.match(/^把(.+?)(?:从)?(?:我们的)?(?:出行|出行|游玩)?(?:清单|计划)(?:里)?(?:删除|删掉|删一下|移除|划掉|拿掉)[。！!]?$/u)
    || removalText.match(/^(.+?)(?:先)?(?:不想去|不去)了?[，,]?(?:从清单里?)?(?:删掉|划掉|拿掉)(?:吧)?[。！!]?$/u);
  if (match) return { type: 'remove', name: cleanPlaceName(match[1]) };

  match = raw.match(/^把(.+?)(?:标记为|标成)(?:已经|已)?去过(?:了)?[。！!]?$/u)
    || raw.match(/^(.+?)我们(?:已经)?去过了[。！!]?$/u);
  if (match) return { type: 'visited', name: cleanPlaceName(match[1]) };
  match = raw.match(/^把(.+?)(?:恢复为|标记为|标成)(?:还)?想去[。！!]?$/u);
  if (match) return { type: 'restore', name: cleanPlaceName(match[1]) };

  match = raw.match(/^(?:想去箱|双人想去箱)(?:加入|添加|加一个|加进|放进)[：:\s]*(.+)$/u)
    || raw.match(/^把(.+?)(?:放进|加入|加进|记进)(?:我们的|双人的)?(?:想去箱|双人想去箱)[。！!]?$/u)
    || raw.match(/^我们想去(.+?)(?:[，,]\s*)?记一下[。！!]?$/u)
    || raw.match(/^把(.+?)(?:加到|放到|记到)(?:我们的)?(?:出行|出行|游玩)?(?:清单|计划)(?:里)?[。！!]?$/u)
    || raw.match(/^(?:下次|改天|有空)(?:我们)?(?:想)?去(.+?)[，,]?(?:帮我)?(?:记一下|记下来|收藏一下)[。！!]?$/u)
    || raw.match(/^(.+?)[，,]?(?:帮我)?(?:记一下|记下来|收藏一下)[，,]?(?:下次|改天|有空)(?:我们)?去[。！!]?$/u);
  if (match) {
    const parsed = splitNote(match[1]);
    if (!parsed.name) return null;
    return { type: 'add', ...parsed };
  }

  const recommendation = /^(?:今天|明天|后天|周末|(?:这|本|下)?(?:周|星期)[一二三四五六日天])(?:我们)?(?:去哪里|去哪|去哪儿)|(?:看看|看下|帮我看看)?(?:想去箱|箱子)(?:里)?(?:今天|明天|后天|周末|(?:这|本|下)?(?:周|星期)[一二三四五六日天])?.*(?:适合|推荐|去哪)|^以(.+?)为主[，,]?.*(?:附近|顺路|一起|联动|搭)/u.test(raw);
  if (recommendation) {
    const focus = raw.match(/^以(.+?)为主/u)?.[1] || '';
    const energy = /不想太累|少走|省力|轻松|低能量/u.test(raw) ? 'low' : (/不怕下雨|雨天|室内/u.test(raw) ? 'weatherproof' : 'balanced');
    return { type: 'recommend', ...targetDate(raw, now), focus: cleanPlaceName(focus), energy, query: raw.slice(0, 300) };
  }
  return null;
}

module.exports = { parseSharedPlaceCommand, shanghaiDate, targetDate };
