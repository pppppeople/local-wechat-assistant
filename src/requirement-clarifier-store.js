'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { QUESTIONS, uncertain, renderDocument } = require('./requirement-clarifier-provider');
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
function question(session) {
  return `需求澄清 第 ${session.answers.length + 1}/4 问\n${QUESTIONS[session.answers.length]}\n\n可回复「跳过」，或「结束澄清」中止。`;
}
function createRequirementClarifierStore({ provider }) {
  // Volatile state only: no document, task, ordinary history or memory writes.
  let session = null;
  let pending = Promise.resolve();
  let queuedStarts = 0;
  let epoch = 0;
  const claimsAnswer = side => side === 'owner' && (session !== null || queuedStarts > 0);
  async function summarize(current) {
    current.phase = 'summary_pending';
    try {
      const data = { requirement: current.requirement, questions: [...QUESTIONS], answers: current.answers.map(a => ({ ...a })) };
      const result = await provider.summarize(data);
      if (session !== current) return null; // End during generation suppresses stale output.
      const reply = renderDocument(result, data);
      session = null;
      return changed(reply);
    } catch {
      if (session !== current) return null;
      return refused('需求文档生成失败，会话已保留。请回复「重试」再次整理，或「结束澄清」中止。');
    }
  }
  async function apply(command) {
    if (command.type === 'start') {
      if (session) return refused('已有进行中的需求澄清，请先「结束澄清」再开启。');
      if (!nonempty(command.requirement)) return refused('请发送「澄清需求：<一句话需求>」或「帮我澄清这个需求：<需求>」。');
      session = { requirement: command.requirement, answers: [], phase: 'asking' };
      return changed(question(session));
    }
    if (!session) return unchanged('当前没有进行中的需求澄清。');
    if (session.phase === 'summary_pending') {
      return command.type === 'retry' ? summarize(session)
        : unchanged('四问已结束，请回复「重试」整理文档，或「结束澄清」中止。');
    }
    if (command.type === 'retry' || (command.type === 'answer' && !nonempty(command.answer))) return unchanged(question(session));
    if (!['answer', 'skip'].includes(command.type)) return refused('不支持这个澄清操作。');
    const text = command.type === 'skip' ? '' : command.answer;
    session.answers.push({ status: !nonempty(text) || uncertain(text) ? 'pending' : 'answered', text });
    return session.answers.length === 4 ? summarize(session) : changed(question(session));
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command) return Promise.resolve(null);
    // Cancellation is immediate even while a model is outstanding; queued work is invalidated.
    if (command.type === 'end') {
      session = null; epoch++; queuedStarts = 0;
      return Promise.resolve(changed('已结束澄清，会话状态已清除，未产出文档。'));
    }
    const starting = command.type === 'start';
    if (starting && claimsAnswer(side)) return Promise.resolve(refused('已有进行中的需求澄清，请先「结束澄清」再开启。'));
    if (starting) queuedStarts++;
    const generation = epoch;
    const result = pending.then(() => generation === epoch ? apply(command) : null)
      .finally(() => { if (starting && generation === epoch) queuedStarts--; });
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}

module.exports = { createRequirementClarifierStore };
