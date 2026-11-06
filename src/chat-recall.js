'use strict';

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function searchChatRecall(turns, keyword) {
  const query = String(keyword || '').trim().toLowerCase();
  if (!query) return [];
  const words = [...new Set(query.split(/\s+/u).filter(Boolean))];
  const results = [];
  for (const [index, turn] of turns.entries()) {
    for (const [field, speaker] of [['user', '主人'], ['assistant', '助手']]) {
      const original = turn[field];
      if (typeof original !== 'string' || !original.trim()) continue;
      const content = original.toLowerCase();
      const hits = words.filter(word => content.includes(word)).length;
      if (!hits) continue;
      const timestamp = Date.parse(turn.at);
      results.push({ text: original, speaker, at: turn.at,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        full: Number(content.includes(query)), hits, index });
    }
  }
  return results.sort((a, b) => b.full - a.full || b.hits - a.hits
    || b.timestamp - a.timestamp || b.index - a.index).slice(0, 5);
}

function formatChatRecall(results) {
  if (!results.length) return '在你本人已保存的聊天记录中没找到相关线索。';
  return '在你本人已保存的聊天记录中找到这些线索（Asia/Shanghai）：\n'
    + results.map((item, index) => {
      const time = Number.isFinite(Date.parse(item.at)) ? timeFormat.format(new Date(item.at)) : '时间未知';
      const chars = Array.from(item.text);
      const quote = chars.slice(0, 220).join('') + (chars.length > 220 ? '…' : '');
      return `${index + 1}. ${time}｜${item.speaker}\n「${quote}」`;
    }).join('\n\n');
}

// Owner binding is checked before invoking the only injected data source.
// No fallback sources, writes, session changes, or model calls belong here.
function recallChat({ senderId, ownerId, file, keyword }, { getChatHistory }) {
  if (!ownerId || senderId !== ownerId) return null;
  if (!String(keyword || '').trim()) return '请给我一个要找回的关键词，例如：找回：签证材料。';
  return formatChatRecall(searchChatRecall(getChatHistory(file, ownerId), keyword));
}

module.exports = { searchChatRecall, formatChatRecall, recallChat };
