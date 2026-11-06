'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const SIDES = ['owner', 'friend'];
const HELP = '用「共同愿望：一起旅行 1000元」创建一个金额目标；「愿望贡献：12.50元」记自己一笔；「撤销愿望贡献：1」撤销自己的编号记录；「共同愿望进度」查看。人民币最多两位小数，金额须大于零。仅文本记账，不处理真实资金或支付。达到目标自动完成，完成后不能贡献或撤销。';
const validSide = side => { if (!SIDES.includes(side)) throw new Error('invalid savings side'); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const money = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}元`;
const total = goal => goal.contributions.filter(entry => entry.revokedAt === null).reduce((sum, entry) => sum + entry.amountCents, 0);

function validate(state) {
  const fail = () => { throw new Error('共同愿望存储格式无效'); };
  if (state?.schemaVersion !== 1 || !Array.isArray(state.goals)
    || state.goals.filter(goal => goal?.status === 'active').length > 1) fail();
  const ids = new Set();
  for (const goal of state.goals) {
    if (!goal || typeof goal.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(goal.id) || ids.has(goal.id)
      || typeof goal.binding !== 'string' || !goal.binding || !SIDES.includes(goal.createdBy)
      || typeof goal.name !== 'string' || !goal.name.trim() || goal.name.length > 120 || /[\r\n]/u.test(goal.name)
      || !positive(goal.targetCents) || !date(goal.createdAt) || !['active', 'completed'].includes(goal.status)
      || !Array.isArray(goal.contributions) || !(goal.completedAt === null || date(goal.completedAt))
      || (goal.status === 'active') !== (goal.completedAt === null)) fail();
    ids.add(goal.id);
    for (const [i, entry] of goal.contributions.entries()) {
      if (!entry || entry.number !== i + 1 || !SIDES.includes(entry.side) || !positive(entry.amountCents)
        || !date(entry.createdAt) || !(entry.revokedAt === null || date(entry.revokedAt))) fail();
    }
    const sum = total(goal);
    if (!Number.isSafeInteger(sum) || (goal.status === 'completed') !== (sum >= goal.targetCents)) fail();
  }
}

function createPairSavingsStore({ stateFile, getBinding, now = () => Date.now(), sideNames = { owner: '主人', friend: '好友' } }) {
  const empty = () => ({ schemaVersion: 1, goals: [] });
  const load = () => readRecordState(stateFile, empty(), true, { strict: true, now, validate });
  function save(state) { validate(state); writeRecordState(stateFile, state, ['goals']); }
  function progress(goal) {
    const sum = total(goal);
    const percent = BigInt(sum) * 100n / BigInt(goal.targetCents);
    const blocks = Number(percent / 10n > 10n ? 10n : percent / 10n);
    return [`共同愿望：${goal.name}（${goal.status === 'active' ? '进行中' : '已完成'}）`,
      `进度：[${'■'.repeat(blocks)}${'□'.repeat(10 - blocks)}] ${percent}%`,
      `目标：${money(goal.targetCents)}；已记录：${money(sum)}；剩余：${money(Math.max(0, goal.targetCents - sum))}。`,
      ...SIDES.map(side => `${sideNames[side]}贡献：${money(goal.contributions.filter(e => e.side === side && e.revokedAt === null).reduce((s, e) => s + e.amountCents, 0))}。`),
      ...goal.contributions.map(e => `#${e.number} ${sideNames[e.side]} ${money(e.amountCents)} ${e.createdAt}${e.revokedAt ? '（已撤销）' : ''}`),
      '仅文本记账，不代表真实收付款。'].join('\n');
  }
  function handle(side, command) {
    validSide(side);
    const binding = getBinding();
    if (typeof binding !== 'string' || !binding) throw new Error('配对尚未绑定');
    if (!command || !['create', 'contribute', 'undo', 'progress', 'help'].includes(command.type)) throw new Error('不支持的共同愿望命令');
    if (command.type === 'help') return HELP;
    const state = load();
    if (state.goals.some(goal => goal.binding !== binding)) throw new Error('共同愿望配对绑定已变化，请人工处理旧状态');
    const goal = state.goals.find(item => item.status === 'active');
    if (command.type === 'create') {
      if (typeof command.name !== 'string' || !command.name.trim() || command.name.trim().length > 120
        || /[\r\n]/u.test(command.name) || !positive(command.targetCents)) return HELP;
      if (goal) return `已有进行中的共同愿望「${goal.name}」，不会覆盖，请先达成目标。`;
      const created = { id: crypto.randomUUID(), binding, name: command.name.trim(), targetCents: command.targetCents,
        createdBy: side, createdAt: new Date(now()).toISOString(), status: 'active', completedAt: null, contributions: [] };
      state.goals.push(created); save(state);
      return '已创建共同愿望。\n' + progress(created);
    }
    if (command.type === 'progress') return state.goals.length
      ? [goal ? progress(goal) : '当前没有进行中的共同愿望。',
        ...state.goals.filter(item => item.status === 'completed').map(item => '历史记录：\n' + progress(item))].join('\n\n')
      : '还没有共同愿望。' + HELP;
    if (!goal) return '当前没有进行中的共同愿望，已完成目标不能继续贡献或撤销；可用「共同愿望进度」查看。';
    if (command.type === 'undo') {
      if (!positive(command.number)) return HELP;
      const entry = goal.contributions.find(item => item.number === command.number);
      if (!entry) return '当前目标没有这笔贡献，请查看「共同愿望进度」中的编号。';
      if (entry.side !== side) return '只能撤销自己的贡献，不能修改对方记录。';
      if (entry.revokedAt !== null) return '这笔贡献已撤销，不会重复扣减。';
      entry.revokedAt = new Date(now()).toISOString(); save(state);
      return `已撤销你自己的贡献 #${entry.number}。\n${progress(goal)}`;
    }
    if (!positive(command.amountCents)) return HELP;
    if (!Number.isSafeInteger(total(goal) + command.amountCents)) return '贡献合计超出整数分安全范围，未记录。';
    const entry = { number: goal.contributions.length + 1, side, amountCents: command.amountCents,
      createdAt: new Date(now()).toISOString(), revokedAt: null };
    goal.contributions.push(entry);
    if (total(goal) >= goal.targetCents) { goal.status = 'completed'; goal.completedAt = entry.createdAt; }
    save(state);
    return `已记录你自己的贡献 #${entry.number}。\n${goal.status === 'completed' ? '已达到目标，自动标记完成！\n' : ''}${progress(goal)}`;
  }
  function deleteSide(side) {
    validSide(side);
    const state = load(); save(empty());
    return { removed: state.goals.length };
  }
  return { handle, deleteSide };
}

module.exports = { createPairSavingsStore };
