'use strict';

function splitDrawOptions(text) {
  return [...new Set(String(text || '').split(/(?:[、，,]|还是|或)/u)
    .map((option) => option.trim()).filter(Boolean))];
}

function parseRandomDrawCommand(text) {
  const value = String(text || '').trim();
  if (value === '再抽一次') return { type: 'redraw' };
  if (value === '从想去箱抽一个' || value === '想去箱随机选一个') return { type: 'place' };
  const match = value.match(/^(?:抽签|帮我抽一个|抽一个)[：:]([\s\S]*)$/u);
  return match ? { type: 'draw', options: splitDrawOptions(match[1]) } : null;
}

module.exports = { parseRandomDrawCommand, splitDrawOptions };
