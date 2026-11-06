'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { REFUSAL } = require('./detective-game-commands');
const { validateCase } = require('./detective-game-provider');
const normalizeAnswer = value => String(value || '').normalize('NFKC').trim().toLowerCase();
const NO_SESSION = '当前没有进行中的桌游，请发送“桌游主持”或“开始桌游”。';
const ALREADY_ACTIVE = '已有进行中的桌游，请先发送“结束桌游”或“答案：<推断>”，不会覆盖当前案件。';
function createDetectiveGameStore({ provider }) {
  // One independent volatile owner session; no filesystem or other feature data.
  let session = null, epoch = 0, queuedStarts = 0;
  let pending = Promise.resolve();
  const claimsAnswer = side => side === 'owner' && (session !== null || queuedStarts > 0);
  async function apply(command, admitted) {
    if (command.type === 'start') {
      if (session) return refused(ALREADY_ACTIVE);
      try {
        const output = validateCase(await provider.generate());
        if (admitted !== epoch) return null;
        const mystery = Object.freeze({ ...output, clues: Object.freeze([...output.clues]) });
        session = { mystery, revealed: 0 };
        return changed(`${mystery.background}\n\n发送“调查”或“问线索”依次获取线索，共 ${mystery.clues.length} 条（最多 5 次）。发送“答案：<推断>”提交一次答案并揭晓，或“结束桌游”退出。`);
      } catch {
        if (admitted !== epoch) return null;
        return refused('桌游开局模型生成失败或格式异常，未建立会话，请重新发送“开始桌游”。');
      }
    }
    if (!session) return unchanged(NO_SESSION);
    if (command.type === 'investigate') {
      if (session.revealed >= session.mystery.clues.length) return refused('已无线索，只能发送“答案：<推断>”提交答案或“结束桌游”。');
      const index = session.revealed++;
      return changed(`线索 ${index + 1}/${session.mystery.clues.length}：${session.mystery.clues[index]}${session.revealed === session.mystery.clues.length
        ? '\n线索已用完，只能发送“答案：<推断>”提交答案或“结束桌游”。' : '\n可继续“调查”，或提交答案／结束桌游。'}`);
    }
    if (!normalizeAnswer(command.answer)) return refused('请在“答案：”后填写推断，或发送“结束桌游”。');
    const answer = session.mystery.answer;
    const correct = normalizeAnswer(command.answer) === normalizeAnswer(answer);
    session = null;
    return changed(`${correct ? '答对了' : '答错了'}！冻结答案：${answer}\n桌游已结束，临时会话已清除。`);
  }
  function execute(side, command) {
    // Admission must precede every session lookup, including invalid requests.
    if (side !== 'owner') return Promise.resolve(refused(REFUSAL));
    if (!command || !['start', 'investigate', 'answer', 'end'].includes(command.type)
      || command.type === 'answer' && typeof command.answer !== 'string') {
      return Promise.resolve(refused('请用“开始桌游”、“调查”、“答案：<推断>”或“结束桌游”。'));
    }
    if (command.type === 'end') {
      const active = claimsAnswer(side);
      session = null; epoch++; queuedStarts = 0;
      return Promise.resolve(active ? changed('桌游已结束，临时会话已清除。') : unchanged(NO_SESSION));
    }
    const starting = command.type === 'start';
    if (starting && claimsAnswer(side)) return Promise.resolve(refused(ALREADY_ACTIVE));
    if (starting) queuedStarts++;
    const admitted = epoch;
    const result = pending.then(() => admitted === epoch ? apply(command, admitted) : null)
      .finally(() => { if (starting && admitted === epoch) queuedStarts--; });
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}
module.exports = { createDetectiveGameStore, normalizeAnswer };
