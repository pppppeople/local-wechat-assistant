'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { validateQuestions, validateSummary } = require('./reverse-interview-provider');
const text = value => typeof value === 'string' && Boolean(value.trim());
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.sessions) || state.sessions.length > 1) throw Error('提问存储格式无效');
  for (const s of state.sessions) {
    validateQuestions({ questions: s.questions });
    if (!/^[a-z0-9_-]+$/iu.test(s.id) || !text(s.topic) || !Number.isFinite(Date.parse(s.createdAt))
      || !['asking', 'summary_pending', 'completed'].includes(s.phase)
      || !Number.isInteger(s.index) || s.index < 0 || s.index > s.questions.length
      || (s.phase === 'asking' && s.index === s.questions.length)
      || !Array.isArray(s.answers) || s.answers.length !== s.index
      || s.answers.some(a => !a || !['answered', 'skipped'].includes(a.status)
        || typeof a.text !== 'string' || (a.status === 'answered' ? !text(a.text) : a.text !== ''))
      || (s.phase !== 'completed' && s.summary !== null)) throw Error('提问存储格式无效');
    if (s.phase === 'completed') validateSummary(s.summary);
  }
}
function renderQuestion(s) {
  return `反向提问 第 ${s.index + 1}/${s.questions.length} 题\n${s.questions[s.index]}\n\n可回复「跳过」「结束提问」或「放弃提问」。`;
}
function createReverseInterviewStore({ stateFile, provider, now = () => Date.now() }) {
  let pending = Promise.resolve();
  let queuedStarts = 0;
  const load = (readOnly = false) => readRecordState(stateFile, { schemaVersion: 1, sessions: [] }, true,
    { strict: true, readOnly, now, validate: validateState });
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['sessions']); }
  function claimsAnswer(side) {
    if (side !== 'owner') return false;
    return queuedStarts > 0 || Boolean(load(true).sessions.some(s => s.phase !== 'completed'));
  }
  async function summarize(state, s) {
    s.phase = 'summary_pending';
    save(state); // Keep originals if generation fails or the process stops.
    try { s.summary = validateSummary(await provider.summarize({ topic: s.topic, questions: s.questions, answers: s.answers })); }
    catch { return unchanged('小结这次没有生成成功，问答原文已保留。可回复「结束提问」重试，或「放弃提问」。'); }
    s.phase = 'completed';
    save(state);
    return changed(`已明确\n${s.summary.clarified}\n\n仍不确定\n${s.summary.uncertain}\n\n下一步\n${s.summary.nextSteps}`);
  }
  async function apply(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command) return null;
    const state = load();
    const s = state.sessions[0];
    if (command.type === 'discard') {
      if (!s) return unchanged('当前没有提问会话。');
      state.sessions = []; save(state);
      return changed('已放弃提问，本场内容已丢弃。');
    }
    if (command.type === 'save_card') {
      return refused(s?.phase === 'completed'
        ? '暂不支持将本场存成卡片：现有聊天存档卡没有可复用的指定问答落卡入口。'
        : '请先完成提问小结。');
    }
    if (command.type === 'start') {
      if (s && s.phase !== 'completed') return refused('已有进行中的反向提问，请先「结束提问」或「放弃提问」再开一场。');
      if (!text(command.topic)) return refused('请发送「反过来问我：<待决定的问题>」。');
      // A new attempt replaces the latest completed session, never ordinary chat.
      if (s) { state.sessions = []; save(state); }
      let questions;
      try { questions = validateQuestions(await provider.generate({ topic: command.topic })).questions; }
      catch { return refused('这次没生成出问题，可以再试一次'); }
      const created = { id: crypto.randomUUID(), createdAt: new Date(now()).toISOString(), topic: command.topic,
        questions, index: 0, answers: [], phase: 'asking', summary: null };
      state.sessions = [created]; save(state);
      return changed(renderQuestion(created));
    }
    if (!s || s.phase === 'completed') return unchanged('当前没有进行中的反向提问。');
    if (command.type === 'end') return summarize(state, s);
    if (s.phase === 'summary_pending') return unchanged('问答已结束，请回复「结束提问」重试小结，或「放弃提问」。');
    if (command.type !== 'answer' && command.type !== 'skip') return refused('不支持这个提问操作。');
    if (command.type === 'answer' && !text(command.answer)) return unchanged(renderQuestion(s));
    s.answers.push({ status: command.type === 'skip' ? 'skipped' : 'answered', text: command.type === 'skip' ? '' : command.answer });
    s.index++;
    if (s.index === s.questions.length) return summarize(state, s);
    save(state);
    return changed(renderQuestion(s));
  }
  function execute(side, command) {
    // Claim immediately: a poll batch can dispatch the next text before this promise starts.
    const starting = side === 'owner' && command?.type === 'start';
    if (starting) queuedStarts++;
    const result = pending.then(() => apply(side, command)).finally(() => { if (starting) queuedStarts--; });
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}
module.exports = { createReverseInterviewStore };
