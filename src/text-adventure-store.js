'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { REFUSAL } = require('./text-adventure-commands');
const { validateAdventure } = require('./text-adventure-provider');
const MAX_ROUNDS = 6;
const MAX_HP = 3;
const EFFECTS = Object.freeze({
  1: Object.freeze({ hp: -1, clues: 2, label: '冒险搜寻：生命 -1，线索 +2' }),
  2: Object.freeze({ hp: 0, clues: 1, label: '谨慎调查：线索 +1' }),
  3: Object.freeze({ hp: 1, clues: 0, label: '休整：生命 +1（上限 3）' }),
});
const status = s => `已行动 ${s.rounds}/${MAX_ROUNDS} 轮｜生命 ${s.hp}/${MAX_HP}｜线索 ${s.clues}`;
function advance(current, choice) {
  const effect = EFFECTS[choice];
  const next = { ...current, rounds: current.rounds + 1, hp: Math.max(0, Math.min(MAX_HP, current.hp + effect.hp)),
    clues: current.clues + effect.clues,
    history: [...current.history, { round: current.rounds + 1, choice, action: current.options[choice - 1] }].slice(-MAX_ROUNDS) };
  next.terminal = next.hp === 0 ? '生命耗尽，冒险失败' : next.clues >= 6 ? '收集六条线索，冒险成功'
    : next.rounds >= MAX_ROUNDS ? '已达六轮上限，冒险结束' : '';
  return next;
}
function createTextAdventureStore({ provider, readCard }) {
  // Same convention as story-chain: one volatile bound-owner session, no new session keys.
  let session = null, epoch = 0, queuedStarts = 0;
  let pending = Promise.resolve();
  const claimsAnswer = side => side === 'owner' && (session !== null || queuedStarts > 0);
  async function apply(command) {
    const generation = epoch;
    if (command.type === 'start') {
      if (session) return refused('已有进行中的冒险，请先发送“结束冒险”，不会覆盖旧局。');
      let setting = '一位虚构探险者探索失落城堡';
      if (command.cardName) {
        try {
          const card = await readCard(command.cardName);
          if (generation !== epoch) return null;
          if (!card || card.continue !== true) return refused(card?.reply || '角色卡不存在，无法开始冒险。');
          setting = card.reply; // Read-only snapshot; never call card mutations or story start.
        } catch { return refused('角色卡读取失败，未开始冒险，请恢复角色卡存储后再试。'); }
      }
      session = { setting, summary: '', hp: MAX_HP, clues: 0, rounds: 0, history: [], options: [], terminal: '' };
    }
    if (!session) return unchanged('当前没有进行中的冒险，请发送“开始冒险”或“开始冒险：角色卡名”。');
    const current = session;
    const opening = current.options.length === 0;
    if (command.type === 'retry' && !opening) return unchanged('请选择 1、2 或 3，或发送“结束冒险”。');
    const next = opening ? { ...current } : advance(current, command.choice);
    // Local terminal transitions always clear, including when the ending model fails.
    if (next.terminal) session = null;
    const admitted = epoch;
    try {
      const output = validateAdventure(await provider.generate(structuredClone(next)), !!next.terminal);
      if (epoch !== admitted || (!next.terminal && session !== current)) return null;
      if (!next.terminal) session = { ...next, summary: output.summary, options: output.options };
      return changed(`${output.narrative}\n\n${status(next)}\n${next.terminal
        ? `${next.terminal}，临时会话已清除。`
        : output.options.map((v, i) => `${i + 1}. ${v}（${EFFECTS[i + 1].label}）`).join('\n') + '\n回复 1/2/3，或“结束冒险”。'}`);
    } catch {
      if (epoch !== admitted || (!next.terminal && session !== current)) return null;
      return refused(next.terminal ? `冒险结局模型生成失败。${status(next)}；${next.terminal}，临时会话已清除。`
        : `冒险${opening ? '开场' : '续写'}模型生成失败；会话及数值已保留，未计本次行动。请${opening ? '发送“冒险继续”重试开场' : '重发原选项重试'}，或发送“结束冒险”。`);
    }
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused(REFUSAL));
    if (!command || !['start', 'choose', 'retry', 'end'].includes(command.type)
      || command.type === 'choose' && ![1, 2, 3].includes(command.choice)) {
      return Promise.resolve(refused('请用“开始冒险：角色卡名”（卡名可省略）、“冒险选择 1/2/3”或“结束冒险”。'));
    }
    if (command.type === 'end') {
      session = null; epoch++; queuedStarts = 0;
      return Promise.resolve(changed('冒险已结束，临时会话已清除。'));
    }
    const starting = command.type === 'start';
    if (starting && claimsAnswer(side)) return Promise.resolve(refused('已有进行中的冒险，请先发送“结束冒险”，不会覆盖旧局。'));
    if (starting) queuedStarts++;
    const admitted = epoch;
    const result = pending.then(() => admitted === epoch ? apply(command) : null)
      .finally(() => { if (starting && admitted === epoch) queuedStarts--; });
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}
module.exports = { createTextAdventureStore, advance, EFFECTS, MAX_ROUNDS };
