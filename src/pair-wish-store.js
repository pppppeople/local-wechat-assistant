'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const SIDES = ['owner', 'friend'];
const collections = ['owner_wishes', 'friend_wishes'];
const peer = side => side === 'owner' ? 'friend' : 'owner';
const key = side => `${side}_wishes`;
const validSide = side => { if (!SIDES.includes(side)) throw new Error('invalid wish side'); };
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const day = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
function validate(state) {
  const fail = () => { throw new Error('心愿存储格式无效'); };
  if (state?.schemaVersion !== 1 || !state.current || Object.keys(state.current).some(s => !SIDES.includes(s))) fail();
  const ids = new Set();
  for (const side of SIDES) {
    if (!Array.isArray(state[key(side)])) fail();
    for (const wish of state[key(side)]) {
      if (!wish || typeof wish.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(wish.id) || ids.has(wish.id)
        || wish.owner !== side || typeof wish.text !== 'string' || !wish.text.trim() || wish.text.length > 500
        || !date(wish.createdAt) || !['hidden', 'drawn', 'completed'].includes(wish.status)
        || !(wish.cooldownDate === null || /^\d{4}-\d{2}-\d{2}$/u.test(wish.cooldownDate))
        || !(wish.completedAt === null || date(wish.completedAt))
        || (wish.status === 'completed') !== Boolean(wish.completedAt)) fail();
      ids.add(wish.id);
      if (wish.status === 'drawn' && state.current[peer(side)]?.id !== wish.id) fail();
    }
    if (state[key(side)].filter(w => w.status !== 'completed').length > 20) fail();
    const current = state.current[side];
    if (current !== null) {
      if (!current || typeof current.id !== 'string' || typeof current.invalidated !== 'boolean') fail();
      const wish = state[key(peer(side))]?.find(w => w.id === current.id);
      if (current.invalidated ? Boolean(wish) : !wish || wish.status !== 'drawn') fail();
    }
  }
}

function createPairWishStore({ stateFile, now = () => Date.now(), random = Math.random }) {
  const empty = () => ({ schemaVersion: 1, owner_wishes: [], friend_wishes: [], current: { owner: null, friend: null } });
  const load = () => readRecordState(stateFile, empty(), true, { strict: true, now, validate });
  function save(state) { validate(state); writeRecordState(stateFile, state, collections); }
  function removeOwned(state, side, wishes) {
    const ids = new Set(wishes.map(w => w.id));
    state[key(side)] = state[key(side)].filter(w => !ids.has(w.id));
    if (ids.has(state.current[peer(side)]?.id)) state.current[peer(side)].invalidated = true;
  }
  function handle(side, command) {
    validSide(side);
    if (!command || !['add', 'list', 'draw', 'complete', 'return', 'delete'].includes(command.type)) throw new Error('不支持的心愿命令');
    const state = load();
    // Retain only the relationship ID after deletion, so the next operation can explain invalidation.
    if (state.current[side]?.invalidated) {
      state.current[side] = null;
      save(state);
      return '你当前抽中的心愿已被创建者删除，现已失效；本次操作未执行，请重新操作。';
    }
    const own = state[key(side)];
    if (command.type === 'add') {
      if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 500) return '请填写 1–500 字的小心愿。';
      if (own.filter(w => w.status !== 'completed').length >= 20) return '你的未完成心愿已达 20 条上限，请先完成或删除一些。';
      own.push({ id: crypto.randomUUID(), owner: side, text: command.text.trim(), status: 'hidden',
        createdAt: new Date(now()).toISOString(), completedAt: null, cooldownDate: null });
      save(state);
      return '已存下你的小心愿（未公开），对方抽中时才会看到。';
    }
    if (command.type === 'list') return own.length ? ['我的心愿：', ...own.map((w, i) =>
      `${i + 1}. ${w.text}（${w.status === 'hidden' ? '未公开' : w.status === 'drawn' ? '已被对方抽中' : `已完成，完成时间：${w.completedAt}`}）`)].join('\n') : '你还没有存下小心愿。';
    if (command.type === 'delete') {
      if (!Number.isSafeInteger(command.index) || !own[command.index - 1]) return '没有这个编号的心愿，请先查看「我的心愿」。';
      removeOwned(state, side, [own[command.index - 1]]);
      save(state);
      return '已删除你的这条心愿；如已被抽中，对方的当前抽中同时失效。';
    }
    const current = state.current[side];
    if (command.type === 'draw') {
      if (current) return `你当前抽中的心愿：${state[key(peer(side))].find(w => w.id === current.id).text}\n可说「心愿完成了」或「换个心愿」。`;
      const candidates = state[key(peer(side))].filter(w => w.status === 'hidden' && (!w.cooldownDate || w.cooldownDate < day(now())));
      if (!candidates.length) return '对方目前没有可抽的小心愿（放回的心愿次日才可再抽）。';
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源无效');
      const wish = candidates[Math.floor(value * candidates.length)];
      wish.status = 'drawn';
      state.current[side] = { id: wish.id, invalidated: false };
      save(state);
      return `抽中了对方的小心愿：${wish.text}\n可说「心愿完成了」或「换个心愿」。`;
    }
    if (!current) return '你当前没有抽中的心愿，可以说「抽一个对方的小心愿」。';
    const wish = state[key(peer(side))].find(w => w.id === current.id);
    state.current[side] = null;
    if (command.type === 'complete') {
      wish.status = 'completed';
      wish.completedAt = new Date(now()).toISOString();
      save(state);
      return '心愿已标记完成，已留下完成时间。';
    }
    wish.status = 'hidden';
    wish.cooldownDate = day(now());
    save(state);
    return '已放回当前心愿，今天不会再抽到这条；可以再说「抽一个对方的小心愿」。';
  }
  function deleteSide(side) {
    validSide(side);
    const state = load();
    const removed = state[key(side)].length;
    removeOwned(state, side, state[key(side)]);
    const held = state.current[side];
    if (held && !held.invalidated) state[key(peer(side))].find(w => w.id === held.id).status = 'hidden';
    state.current[side] = null;
    save(state);
    return { removed };
  }
  return { handle, deleteSide };
}
module.exports = { createPairWishStore };
