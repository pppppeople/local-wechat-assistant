'use strict';

const { validatePurchase } = require('./belonging-purchase');
const { DEFAULT_SOURCE } = require('./price-note-commands');
const key = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[\s，,。.!！?？、：:；;（）()“”"'‘’_-]+/gu, '');

// Numbered, explicit syntax only: never claim the existing cooldown phrases.
function parseLinkCommand(value) {
  const match = value.match(/^第\s*([1-9]\d*)\s*个\s*(?:(确认新建|确认|取消))?联动\s*(保修|价格|两者都要|都不要)?(?:\s+(.*))?$/u);
  if (!match) return null;
  const kind = { 保修: 'warranty', 价格: 'price', 两者都要: 'both', 都不要: 'none' }[match[3]];
  return { type: 'link', number: Number(match[1]), action: { 确认新建: 'create', 确认: 'confirm', 取消: 'cancel' }[match[2]] || 'prepare',
    kind, fields: match[4] || '' };
}

function fieldsFor(kind, fields, base, now) {
  const patch = {};
  for (const token of fields.trim().split(/\s+/u).filter(Boolean)) {
    let match;
    if ((match = token.match(/^(\d+(?:\.\d{1,2})?)元$/u)) && patch.amount === undefined) patch.amount = Number(match[1]);
    else if (kind === 'warranty' && (match = token.match(/^(?:保修)?([1-9]\d*)(年|个月)$/u)) && patch.warrantyMonths === undefined)
      patch.warrantyMonths = Number(match[1]) * (match[2] === '年' ? 12 : 1);
    else if (kind === 'warranty' && /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日)$/u.test(token) && patch.purchaseDate === undefined) patch.purchaseDate = token;
    else throw new Error('格式无法解析：保修可填「2年 399元 2026-11-01」，价格可填「399元」。');
  }
  const draft = { ...base, ...patch };
  if (!Number.isFinite(draft.amount) || draft.amount < 0) throw new Error('金额无效。');
  if (kind === 'warranty') {
    if (!draft.warrantyMonths) throw new Error('请显式提供保修时长，例如「第 N 个联动保修 2 年」（也支持 6个月）；没有登记。');
    return validatePurchase(draft, now());
  }
  return { amount: draft.amount };
}

function handleLink({ state, command, save, now, sharedLife, priceNotes }) {
  const item = state.items.find(entry => entry.number === command.number && entry.status === 'bought');
  if (!item?.link) return '该编号没有可联动的已买冷静期条目。';
  const link = item.link, { kind, action } = command;
  const prefix = `第 ${item.number} 个`;
  if (!['warranty', 'price', 'both', 'none'].includes(kind)) return '请指定联动保修、价格、两者都要或都不要。';
  if (kind === 'both' || kind === 'none') {
    if (action !== 'prepare' || command.fields) return '一次确认或取消只处理一种，请分别指定联动保修或联动价格。';
    if (link.answered) return '联动选择已答复，不再追问；可分别使用带编号的联动保修或联动价格命令。';
    link.answered = true;
    if (kind === 'none') {
      for (const name of ['warranty', 'price']) if (link[name].status !== 'done') link[name] = { status: 'cancelled' };
      save(state); return '已选择都不要，两种均未写入；买了决定保留。';
    }
    save(state);
    return `已选择两者都要，尚未写入。分别使用「${prefix}联动保修 2年」预览保修（时长须自己填写），以及「${prefix}联动价格」预览价格；然后逐项显式确认，一次只写一种。`;
  }
  if (action === 'create' && kind !== 'warranty') return '确认新建仅用于生活箱保修物品；价格请使用确认联动价格。';
  const label = kind === 'warranty' ? '保修' : '价格';
  const slot = link[kind];
  if (slot.status === 'done') return `该冷静期条目已登记${label}，不会重复写入。`;
  if (slot.status === 'cancelled') return `该条目的${label}联动已取消，未写入；买了决定保留。`;
  link.answered = true;
  if (action === 'cancel') {
    link[kind] = { status: 'cancelled' }; save(state);
    return `已取消${label}联动，未写入；买了决定保留，另一种联动不受影响。`;
  }
  let draft;
  try {
    // Accept "2 年" as well as "2年"; no default warranty duration.
    const fields = command.fields.replace(/(\d)\s+(年|个月)/gu, '$1$2');
    draft = fieldsFor(kind, fields, slot.draft || { amount: item.amountCents / 100 }, now);
  } catch (error) { save(state); return error.message.replace('第 N 个', prefix); }
  if (action !== 'prepare' && !slot.draft) return `尚未预览，未写入。请先用「${prefix}联动${label}${kind === 'warranty' ? ' 2年' : ''}」预览。`;
  let missing = false;
  if (kind === 'warranty') {
    if (!sharedLife) throw new Error('生活箱不可用');
    if (item.item.length > 80 || !key(item.item)) return '原商品名不符合生活箱名称要求（非空且最多80字），未登记保修；请使用既有登记购买命令指定物品。';
    const own = sharedLife.readBelongings('owner'), needle = key(item.item);
    const exact = own.filter(entry => key(entry.name) === needle);
    const matches = exact.length ? exact : own.filter(entry => key(entry.name).includes(needle) || needle.includes(key(entry.name)));
    if (matches.length > 1) return '生活箱有多个候选物品，存在歧义，未登记保修。请先在生活箱核实物品。';
    missing = matches.length === 0;
    if (missing && (action !== 'create' || !slot.missingPrompted)) {
      slot.draft = draft; slot.missingPrompted = true; save(state);
      return `生活箱不存在「${item.item}」，尚未新建或登记。预填：${draft.amount}元，${draft.purchaseDate}，保修${draft.warrantyMonths}个月。同意新建物品并登记请回复「${prefix}确认新建联动保修」；可附金额、日期、时长修改，或回复「${prefix}取消联动保修」。`;
    }
  }
  if (action === 'prepare') {
    slot.draft = draft; save(state);
    return `联动${label}预览：${item.item}，${draft.amount}元${kind === 'warranty' ? `，${draft.purchaseDate}，保修${draft.warrantyMonths}个月` : `，来源：${DEFAULT_SOURCE}`}。尚未写入。请回复「${prefix}确认联动${label}」；可附${kind === 'warranty' ? '金额、日期、保修时长' : '金额'}修改，或回复「${prefix}取消联动${label}」。`;
  }
  const result = kind === 'warranty'
    ? sharedLife.registerCooldownPurchase('owner', item.id, { type: 'belonging_purchase_set', name: item.item, ...draft }, missing)
    : priceNotes.recordCooldownPrice('owner', item.id, { type: 'record', name: item.item, ...draft, source: DEFAULT_SOURCE });
  if (result.continue) { link[kind] = { status: 'done' }; save(state); }
  return result.reply;
}

module.exports = { parseLinkCommand, handleLink };
