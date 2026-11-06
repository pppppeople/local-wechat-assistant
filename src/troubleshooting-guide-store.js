'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { validateStep, validateSummary } = require('./troubleshooting-guide-provider');
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
function repeats(step, tried) {
  return tried.some(previous => ['check', 'question'].some(key => {
    const a = normalize(step[key]), b = normalize(previous[key]);
    return a.includes(b) || b.includes(a);
  }));
}
function createTroubleshootingGuideStore({ provider }) {
  // One volatile session, separate from ordinary chat, tasks and saved records.
  let session = null;
  let pending = Promise.resolve();
  let queuedStarts = 0;
  const claimsAnswer = side => side === 'owner' && (session !== null || queuedStarts > 0);
  const data = current => ({ symptom: current.symptom, tried: current.tried.map(step => ({ ...step })),
    current: current.current ? { ...current.current } : null });
  async function close(current) {
    current.phase = 'summary';
    try {
      const summary = validateSummary(await provider.summarize(data(current)));
      const process = current.tried.map((step, i) => `${i + 1}. 检查：${step.check}\n问题：${step.question}\n观察结果：${step.result}`).join('\n') || '暂无已完成的检查。';
      const unreturned = current.current ? `\n待反馈检查：${current.current.check}\n问题：${current.current.question}\n观察结果：尚未反馈。` : '';
      session = null;
      return changed(`诊断摘要\n现象：${current.symptom}\n\n排查过程：\n${process}${unreturned}\n\n目前最可能的原因（模型判断，仅为推测）：\n${summary.likelyCause}\n\n仍需确认的事项：\n${summary.unconfirmed}\n\n排查已结束，临时状态已清除。`);
    } catch {
      return refused('这次模型诊断摘要生成失败，排查进度已保留；请发送“结束排查”重试。');
    }
  }
  async function next(current) {
    try {
      const rejected = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const step = validateStep(await provider.next({ ...data(current), rejected }));
        if (!repeats(step, current.tried)) {
          current.current = { ...step };
          return changed(`排查第 ${current.tried.length + 1}/5 步\n检查建议：${step.check}\n${step.question}\n\n请回复观察结果，或发送“结束排查”。仅提供建议，由你自行检查。`);
        }
        rejected.push({ ...step });
      }
      return refused('模型连续给出了与已试步骤重复的建议，已拦截并跳过该步，未增加步数。进度已保留；请回复“重试”换一步，或发送“结束排查”。');
    } catch {
      return refused('这次模型检查步骤生成失败，排查进度已保留；请回复“重试”生成下一步，或发送“结束排查”。');
    }
  }
  async function apply(command) {
    if (command.type === 'start') {
      if (session) return refused('已有进行中的排查，请先发送“结束排查”再开启，不会覆盖原进度。');
      if (!nonempty(command.symptom)) return refused('请发送“帮我排查：<现象>”或“排查一下：<现象>”开启。');
      session = { symptom: command.symptom.trim(), tried: [], current: null, phase: 'checking' };
      return next(session);
    }
    if (!session) return unchanged('当前没有进行中的排查，请发送“帮我排查：<现象>”开启。');
    const current = session;
    if (command.type === 'end' || current.phase === 'summary') return close(current);
    if (!nonempty(command.text)) return refused('请回复观察结果，或发送“结束排查”。');
    if (current.current) {
      current.tried.push({ ...current.current, result: command.text });
      current.current = null;
    }
    if (current.tried.length === 5) return close(current);
    return next(current);
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command || !['start', 'answer', 'end'].includes(command.type)) return Promise.resolve(refused('不支持这个排查操作。'));
    const starting = command.type === 'start';
    if (starting) queuedStarts++;
    const result = pending.then(() => apply(command)).finally(() => { if (starting) queuedStarts--; });
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}

module.exports = { createTroubleshootingGuideStore };
