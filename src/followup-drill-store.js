'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { REFUSAL } = require('./followup-drill-commands');
const { validateQuestion, validateEvaluation } = require('./followup-drill-provider');
const MAX_ROUNDS = 3;
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
function createFollowupDrillStore({ provider }) {
  // One independent volatile session; no files, favorites, history or specialist reads.
  let session = null;
  let generation = 0;
  let pending = Promise.resolve();
  function claimsAnswer(side) { return side === 'owner' && session !== null; }
  async function apply(command) {
    if (command.type === 'start') {
      if (!nonempty(command.scene)) return refused('场景不能为空，请发送“追问训练：<场景>”。');
      if (session) return refused('已有追问训练在进行，请先发送“结束追问”再开始新训练。');
      session = { scene: command.scene.trim(), question: '', turns: [] };
    }
    if (!session) return unchanged('当前没有追问训练在进行，请发送“追问训练：<场景>”开始。');
    const current = session;
    if (current.question && !nonempty(command.text)) return refused('请用文字回答，或发送“结束追问”。');
    // Commit a reply only when the next question succeeds, so a failed round can be retried.
    const turns = current.turns.map(turn => ({ ...turn }));
    if (current.question) turns.push({ question: current.question, answer: command.text.trim() });
    if (turns.length === MAX_ROUNDS) {
      try {
        const evaluation = validateEvaluation(await provider.evaluate({ scene: current.scene, turns }));
        if (session !== current) return null;
        session = null;
        return changed(`表达清晰度：\n${evaluation.clarity}\n\n未回应问题：\n${evaluation.unanswered}\n\n推荐表达：\n${evaluation.recommended}\n\n追问训练已结束，临时状态已清除。`);
      } catch {
        if (session !== current) return null;
        session = null;
        return refused('这次模型终局评价失败，未生成评价；追问训练已结束，临时状态已清除。可重新发送“追问训练：<场景>”开始。');
      }
    }
    try {
      const next = validateQuestion(await provider.next({ scene: current.scene, turns, round: turns.length + 1 }));
      if (session !== current) return null;
      current.turns = turns;
      current.question = next.question;
      return changed(`第 ${turns.length + 1}/${MAX_ROUNDS} 轮追问：\n${next.question}`);
    } catch {
      if (session !== current) return null;
      return refused(current.question
        ? '这次模型追问失败，会话已保留、轮次未增加；请重发本轮回答重试，或发送“结束追问”。'
        : '这次模型追问失败，会话已保留；请发送文字重试首轮追问，或发送“结束追问”。');
    }
  }
  function execute(side, command) {
    // Admission precedes reading session state or scheduling a model call.
    if (side !== 'owner') return Promise.resolve(refused(REFUSAL));
    if (!command || !['start', 'answer', 'end'].includes(command.type)) return Promise.resolve(refused('不支持这个追问训练操作。'));
    // End works during generation, and invalidates both late results and queued answers.
    if (command.type === 'end') {
      const active = session !== null;
      session = null;
      generation++;
      return Promise.resolve(active ? changed('追问训练已结束，临时状态已清除。') : unchanged('当前没有追问训练在进行。'));
    }
    const admitted = generation;
    const result = pending.then(() => admitted === generation ? apply(command) : null);
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}

module.exports = { createFollowupDrillStore };
