'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { describeTimestamp } = require('./friend-relay-commands');
const DAY = 86400000; // Asia/Shanghai calendar days have no daylight-saving transition.
const calendarDay = time => Math.floor((time + 8 * 3600000) / DAY);

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.items)) throw new Error('冷静期存储格式无效');
  const numbers = new Set();
  for (const item of state.items) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || !Number.isSafeInteger(item.number) || item.number < 1 || numbers.has(item.number)
      || typeof item.item !== 'string' || !item.item.trim()
      || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0
      || !Number.isSafeInteger(item.days) || item.days < 1 || item.days > 36500
      || !Number.isSafeInteger(item.extensions) || item.extensions < 0
      || !['cooling', 'bought', 'abandoned'].includes(item.status)
      || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.dueAt))
      || Date.parse(item.dueAt) <= Date.parse(item.createdAt)
      || typeof item.asked !== 'boolean') throw new Error('冷静期记录格式无效');
    numbers.add(item.number);
  }
}

function createPurchaseCooldownStore({ stateFile, now = () => Date.now(), sharedLife, priceNotes }) {
  const load = (readOnly = false) => readRecordState(stateFile, { schemaVersion: 1, items: [] }, true,
    { strict: true, readOnly, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['items']); };
  const due = item => item.status === 'cooling' && Date.parse(item.dueAt) <= now();
  const money = item => (item.amountCents / 100).toFixed(2);
  function hasPending(side = 'owner') {
    if (side !== 'owner') return false;
    try { return load(true).items.some(due); } catch { return false; }
  }
  function handle(side, command) {
    if (side !== 'owner') return '购物冷静期仅主人可用。';
    if (!command || command.type === 'invalid') return '没有登记冷静期：请填写物品、明确的正数金额（元）及正整数天数，例如「想买键盘 399 元，先冷静 3 天」；省略天数默认 3 天。';
    const state = load();
    if (command.type === 'create') {
      const amountCents = Math.round(command.amount * 100);
      if (!command.item?.trim() || !Number.isSafeInteger(amountCents) || amountCents <= 0
        || !Number.isSafeInteger(command.days) || command.days <= 0 || command.days > 36500) return '没有登记冷静期：物品、金额或天数无效。';
      const clock = now();
      const item = { id: crypto.randomUUID(), number: Math.max(0, ...state.items.map(entry => entry.number)) + 1,
        item: command.item.trim(), amountCents, days: command.days, extensions: 0, status: 'cooling',
        createdAt: new Date(clock).toISOString(), dueAt: new Date(clock + command.days * DAY).toISOString(), asked: false };
      state.items.push(item); save(state);
      return `已登记冷静期：第 ${item.number} 个 ${item.item}，${money(item)} 元，${item.days} 天；到期：${describeTimestamp(item.dueAt)}（Asia/Shanghai）。`;
    }
    if (command.type === 'list') {
      const active = state.items.filter(item => item.status === 'cooling');
      return active.length ? `冷静期清单：\n${active.map(item => `第 ${item.number} 个 ${item.item}，${money(item)} 元，${due(item) ? '已到期待决定' : `还剩 ${Math.max(0, calendarDay(Date.parse(item.dueAt)) - calendarDay(now()))} 天`}`).join('\n')}` : '冷静期清单为空。';
    }
    if (command.type === 'stats') {
      const abandoned = state.items.filter(item => item.status === 'abandoned');
      return `冷静期战绩：放弃 ${abandoned.length} 次，放弃总金额 ${(abandoned.reduce((sum, item) => sum + item.amountCents, 0) / 100).toFixed(2)} 元；买了 ${state.items.filter(item => item.status === 'bought').length} 次。`;
    }
    if (command.type === 'link') return require('./purchase-cooldown-link').handleLink({ state, command, save, now, sharedLife, priceNotes });
    if (command.type !== 'decide') throw new Error('不支持的冷静期命令');
    const pending = state.items.filter(due);
    if (!pending.length) return '没有已到期待决定的冷静期条目。';
    if (command.number == null && pending.length > 1) return '有多个到期待决条目，请回复「第 N 个买了 / 第 N 个放弃 / 第 N 个再想想」，N 使用条目编号。';
    const item = command.number == null ? pending[0] : pending.find(entry => entry.number === command.number);
    if (!item) return '该编号没有已到期待决定的冷静期条目。';
    if (!['bought', 'abandoned', 'extend'].includes(command.decision)) throw new Error('无效冷静期决定');
    item.decidedAt = new Date(now()).toISOString();
    if (command.decision === 'extend') {
      item.extensions++;
      item.dueAt = new Date(now() + item.days * DAY).toISOString(); item.asked = false;
      save(state);
      return `第 ${item.number} 个 ${item.item}：再想想，已顺延 ${item.days} 天（第 ${item.extensions} 次），到期：${describeTimestamp(item.dueAt)}（Asia/Shanghai）。`;
    }
    item.status = command.decision;
    if (item.status === 'bought') item.link = { offered: true, answered: false, warranty: { status: 'pending' }, price: { status: 'pending' } };
    save(state);
    return command.decision === 'bought'
      ? `第 ${item.number} 个 ${item.item}：已记录买了。原商品名「${item.item}」与 ${money(item)} 元仅作预填，不会自动登记。是否顺手登记保修、记价格、两者都要或都不要？请回复「第 ${item.number} 个联动 保修 / 价格 / 两者都要 / 都不要」。保修与价格各自预览后分别显式确认，一次只写一种。`
      : `第 ${item.number} 个 ${item.item}：已记录放弃，${money(item)} 元计入冷静期战绩。`;
  }
  async function tick(deliver) {
    let delivered = false;
    // Reload after every await: a decision/extension during delivery must survive.
    for (;;) {
      const state = load();
      const item = state.items.find(entry => due(entry) && !entry.asked);
      if (!item) return delivered;
      item.asked = true; save(state);
      await deliver(`冷静期到期：第 ${item.number} 个 ${item.item}，${money(item)} 元。还想买吗？请回复「第 ${item.number} 个买了 / 第 ${item.number} 个放弃 / 第 ${item.number} 个再想想」。只有一条到期待决时也可直接回复「买了 / 放弃 / 再想想」。`,
        `purchase-cooldown-${item.id}-${item.extensions}`);
      delivered = true;
    }
  }
  return { handle, hasPending, tick };
}

module.exports = { createPurchaseCooldownStore };
