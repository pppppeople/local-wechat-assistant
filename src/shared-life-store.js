'use strict';

const crypto = require('crypto');
const { createBelongingMaintenance } = require('./belonging-maintenance');
const { changed, readResult, refused, resultText, unchanged } = require('./feature-result');
const { readRecordState, writeRecordState } = require('./record-state');
const { validatePurchase, warrantyExpiry, warrantyDaysLeft } = require('./belonging-purchase');
const { expiryTimestamp, expiryDaysLeft, expiryStatus } = require('./belonging-expiry');
const { validateReturnDeadlines, createReturnDeadlineHandler } = require('./return-deadline');

function clean(value, limit = 240) {
  const text = String(value || '').trim().slice(0, limit);
  if (/(?:密码|口令|验证码|token|cookie|secret|api[ _-]?key)\s*[：:=]\s*\S+/iu.test(text)) {
    throw new Error('这段内容疑似包含密码、Token、Cookie 或验证码，请删除后再保存');
  }
  return text;
}

function key(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[\s，,。.!！?？、：:；;（）()“”"'‘’_-]+/gu, '');
}

function validSide(side) {
  if (!['owner', 'friend'].includes(side)) throw new Error('invalid shared life side');
  return side;
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();
}

function findMatches(entries, query, fields) {
  const needle = key(query);
  if (!needle) return [];
  const exact = entries.filter((entry) => fields.some((field) => key(entry[field]) === needle));
  if (exact.length) return exact;
  return entries.filter((entry) => fields.some((field) => {
    const value = key(entry[field]);
    return value && (value.includes(needle) || needle.includes(value));
  }));
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

function createSharedLifeStore({ stateFile, now = () => Date.now(), capsuleScheduler = null,
  sideNames = { owner: 'Owner', friend: '好友' } }) {
  function load(options = {}) {
    const state = readRecordState(stateFile, { schemaVersion: 1, belongings: [], commitments: [], inventory: [] }, true,
      { ...options, validate: validateReturnDeadlines });
    state.schemaVersion = 1;
    state.belongings = Array.isArray(state.belongings) ? state.belongings : [];
    state.commitments = Array.isArray(state.commitments) ? state.commitments : [];
    state.inventory = Array.isArray(state.inventory) ? state.inventory : [];
    return state;
  }
  function save(state) { writeRecordState(stateFile, state, ['belongings', 'commitments', 'inventory']); }
  const maintenance = createBelongingMaintenance({ load, save, findMatches, clean, now });
  const returnDeadline = createReturnDeadlineHandler({ load, save, findMatches, clean, now });
  function timestamp() { return new Date(now()).toISOString(); }

  function ownBelonging(state, side, name) {
    let item = state.belongings.find((entry) => entry.ownerSide === side && key(entry.name) === key(name));
    if (!item) {
      if (state.belongings.filter((entry) => entry.ownerSide === side).length >= 100) throw new Error('物品位置最多保存一百条');
      item = { id: createId('BL'), ownerSide: side, name, location: '', createdAt: timestamp() };
      item.provenance = {
        sourceType: 'explicit_natural_language', ownerSide: side, visibility: 'owner_only',
        createdReason: '用户明确记录物品', updatedAt: item.createdAt,
      };
      state.belongings.push(item);
    }
    return item;
  }

  function setBelonging(side, name, location) {
    validSide(side);
    const safeName = clean(name, 80);
    const safeLocation = clean(location, 160).replace(/[。！!~～]+$/gu, '');
    if (!safeName || !safeLocation) throw new Error('请同时说清楚物品和放置位置');
    const state = load();
    const item = ownBelonging(state, side, safeName);
    item.location = safeLocation;
    item.updatedAt = timestamp();
    item.provenance = {
      sourceType: 'explicit_natural_language', ownerSide: side, visibility: 'owner_only',
      createdReason: '用户明确记录物品位置', updatedAt: item.updatedAt,
    };
    save(state);
    return changed(`记住了：${item.name}在${item.location}。这条位置只对你自己的助手可见。`);
  }

  function setPurchase(side, command, link = null) {
    validSide(side);
    const name = clean(command.name, 80);
    if (!key(name)) throw new Error('请说清楚物品名称');
    const purchase = validatePurchase(command, now());
    const state = load();
    let targetName = name;
    if (link) {
      if (side !== 'owner') return refused('购物冷静期仅主人可用。');
      if (state.cooldownPurchases?.[link.id]) return unchanged('该冷静期条目已登记保修，不会重复写入。');
      const matches = findMatches(state.belongings.filter(entry => entry.ownerSide === side), name, ['name']);
      if (matches.length > 1) return refused('生活箱有多个候选物品，存在歧义，未登记保修。');
      if (!matches.length && !link.allowCreate) return refused('生活箱不存在该物品，须先明确确认新建。');
      // Preserve the unique existing identity when normalized/inclusion matching succeeds.
      if (matches.length) targetName = matches[0].name;
      state.cooldownPurchases = { ...state.cooldownPurchases, [link.id]: true };
    }
    const item = ownBelonging(state, side, targetName);
    item.purchase = purchase;
    item.updatedAt = timestamp();
    save(state);
    return changed(`已登记「${item.name}」：购买日期 ${purchase.purchaseDate}，金额 ${purchase.amount}元，保修 ${purchase.warrantyMonths}个月，到期日 ${warrantyExpiry(purchase.purchaseDate, purchase.warrantyMonths)}。购买信息只对你自己的助手可见。`);
  }

  function queryWarranty(side, name) {
    validSide(side);
    const matches = findMatches(load().belongings.filter((entry) => entry.ownerSide === side), name, ['name']);
    if (!matches.length) return `「${clean(name, 80)}」未登记购买信息。`;
    if (matches.length > 1) return `我找到 ${matches.length} 条相近记录：${matches.map((item) => item.name).join('、')}。你问的是哪一个？`;
    const item = matches[0];
    if (!item.purchase) return `「${item.name}」未登记购买信息。`;
    const purchase = item.purchase;
    return `「${item.name}」｜购买日期 ${purchase.purchaseDate}｜金额 ${purchase.amount}元｜保修到期日 ${warrantyExpiry(purchase.purchaseDate, purchase.warrantyMonths)}｜${warrantyDaysLeft(purchase, now()) >= 0 ? '在保' : '已过保'}`;
  }

  function listWarranties(side) {
    validSide(side);
    const clock = now();
    const items = load().belongings.filter((entry) => entry.ownerSide === side && entry.purchase)
      .map((item) => ({ name: item.name, expiry: warrantyExpiry(item.purchase.purchaseDate, item.purchase.warrantyMonths), days: warrantyDaysLeft(item.purchase, clock) }))
      .filter((item) => item.days <= 30).sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (!items.length) return '暂无已过保或未来 30 天内到期的物品。';
    return ['已过保与即将到期的物品：', ...items.map((item) => `${item.name}｜${item.expiry}｜${item.days < 0 ? `已过保 ${-item.days} 天` : `剩 ${item.days} 天`}`)].join('\n');
  }

  // Expiry is independent of purchase/warranty and never creates a missing item.
  function handleExpiry(side, command) {
    const state = load();
    const own = state.belongings.filter(item => item.ownerSide === side);
    if (command.type === 'belonging_expiry_list') {
      const clock = now();
      const rows = own.filter(item => item.expiresAt !== undefined)
        .map(item => ({ ...item, days: expiryDaysLeft(item.expiresAt, clock) }))
        .filter(item => item.days <= 30).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
      return rows.length ? ['已过期与临期物品（未来 30 天内，含今天）：',
        ...rows.map(item => `${item.name}｜${item.expiresAt}｜${expiryStatus(item.days)}`)].join('\n')
        : '暂无已过期或未来 30 天内临期的物品。';
    }
    const name = clean(command.name, 80);
    if (!key(name)) throw new Error('请说清楚物品名称');
    if (command.type === 'belonging_expiry_set') expiryTimestamp(command.expiresAt);
    const matches = findMatches(own, name, ['name']);
    if (!matches.length) return refused(`未找到「${name}」的物品记录，请先登记物品位置或购买信息。`);
    if (matches.length > 1) return refused(`有 ${matches.length} 条相近记录，无法确定要处理哪条，请指定候选名称：${matches.map(item => item.name).join('、')}。`);
    const item = matches[0];
    if (command.type === 'belonging_expiry_query') {
      return item.expiresAt === undefined ? `「${item.name}」未设置保质期。`
        : `「${item.name}」｜保质期 ${item.expiresAt}｜${expiryStatus(expiryDaysLeft(item.expiresAt, now()))}`;
    }
    if (command.type === 'belonging_expiry_clear') {
      if (item.expiresAt === undefined) return unchanged(`「${item.name}」未设置保质期，无需清除。`);
      delete item.expiresAt;
    } else item.expiresAt = command.expiresAt;
    item.updatedAt = timestamp();
    save(state);
    return changed(command.type === 'belonging_expiry_clear' ? `已清除「${item.name}」的保质期。`
      : `已设置「${item.name}」的保质期：${item.expiresAt}。`);
  }

  function listBelongings(side) {
    validSide(side);
    const items = load().belongings.filter((entry) => entry.ownerSide === side)
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
    if (!items.length) return '我还没记录你的物品位置。可以直接说“备用钥匙放在电视柜第二层”。';
    return ['我替你记着这些位置：', ...items.map((item, index) => `${index + 1}. ${item.name}｜${item.location || '未记录位置'}`)].join('\n');
  }

  function queryBelonging(side, name) {
    validSide(side);
    const matches = findMatches(load().belongings.filter((entry) => entry.ownerSide === side), name, ['name']);
    if (!matches.length) return `我还没记录「${clean(name, 80)}」放在哪里。`;
    if (matches.length > 1) return `我找到 ${matches.length} 条相近记录：${matches.map((item) => item.name).join('、')}。你问的是哪一个？`;
    return matches[0].location ? `${matches[0].name}在${matches[0].location}。` : `「${matches[0].name}」未记录位置。`;
  }

  function deleteBelonging(side, name) {
    validSide(side);
    const state = load();
    const own = state.belongings.filter((entry) => entry.ownerSide === side);
    const matches = findMatches(own, name, ['name']);
    if (!matches.length) return refused(`我没有找到「${clean(name, 80)}」的位置记录，所以什么都没删。`);
    if (matches.length > 1) return refused(`有 ${matches.length} 条相近位置记录，请说得更具体一点：${matches.map((item) => item.name).join('、')}。`);
    state.belongings = state.belongings.filter((entry) => entry.id !== matches[0].id);
    save(state);
    return changed(`已经忘掉「${matches[0].name}」的位置记录。`);
  }

  function addCommitment(side, text) {
    validSide(side);
    const body = clean(text, 240);
    if (!body) throw new Error('约定内容不能为空');
    const state = load();
    const duplicate = state.commitments.find((entry) => entry.status === 'open' && key(entry.text) === key(body));
    if (duplicate) return unchanged(`这件事已经在约定里了：#${duplicate.id} ${duplicate.text}`);
    if (state.commitments.filter((entry) => entry.status === 'open').length >= 50) throw new Error('未完成约定最多保存五十条');
    const item = {
      id: createId('CM'), text: body, createdBy: side, status: 'open', createdAt: timestamp(), updatedAt: timestamp(),
      provenance: { sourceType: 'explicit_natural_language', ownerSide: side, visibility: 'fixed_pair', createdReason: '用户明确记录双人约定' },
    };
    state.commitments.push(item);
    save(state);
    return changed(`已经记进“我们说过要做的事”：#${item.id} ${item.text}。这条约定双方都能查看。`);
  }

  function listCommitments(side) {
    validSide(side);
    const items = load().commitments.filter((entry) => entry.status !== 'deleted')
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
    const open = items.filter((entry) => entry.status === 'open');
    const done = items.filter((entry) => entry.status === 'done').slice(0, 5);
    if (!open.length && !done.length) return '现在还没有记录双人约定。可以说“记一下，我答应好友周末修耳机”。';
    return [open.length ? '我们还说过要做：' : '现在没有未完成的约定。',
      ...open.map((item, index) => `${index + 1}. #${item.id}｜${item.text}｜由${sideNames[item.createdBy]}记录`),
      ...(done.length ? ['最近完成：', ...done.map((item) => `✓ #${item.id}｜${item.text}`)] : [])].join('\n');
  }

  function resolveCommitment(state, query) {
    const active = state.commitments.filter((entry) => !['deleted'].includes(entry.status));
    const byId = active.find((entry) => entry.id === String(query || '').toUpperCase().replace(/^#/, ''));
    if (byId) return [byId];
    return findMatches(active, query, ['text']);
  }

  function completeCommitment(side, query) {
    validSide(side);
    const state = load();
    const matches = resolveCommitment(state, query).filter((entry) => entry.status === 'open');
    if (!matches.length) return refused('没有找到对应的未完成约定。');
    if (matches.length > 1) return refused(`有 ${matches.length} 条相近约定，请带上编号：${matches.map((item) => `#${item.id}`).join('、')}。`);
    matches[0].status = 'done';
    matches[0].completedBy = side;
    matches[0].completedAt = timestamp();
    matches[0].updatedAt = matches[0].completedAt;
    save(state);
    return changed(`好，「${matches[0].text}」已经标记完成。`);
  }

  function deleteCommitment(side, query) {
    validSide(side);
    const state = load();
    const matches = resolveCommitment(state, query).filter((entry) => entry.status !== 'deleted');
    if (!matches.length) return refused('没有找到要删除的约定。');
    if (matches.length > 1) return refused(`有 ${matches.length} 条相近约定，请带上编号：${matches.map((item) => `#${item.id}`).join('、')}。`);
    if (matches[0].createdBy !== side) return refused(`这条约定是${sideNames[matches[0].createdBy]}记录的，只能由记录者删除；你可以把它标记完成。`);
    matches[0].status = 'deleted';
    matches[0].text = '';
    matches[0].updatedAt = timestamp();
    save(state);
    return changed('已经删除这条约定。');
  }

  function effectiveInventory(item) {
    return [...(item.updates || [])].sort((left, right) => new Date(right.at) - new Date(left.at))[0] || null;
  }

  function setInventory(side, name, stateName, quantity) {
    validSide(side);
    const safeName = clean(name, 80);
    if (!safeName) throw new Error('请说清楚是哪样东西');
    const allowed = ['needed', 'low', 'stocked'];
    if (!allowed.includes(stateName)) throw new Error('库存状态不支持');
    const state = load();
    let item = state.inventory.find((entry) => key(entry.name) === key(safeName));
    if (!item) {
      if (state.inventory.length >= 100) throw new Error('共享库存最多保存一百项');
      item = { id: createId('IV'), name: safeName, updates: [], createdAt: timestamp() };
      state.inventory.push(item);
    }
    item.name = safeName;
    item.updates.push({ side, state: stateName, quantity: clean(quantity, 50), at: timestamp() });
    item.updates = item.updates.slice(-20);
    item.updatedAt = timestamp();
    item.provenance = { sourceType: 'explicit_natural_language', visibility: 'fixed_pair', createdReason: '用户明确更新共享家庭库存' };
    save(state);
    const label = stateName === 'needed' ? '需要补货' : (stateName === 'low' ? `只剩${clean(quantity, 50)}` : (quantity ? `还有${clean(quantity, 50)}` : '已经补好'));
    return changed(`共享库存已更新：${item.name}｜${label}。`);
  }

  function listInventory(side, needsOnly = false) {
    validSide(side);
    const rows = load().inventory.map((item) => ({ item, update: effectiveInventory(item) })).filter((row) => row.update)
      .filter((row) => !needsOnly || ['needed', 'low'].includes(row.update.state))
      .sort((left, right) => new Date(right.update.at) - new Date(left.update.at));
    if (!rows.length) return needsOnly ? '采购池现在是空的，暂时没有明确缺货或快用完的东西。' : '共享家庭库存现在还是空的。';
    const title = needsOnly ? '目前采购池：' : '共享家庭库存：';
    return [title, ...rows.map(({ item, update }, index) => {
      const status = update.state === 'needed' ? '要买' : (update.state === 'low' ? `只剩${update.quantity}` : (update.quantity ? `还有${update.quantity}` : '已补好'));
      return `${index + 1}. ${item.name}｜${status}｜${sideNames[update.side]}更新`;
    })].join('\n');
  }

  function deleteInventory(side, name) {
    validSide(side);
    const state = load();
    const matches = findMatches(state.inventory, name, ['name']);
    if (!matches.length) return refused(`共享库存里没有「${clean(name, 80)}」，所以什么都没删。`);
    if (matches.length > 1) return refused(`找到几项相近库存，请说具体一点：${matches.map((item) => item.name).join('、')}。`);
    state.inventory = state.inventory.filter((entry) => entry.id !== matches[0].id);
    save(state);
    return changed(`已经把「${matches[0].name}」从共享库存和采购池移除。`);
  }

  function help(side) {
    return [
      '生活箱现在有四个轻量功能：',
      '• 物品位置（只对记录者可见）：备用钥匙放在电视柜第二层 / 我的备用钥匙放哪了 / 删除备用钥匙的位置',
      '  购买与保修：登记购买 耳机 299元 保修1年 / 保修查询 耳机 / 哪些东西快过保了',
      '  保质期（独立于保修，仅主动查询）：设置保质期 牛奶 2026-12-01 / 保质期查询 牛奶 / 清除保质期 牛奶 / 保质期列表',
      ...(side === 'owner' ? ['  主人维护提醒：设置维护周期 滤芯 30天 / 维护查询 滤芯 / 完成维护 滤芯 / 暂停维护提醒 滤芯 / 恢复维护提醒 滤芯 / 清除维护周期 滤芯 / 维护列表'] : []),
      '• 双人约定：记一下，我答应好友周末修耳机 / 查看我们的约定 / 把修耳机这个约定标记完成',
      '• 共享库存：洗衣液剩半瓶 / 纸巾没了 / 纸巾买好了 / 家里缺什么',
      '• 文字时间胶囊：一个月后把这句话发给我们俩：希望那时已经去看展 / 每年10月3日晚上8点把这句话发给我们俩：纪念日快乐 / 查看时间胶囊 / 取消时间胶囊 #编号',
    ].join('\n');
  }

  function handleResult(side, command) {
    validSide(side);
    if (!command || typeof command !== 'object') throw new Error('生活箱指令无效');
    if (command.type?.startsWith('belonging_return_deadline_')) return returnDeadline(side, command);
    if (command.type?.startsWith('belonging_maintenance_')) return maintenance.handle(side, command);
    if (command.type === 'help') return help(side);
    if (command.type === 'belonging_set') return setBelonging(side, command.name, command.location);
    if (command.type === 'belonging_list') return listBelongings(side);
    if (command.type === 'belonging_query') return queryBelonging(side, command.name);
    if (command.type === 'belonging_delete') return deleteBelonging(side, command.name);
    if (['belonging_expiry_set', 'belonging_expiry_query', 'belonging_expiry_clear', 'belonging_expiry_list'].includes(command.type)) return handleExpiry(side, command);
    if (command.type === 'belonging_purchase_set') return setPurchase(side, command);
    if (command.type === 'belonging_warranty_query') return queryWarranty(side, command.name);
    if (command.type === 'belonging_warranty_list') return listWarranties(side);
    if (command.type === 'commitment_add') return addCommitment(side, command.text);
    if (command.type === 'commitment_list') return listCommitments(side);
    if (command.type === 'commitment_complete') return completeCommitment(side, command.query);
    if (command.type === 'commitment_delete') return deleteCommitment(side, command.query);
    if (command.type === 'inventory_set') return setInventory(side, command.name, command.state, command.quantity);
    if (command.type === 'inventory_list') return listInventory(side, command.needsOnly === true);
    if (command.type === 'inventory_delete') return deleteInventory(side, command.name);
    if (command.type === 'capsule_create') {
      if (!capsuleScheduler) throw new Error('时间胶囊调度尚未启用');
      const capsule = capsuleScheduler.createTimeCapsule(side, command.text, command.schedule?.sendAt, {
        recurrence: command.schedule?.recurrence,
      });
      return changed(`时间胶囊 #${capsule.id} 已经封好，${capsule.recurrence?.type === 'annual' ? '会从' : '会在'} ${formatDate(capsule.sendAt)}${capsule.recurrence?.type === 'annual' ? '开始每年' : ''}发给你们两个人。到期前不会把正文透露给对方。`);
    }
    if (command.type === 'capsule_list') {
      if (!capsuleScheduler) throw new Error('时间胶囊调度尚未启用');
      return capsuleScheduler.listTimeCapsules(side);
    }
    if (command.type === 'capsule_cancel') {
      if (!capsuleScheduler) throw new Error('时间胶囊调度尚未启用');
      return changed(capsuleScheduler.cancelTimeCapsule(side, command.id));
    }
    throw new Error('不支持这个生活箱操作');
  }

  function explain(side, query) {
    validSide(side);
    const state = load();
    const belonging = findMatches(state.belongings.filter((item) => item.ownerSide === side), query, ['name', 'location'])[0];
    if (belonging) return `我知道这条物品位置，是因为你在 ${formatDate(belonging.updatedAt)} 明确让自己的助手记录过；它只对你可见。`;
    const commitment = findMatches(state.commitments.filter((item) => item.status !== 'deleted'), query, ['text'])[0];
    if (commitment) return `这来自${sideNames[commitment.createdBy]}在 ${formatDate(commitment.createdAt)} 明确加入的双人约定，不是从私人聊天或长期记忆推断的。`;
    const inventory = findMatches(state.inventory, query, ['name'])[0];
    const update = inventory ? effectiveInventory(inventory) : null;
    if (inventory && update) return `这来自${sideNames[update.side]}在 ${formatDate(update.at)} 对共享家庭库存的明确更新，不是从私人记忆推断的。`;
    return null;
  }

  function deleteSide(side) {
    validSide(side);
    const state = load();
    const belongings = state.belongings.filter((item) => item.ownerSide === side).length;
    const commitments = state.commitments.filter((item) => item.createdBy === side).length;
    state.belongings = state.belongings.filter((item) => item.ownerSide !== side);
    state.commitments = state.commitments.filter((item) => item.createdBy !== side);
    for (const item of state.commitments) {
      if (item.completedBy !== side) continue;
      item.status = 'open';
      delete item.completedBy;
      delete item.completedAt;
      item.updatedAt = timestamp();
    }
    let inventoryUpdates = 0;
    state.inventory = state.inventory.map((item) => {
      const updates = (item.updates || []).filter((update) => {
        if (update.side === side) inventoryUpdates += 1;
        return update.side !== side;
      });
      return { ...item, updates };
    }).filter((item) => item.updates.length);
    save(state);
    const capsules = capsuleScheduler ? capsuleScheduler.deleteTimeCapsules(side) : 0;
    return { belongings, commitments, inventoryUpdates, capsules };
  }

  function handle(side, command) { return resultText(handleResult(side, command)); }
  function execute(side, command) { return readResult(handleResult(side, command)); }

  function readBriefItems(side) {
    validSide(side);
    const state = load({ strict: true, readOnly: true });
    return {
      commitments: state.commitments.filter((item) => item.status === 'open')
        .map(({ text, dueDate }) => ({ text, dueDate })),
      inventory: state.inventory.map((item) => ({ name: item.name, update: effectiveInventory(item) }))
        .filter(({ update }) => update && ['needed', 'low'].includes(update.state))
        .sort((a, b) => new Date(b.update.at) - new Date(a.update.at))
        .map(({ name }) => name),
    };
  }
  function readBelongings(side) {
    validSide(side);
    return load({ strict: true, readOnly: true }).belongings.filter(item => item.ownerSide === side)
      .map(({ id, name }) => ({ id, name }));
  }
  function readInventory(side) {
    if (side !== 'owner') return [];
    return load({ strict: true, readOnly: true }).inventory
      .map(({ id, name, updates }) => ({ id, name, update: effectiveInventory({ updates }) }))
      .filter(({ update }) => update);
  }
  function readNamedInventory(side, names) {
    if (side !== 'owner') return [];
    const wanted = new Set(names.map(key));
    return load({ strict: true, readOnly: true }).inventory
      .filter(item => wanted.has(key(item.name)))
      .map(({ name, expiresAt }) => ({ name, ...(expiresAt !== undefined ? { expiresAt } : {}) }));
  }
  function registerCooldownPurchase(side, id, command, allowCreate = false) {
    if (side !== 'owner') return refused('购物冷静期仅主人可用。');
    if (!/^[a-z0-9_-]+$/iu.test(id || '')) throw new Error('无效冷静期关联');
    return setPurchase(side, command, { id, allowCreate });
  }
  return { maintenance, deleteSide, explain, handle, execute, readBriefItems, readBelongings, readInventory, readNamedInventory, registerCooldownPurchase };
}

module.exports = { createSharedLifeStore, inventoryNameKey: key };
