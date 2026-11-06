'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { validateFeedback, validateSummary } = require('./feynman-coach-provider');
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
function createFeynmanCoachStore({ provider }) {
  // Deliberately volatile: only one active session, no records or mistake book.
  let session = null;
  let generation = 0;
  let pending = Promise.resolve();
  function claimsAnswer(side) { return side === 'owner' && session !== null; }
  async function apply(command) {
    if (command.type === 'start') {
      if (session) return refused('当前有进行中的费曼会话，请先发送“结束费曼”再开启。');
      if (!nonempty(command.topic)) return refused('请发送“费曼：<主题>”或“费曼模式：<主题>”开启。');
      session = { topic: command.topic.trim(), stage: 'explanation', explanation: '' };
      return changed(`请用自己的话讲一遍 ${session.topic}，尽量不用术语。`);
    }
    if (!session) return unchanged('当前没有进行中的费曼会话，请发送“费曼：<主题>”开启。');
    if (!nonempty(command.text)) return refused('请发一段文字，或发送“结束费曼”。');
    const current = session;
    if (current.stage === 'explanation') {
      current.explanation = command.text;
      try {
        const feedback = validateFeedback(await provider.feedback({ topic: current.topic, explanation: current.explanation }));
        if (session !== current) return null;
        current.stage = 'followup';
        return changed(`讲清楚了什么：${feedback.clear}\n含糊或可能有误的地方：${feedback.uncertain}\n一个类比或例子建议：${feedback.example}\n\n追问：${feedback.question}`);
      } catch {
        if (session !== current) return null;
        return refused('这次模型反馈失败，会话和讲解已保留；请重发讲解重试，或发送“结束费曼”。');
      }
    }
    try {
      const summary = validateSummary(await provider.summarize({ topic: current.topic,
        explanation: current.explanation, answer: command.text }));
      if (session !== current) return null;
      session = null;
      return changed(`${summary.mastery}；建议下一步：${summary.nextStep}`);
    } catch {
      if (session !== current) return null;
      return refused('这次模型收尾失败，会话和讲解已保留；请重发追问回答重试，或发送“结束费曼”。');
    }
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command || !['start', 'answer', 'end'].includes(command.type)) {
      return Promise.resolve(refused('不支持这个费曼操作。'));
    }
    // End is immediate, including while a model call is pending. Stale output is discarded.
    if (command.type === 'end') {
      const active = session !== null;
      session = null;
      generation++;
      return Promise.resolve(active ? changed('费曼会话已结束，临时状态已清除。') : unchanged('当前没有进行中的费曼会话。'));
    }
    const admitted = generation;
    const result = pending.then(() => admitted === generation ? apply(command) : null);
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}

module.exports = { createFeynmanCoachStore };
