'use strict';

const { inventoryNameKey } = require('./shared-life-store');
const { unchanged, refused } = require('./feature-result');
const REFUSAL = '物品盘点仅主人可用，好友不能读取或操作库存。';

function parseStocktakeCommand(text) {
  const value = String(text || '').trim();
  const start = value.match(/^(?:物品盘点|开始盘点)(?:(?:[：:]\s*|\s+)(.+))?$/u);
  if (start) return { type: 'start', names: start[1] ? start[1].split(/[、，,\n]/u).map(name => name.trim()).filter(Boolean) : [] };
  if (value === '取消盘点') return { type: 'cancel' };
  if (value === '确认盘点') return { type: 'confirm', indices: null };
  const confirm = value.match(/^确认盘点(?:[：:]\s*|\s+)(.+)$/u);
  if (confirm) {
    const indices = confirm[1].split(/[、，,]/u).map(item => item.trim());
    if (indices.every(item => /^[1-9]\d*$/u.test(item))) return { type: 'confirm', indices: [...new Set(indices.map(Number))] };
    return { type: 'invalid' };
  }
  return null;
}

function createStocktake({ inventory }) {
  let batch = null;
  function summary(confirmed, unconfirmed) {
    return `已确认：${confirmed.join('、') || '无'}\n未确认：${unconfirmed.join('、') || '无'}`;
  }
  async function execute(side, command) {
    if (side !== 'owner') return refused(REFUSAL);
    if (command.type === 'invalid') return refused('请回复「确认盘点」或「确认盘点 1、3」，也可「取消盘点」。');
    if (command.type === 'cancel') {
      if (!batch || batch.status !== 'pending') return unchanged('没有待确认的盘点，未写入库存。');
      batch.status = 'cancelled';
      return unchanged(`已取消盘点，未写入库存。\n${summary([], batch.items.map(item => item.name))}`);
    }
    if (command.type === 'start') {
      batch = null;
      const rows = inventory.readInventory('owner');
      const items = [];
      for (const name of command.names.length ? command.names : rows.map(row => row.name)) {
        const matches = rows.filter(row => inventoryNameKey(row.name) === inventoryNameKey(name));
        if (matches.length > 1) return refused(`同名库存有歧义，未写入，请指明具体物品；当前按名称写入接口不能区分这些记录：\n${matches.map(row => `${row.name}（${row.id}）`).join('\n')}`);
        if (!matches.length) return refused(`既有库存中没有「${name}」，未新建或写入。`);
        if (!items.some(item => item.id === matches[0].id)) items.push(matches[0]);
      }
      if (!items.length) return unchanged('既有库存列表为空，没有可盘点的物品。');
      batch = { status: 'pending', items };
      return unchanged(['物品盘点预览（尚未写入）：', ...items.map((item, index) =>
        `${index + 1}. ${item.name}｜状态：${item.update.state}｜数量：${item.update.quantity}`),
      '请逐项核对；回复「确认盘点」确认全部，或「确认盘点 1、3」仅确认所选项；「取消盘点」放弃。其余项保持未确认。需修正时先取消，用既有库存命令更新后重新盘点。'].join('\n'));
    }
    if (command.type !== 'confirm') return refused('不支持的盘点命令。');
    if (!batch) return refused('没有待确认的盘点，请先说「物品盘点」。');
    if (batch.status !== 'pending') return unchanged(batch.status === 'cancelled' ? '盘点已取消，未写入库存。' : '该盘点批次已完成或已处理，请勿重复确认；未再次写入库存。');
    const selected = command.indices || batch.items.map((_, index) => index + 1);
    if (!selected.length || selected.some(index => !Number.isInteger(index) || index < 1 || index > batch.items.length)) return refused('盘点序号无效，未写入，请按预览序号确认。');
    const currentBatch = batch;
    currentBatch.status = 'processing'; // Consume before any write/await; never replay partial failures.
    const confirmed = [], unconfirmed = [], reasons = [];
    for (const [index, item] of currentBatch.items.entries()) {
      if (!selected.includes(index + 1)) { unconfirmed.push(item.name); continue; }
      try {
        const matches = inventory.readInventory('owner').filter(row => inventoryNameKey(row.name) === inventoryNameKey(item.name));
        const current = matches[0];
        if (matches.length !== 1 || current.id !== item.id || current.name !== item.name
          || JSON.stringify(current.update) !== JSON.stringify(item.update)) {
          unconfirmed.push(item.name); reasons.push(`${item.name}：库存已变化或存在歧义，请重新盘点`); continue;
        }
        const result = await inventory.execute('owner', { type: 'inventory_set', name: item.name, state: item.update.state, quantity: item.update.quantity });
        if (!result || result.wrote !== true) { unconfirmed.push(item.name); reasons.push(`${item.name}：未确认写入成功`); continue; }
        confirmed.push(item.name);
      } catch {
        unconfirmed.push(item.name); reasons.push(`${item.name}：操作失败，写入结果未确认，不自动重试`);
      }
    }
    currentBatch.status = 'done';
    return { reply: ['盘点批次已处理。', summary(confirmed, unconfirmed), ...reasons].join('\n'), wrote: confirmed.length > 0, continue: unconfirmed.length === 0 };
  }
  return { execute };
}

module.exports = { parseStocktakeCommand, createStocktake, REFUSAL };
