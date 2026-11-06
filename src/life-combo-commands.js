'use strict';

const { refused, unchanged } = require('./feature-result');
const HELP = '发送“合成任务”或“随机合成任务”抽取；“合成任务完成”或“放弃合成任务”仅结束临时卡片，不修改来源记录。';
function parseLifeComboCommand(text) {
  const value = String(text || '').trim();
  if (['合成任务', '随机合成任务'].includes(value)) return { type: 'draw' };
  if (value === '合成任务完成') return { type: 'complete' };
  if (value === '放弃合成任务') return { type: 'abandon' };
  return /^(?:随机合成任务|合成任务|放弃合成任务)/u.test(value) ? { type: 'invalid' } : null;
}
function candidates(todos, places, habits) {
  const pool = [], seen = new Set();
  for (const [source, rows, field] of [['待办', todos, 'text'], ['地点', places, 'name'], ['习惯', habits, 'name']]) {
    const ids = new Set();
    for (const row of rows) {
      const title = row[field]?.trim();
      if (!title) throw Error('候选条目无效');
      const key = JSON.stringify([source, title]);
      if (seen.has(key) || row.id && ids.has(row.id)) continue;
      seen.add(key); if (row.id) ids.add(row.id);
      pool.push({ source, title });
    }
  }
  return pool;
}
function createLifeCombo({ todos, places, habits, provider, random = Math.random }) {
  const cards = new Map();
  let queue = Promise.resolve();
  async function run(command, session) {
    if (command.type !== 'draw') {
      if (!cards.has(session)) return unchanged('暂无临时卡片，请先发送“合成任务”。');
      cards.delete(session);
      return unchanged(`已${command.type === 'complete' ? '完成' : '放弃'}本次临时卡片；未修改待办状态、地点已去标记或习惯打卡。`);
    }
    // A new draw replaces the old card, including empty/failed draws.
    cards.delete(session);
    let pool;
    try { pool = candidates(todos.readOpenItems('owner'), places.readOwnerUnvisitedItems('owner'), habits.readActiveItems('owner')); }
    catch { return refused('合成任务失败：来源记录无法读取，未生成卡片，未修改任何记录。'); }
    if (!pool.length) return unchanged('暂无可组合内容，请先添加待办、想去地点或习惯。');
    const pick = rows => rows[Math.floor(random() * rows.length)];
    const first = pick(pool);
    const others = pool.filter(item => item !== first);
    const cross = others.filter(item => item.source !== first.source);
    const selected = others.length ? [first, pick(cross.length ? cross : others)] : [first];
    const originals = selected.map((item, i) => `${i + 1}. ${item.source}：${item.title}`).join('\n');
    if (selected.length === 1) {
      cards.set(session, selected);
      return unchanged(`仅有 1 项，仅展示该条（临时卡片）：\n${originals}\n${HELP}`);
    }
    const scope = cross.length ? '' : '\n本次两项来自同一来源，暂无其他来源可选。';
    try {
      const value = await provider.generate(selected);
      // The provider validates its closed output; rendering uses originals only.
      let advice = '这两项暂不适合合成，分别要点如下：';
      if (value.compatible) {
        const [a, b] = value.reverse ? [...selected].reverse() : selected;
        const action = item => item.source === '地点' ? `前往「${item.title}」` : `进行「${item.title}」`;
        advice = value.mode === '依次进行' ? `组合建议：先${action(a)}，然后${action(b)}。`
          : `组合建议：在同一次安排中，${action(a)}，并${action(b)}。`;
      }
      cards.set(session, selected);
      return unchanged(`临时合成任务卡片${scope}\n${advice}\n${originals}\n${HELP}`);
    } catch {
      return refused(`合成任务失败：模型调用失败或返回格式异常，未生成合成结论或卡片；以下仅展示抽中条目：${scope}\n${originals}`);
    }
  }
  return { execute(side, command, session = 'owner') {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command || !['draw', 'complete', 'abandon'].includes(command.type)
      || Object.keys(command).length !== 1 || typeof session !== 'string' || !session) return Promise.resolve(refused(HELP));
    const result = queue.then(() => run(command, session));
    queue = result.catch(() => {});
    return result;
  } };
}
module.exports = { parseLifeComboCommand, createLifeCombo, HELP };
