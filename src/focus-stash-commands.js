'use strict';

const crypto = require('crypto');

const REFUSAL = '专注暂存仅主人可用，好友不能读取或操作。';
function parseFocusStashCommand(text) {
  const value = String(text || '').trim();
  if (value === '暂存列表') return { type: 'list' };
  if (value === '暂存转待办') return { type: 'transfer' };
  const removal = value.match(/^删除暂存第\s*(\d+)\s*条$/u);
  if (removal) return { type: 'delete', number: Number(removal[1]) };
  const addition = value.match(/^暂存[：:]([\s\S]*)$/u);
  return addition ? { type: 'add', text: addition[1].trim() } : null;
}

function formatFocusStash(items = []) {
  return items.length ? `本次专注暂存（上海时间）：\n${items.map((item, index) =>
    `${index + 1}. ${item.text}（${item.createdAt}）${item.transferred ? '〔已转待办〕' : ''}`).join('\n')}`
    : '本次专注暂无暂存条目。';
}

// The caller saves the cleared array together with its existing terminal marker.
function finishFocusStash(session) {
  if (!session.stash?.length) { delete session.stash; return ''; }
  const reply = `\n${formatFocusStash(session.stash)}\n暂存已随专注结束清除。`;
  delete session.stash;
  return reply;
}

function validateFocusStash(items) {
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length > 10
    || new Set(items.map(item => item?.id)).size !== items.length
    || items.some(item => !item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id)
      || typeof item.text !== 'string' || !item.text.trim() || item.text !== item.text.trim()
      || typeof item.createdAt !== 'string' || !item.createdAt.endsWith('+08:00')
      || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.transferred !== 'boolean')) {
    throw new Error('专注暂存格式无效');
  }
}

function createFocusStashCommands({ load, save, now, todos }) {
  return function handleStash(side, command) {
    if (side !== 'owner') return REFUSAL; // Before any storage access, including restart cleanup.
    if (!command || !['add', 'list', 'delete', 'transfer'].includes(command.type)) return '不支持这个暂存操作。';
    if (command.type === 'add' && !String(command.text || '').trim()) return '暂存内容不能为空。';
    const state = load();
    const session = state.sessions.find(item => item.status === 'active' && Date.parse(item.endsAt) > now());
    if (!session) return '没有进行中的专注，无法操作暂存；请先开始专注，例如「专心工作 45 分钟」。';
    const items = session.stash || [];
    if (command.type === 'list') return formatFocusStash(items);
    if (command.type === 'add') {
      if (items.length >= 10) return '本次专注暂存最多 10 条，请先删除条目；本次未暂存。';
      const createdAt = new Date(now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
      items.push({ id: crypto.randomUUID(), text: command.text.trim(), createdAt, transferred: false });
      session.stash = items;
      save(state);
      return `已暂存第 ${items.length} 条（上海时间 ${createdAt}），未自动创建待办。`;
    }
    if (command.type === 'delete') {
      if (!Number.isSafeInteger(command.number) || command.number < 1 || command.number > items.length) {
        return '暂存序号越界，请先查看「暂存列表」并使用当前序号。';
      }
      items.splice(command.number - 1, 1);
      save(state);
      return `已删除暂存第 ${command.number} 条，请重新查看列表序号。`;
    }
    const pending = items.filter(item => !item.transferred);
    if (!pending.length) return items.length ? '暂存已全部转为待办，未重复写入。' : '本次专注暂无暂存条目。';
    let count = 0;
    for (const item of pending) {
      // A stable ID at the existing add boundary also covers a failed stash save
      // after a successful todo write. No deadline is inferred from the content.
      const result = todos.execute('owner', { type: 'add', text: item.text, dueDate: null,
        idempotencyKey: `focus-stash-${item.id}` });
      if (!result.continue) return `本次已转 ${count} 条；其余未转：${result.reply}`;
      item.transferred = true;
      save(state);
      count++;
    }
    return `已将 ${count} 条暂存转为个人待办；条目保留并标记已转，重复操作不会重复写入。`;
  };
}

module.exports = { REFUSAL, parseFocusStashCommand, formatFocusStash, finishFocusStash,
  validateFocusStash, createFocusStashCommands };
