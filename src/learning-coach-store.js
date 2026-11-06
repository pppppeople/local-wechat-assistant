'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const TTL = 2 * 60 * 60 * 1000;
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = value => typeof value === 'string' && /^[a-z0-9_-]+$/iu.test(value);
function validQuestion(q) {
  return q && text(q.question) && text(q.explanation) && /^[A-D]$/u.test(q.answer)
    && q.options && Object.keys(q.options).sort().join('') === 'ABCD'
    && Object.values(q.options).every(text) && new Set(Object.values(q.options)).size === 4;
}
function validateState(state) {
  const sessions = state?.sessions;
  const mistakes = state?.mistakes;
  if (state?.schemaVersion !== 1 || !Array.isArray(sessions) || sessions.length > 1
    || !Array.isArray(mistakes) || mistakes.length > 50
    || mistakes.some(q => !validQuestion(q) || !id(q.id) || !text(q.topic) || !date(q.createdAt)
      || !Number.isSafeInteger(q.errors) || q.errors < 1)
    || new Set(mistakes.map(q => q.id)).size !== mistakes.length
    || sessions.some(s => !id(s.id) || !date(s.createdAt) || !date(s.lastActivityAt)
      || !['quiz', 'retry'].includes(s.mode) || !Array.isArray(s.questions)
      || s.questions.length < 1 || s.questions.length > (s.mode === 'retry' ? 50 : 10)
      || s.questions.some(q => !validQuestion(q) || !id(q.id) || !text(q.topic))
      || new Set(s.questions.map(q => q.id)).size !== s.questions.length
      || !Number.isInteger(s.index) || s.index < 0 || s.index >= s.questions.length
      || !Number.isInteger(s.correct) || s.correct < 0 || s.correct > s.index)) {
    throw new Error('碎片学习存储格式无效');
  }
}
function questionText(session) {
  const q = session.questions[session.index];
  return `第 ${session.index + 1}/${session.questions.length} 题（${q.topic}）\n${q.question}\n`
    + ['A', 'B', 'C', 'D'].map(key => `${key}. ${q.options[key]}`).join('\n');
}
function summary(s, ended = false) {
  return `${ended ? '练习已结束' : '练习完成'}：对 ${s.correct}/${s.questions.length}，已答 ${s.index}/${s.questions.length} 题。`;
}
function createLearningCoachStore({ stateFile, provider, now = () => Date.now() }) {
  let pending = Promise.resolve();
  function load(readOnly = false) {
    return readRecordState(stateFile, { schemaVersion: 1, sessions: [], mistakes: [] }, true,
      { strict: true, readOnly, now, validate: validateState });
  }
  function save(state) {
    validateState(state);
    writeRecordState(stateFile, state, ['sessions', 'mistakes']);
  }
  function expire(state) {
    if (state.sessions[0] && now() - Date.parse(state.sessions[0].lastActivityAt) > TTL) {
      state.sessions = [];
      save(state);
    }
  }
  function claimsAnswer(side) {
    if (side !== 'owner') return false;
    // Admission must not quarantine first: execution owns the explicit failure reply.
    const state = load(true);
    expire(state);
    return state.sessions.length > 0;
  }
  async function apply(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['start', 'answer', 'end', 'mistakes', 'retry'].includes(command.type)) {
      return refused('不支持这个碎片学习操作。');
    }
    const state = load();
    expire(state);
    const session = state.sessions[0];
    if (command.type === 'mistakes') {
      return unchanged(state.mistakes.length ? state.mistakes.map((q, i) =>
        `${i + 1}. ${q.topic}：${q.question.slice(0, 60)}${q.question.length > 60 ? '…' : ''}（错 ${q.errors} 次）`).join('\n') : '暂无错题。');
    }
    if (command.type === 'end') {
      if (!session) return unchanged('当前没有进行中的练习。');
      state.sessions = [];
      save(state);
      return changed(summary(session, true));
    }
    if (command.type === 'answer') {
      if (!session || !/^[A-D]$/u.test(command.answer)) return null;
      const q = session.questions[session.index];
      const correct = command.answer === q.answer;
      const old = state.mistakes.find(item => item.id === q.id);
      if (correct) {
        session.correct++;
        if (session.mode === 'retry') state.mistakes = state.mistakes.filter(item => item.id !== q.id);
      } else if (old) old.errors++;
      else {
        state.mistakes.push({ ...q, errors: 1, createdAt: new Date(now()).toISOString() });
        state.mistakes = state.mistakes.slice(-50);
      }
      session.index++;
      session.lastActivityAt = new Date(now()).toISOString();
      const finished = session.index === session.questions.length;
      const reply = `${correct ? '答对了' : `答错了，正确答案是 ${q.answer}`}。\n解析：${q.explanation}\n\n`
        + (finished ? summary(session) : questionText(session));
      if (finished) state.sessions = [];
      save(state);
      return changed(reply);
    }
    if (session) return refused(`当前练习已答 ${session.index}/${session.questions.length} 题，请先发送“结束练习”再开局。`);
    let questions;
    if (command.type === 'retry') {
      if (!state.mistakes.length) return unchanged('暂无错题可重练。');
      questions = state.mistakes.map(q => ({ ...q, options: { ...q.options } }));
    } else {
      if (!text(command.topic) || !Number.isInteger(command.count) || command.count < 1 || command.count > 10) {
        return refused('请用“考我N道<主题>题”，N 为 1–10，省略时为 3。');
      }
      try {
        const generated = await provider.generateQuiz({ topic: command.topic, count: command.count });
        if (!Array.isArray(generated) || generated.length !== command.count || !generated.every(validQuestion)) throw Error('invalid quiz');
        questions = generated.map(q => ({ id: crypto.randomUUID(), topic: command.topic,
          question: q.question, options: { ...q.options }, answer: q.answer, explanation: q.explanation }));
      } catch {
        return refused('这次没生成成功，请稍后重新开局；未创建练习会话。');
      }
    }
    const timestamp = new Date(now()).toISOString();
    const created = { id: crypto.randomUUID(), mode: command.type === 'retry' ? 'retry' : 'quiz',
      questions, index: 0, correct: 0, createdAt: timestamp, lastActivityAt: timestamp };
    state.sessions = [created];
    save(state);
    return changed(questionText(created));
  }
  // Generation is asynchronous; serialize mutations so concurrent starts cannot overwrite a game.
  function execute(side, command) {
    const result = pending.then(() => apply(side, command));
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}
module.exports = { createLearningCoachStore };
