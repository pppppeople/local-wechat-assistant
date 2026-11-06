'use strict';

const TIME_ZONE = 'Asia/Shanghai';
const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function chineseNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (text.includes('十')) {
    const [left, right] = text.split('十');
    return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0);
  }
  return [...text].reduce((total, item) => total * 10 + (digits[item] ?? 0), 0);
}

function shanghaiParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday);
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), weekday,
  };
}

function localTimestamp(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

function daysInMonth(year, month) {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2) return leapYear ? 29 : 28;
  return [31, 30, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;
}

function validateCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error('日期不合法');
  }
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function parseClock(expression) {
  const value = String(expression || '').trim().replace(/：/g, ':').replace(/\s+/g, '');
  let match = value.match(/^(.*?)(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    if (hour > 23 || minute > 59) throw new Error('时间不合法');
    return { prefix: match[1].trim(), hour, minute };
  }
  match = value.match(/^(.*?)([零〇一二两三四五六七八九十\d]{1,3})点(?:(半)|([零〇一二两三四五六七八九十\d]{1,3})分?)?$/);
  if (!match) throw new Error('请写明时间，例如“今晚八点”或“明天 18:30”');
  const hour = chineseNumber(match[2]);
  const minute = match[3] ? 30 : (match[4] ? chineseNumber(match[4]) : 0);
  if (hour > 23 || minute > 59) throw new Error('时间不合法');
  return { prefix: match[1].trim(), hour, minute };
}

function describeTimestamp(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIME_ZONE,
    month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp));
}

function relayModeLabel(mode, peer) {
  if (mode === 'self_reminder') return '提醒自己';
  if (mode === 'shared_reminder') return `双人提醒（你和${peer}）`;
  if (mode === 'peer_reminder') return `提醒${peer}`;
  if (mode === 'reminder') return `提醒你转告${peer}`;
  return `自动转告${peer}`;
}

function relayModeAction(mode, peer) {
  if (mode === 'self_reminder') return '提醒你自己';
  if (mode === 'shared_reminder') return `同时提醒你和${peer}`;
  if (mode === 'peer_reminder') return `直接提醒${peer}`;
  if (mode === 'reminder') return `提醒你转告${peer}`;
  return `自动转告${peer}`;
}

function parseTimeExpression(expression, now = Date.now()) {
  const clock = parseClock(expression);
  const current = shanghaiParts(now);
  let prefix = clock.prefix.replace(/\s+/g, '');
  let hour = clock.hour;
  let period = '';
  let date = { year: current.year, month: current.month, day: current.day };
  let recurrence = null;
  let explicitToday = false;
  const periodMatch = prefix.match(/^(.*?)(凌晨|早上|上午|中午|下午|傍晚|晚上)$/);
  if (periodMatch) {
    prefix = periodMatch[1];
    period = periodMatch[2];
    if (period === '凌晨' && hour === 12) hour = 0;
    if (period === '中午' && hour < 11) hour += 12;
    if (['下午', '傍晚', '晚上'].includes(period) && hour < 12) hour += 12;
  }

  if (prefix === '每天') {
    recurrence = { type: 'daily', hour, minute: clock.minute };
  } else {
    const weekly = prefix.match(/^每周([一二三四五六日天])$/);
    if (weekly) recurrence = { type: 'weekly', weekday: WEEKDAYS[weekly[1]], hour, minute: clock.minute };
  }

  if (recurrence) {
    const sendAt = nextOccurrence(recurrence, now - 1000);
    return { sendAt, recurrence, description: describeTimestamp(sendAt) };
  }

  if (prefix === '今晚') {
    explicitToday = true;
    if (period === '凌晨' || (!period && hour === 12)) {
      date = addLocalDays(current, 1);
      if (!period && hour === 12) hour = 0;
    } else if (hour < 12) hour += 12;
  } else if (prefix === '今天' || prefix === '今早') {
    explicitToday = true;
  } else if (prefix === '明天' || prefix === '明早' || prefix === '明晚') {
    const afterMidnight = prefix === '明晚' && (period === '凌晨' || (!period && hour === 12));
    date = addLocalDays(current, afterMidnight ? 2 : 1);
    if (prefix === '明晚' && !afterMidnight && hour < 12) hour += 12;
    if (afterMidnight && !period && hour === 12) hour = 0;
  } else if (prefix === '后天' || prefix === '后早' || prefix === '后晚') {
    const afterMidnight = prefix === '后晚' && (period === '凌晨' || (!period && hour === 12));
    date = addLocalDays(current, afterMidnight ? 3 : 2);
    if (prefix === '后晚' && !afterMidnight && hour < 12) hour += 12;
    if (afterMidnight && !period && hour === 12) hour = 0;
  } else if (/^周[一二三四五六日天]$/.test(prefix)) {
    const target = WEEKDAYS[prefix.slice(1)];
    let delta = (target - current.weekday + 7) % 7;
    if (delta === 0 && localTimestamp(date.year, date.month, date.day, hour, clock.minute) <= now) delta = 7;
    date = addLocalDays(current, delta);
  } else {
    const iso = prefix.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const monthDay = prefix.match(/^(\d{1,2})月(\d{1,2})日?$/);
    if (iso) {
      date = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
      validateCalendarDate(date.year, date.month, date.day);
    } else if (monthDay) {
      date = { year: current.year, month: Number(monthDay[1]), day: Number(monthDay[2]) };
      validateCalendarDate(date.year, date.month, date.day);
      if (localTimestamp(date.year, date.month, date.day, hour, clock.minute) <= now) date.year += 1;
      validateCalendarDate(date.year, date.month, date.day);
    } else if (prefix) {
      throw new Error('暂不认识这个日期，请使用今天、明天、周五、每天、每周五或具体日期');
    }
  }

  let sendAt = localTimestamp(date.year, date.month, date.day, hour, clock.minute);
  if (!prefix && sendAt <= now) {
    date = addLocalDays(current, 1);
    sendAt = localTimestamp(date.year, date.month, date.day, hour, clock.minute);
  }
  if (sendAt <= now + 30_000) {
    if (explicitToday || prefix) throw new Error('这个时间已经过去了，请换一个未来时间');
    throw new Error('请设置至少一分钟后的时间');
  }
  return { sendAt, recurrence: null, description: describeTimestamp(sendAt) };
}

function parseLeadingScheduleAndBody(value, now) {
  const text = String(value || '').trim();
  let best = null;
  for (let offset = 1; offset < text.length; offset += 1) {
    const expression = text.slice(0, offset).trim();
    const body = text.slice(offset).replace(/^[\s：:,，]+/u, '').trim();
    if (!expression || !body) continue;
    try {
      best = { schedule: parseTimeExpression(expression, now), body };
    } catch {}
  }
  if (best) return best;
  throw new Error('请写明提醒时间和内容，例如“提醒我和好友今晚八点出门”');
}

function nextOccurrence(recurrence, after = Date.now()) {
  const current = shanghaiParts(after + 1000);
  for (let delta = 0; delta <= 8; delta += 1) {
    const date = addLocalDays(current, delta);
    const weekday = (current.weekday + delta) % 7;
    if (recurrence.type === 'weekly' && weekday !== recurrence.weekday) continue;
    const candidate = localTimestamp(date.year, date.month, date.day, recurrence.hour, recurrence.minute);
    if (candidate > after + 1000) return candidate;
  }
  throw new Error('无法计算下一次发送时间');
}

function peerPattern(peerNames) {
  const escaped = (peerNames || []).filter(Boolean).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escaped.length ? `(?:${escaped.join('|')})` : '(?:对方)';
}

function relaySpeechAct(text, explicit = '') {
  // The sending instruction decides the act; the body may contain quoted/rhetorical questions.
  return explicit === 'question' ? 'question' : 'statement';
}

function extractConfirmationRequirement(text) {
  let value = String(text || '').trim();
  let confirmationFollowUpAfterMs = 0;
  const followUp = value.match(/(?:[，,；;。.]?\s*)(?:(?:如果|要是)\s*)?(?:(?:他|她|对方)\s*)?(?:(半|一|两|二|\d{1,2})\s*(分钟|小时|天)\s*(?:内|后)?)?\s*没(?:有)?确认(?:的话)?\s*(?:就)?再(?:提醒|催)(?:他|她|对方)?(?:一次|一下)?(?:[。.!！~～])?$/u);
  if (followUp) {
    const amountText = followUp[1] || '半';
    const unit = followUp[2] || '小时';
    const amount = amountText === '半' ? 0.5 : ({ 一: 1, 两: 2, 二: 2 }[amountText] || Number(amountText));
    const unitMs = unit === '分钟' ? 60_000 : (unit === '天' ? 24 * 60 * 60_000 : 60 * 60_000);
    confirmationFollowUpAfterMs = Math.max(5 * 60_000, Math.min(24 * 60 * 60_000, amount * unitMs));
    value = value.slice(0, followUp.index).trim();
  }
  const marker = /(?:[，,；;。.]?\s*)(?:(?:并且|而且|另外|还有)\s*)?(?:(?:要|让|请)\s*(?:他|她|对方)\s*)?(?:(?:回复|回一句|回个)?\s*[“"']?收到[”"']?\s*(?:来)?确认(?:一下)?|(?:回复|回一句|回个)\s*[“"']?收到[”"']?|确认(?:一下|收到)?|需要确认)(?:[。.!！~～])?$/u;
  const match = value.match(marker);
  if (!match || !value.slice(0, match.index).trim()) return { text: value, requiresConfirmation: false };
  return {
    text: value.slice(0, match.index).trim(),
    requiresConfirmation: true,
    ...(confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs } : {}),
  };
}

function parseExplicitRelay(value, peers) {
  const courtesy = '(?:(?:(?:请|麻烦|劳烦|拜托)(?:你)?(?:帮我)?|(?:你)?帮我|替我)\\s*)?';
  const separator = '\\s*(?:[：:,，]\\s*)?';
  const patterns = [
    { pattern: new RegExp(`^${courtesy}(?:问|询问)(?:一下)?\\s*(?:给)?\\s*${peers}${separator}([\\s\\S]+)$`, 'i'), speechAct: 'question' },
    { pattern: new RegExp(`^${courtesy}(?:转告|转达|告诉|告知|通知|提醒|回复|传话)(?:一下)?\\s*(?:给)?\\s*${peers}${separator}([\\s\\S]+)$`, 'i') },
    { pattern: new RegExp(`^${courtesy}(?:(?:跟|和|对)\\s*${peers}|给\\s*${peers})\\s*(?:说|讲)(?:一下|一声)?${separator}([\\s\\S]+)$`, 'i') },
    { pattern: new RegExp(`^${courtesy}(?:(?:带|捎)(?:个|句)?话\\s*(?:给)?\\s*${peers}|给\\s*${peers}\\s*(?:带|捎)(?:个|句)?话)${separator}([\\s\\S]+)$`, 'i') },
    { pattern: new RegExp(`^${courtesy}让\\s*${peers}\\s*知道${separator}([\\s\\S]+)$`, 'i') },
  ];
  for (const entry of patterns) {
    const match = value.match(entry.pattern);
    if (!match) continue;
    const confirmation = extractConfirmationRequirement(match[1]);
    const body = confirmation.text;
    if (!body || !body.replace(/[\s\p{P}]/gu, '')) throw new Error('转告内容不能为空');
    if (/^(?:会怎么样|是什么意思|是怎么回事|要怎么说|应该怎么说|怎么说(?:比较好)?|如何说(?:比较好)?|好吗|可以吗|行吗)[呢吗嘛]?[?？]$/.test(body)) {
      return null;
    }
    return {
      type: 'create', mode: 'relay', speechAct: relaySpeechAct(body, entry.speechAct), text: body, ...(/^(?:(?:请|麻烦|帮我|请帮我)\s*)?回复/u.test(value) ? { replyToPrevious: true } : {}),
      schedule: null, ...(confirmation.requiresConfirmation ? { requiresConfirmation: true } : {}),
      ...(confirmation.confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs: confirmation.confirmationFollowUpAfterMs } : {}),
    };
  }
  return null;
}

function parseRelayCommand(text, options = {}) {
  const value = String(text || '').trim();
  const formatted = value.match(/^(?:请)?(?:用|按|以)(邮件|电子邮件|信件|书信|明信片|公告|新闻播报)(?:的)?(?:格式|形式|风格)[，,：:\s]*([\s\S]+)$/u);
  if (formatted) {
    const command = parseRelayCommand(formatted[2].replace(/^发给/u, '告诉'), options);
    if (!command || command.type !== 'create' || command.mode !== 'relay') throw new Error('请明确转告对象和正文；格式只用于微信转告');
    const formats = { 邮件: 'email', 电子邮件: 'email', 信件: 'letter', 书信: 'letter', 明信片: 'postcard', 公告: 'bulletin', 新闻播报: 'news' };
    return { ...command, format: formats[formatted[1]] };
  }
  const peers = peerPattern(options.peerNames || []);
  const reminderTarget = `(?:${peers}|对方)`;
  if (!value) return null;
  if (/^(?:转告|传话|留言)(?:帮助|说明)$/.test(value)) return { type: 'help' };
  if (/^(?:查看|显示|看看|列出)(?:我的|当前的)?(?:定时)?(?:转告|提醒|任务)(?:列表)?[？?。]?$/.test(value)
    || /^(?:我)?(?:有|还有)哪些(?:定时)?(?:转告|提醒|任务)[？?。]?$/.test(value)) return { type: 'list' };
  if (/^(?:开启|恢复)转告$/.test(value)) return { type: 'enable' };
  if (/^(?:关闭|暂停)转告$/.test(value)) return { type: 'disable' };
  if (/^(?:删除|清除)(?:我的)?转告记录$/.test(value)) return { type: 'delete' };
  if (/^提醒(?:收到|已收到|确认收到)[。！!~～]?$/.test(value)
    || (options.acceptBareReminderResponse === true && /^(?:收到|已收到|确认收到)[。！!~～]?$/.test(value))) return { type: 'confirm' };
  if (/^提醒(?:完成|已完成|做完了|搞定了)[。！!~～]?$/.test(value)
    || (options.acceptBareReminderResponse === true && /^(?:完成|已完成|做完了|搞定了)[。！!~～]?$/.test(value))) return { type: 'complete' };
  let statusMatch = value.match(/^(?:查看|查询)?(?:刚才那个|最近(?:那个|一条)?|我的)?提醒(?:的)?(?:确认|完成|处理)?状态(?:\s*[#＃]?([A-Za-z0-9-]+))?[？?。]?$/u)
    || value.match(/^提醒\s*[#＃]?([A-Za-z0-9-]+)\s*(?:确认|完成|处理)?(?:了吗|没有|状态)[？?]?$/u)
    || value.match(/^(?:他|她|对方)(?:已经)?(?:确认|完成)(?:刚才那个)?提醒了吗[？?]?$/u);
  if (statusMatch) return { type: 'tracking_status', id: String(statusMatch[1] || '').toUpperCase() };
  let match = value.match(/^(?:取消|撤销|删除|删掉)(?:这(?:个|条))?(?:定时)?(?:转告|提醒|任务)?\s*[#＃]?([A-Za-z0-9-]+)[。！!~～]?$/);
  if (!match) match = value.match(/^(?:把|将)?(?:这(?:个|条))?(?:定时)?(?:转告|提醒|任务)?\s*[#＃]?([A-Za-z0-9-]+)\s*(?:取消掉|取消|撤销|删除|删掉)[。！!~～]?$/);
  if (match) return { type: 'cancel', id: match[1].toUpperCase() };
  match = value.match(/^(?:修改|改期)(?:定时)?(?:转告|提醒|任务)\s*[#＃]?([A-Za-z0-9-]+)\s*[：:]?\s*(?:改到|改成|到)?\s*(.+)$/);
  if (!match) match = value.match(/^(?:把|将)(?:这(?:个|条))?(?:定时)?(?:转告|提醒|任务)?\s*[#＃]?([A-Za-z0-9-]+)\s*(?:改到|改成|改为)\s*(.+)$/);
  if (match) {
    const timeExpression = match[2].trim().replace(/^改到\s*/, '');
    return { type: 'reschedule', id: match[1].toUpperCase(), schedule: parseTimeExpression(timeExpression, options.now) };
  }
  match = value.match(new RegExp(`^(?:双人\\s*)?提醒(?:一下)?\\s*(?:我\\s*(?:和|跟|与)\\s*${peers}|${peers}\\s*(?:和|跟|与)\\s*我)\\s*[：:,，]?\\s*([\\s\\S]+)$`, 'i'));
  if (match) {
    const parsed = parseLeadingScheduleAndBody(match[1], options.now);
    const confirmation = extractConfirmationRequirement(parsed.body);
    return {
      type: 'create', mode: 'shared_reminder', speechAct: 'statement', text: confirmation.text,
      schedule: parsed.schedule, ...(confirmation.requiresConfirmation ? { requiresConfirmation: true } : {}),
      ...(confirmation.confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs: confirmation.confirmationFollowUpAfterMs } : {}),
    };
  }
  match = value.match(new RegExp(`^(.+?)\\s*提醒(?:一下)?\\s*(?:我\\s*(?:和|跟|与)\\s*${peers}|${peers}\\s*(?:和|跟|与)\\s*我)\\s*[：:,，]?\\s*([\\s\\S]+)$`, 'i'));
  if (match) {
    const confirmation = extractConfirmationRequirement(match[2]);
    const body = confirmation.text;
    if (!body) throw new Error('提醒内容不能为空');
    return {
      type: 'create', mode: 'shared_reminder', speechAct: 'statement', text: body,
      schedule: parseTimeExpression(match[1], options.now), ...(confirmation.requiresConfirmation ? { requiresConfirmation: true } : {}),
      ...(confirmation.confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs: confirmation.confirmationFollowUpAfterMs } : {}),
    };
  }
  const peerReminderSuffix = new RegExp(`\\s*[，,；;。.]?\\s*(?:到点|届时)(?:就)?(?:直接)?提醒(?:一下)?\\s*${reminderTarget}(?:本人)?[。.!！~～]?$`, 'i');
  const scheduledPeerReminder = (schedule, rawBody) => {
    const confirmation = extractConfirmationRequirement(rawBody);
    const body = confirmation.text.replace(peerReminderSuffix, '').trim();
    if (!body) throw new Error('提醒内容不能为空');
    return {
      type: 'create', mode: 'peer_reminder', speechAct: 'statement', text: body, schedule,
      ...(confirmation.requiresConfirmation ? { requiresConfirmation: true } : {}),
      ...(confirmation.confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs: confirmation.confirmationFollowUpAfterMs } : {}),
    };
  };
  match = value.match(new RegExp(`^(.+?)\\s*(?:(?:请|麻烦)(?:你)?\\s*)?(?:帮我\\s*)?(?:到点\\s*)?(?:直接\\s*)?提醒(?:一下)?\\s*${reminderTarget}(?:本人)?\\s*[：:,，]?\\s*([\\s\\S]+)$`, 'i'));
  if (match && /(?:今|明|后|周|星期|每天|每周|\\d|[零〇一二两三四五六七八九十]点|:|：)/u.test(match[1])) {
    return scheduledPeerReminder(parseTimeExpression(match[1], options.now), match[2]);
  }
  match = value.match(new RegExp(`^(?:(?:请|麻烦)(?:你)?\\s*)?(?:帮我\\s*)?(?:到点\\s*)?(?:直接\\s*)?提醒(?:一下)?\\s*${reminderTarget}(?:本人)?\\s*[：:,，]?\\s*([\\s\\S]+)$`, 'i'));
  if (match) {
    try {
      const parsed = parseLeadingScheduleAndBody(match[1], options.now);
      return scheduledPeerReminder(parsed.schedule, parsed.body);
    } catch {}
  }
  match = value.match(new RegExp(`^(.+?)\\s*(定时转告|提醒我转告)\\s*(?:给)?${peers}\\s*[：:]\\s*([\\s\\S]+)$`, 'i'));
  if (match) {
    const confirmation = extractConfirmationRequirement(match[3]);
    const body = confirmation.text;
    if (!body) throw new Error('转告内容不能为空');
    return {
      type: 'create', mode: match[2] === '提醒我转告' ? 'reminder' : 'relay',
      speechAct: relaySpeechAct(body), text: body, schedule: parseTimeExpression(match[1], options.now),
      ...(confirmation.requiresConfirmation ? { requiresConfirmation: true } : {}),
      ...(confirmation.confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs: confirmation.confirmationFollowUpAfterMs } : {}),
    };
  }
  match = value.match(/^(.+?)\s*提醒(?:一下)?我\s*[：:,，]?\s*([\s\S]+)$/i);
  if (match) {
    const confirmation = extractConfirmationRequirement(match[2]);
    if (!confirmation.text) throw new Error('提醒内容不能为空');
    return {
      type: 'create', mode: 'self_reminder', speechAct: 'statement', text: confirmation.text,
      schedule: parseTimeExpression(match[1], options.now), ...(confirmation.requiresConfirmation ? { requiresConfirmation: true } : {}),
      ...(confirmation.confirmationFollowUpAfterMs ? { confirmationFollowUpAfterMs: confirmation.confirmationFollowUpAfterMs } : {}),
    };
  }
  const explicitRelay = parseExplicitRelay(value, peers);
  if (explicitRelay) return explicitRelay;
  match = value.match(new RegExp(`^(?:回他|回她|回复他|回复她|回复对方|回${peers})\\s*[：:]\\s*([\\s\\S]+)$`, 'i'));
  if (match) {
    const body = match[1].trim();
    return { type: 'create', mode: 'relay', speechAct: relaySpeechAct(body), text: body, schedule: null, replyToPrevious: true };
  }
  return null;
}

module.exports = {
  TIME_ZONE,
  describeTimestamp,
  nextOccurrence,
  parseRelayCommand,
  parseTimeExpression,
  relayModeAction,
  relayModeLabel,
  relaySpeechAct,
  shanghaiParts,
};
