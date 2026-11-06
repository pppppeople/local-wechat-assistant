'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { shanghaiDay } = require('./personal-todo-commands');
const { validDay } = require('./surprise-countdown-commands');

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.questions)) throw new Error('未来题存储格式无效');
  const ids = new Set();
  for (const item of state.questions) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id) || ids.has(item.id)
      || typeof item.question !== 'string' || !item.question.trim()
      || typeof item.answer !== 'string' || !item.answer.trim() || !validDay(item.date)
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || !['sealed', 'pending', 'closed'].includes(item.status)
      || (item.status !== 'sealed' && !Number.isFinite(Date.parse(item.askedAt)))
      || (item.status === 'closed' && (typeof item.todayAnswer !== 'string' || !item.todayAnswer.trim()
        || !Number.isFinite(Date.parse(item.closedAt))))) throw new Error('未来题记录格式无效');
    ids.add(item.id);
  }
}

function createFutureQuestionStore({ stateFile, now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, questions: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['questions']); };
  const example = '例如「给未来的我出题：最近最在意什么？｜我的答案：多休息｜明天」。';
  const unopened = (item, today) => item.status === 'sealed' && item.date > today;
  function handle(side, command) {
    if (side !== 'owner') return '给未来的自己出题仅主人可用。';
    if (!command || command.type === 'invalid') return `没有执行未来题操作：请写完整问题、答案和将来的上海日期。${example}`;
    const today = shanghaiDay(now());
    const state = load();
    if (command.type === 'create') {
      if (typeof command.question !== 'string' || !command.question.trim()
        || typeof command.answer !== 'string' || !command.answer.trim()
        || !validDay(command.date) || command.date <= today) {
        return `没有封存未来题：问题、答案不能为空，日期必须是将来的上海日期。${example}`;
      }
      const question = command.question.trim();
      state.questions.push({ id: crypto.randomUUID(), question, answer: command.answer.trim(), date: command.date,
        createdAt: new Date(now()).toISOString(), status: 'sealed' });
      save(state);
      return `已封存未来题：${question}，${command.date}（Asia/Shanghai）。`;
    }
    if (command.type === 'list') {
      const items = state.questions.filter(item => unopened(item, today)).sort((a, b) => a.date.localeCompare(b.date));
      return items.length ? `未来的题：\n${items.map(item => `${item.question}，${item.date}`).join('\n')}` : '暂无未到期的未来题。';
    }
    if (command.type === 'cancel') {
      if (typeof command.text !== 'string' || !command.text.trim()) return '请写明要取消的问题关键词。';
      const items = state.questions.filter(item => unopened(item, today) && item.question.includes(command.text.trim()));
      if (!items.length) return '没有找到匹配的未到期未来题。';
      if (items.length > 1) return '匹配到多道未到期未来题，请把问题关键词说得更具体。';
      state.questions = state.questions.filter(item => item.id !== items[0].id); save(state);
      return `已取消未来题：${items[0].question}。`;
    }
    if (command.type !== 'answer') throw new Error('不支持的未来题命令');
    const item = state.questions.filter(question => question.status === 'pending')
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt))[0];
    if (!item) return '暂无待回答的未来题。';
    if (typeof command.text !== 'string' || !command.text.trim()) return '请写下今天的答案，例如「未来题回答：现在更在意健康」。';
    item.todayAnswer = command.text.trim(); item.status = 'closed'; item.closedAt = new Date(now()).toISOString();
    save(state);
    return `未来题揭晓：${item.question}\n当初封存的答案：${item.answer}\n今天的答案：${item.todayAnswer}\n请你自己看看，这段时间有哪些变化。`;
  }
  async function tick(deliver) {
    const state = load();
    const today = shanghaiDay(now());
    const item = state.questions.find(question => question.status === 'sealed' && question.date === today);
    if (!item) return false;
    // Persist before dispatch: overlapping scans/restarts/failures never retry this question.
    item.status = 'pending'; item.askedAt = new Date(now()).toISOString(); save(state);
    await deliver(`今天可以回答这道题了：${item.question}（请回复「未来题回答：<你的答案>」）`,
      `future-question-${item.id}-${item.date}`);
    return true;
  }
  return { handle, tick };
}

module.exports = { createFutureQuestionStore };
