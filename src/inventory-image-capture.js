'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { validateItems } = require('./inventory-image-provider');
const TTL = 30 * 60 * 1000;
const HINT = '回复「都加入」或「加入第1、3项」或「算了」。';
const line = text => text.trim().replace(/[\r\n]+/gu, ' ');

function parseInventoryImageCommand(text, imagePaths = [], side = 'owner') {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (imagePaths.length && /(?:加入(?:家里的?|家庭)?库存|登记到(?:家里的?|家庭)?库存)/u.test(value)
    && !/(?:不要|不用|不想|取消).*(?:加入|登记)|(?:^|[，。；\s])别(?:再)?(?:加入|登记)/u.test(value)) {
    return { type: 'extract', text: value, imagePaths };
  }
  if (value === '都加入') return { type: 'confirm_all' };
  if (value === '算了') return { type: 'discard' };
  const match = value.match(/^加入第(\d+(?:[、,，]\d+)*)项$/u);
  return match ? { type: 'confirm_selected', numbers: [...new Set(match[1].split(/[、,，]/u).map(Number))] } : null;
}

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.pending) || state.pending.length > 1
    || state.pending.some(record => !record || typeof record.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(record.id)
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)))) {
    throw new Error('库存图片待确认存储格式无效');
  }
  for (const record of state.pending) validateItems(record.items);
}

function createInventoryImageCapture({ stateFile, provider, inventory, now = () => Date.now() }) {
  let queue = Promise.resolve();
  const empty = () => ({ schemaVersion: 1, pending: [] });
  function save(state) {
    validateState(state);
    writeRecordState(stateFile, state, ['pending']);
  }
  function hasPending() {
    try {
      const pending = readRecordState(stateFile, empty(), false,
        { strict: true, readOnly: true, now, validate: validateState }).pending[0];
      return Boolean(pending?.items.length && now() - Date.parse(pending.createdAt) < TTL);
    } catch { return false; }
  }
  async function apply(side, command) {
    // Non-owner calls are unclaimed and silent, without touching the model or files.
    if (side !== 'owner') return null;
    if (!command || !['extract', 'confirm_all', 'confirm_selected', 'discard'].includes(command.type)) {
      return refused('不支持这个库存图片操作。');
    }
    const state = readRecordState(stateFile, empty(), true, { strict: true, now, validate: validateState });
    if (state.pending[0] && now() - Date.parse(state.pending[0].createdAt) >= TTL) {
      state.pending = []; save(state);
    }
    if (command.type === 'extract') {
      if (state.pending.length) { state.pending = []; save(state); }
      let items;
      try {
        if (!command.imagePaths?.length) throw new Error('缺少图片');
        items = validateItems(await provider.extract({ text: command.text, imagePaths: command.imagePaths }))
          .map(item => ({ name: line(item.name), quantity: line(item.quantity) || '数量待填',
            category: line(item.category) || '未分类' }));
      } catch {
        return refused('这次没识别到可登记的物品（识别失败），没有写入库存，请带照片重试。');
      }
      if (!items.length) return unchanged('没识别到可登记的物品，没有写入库存。');
      state.pending = [{ id: crypto.randomUUID(), items, createdAt: new Date(now()).toISOString() }];
      save(state);
      return changed(['待确认物品（尚未写入库存）：',
        ...items.map((item, i) => `${i + 1}. ${item.name}｜${item.quantity}｜${item.category}`), HINT].join('\n'));
    }
    const pending = state.pending[0];
    if (!pending) return unchanged('当前没有待确认的库存物品（可能已过期），请重新发照片。');
    // One-shot consumption matches screenshot actions; interrupted writes cannot replay a batch.
    state.pending = []; save(state);
    if (command.type === 'discard') return changed('已取消这次登记，没有写入库存。');
    const numbers = command.type === 'confirm_all' ? pending.items.map((_, i) => i + 1) : [...new Set(command.numbers)];
    const invalid = numbers.filter(n => !Number.isSafeInteger(n) || n < 1 || n > pending.items.length);
    const replies = [];
    let added = 0;
    for (const number of numbers.filter(n => !invalid.includes(n))) {
      const item = pending.items[number - 1];
      try {
        const result = inventory.execute('owner', { type: 'inventory_set', name: item.name, state: 'stocked', quantity: item.quantity });
        if (result.wrote) added++;
        replies.push(`第${number}项：${result.reply}`);
      } catch {
        replies.push(`第${number}项：库存写入未完成，请检查库存后再操作；后续项未执行。`);
        break;
      }
    }
    return changed([`实际登记了 ${added} 项库存。`, ...replies,
      ...(invalid.length ? [`已忽略越界序号：${invalid.join('、')}。`] : [])].join('\n'));
  }
  function execute(side, command) {
    const result = queue.then(() => apply(side, command));
    queue = result.catch(() => {});
    return result;
  }
  return { execute, hasPending };
}

module.exports = { createInventoryImageCapture, parseInventoryImageCommand };
