'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { extractParcelPickup, extractDeadline, REFUSAL, HELP } = require('./parcel-pickup-commands');
const MAX_PENDING = 30;
const TTL = 10 * 60 * 1000;
const validCode = code => typeof code === 'string' && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(code);
const validFields = item => item && validCode(item.code) && typeof item.location === 'string' && item.location.trim()
  && !/[\r\n]/u.test(item.location) && (item.deadline === null || (typeof item.deadline === 'string'
    && extractDeadline(`截止日期：${item.deadline}`) === item.deadline));
const describe = item => `取件码 ${item.code}｜${item.location}｜${item.deadline ? `截止 ${item.deadline}` : '未提供截止日期'}｜${item.status === 'picked' ? '已取' : '待取'}`;
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.parcels)
    || state.parcels.some(item => !validFields(item) || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || !['pending', 'picked'].includes(item.status) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || (item.status === 'picked' && !Number.isFinite(Date.parse(item.pickedAt))))
    || new Set(state.parcels.map(item => item.id)).size !== state.parcels.length
    || new Set(state.parcels.map(item => item.code)).size !== state.parcels.length
    || state.parcels.filter(item => item.status === 'pending').length > MAX_PENDING) throw new Error('取件存储格式无效');
}

function createParcelPickupStore({ stateFile, provider, now = () => Date.now(),
  readState = () => readRecordState(stateFile, { schemaVersion: 1, parcels: [] }, true,
    { strict: true, now, validate: validateState }) }) {
  const sessions = new Map();
  let queue = Promise.resolve();
  async function apply(command, sessionKey) {
    if (!command || !['add', 'confirm', 'list', 'picked_list', 'picked', 'delete', 'find'].includes(command.type)) return refused(HELP);
    const session = sessions.get(sessionKey) || {};
    sessions.set(sessionKey, session);
    if (command.type === 'add') delete session.candidate;
    if (command.type === 'add' && (typeof command.text !== 'string' || !command.text.trim())) return refused('请粘贴取件文本。' + HELP);
    const state = readState();
    validateState(state);
    const save = () => { validateState(state); writeRecordState(stateFile, state, ['parcels']); sessions.forEach(value => { delete value.view; }); };
    const full = () => state.parcels.filter(item => item.status === 'pending').length >= MAX_PENDING;
    const duplicate = item => state.parcels.find(saved => saved.code === item.code);
    function register(item) {
      const existing = duplicate(item);
      if (existing) return refused(`同取件码重复登记，未写入。已有条目：\n${describe(existing)}`);
      if (full()) return refused('待取已满 30 条，拒绝新登记；请先标记已取或删除，已有条目未淘汰。');
      const parcel = { ...item, id: crypto.randomUUID(), status: 'pending', createdAt: new Date(now()).toISOString() };
      state.parcels.push(parcel); save();
      return changed(`已登记：${describe(parcel)}`);
    }
    if (command.type === 'add') {
      const item = extractParcelPickup(command.text);
      if (item) return register(item);
      let candidate;
      try { candidate = await provider?.extract(command.text); } catch {
        return refused('取件模型候选提取未完成，未登记；请补充取件码和地点后重新登记。');
      }
      if (!candidate || !validCode(candidate.code) || !candidate.location?.trim()
        || /[\r\n]/u.test(candidate.location) || !command.text.includes(candidate.code)
        || !command.text.includes(candidate.location)) return refused(full()
          ? '待取已满 30 条，拒绝新登记；已有条目未淘汰。'
          : '未能确定取件码和地点，未登记。请补充“取件码：……，取件地点：……”后重新登记。');
      const proposed = { code: candidate.code, location: candidate.location, deadline: extractDeadline(command.text) };
      const existing = duplicate(proposed);
      if (existing) return refused(`同取件码重复登记，未写入。已有条目：\n${describe(existing)}`);
      if (full()) return refused('待取已满 30 条，拒绝新登记；已有条目未淘汰。');
      session.candidate = { item: proposed, expiresAt: now() + TTL };
      return unchanged(`模型候选、待主人确认（尚未入库）：\n${describe(proposed)}\n核对后回复“确认取件”，10 分钟内有效；新登记替换候选。模型候选质量待人工抽查。`);
    }
    if (command.type === 'confirm') {
      const candidate = session.candidate;
      delete session.candidate;
      if (!candidate || candidate.expiresAt <= now()) return refused('没有有效的待确认取件候选，请重新登记。');
      return register(candidate.item);
    }
    if (command.type === 'list' || command.type === 'picked_list') {
      const status = command.type === 'list' ? 'pending' : 'picked';
      const items = state.parcels.filter(item => item.status === status);
      session.view = items.map(item => item.id);
      return unchanged(items.length ? [`${status === 'pending' ? '待取' : '已取'}列表（${items.length} 条）`,
        ...items.map((item, i) => `${i + 1}. ${describe(item)}`),
        '序号仅对应本次列表；修改后请重新查看列表，也可直接用取件码操作。'].join('\n') : `暂无${status === 'pending' ? '待取' : '已取'}快递。`);
    }
    if (typeof command.target !== 'string' || !command.target.trim()) return refused(HELP);
    // Exact codes take precedence over numbers, including all-numeric pickup codes.
    let item = state.parcels.find(item => item.code === command.target);
    if (command.type === 'find') return item ? unchanged(describe(item)) : refused('未找到此取件码（仅精确匹配）。');
    if (!item && /^[+-]?\d+(?:\.\d+)?$/u.test(command.target)) {
      const number = Number(command.target);
      if (!session.view) return refused('序号无有效列表，请先查看取件列表或已取列表，或直接使用取件码。');
      if (!Number.isSafeInteger(number) || number < 1 || number > session.view.length) return refused('取件序号越界，未执行；请使用当次列表中的有效序号。');
      item = state.parcels.find(item => item.id === session.view[number - 1]);
      if (!item) { delete session.view; return refused('取件列表已变化，请重新查看列表后操作。'); }
    }
    if (!item) return refused('未找到此取件码，请查看列表后重试。');
    if (command.type === 'picked') {
      if (item.status === 'picked') return refused(`此条已取，无需重复标记：${describe(item)}`);
      item.status = 'picked'; item.pickedAt = new Date(now()).toISOString();
    } else state.parcels = state.parcels.filter(saved => saved.id !== item.id);
    save();
    return changed(`${command.type === 'delete' ? '已删除取件' : '已标记已取'}：${describe(item)}`);
  }
  function execute(side, command, sessionKey = 'owner') {
    // Reject before scheduling, reading any state, or invoking a model.
    if (side !== 'owner') return Promise.resolve(refused(REFUSAL));
    const task = queue.then(() => apply(command, sessionKey)).catch(() => refused('取件操作未完成，请检查并恢复取件存储后再试；未自动重试。'));
    queue = task.then(() => {});
    return task;
  }
  return { execute, discardSession: sessionKey => sessions.delete(sessionKey) };
}

module.exports = { createParcelPickupStore, MAX_PENDING };
