'use strict';

const { describeTimestamp, parseTimeExpression, shanghaiParts } = require('./friend-relay-commands');
const { validatePurchase } = require('./belonging-purchase');
const { parseMaintenanceCommand } = require('./belonging-maintenance');
const { expiryTimestamp } = require('./belonging-expiry');
const { parseReturnDeadlineCommand } = require('./return-deadline');

const NUMBER_WORDS = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function clean(value, limit = 200) {
  return String(value || '').replace(/^\s+|\s+$/gu, '').replace(/[。！!~～]+$/gu, '').trim().slice(0, limit);
}

function cleanName(value) {
  return clean(value, 80)
    .replace(/^(?:请|麻烦)?(?:帮我)?(?:记一下|记住)[，,：:\s]*/u, '')
    .replace(/^(?:把|我把|我的|我们家的?|家里的)\s*/u, '')
    .replace(/\s*(?:这个|那个)?(?:东西|物品)$/u, '')
    .trim();
}

function validName(value) {
  const name = cleanName(value);
  if (!name || name.length > 80) return '';
  if (/^(?:我|你|他|她|对方|大家|东西|物品|库存|采购清单|购物清单|钱|时间|耐心|希望|心情|感觉|机会|办法|力气|精神|电|网)$/u.test(name)) return '';
  return name;
}

function numberValue(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  return NUMBER_WORDS[text] || 0;
}

function addMonthsClamped(now, months) {
  const parts = shanghaiParts(now);
  const targetMonthIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(targetMonthIndex / 12);
  const monthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDay);
  return Date.UTC(year, monthIndex, day, parts.hour - 8, parts.minute, new Date(now).getUTCSeconds(), 0);
}

function parseCapsuleTime(expression, now = Date.now()) {
  const value = clean(expression, 80).replace(/^在/u, '').replace(/\s+/gu, '');
  const annual = value.startsWith('每年');
  const timeValue = annual ? value.slice(2) : value;
  let sendAt = 0;
  let recurrence = null;
  let match = annual ? null : timeValue.match(/^([一二两三四五六七八九十\d]{1,3})(小时|天|周|个月|月|年)后$/u);
  if (annual) {
    const parsed = parseTimeExpression(timeValue, now);
    const parts = shanghaiParts(parsed.sendAt);
    sendAt = parsed.sendAt;
    recurrence = { type: 'annual', month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
  } else if (match) {
    const amount = numberValue(match[1]);
    if (!amount) throw new Error('时间胶囊的时间没有看懂');
    if (match[2] === '小时') sendAt = now + amount * 60 * 60 * 1000;
    else if (match[2] === '天') sendAt = now + amount * 24 * 60 * 60 * 1000;
    else if (match[2] === '周') sendAt = now + amount * 7 * 24 * 60 * 60 * 1000;
    else sendAt = addMonthsClamped(now, amount * (match[2] === '年' ? 12 : 1));
  } else if (timeValue === '明年今天') {
    sendAt = addMonthsClamped(now, 12);
  } else {
    sendAt = parseTimeExpression(timeValue, now).sendAt;
  }
  if (!Number.isFinite(sendAt) || sendAt <= now + 30_000) throw new Error('时间胶囊需要设置未来时间');
  if (sendAt > addMonthsClamped(now, 60)) throw new Error('时间胶囊目前最多保存五年');
  return { sendAt, description: describeTimestamp(sendAt), recurrence };
}

function parseSharedLifeCommand(text, options = {}) {
  const value = clean(text, 600);
  if (!value) return null;
  if (/^(?:共享)?生活(?:箱|助手)(?:帮助|说明|怎么用)$|^生活箱$/u.test(value)) return { type: 'help' };

  const maintenance = parseMaintenanceCommand(value, options.now);
  if (maintenance) {
    if (maintenance.name !== undefined) {
      maintenance.name = validName(maintenance.name);
      if (!maintenance.name) throw new Error('请说清楚物品名称');
    }
    return maintenance;
  }

  if (/^(?:保质期列表|哪些东西快过期了|列出已过期与临期物品)$/u.test(value)) return { type: 'belonging_expiry_list' };
  if (/^设置保质期(?:[：:]|\s|$)/u.test(value)) {
    const match = value.match(/^设置保质期(?:[：:]\s*|\s+)(.+?)\s+(\S+)$/u);
    if (!match) throw new Error('请按“设置保质期 <物品名> YYYY-MM-DD”填写');
    const name = validName(match[1]);
    if (!name) throw new Error('请说清楚物品名称');
    expiryTimestamp(match[2]);
    return { type: 'belonging_expiry_set', name, expiresAt: match[2] };
  }
  if (/^(?:保质期查询|查询保质期|清除保质期)(?:[：:]|\s|$)/u.test(value)) {
    const match = value.match(/^(保质期查询|查询保质期|清除保质期)(?:[：:]\s*|\s+)(.+)$/u);
    const name = match && validName(match[2]);
    if (!name) throw new Error('请说清楚要查询或清除保质期的物品名称');
    return { type: match[1] === '清除保质期' ? 'belonging_expiry_clear' : 'belonging_expiry_query', name };
  }

  if (value === '哪些东西快过保了') return { type: 'belonging_warranty_list' };
  if (/^登记购买(?:\s|$)/u.test(value)) {
    const purchase = value.match(/^登记购买\s+(.+?)\s+(\d+(?:\.\d+)?)元\s+保修(\d+)(年|个月)(?:\s+(\S+))?$/u);
    if (!purchase) throw new Error('请按“登记购买 <物品名> <正数金额>元 保修<正整数>年或个月 [购买日期]”填写');
    const name = validName(purchase[1]);
    if (!name) throw new Error('请说清楚物品名称');
    return { type: 'belonging_purchase_set', name, ...validatePurchase({
      amount: Number(purchase[2]), warrantyMonths: Number(purchase[3]) * (purchase[4] === '年' ? 12 : 1), purchaseDate: purchase[5],
    }, options.now) };
  }
  if (/^保修查询(?:\s|$)/u.test(value)) {
    const name = validName(value.slice(4));
    if (!name) throw new Error('请说清楚要查询保修的物品名称');
    return { type: 'belonging_warranty_query', name };
  }

  // Explicit warranty/expiry commands above keep priority. Reserve return syntax
  // before broad natural verbs such as 放/收 can consume item names like 放大镜.
  const returnDeadline = parseReturnDeadlineCommand(text);
  if (returnDeadline) return returnDeadline;

  if (/^(?:查看|看看|列出)(?:我们(?:俩)?的|我的)?时间胶囊(?:列表)?$/u.test(value)) return { type: 'capsule_list' };
  let match = value.match(/^取消时间胶囊\s*[#＃]?([A-Za-z0-9-]+)$/u);
  if (match) return { type: 'capsule_cancel', id: match[1].toUpperCase() };
  match = value.match(/^(?:时间胶囊[：:]\s*)?(.+?)(?:把|将)这句话(?:在)?(?:发|送)(?:给)?(?:我们(?:两个人|俩)|我和(?:好友|Owner)|(?:好友|Owner)和我)\s*[：:,，]\s*([\s\S]+)$/u);
  if (match) {
    const body = clean(match[2], 500);
    if (!body) throw new Error('时间胶囊正文不能为空');
    return { type: 'capsule_create', text: body, schedule: parseCapsuleTime(match[1], options.now) };
  }

  if (/^(?:查看|看看|列出)?(?:我们(?:俩)?的|双人(?:的)?|我们的|我们)?(?:还有|有)?(?:哪些|什么)?(?:约定|承诺|说好要做的事)(?:列表)?[？?]?$/u.test(value)) {
    return { type: 'commitment_list' };
  }
  match = value.match(/^(?:把)?(.+?)(?:这个|那个)?(?:约定|承诺)(?:标记为?)?(?:完成|已完成|做完|搞定)(?:了)?$/u);
  if (match) return { type: 'commitment_complete', query: cleanName(match[1]) };
  match = value.match(/^(?:删除|删掉|移除|取消)(?:我们(?:的)?)?(.+?)(?:这个|那个)?(?:约定|承诺)$/u)
    || value.match(/^把(.+?)(?:这个|那个)?(?:约定|承诺)(?:删除|删掉|移除|取消)$/u);
  if (match) return { type: 'commitment_delete', query: cleanName(match[1]) };
  match = value.match(/^(?:请|麻烦)?(?:帮我)?(?:记一下|记住)(?:我们(?:的)?)?(?:约定|承诺|说好要做的事)?[，,：:\s]*([\s\S]+)$/u);
  if (match && /(?:答应|约好|说好|约定|承诺|下次|周末|以后)/u.test(match[1])) {
    return { type: 'commitment_add', text: clean(match[1], 240) };
  }
  if (/^(?:我答应(?:好友|Owner|他|她|对方).{2,}|(?:好友|Owner|他|她|对方)答应我.{2,}|我们(?:俩)?(?:约好|说好|约定|答应).{2,})/u.test(value)) {
    return { type: 'commitment_add', text: clean(value, 240) };
  }

  if (/^(?:查看|看看|列出)?(?:家里|我们家|共享)?(?:的)?(?:库存|存货|日用品)(?:列表)?$/u.test(value)) return { type: 'inventory_list', needsOnly: false };
  if (/^(?:家里|我们家)?(?:缺什么|要买什么|有什么要买的)[？?]?$|^(?:查看|看看)?(?:采购|购物)清单$/u.test(value)) {
    return { type: 'inventory_list', needsOnly: true };
  }
  match = value.match(/^把?(.+?)从(?:家里)?(?:库存|采购清单|购物清单)(?:里)?(?:删除|删掉|移除)$/u)
    || value.match(/^(?:从)?(?:家里)?(?:库存|采购清单|购物清单)(?:里)?(?:删除|删掉|移除)\s*(.+)$/u);
  if (match) return { type: 'inventory_delete', name: validName(match[1]) };
  match = value.match(/^(?:采购清单|购物清单)(?:里)?(?:加上|加入|添加)\s*(.+)$/u)
    || value.match(/^把?(.+?)(?:加入|放进)(?:采购清单|购物清单)$/u);
  if (match) return { type: 'inventory_set', name: validName(match[1]), state: 'needed', quantity: '' };
  match = value.match(/^(.{1,80}?)(?:没了|用完了|没有了|缺了|该买了)$/u);
  if (match && validName(match[1])) return { type: 'inventory_set', name: validName(match[1]), state: 'needed', quantity: '' };
  match = value.match(/^(.{1,80}?)(?:只剩|剩下?|还剩)(.{1,50})$/u);
  if (match && validName(match[1])) return { type: 'inventory_set', name: validName(match[1]), state: 'low', quantity: clean(match[2], 50) };
  match = value.match(/^(.{1,80}?)(?:还有|有)([零一二两三四五六七八九十百\d半]+\s*(?:瓶|包|盒|个|袋|卷|支|桶|罐|斤|公斤|升|毫升|片|板|套))$/u);
  if (match && validName(match[1])) return { type: 'inventory_set', name: validName(match[1]), state: 'stocked', quantity: clean(match[2], 50) };
  match = value.match(/^(.{1,80}?)(?:买好了|补好了|补上了|买到了|到货了)$/u);
  if (match && validName(match[1])) return { type: 'inventory_set', name: validName(match[1]), state: 'stocked', quantity: '' };

  if (/^(?:查看|看看|列出)?(?:我)?(?:记住|记录)(?:了)?(?:哪些|什么)?(?:东西|物品)(?:的)?位置$|^查看物品位置$/u.test(value)) {
    return { type: 'belonging_list' };
  }
  match = value.match(/^(?:删除|删掉|忘掉|别记|不记)(?:我(?:的)?)?(.+?)(?:的)?位置(?:了)?$/u)
    || value.match(/^把(?:我(?:的)?)?(.+?)(?:的)?位置(?:记录)?(?:删除|删掉)$/u);
  if (match) return { type: 'belonging_delete', name: validName(match[1]) };
  match = value.match(/^(?:我(?:的)?|我把)(.+?)(?:现在)?(?:放哪(?:里|儿)?了|放在(?:了)?哪(?:里|儿)?)[？?]?$/u)
    || value.match(/^(.+?)(?:现在)?放哪(?:里|儿)?了[？?]?$/u);
  if (match) return { type: 'belonging_query', name: validName(match[1]) };
  match = value.match(/^(?:请|麻烦)?(?:帮我)?(?:记一下|记住)?[，,：:\s]*(?:我把|把|我的)?(.{1,80}?)(?:放在|收在|搁在|塞在|放进|放(?!进|到|入)|收|搁|塞)(.{1,160})$/u);
  if (match && validName(match[1])) {
    const location = clean(match[2], 160);
    if (/^(?:我们的|双人的)?(?:想去箱|双人想去箱|礼物箱|惊喜箱|收藏箱|票券仓|票券箱|收件箱)$/u.test(location)) return null;
    return { type: 'belonging_set', name: validName(match[1]), location };
  }
  match = value.match(/^(?:我把|把|我的)?(.{1,80}?)(?:借给|交给)(?:好友|Owner|他|她|对方)(?:用)?了$/u);
  if (match && validName(match[1])) return { type: 'belonging_set', name: validName(match[1]), location: '借给对方' };
  return null;
}

module.exports = { parseCapsuleTime, parseSharedLifeCommand, validName };
