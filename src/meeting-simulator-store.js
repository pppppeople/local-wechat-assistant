'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { validateOpening, validateTurn, validateSummary } = require('./meeting-simulator-provider');
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const MAX_TURNS = 5;
function createMeetingSimulatorStore({ provider }) {
  // One volatile session; no ordinary history, files or long-term learning.
  let session = null;
  let expressionCache = null;
  let nextExpressionNumber = 1;
  let hadSummary = false;
  let pending = Promise.resolve();
  function claimsAnswer(side) { return side === 'owner' && session !== null; }
  function data(current, includeFailed = false) {
    const turns = current.turns.map(turn => ({ ...turn }));
    if (includeFailed && current.failedAnswer) turns.push({ question: current.question,
      answer: current.failedAnswer, advice: '' });
    return { scene: current.scene, role: current.role, turns };
  }
  async function close(current) {
    try {
      const closingData = data(current, true);
      const summary = validateSummary(await provider.summarize(closingData), closingData);
      expressionCache = summary.comparisons.map(item => ({ number: nextExpressionNumber++,
        original: item.original, suggested: item.suggested, scene: current.scene }));
      hadSummary = true;
      session = null;
      const issues = summary.issues.map(item => `- ${item}`).join('\n') || '暂无可归纳的表达问题。';
      const comparisons = expressionCache.map(item => `${item.number}. ${item.original} → ${item.suggested}`).join('\n') || '暂无建议说法对照。';
      return changed(`${current.closingAdvice ? `中文表达建议：${current.closingAdvice}\n\n` : ''}本场场景：${current.scene}\n常见表达问题清单：\n${issues}\n建议说法对照（原句→建议句）：\n${comparisons}\n\n模拟已结束，临时状态已清除。`);
    } catch {
      return refused('这次模型总结失败，会话已保留；请发送“结束模拟”重试总结。');
    }
  }
  async function apply(command) {
    if (command.type === 'start') {
      if (session) return refused('当前有进行中的会议模拟，请先发送“结束模拟”再开启。');
      if (!nonempty(command.scene)) return refused('请发送“模拟会议：<场景>”或“模拟英文会议：<场景>”开启。');
      expressionCache = null;
      session = { scene: command.scene.trim(), role: '', stage: 'opening', turns: [] };
    }
    if (!session) return unchanged('当前没有进行中的会议模拟，请发送“模拟会议：<场景>”开启。');
    const current = session;
    if (command.type === 'end' || current.stage === 'closing') {
      current.stage = 'closing';
      return close(current);
    }
    if (current.stage === 'opening') {
      try {
        const opening = validateOpening(await provider.open({ scene: current.scene }));
        current.role = opening.role;
        current.stage = 'answer';
        current.question = opening.question;
        return changed(`对方角色：${opening.role}\n${opening.question}\n\n本轮练习：${opening.practice}`);
      } catch {
        return refused('这次模型开场失败，会话已保留；请发送文字重试开场，或发送“结束模拟”。');
      }
    }
    if (!nonempty(command.text)) return refused('请用文字回答，或发送“结束模拟”。');
    try {
      const final = current.turns.length + 1 === MAX_TURNS;
      const turn = validateTurn(await provider.turn({ ...data(current), question: current.question,
        answer: command.text, final }), final);
      current.failedAnswer = '';
      current.turns.push({ question: current.question, answer: command.text, advice: turn.advice });
      if (final) {
        current.stage = 'closing';
        current.closingAdvice = turn.advice;
        return close(current);
      }
      current.question = turn.question;
      return changed(`${turn.question}\n\n中文表达建议：${turn.advice}`);
    } catch {
      current.failedAnswer = command.text;
      return refused('这次模型追问失败，会话已保留、轮次未增加；请重发本轮回答重试，或发送“结束模拟”。');
    }
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command || !['start', 'answer', 'end'].includes(command.type)) return Promise.resolve(refused('不支持这个会议模拟操作。'));
    const result = pending.then(() => apply(command));
    pending = result.catch(() => {});
    return result;
  }
  function getExpression(side, number) {
    if (side !== 'owner') return { reply: '这个私人助手只供已绑定的本人使用。' };
    if (!expressionCache) return { reply: hadSummary
      ? '总结缓存已过期，新一轮模拟已取代旧总结；请结束当前模拟后按新总结序号收藏。'
      : '没有可用的内存总结缓存，请先完成一次会议模拟；重启后不能复用旧总结。' };
    const entry = expressionCache.find(item => item.number === number);
    if (!entry) return { reply: number > 0 && number < nextExpressionNumber
      ? '这个序号所属的总结缓存已过期，请使用最近一次总结显示的序号。'
      : '序号越界，不属于当前总结缓存；请使用最近一次总结显示的序号。' };
    return { entry: { original: entry.original, suggested: entry.suggested, scene: entry.scene } };
  }
  return { execute, claimsAnswer, getExpression };
}

module.exports = { createMeetingSimulatorStore };
