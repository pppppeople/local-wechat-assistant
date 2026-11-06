'use strict';

function splitMessage(text, maxLength = 1700) {
  const chunks = [];
  let current = '';
  for (const paragraph of String(text || '').trim().split(/\n{2,}/).filter(Boolean)) {
    if (paragraph.length > maxLength) {
      if (current) { chunks.push(current); current = ''; }
      for (let offset = 0; offset < paragraph.length; offset += maxLength) chunks.push(paragraph.slice(offset, offset + maxLength));
    } else {
      const combined = current ? `${current}\n\n${paragraph}` : paragraph;
      if (combined.length > maxLength) { chunks.push(current); current = paragraph; }
      else current = combined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function answerDeliveries({ id, accountId, senderId, text, userText, imageCount }) {
  const chunks = splitMessage(text);
  return chunks.map((chunk, index) => ({
    id: chunks.length === 1 ? id : `${id}:${index + 1}`,
    clientId: `codex-wechat:${id}:${index + 1}`,
    accountId, senderId, text: chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n${chunk}` : chunk,
    kind: 'ordinary-answer', initialDelayMs: Math.max(15000, chunks.length * 30000),
    metadata: { userText, imageCount, historyId: id, recordHistory: index === chunks.length - 1,
      historyText: index === chunks.length - 1 ? text.slice(0, 1800) : '' },
  }));
}

module.exports = { answerDeliveries, splitMessage };
