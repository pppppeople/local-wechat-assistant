'use strict';

const { todayShanghai } = require('./belonging-purchase');
const { changed, refused, unchanged } = require('./feature-result');

function maintenanceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('维护日期只接受合法 YYYY-MM-DD');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('维护日期无效');
  return time;
}
function maintenanceCycle(cycleDays, lastMaintainedAt, now = Date.now()) {
  if (!Number.isSafeInteger(cycleDays) || cycleDays <= 0) throw new Error('维护周期天数必须为正整数');
  if (lastMaintainedAt === undefined) lastMaintainedAt = todayShanghai(now);
  const time = maintenanceDate(lastMaintainedAt) + cycleDays * 86400000;
  if (!Number.isFinite(time) || time > maintenanceDate('9999-12-31')) throw new Error('下次维护日期超出支持范围');
  return { cycleDays, lastMaintainedAt, nextDueAt: new Date(time).toISOString().slice(0, 10) };
}
function maintenanceStatus(nextDueAt, now) {
  const days = (maintenanceDate(todayShanghai(now)) - maintenanceDate(nextDueAt)) / 86400000;
  return days < 0 ? '未到期' : days === 0 ? '到期当天' : `已超期 ${days} 天`;
}

function parseMaintenanceCommand(value, now = Date.now()) {
  if (value === '维护列表') return { type: 'belonging_maintenance_list' };
  if (/^设置维护周期(?:[：:]|\s|$)/u.test(value)) {
    const match = value.match(/^设置维护周期(?:[：:]\s*|\s+)(.+?)\s+(\S+)天(?:\s+(\S+))?$/u);
    if (!match || !/^\d+$/u.test(match[2])) throw new Error('请按“设置维护周期 <物品名> <正整数>天 [YYYY-MM-DD]”填写');
    const cycleDays = Number(match[2]);
    maintenanceCycle(cycleDays, match[3], now);
    return { type: 'belonging_maintenance_set', name: match[1], cycleDays, ...(match[3] === undefined ? {} : { lastMaintainedAt: match[3] }) };
  }
  const verbs = { 维护查询: 'query', 清除维护周期: 'clear', 完成维护: 'complete', 暂停维护提醒: 'pause', 恢复维护提醒: 'resume' };
  for (const [verb, action] of Object.entries(verbs)) {
    if (value === verb || value.startsWith(`${verb} `) || value.startsWith(`${verb}：`) || value.startsWith(`${verb}:`)) {
      const name = value.slice(verb.length).replace(/^[：:\s]+/u, '').trim();
      if (!name) throw new Error('请说清楚物品名称');
      return { type: `belonging_maintenance_${action}`, name };
    }
  }
  return null;
}

// Uses only the life-box loader/writer: no independent state or broker API.
function createBelongingMaintenance({ load, save, findMatches, clean, now }) {
  const describe = item => `「${item.name}」｜周期 ${item.maintenance.cycleDays} 天｜上次维护 ${item.maintenance.lastMaintainedAt}｜下次维护 ${item.maintenance.nextDueAt}｜${maintenanceStatus(item.maintenance.nextDueAt, now())}${item.maintenance.paused ? '｜提醒已暂停' : ''}`;
  function handle(side, command) {
    if (side !== 'owner') return refused('家庭物品维护提醒仅主人可用。');
    const state = load({ strict: true });
    const own = state.belongings.filter(item => item.ownerSide === 'owner');
    if (command.type === 'belonging_maintenance_list') {
      const rows = own.filter(item => item.maintenance).sort((a, b) => a.maintenance.nextDueAt.localeCompare(b.maintenance.nextDueAt));
      return rows.length ? ['维护列表：', ...rows.map(describe)].join('\n') : '暂无已设置维护周期的物品。';
    }
    const name = clean(command.name, 80);
    if (!name) throw new Error('请说清楚物品名称');
    const cycle = command.type === 'belonging_maintenance_set'
      ? maintenanceCycle(command.cycleDays, command.lastMaintainedAt, now()) : null;
    const matches = findMatches(own, name, ['name']);
    if (!matches.length) return refused(`未找到「${name}」的物品记录，请先登记物品位置或购买信息。`);
    if (matches.length > 1) return refused(`有 ${matches.length} 条相近记录，无法确定要处理哪条，请指定候选名称：${matches.map(item => item.name).join('、')}。`);
    const item = matches[0];
    if (cycle) item.maintenance = { ...cycle, remindedDueAt: null, paused: item.maintenance?.paused === true };
    else if (!item.maintenance) return unchanged(`「${item.name}」未设置维护周期${command.type.endsWith('_clear') ? '，无需清除' : ''}。`);
    else if (command.type.endsWith('_query')) return describe(item);
    else if (command.type.endsWith('_clear')) delete item.maintenance;
    else if (command.type.endsWith('_complete')) item.maintenance = {
      ...item.maintenance, ...maintenanceCycle(item.maintenance.cycleDays, undefined, now()), remindedDueAt: null,
    };
    else if (command.type.endsWith('_pause')) item.maintenance.paused = true;
    else if (command.type.endsWith('_resume')) item.maintenance.paused = false;
    else throw new Error('不支持这个维护操作');
    item.updatedAt = new Date(now()).toISOString();
    save(state);
    const verb = { set: '已设置维护周期', clear: '已清除维护周期', complete: '已完成维护', pause: '已暂停维护提醒', resume: '已恢复维护提醒' }[command.type.split('_').at(-1)];
    return changed(`${verb}：${item.maintenance ? describe(item) : `「${item.name}」`}。`);
  }
  async function tick(deliver) {
    let delivered = false;
    // Same at-most-once attempt convention as belongingLoans: persist before send.
    // Reload between sends so a command during await is never overwritten.
    for (;;) {
      const state = load({ strict: true });
      const item = state.belongings.find(item => item.ownerSide === 'owner' && item.maintenance
        && !item.maintenance.paused && item.maintenance.nextDueAt <= todayShanghai(now())
        && item.maintenance.remindedDueAt !== item.maintenance.nextDueAt);
      if (!item) return delivered;
      const maintenance = item.maintenance;
      maintenance.remindedDueAt = maintenance.nextDueAt;
      save(state);
      await deliver(`物品维护提醒：${item.name}｜下次维护日 ${maintenance.nextDueAt}｜周期 ${maintenance.cycleDays} 天。`,
        `belonging-maintenance-${item.id}-${maintenance.nextDueAt}`);
      delivered = true;
    }
  }
  return { handle, tick };
}

module.exports = { maintenanceDate, maintenanceCycle, maintenanceStatus, parseMaintenanceCommand, createBelongingMaintenance };
