'use strict';

const { todayShanghai } = require('./belonging-purchase');
const { changed, refused, unchanged } = require('./feature-result');

const REFUSAL = '购物退货期限仅主人可用，好友不能读取或操作。';
const PREFIX = 'belonging_return_deadline_';

function returnDeadlineTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('退货期限只接受合法的 YYYY-MM-DD 上海日期');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('退货期限日期无效，请填写真实存在的 YYYY-MM-DD 日期');
  return time;
}

function validateReturnDeadlines(state) {
  for (const item of Array.isArray(state?.belongings) ? state.belongings : []) {
    if (Object.hasOwn(item, 'returnDeadline')) returnDeadlineTimestamp(item.returnDeadline);
  }
}

// Parse only explicit prefixes; malformed commands still belong to this feature.
// No storage/date lookup here, so even invalid friend commands can be refused first.
function parseReturnDeadlineCommand(text) {
  const value = String(text || '').trim();
  if (value === '退货期限查询') return { type: `${PREFIX}list` };
  if (/^设置退货期限(?:\s|$)/u.test(value)) {
    const match = value.match(/^设置退货期限\s+(.+?)\s+(\S+)$/u);
    return match ? { type: `${PREFIX}set`, name: match[1].trim(), returnDeadline: match[2] }
      : { type: `${PREFIX}invalid`, error: '请按“设置退货期限 <物品名或BL编号> <YYYY-MM-DD>”填写' };
  }
  const match = value.match(/^(清除退货期限|退货期限)(?:\s+(.+))?$/u);
  if (!match) return null;
  return match[2]?.trim() ? { type: `${PREFIX}${match[1] === '退货期限' ? 'query' : 'clear'}`, name: match[2].trim() }
    : { type: `${PREFIX}invalid`, error: '请说清楚物品名称或 BL 编号' };
}

// Adapter over the existing life-box state, with no independent store or scheduler.
function createReturnDeadlineHandler({ load, save, findMatches, clean, now }) {
  function describe(item, clock) {
    const days = (returnDeadlineTimestamp(item.returnDeadline) - returnDeadlineTimestamp(todayShanghai(clock))) / 86400000;
    return `#${item.id}「${item.name}」｜退货期限 ${item.returnDeadline}｜${days < 0 ? `已过期 ${-days} 天` : `剩余 ${days} 天`}`;
  }
  return function handle(side, command) {
    if (side !== 'owner') return refused(REFUSAL);
    const action = command.type.slice(PREFIX.length);
    if (!['set', 'query', 'clear', 'list'].includes(action)) return refused(command.error || '不支持这个退货期限操作');
    if (action === 'set') returnDeadlineTimestamp(command.returnDeadline);
    const name = action === 'list' ? '' : clean(command.name, 81);
    if (action !== 'list' && (!name || name.length > 80)) throw new Error('请填写 1 至 80 字的物品名称或 BL 编号');
    const id = name.replace(/^#/, '').toUpperCase();
    const byId = name.startsWith('#') || /^[a-z]{2}[-_]/iu.test(name) || /^BL$/iu.test(name);
    if (byId && !/^BL-[A-Z0-9]+$/u.test(id)) return refused('物品编号无效，请使用 BL- 前缀的完整物品编号。');
    const state = load({ strict: true });
    const own = state.belongings.filter(item => item.ownerSide === 'owner');
    if (action === 'list') {
      const clock = now();
      const rows = own.filter(item => Object.hasOwn(item, 'returnDeadline'))
        .sort((a, b) => a.returnDeadline.localeCompare(b.returnDeadline));
      return rows.length ? ['退货期限查询：', ...rows.map(item => describe(item, clock))].join('\n') : '暂无已设置退货期限的物品。';
    }
    const matches = byId ? own.filter(item => item.id === id) : findMatches(own, name, ['name']);
    if (!matches.length) return refused(`未找到「${name}」的物品记录，请先登记物品位置或购买信息。`);
    if (matches.length > 1) return refused(`有 ${matches.length} 条相近记录，无法确定要处理哪条，请指定候选名称或编号：${matches.map(item => `${item.name}（#${item.id}）`).join('、')}。`);
    const item = matches[0];
    if (action === 'query') return Object.hasOwn(item, 'returnDeadline') ? describe(item, now()) : `「${item.name}」未设置退货期限。`;
    if (action === 'clear') {
      if (!Object.hasOwn(item, 'returnDeadline')) return unchanged(`「${item.name}」未设置退货期限，无需清除。`);
      delete item.returnDeadline;
    } else item.returnDeadline = command.returnDeadline;
    item.updatedAt = new Date(now()).toISOString();
    save(state);
    return changed(action === 'clear' ? `已清除「${item.name}」的退货期限。` : `已设置「${item.name}」的退货期限：${item.returnDeadline}。`);
  };
}

module.exports = { REFUSAL, parseReturnDeadlineCommand, returnDeadlineTimestamp, validateReturnDeadlines, createReturnDeadlineHandler };
