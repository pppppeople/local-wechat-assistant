'use strict';

const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const MISSIONS = Object.freeze([
  '主动夸对方一个今天的小细节。',
  '用手边的纸折一个小惊喜给对方看。',
  '拍一张今天的天空，亲自发给对方。',
  '给对方画一个只有三笔的小动物。',
  '亲自给对方分享一首适合今天的歌名。',
  '给今天遇见的一朵云起个名字，亲口告诉对方。',
  '把一件手边的小物摆成笑脸，亲自给对方看。',
  '给对方写一句带有水果名字的问候。',
  '主动向对方说一句具体的谢谢。',
  '用三个表情给对方描述今天的天气。',
  '给对方编一个十个字以内的小故事。',
  '给对方画一张想象中的明信片。',
  '找一个身边有趣的影子，亲自描述给对方。',
  '用手边的杯子轻敲一小段节奏给对方听。',
  '给对方想一个云朵主题的可爱称呼。',
  '给一件普通文具编个外号，亲口告诉对方。',
  '亲自给对方讲一个关于小动物的原创冷笑话。',
  '把一句普通问候改成童话口吻，亲口说给对方。',
  '用纸写一张不署名的小鼓励，亲自给对方看。',
  '找出身边两样同色的小物，亲自分享给对方。',
  '给对方写一句只有你们能读懂的天气预报。',
  '用手指比一个有趣的手影，亲自给对方看。',
  '给今天起个电影片名，亲自告诉对方。',
  '给对方编一句以星星结尾的小祝福。',
]);
const SIDES = ['owner', 'friend'];
const terminal = entry => entry && ['completed', 'abandoned'].includes(entry.status);
const labels = { active: '进行中', completed: '已完成', abandoned: '已放弃', expired: '已作废' };
function validSide(side) {
  if (!SIDES.includes(side)) throw new Error('invalid secret mission side');
}
function validateState(state) {
  if (state?.schemaVersion !== 1 || typeof state.binding !== 'string' || !Array.isArray(state.days)
    || state.days.length > 2 || new Set(state.days.map(day => day.id)).size !== state.days.length
    || state.days.some(day => !/^\d{4}-\d{2}-\d{2}$/u.test(day.id)
      || day.id !== shanghaiDay(day.createdAt) || !['sealed', 'revealed'].includes(day.status)
      || !day.entries || typeof day.entries !== 'object' || Array.isArray(day.entries)
      || Object.entries(day.entries).some(([side, entry]) => !SIDES.includes(side)
        || !entry || !Object.hasOwn(labels, entry.status)
        || !(Number.isInteger(entry.mission) && entry.mission >= 0 && entry.mission < MISSIONS.length
          || entry.mission === null && entry.status === 'abandoned'))
      || day.entries.owner?.mission != null && day.entries.owner.mission === day.entries.friend?.mission
      || !day.seen || SIDES.some(side => typeof day.seen[side] !== 'boolean')
      || day.status === 'revealed' && Object.values(day.entries).some(entry => entry.status === 'active')
      || day.status === 'sealed' && (SIDES.some(side => day.seen[side])
        || SIDES.every(side => terminal(day.entries[side]))
        || SIDES.some(side => day.entries[side]?.status === 'expired')))) {
    throw new Error('秘密任务存储格式无效');
  }
}
function createPairSecretMissionStore({ stateFile, getBinding, now = () => Date.now(), random = Math.random,
  sideNames = { owner: 'Owner', friend: '好友' } }) {
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['days']); };
  function load() {
    const binding = getBinding();
    if (typeof binding !== 'string' || !binding) throw new Error('秘密任务尚未绑定');
    const state = readRecordState(stateFile, { schemaVersion: 1, binding, days: [] }, true,
      { strict: true, now, validate: validateState });
    const date = shanghaiDay(now());
    const yesterday = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    let changed = false;
    if (state.binding !== binding) { state.binding = binding; state.days = []; changed = true; }
    const kept = state.days.filter(day => day.id === date || day.id === yesterday);
    if (kept.length !== state.days.length) { state.days = kept; changed = true; }
    for (const day of state.days) {
      if (day.id !== date && day.status === 'sealed') {
        for (const entry of Object.values(day.entries)) if (entry.status === 'active') entry.status = 'expired';
        day.status = 'revealed';
        changed = true;
      }
    }
    if (changed) save(state);
    return { state, date };
  }
  function reveal(day) {
    return [`秘密任务揭晓（${day.id}）：`, ...SIDES.map(side => {
      const entry = day.entries[side];
      return `${sideNames[side]}：${entry?.mission != null ? MISSIONS[entry.mission] : '未抽取任务'}（${entry ? labels[entry.status] : '未抽取'}）`;
    })].join('\n');
  }
  function handle(side, command) {
    validSide(side);
    if (!command || !['draw', 'complete', 'abandon'].includes(command.type)) throw new Error('不支持的秘密任务命令');
    const { state, date } = load();
    let day = state.days.find(item => item.id === date);
    const previous = state.days.find(item => item.id !== date);
    if (!day) {
      day = { id: date, createdAt: new Date(now()).toISOString(), status: 'sealed', entries: {}, seen: { owner: false, friend: false } };
      state.days.push(day);
    }
    let entry = day.entries[side];
    let prefix = '';
    if (day.status === 'sealed') {
      if (command.type === 'draw' && !entry) {
        const other = day.entries[side === 'owner' ? 'friend' : 'owner'];
        const candidates = MISSIONS.map((_, index) => index).filter(index => index !== other?.mission);
        const value = random();
        if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源无效');
        entry = day.entries[side] = { mission: candidates[Math.floor(value * candidates.length)], status: 'active' };
      } else if (command.type === 'complete' && !entry) prefix = '请先发「秘密任务」抽取今天的任务。\n';
      else if (command.type === 'abandon' && !entry) {
        entry = day.entries[side] = { mission: null, status: 'abandoned' };
      } else if (entry?.status === 'active' && command.type !== 'draw') {
        entry.status = command.type === 'complete' ? 'completed' : 'abandoned';
      } else if (terminal(entry) && command.type !== 'draw') prefix = '今天已终局，不能修改结果。\n';
      if (SIDES.every(key => terminal(day.entries[key]))) day.status = 'revealed';
    }
    let text;
    if (day.status === 'revealed') { day.seen[side] = true; text = reveal(day); }
    else {
      const other = day.entries[side === 'owner' ? 'friend' : 'owner'];
      text = [`秘密任务（${date}）：`,
        entry?.mission != null ? `你的任务：${MISSIONS[entry.mission]}` : '你尚未抽取任务。',
        `你：${entry ? labels[entry.status] : '未抽取'}；对方：${other ? other.status === 'completed' ? '已完成' : '进行中' : '未抽取'}。`,
        terminal(entry) ? '今天不能再抽任务，等待双方终局或日终揭晓。' : '可说「秘密任务完成了」或「放弃秘密任务」。',
        '任务由你本人执行，涉及分享的内容请亲自发给对方；系统不代发。'].join('\n');
    }
    if (previous) { previous.seen[side] = true; text += `\n昨日${reveal(previous)}`; }
    save(state);
    return prefix + text;
  }
  function claim(side) {
    validSide(side);
    const { state } = load();
    const pending = state.days.filter(day => day.status === 'revealed' && !day.seen[side]);
    if (!pending.length) return { result: { pending: false, text: '' }, dates: [] };
    const text = pending.map(reveal).join('\n');
    for (const day of pending) day.seen[side] = true;
    save(state); // Consume before returning/transport; failures must never replay a claimed reveal.
    return { result: { pending: true, text }, dates: pending.map(day => day.id).sort() };
  }
  function takePending(side) { return claim(side).result; }
  async function tick(deliver) {
    const { result, dates } = claim('owner');
    if (result.pending) await deliver(result.text, `pair-secret-mission:${dates.join(':')}`);
  }
  function deleteSide(side) {
    validSide(side);
    const { state } = load();
    const removed = state.days.length;
    state.days = [];
    save(state);
    return { removed };
  }
  return { handle, takePending, tick, deleteSide };
}
module.exports = { MISSIONS, createPairSecretMissionStore };
