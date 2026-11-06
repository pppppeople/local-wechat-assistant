'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const SIDES = ['owner', 'friend'];
const peer = side => side === 'owner' ? 'friend' : 'owner';
const validSide = side => { if (!SIDES.includes(side)) throw new Error('invalid date turn side'); };
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const HELP = '请用「发起出行轮值：周末出行 主人先选」（或「好友先选」），主题须为 1–500 字。查看用「出行轮到谁」「出行轮值状态」「出行轮值历史」；完成须带轮次，如「出行轮值完成 1」；回退用「撤销出行轮值完成」。';
function validate(state) {
  const fail = () => { throw new Error('出行轮值存储格式无效'); };
  if (state?.schemaVersion !== 1 || !Array.isArray(state.turns) || state.turns.length > 1) fail();
  for (const turn of state.turns) {
    if (!turn || typeof turn.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(turn.id)
      || typeof turn.binding !== 'string' || !turn.binding || typeof turn.text !== 'string'
      || !turn.text.trim() || turn.text.length > 500 || !date(turn.createdAt)
      || !SIDES.includes(turn.createdBy) || !SIDES.includes(turn.first) || !SIDES.includes(turn.current)
      || turn.status !== 'pending' || !Array.isArray(turn.history)
      || turn.round !== turn.history.length + 1) fail();
    let selected = turn.first;
    for (const [i, entry] of turn.history.entries()) {
      if (!entry || entry.round !== i + 1 || entry.picker !== selected || entry.status !== 'completed'
        || !SIDES.includes(entry.completedBy) || !date(entry.completedAt)) fail();
      selected = peer(selected);
    }
    if (turn.current !== selected) fail();
  }
}

function createPairDateTurnStore({ stateFile, getBinding, now = () => Date.now(), sideNames = { owner: '主人', friend: '好友' } }) {
  const empty = () => ({ schemaVersion: 1, turns: [] });
  const load = () => readRecordState(stateFile, empty(), true, { strict: true, now, validate });
  function save(state) { validate(state); writeRecordState(stateFile, state, ['turns']); }
  function binding() {
    const value = getBinding();
    if (typeof value !== 'string' || !value) throw new Error('配对尚未绑定');
    return value;
  }
  const current = turn => `主题：${turn.text}\n第 ${turn.round} 轮（待选），当前轮到${sideNames[turn.current]}。完成请用「出行轮值完成 ${turn.round}」。`;
  const history = turn => turn.history.length ? ['完成历史：', ...turn.history.map(entry =>
    `第 ${entry.round} 轮：${sideNames[entry.picker]}已选定（已完成）；${sideNames[entry.completedBy]}标记，${entry.completedAt}。`)].join('\n') : '暂无完成历史。';
  function handle(side, command) {
    validSide(side);
    const bound = binding();
    if (!command || !['start', 'current', 'status', 'history', 'complete', 'undo', 'help'].includes(command.type)) throw new Error('不支持的出行轮值命令');
    if (command.type === 'help') return HELP;
    if (command.type === 'start' && (typeof command.text !== 'string' || !command.text.trim()
      || command.text.length > 500 || /[\r\n]/u.test(command.text) || !SIDES.includes(command.first))) return HELP;
    if (command.type === 'complete' && (!Number.isSafeInteger(command.round) || command.round <= 0)) return HELP;
    const state = load();
    let turn = state.turns[0];
    if (turn && turn.binding !== bound) throw new Error('出行轮值配对绑定已变化，请人工处理旧状态');
    if (command.type === 'start') {
      if (turn) return `已有出行轮值，不会覆盖主题或历史。\n${current(turn)}`;
      turn = { id: crypto.randomUUID(), binding: bound, text: command.text.trim(), first: command.first,
        current: command.first, round: 1, status: 'pending', createdBy: side, createdAt: new Date(now()).toISOString(), history: [] };
      state.turns.push(turn); save(state);
      return `已发起出行轮值。\n${current(turn)}\n未向对方发消息或邀请。`;
    }
    if (!turn) return '还没有出行轮值。' + HELP;
    if (command.type === 'current') return current(turn);
    if (command.type === 'status' || command.type === 'history') return `${current(turn)}\n${history(turn)}`;
    if (command.type === 'undo') {
      const last = turn.history.pop();
      if (!last) return `没有可撤销的完成记录，未回退。\n${current(turn)}`;
      turn.round = last.round; turn.current = last.picker;
      save(state);
      return `已撤销第 ${last.round} 轮完成，历史已回退。\n${current(turn)}`;
    }
    if (command.round < turn.round) return `第 ${command.round} 轮已完成，不会重复推进或记历史。\n${current(turn)}`;
    if (command.round !== turn.round) return `轮次不匹配，本次未完成。\n${current(turn)}`;
    turn.history.push({ round: turn.round, picker: turn.current, status: 'completed', completedBy: side, completedAt: new Date(now()).toISOString() });
    turn.round += 1; turn.current = peer(turn.current);
    save(state);
    return `第 ${command.round} 轮已选定（已完成）。\n${current(turn)}\n未向对方发消息或邀请。`;
  }
  function deleteSide(side) {
    validSide(side);
    const state = load(); save(empty());
    return { removed: state.turns.length };
  }
  return { handle, deleteSide };
}
module.exports = { createPairDateTurnStore };
